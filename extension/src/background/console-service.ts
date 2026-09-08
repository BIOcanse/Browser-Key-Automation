import type { PublicKeyRecord } from "../shared/admin-protocol.js";
import { createTextArtifact } from "./artifact-service.js";
import { BrowserOperationError, exact, featureLimit, integer, object, waitForFeatureReceipt } from "./browser-feature-model.js";
import { leaseDebuggerDomains, type DebuggerDispatch, type DebuggerEvent, type DebuggerLease } from "./debugger-service.js";
import { isTabRefShape } from "./tab-service.js";

const limit=(name:string)=>featureLimit(`command.console.${name}`);
const captures=new Map<string,Capture>();
const encoder=new TextEncoder();

interface ConsoleRecord {
  readonly sequence:number;readonly receivedAt:number;readonly sessionId:string|null;
  readonly method:string;readonly timestamp:number|null;readonly historical:boolean|null;
  readonly params:Readonly<Record<string,unknown>>;
}
interface Capture {
  readonly captureId:string;readonly ownerKeyId:string;readonly tabRef:string;readonly includeExisting:boolean;
  readonly startedAt:number;expiresAt:number;readonly records:ConsoleRecord[];
  state:"starting"|"running"|"stopping"|"stopped"|"interrupted"|"cleanup_failed";reason:string|null;
  bytes:number;lostEvents:number;excludedExisting:number;failedReleases:number;untrackedReferences:number;
  lease:DebuggerLease|null;readonly releases:Map<string,Promise<void>>;
  readonly lifetime:AbortController;readonly protocol:Set<Promise<unknown>>;
  cleanup:Promise<void>|null;stopping:Promise<void>|null;timer:ReturnType<typeof setTimeout>|null;
}
export function parseConsoleParams(method:string,params:Record<string,unknown>):boolean {
  if(method==="console.start")return exact(params,["tabRef","durationMs","includeExisting"])&&isTabRefShape(params.tabRef)&&
    integer(params.durationMs,1,limit("maximum_duration_ms"))&&typeof params.includeExisting==="boolean";
  if(typeof params.captureId!=="string"||!/^cc1\.[a-f0-9-]{36}$/u.test(params.captureId))return false;
  if(method==="console.read")return exact(params,["captureId","afterSequence","limit"])&&integer(params.afterSequence)&&integer(params.limit,1,limit("maximum_page_size"));
  return ["console.stop","console.export"].includes(method)&&exact(params,["captureId"]);
}
function metadata(capture:Capture){return {captureId:capture.captureId,tabRef:capture.tabRef,state:capture.state,reason:capture.reason,
  startedAt:capture.startedAt,expiresAt:capture.expiresAt,includeExisting:capture.includeExisting,recordCount:capture.records.length,
  bytes:capture.bytes,lostEvents:capture.lostEvents,excludedExisting:capture.excludedExisting,pendingReleases:capture.releases.size,
  failedReleases:capture.failedReleases,untrackedReferences:capture.untrackedReferences,pendingProtocolCalls:capture.protocol.size,scope:"attached_target_only",values:"protocol_snapshot",
  recovery:capture.failedReleases>0||capture.untrackedReferences>0?"explicit_debugger_detach":null};}
function finish(capture:Capture,reason:string|null):void {
  if(capture.timer!==null)clearTimeout(capture.timer);
  capture.lifetime.abort();
  capture.lease?.release();capture.lease=null;capture.state=reason===null?"stopped":"interrupted";capture.reason=reason;
  capture.timer=setTimeout(()=>captures.delete(capture.captureId),limit("retention_ms"));
}
async function stop(capture:Capture,reason:string|null):Promise<void>{
  if(capture.state==="stopped"||capture.state==="interrupted")return;
  if(capture.stopping)return capture.stopping;
  capture.state="stopping";capture.reason=reason;capture.lifetime.abort();
  if(capture.timer!==null)clearTimeout(capture.timer);capture.timer=null;
  capture.stopping=(async()=>{
    const lease=capture.lease;
    if(lease===null){finish(capture,reason);return;}
    try{
      await waitForFeatureReceipt(Promise.allSettled([...capture.protocol]),limit("cleanup_timeout_ms"),"CONSOLE_PROTOCOL_PENDING");
      // Preserve the same disable receipts across timeout/explicit stop. Events
      // received before the disable barrier still need exact handle release.
      capture.cleanup??=Promise.all([lease.cleanup("Runtime.disable"),lease.cleanup("Log.disable")]).then(()=>{});
      await waitForFeatureReceipt(capture.cleanup,limit("cleanup_timeout_ms"),"CONSOLE_CLEANUP_TIMEOUT");
      await waitForFeatureReceipt(Promise.all([...capture.releases.values()]),limit("cleanup_timeout_ms"),"CONSOLE_RELEASE_TIMEOUT");
      if(capture.failedReleases>0||capture.untrackedReferences>0)throw new BrowserOperationError("CONSOLE_REFERENCES_UNRELEASED");
    }catch(error){
      if(capture.lease===null)return;
      capture.state="cleanup_failed";capture.reason=error instanceof BrowserOperationError?error.details.reason:"CONSOLE_CLEANUP_FAILED";return;
    }
    if(capture.lease!==null)finish(capture,reason);
  })();
  try{await capture.stopping;}finally{capture.stopping=null;}
}
function observeProtocol(capture:Capture,method:string,active:()=>void):Promise<unknown>{
  const receipt=capture.lease!.send(method,{},undefined,active);
  capture.protocol.add(receipt);
  void receipt.then(()=>capture.protocol.delete(receipt),()=>capture.protocol.delete(receipt));
  return waitForFeatureReceipt(receipt,Math.max(0,Math.min(limit("operation_timeout_ms"),capture.expiresAt-Date.now())),"CONSOLE_OPERATION_TIMEOUT",capture.lifetime.signal);
}
function remoteArguments(method:string,payload:Readonly<Record<string,unknown>>):unknown[]{
  const entry=object(payload.entry)?payload.entry:null,details=object(payload.exceptionDetails)?payload.exceptionDetails:null;
  const args=method==="Runtime.consoleAPICalled"?payload.args:method==="Log.entryAdded"?entry?.args:details?.exception?[details.exception]:[];
  return Array.isArray(args)?args:[];
}
function releaseArguments(capture:Capture,event:DebuggerEvent):void {
  const args=remoteArguments(event.method,event.params);
  if(capture.lease===null)return;
  for(const arg of args){
    if(!object(arg)||typeof arg.objectId!=="string")continue;
    const identity=JSON.stringify([event.sessionId,arg.objectId]);
    if(capture.releases.has(identity))continue;
    if(capture.releases.size>=limit("maximum_pending_releases")){
      capture.untrackedReferences++;void stop(capture,"CONSOLE_REFERENCE_LIMIT");continue;
    }
    const lease=capture.lease;
    const receipt=lease.cleanup("Runtime.releaseObject",{objectId:arg.objectId},event.sessionId??undefined)
      .then(()=>{},()=>{if(capture.lease!==null)capture.failedReleases++;});
    capture.releases.set(identity,receipt);
    void receipt.then(()=>capture.releases.delete(identity));
  }
}
function receive(capture:Capture,event:DebuggerEvent|null,reason?:string):void {
  if(event===null){finish(capture,reason??"DEBUGGER_DETACHED");capture.releases.clear();return;}
  if(!["Runtime.consoleAPICalled","Runtime.exceptionThrown","Runtime.exceptionRevoked","Log.entryAdded"].includes(event.method))return;
  releaseArguments(capture,event);
  if(capture.state!=="running"&&capture.state!=="starting")return;
  if(Date.now()>=capture.expiresAt){void stop(capture,"DURATION_EXPIRED");return;}
  const value=event.method==="Log.entryAdded"&&object(event.params.entry)?event.params.entry.timestamp:event.params.timestamp;
  const timestamp=typeof value==="number"&&Number.isFinite(value)?value:null;
  const historical=timestamp===null?null:timestamp<capture.startedAt;
  if(historical&&!capture.includeExisting){capture.excludedExisting++;return;}
  // Snapshots never expose live handles or expand page properties. The browser
  // remains responsible for the descriptions/previews in its original event.
  const params=JSON.parse(JSON.stringify(event.params)) as Record<string,unknown>;
  for(const arg of remoteArguments(event.method,params))if(object(arg))delete arg.objectId;
  const record:ConsoleRecord={sequence:capture.records.length+1,receivedAt:Date.now(),sessionId:event.sessionId,method:event.method,timestamp,historical,params};
  const bytes=encoder.encode(JSON.stringify(record)).byteLength;
  if(capture.records.length>=limit("maximum_records")||bytes>limit("maximum_record_bytes")||capture.bytes+bytes>limit("maximum_buffer_bytes")){
    capture.lostEvents++;void stop(capture,"CONSOLE_RECORD_LIMIT");return;
  }
  capture.records.push(record);capture.bytes+=bytes;
}
export async function startConsole(caller:PublicKeyRecord,params:Record<string,unknown>,dispatch:DebuggerDispatch){
  if(captures.size>=limit("maximum_captures"))throw new BrowserOperationError("CAPTURE_LIMIT");
  const startedAt=Date.now(),capture:Capture={captureId:`cc1.${crypto.randomUUID()}`,ownerKeyId:caller.keyId,tabRef:params.tabRef as string,
    includeExisting:params.includeExisting as boolean,startedAt,expiresAt:startedAt+Number(params.durationMs),
    state:"starting",reason:null,records:[],bytes:0,lostEvents:0,excludedExisting:0,failedReleases:0,untrackedReferences:0,
    lease:null,releases:new Map(),lifetime:new AbortController(),protocol:new Set(),cleanup:null,stopping:null,timer:null};
  captures.set(capture.captureId,capture);
  const active=()=>{if(capture.state!=="starting"||Date.now()>=capture.expiresAt)throw new BrowserOperationError("CAPTURE_INTERRUPTED");};
  capture.timer=setTimeout(()=>void stop(capture,"DURATION_EXPIRED"),Math.max(0,capture.expiresAt-Date.now()));
  try{
    const acquisition=leaseDebuggerDomains(capture.tabRef,["Runtime","Log"],effect=>dispatch(async()=>{
      if(capture.lifetime.signal.aborted||Date.now()>=capture.expiresAt)throw new BrowserOperationError("CAPTURE_INTERRUPTED");return effect();
    }),(event,reason)=>receive(capture,event,reason)).then(lease=>{
      try{active();capture.lease=lease;return lease;}catch(error){lease.release();throw error;}
    });
    await waitForFeatureReceipt(acquisition,limit("operation_timeout_ms"),"CONSOLE_OPERATION_TIMEOUT",capture.lifetime.signal);active();
    await observeProtocol(capture,"Runtime.enable",active);active();
    await observeProtocol(capture,"Log.enable",active);active();
    capture.state="running";return {capture:metadata(capture)};
  }catch(error){
    if(capture.lease===null&&capture.state==="starting"){
      finish(capture,"START_FAILED");
      if(!(error instanceof BrowserOperationError)){if(capture.timer!==null)clearTimeout(capture.timer);capture.timer=null;captures.delete(capture.captureId);throw error;}
    }
    await stop(capture,"START_FAILED");throw new BrowserOperationError("CONSOLE_START_FAILED",true,{capture:metadata(capture)});
  }
}
export async function runConsole(owner:string,method:string,params:Record<string,unknown>){
  const capture=captures.get(params.captureId as string);
  if(!capture||capture.ownerKeyId!==owner)throw new BrowserOperationError("CAPTURE_NOT_FOUND");
  if(method==="console.stop"){await stop(capture,null);return {capture:metadata(capture)};}
  if(method==="console.export"){
    if(["starting","running","stopping"].includes(capture.state))throw new BrowserOperationError("STOP_CAPTURE_BEFORE_EXPORT");
    return {capture:metadata(capture),artifact:await createTextArtifact(owner,"application/json",JSON.stringify({capture:metadata(capture),records:capture.records}))};
  }
  if(method!=="console.read")throw new BrowserOperationError("UNKNOWN_OPERATION");
  const items:ConsoleRecord[]=[];let nextSequence=Number(params.afterSequence),hasMore=false;
  for(const row of capture.records){
    if(row.sequence<=nextSequence)continue;
    if(items.length>=Number(params.limit)||encoder.encode(JSON.stringify([...items,row])).byteLength>featureLimit("command.inline.maximum_result_json_bytes")-4096){hasMore=true;break;}
    items.push(row);nextSequence=row.sequence;
  }
  if(hasMore&&items.length===0)throw new BrowserOperationError("RESULT_TOO_LARGE_USE_EXPORT");
  return {capture:metadata(capture),items,nextSequence,hasMore};
}
