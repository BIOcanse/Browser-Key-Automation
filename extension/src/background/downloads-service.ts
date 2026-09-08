import { COMMAND_CATALOG } from "../generated/command-config.js";
import type { DebuggerDispatch } from "./debugger-service.js";
import { BrowserOperationError, exact, httpUrl, integer, text } from "./browser-feature-model.js";

export function parseDownloadParams(method:string,params:Record<string,unknown>):boolean {
  if(method==="downloads.start") return exact(params,["url","filename","conflictAction"]) && httpUrl(params.url) &&
    text(params.filename,1024) && !/[\\:\u0000-\u001f]/u.test(params.filename) && params.filename.split("/").every((part)=>part!==""&&part!==".."&&part!==".") &&
    ["uniquify","overwrite"].includes(params.conflictAction as string);
  if(method==="downloads.list")return exact(params,["query","limit","startedBefore"])&&text(params.query,1024,true)&&
    integer(params.limit,1,COMMAND_CATALOG.limits["command.downloads.maximum_page_size"]) &&
    (params.startedBefore===null||text(params.startedBefore,64)&&Number.isFinite(Date.parse(params.startedBefore)));
  if(method==="downloads.wait")return exact(params,["downloadId","timeoutMs"])&&integer(params.downloadId)&&integer(params.timeoutMs,1,COMMAND_CATALOG.limits["command.downloads.maximum_timeout_ms"]);
  return exact(params,["downloadId"])&&integer(params.downloadId);
}
function api():NonNullable<typeof chrome.downloads> {
  if(!chrome.downloads)throw new BrowserOperationError("DOWNLOADS_API_UNAVAILABLE");return chrome.downloads;
}
function publicDownload(item:ChromeDownloadItem) {
  return {downloadId:item.id,url:item.url,finalUrl:item.finalUrl,filename:item.filename,mime:item.mime,
    state:item.state,paused:item.paused,canResume:item.canResume,danger:item.danger,error:item.error??null,
    bytesReceived:item.bytesReceived,totalBytes:item.totalBytes,fileSize:item.fileSize,exists:item.exists,
    startTime:item.startTime,endTime:item.endTime??null};
}
async function get(id:number) {
  const item=(await api().search({id}))[0];if(!item)throw new BrowserOperationError("DOWNLOAD_NOT_FOUND");return publicDownload(item);
}
export async function runDownload(method:string,params:Record<string,unknown>,dispatch:DebuggerDispatch):Promise<unknown> {
  const downloads=api();
  if(method==="downloads.get")return {download:await dispatch(()=>get(params.downloadId as number))};
  if(method==="downloads.list") {
    const items=await dispatch(()=>downloads.search({query:params.query===""?[]:[params.query as string],limit:params.limit as number,orderBy:["-startTime"],
      ...(params.startedBefore===null?{}:{startedBefore:params.startedBefore as string})}));
    const projected=items.map(publicDownload);
    if(new TextEncoder().encode(JSON.stringify(projected)).byteLength>COMMAND_CATALOG.limits["command.inline.maximum_result_json_bytes"])throw new BrowserOperationError("RESULT_TOO_LARGE");
    return {items:projected,lastStartTime:items.at(-1)?.startTime??null,mayHaveMore:items.length===params.limit};
  }
  if(method==="downloads.wait") {
    const downloadId=params.downloadId as number,deadline=performance.now()+(params.timeoutMs as number);
    let version=0;
    const pending:{wake:(()=>void)|null}={wake:null};
    const changed=(delta:{readonly id:number})=>{if(delta.id===downloadId){version++;pending.wake?.();}};
    downloads.onChanged.addListener(changed);
    let lastDownload:Awaited<ReturnType<typeof get>>|null=null;
    try {
      while(true) {
        if(lastDownload!==null&&performance.now()>=deadline)return {status:"timeout",download:lastDownload};
        const before=version;
        let queryTimer:ReturnType<typeof setTimeout>|undefined;
        let download:Awaited<ReturnType<typeof get>>;
        try {download=await Promise.race([dispatch(()=>get(downloadId)),new Promise<never>((_,reject)=>{queryTimer=setTimeout(()=>reject(new BrowserOperationError("DOWNLOAD_QUERY_TIMEOUT")),Math.max(1,deadline-performance.now()));})]);}
        catch(error){if(error instanceof BrowserOperationError&&error.details.reason==="DOWNLOAD_QUERY_TIMEOUT"&&lastDownload!==null)return {status:"timeout",download:lastDownload};throw error;}
        finally{if(queryTimer!==undefined)clearTimeout(queryTimer);}
        lastDownload=download;
        if(download.state!=="in_progress")return {status:download.state,download};
        while(version===before) {
          const remaining=deadline-performance.now();
          if(remaining<=0)return {status:"timeout",download};
          await new Promise<void>((resolve)=>{
            const timer=setTimeout(()=>{pending.wake=null;resolve();},Math.ceil(remaining));
            pending.wake=()=>{clearTimeout(timer);pending.wake=null;resolve();};
            if(version!==before)pending.wake();
          });
        }
      }
    }finally{downloads.onChanged.removeListener(changed);pending.wake?.();}
  }
  if(!["downloads.start","downloads.pause","downloads.resume","downloads.cancel"].includes(method))throw new BrowserOperationError("UNKNOWN_DOWNLOAD_COMMAND");
  let launched=false,apiCompleted=false,downloadId=params.downloadId as number;
  try {
    await dispatch(async()=>{
      launched=true;
      if(method==="downloads.start")downloadId=await downloads.download({url:params.url as string,filename:params.filename as string,saveAs:false,conflictAction:params.conflictAction as "uniquify"|"overwrite"});
      else if(method==="downloads.pause")await downloads.pause(downloadId);
      else if(method==="downloads.resume")await downloads.resume(downloadId);
      else if(method==="downloads.cancel")await downloads.cancel(downloadId);
      apiCompleted=true;
    });
    return {download:await get(downloadId)};
  }catch(error){
    if(!launched)throw error;
    throw new BrowserOperationError(error instanceof BrowserOperationError?error.details.reason:"DOWNLOAD_OPERATION_FAILED",true,
      {operation:method,downloadId:Number.isSafeInteger(downloadId)?downloadId:null,apiCompleted});
  }
}
