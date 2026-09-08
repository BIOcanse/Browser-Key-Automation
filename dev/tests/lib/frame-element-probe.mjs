import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pageEvaluate} from './cdp-client.mjs';

export async function runFrameElementProbe({call,baseUrl,windowId,workerClient,observations,save}) {
 const tab=(await call('tabs.create',{windowId,url:new URL('frame-capture',baseUrl).href,active:true})).tab;
 const tabRef=tab.tabRef;
 let lastShot=0;
 const pauseShot=async()=>{const remaining=650-(Date.now()-lastShot);if(remaining>0)await new Promise(resolve=>setTimeout(resolve,remaining));lastShot=Date.now();};
 const decode=async(file)=>pageEvaluate(workerClient,async data=>{
  const image=await createImageBitmap(new Blob([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],{type:'image/png'}));
  try{const canvas=new OffscreenCanvas(image.width,image.height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
   const colors=[[0,0],[Math.floor(image.width/2),Math.floor(image.height/2)],[image.width-1,image.height-1]].map(([x,y])=>[...ctx.getImageData(x,y,1,1).data]);
   return {width:image.width,height:image.height,colors};
  }finally{image.close();}
 },(await readFile(file)).toString('base64'));
 try{
  await call('page.wait',{tabRef,until:'complete'});
  const frames=(await call('frames.list',{tabRef})).items,nodes=[];
  for(const frame of frames.filter(frame=>frame.frameId!==0)){
   for(const color of ['green','red']){const match=await call('dom.query',{documentRef:frame.documentRef,selector:`#paint[data-color="${color}"]`,limit:1});
    if(match.items.length)nodes.push({color,frameId:frame.frameId,documentRef:frame.documentRef,nodeRef:match.items[0].nodeRef});
   }
  }
  assert.equal(nodes.length,2);assert.equal(new Set(frames.filter(frame=>frame.frameId!==0).map(frame=>frame.url)).size,1,'both frame URLs must be identical');
  const green=nodes.find(node=>node.color==='green'),red=nodes.find(node=>node.color==='red');
  const ordinary=await call('page.screenshot.element',{nodeRef:green.nodeRef,width:120,height:80},'ELEMENT_SCREENSHOT_FAILED');
  assert.equal(ordinary.details.feature,'frame-coordinate-mapping');assert.equal((await call('debugger.events.get',{tabRef})).attached,false);
  await call('debugger.attach',{tabRef});
  const missing=await call('page.screenshot.element',{nodeRef:green.nodeRef,width:120,height:80,frameMapping:'debugger'},'ELEMENT_SCREENSHOT_FAILED');
  assert.equal(missing.details.feature,'frame-session-not-attached');
  await call('debugger.send',{tabRef,method:'Target.setAutoAttach',params:{autoAttach:true,waitForDebuggerOnStart:false,flatten:true}});
  let attached=[];const until=Date.now()+5000;
  while(attached.length<2&&Date.now()<until){attached=(await call('debugger.events.get',{tabRef,limit:100})).items.filter(event=>event.method==='Target.attachedToTarget'&&event.params.targetInfo.type==='iframe');if(attached.length<2)await new Promise(resolve=>setTimeout(resolve,25));}
  assert.equal(attached.length,2);
  await pageEvaluate(workerClient,()=>{
   const records=[],injection=chrome.scripting.executeScript.bind(chrome.scripting),protocol=chrome.debugger.sendCommand.bind(chrome.debugger);
   globalThis.__frameProbe={records,restore(){chrome.scripting.executeScript=injection;chrome.debugger.sendCommand=protocol;}};
   chrome.scripting.executeScript=async request=>{try{const result=await injection(request);if(records.length<100)records.push({kind:'injection',func:request.func.name,target:request.target,result});return result;}catch(error){records.push({kind:'injection',func:request.func.name,error:String(error)});throw error;}};
   chrome.debugger.sendCommand=async(target,method,params)=>{try{
    const result=await protocol(target,method,params);if(records.length<100)records.push({kind:'protocol',target,method,...(method==='Runtime.callFunctionOn'?{functionName:params.functionDeclaration.slice(0,75),arguments:params.arguments}:{}),result});
    if(method==='DOM.resolveNode'&&result?.object?.objectId&&records.length<100){
     const nullArgument=await protocol(target,'Runtime.callFunctionOn',{objectId:result.object.objectId,functionDeclaration:'function(value){return {type:typeof value,isNull:value===null}}',arguments:[{value:null}],returnByValue:true,silent:true});
     records.push({kind:'isolated native CallArgument null round trip',nullArgument});
    }
    if(method==='Runtime.callFunctionOn'&&result?.result?.value?.reason==='stale'){
     const owner=await protocol(target,method,{objectId:params.objectId,functionDeclaration:'function(){return {tag:this.tagName,connected:this.isConnected,sameDocument:this.ownerDocument===document,ownerUrl:this.ownerDocument?.URL,documentUrl:document.URL,args:Array.from(arguments)}}',arguments:params.arguments,returnByValue:true,silent:true});
     records.push({kind:'original owner inspection after a failed capture, no capture retry',owner});
    }
    return result;
   }catch(error){records.push({kind:'protocol',target,method,error:String(error)});throw error;}};
  });
  for(const node of [green,red]){
   await pauseShot();
   const shot=await call('page.screenshot.element',{nodeRef:node.nodeRef,width:120,height:80,frameMapping:'debugger'});
   const pixels=await decode(await save(shot.artifact,`frame-${node.color}.png`));
   observations.push({evidence:'production exact document mapping with two identical cross-origin URLs, native PNG pixels',node,shot,pixels});
   const expected=node.color==='green'?[36,184,92,255]:[220,44,72,255];
   for(const pixel of pixels.colors)assert.deepEqual(pixel,expected);
   assert.deepEqual(shot.sourceRect,{x:node.color==='green'?109:449,y:79,width:120,height:80});
  }
  const prepare=async(frameId,changes)=>pageEvaluate(workerClient,async({url,frameId,changes})=>{
   const targets=(await chrome.tabs.query({})).filter(candidate=>candidate.url===url);if(targets.length!==1)throw new Error('nonunique isolated fixture');
   const current=(await chrome.webNavigation.getAllFrames({tabId:targets[0].id})).find(frame=>frame.frameId===frameId);if(!current)throw new Error('fixture document disappeared');
   return chrome.scripting.executeScript({target:{tabId:targets[0].id,documentIds:[current.documentId]},world:'ISOLATED',func:changes=>{
    for(const [selector,style] of Object.entries(changes.styles??{}))Object.assign(document.querySelector(selector).style,style);
    if(changes.nested){const frame=document.createElement('iframe');frame.id='nested';frame.name='green';Object.assign(frame.style,{left:'30px',top:'20px',width:'180px',height:'140px',borderWidth:'3px',padding:'2px'});
     const url=new URL('/frame-capture?child=2',location.href);url.hostname=location.hostname==='localhost'?'127.0.0.1':'localhost';frame.src=url.href;document.body.append(frame);
    }
   },args:[changes]});
  },{url:new URL('frame-capture',baseUrl).href,frameId,changes});
  const capture=async(node,name,width,height,expectedRect=null)=>{
   await pauseShot();const shot=await call('page.screenshot.element',{nodeRef:node.nodeRef,width,height,frameMapping:'debugger'});
   const pixels=await decode(await save(shot.artifact,`frame-${name}.png`));observations.push({evidence:`production frame geometry: ${name}`,shot,pixels});
   if(expectedRect)assert.deepEqual(shot.sourceRect,expectedRect);
   assert.deepEqual(pixels.colors[1],[36,184,92,255]);return {shot,pixels};
  };
  await prepare(0,{styles:{'#clip':{width:'160px'}}});
  const clipped=await capture(green,'parent-overflow',91,80,{x:109,y:79,width:91,height:80});
  assert.ok(clipped.pixels.colors.every(color=>JSON.stringify(color)==='[36,184,92,255]'));
  await prepare(0,{styles:{'#clip':{width:'340px',height:'260px'}}});
  await prepare(green.frameId,{styles:{'#paint':{position:'fixed',left:'270px',top:'180px',width:'80px',height:'80px'}}});
  await capture(green,'fixed-frame-viewport-clip',60,40,{x:319,y:219,width:30,height:20});
  await prepare(green.frameId,{styles:{'#paint':{position:'absolute',left:'60px',top:'40px',width:'120px',height:'80px'}}});
  await prepare(0,{styles:{'#green':{transform:'rotate(15deg)'}}});
  const rotated=await capture(green,'rotated-owner',160,140);
  assert.equal(rotated.pixels.colors[0][3],0);assert.equal(rotated.pixels.colors[2][3],0);
  assert.ok(rotated.shot.sourceRect.x>=72&&rotated.shot.sourceRect.x<=74);assert.ok(rotated.shot.sourceRect.y>=94&&rotated.shot.sourceRect.y<=96);
  await prepare(0,{styles:{'#green':{transform:'none'}}});
  for(const attachedEvent of attached)await call('debugger.send',{tabRef,sessionId:attachedEvent.params.sessionId,method:'Target.setAutoAttach',params:{autoAttach:true,waitForDebuggerOnStart:false,flatten:true}});
  await prepare(green.frameId,{styles:{'#paint':{display:'none'}},nested:true});
  let nested;const nestedDeadline=Date.now()+5000;
  while(!nested&&Date.now()<nestedDeadline){nested=(await call('frames.list',{tabRef})).items.find(frame=>frame.parentFrameId===green.frameId&&frame.url?.includes('child=2'));if(!nested)await new Promise(resolve=>setTimeout(resolve,25));}
  assert.ok(nested);let nestedNode;
  while(!nestedNode&&Date.now()<nestedDeadline){nestedNode=(await call('dom.query',{documentRef:nested.documentRef,selector:'#paint[data-color="green"]',limit:1})).items[0];if(!nestedNode)await new Promise(resolve=>setTimeout(resolve,25));}
  assert.ok(nestedNode);
  await capture(nestedNode,'nested-cross-origin',120,80,{x:144,y:104,width:120,height:80});
  await call('debugger.send',{tabRef,method:'Emulation.setDeviceMetricsOverride',params:{width:800,height:500,deviceScaleFactor:1.25,mobile:false}});
  await capture(nestedNode,'nested-dpr-1.25',120,80,{x:144,y:104,width:120,height:80});
  await call('debugger.send',{tabRef,method:'Emulation.clearDeviceMetricsOverride'});
  const after=await pageEvaluate(workerClient,async url=>{
   const targets=(await chrome.tabs.query({})).filter(candidate=>candidate.url===url);if(targets.length!==1)throw new Error('nonunique isolated fixture');
   return chrome.scripting.executeScript({target:{tabId:targets[0].id,allFrames:true},world:'ISOLATED',func:()=>({proof:globalThis.__BKA_CAPTURE_DOCUMENT_PROOF_V1__??null,scroll:[scrollX,scrollY],active:document.activeElement?.tagName})});
  },new URL('frame-capture',baseUrl).href);
  assert.ok(after.every(frame=>frame.result.proof===null));assert.ok(after.every(frame=>frame.result.scroll.every(value=>value===0)));
  observations.push({evidence:'mapping private proofs removed and every document scroll preserved',after});
  await call('debugger.send',{tabRef,method:'Runtime.enable'});await call('debugger.send',{tabRef,method:'Runtime.disable'});
  await call('debugger.send',{tabRef,method:'Target.setAutoAttach',params:{autoAttach:false,waitForDebuggerOnStart:false,flatten:true}});
 }finally{
  const records=await pageEvaluate(workerClient,()=>{const probe=globalThis.__frameProbe;if(!probe)return null;probe.restore();delete globalThis.__frameProbe;return probe.records;}).catch(()=>null);
  if(records)observations.push({evidence:'bounded original API receipts for the isolated frame mapping probe',records});
  await call('debugger.detach',{tabRef}).catch(()=>{});await call('tabs.close',{tabRef}).catch(()=>{});
 }
}
