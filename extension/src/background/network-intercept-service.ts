import type { PublicKeyRecord } from "../shared/admin-protocol.js";
import { isArtifactRefShape, readArtifactBytes } from "./artifact-service.js";
import { BrowserOperationError, exact, featureLimit, httpUrl, integer, object, text, waitForFeatureReceipt } from "./browser-feature-model.js";
import { leaseDebuggerDomains, type DebuggerDispatch, type DebuggerEvent, type DebuggerLease } from "./debugger-service.js";
import { isTabRefShape } from "./tab-service.js";

const limit=(name:string)=>featureLimit(`command.intercept.${name}`);
type Header={readonly name:string;readonly value:string};
type Rule={readonly urlPattern:string;readonly stage:"request"|"response";readonly action:Record<string,unknown>};
interface CompiledRule {readonly source:Rule;readonly method:string;readonly params:Readonly<Record<string,unknown>>;}
interface Entry {readonly sequence:number;readonly requestId:string;readonly sessionId:string|null;readonly url:string;readonly stage:string;readonly ruleIndex:number|null;readonly method:string;readonly at:number;state:string;}
interface Interceptor {
  readonly interceptId:string;readonly ownerKeyId:string;readonly tabRef:string;expiresAt:number;readonly requestTimeoutMs:number;rules:readonly CompiledRule[];
  lease:DebuggerLease|null;state:string;reason:string|null;timer:ReturnType<typeof setTimeout>|null;closing:Promise<void>|null;
  sequence:number;droppedThrough:number;readonly events:Entry[];readonly pending:Map<string,{entry:Entry;timer:ReturnType<typeof setTimeout>}>;
  readonly lifetime:AbortController;readonly protocol:Set<Promise<unknown>>;cleanup:Promise<unknown>|null;
}
const interceptors=new Map<string,Interceptor>();
const idShape=(value:unknown)=>typeof value==="string"&&/^ni1\.[a-f0-9-]{36}$/u.test(value);
function validHeaders(value:unknown):value is Header[]{return Array.isArray(value)&&value.length<=limit("maximum_headers")&&value.every(header=>object(header)&&exact(header,["name","value"])&&text(header.name,256)&&/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(header.name)&&text(header.value,8192,true)&&!/[\r\n\u0000]/u.test(header.value));}
function validRule(value:unknown):value is Rule {
  if(!object(value)||!exact(value,["urlPattern","stage","action"])||!text(value.urlPattern,2048)||/[\\\r\n\u0000]/u.test(value.urlPattern)||!["request","response"].includes(value.stage as string)||!object(value.action))return false;
  const action=value.action;
  if(action.kind==="fulfill")return exact(action,["kind","status","headers","artifactRef"])&&integer(action.status,200,599)&&validHeaders(action.headers)&&(action.artifactRef===null||isArtifactRefShape(action.artifactRef));
  if(action.kind==="fail")return exact(action,["kind","errorReason"])&&["Failed","Aborted","TimedOut","AccessDenied","ConnectionClosed","ConnectionReset","ConnectionRefused","ConnectionAborted","ConnectionFailed","NameNotResolved","InternetDisconnected","AddressUnreachable","BlockedByClient","BlockedByResponse"].includes(action.errorReason as string);
  if(action.kind!=="continue"||!Object.keys(action).every(key=>["kind","url","method","headers","postDataArtifactRef"].includes(key)))return false;
  if(value.stage==="response"&&Object.keys(action).length!==1)return false;
  return (action.url===undefined||httpUrl(action.url))&&(action.method===undefined||text(action.method,32)&&/^[A-Z]+$/u.test(action.method))&&
    (action.headers===undefined||validHeaders(action.headers))&&(action.postDataArtifactRef===undefined||isArtifactRefShape(action.postDataArtifactRef));
}
export function parseInterceptParams(method:string,params:Record<string,unknown>):boolean {
  if(method==="network.intercept.start")return exact(params,["tabRef","rules","durationMs","requestTimeoutMs"])&&isTabRefShape(params.tabRef)&&Array.isArray(params.rules)&&params.rules.length>0&&params.rules.length<=limit("maximum_rules")&&params.rules.every(validRule)&&new TextEncoder().encode(JSON.stringify(params.rules)).byteLength<=limit("maximum_rule_bytes")&&integer(params.durationMs,1,limit("maximum_duration_ms"))&&integer(params.requestTimeoutMs,1,limit("maximum_request_timeout_ms"));
  if(!idShape(params.interceptId))return false;
  if(method==="network.intercept.read")return exact(params,["interceptId","afterSequence","limit"])&&integer(params.afterSequence)&&integer(params.limit,1,limit("maximum_page_size"));
  return exact(params,["interceptId"]);
}
function matches(pattern:string,value:string):boolean{
  let p=0,v=0,star=-1,mark=0,steps=0;
  while(v<value.length){
    if(++steps>limit("maximum_match_steps"))throw new BrowserOperationError("PATTERN_MATCH_LIMIT");
    if(pattern[p]==="?"||pattern[p]===value[v]){p++;v++;}
    else if(pattern[p]==="*"){star=p++;mark=v;}
    else if(star>=0){p=star+1;v=++mark;}
    else return false;
  }
  while(pattern[p]==="*")p++;return p===pattern.length;
}
async function compileRules(owner:string,rules:readonly Rule[]):Promise<CompiledRule[]> {
  let total=0;
  const body=async(ref:string)=>{const data=await readArtifactBytes(owner,ref,Math.min(limit("maximum_body_bytes"),limit("maximum_body_total_bytes")-total));total+=data.bytes.byteLength;let binary="";for(const byte of data.bytes)binary+=String.fromCharCode(byte);return btoa(binary);};
  const compiled:CompiledRule[]=[];
  for(const rule of rules){
    const action=rule.action;
    const params:Record<string,unknown>={};let method="Fetch.continueRequest";
    if(action.kind==="fulfill") {method="Fetch.fulfillRequest";params.responseCode=action.status;params.responseHeaders=action.headers;params.body=action.artifactRef===null?"":await body(action.artifactRef as string);}
    else if(action.kind==="fail"){method="Fetch.failRequest";params.errorReason=action.errorReason;}
    else {for(const name of ["url","method","headers"])if(action[name]!==undefined)params[name]=action[name];if(action.postDataArtifactRef!==undefined)params.postData=await body(action.postDataArtifactRef as string);}
    compiled.push({source:structuredClone(rule),method,params});
  }
  return compiled;
}
function metadata(session:Interceptor){return {interceptId:session.interceptId,tabRef:session.tabRef,state:session.state,reason:session.reason,expiresAt:session.expiresAt,ruleCount:session.rules.length,pending:session.pending.size,pendingProtocolCalls:session.protocol.size,observed:session.sequence,droppedThroughSequence:session.droppedThrough,onStop:"continue",scope:"attached_target_only"};}
async function stop(session:Interceptor,reason:string|null):Promise<void>{
  if(session.closing)return session.closing;
  if(session.state==="stopped"||session.state==="interrupted")return;
  session.state="stopping";session.reason=reason;session.lifetime.abort();if(session.timer!==null)clearTimeout(session.timer);session.timer=null;
  session.closing=(async()=>{
    try{
      await waitForFeatureReceipt(Promise.allSettled([...session.protocol]),limit("cleanup_timeout_ms"),"INTERCEPT_PROTOCOL_PENDING");
      if(session.lease){session.cleanup??=session.lease.cleanup("Fetch.disable");await waitForFeatureReceipt(session.cleanup,limit("cleanup_timeout_ms"),"INTERCEPT_CLEANUP_TIMEOUT");}
    }catch(error){if(session.lease!==null){session.state="cleanup_failed";session.reason=error instanceof BrowserOperationError?error.details.reason:"INTERCEPT_CLEANUP_FAILED";}return;}
    if(session.state!=="stopping")return;
    session.lease?.release();session.lease=null;
    for(const pending of session.pending.values()){clearTimeout(pending.timer);pending.entry.state=pending.entry.state==="sending"?"unconfirmed_after_stop":"continued_on_stop";}
    session.pending.clear();session.state=session.reason===null?"stopped":"interrupted";
    session.timer=setTimeout(()=>interceptors.delete(session.interceptId),limit("retention_ms"));
  })();
  try{await session.closing;}finally{session.closing=null;}
}
function receive(session:Interceptor,event:DebuggerEvent|null,reason?:string):void{
  if(event===null){
    session.lifetime.abort();
    session.lease?.release();session.lease=null;session.reason=reason??"DETACHED";
    if(session.timer!==null)clearTimeout(session.timer);
    for(const pending of session.pending.values()){clearTimeout(pending.timer);pending.entry.state="unconfirmed_after_detach";}
    session.pending.clear();session.state="interrupted";session.timer=setTimeout(()=>interceptors.delete(session.interceptId),limit("retention_ms"));return;
  }
  if(event.method!=="Fetch.requestPaused"||session.state!=="running")return;
  const value=event.params;
  if(session.expiresAt<=Date.now()||session.pending.size>=limit("maximum_pending")){void stop(session,"INTERCEPT_LIMIT");return;}
  if(!text(value.requestId,1024)||!object(value.request)||!text(value.request.url,8192)){void stop(session,"INVALID_REQUEST_METADATA");return;}
  const stage=value.responseStatusCode!==undefined||value.responseErrorReason!==undefined?"response":"request";
  const key=JSON.stringify([event.sessionId,value.requestId,stage]);if(session.pending.has(key)){void stop(session,"DUPLICATE_PAUSE");return;}
  const url=value.request.url;
  const index=session.rules.findIndex(rule=>rule.source.stage===stage&&matches(rule.source.urlPattern,url)),rule=session.rules[index];
  const entry:Entry={sequence:++session.sequence,requestId:value.requestId,sessionId:event.sessionId,url:value.request.url,stage,ruleIndex:index<0?null:index,method:rule?.method??"Fetch.continueRequest",at:Date.now(),state:"pending"};
  session.events.push(entry);if(session.events.length>limit("maximum_events"))session.droppedThrough=session.events.shift()!.sequence;
  const timer=setTimeout(()=>{void stop(session,"REQUEST_TIMEOUT");},session.requestTimeoutMs);session.pending.set(key,{entry,timer});
  void (async()=>{
    let sent=false;
    try{
      await session.lease!.send(entry.method,{...(rule?.params??{}),requestId:entry.requestId},event.sessionId??undefined,()=>{
        if(session.state!=="running"||session.expiresAt<=Date.now()||session.pending.get(key)?.entry!==entry)throw new BrowserOperationError("INTERCEPT_STOPPED");sent=true;entry.state="sending";
      });
      entry.state="confirmed";
    }catch{entry.state=sent?(["unconfirmed_after_stop","unconfirmed_after_detach"].includes(entry.state)?entry.state:"unconfirmed"):"not_sent";void stop(session,"RULE_FAILED");}
    finally{clearTimeout(timer);if(session.pending.get(key)?.entry===entry)session.pending.delete(key);}
  })();
}
export async function startIntercept(caller:PublicKeyRecord,params:Record<string,unknown>,dispatch:DebuggerDispatch){
  if(interceptors.size>=limit("maximum_sessions"))throw new BrowserOperationError("INTERCEPT_SESSION_LIMIT");
  const session:Interceptor={interceptId:`ni1.${crypto.randomUUID()}`,ownerKeyId:caller.keyId,tabRef:params.tabRef as string,expiresAt:Date.now()+(params.durationMs as number),requestTimeoutMs:params.requestTimeoutMs as number,rules:[],lease:null,state:"starting",reason:null,timer:null,closing:null,sequence:0,droppedThrough:0,events:[],pending:new Map(),lifetime:new AbortController(),protocol:new Set(),cleanup:null};
  interceptors.set(session.interceptId,session);
  const active=()=>{if(session.lifetime.signal.aborted||Date.now()>=session.expiresAt)throw new BrowserOperationError("CAPTURE_INTERRUPTED");};
  session.timer=setTimeout(()=>void stop(session,"DURATION_EXPIRED"),Math.max(0,session.expiresAt-Date.now()));
  try{
    session.rules=await waitForFeatureReceipt(compileRules(caller.keyId,params.rules as unknown as Rule[]),limit("operation_timeout_ms"),"INTERCEPT_OPERATION_TIMEOUT",session.lifetime.signal);active();
    const acquisition=leaseDebuggerDomains(session.tabRef,["Fetch"],effect=>dispatch(async()=>{active();return effect();}),(event,reason)=>{try{receive(session,event,reason);}catch{void stop(session,"EVENT_PROCESSING_FAILED");}}).then(lease=>{
      try{active();session.lease=lease;return lease;}catch(error){lease.release();throw error;}
    });
    await waitForFeatureReceipt(acquisition,limit("operation_timeout_ms"),"INTERCEPT_OPERATION_TIMEOUT",session.lifetime.signal);active();session.state="running";
    const receipt=session.lease!.send("Fetch.enable",{patterns:session.rules.map(rule=>({urlPattern:rule.source.urlPattern,requestStage:rule.source.stage==="response"?"Response":"Request"})),handleAuthRequests:false},undefined,active);
    session.protocol.add(receipt);void receipt.then(()=>session.protocol.delete(receipt),()=>session.protocol.delete(receipt));
    await waitForFeatureReceipt(receipt,limit("operation_timeout_ms"),"INTERCEPT_OPERATION_TIMEOUT",session.lifetime.signal);active();return {intercept:metadata(session)};
  }catch(error){await stop(session,"START_FAILED");
    if(session.lease===null&&!(error instanceof BrowserOperationError)){if(session.timer!==null)clearTimeout(session.timer);interceptors.delete(session.interceptId);throw error;}
    throw new BrowserOperationError("INTERCEPT_START_FAILED",true,{intercept:metadata(session)});
  }
}
export async function runIntercept(owner:string,method:string,params:Record<string,unknown>){
  const session=interceptors.get(params.interceptId as string);if(!session||session.ownerKeyId!==owner)throw new BrowserOperationError("INTERCEPT_NOT_FOUND");
  if(method==="network.intercept.stop"){await stop(session,null);return {intercept:metadata(session)};}
  const items:Entry[]=[];let nextSequence=Math.max(params.afterSequence as number,session.droppedThrough),hasMore=false;
  for(const entry of session.events){if(entry.sequence<=nextSequence)continue;if(items.length>=Number(params.limit)||new TextEncoder().encode(JSON.stringify([...items,entry])).byteLength>featureLimit("command.inline.maximum_result_json_bytes")-4096){hasMore=true;break;}items.push(entry);nextSequence=entry.sequence;}
  return {intercept:metadata(session),items,nextSequence,hasMore};
}
