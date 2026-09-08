import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';

const event=()=>({addListener(){},removeListener(){}});
test('scroll capture covers fractional DPR edges and preserves restoration evidence across deadlines and failures',async t=>{
 const originals={chrome:globalThis.chrome,canvas:globalThis.OffscreenCanvas,bitmap:globalThis.createImageBitmap};
 const {COMMAND_CATALOG}=await import('../../out/extension/generated/command-config.js');
 const {getRuntimeSettings,updateRuntimeSettings}=await import('../../out/extension/background/settings-service.js');
 const {releaseArtifact}=await import('../../out/extension/background/artifact-service.js');
 const storage={},tab={id:1,index:0,windowId:1,active:true,highlighted:false,pinned:false,incognito:false,status:'complete',title:'Fixture',url:'https://example.test'};
 const initial={x:0,y:125,width:758,height:565,clientWidth:743,clientHeight:550,contentWidth:743,contentHeight:2000,visualWidth:743.2,visualHeight:550.4,dpr:1.25,scale:1,direction:'ltr',writingMode:'horizontal-tb'};
 let layout,calls,draws,clock,readHook,sendHook,dispatchHook,encodeHook,bitmapHook,canvas;
 const reset=()=>{layout={...initial};calls=[];draws=[];clock=0;readHook=sendHook=dispatchHook=encodeHook=bitmapHook=()=>{};};reset();
 const time=t.mock.method(performance,'now',()=>clock);
 const expire=()=>{clock=COMMAND_CATALOG.limits['command.page.screenshot.maximum_scroll_duration_ms']+1;};
 globalThis.chrome={storage:{session:{async setAccessLevel(){},async get(key){return {[key]:storage[key]};},async set(items){Object.assign(storage,items);}}},
  tabs:{onRemoved:event(),onReplaced:event(),async query(){return [tab];},async get(){return tab;}},
  debugger:{onEvent:event(),onDetach:event(),async attach(){},async sendCommand(_target,method){calls.push(method);sendHook(method);return method==='Page.captureScreenshot'?{data:'AA=='}:{};}},
  scripting:{async executeScript(options){assert.deepEqual(options.target.documentIds??options.target.frameIds,options.target.documentIds?['doc-1']:[0]);const point=options.args[0];if(point){layout.x=point.x;layout.y=point.y;}readHook(point);return [{documentId:'doc-1',result:{...layout}}];}}};
 globalThis.OffscreenCanvas=class {constructor(width,height){this.width=width;this.height=height;canvas=this;}getContext(){return {drawImage(...args){draws.push(args.slice(1));}};}async convertToBlob(){encodeHook();return new Blob(['png'],{type:'image/png'});}};
 globalThis.createImageBitmap=async()=>{bitmapHook();return {width:Math.ceil(initial.width*initial.dpr),height:Math.ceil(initial.height*initial.dpr),close(){}};};
 const dispatch=async effect=>{dispatchHook();return effect();};
 try{
  const tabs=await import('../../out/extension/background/tab-service.js');tabs.initializeTabService();
  const tabRef=(await tabs.listTabs({afterTabId:null,limit:10})).items[0].tabRef;
  const {attachDebugger}=await import('../../out/extension/background/debugger-service.js');await attachDebugger(tabRef,dispatch);
  const {captureScrolledScreenshot}=await import('../../out/extension/background/capture/scroll-service.js');
  const capture=extra=>captureScrolledScreenshot('scroll-owner',{tabRef,format:'png',quality:90,...extra},dispatch);
  await t.test('full-page final pixel and bottom region at DPR 1.25, restoring nonzero scroll',async()=>{
   const full=await capture();assert.deepEqual([full.width,full.height,full.tiles,full.scrollRestored],[929,2500,4,true]);
   assert.equal(draws.at(-1)[5]+draws.at(-1)[7],2500);assert.ok(draws.every(draw=>draw[6]===929));
   assert.equal(layout.y,125);assert.equal(canvas.width,0);await releaseArtifact('scroll-owner',full.artifact.artifactRef);
   reset();const region=await capture({region:{x:0,y:1850,width:743,height:80}});
   assert.deepEqual([region.width,region.height,region.tiles],[929,100,1]);assert.equal(draws[0][1],500);assert.equal(layout.y,125);
   await releaseArtifact('scroll-owner',region.artifact.artifactRef);
  });
  await t.test('rounded CSS height never requests the missing bitmap row; later tiles cover it',async()=>{
   reset();layout.height=layout.clientHeight=341;layout.visualHeight=340.8000030517578;
   const create=globalThis.createImageBitmap;globalThis.createImageBitmap=async()=>({width:948,height:426,close(){}});
   try{
    const result=await capture();assert.equal(result.height,2500);assert.equal(draws.at(-1)[5]+draws.at(-1)[7],2500);
    assert.ok(draws.every(draw=>draw[1]+draw[3]<=426));assert.equal(layout.y,125);await releaseArtifact('scroll-owner',result.artifact.artifactRef);
   }finally{globalThis.createImageBitmap=create;reset();}
  });
  await t.test('a fractional viewport without scrolling has exactly the real bitmap extent',async()=>{
   reset();layout.y=0;layout.height=layout.clientHeight=layout.contentHeight=341;layout.visualHeight=340.8000030517578;
   const create=globalThis.createImageBitmap;globalThis.createImageBitmap=async()=>({width:948,height:426,close(){}});
   try{
    const result=await capture();assert.deepEqual([result.width,result.height,result.tiles],[929,426,1]);assert.equal(result.sourceRect.height,340.8);
    assert.equal(draws[0][3],426);assert.equal(draws[0][7],426);await releaseArtifact('scroll-owner',result.artifact.artifactRef);
    const captures=calls.filter(method=>method==='Page.captureScreenshot').length;
    await assert.rejects(capture({region:{x:0,y:340.8,width:1,height:0.2}}),error=>error.details.reason==='REGION_OUTSIDE_PAGE');
    assert.equal(calls.filter(method=>method==='Page.captureScreenshot').length,captures);
   }finally{globalThis.createImageBitmap=create;reset();}
  });
  await t.test('expired reads and dispatch gates prevent any later screenshot send',async()=>{
   for(const stage of ['read','dispatch']){
    reset();if(stage==='read')readHook=point=>{if(point?.y===0)expire();};
    else readHook=point=>{if(point?.y===0)dispatchHook=expire;};
    await assert.rejects(capture(),error=>error.details.reason==='SCREENSHOT_DEADLINE'&&error.details.commandMayHaveRun&&error.details.observation.scrollRestored);
    assert.equal(calls.filter(method=>method==='Page.captureScreenshot').length,0);assert.equal(layout.y,125);
   }
  });
  await t.test('a late last capture or bitmap cannot publish success and still restores',async()=>{
   for(const stage of ['capture','bitmap','encoding']){
    reset();if(stage==='capture')sendHook=method=>{if(method==='Page.captureScreenshot')expire();};
    else if(stage==='bitmap')bitmapHook=expire;else encodeHook=expire;
    await assert.rejects(capture({region:{x:0,y:1850,width:120,height:80}}),error=>error.details.reason==='SCREENSHOT_DEADLINE'&&error.details.observation.scrollRestored);
    assert.equal(calls.filter(method=>method==='Page.captureScreenshot').length,1);assert.equal(layout.y,125);assert.equal(canvas.width,0);
   }
  });
  await t.test('lost authority reports failed restoration and does not bypass the gate',async()=>{
   reset();sendHook=method=>{if(method==='Page.captureScreenshot')dispatchHook=()=>{throw new Error('authority lost');};};
   await assert.rejects(capture(),error=>error.details.commandMayHaveRun&&error.details.observation.scrollRestored===false);
   assert.equal(layout.y,0);assert.equal(canvas.width,0);
  });
  await t.test('encoding and artifact quota failures retain completed scroll restoration',async()=>{
   reset();encodeHook=()=>{throw new Error('encoding failed '+ 'large detail'.repeat(10000));};
   await assert.rejects(capture({region:{x:0,y:1850,width:120,height:80}}),error=>error.details.commandMayHaveRun&&error.details.observation.scrollRestored&&error.details.observation.phase==='encoding'&&error.details.observation.cause.startsWith('Error: encoding failed')&&error.details.observation.cause.length<=COMMAND_CATALOG.limits['command.page.screenshot.maximum_error_bytes']);
   reset();const settings=await getRuntimeSettings();await updateRuntimeSettings({...settings,expectedRevision:settings.revision,artifactMaximumBytes:1024});
   // Change the encoder before capture; the storage service enforces the real quota.
   const prototype=globalThis.OffscreenCanvas.prototype,convert=prototype.convertToBlob;
   prototype.convertToBlob=async()=>new Blob([new Uint8Array(1025)],{type:'image/png'});
   try{await assert.rejects(capture({region:{x:0,y:1850,width:120,height:80}}),error=>error.details.commandMayHaveRun&&error.details.observation.scrollRestored&&error.details.observation.phase==='artifact_storage');}
   finally{prototype.convertToBlob=convert;}
   assert.equal(layout.y,125);assert.equal(canvas.width,0);
  });
 }finally{time.mock.restore();globalThis.chrome=originals.chrome;globalThis.OffscreenCanvas=originals.canvas;globalThis.createImageBitmap=originals.bitmap;}
});
