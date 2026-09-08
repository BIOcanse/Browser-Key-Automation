import { COMMAND_CATALOG } from "../../generated/command-config.js";
import { parseDomTarget } from "../ensure-service.js";
import { integer, onlyKeys, record } from "../actions/model.js";
import { RecordingError, type RawDomEvent, type RecordingDocument } from "./model.js";
const sampleTab=`tr1.${"A".repeat(22)}.1.${"A".repeat(22)}`;
const text=(value:unknown):value is string=>typeof value==="string" && new TextEncoder().encode(value).byteLength<=COMMAND_CATALOG.limits["command.recording.maximum_event_text_bytes"];
function locator(value:unknown):boolean {
  return record(value) && onlyKeys(value,["selector","shadowPath","role","name","nameMatch","match"]) &&
    parseDomTarget({kind:"locator",tabRef:sampleTab,framePath:[],...value})!==null;
}
function point(value:unknown):boolean { return record(value) && onlyKeys(value,["x","y"]) && [value.x,value.y].every((v)=>typeof v==="number"&&Number.isFinite(v)); }
export function isRawDomEvent(value:unknown):value is RawDomEvent {
  if(!record(value) || !integer(value.documentSequence,1) || !integer(value.gesture) || typeof value.at!=="number" || !Number.isFinite(value.at) || value.at<0) return false;
  const base=["documentSequence","at","gesture","kind"];
  if(value.kind==="click"||value.kind==="focus") return onlyKeys(value,[...base,"target"])&&locator(value.target);
  if(value.kind==="input") return onlyKeys(value,[...base,"target","value","events","inputType","data","contentEditable"])&&locator(value.target)&&text(value.value)&&
    ["input","change"].includes(value.events as string)&&text(value.inputType)&&(value.data===null||text(value.data))&&typeof value.contentEditable==="boolean";
  if(value.kind==="select") return onlyKeys(value,[...base,"target","values"])&&locator(value.target)&&Array.isArray(value.values)&&value.values.length<=COMMAND_CATALOG.limits["command.dom.query.maximum_results"]&&value.values.every(text);
  if(value.kind==="scroll") return onlyKeys(value,[...base,"target","left","top"])&&locator(value.target)&&[value.left,value.top].every((v)=>typeof v==="number"&&Number.isFinite(v));
  if(value.kind==="hover") return onlyKeys(value,[...base,"target","phase"])&&locator(value.target)&&["enter","leave"].includes(value.phase as string);
  if(value.kind==="drag") return onlyKeys(value,[...base,"from","to","mode","fromOffset","toOffset","fromClient","toClient","points"])&&locator(value.from)&&locator(value.to)&&
    ["html5","pointer"].includes(value.mode as string)&&point(value.fromOffset)&&point(value.toOffset)&&point(value.fromClient)&&point(value.toClient)&&Array.isArray(value.points)&&value.points.length<=COMMAND_CATALOG.limits["command.recording.maximum_pending_events"]&&value.points.every(point);
  if(value.kind==="boundary") return onlyKeys(value,[...base,"reason","url"])&&["DOCUMENT_ATTACHED","DOCUMENT_UNLOADING"].includes(value.reason as string)&&(value.url===undefined||text(value.url));
  if(value.kind==="unsupported") return onlyKeys(value,[...base,"reason","target","button"])&&text(value.reason)&&(value.target===undefined||locator(value.target))&&(value.button===undefined||integer(value.button,0,5));
  return false;
}
export async function attachDomRecorder(recordingId:string,document:RecordingDocument,dispatch:<T>(effect:()=>Promise<T>)=>Promise<T>) {
  const target={tabId:document.tabId,documentIds:[document.documentId]};
  await dispatch(()=>chrome.scripting.executeScript({target,world:"ISOLATED",injectImmediately:true,files:["content/recording.js"]}));
  const config={recordingId,maximumPending:COMMAND_CATALOG.limits["command.recording.maximum_pending_events"],maximumBatch:COMMAND_CATALOG.limits["command.recording.maximum_batch_events"],
    maximumShadowRoots:COMMAND_CATALOG.limits["command.recording.maximum_shadow_roots"],maximumScanNodes:COMMAND_CATALOG.limits["command.recording.maximum_scan_nodes"],
    maximumText:COMMAND_CATALOG.limits["command.recording.maximum_event_text_bytes"],maximumDepth:COMMAND_CATALOG.limits["command.ensure.maximum_frame_depth"],flushIntervalMs:COMMAND_CATALOG.limits["command.recording.flush_interval_ms"]};
  const results=await dispatch(()=>chrome.scripting.executeScript({target,world:"ISOLATED",func:(configuration)=>{
    const page=globalThis as unknown as {__BKA_RECORDER_V1__?:{start(config:typeof configuration):unknown}};
    return page.__BKA_RECORDER_V1__?.start(configuration);
  },args:[config]}));
  if(results.length!==1 || results[0]!.documentId!==document.documentId || results[0]!.result===undefined) throw new RecordingError({reason:"DOCUMENT_ATTACH_FAILED"});
  return results[0]!.result;
}
export async function controlDomRecorder(recordingId:string,document:RecordingDocument,operation:"pause"|"resume"|"stop"|"read") {
  const results=await chrome.scripting.executeScript({target:{tabId:document.tabId,documentIds:[document.documentId]},world:"ISOLATED",func:async(id,command)=>{
    const page=globalThis as unknown as {__BKA_RECORDER_V1__?:{control(recordingId:string,operation:typeof command):Promise<unknown>}};
    return await page.__BKA_RECORDER_V1__?.control(id,command);
  },args:[recordingId,operation]});
  if(results.length!==1 || results[0]!.documentId!==document.documentId) throw new RecordingError({reason:"DOCUMENT_CONTROL_FAILED"});
  return results[0]!.result;
}
