import { COMMAND_CATALOG } from "../../generated/command-config.js";
import type { PublicKeyRecord } from "../../shared/admin-protocol.js";
import { integer, onlyKeys, record } from "../actions/model.js";
import { assertScriptingTargetAvailable } from "../browser-service.js";
import { getTab, isTabRefShape, resolveCurrentTabTarget, resolveTabTarget } from "../tab-service.js";
import { getViewport, getWindow, windowSnapshot } from "../window-service.js";
import { attachDomRecorder, controlDomRecorder, isRawDomEvent } from "./dom.js";
import { publicRecording, RecordingError, type RecordedEvent, type RecordingDocument, type RecordingSession } from "./model.js";
import { changeRecording, createRecording, deleteRecording as deleteStoredRecording, inventoryRecordings, loadRecording, readRecordingEvents } from "./store.js";
import { discardNativeRecording, openNativeRecording, readNativeRecordingContinuously, stopNativeRecording, type NativeRecordingContext } from "./native.js";
const recordingId=(value:unknown):value is string=>typeof value==="string"&&/^rr1\.[a-f0-9-]{36}$/u.test(value);
const timers=new Map<string,{readonly handle:ReturnType<typeof setTimeout>;readonly deadline:number}>();
const terminal=(session:RecordingSession)=>["stopped","interrupted"].includes(session.state);
const inScope=(session:RecordingSession,tab:Pick<ChromeTab,"id"|"windowId">)=>session.scope==="window"?session.windowId===tab.windowId:session.tabId===tab.id;
let initialized=false;
let startup:Promise<void>=Promise.resolve();
export function parseRecordingParams(method:string,params:Record<string,unknown>):boolean {
  if(method==="recording.start") return onlyKeys(params,["tabRef","scope","mode","includeFrames","durationMs","retentionMs"])&&isTabRefShape(params.tabRef)&&
    ["dom","real"].includes(params.mode as string)&&["tab","window"].includes(params.scope as string)&&typeof params.includeFrames==="boolean"&&
    integer(params.durationMs,1,COMMAND_CATALOG.limits["command.recording.maximum_duration_ms"])&&integer(params.retentionMs,1,COMMAND_CATALOG.limits["command.recording.maximum_retention_ms"])&&params.retentionMs>=params.durationMs;
  if(method==="recording.list") return onlyKeys(params,["afterRecordingId","limit"])&&(params.afterRecordingId===null||recordingId(params.afterRecordingId))&&integer(params.limit,1,COMMAND_CATALOG.limits["command.recording.maximum_page_size"]);
  if(method==="recording.read") return onlyKeys(params,["recordingId","afterSequence","limit"])&&recordingId(params.recordingId)&&integer(params.afterSequence)&&integer(params.limit,1,COMMAND_CATALOG.limits["command.recording.maximum_page_size"]);
  return ["recording.get","recording.pause","recording.resume","recording.stop","recording.delete"].includes(method)&&onlyKeys(params,["recordingId"])&&recordingId(params.recordingId);
}
async function interrupt(session:RecordingSession,reason:string,deferCleanup=false):Promise<RecordingSession> {
  clearRecordingTimer(session.recordingId);
  const changed=await changeRecording(session.recordingId,(current)=>({session:terminal(current)?current:{...current,state:"interrupted",reason,lostEvents:current.lostEvents+1}}));
  if(changed.mode==="real") {
    await discardNativeRecording(changed).catch(()=>undefined);
    return loadRecording(changed.ownerKeyId,changed.recordingId);
  }
  const cleanup=()=>Promise.allSettled(changed.documents.filter((doc)=>!doc.sealed).map((doc)=>controlDomRecorder(changed.recordingId,doc,"stop")));
  // Ingress must acknowledge before asking the same document to flush/stop.
  if(deferCleanup)setTimeout(()=>{void cleanup();},0);else await cleanup();
  return changed;
}
function clearRecordingTimer(id:string):void {
  const timer=timers.get(id);if(timer!==undefined)clearTimeout(timer.handle);timers.delete(id);
}
function armRecordingTimer(session:RecordingSession):void {
  if(terminal(session)){clearRecordingTimer(session.recordingId);return;}
  const previous=timers.get(session.recordingId);
  if(previous!==undefined&&previous.deadline<=session.expiresAt)return;
  clearRecordingTimer(session.recordingId);
  const handle=setTimeout(()=>{
    if(timers.get(session.recordingId)?.handle!==handle)return;
    timers.delete(session.recordingId);
    void (async()=>{
      const current=await loadRecording(session.ownerKeyId,session.recordingId);
      if(terminal(current))return;
      await stopRecording(current.ownerKeyId,current.recordingId,"stop");
    })().catch(()=>undefined);
  },Math.max(1,session.expiresAt-Date.now()));
  timers.set(session.recordingId,{handle,deadline:session.expiresAt});
}
async function currentRecording(session:RecordingSession):Promise<RecordingSession> {
  const current=await loadRecording(session.ownerKeyId,session.recordingId);
  if(current.state!=="recording")throw new RecordingError({reason:"NOT_RECORDING"});
  if(current.expiresAt<=Date.now())throw new RecordingError({reason:"DURATION_EXPIRED"});
  return current;
}
async function attachTab(session:RecordingSession,tabId:number):Promise<void> {
  await currentRecording(session);
  const target=await resolveCurrentTabTarget(tabId);await assertScriptingTargetAvailable(target);
  const tab=await getTab(target.tabRef);
  if(!inScope(session,{id:tabId,windowId:tab.windowId}))throw new RecordingError({reason:"TAB_OUTSIDE_SCOPE"});
  if(tab.url===null||tab.urlTruncated)throw new RecordingError({reason:"TAB_URL_UNAVAILABLE"});
  const frames=await chrome.webNavigation.getAllFrames({tabId});
  if(frames.length>COMMAND_CATALOG.limits["command.recording.maximum_documents"])throw new RecordingError({reason:"DOCUMENT_LIMIT"});
  const byId=new Map(frames.map((frame)=>[frame.frameId,frame]));
  for(const frame of frames) {
    if(!session.includeFrames&&frame.frameId!==0)continue;
    if(frame.documentId===undefined||frame.errorOccurred)throw new RecordingError({reason:"DOCUMENT_UNAVAILABLE"});
    const framePath:{urlPattern:string;urlMatch:"exact";match:"unique"}[]=[];let current=frame;
    let locatorIssue:RecordingDocument["locatorIssue"]=null;
    while(current.frameId!==0) {
      if(framePath.length>=COMMAND_CATALOG.limits["command.ensure.maximum_frame_depth"])throw new RecordingError({reason:"FRAME_DEPTH_LIMIT"});
      if(frames.filter((item)=>item.parentFrameId===current.parentFrameId&&item.url===current.url).length!==1)locatorIssue="FRAME_URL_AMBIGUOUS";
      framePath.unshift({urlPattern:current.url,urlMatch:"exact",match:"unique"});
      const parent=byId.get(current.parentFrameId);if(parent===undefined)throw new RecordingError({reason:"FRAME_PARENT_UNAVAILABLE"});current=parent;
    }
    const doc:RecordingDocument={tabId,frameId:frame.frameId,documentId:frame.documentId,framePath,locatorIssue,acceptedThrough:0,sealed:false};
    let added=false;
    const next=await changeRecording(session.recordingId,(existing)=>{
      if(existing.state!=="recording" || existing.documents.some((item)=>item.documentId===doc.documentId))return {session:existing};
      if(existing.documents.length>=COMMAND_CATALOG.limits["command.recording.maximum_documents"])throw new RecordingError({reason:"DOCUMENT_LIMIT"});
      added=true;
      const tabs=existing.tabs.some((item)=>item.tabId===tabId)?existing.tabs:[...existing.tabs,{tabId,alias:`tab_${existing.tabs.length+1}`,initialUrl:tab.url!,title:tab.title}];
      return {session:{...existing,documents:[...existing.documents,doc],tabs}};
    });
    if(added) {
      await attachDomRecorder(next.recordingId,doc,async(effect)=>{
        await currentRecording(next);
        return effect();
      });
      const latest=await loadRecording(next.ownerKeyId,next.recordingId);
      if(!inScope(latest,await chrome.tabs.get(tabId)))throw new RecordingError({reason:"TAB_OUTSIDE_SCOPE"});
      if(latest.state!=="recording")await controlDomRecorder(next.recordingId,doc,latest.state==="paused"||latest.state==="pausing"?"pause":"stop");
    }
  }
}
export async function startRecording(caller:PublicKeyRecord,params:Record<string,unknown>,context?:NativeRecordingContext) {
  await startup;
  const mode=params.mode as "dom"|"real";
  if(mode==="real"&&context===undefined)throw new RecordingError({reason:"NATIVE_ROUTE_REQUIRED"});
  const target=await resolveTabTarget(params.tabRef as string),tab=await getTab(target.tabRef);
  await assertScriptingTargetAvailable(target);
  const baseline={window:await getWindow(tab.windowId),viewport:await getViewport(target.tabRef)};
  const now=Date.now(),expiresAt=now+(params.durationMs as number);
  const session:RecordingSession={recordingId:`rr1.${crypto.randomUUID()}`,ownerKeyId:caller.keyId,mode,state:"recording",scope:params.scope as "tab"|"window",tabId:target.tabId,
    windowId:tab.windowId,includeFrames:params.includeFrames as boolean,startedAt:now,updatedAt:now,expiresAt,retainUntil:now+(params.retentionMs as number),pausedAt:null,pausedMs:0,
    eventCount:0,byteLength:0,lostEvents:0,reason:null,baseline,documents:[],tabs:[]};
  await createRecording(session);
  armRecordingTimer(session);
  try {
    if(mode==="real") {
      await changeRecording(session.recordingId,current=>({session:{...current,tabs:[{tabId:target.tabId,alias:"tab_1",initialUrl:tab.url??"",title:tab.title}]}}));
      await openNativeRecording(session,target.tabRef,context!);
      readNativeRecordingContinuously(session);
      return {recording:publicRecording(await loadRecording(caller.keyId,session.recordingId))};
    }
    const targets=session.scope==="tab"?[target.tabId]:(await chrome.tabs.query({})).filter((item)=>item.windowId===session.windowId&&item.id!==undefined).map((item)=>item.id!);
    for(const tabId of targets)await attachTab(session,tabId);
    return {recording:publicRecording(await loadRecording(caller.keyId,session.recordingId))};
  } catch(error) {await interrupt(session,"ATTACH_FAILED");throw error;}
}
export async function acceptRecordingEvents(message:unknown,sender:ChromeMessageSender):Promise<unknown> {
  if(!record(message)||message.kind!=="recording.events"||!onlyKeys(message,["kind","recordingId","events","lost"])||!recordingId(message.recordingId)||
    sender.id!==chrome.runtime.id||sender.tab?.id===undefined||sender.frameId===undefined||sender.documentId===undefined||!Array.isArray(message.events)||
    message.events.length>COMMAND_CATALOG.limits["command.recording.maximum_batch_events"]||!message.events.every(isRawDomEvent)||!integer(message.lost))return {ok:false};
  const initial=(await inventoryRecordings()).find((item)=>item.recordingId===message.recordingId);
  if(initial===undefined||terminal(initial))return {ok:false};
  if(!initial.documents.some((doc)=>doc.tabId===sender.tab!.id&&doc.frameId===sender.frameId&&doc.documentId===sender.documentId))return {ok:false};
  try {
    if(!inScope(initial,await chrome.tabs.get(sender.tab.id))) {await interrupt(initial,"TAB_LEFT_SCOPE",true);return {ok:false};}
    if(initial.expiresAt<=Date.now()&&initial.state!=="stopping") {await interrupt(initial,"DURATION_EXPIRED",true);return {ok:false};}
    let acceptedThrough=0;
    const saved=await changeRecording(initial.recordingId,(current)=>{
      if(!["recording","pausing","stopping"].includes(current.state))throw new RecordingError({reason:"NOT_RECORDING"});
      const index=current.documents.findIndex((doc)=>doc.tabId===sender.tab!.id&&doc.frameId===sender.frameId&&doc.documentId===sender.documentId);
      if(index<0)throw new RecordingError({reason:"DOCUMENT_NOT_AUTHORIZED"});
      const document=current.documents[index]!;acceptedThrough=document.acceptedThrough;let sealed=document.sealed,lost=current.lostEvents+(message.lost as number);
      const events:RecordedEvent[]=[];
      for(const event of message.events as readonly import("./model.js").RawDomEvent[]) {
        if(event.documentSequence<=acceptedThrough)continue;
        if(sealed)throw new RecordingError({reason:"DOCUMENT_SEALED"});
        if(event.documentSequence!==acceptedThrough+1)lost+=event.documentSequence-acceptedThrough-1;
        acceptedThrough=event.documentSequence;
        sealed=event.kind==="boundary"&&event.reason==="DOCUMENT_UNLOADING";
        events.push({...event,recordingId:current.recordingId,sequence:current.eventCount+events.length+1,activeMs:Math.max(0,event.at-current.startedAt-current.pausedMs),tabId:document.tabId,frameId:document.frameId,documentId:document.documentId});
      }
      const documents=[...current.documents];documents[index]={...document,acceptedThrough,sealed};
      return {session:{...current,documents,lostEvents:lost,...(lost>current.lostEvents?{state:"interrupted" as const,reason:"EVENT_GAP"}:{})},events};
    });
    if(saved.state==="interrupted") {
      clearRecordingTimer(saved.recordingId);
      setTimeout(()=>{void Promise.allSettled(saved.documents.filter((doc)=>!doc.sealed).map((doc)=>controlDomRecorder(saved.recordingId,doc,"stop")));},0);
    }
    return {ok:true,acceptedThrough,continueRecording:!terminal(saved)};
  } catch(error) {
    if(error instanceof RecordingError&&error.details.reason==="RECORDING_LIMIT")await interrupt(initial,"RECORDING_LIMIT",true);
    return {ok:false};
  }
}
export async function stopRecording(ownerKeyId:string,id:string,operation:"pause"|"stop") {
  const initial=await loadRecording(ownerKeyId,id);
  if(initial.mode==="real") {
    if(terminal(initial)&&initial.native?.closed!==false||operation==="pause"&&initial.state==="paused")return {recording:publicRecording(initial)};
    const final=await stopNativeRecording(ownerKeyId,id,operation);
    if(terminal(final))clearRecordingTimer(id);
    return {recording:publicRecording(final)};
  }
  if(terminal(initial))return {recording:publicRecording(initial)};
  if(operation==="pause"&&initial.state==="paused")return {recording:publicRecording(initial)};
  let entered=false;
  const expected=operation==="pause"?"pausing":"stopping";
  const current=await changeRecording(id,(session)=>{
    if(terminal(session)||session.state==="stopping"||operation==="pause"&&["pausing","paused"].includes(session.state))return {session};
    entered=true;return {session:{...session,state:expected}};
  });
  if(!entered)return {recording:publicRecording(current)};
  let lost=0,incomplete=false;
  for(const document of current.documents.filter((doc)=>!doc.sealed)) {
    try { const result=await controlDomRecorder(id,document,operation);
      if(!record(result)||!integer(result.capturedThrough)||!integer(result.sentThrough)||result.capturedThrough!==result.sentThrough||result.terminal!==null)lost++;
      if(record(result)&&Array.isArray(result.unfinished)&&result.unfinished.length>0){lost++;incomplete=true;}
    } catch {lost++;}
  }
  const final=await changeRecording(id,(session)=>({session:session.state!==expected?session:{...session,state:lost>0?"interrupted":operation==="pause"?"paused":"stopped",pausedAt:operation==="pause"?Date.now():null,
    lostEvents:session.lostEvents+lost,reason:lost>0?incomplete?"INCOMPLETE_GESTURE":"TAIL_UNCONFIRMED":session.reason}}));
  if(terminal(final))clearRecordingTimer(id);
  return {recording:publicRecording(final)};
}
export async function resumeRecording(ownerKeyId:string,id:string,context?:NativeRecordingContext) {
  const initial=await loadRecording(ownerKeyId,id);
  if(initial.state!=="paused")throw new RecordingError({reason:"NOT_PAUSED"});
  if(initial.expiresAt<=Date.now())throw new RecordingError({reason:"DURATION_EXPIRED"});
  if(initial.mode==="real") {
    if(context===undefined)throw new RecordingError({reason:"NATIVE_ROUTE_REQUIRED"});
    try {
      const tab=initial.scope==="tab"?await chrome.tabs.get(initial.tabId):(await chrome.tabs.query({})).find(tab=>tab.windowId===initial.windowId&&tab.active);
      if(tab?.id===undefined)throw new RecordingError({reason:"SCOPE_UNAVAILABLE"});
      const target=await resolveCurrentTabTarget(tab.id),now=Date.now();
      const current=await changeRecording(id,session=>({session:{...session,state:"recording",pausedMs:session.pausedMs+Math.max(0,now-(session.pausedAt??now)),pausedAt:null}}));
      await recordBrowserEvent(current,tab.id,"window_changed",{window:await getWindow(current.windowId)},now);
      await openNativeRecording(current,target.tabRef,context);
      readNativeRecordingContinuously(current);
      return {recording:publicRecording(await loadRecording(ownerKeyId,id))};
    }catch(error){await interrupt(initial,"RESUME_FAILED");throw error;}
  }
  try {
    const tabs=(await chrome.tabs.query({})).filter((tab)=>tab.id!==undefined&&inScope(initial,tab));
    if(tabs.length===0)throw new RecordingError({reason:"SCOPE_UNAVAILABLE"});
    const frames=new Map<number,readonly ChromeWebNavigationFrame[]>();
    for(const tab of tabs)frames.set(tab.id!,await chrome.webNavigation.getAllFrames({tabId:tab.id!}));
    const now=Date.now();
    // Pausing confirmed each old tail before sampling stopped. Documents replaced
    // while paused can be sealed without treating unrecorded paused input as loss.
    const current=await changeRecording(id,(session)=>({session:session.state!=="paused"?session:{...session,state:"recording",pausedMs:session.pausedMs+Math.max(0,now-(session.pausedAt??now)),pausedAt:null,
      documents:session.documents.map((doc)=>({...doc,sealed:doc.sealed||!frames.get(doc.tabId)?.some((frame)=>frame.documentId===doc.documentId)}))}}));
    for(const doc of current.documents.filter((item)=>!item.sealed)){await currentRecording(current);await controlDomRecorder(id,doc,"resume");}
    for(const tab of tabs) {
      const main=frames.get(tab.id!)?.find((frame)=>frame.frameId===0);
      if(main!==undefined&&!initial.documents.some((doc)=>doc.tabId===tab.id&&doc.documentId===main.documentId))await recordBrowserEvent(current,tab.id!,"navigation",{url:tab.url??null,transition:"resume_context",origin:"external"},now);
      await attachTab(current,tab.id!);
    }
  }catch(error){await interrupt(initial,"RESUME_FAILED");throw error;}
  return {recording:publicRecording(await loadRecording(ownerKeyId,id))};
}
export async function readRecording(ownerKeyId:string,id:string,after:number,limit:number) {
  const result=await readRecordingEvents(ownerKeyId,id,after,limit);
  return {...result,recording:publicRecording(result.recording)};
}
export async function listRecordings(ownerKeyId:string,after:string|null,limit:number) {
  const records=(await inventoryRecordings()).filter((item)=>item.ownerKeyId===ownerKeyId&&item.retainUntil>Date.now()&&(after===null||item.recordingId>after)).sort((a,b)=>a.recordingId<b.recordingId?-1:1);
  return {items:records.slice(0,limit).map(publicRecording),nextAfterRecordingId:records.length>limit?records[limit-1]!.recordingId:null};
}
export async function deleteRecording(ownerKeyId:string,id:string) {
  const current=await loadRecording(ownerKeyId,id);
  if(!terminal(current))throw new RecordingError({reason:"STOP_BEFORE_DELETING"});
  if(current.mode==="real"&&current.native?.closed===false) {
    try {await discardNativeRecording(current);}
    catch(error) {
      // The App owns cleanup for a retired connection. Explicit draft deletion
      // can discard its metadata; it does not fabricate a native stop receipt.
      if(!(error instanceof RecordingError)||error.details.reason!=="CONNECTION_CHANGED")throw error;
    }
  }
  return deleteStoredRecording(ownerKeyId,id);
}
export {loadRecording,publicRecording};
async function recordBrowserEvent(session:RecordingSession,tabId:number,kind:"navigation"|"frame_navigation"|"tab_activated"|"unsupported"|"zoom"|"window_changed",data:Record<string,unknown>,at:number,
  frame?:{readonly frameId:number;readonly documentId:string}) {
  const tab=session.tabs.some(tab=>tab.tabId===tabId)?null:await chrome.tabs.get(tabId);
  await changeRecording(session.recordingId,(current)=>{
    if(current.state!=="recording")return {session:current};
    const event:RecordedEvent={...data,kind,recordingId:current.recordingId,sequence:current.eventCount+1,documentSequence:0,gesture:0,at,
      activeMs:Math.max(0,at-current.startedAt-current.pausedMs),tabId,frameId:frame?.frameId??0,documentId:frame?.documentId??"browser"};
    const tabs=tab===null||current.tabs.some(tab=>tab.tabId===tabId)?current.tabs:[...current.tabs,{tabId,alias:`tab_${current.tabs.length+1}`,initialUrl:tab.url??"",title:tab.title??null}];
    return {session:{...current,tabs},events:[event]};
  });
}
export function initializeRecordingService():void {
  if(initialized)return;initialized=true;
  startup=inventoryRecordings().then(async(records)=>{for(const session of records)if(!terminal(session))await interrupt(session,"WORKER_INTERRUPTED");});
  void startup.catch(()=>undefined);
  chrome.tabs.onRemoved.addListener((tabId)=>{void inventoryRecordings().then(async(records)=>{for(const session of records)if(!terminal(session)&&(session.mode==="real"?session.scope==="tab"&&session.tabId===tabId:session.documents.some((doc)=>doc.tabId===tabId&&!doc.sealed)))await interrupt(session,"TAB_CLOSED");}).catch(()=>undefined);});
  chrome.tabs.onDetached.addListener((tabId,details)=>{
    void inventoryRecordings().then(async(records)=>{
      for(const session of records)if(!terminal(session)&&(session.mode==="real"?session.scope==="tab"&&session.tabId===tabId:session.scope==="window"&&session.windowId===details.oldWindowId&&session.documents.some((doc)=>doc.tabId===tabId&&!doc.sealed)))await interrupt(session,"TAB_LEFT_SCOPE");
    }).catch(()=>undefined);
  });
  const entered=(tabId:number,windowId:number,reason:string)=>{
    const at=Date.now();void inventoryRecordings().then(async(records)=>{
      const tab=await chrome.tabs.get(tabId);
      for(const session of records)if(session.state==="recording"&&session.scope==="window"&&session.windowId===windowId) {
        try {
          await recordBrowserEvent(session,tabId,"unsupported",{reason},at);
          if(session.mode==="dom"&&/^(?:https?|file):/u.test(tab.url??""))await attachTab(session,tabId);
        }catch{await interrupt(session,"TAB_ATTACH_FAILED");}
      }
    }).catch(()=>undefined);
  };
  chrome.tabs.onCreated.addListener((tab)=>{if(tab.id!==undefined)entered(tab.id,tab.windowId,"NEW_TAB_REQUIRES_CREATION_BINDING");});
  chrome.tabs.onAttached.addListener((tabId,details)=>entered(tabId,details.newWindowId,"TAB_ENTERED_SCOPE_REQUIRES_MOVE_STEP"));
  chrome.tabs.onReplaced.addListener((addedTabId,removedTabId)=>{
    void inventoryRecordings().then(async(records)=>{
      const tab=await chrome.tabs.get(addedTabId);
      for(const session of records)if(!terminal(session)&&session.tabs.some((item)=>item.tabId===removedTabId)) {
        if(session.scope==="window"&&session.windowId!==tab.windowId){await interrupt(session,"TAB_LEFT_SCOPE");continue;}
        const updated=await changeRecording(session.recordingId,(current)=>{
          const logical=current.tabs.find((item)=>item.tabId===removedTabId)!;
          return {session:{...current,tabId:current.tabId===removedTabId?addedTabId:current.tabId,tabs:[...current.tabs,{...logical,tabId:addedTabId}],
            documents:current.documents.map((doc)=>({...doc,sealed:doc.sealed||current.state==="paused"&&doc.tabId===removedTabId}))}};
        });
        if(updated.mode==="dom"&&updated.state==="recording")try {await attachTab(updated,addedTabId);}catch{await interrupt(updated,"REPLACEMENT_ATTACH_FAILED");}
      }
    }).catch(()=>undefined);
  });
  chrome.webNavigation.onCommitted.addListener((details)=>{
    const at=Date.now();
    void inventoryRecordings().then(async(records)=>{
      const tab=await chrome.tabs.get(details.tabId);
      for(const session of records)if(session.state==="recording"&&(session.scope==="window"?session.windowId===tab.windowId:session.tabId===details.tabId)) {
        try {
          if(details.frameId===0) {
            const origin=details.transitionQualifiers?.includes("forward_back")?"unknown":["typed","auto_bookmark","keyword","keyword_generated","generated","reload"].includes(details.transitionType??"")?"external":["link","form_submit","auto_toplevel"].includes(details.transitionType??"")?"page":"unknown";
            await recordBrowserEvent(session,details.tabId,"navigation",{url:details.url??tab.url??null,transition:details.transitionType??null,origin},at);
          } else if(session.includeFrames) {
            await recordBrowserEvent(session,details.tabId,"frame_navigation",{url:details.url??null,transition:details.transitionType??null,
              origin:details.transitionQualifiers?.includes("forward_back")?"unknown":"page"},at,details);
          }
          if(session.mode==="dom")await attachTab(session,details.tabId);
        }catch{await interrupt(session,"NAVIGATION_ATTACH_FAILED");}
      }
    }).catch(()=>undefined);
  });
  const history=(details:{readonly tabId:number;readonly frameId:number;readonly documentId:string;readonly url:string},transition:string)=>{
    const at=Date.now();
    void inventoryRecordings().then(async(records)=>{const tab=await chrome.tabs.get(details.tabId);
      for(const session of records)if(session.state==="recording"&&(session.scope==="window"?session.windowId===tab.windowId:session.tabId===details.tabId)) {
        if(details.frameId===0)await recordBrowserEvent(session,details.tabId,"navigation",{url:details.url,transition:"history_state",origin:"page"},at);
        else if(session.includeFrames)await recordBrowserEvent(session,details.tabId,"frame_navigation",{url:details.url,transition,origin:"page"},at,details);
      }
    }).catch(()=>undefined);
  };
  chrome.webNavigation.onHistoryStateUpdated?.addListener(details=>history(details,"history_state"));
  chrome.webNavigation.onReferenceFragmentUpdated?.addListener(details=>history(details,"fragment"));
  chrome.tabs.onActivated.addListener((details)=>{
    const at=Date.now();void inventoryRecordings().then(async(records)=>{
      for(const session of records)if(session.state==="recording"&&session.windowId===details.windowId) {
        if(session.mode==="real"&&session.scope==="tab"&&session.tabId!==details.tabId){await interrupt(session,"TAB_NOT_ACTIVE");continue;}
        if(session.scope!=="window")continue;
        try {if(session.mode==="dom")await attachTab(session,details.tabId);await recordBrowserEvent(session,details.tabId,"tab_activated",{zoom:await chrome.tabs.getZoom(details.tabId)},at);}
        catch {await interrupt(session,"TAB_ACTIVATION_UNOBSERVABLE");}
      }
    }).catch(()=>undefined);
  });
  chrome.windows.onBoundsChanged?.addListener(window=>{
    const at=Date.now();
    void inventoryRecordings().then(async records=>{
      for(const session of records)if(session.mode==="real"&&session.state==="recording"&&session.windowId===window.id)
        await recordBrowserEvent(session,session.tabId,"window_changed",{window:windowSnapshot(session.windowId,window)},at);
    }).catch(()=>undefined);
  });
  chrome.tabs.onZoomChange?.addListener(details=>{
    const at=Date.now();void inventoryRecordings().then(async records=>{
      const tab=await chrome.tabs.get(details.tabId);
      for(const session of records)if(session.state==="recording"&&inScope(session,tab))
        await recordBrowserEvent(session,details.tabId,"zoom",{factor:details.newZoomFactor},at);
    }).catch(()=>undefined);
  });
}
