import type { PublicKeyRecord } from "../shared/admin-protocol.js";
import { BrowserOperationError, exact, featureLimit, integer, object, text, waitForFeatureReceipt } from "./browser-feature-model.js";
import { leaseDebuggerDomains, type DebuggerDispatch, type DebuggerLease } from "./debugger-service.js";
import { isTabRefShape } from "./tab-service.js";

const limit=(name:string)=>featureLimit(`command.dialogs.${name}`);
interface Dialog {readonly dialogId:string;readonly type:string;readonly message:string;readonly defaultPrompt:string;readonly url:string;readonly hasBrowserHandler:boolean;readonly sessionId:string|null;readonly openedAt:number;}
interface Policy {readonly type:string;readonly message:string;readonly accept:boolean;readonly promptText:string|null;}
interface Watch {readonly watchId:string;readonly ownerKeyId:string;readonly tabRef:string;expiresAt:number;lease:DebuggerLease|null;dialog:Dialog|null;state:string;reason:string|null;timer:ReturnType<typeof setTimeout>|null;closing:Promise<void>|null;
  policy:Policy|null;responding:boolean;lastResponse:{dialogId:string;state:string}|null;readonly lifetime:AbortController;readonly protocol:Set<Promise<unknown>>;cleanup:Promise<unknown>|null;}
const watches=new Map<string,Watch>();
const watchShape=(value:unknown)=>typeof value==="string"&&/^dw1\.[a-f0-9-]{36}$/u.test(value);
export function parseDialogParams(method:string,params:Record<string,unknown>):boolean {
  if(method==="dialogs.start")return exact(params,["tabRef","durationMs","policy"])&&isTabRefShape(params.tabRef)&&integer(params.durationMs,1,limit("maximum_duration_ms"))&&policyValid(params.policy);
  if(!watchShape(params.watchId))return false;
  if(method==="dialogs.setPolicy")return exact(params,["watchId","policy"])&&policyValid(params.policy);
  if(method==="dialogs.respond")return exact(params,["watchId","dialogId","accept","promptText"])&&typeof params.dialogId==="string"&&/^jd1\.[a-f0-9-]{36}$/u.test(params.dialogId)&&typeof params.accept==="boolean"&&
    (params.promptText===null||text(params.promptText,limit("maximum_text_bytes"),true));
  return exact(params,["watchId"]);
}
function policyValid(value:unknown):boolean{return value===null||object(value)&&exact(value,["type","message","accept","promptText"])&&["alert","confirm","prompt","beforeunload"].includes(value.type as string)&&text(value.message,limit("maximum_text_bytes"),true)&&typeof value.accept==="boolean"&&(value.promptText===null||value.type==="prompt"&&value.accept===true&&text(value.promptText,limit("maximum_text_bytes"),true));}
const publicWatch=(watch:Watch)=>({watchId:watch.watchId,tabRef:watch.tabRef,expiresAt:watch.expiresAt,state:watch.state,reason:watch.reason,dialog:watch.dialog,onStop:"leave_open",policy:watch.policy,lastResponse:watch.lastResponse,pendingProtocolCalls:watch.protocol.size});
async function respond(watch:Watch,dialogId:string,accept:boolean,promptText:string|null):Promise<void>{
  const dialog=watch.dialog;
  if(watch.state!=="running"||!dialog||dialog.dialogId!==dialogId||watch.responding)throw new BrowserOperationError("DIALOG_STALE");
  if(promptText!==null&&(dialog.type!=="prompt"||!accept))throw new BrowserOperationError("PROMPT_TEXT_NOT_APPLICABLE");
  watch.responding=true;
  try{
    await watch.lease!.send("Page.handleJavaScriptDialog",{accept,...(promptText===null?{}:{promptText})},dialog.sessionId??undefined,()=>{
      if(watch.state!=="running"||watch.expiresAt<=Date.now()||watch.dialog?.dialogId!==dialogId)throw new BrowserOperationError("DIALOG_STALE");
      watch.dialog=null;watch.lastResponse={dialogId,state:"sending"};
    });
    watch.lastResponse={dialogId,state:"confirmed"};
  }catch(error){if(watch.lastResponse?.dialogId===dialogId)watch.lastResponse={dialogId,state:"unconfirmed"};throw error;}
  finally{watch.responding=false;}
}
function applyPolicy(watch:Watch):void{
  if(watch.responding)return;
  void(async()=>{
    // Each iteration consumes a newly armed policy; the previous dialog is never retried.
    while(watch.state==="running"&&watch.expiresAt>Date.now()&&!watch.responding){
      const policy=watch.policy,dialog=watch.dialog;
      if(!policy||!dialog||policy.type!==dialog.type||policy.message!==dialog.message)return;
      watch.policy=null;
      try{await respond(watch,dialog.dialogId,policy.accept,policy.promptText);}
      catch{watch.reason="POLICY_RESPONSE_FAILED";}
    }
  })();
}
async function close(watch:Watch,reason:string|null):Promise<void>{
  if(watch.closing)return watch.closing;
  if(watch.state==="stopped"||watch.state==="interrupted")return;
  watch.lifetime.abort();watch.reason=reason;
  if(watch.timer!==null)clearTimeout(watch.timer);watch.timer=null;watch.state="stopping";
  watch.closing=(async()=>{
    try{
      await waitForFeatureReceipt(Promise.allSettled([...watch.protocol]),limit("cleanup_timeout_ms"),"DIALOG_PROTOCOL_PENDING");
      if(watch.lease){watch.cleanup??=watch.lease.cleanup("Page.disable");await waitForFeatureReceipt(watch.cleanup,limit("cleanup_timeout_ms"),"DIALOG_CLEANUP_TIMEOUT");}
    }catch(error){if(watch.lease!==null){watch.state="cleanup_failed";watch.reason=error instanceof BrowserOperationError?error.details.reason:"DIALOG_CLEANUP_FAILED";}return;}
    if(watch.state!=="stopping")return;
    watch.lease?.release();watch.lease=null;watch.state=reason===null?"stopped":"interrupted";watch.reason=reason;
    watch.timer=setTimeout(()=>watches.delete(watch.watchId),limit("retention_ms"));
  })();
  try{await watch.closing;}finally{watch.closing=null;}
}
export async function startDialogs(caller:PublicKeyRecord,params:Record<string,unknown>,dispatch:DebuggerDispatch){
  if(watches.size>=limit("maximum_watches"))throw new BrowserOperationError("DIALOG_WATCH_LIMIT");
  const watch:Watch={watchId:`dw1.${crypto.randomUUID()}`,ownerKeyId:caller.keyId,tabRef:params.tabRef as string,expiresAt:Date.now()+(params.durationMs as number),lease:null,dialog:null,state:"starting",reason:null,timer:null,closing:null,policy:params.policy as Policy|null,responding:false,lastResponse:null,lifetime:new AbortController(),protocol:new Set(),cleanup:null};
  watches.set(watch.watchId,watch);
  const active=()=>{if(watch.lifetime.signal.aborted||Date.now()>=watch.expiresAt)throw new BrowserOperationError("CAPTURE_INTERRUPTED");};
  watch.timer=setTimeout(()=>void close(watch,"DURATION_EXPIRED"),Math.max(0,watch.expiresAt-Date.now()));
  try{
    const acquisition=leaseDebuggerDomains(watch.tabRef,["Page"],effect=>dispatch(async()=>{active();return effect();}),(event,reason)=>{
      if(event===null){watch.lifetime.abort();watch.lease?.release();watch.lease=null;watch.state="interrupted";watch.reason=reason??"DETACHED";if(watch.timer!==null)clearTimeout(watch.timer);watch.timer=setTimeout(()=>watches.delete(watch.watchId),limit("retention_ms"));return;}
      if(watch.state!=="running")return;
      if(Date.now()>=watch.expiresAt){void close(watch,"DURATION_EXPIRED");return;}
      if(event.method==="Page.javascriptDialogOpening"){
        const value=event.params;
        if(!text(value.type,64)||!text(value.message,limit("maximum_text_bytes"),true)||!text(value.url,8192,true)||typeof value.hasBrowserHandler!=="boolean"||!text(value.defaultPrompt??"",limit("maximum_text_bytes"),true)){
          watch.reason="DIALOG_METADATA_LIMIT";void close(watch,watch.reason);return;
        }
        watch.dialog={dialogId:`jd1.${crypto.randomUUID()}`,type:value.type,message:value.message,defaultPrompt:(value.defaultPrompt??"") as string,url:value.url,hasBrowserHandler:value.hasBrowserHandler,sessionId:event.sessionId,openedAt:Date.now()};
        applyPolicy(watch);
      }else if(event.method==="Page.javascriptDialogClosed"&&event.sessionId===watch.dialog?.sessionId)watch.dialog=null;
    }).then(lease=>{try{active();watch.lease=lease;return lease;}catch(error){lease.release();throw error;}});
    await waitForFeatureReceipt(acquisition,limit("operation_timeout_ms"),"DIALOG_OPERATION_TIMEOUT",watch.lifetime.signal);active();
    watch.state="running";
    const receipt=watch.lease!.send("Page.enable",{},undefined,active);watch.protocol.add(receipt);
    void receipt.then(()=>watch.protocol.delete(receipt),()=>watch.protocol.delete(receipt));
    await waitForFeatureReceipt(receipt,limit("operation_timeout_ms"),"DIALOG_OPERATION_TIMEOUT",watch.lifetime.signal);active();
    return {watch:publicWatch(watch)};
  }catch(error){await close(watch,"START_FAILED");
    if(watch.lease===null&&!(error instanceof BrowserOperationError)){if(watch.timer!==null)clearTimeout(watch.timer);watches.delete(watch.watchId);throw error;}
    throw new BrowserOperationError("DIALOG_START_FAILED",true,{watch:publicWatch(watch)});
  }
}
export async function runDialogs(owner:string,method:string,params:Record<string,unknown>){
  const watch=watches.get(params.watchId as string);if(!watch||watch.ownerKeyId!==owner)throw new BrowserOperationError("DIALOG_WATCH_NOT_FOUND");
  if(method==="dialogs.stop")await close(watch,null);
  else if(method==="dialogs.setPolicy"){
    if(watch.state!=="running")throw new BrowserOperationError("DIALOG_WATCH_STOPPED");
    watch.policy=params.policy as Policy|null;applyPolicy(watch);
  }
  else if(method==="dialogs.respond"){
    try{await respond(watch,params.dialogId as string,params.accept as boolean,params.promptText as string|null);}
    finally{applyPolicy(watch);}
  }
  return {watch:publicWatch(watch)};
}
