import { COMMAND_CATALOG } from "../../generated/command-config.js";
import { createArtifact, releaseArtifact, type ArtifactMetadata } from "../artifact-service.js";
import { BrowserOperationError } from "../browser-feature-model.js";
import { sendDebuggerProtocol, type DebuggerDispatch } from "../debugger-service.js";
import { assertResolvedTabTarget, resolveTabTarget } from "../tab-service.js";
import { decodeProtocolBytes } from "./cdp-service.js";
import type { CaptureRect } from "./geometry-model.js";

interface Point {readonly x:number;readonly y:number;}
interface Layout extends Point {
  readonly documentId:string;readonly width:number;readonly height:number;readonly clientWidth:number;readonly clientHeight:number;
  readonly contentWidth:number;readonly contentHeight:number;readonly dpr:number;readonly scale:number;readonly direction:string;readonly writingMode:string;
  readonly visualWidth:number;readonly visualHeight:number;
}
const geometry=(layout:Layout)=>JSON.stringify({...layout,x:0,y:0});
export async function captureScrolledScreenshot(ownerKeyId:string,params:Record<string,unknown>,dispatch:DebuggerDispatch){
  const tabRef=params.tabRef as string,target=await resolveTabTarget(tabRef);
  // Resolve debugger availability before any explicitly permitted scroll.
  await sendDebuggerProtocol({tabRef,method:"Page.getLayoutMetrics",params:{}},dispatch);
  let documentId:string|undefined,scrolled=false;
  const read=async(point:Point|null=null,restoring=false):Promise<Layout>=>{
    const result=await dispatch(async()=>{
      assertResolvedTabTarget(target);
      if(point!==null){if(!restoring)checkDeadline();scrolled=true;}
      return chrome.scripting.executeScript({target:{tabId:target.tabId,...(documentId===undefined?{frameIds:[0]}:{documentIds:[documentId]})},world:"ISOLATED",
        args:[point,COMMAND_CATALOG.limits["command.page.screenshot.scroll_settle_ms"]],func:async(point:Point|null,waitMs:number)=>{
          const page=globalThis as unknown as {
            scrollX:number;scrollY:number;innerWidth:number;innerHeight:number;devicePixelRatio:number;visualViewport:{scale:number;width:number;height:number}|null;
            document:{documentElement:{clientWidth:number;clientHeight:number;scrollWidth:number;scrollHeight:number}};
            scrollTo(options:{left:number;top:number;behavior:string}):void;
            getComputedStyle(element:unknown):{direction:string;writingMode:string};
            requestAnimationFrame(callback:()=>void):number;cancelAnimationFrame(id:number):void;
          };
          if(point!==null){
            page.scrollTo({left:point.x,top:point.y,behavior:"instant"});
            await new Promise<void>(resolve=>{
              let first=0,second=0;
              const finish=()=>{clearTimeout(timer);page.cancelAnimationFrame(first);page.cancelAnimationFrame(second);resolve();};
              const timer=setTimeout(finish,waitMs);
              first=page.requestAnimationFrame(()=>{second=page.requestAnimationFrame(finish);});
            });
          }
          const root=page.document.documentElement,style=page.getComputedStyle(root);
          return {x:page.scrollX,y:page.scrollY,width:page.innerWidth,height:page.innerHeight,clientWidth:root.clientWidth,clientHeight:root.clientHeight,
            contentWidth:root.scrollWidth,contentHeight:root.scrollHeight,dpr:page.devicePixelRatio,scale:page.visualViewport?.scale??0,
            visualWidth:page.visualViewport?.width??0,visualHeight:page.visualViewport?.height??0,direction:style.direction,writingMode:style.writingMode};
        }});
    });
    const first=result[0];if(!first?.documentId||!first.result)throw new BrowserOperationError("SCREENSHOT_DOCUMENT_UNAVAILABLE",scrolled);
    if(documentId!==undefined&&first.documentId!==documentId)throw new BrowserOperationError("SCREENSHOT_DOCUMENT_CHANGED",scrolled);
    documentId=first.documentId;return {...first.result,documentId};
  };
  const original=await read(),baseline=geometry(original),dpr=original.dpr;
  if(original.direction!=="ltr"||original.writingMode!=="horizontal-tb"||original.scale!==1||![dpr,original.visualWidth,original.visualHeight].every(value=>Number.isFinite(value)&&value>0))throw new BrowserOperationError("UNSUPPORTED_SCROLL_CAPTURE_GEOMETRY");
  // A visual viewport maps to whole surface pixels. Its float representation
  // can be slightly above/below that boundary, whereas client/scroll dimensions
  // have already lost fractional CSS pixels. Neither needs an extra output row.
  const tileWidth=Math.round(original.visualWidth*dpr),tileHeight=Math.round(original.visualHeight*dpr);
  const contentWidth=original.contentWidth<=original.clientWidth?tileWidth/dpr:original.contentWidth;
  const contentHeight=original.contentHeight<=original.clientHeight?tileHeight/dpr:original.contentHeight;
  const clip=(params.region??{x:0,y:0,width:contentWidth,height:contentHeight}) as CaptureRect;
  const width=params.region===undefined&&original.contentWidth<=original.clientWidth?tileWidth:Math.ceil(clip.width*dpr);
  const height=params.region===undefined&&original.contentHeight<=original.clientHeight?tileHeight:Math.ceil(clip.height*dpr);
  const dimension=COMMAND_CATALOG.limits["command.page.screenshot.maximum_dimension"],maximumPixels=COMMAND_CATALOG.limits["command.page.screenshot.maximum_pixels"];
  if(![width,height,tileWidth,tileHeight,clip.x,clip.y].every(Number.isFinite)||width<=0||height<=0||tileWidth<=0||tileHeight<=0||width>dimension||height>dimension||width*height>maximumPixels)throw new BrowserOperationError("SCREENSHOT_PIXEL_LIMIT");
  if(clip.x<0||clip.y<0||clip.x+clip.width>contentWidth||clip.y+clip.height>contentHeight)throw new BrowserOperationError("REGION_OUTSIDE_PAGE");
  const tileCount=Math.ceil(width/tileWidth)*Math.ceil(height/tileHeight);
  if(tileCount>COMMAND_CATALOG.limits["command.page.screenshot.maximum_scroll_tiles"])throw new BrowserOperationError("SCREENSHOT_TILE_LIMIT");
  const canvas=new OffscreenCanvas(width,height),context=canvas.getContext("2d");
  if(!context)throw new BrowserOperationError("CANVAS_UNAVAILABLE");context.imageSmoothingEnabled=false;
  const deadline=performance.now()+COMMAND_CATALOG.limits["command.page.screenshot.maximum_scroll_duration_ms"];
  const checkDeadline=()=>{if(performance.now()>=deadline)throw new BrowserOperationError("SCREENSHOT_DEADLINE",scrolled);};
  let failure:unknown=null,restoration:Layout|null=null,tiles=0,bitmapSize:{width:number;height:number}|null=null;
  try{
    for(let y=0;y<height;){
      let rowHeight=0;
      for(let x=0;x<width;){
        checkDeadline();
        if(tiles>=COMMAND_CATALOG.limits["command.page.screenshot.maximum_scroll_tiles"])throw new BrowserOperationError("SCREENSHOT_TILE_LIMIT",scrolled);
        const pageX=clip.x+x/dpr,pageY=clip.y+y/dpr;
        const current=await read({x:Math.min(pageX,Math.max(0,original.contentWidth-original.clientWidth)),y:Math.min(pageY,Math.max(0,original.contentHeight-original.clientHeight))});
        checkDeadline();
        if(geometry(current)!==baseline)throw new BrowserOperationError("SCREENSHOT_GEOMETRY_CHANGED",scrolled);
        const sourceX=Math.round((pageX-current.x)*dpr),sourceY=Math.round((pageY-current.y)*dpr);
        if(sourceX<0||sourceY<0||sourceX>=tileWidth||sourceY>=tileHeight)throw new BrowserOperationError("SCROLL_POSITION_UNAVAILABLE",scrolled);
        const response=await sendDebuggerProtocol({tabRef,method:"Page.captureScreenshot",params:{format:"png",fromSurface:true,captureBeyondViewport:false}},dispatch,undefined,checkDeadline) as {data?:unknown};
        checkDeadline();
        const after=await read();
        checkDeadline();
        if(geometry(after)!==baseline||after.x!==current.x||after.y!==current.y)throw new BrowserOperationError("SCREENSHOT_GEOMETRY_CHANGED",scrolled);
        const bytes=decodeProtocolBytes(response.data,COMMAND_CATALOG.limits["build.artifact.hard_maximum_bytes"]),image=await createImageBitmap(new Blob([bytes],{type:"image/png"}));
        try{
          checkDeadline();
          if(Math.abs(image.width-original.width*dpr)>1||Math.abs(image.height-original.height*dpr)>1||bitmapSize!==null&&(bitmapSize.width!==image.width||bitmapSize.height!==image.height))
            throw new BrowserOperationError("SCREENSHOT_DIMENSIONS_CHANGED",scrolled,{bitmap:{width:image.width,height:image.height},viewport:{width:original.width,height:original.height,dpr}});
          bitmapSize??={width:image.width,height:image.height};
          // Integer CSS viewport dimensions can round up while the actual
          // surface rounds down. Advance by pixels genuinely present in this
          // bitmap; the following tile supplies the remainder of the output.
          const partWidth=Math.min(width-x,Math.min(tileWidth,image.width)-sourceX);
          const partHeight=Math.min(rowHeight||height-y,Math.min(tileHeight,image.height)-sourceY);
          if(partWidth<=0||partHeight<=0||rowHeight!==0&&partHeight!==rowHeight)throw new BrowserOperationError("SCROLL_POSITION_UNAVAILABLE",scrolled);
          rowHeight=partHeight;
          context.drawImage(image,sourceX,sourceY,partWidth,partHeight,x,y,partWidth,partHeight);
          x+=partWidth;tiles++;
        }finally{image.close();}
      }
      y+=rowHeight;
    }
  }catch(error){failure=error;}
  finally{
    if(scrolled){try{restoration=await read({x:original.x,y:original.y},true);}catch(error){failure??=error;}}
    else restoration=original;
  }
  const restored=restoration!==null&&geometry(restoration)===baseline&&restoration.x===original.x&&restoration.y===original.y;
  if(failure!==null||!restored){canvas.width=0;canvas.height=0;throw new BrowserOperationError(failure instanceof BrowserOperationError?failure.details.reason:failure===null?"SCREENSHOT_RESTORE_FAILED":"SCROLL_CAPTURE_FAILED",scrolled,{scrollRestored:restored,originalScroll:{x:original.x,y:original.y},lastScroll:restoration===null?null:{x:restoration.x,y:restoration.y},capture:failure instanceof BrowserOperationError?failure.details.observation??null:null});}
  const mediaType=params.format==="jpeg"?"image/jpeg":"image/png";
  let artifact:ArtifactMetadata|undefined,phase="encoding";
  try{
    checkDeadline();
    const blob=await canvas.convertToBlob({type:mediaType,quality:(params.quality as number)/100});
    checkDeadline();phase="artifact_storage";
    artifact=await createArtifact(ownerKeyId,mediaType,blob);
    checkDeadline();
    return {tabRef,artifact,width,height,sourceRect:clip,coordinates:"css_page",route:"scroll_stitch",viewportOnly:false,tiles,scrollRestored:true};
  }catch(error){
    let retainedArtifact:ArtifactMetadata|null=null;
    if(artifact){try{await releaseArtifact(ownerKeyId,artifact.artifactRef);}catch{retainedArtifact=artifact;}}
    const cause=error instanceof Error?new TextDecoder().decode(new TextEncoder().encode(`${error.name}: ${error.message}`
      .replace(/bk1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/gu,"[redacted-key]"))
      .subarray(0,COMMAND_CATALOG.limits["command.page.screenshot.maximum_error_bytes"]),{stream:true}):null;
    throw new BrowserOperationError(error instanceof BrowserOperationError?error.details.reason:"SCROLL_CAPTURE_FAILED",scrolled,
      {phase,scrollRestored:true,originalScroll:{x:original.x,y:original.y},retainedArtifact,
        cause});
  }finally{canvas.width=0;canvas.height=0;}
}
