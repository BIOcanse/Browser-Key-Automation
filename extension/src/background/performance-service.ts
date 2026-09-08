import type { PublicKeyRecord } from "../shared/admin-protocol.js";
import { createTextArtifact } from "./artifact-service.js";
import { BrowserOperationError, exact, featureLimit, integer, object, waitForFeatureReceipt } from "./browser-feature-model.js";
import { leaseDebuggerDomains, type DebuggerDispatch, type DebuggerLease } from "./debugger-service.js";
import { isTabRefShape } from "./tab-service.js";

const limit=(name:string)=>featureLimit(`command.performance.${name}`),encoder=new TextEncoder();
interface Sample {readonly sequence:number;readonly requestedAt:number;readonly receivedAt:number;readonly metrics:readonly {readonly name:string;readonly value:number}[];}
interface Capture {
  readonly captureId:string;readonly ownerKeyId:string;readonly tabRef:string;readonly timeDomain:string;readonly startedAt:number;expiresAt:number;
  state:"starting"|"running"|"stopping"|"stopped"|"interrupted"|"cleanup_failed";reason:string|null;
  readonly samples:Sample[];bytes:number;lease:DebuggerLease|null;cleanup:Promise<unknown>|null;stopping:Promise<void>|null;timer:ReturnType<typeof setTimeout>|null;
  readonly lifetime:AbortController;readonly protocol:Set<Promise<unknown>>;
}
const captures=new Map<string,Capture>();
export function parsePerformanceParams(method:string,params:Record<string,unknown>):boolean {
  if(method==="performance.start")return exact(params,["tabRef","durationMs","timeDomain"])&&isTabRefShape(params.tabRef)&&integer(params.durationMs,1,limit("maximum_duration_ms"))&&["timeTicks","threadTicks"].includes(params.timeDomain as string);
  if(typeof params.captureId!=="string"||!/^pc1\.[a-f0-9-]{36}$/u.test(params.captureId))return false;
  if(method==="performance.read")return exact(params,["captureId","afterSequence","limit"])&&integer(params.afterSequence)&&integer(params.limit,1,limit("maximum_page_size"));
  return ["performance.sample","performance.stop","performance.export"].includes(method)&&exact(params,["captureId"]);
}
function metadata(capture:Capture){return {captureId:capture.captureId,tabRef:capture.tabRef,state:capture.state,reason:capture.reason,timeDomain:capture.timeDomain,
  startedAt:capture.startedAt,expiresAt:capture.expiresAt,recordCount:capture.samples.length,bytes:capture.bytes,pendingProtocolCalls:capture.protocol.size,scope:"attached_target_only",sampling:"explicit",source:"CDP.Performance.getMetrics"};}
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
    try{
      await waitForFeatureReceipt(Promise.allSettled([...capture.protocol]),limit("cleanup_timeout_ms"),"PERFORMANCE_PROTOCOL_PENDING");
      if(capture.lease){capture.cleanup??=capture.lease.cleanup("Performance.disable");await waitForFeatureReceipt(capture.cleanup,limit("cleanup_timeout_ms"),"PERFORMANCE_CLEANUP_TIMEOUT");}
    }catch(error){if(capture.lease!==null){capture.state="cleanup_failed";capture.reason=error instanceof BrowserOperationError?error.details.reason:"PERFORMANCE_CLEANUP_FAILED";}return;}
    if(capture.state==="stopping")finish(capture,reason);
  })();
  try{await capture.stopping;}finally{capture.stopping=null;}
}
function observeProtocol(capture:Capture,method:string,params:Readonly<Record<string,unknown>>,active:()=>void):Promise<unknown>{
  const receipt=capture.lease!.send(method,params,undefined,active);capture.protocol.add(receipt);
  void receipt.then(()=>capture.protocol.delete(receipt),()=>capture.protocol.delete(receipt));
  return waitForFeatureReceipt(receipt,Math.max(0,Math.min(limit("operation_timeout_ms"),capture.expiresAt-Date.now())),"PERFORMANCE_OPERATION_TIMEOUT",capture.lifetime.signal);
}
export async function startPerformance(caller:PublicKeyRecord,params:Record<string,unknown>,dispatch:DebuggerDispatch){
  if(captures.size>=limit("maximum_captures"))throw new BrowserOperationError("CAPTURE_LIMIT");
  const startedAt=Date.now(),capture:Capture={captureId:`pc1.${crypto.randomUUID()}`,ownerKeyId:caller.keyId,tabRef:params.tabRef as string,timeDomain:params.timeDomain as string,
    startedAt,expiresAt:startedAt+Number(params.durationMs),state:"starting",reason:null,samples:[],bytes:0,lease:null,cleanup:null,stopping:null,timer:null,lifetime:new AbortController(),protocol:new Set()};
  captures.set(capture.captureId,capture);
  const active=()=>{if(capture.state!=="starting"||Date.now()>=capture.expiresAt)throw new BrowserOperationError("CAPTURE_INTERRUPTED");};
  capture.timer=setTimeout(()=>void stop(capture,"DURATION_EXPIRED"),Math.max(0,capture.expiresAt-Date.now()));
  try{
    const acquisition=leaseDebuggerDomains(capture.tabRef,["Performance"],effect=>dispatch(async()=>{
      if(capture.lifetime.signal.aborted||Date.now()>=capture.expiresAt)throw new BrowserOperationError("CAPTURE_INTERRUPTED");return effect();
    }),(event,reason)=>{if(event===null)finish(capture,reason??"DEBUGGER_DETACHED");}).then(lease=>{
      try{active();capture.lease=lease;return lease;}catch(error){lease.release();throw error;}
    });
    await waitForFeatureReceipt(acquisition,limit("operation_timeout_ms"),"PERFORMANCE_OPERATION_TIMEOUT",capture.lifetime.signal);active();
    await observeProtocol(capture,"Performance.enable",{timeDomain:capture.timeDomain},active);active();
    capture.state="running";return {capture:metadata(capture)};
  }catch(error){
    if(capture.lease===null&&capture.state==="starting"){
      finish(capture,"START_FAILED");
      if(!(error instanceof BrowserOperationError)){if(capture.timer!==null)clearTimeout(capture.timer);capture.timer=null;captures.delete(capture.captureId);throw error;}
    }
    await stop(capture,"START_FAILED");throw new BrowserOperationError("PERFORMANCE_START_FAILED",true,{capture:metadata(capture)});
  }
}
export async function runPerformance(owner:string,method:string,params:Record<string,unknown>){
  const capture=captures.get(params.captureId as string);
  if(!capture||capture.ownerKeyId!==owner)throw new BrowserOperationError("CAPTURE_NOT_FOUND");
  if(method==="performance.stop"){await stop(capture,null);return {capture:metadata(capture)};}
  if(method==="performance.sample"){
    const active=()=>{if(capture.state!=="running"||capture.lease===null||Date.now()>=capture.expiresAt)throw new BrowserOperationError("CAPTURE_NOT_RUNNING");};
    active();if(capture.samples.length>=limit("maximum_records"))throw new BrowserOperationError("PERFORMANCE_RECORD_LIMIT");
    const requestedAt=Date.now();let response:unknown;
    try{response=await observeProtocol(capture,"Performance.getMetrics",{},active);active();}
    catch(error){
      if(!(error instanceof BrowserOperationError)||!["PERFORMANCE_OPERATION_TIMEOUT","CAPTURE_INTERRUPTED"].includes(error.details.reason))throw error;
      await stop(capture,"SAMPLE_INTERRUPTED");throw new BrowserOperationError(error.details.reason,false,{capture:metadata(capture)});
    }
    if(!object(response)||!Array.isArray(response.metrics)||!response.metrics.every(metric=>object(metric)&&typeof metric.name==="string"&&typeof metric.value==="number"&&Number.isFinite(metric.value)))throw new BrowserOperationError("INVALID_PERFORMANCE_METRICS");
    const sample:Sample={sequence:capture.samples.length+1,requestedAt,receivedAt:Date.now(),metrics:response.metrics.map(metric=>({name:metric.name as string,value:metric.value as number}))};
    const bytes=encoder.encode(JSON.stringify(sample)).byteLength;
    if(bytes>limit("maximum_record_bytes")||capture.bytes+bytes>limit("maximum_buffer_bytes"))throw new BrowserOperationError("PERFORMANCE_RECORD_LIMIT");
    capture.samples.push(sample);capture.bytes+=bytes;return {capture:metadata(capture),sample};
  }
  if(method==="performance.export"){
    if(["starting","running","stopping"].includes(capture.state))throw new BrowserOperationError("STOP_CAPTURE_BEFORE_EXPORT");
    return {capture:metadata(capture),artifact:await createTextArtifact(owner,"application/json",JSON.stringify({capture:metadata(capture),samples:capture.samples}))};
  }
  if(method!=="performance.read")throw new BrowserOperationError("UNKNOWN_OPERATION");
  const items:Sample[]=[];let nextSequence=Number(params.afterSequence),hasMore=false;
  for(const sample of capture.samples){
    if(sample.sequence<=nextSequence)continue;
    if(items.length>=Number(params.limit)||encoder.encode(JSON.stringify([...items,sample])).byteLength>featureLimit("command.inline.maximum_result_json_bytes")-4096){hasMore=true;break;}
    items.push(sample);nextSequence=sample.sequence;
  }
  if(hasMore&&items.length===0)throw new BrowserOperationError("RESULT_TOO_LARGE_USE_EXPORT");
  return {capture:metadata(capture),items,nextSequence,hasMore};
}
