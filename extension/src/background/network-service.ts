import type { PublicKeyRecord } from "../shared/admin-protocol.js";
import { createArtifact, createTextArtifact, readArtifactBytes, releaseArtifact, type ArtifactMetadata } from "./artifact-service.js";
import { BrowserOperationError, exact, featureLimit, integer, object, waitForFeatureReceipt } from "./browser-feature-model.js";
import { decodeProtocolBytes } from "./capture/cdp-service.js";
import { leaseDebuggerDomains, type DebuggerDispatch, type DebuggerEvent, type DebuggerLease } from "./debugger-service.js";
import { isTabRefShape } from "./tab-service.js";

const limit=(name:string)=>featureLimit(`command.network.${name}`);
const idShape=(value:unknown):value is string=>typeof value==="string"&&/^nc1\.[a-f0-9-]{36}$/u.test(value);
export interface NetworkRecord {
  readonly requestId:number; readonly protocolRequestId:string; readonly sessionId:string|null; readonly redirectFrom:number|null;
  readonly startedAt:number; readonly timestamp:number; readonly request:Record<string,unknown>; readonly resourceType:string|null;
  response:Record<string,unknown>|null; finishedAt:number|null; encodedBytes:number|null; decodedBytes:number;
  state:"pending"|"complete"|"failed"|"redirected"|"incomplete";
  bodyStatus:string; body:ArtifactMetadata|null; error:string|null;
}
interface Capture {
  readonly captureId:string; readonly ownerKeyId:string; readonly tabRef:string; readonly captureBodies:boolean;
  readonly startedAt:number; expiresAt:number;
  state:"starting"|"running"|"stopping"|"stopped"|"interrupted"|"cleanup_failed"; reason:string|null;
  readonly records:NetworkRecord[]; readonly active:Map<string,NetworkRecord>; readonly extraInfo:DebuggerEvent[];
  metadataBytes:number; bodyBytes:number; reservedBodyBytes:number; lostEvents:number;
  lease:DebuggerLease|null; readonly pending:Set<Promise<void>>; timer:ReturnType<typeof setTimeout>|null;
  stopPromise:Promise<void>|null; cleanupPromise:Promise<unknown>|null;
  readonly lifetime:AbortController; readonly protocol:Set<Promise<unknown>>;
}
const captures=new Map<string,Capture>();
export function parseNetworkParams(method:string,params:Record<string,unknown>):boolean {
  if(method==="network.start")return exact(params,["tabRef","captureBodies","durationMs"])&&isTabRefShape(params.tabRef)&&typeof params.captureBodies==="boolean"&&integer(params.durationMs,1,limit("maximum_duration_ms"));
  if(!idShape(params.captureId))return false;
  if(method==="network.read")return exact(params,["captureId","afterRequestId","limit"])&&integer(params.afterRequestId)&&integer(params.limit,1,limit("maximum_page_size"));
  if(method==="network.get")return exact(params,["captureId","requestId"])&&integer(params.requestId,1);
  if(method==="network.export")return exact(params,["captureId","format"])&&["json","har"].includes(params.format as string);
  return exact(params,["captureId"]);
}
function metadata(capture:Capture){return {captureId:capture.captureId,tabRef:capture.tabRef,state:capture.state,reason:capture.reason,
  startedAt:capture.startedAt,expiresAt:capture.expiresAt,requestCount:capture.records.length,metadataBytes:capture.metadataBytes,bodyBytes:capture.bodyBytes,
  pendingBodies:capture.pending.size,pendingProtocolCalls:capture.protocol.size,lostEvents:capture.lostEvents,supplementalEvents:capture.extraInfo.length,scope:"attached_target_only"};}
function owned(owner:string,id:string):Capture {const capture=captures.get(id);if(!capture||capture.ownerKeyId!==owner)throw new BrowserOperationError("CAPTURE_NOT_FOUND");return capture;}
async function bounded<T>(operation:Promise<T>,timeoutMs:number,reason:string):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new BrowserOperationError(reason)),timeoutMs);})]);}
  finally{if(timer!==undefined)clearTimeout(timer);}
}
async function stop(capture:Capture,reason:string|null):Promise<void> {
  if(capture.state==="stopped"||capture.state==="interrupted")return;
  if(capture.stopPromise)return capture.stopPromise;
  capture.state="stopping";capture.reason=reason;capture.lifetime.abort();
  if(capture.timer!==null)clearTimeout(capture.timer);capture.timer=null;
  capture.stopPromise=(async()=>{
    await Promise.allSettled([...capture.pending]);
    try{
      await waitForFeatureReceipt(Promise.allSettled([...capture.protocol]),limit("cleanup_timeout_ms"),"NETWORK_PROTOCOL_PENDING");
      if(capture.lease){
      capture.cleanupPromise??=capture.lease.cleanup("Network.disable");
      await bounded(capture.cleanupPromise,limit("cleanup_timeout_ms"),"NETWORK_CLEANUP_TIMEOUT");
    }}
    catch(error){
      if(capture.lease!==null){capture.state="cleanup_failed";capture.reason=error instanceof BrowserOperationError?error.details.reason:"NETWORK_CLEANUP_FAILED";return;}
    }
    capture.lease?.release();capture.lease=null;
    for(const record of capture.records)if(record.state==="pending"){record.state="incomplete";record.bodyStatus="stopped_before_finish";}
    capture.active.clear();capture.state=capture.reason===null?"stopped":"interrupted";
    capture.timer=setTimeout(()=>captures.delete(capture.captureId),limit("retention_ms"));
  })();
  try{await capture.stopPromise;}finally{capture.stopPromise=null;}
}
function captureBody(capture:Capture,record:NetworkRecord):void {
  if(!capture.captureBodies){record.bodyStatus="disabled";return;}
  if(capture.pending.size>=limit("maximum_pending_bodies")){record.bodyStatus="capture_busy";return;}
  const maximum=limit("maximum_body_bytes");
  if(record.encodedBytes!==null&&record.encodedBytes>maximum||capture.bodyBytes+capture.reservedBodyBytes+maximum>limit("maximum_body_total_bytes")){record.bodyStatus="body_limit";return;}
  capture.reservedBodyBytes+=maximum;record.bodyStatus="reading";
  const task=(async()=>{
    try{
      await bounded((async()=>{
        const response=await capture.lease!.send("Network.getResponseBody",{requestId:record.protocolRequestId},record.sessionId??undefined,()=>{
          if(record.bodyStatus!=="reading")throw new BrowserOperationError("BODY_CANCELLED");
        });
        if(record.bodyStatus!=="reading")return;
        if(!object(response)||typeof response.body!=="string"||typeof response.base64Encoded!=="boolean")throw new BrowserOperationError("BODY_UNAVAILABLE");
        const bytes=response.base64Encoded?decodeProtocolBytes(response.body,maximum):new TextEncoder().encode(response.body);
        if(bytes.byteLength>maximum){record.bodyStatus="body_limit";return;}
        const body=await createArtifact(capture.ownerKeyId,typeof record.response?.mimeType==="string"?record.response.mimeType:"application/octet-stream",new Blob([bytes]));
        if(record.bodyStatus!=="reading"){await releaseArtifact(capture.ownerKeyId,body.artifactRef);return;}
        record.body=body;capture.bodyBytes+=bytes.byteLength;record.bodyStatus="captured";
      })(),limit("body_timeout_ms"),"BODY_TIMEOUT");
    }catch(error){if(record.bodyStatus==="reading")record.bodyStatus=error instanceof BrowserOperationError&&error.details.reason==="BODY_TIMEOUT"?"timed_out":"unavailable";}
    finally{capture.reservedBodyBytes-=maximum;}
  })();
  capture.pending.add(task);void task.finally(()=>capture.pending.delete(task));
}
function receive(capture:Capture,event:DebuggerEvent|null,reason?:string):void {
  if(event===null){
    capture.lifetime.abort();
    if(capture.timer!==null)clearTimeout(capture.timer);
    capture.lease?.release();capture.lease=null;capture.cleanupPromise=null;capture.state="interrupted";capture.reason=reason??"DEBUGGER_DETACHED";
    for(const record of capture.records){if(record.state==="pending"){record.state="incomplete";record.bodyStatus="detached";}else if(record.bodyStatus==="reading")record.bodyStatus="detached";}
    capture.active.clear();capture.timer=setTimeout(()=>captures.delete(capture.captureId),limit("retention_ms"));return;
  }
  if(capture.state!=="running"||!event.method.startsWith("Network."))return;
  if(capture.expiresAt<=Date.now()){void stop(capture,"DURATION_EXPIRED");return;}
  const accepted=["Network.requestWillBeSent","Network.responseReceived","Network.loadingFinished","Network.loadingFailed","Network.dataReceived","Network.requestWillBeSentExtraInfo","Network.responseReceivedExtraInfo"];
  if(!accepted.includes(event.method))return;
  const bytes=new TextEncoder().encode(JSON.stringify(event)).byteLength;
  if(bytes>limit("maximum_event_bytes")||capture.metadataBytes+bytes>limit("maximum_metadata_bytes")){capture.lostEvents++;void stop(capture,"METADATA_LIMIT");return;}
  capture.metadataBytes+=bytes;
  const value=event.params,protocolId=value.requestId;
  if(typeof protocolId!=="string")return;
  const key=JSON.stringify([event.sessionId,protocolId]),previous=capture.active.get(key);
  if(event.method.endsWith("ExtraInfo")){capture.extraInfo.push(event);return;}
  if(event.method==="Network.requestWillBeSent"){
    if(!object(value.request)||typeof value.timestamp!=="number"||typeof value.wallTime!=="number"){capture.lostEvents++;return;}
    if(capture.records.length>=limit("maximum_requests")){capture.lostEvents++;void stop(capture,"REQUEST_LIMIT");return;}
    if(previous){previous.state=object(value.redirectResponse)?"redirected":"incomplete";previous.response=object(value.redirectResponse)?value.redirectResponse:previous.response;previous.finishedAt=value.timestamp;previous.bodyStatus=previous.state;}
    const record:NetworkRecord={requestId:capture.records.length+1,protocolRequestId:protocolId,sessionId:event.sessionId,redirectFrom:previous?.requestId??null,
      startedAt:value.wallTime*1000,timestamp:value.timestamp,request:value.request,resourceType:typeof value.type==="string"?value.type:null,
      response:null,finishedAt:null,encodedBytes:null,decodedBytes:0,state:"pending",bodyStatus:"pending",body:null,error:null};
    capture.records.push(record);capture.active.set(key,record);return;
  }
  if(!previous){capture.lostEvents++;return;}
  if(event.method==="Network.responseReceived"&&object(value.response))previous.response=value.response;
  else if(event.method==="Network.dataReceived"&&typeof value.dataLength==="number")previous.decodedBytes+=value.dataLength;
  else if(event.method==="Network.loadingFailed"){
    previous.state="failed";previous.error=typeof value.errorText==="string"?value.errorText:"LOAD_FAILED";previous.finishedAt=typeof value.timestamp==="number"?value.timestamp:null;previous.bodyStatus="failed";capture.active.delete(key);
  }else if(event.method==="Network.loadingFinished"){
    previous.state="complete";previous.finishedAt=typeof value.timestamp==="number"?value.timestamp:null;previous.encodedBytes=typeof value.encodedDataLength==="number"?value.encodedDataLength:null;
    capture.active.delete(key);captureBody(capture,previous);
  }
}
export async function startNetwork(caller:PublicKeyRecord,params:Record<string,unknown>,dispatch:DebuggerDispatch) {
  if(captures.size>=limit("maximum_captures"))throw new BrowserOperationError("CAPTURE_LIMIT");
  const capture:Capture={captureId:`nc1.${crypto.randomUUID()}`,ownerKeyId:caller.keyId,tabRef:params.tabRef as string,captureBodies:params.captureBodies as boolean,
    startedAt:Date.now(),expiresAt:Date.now()+(params.durationMs as number),
    state:"starting",reason:null,records:[],active:new Map(),extraInfo:[],metadataBytes:0,bodyBytes:0,reservedBodyBytes:0,lostEvents:0,lease:null,pending:new Set(),timer:null,stopPromise:null,cleanupPromise:null,lifetime:new AbortController(),protocol:new Set()};
  captures.set(capture.captureId,capture);
  const active=()=>{if(capture.lifetime.signal.aborted||Date.now()>=capture.expiresAt)throw new BrowserOperationError("CAPTURE_INTERRUPTED");};
  capture.timer=setTimeout(()=>void stop(capture,"DURATION_EXPIRED"),Math.max(0,capture.expiresAt-Date.now()));
  try{
    const acquisition=leaseDebuggerDomains(capture.tabRef,["Network"],effect=>dispatch(async()=>{
      // Guard reservation here. Already accepted body reads have their own reading/deadline check
      // and may drain during an explicit stop; they still pass current Key authorization.
      if(capture.lease===null)active();return effect();
    }),(event,reason)=>receive(capture,event,reason)).then(lease=>{
      try{active();capture.lease=lease;return lease;}catch(error){lease.release();throw error;}
    });
    await waitForFeatureReceipt(acquisition,limit("operation_timeout_ms"),"NETWORK_OPERATION_TIMEOUT",capture.lifetime.signal);active();
    capture.state="running";
    const receipt=capture.lease!.send("Network.enable",{maxTotalBufferSize:limit("maximum_body_total_bytes"),maxResourceBufferSize:limit("maximum_body_bytes"),maxPostDataSize:limit("maximum_event_bytes")},undefined,active);
    capture.protocol.add(receipt);void receipt.then(()=>capture.protocol.delete(receipt),()=>capture.protocol.delete(receipt));
    await waitForFeatureReceipt(receipt,limit("operation_timeout_ms"),"NETWORK_OPERATION_TIMEOUT",capture.lifetime.signal);active();
    return {capture:metadata(capture)};
  }catch(error){await stop(capture,"START_FAILED");
    if(capture.lease===null&&!(error instanceof BrowserOperationError)){if(capture.timer!==null)clearTimeout(capture.timer);captures.delete(capture.captureId);throw error;}
    throw new BrowserOperationError("NETWORK_START_FAILED",true,{capture:metadata(capture)});
  }
}
function headers(value:unknown):{name:string;value:string}[]{
  if(!object(value))return [];
  return Object.entries(value).flatMap(([name,value])=>String(value).split("\n").map(part=>({name,value:part})));
}
async function har(owner:string,capture:Capture) {
  const entries=[];
  for(const row of capture.records){
    const response=row.response??{},requestHeaders=headers(row.request.headers),responseHeaders=headers(response.headers);
    const elapsed=row.finishedAt===null?0:Math.max(0,(row.finishedAt-row.timestamp)*1000);
    let body:Record<string,unknown>={size:row.decodedBytes,mimeType:response.mimeType??"application/octet-stream",_captureStatus:row.bodyStatus};
    if(row.body){
      try{const data=await readArtifactBytes(owner,row.body.artifactRef,limit("maximum_body_bytes"));let binary="";for(const byte of data.bytes)binary+=String.fromCharCode(byte);body={...body,size:data.bytes.byteLength,text:btoa(binary),encoding:"base64"};}
      catch{body={...body,_captureStatus:"artifact_unavailable"};}
    }
    let queryString:{name:string;value:string}[]=[];try{queryString=[...new URL(String(row.request.url)).searchParams].map(([name,value])=>({name,value}));}catch{/* Non-URL protocol evidence remains in request.url. */}
    entries.push({startedDateTime:new Date(row.startedAt).toISOString(),time:elapsed,
      request:{method:row.request.method,url:row.request.url,httpVersion:response.protocol??"",cookies:[],headers:requestHeaders,queryString,headersSize:-1,bodySize:typeof row.request.postData==="string"?new TextEncoder().encode(row.request.postData).byteLength:row.request.hasPostData?-1:0,
        ...(typeof row.request.postData==="string"?{postData:{mimeType:requestHeaders.find(header=>header.name.toLowerCase()==="content-type")?.value??"application/octet-stream",text:row.request.postData}}:{})},
      response:{status:response.status??0,statusText:response.statusText??"",httpVersion:response.protocol??"",cookies:[],headers:responseHeaders,content:body,redirectURL:responseHeaders.find(header=>header.name.toLowerCase()==="location")?.value??"",headersSize:-1,bodySize:-1},
      cache:{},timings:{blocked:-1,dns:-1,connect:-1,send:0,wait:elapsed,receive:0,ssl:-1},
      _requestId:row.requestId,_protocolRequestId:row.protocolRequestId,_sessionId:row.sessionId,_state:row.state,
      _timingSource:"total_only_phase_breakdown_unavailable",_headerSource:"cdp_dictionary",_cookies:"not_parsed",_encodedTransferSize:row.encodedBytes});
  }
  return {log:{version:"1.2",creator:{name:"Browser Key Automation",version:chrome.runtime.getManifest().version},entries,_capture:metadata(capture),_supplementalEvents:capture.extraInfo}};
}
export async function runNetwork(owner:string,method:string,params:Record<string,unknown>):Promise<unknown> {
  const capture=owned(owner,params.captureId as string);
  if(method==="network.stop"){await stop(capture,null);return {capture:metadata(capture)};}
  if(method==="network.get"){const request=capture.records.find(record=>record.requestId===params.requestId);if(!request)throw new BrowserOperationError("REQUEST_NOT_FOUND");return {capture:metadata(capture),request};}
  if(method==="network.export"){
    if(capture.state==="running"||capture.state==="starting"||capture.state==="stopping")throw new BrowserOperationError("STOP_CAPTURE_BEFORE_EXPORT");
    const output=params.format==="har"?await har(owner,capture):{capture:metadata(capture),requests:capture.records,supplementalEvents:capture.extraInfo};
    return {capture:metadata(capture),artifact:await createTextArtifact(owner,"application/json",JSON.stringify(output))};
  }
  const items:NetworkRecord[]=[];let nextAfterRequestId=params.afterRequestId as number,hasMore=false;
  for(const row of capture.records){
    if(row.requestId<=nextAfterRequestId)continue;
    if(items.length>=Number(params.limit)||new TextEncoder().encode(JSON.stringify([...items,row])).byteLength>featureLimit("command.inline.maximum_result_json_bytes")-4096){hasMore=true;break;}
    items.push(row);nextAfterRequestId=row.requestId;
  }
  if(hasMore&&items.length===0)throw new BrowserOperationError("RESULT_TOO_LARGE_USE_EXPORT");
  return {capture:metadata(capture),items,nextAfterRequestId,hasMore};
}
