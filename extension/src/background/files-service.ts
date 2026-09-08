import { COMMAND_CATALOG } from "../generated/command-config.js";
import { isArtifactRefShape, readArtifactBytes } from "./artifact-service.js";
import { assertScriptingTargetAvailable } from "./browser-service.js";
import { resolveNodeRefTarget, isNodeRefShape } from "./dom-service.js";
import { assertResolvedTabTarget, resolveTabTarget } from "./tab-service.js";
import type { DebuggerDispatch } from "./debugger-service.js";
import { BrowserOperationError, exact, integer, object, text } from "./browser-feature-model.js";

export interface UploadFile { readonly artifactRef: string; readonly name: string; readonly mime: string; readonly lastModified: number }
interface FilePayload extends UploadFile { readonly base64: string }

export function parseUploadParams(params: Record<string, unknown>): boolean {
  return exact(params,["nodeRef","files"]) && isNodeRefShape(params.nodeRef) && Array.isArray(params.files) &&
    params.files.length <= COMMAND_CATALOG.limits["command.files.maximum_count"] && params.files.every((file: unknown) =>
      object(file) && exact(file,["artifactRef","name","mime","lastModified"]) && isArtifactRefShape(file.artifactRef) &&
      text(file.name,255) && !/[\\/\u0000-\u001f]/u.test(file.name) && ![".",".."].includes(file.name) &&
      text(file.mime,255,true) && /^[\x20-\x7e]*$/u.test(file.mime) && integer(file.lastModified));
}

// Serialized into the extension isolated world of the exact NodeRef document.
function setFiles(nodeRef: string, files: readonly FilePayload[]) {
  interface FileInput { readonly isConnected: boolean; readonly ownerDocument: unknown; readonly tagName: string; readonly type: string;
    readonly disabled: boolean; readonly multiple: boolean; files: ArrayLike<File> | null; dispatchEvent(event: Event): boolean }
  const page = globalThis as unknown as { document: unknown; performance: {now(): number};
    __BKA_DOM_NODE_REGISTRY_V1__?: {nodes: Map<string,{element: FileInput; expiresAt: number}>};
    DataTransfer: new () => {items: {add(file: File): void}; files: ArrayLike<File>}; };
  const entry = page.__BKA_DOM_NODE_REGISTRY_V1__?.nodes.get(nodeRef), element = entry?.element;
  if (!entry || entry.expiresAt <= page.performance.now() || !element?.isConnected || element.ownerDocument !== page.document) return {ok:false,reason:"NODE_STALE"};
  if (element.tagName !== "INPUT" || element.type !== "file" || element.disabled || !element.multiple && files.length > 1) return {ok:false,reason:"FILE_INPUT_REQUIRED"};
  const transfer = new page.DataTransfer();
  for (const file of files) {
    const binary = atob(file.base64), bytes = new Uint8Array(binary.length);
    for (let index=0;index<binary.length;index++) bytes[index]=binary.charCodeAt(index);
    transfer.items.add(new File([bytes],file.name,{type:file.mime,lastModified:file.lastModified}));
  }
  element.files=transfer.files;
  const assigned = Array.from(element.files ?? [],(file) => ({name:file.name,mime:file.type,size:file.size,lastModified:file.lastModified}));
  element.dispatchEvent(new Event("input",{bubbles:true,composed:true}));
  element.dispatchEvent(new Event("change",{bubbles:true}));
  return {ok:true,files:assigned};
}

export async function uploadFiles(ownerKeyId:string,nodeRef:string,files:readonly UploadFile[],dispatch:DebuggerDispatch) {
  const node = resolveNodeRefTarget(nodeRef), target = await resolveTabTarget(node.tabRef);
  await assertScriptingTargetAvailable(target);
  const payload: FilePayload[]=[];
  let bytes=0;
  for (const file of files) {
    const data=await readArtifactBytes(ownerKeyId,file.artifactRef,COMMAND_CATALOG.limits["command.files.maximum_bytes"]-bytes);
    bytes+=data.bytes.byteLength;
    let binary="";
    for (let index=0;index<data.bytes.length;index++) binary+=String.fromCharCode(data.bytes[index]!);
    payload.push({...file,base64:btoa(binary)});
  }
  let launched=false;
  try {
    const entries=await dispatch(async()=>{
      assertResolvedTabTarget(target);
      if (resolveNodeRefTarget(nodeRef).documentId!==node.documentId) throw new BrowserOperationError("NODE_STALE",false);
      launched=true;
      return chrome.scripting.executeScript({target:{tabId:node.tabId,documentIds:[node.documentId]},world:"ISOLATED",func:setFiles,args:[nodeRef,payload]});
    });
    const entry=entries[0];
    if(entries.length!==1||entry?.documentId!==node.documentId||!entry.result) throw new BrowserOperationError("UPLOAD_RESULT_UNAVAILABLE",true);
    if(!entry.result.ok) throw new BrowserOperationError(entry.result.reason??"UPLOAD_FAILED",false);
    return {nodeRef,tabRef:node.tabRef,files:entry.result.files,byteLength:bytes,route:"dom",eventsTrusted:false};
  } catch(error) {
    if(error instanceof BrowserOperationError||!launched)throw error;
    throw new BrowserOperationError("UPLOAD_RESULT_UNAVAILABLE",true);
  }
}
