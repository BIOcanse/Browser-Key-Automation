import { COMMAND_CATALOG } from "../../generated/command-config.js";
import { createArtifact } from "../artifact-service.js";
import { BrowserOperationError, exact, integer, object } from "../browser-feature-model.js";
import { sendDebuggerProtocol, type DebuggerDispatch } from "../debugger-service.js";
import { isTabRefShape, resolveTabTarget } from "../tab-service.js";
import { getViewport } from "../window-service.js";
import type { CaptureRect } from "./geometry-model.js";

export function parseCdpScreenshotParams(method:string,params:Record<string,unknown>):boolean {
  const keys=["tabRef","format","quality","captureMethod","allowScroll",...(method==="page.screenshot.region"?["region"]:[])];
  if(!exact(params,keys)||!isTabRefShape(params.tabRef)||!["png","jpeg"].includes(params.format as string)||!integer(params.quality,0,100))return false;
  if(params.captureMethod==="cdp"?params.allowScroll!==false:params.captureMethod!=="scroll"||params.allowScroll!==true)return false;
  if(method!=="page.screenshot.region")return true;
  const region=params.region;
  return object(region)&&exact(region,["x","y","width","height"])&&["x","y","width","height"].every((key)=>typeof region[key]==="number"&&Number.isFinite(region[key]))&&
    (region.x as number)>=0&&(region.y as number)>=0&&(region.width as number)>0&&(region.height as number)>0;
}
export function decodeProtocolBytes(value:unknown,maximum:number):Uint8Array<ArrayBuffer> {
  if(typeof value!=="string"||value.length>Math.ceil(maximum/3)*4||value.length%4!==0||/[^A-Za-z0-9+/=]/u.test(value))throw new BrowserOperationError("INVALID_OR_OVERSIZED_PROTOCOL_BYTES");
  let binary:string;
  try{binary=atob(value);if(btoa(binary)!==value)throw new Error("Noncanonical base64");}
  catch{throw new BrowserOperationError("INVALID_OR_OVERSIZED_PROTOCOL_BYTES");}
  if(binary.length>maximum)throw new BrowserOperationError("PROTOCOL_BYTES_LIMIT");
  const bytes=new Uint8Array(binary.length);for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);return bytes;
}
export async function captureCdpScreenshot(ownerKeyId:string,params:Record<string,unknown>,dispatch:DebuggerDispatch) {
  const tabRef=params.tabRef as string;
  const target=await resolveTabTarget(tabRef);
  const readDomLayout=async()=>{
    const result=await chrome.scripting.executeScript({target:{tabId:target.tabId,frameIds:[0]},world:"ISOLATED",func:()=>{
      const page=globalThis as unknown as {document:{documentElement:{clientWidth:number;clientHeight:number;scrollWidth:number;scrollHeight:number;getBoundingClientRect():{width:number;height:number}}}};
      const root=page.document.documentElement,rect=root.getBoundingClientRect();return {clientWidth:root.clientWidth,clientHeight:root.clientHeight,scrollWidth:root.scrollWidth,scrollHeight:root.scrollHeight,width:rect.width,height:rect.height};
    }});return result[0]?.result;
  };
  const domBefore=await readDomLayout();
  const send=(method:string)=>sendDebuggerProtocol({tabRef,method,params:{}},dispatch);
  const before=await send("Page.getLayoutMetrics"),frameBefore=await send("Page.getFrameTree"),viewport=await getViewport(tabRef);
  if(!object(before)||!object(before.cssContentSize))throw new BrowserOperationError("LAYOUT_METRICS_UNAVAILABLE");
  const content=before.cssContentSize;
  const clip=(params.region??{x:content.x,y:content.y,width:content.width,height:content.height}) as CaptureRect;
  const dimension=COMMAND_CATALOG.limits["command.page.screenshot.maximum_dimension"],pixels=COMMAND_CATALOG.limits["command.page.screenshot.maximum_pixels"];
  const width=Math.ceil(clip.width*viewport.devicePixelRatio),height=Math.ceil(clip.height*viewport.devicePixelRatio);
  if(![clip.x,clip.y,clip.width,clip.height,width,height].every(Number.isFinite)||clip.width<=0||clip.height<=0||width>dimension||height>dimension||width*height>pixels)throw new BrowserOperationError("SCREENSHOT_PIXEL_LIMIT");
  if(clip.x<Number(content.x)||clip.y<Number(content.y)||clip.x+clip.width>Number(content.x)+Number(content.width)||clip.y+clip.height>Number(content.y)+Number(content.height))throw new BrowserOperationError("REGION_OUTSIDE_PAGE");
  const metrics=(value:unknown)=>object(value)?{content:value.cssContentSize,layout:value.cssLayoutViewport,visual:value.cssVisualViewport}:null;
  const documentIdentity=(value:unknown)=>object(value)&&object(value.frameTree)&&object(value.frameTree.frame)?{id:value.frameTree.frame.id,loaderId:value.frameTree.frame.loaderId}:null;
  const baseline=JSON.stringify({metrics:metrics(before),document:documentIdentity(frameBefore),viewport,dom:domBefore});
  const result=await sendDebuggerProtocol({tabRef,method:"Page.captureScreenshot",params:{format:params.format,quality:params.quality,clip:{...clip,scale:1},captureBeyondViewport:true,fromSurface:true}},dispatch);
  // One capture, then read-only observation of the browser's restoration.
  const started=performance.now(),deadline=started+COMMAND_CATALOG.limits["command.page.screenshot.settle_observation_ms"];
  const samples:Record<string,unknown>[]=[];
  while(true){
    const domAfter=await readDomLayout(),after=await send("Page.getLayoutMetrics"),frameAfter=await send("Page.getFrameTree"),viewportAfter=await getViewport(tabRef);
    const observed={metrics:metrics(after),document:documentIdentity(frameAfter),viewport:viewportAfter,dom:domAfter};
    samples.push({elapsedMs:Math.round(performance.now()-started),...observed});
    if(JSON.stringify(observed)===baseline)break;
    const remaining=deadline-performance.now();
    if(remaining<=0)throw new BrowserOperationError("SCREENSHOT_GEOMETRY_CHANGED",true,{baseline:JSON.parse(baseline),samples});
    await new Promise<void>(resolve=>setTimeout(resolve,Math.min(25,remaining)));
  }
  const bytes=decodeProtocolBytes(object(result)?result.data:null,COMMAND_CATALOG.limits["build.artifact.hard_maximum_bytes"]);
  const mediaType=params.format==="jpeg"?"image/jpeg":"image/png",blob=new Blob([bytes],{type:mediaType});
  const image=await createImageBitmap(blob);
  try {
    if(image.width>dimension||image.height>dimension||image.width*image.height>pixels)throw new BrowserOperationError("SCREENSHOT_PIXEL_LIMIT");
    if(image.width!==width||image.height!==height)throw new BrowserOperationError("SCREENSHOT_DIMENSIONS_CHANGED",false,{expected:{width,height},actual:{width:image.width,height:image.height}});
    const artifact=await createArtifact(ownerKeyId,mediaType,blob);
    return {tabRef,artifact,width:image.width,height:image.height,sourceRect:clip,coordinates:"css_page",route:"cdp",viewportOnly:false,tiles:1,scrollRestored:true};
  }finally{image.close();}
}
