import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pageEvaluate} from './cdp-client.mjs';
import {saveArtifactFile} from '../../../app/client/src/artifact-files.mjs';
import {runBrowserDataProbe} from './browser-data-probe.mjs';
import {runTabSearchProbe} from './tab-search-probe.mjs';
import {runSemanticSearchProbe} from './semantic-search-probe.mjs';
import {runFrameMappingProbe} from './frame-mapping-probe.mjs';
import {runFrameElementProbe} from './frame-element-probe.mjs';

export async function runBrowserFeaturesProbe({forward,browserClient,connectPage,workerClient,baseUrl,sampleRoot,semanticModel=null,frameMappingProbe=false}) {
 await mkdir(sampleRoot,{recursive:true});
 const observations=[],artifacts=new Set(),fixtureUrl=new URL('browser-features',baseUrl).href;
 let targetId,page,tabRef;
 const call=async(method,params={},expectedError)=>{
  const response=await forward(method,params);observations.push({method,params,response:response.payload});
  if(expectedError){assert.equal(response.payload.error?.code,expectedError,JSON.stringify(response.payload));return response.payload.error;}
  assert.equal(response.payload.ok,true,JSON.stringify(response.payload));return response.payload.result;
 };
 const until=async(probe,message)=>{const end=Date.now()+7000;while(Date.now()<end){const value=await probe();if(value)return value;await new Promise(r=>setTimeout(r,40));}throw new Error(message);};
 const save=async(artifact,filename)=>{artifacts.add(artifact.artifactRef);const output=path.join(sampleRoot,filename);await saveArtifactFile({call,artifactRef:artifact.artifactRef,output});return output;};
 try {
  observations.push({browserVersion:await browserClient.send('Browser.getVersion')});
  targetId=(await browserClient.send('Target.createTarget',{url:fixtureUrl,newWindow:true})).targetId;page=await connectPage(targetId);
  const tab=await until(async()=>(await call('tabs.list',{limit:100})).items.find(t=>t.url===fixtureUrl),'Fixture tab unavailable');tabRef=tab.tabRef;
  await call('page.wait',{tabRef,until:'complete'});
  await runBrowserDataProbe({call,baseUrl,observations});
  await runTabSearchProbe({call,baseUrl,windowId:tab.windowId,activeTabRef:tabRef,observations});
  if(semanticModel)await runSemanticSearchProbe({call,baseUrl,windowId:tab.windowId,activeTabRef:tabRef,observations,...semanticModel});
  if(frameMappingProbe)await runFrameMappingProbe({call,baseUrl,windowId:tab.windowId,workerClient,observations});
  if(frameMappingProbe)await runFrameElementProbe({call,baseUrl,windowId:tab.windowId,workerClient,observations,save});
  const documentRef=(await call('frames.list',{tabRef})).items.find(frame=>frame.frameId===0).documentRef;
  const nodeRef=(await call('dom.query',{documentRef,selector:'#upload',limit:1})).items[0].nodeRef;
  const bytes=Buffer.from('真实上传 bytes 中文\u0000\u0001\u00ff');
  const upload=await call('artifact.upload.begin',{byteLength:bytes.length,mediaType:'application/octet-stream'});artifacts.add(upload.artifactRef);
  await call('artifact.upload.append',{artifactRef:upload.artifactRef,offset:0,dataBase64Url:bytes.toString('base64url')});
  await call('artifact.upload.commit',{artifactRef:upload.artifactRef,sha256:createHash('sha256').update(bytes).digest('hex')});
  const assigned=await call('files.upload',{nodeRef,files:[{artifactRef:upload.artifactRef,name:'中文 file.bin',mime:'application/octet-stream',lastModified:123456}]});
  assert.equal(assigned.eventsTrusted,false);assert.equal(assigned.byteLength,bytes.length);
  const actual=await until(()=>pageEvaluate(page,()=>window.uploadResult),'Upload body did not reach server');
  assert.deepEqual(actual.files[0].bytes,[...bytes]);assert.equal(actual.files[0].name,'中文 file.bin');
  assert.ok(Buffer.from(actual.server.base64,'base64').includes(bytes),'Multipart HTTP request retains every original byte');
  assert.deepEqual(await pageEvaluate(page,()=>window.uploadEvents),[{type:'input',trusted:false},{type:'change',trusted:false}]);
  await call('files.upload',{nodeRef,files:[]});assert.equal(await pageEvaluate(page,()=>document.querySelector('#upload').files.length),0);
  await call('downloads.start',{url:new URL('features-download',baseUrl).href,filename:'../escape'},'SCHEMA_INVALID');
  const downloadPath=path.join(sampleRoot,'downloads');await mkdir(downloadPath,{recursive:true});
  const started=await call('downloads.start',{url:new URL('features-download',baseUrl).href,filename:'sample.bin'});
  const completed=await call('downloads.wait',{downloadId:started.download.downloadId,timeoutMs:10000});assert.equal(completed.status,'complete');
  assert.deepEqual(await readFile(path.join(downloadPath,'sample.bin')),Buffer.from([0,1,2,3,200,255]));
  const slow=await call('downloads.start',{url:new URL('features-slow',baseUrl).href,filename:'slow.bin'}),downloadId=slow.download.downloadId;
  assert.equal((await call('downloads.wait',{downloadId,timeoutMs:1000})).status,'timeout');
  assert.equal((await call('downloads.pause',{downloadId})).download.paused,true);
  await call('downloads.resume',{downloadId});await call('downloads.cancel',{downloadId});
  assert.equal((await call('downloads.wait',{downloadId,timeoutMs:1000})).status,'interrupted');
  const list=await call('downloads.list',{limit:100});assert.ok(list.items.some(item=>item.downloadId===started.download.downloadId));
  await call('page.screenshot.fullPage',{tabRef},'DEBUGGER_OPERATION_FAILED');await call('debugger.attach',{tabRef});
  const network=await call('network.start',{tabRef}),captureId=network.capture.captureId;
  await call('debugger.send',{tabRef,method:'Network.disable',params:{}},'DEBUGGER_OPERATION_FAILED');
  await pageEvaluate(page,async()=>Promise.all([fetch('/features-redirect').then(r=>r.arrayBuffer()).then(b=>[...new Uint8Array(b)]),fetch('/features-echo',{method:'POST',headers:{'content-type':'text/plain'},body:'原请求 POST'}).then(r=>r.json())]));
  const requests=await until(async()=>{const result=await call('network.read',{captureId,limit:100});return result.items.filter(r=>['/features-download','/features-echo'].some(p=>r.request.url.endsWith(p))&&r.bodyStatus==='captured').length===2?result.items:null;},'Original response bodies unavailable');
  const binary=requests.find(r=>r.request.url.endsWith('/features-download'));
  const binaryFile=await save(binary.body,'network-original.bin');assert.deepEqual(await readFile(binaryFile),Buffer.from([0,1,2,3,200,255]));
  assert.ok(requests.some(r=>r.state==='redirected'));assert.ok(binary.redirectFrom>0);
  const post=requests.find(r=>r.request.url.endsWith('/features-echo'));assert.equal(post.request.postData,'原请求 POST');
  await call('network.stop',{captureId});
  const exported=await call('network.export',{captureId,format:'har'}),harFile=await save(exported.artifact,'capture.har');
  const har=JSON.parse(await readFile(harFile,'utf8'));assert.equal(har.log.version,'1.2');assert.ok(har.log.entries.some(e=>e.request.method==='POST'&&e.request.postData.text==='原请求 POST'));
  await pageEvaluate(page,async()=>{console.log('telemetry cached fixture');await new Promise(resolve=>setTimeout(resolve,20));});
  const consoleId=(await call('console.start',{tabRef})).capture.captureId;
  const performanceId=(await call('performance.start',{tabRef})).capture.captureId;
  const firstSample=await call('performance.sample',{captureId:performanceId});
  await pageEvaluate(page,()=>{
   console.log('telemetry live fixture',{answer:42});console.warn('telemetry warning fixture');
   const container=document.createElement('div');container.hidden=true;
   for(let index=0;index<200;index++)container.append(document.createElement('span'));document.body.append(container);
   setTimeout(()=>{throw new Error('telemetry uncaught fixture');},0);
  });
  const consoleRead=await until(async()=>{
   const result=await call('console.read',{captureId:consoleId,limit:100});
   return result.items.some(item=>item.method==='Runtime.exceptionThrown'&&JSON.stringify(item.params).includes('telemetry uncaught fixture'))?result:null;
  },'Console messages and original exception unavailable');
  assert.ok(consoleRead.items.some(item=>JSON.stringify(item.params).includes('telemetry live fixture')));
  assert.ok(consoleRead.items.some(item=>item.params.type==='warning'));
  assert.equal(consoleRead.items.some(item=>JSON.stringify(item.params).includes('telemetry cached fixture')),false);
  assert.equal(JSON.stringify(consoleRead.items).includes('"objectId"'),false);
  const secondSample=await call('performance.sample',{captureId:performanceId});
  const metric=(sample,name)=>sample.sample.metrics.find(value=>value.name===name)?.value;
  assert.ok(Number.isFinite(metric(firstSample,'TaskDuration')));assert.ok(metric(secondSample,'TaskDuration')>=metric(firstSample,'TaskDuration'));
  assert.ok(metric(secondSample,'Nodes')>=metric(firstSample,'Nodes')+200);
  const stoppedConsole=await call('console.stop',{captureId:consoleId});assert.equal(stoppedConsole.capture.state,'stopped');assert.equal(stoppedConsole.capture.failedReleases,0);
  await call('performance.stop',{captureId:performanceId});
  const consoleFile=await save((await call('console.export',{captureId:consoleId})).artifact,'console.json');
  const performanceFile=await save((await call('performance.export',{captureId:performanceId})).artifact,'performance.json');
  assert.deepEqual(JSON.parse(await readFile(consoleFile,'utf8')).records,consoleRead.items);
  assert.equal(JSON.parse(await readFile(performanceFile,'utf8')).samples.length,2);
  const historicalId=(await call('console.start',{tabRef,includeExisting:true})).capture.captureId;
  const historical=await call('console.read',{captureId:historicalId,limit:100});
  assert.ok(historical.items.some(item=>item.historical===true&&JSON.stringify(item.params).includes('telemetry cached fixture')));
  assert.equal((await call('console.stop',{captureId:historicalId})).capture.state,'stopped');
  observations.push({evidence:'console snapshots, cached message choice, exact handle release and original performance metrics',consoleRead,firstSample,secondSample});
  const watch=(await call('dialogs.start',{tabRef,policy:{type:'alert',message:'alert fixture',accept:true,promptText:null}})).watch,watchId=watch.watchId;
  const node=async selector=>(await call('dom.query',{documentRef,selector,limit:1})).items[0].nodeRef;
  await call('dom.click',{nodeRef:await node('#alert')});
  await until(async()=>(await call('dialogs.get',{watchId})).watch.lastResponse?.state==='confirmed','Declared alert policy did not unblock same-Key click');
  await call('dialogs.setPolicy',{watchId,policy:{type:'confirm',message:'confirm fixture',accept:false,promptText:null}});
  await call('dom.click',{nodeRef:await node('#confirm')});assert.equal(await pageEvaluate(page,()=>window.dialogResult),false);
  await call('dialogs.setPolicy',{watchId,policy:{type:'prompt',message:'prompt fixture',accept:true,promptText:'回答中文'}});
  await call('dom.click',{nodeRef:await node('#prompt')});assert.equal(await pageEvaluate(page,()=>window.dialogResult),'回答中文');
  await call('dialogs.respond',{watchId,dialogId:`jd1.${crypto.randomUUID()}`,accept:true},'BROWSER_OPERATION_FAILED');
  await call('dialogs.stop',{watchId});
  const intercepted=await call('network.intercept.start',{tabRef,rules:[
    {urlPattern:new URL('features-replace',baseUrl).href,stage:'request',action:{kind:'fulfill',status:200,headers:[{name:'content-type',value:'application/octet-stream'}],artifactRef:upload.artifactRef}},
    {urlPattern:new URL('features-download',baseUrl).href,stage:'response',action:{kind:'fulfill',status:201,headers:[{name:'content-type',value:'application/octet-stream'}],artifactRef:upload.artifactRef}},
    {urlPattern:new URL('features-echo',baseUrl).href,stage:'request',action:{kind:'continue',method:'POST',headers:[{name:'content-type',value:'text/plain'}],postDataArtifactRef:upload.artifactRef}},
    {urlPattern:new URL('features-fail',baseUrl).href,stage:'request',action:{kind:'fail',errorReason:'BlockedByClient'}},
  ]}),interceptId=intercepted.intercept.interceptId;
  const replaced=await pageEvaluate(page,async()=>{
    const first=await fetch('/features-replace'),response=await fetch('/features-download'),echo=await (await fetch('/features-echo')).json();
    let failed=false;try{await fetch('/features-fail');}catch{failed=true;}
    return {first:[...new Uint8Array(await first.arrayBuffer())],response:[...new Uint8Array(await response.arrayBuffer())],status:response.status,echo,failed};
  });
  assert.deepEqual(replaced.first,[...bytes]);assert.deepEqual(replaced.response,[...bytes]);assert.equal(replaced.status,201);assert.equal(replaced.echo.body,bytes.toString('utf8'));assert.equal(replaced.failed,true);
  const rules=await until(async()=>{const read=await call('network.intercept.read',{interceptId});return read.items.length===4&&read.items.every(item=>item.state==='confirmed')?read:null;},'Rule outcomes did not settle');
  await call('network.intercept.stop',{interceptId});assert.deepEqual(await pageEvaluate(page,async()=>[...new Uint8Array(await (await fetch('/features-download')).arrayBuffer())]),[0,1,2,3,200,255]);
  observations.push({evidence:'request rewrite, response replacement, failure and stop cleanup',replaced,rules});
  observations.push({evidence:'original request bodies, redirect hop, HAR and all three JS dialog policies',requests:requests.map(r=>({id:r.requestId,url:r.request.url,state:r.state,bodyStatus:r.bodyStatus}))});
  await pageEvaluate(page,()=>scrollTo({top:125,behavior:'instant'}));
  const before=await call('page.viewport.get',{tabRef});assert.ok(before.scrollY>0);
  const full=await call('page.screenshot.fullPage',{tabRef,captureMethod:'scroll',allowScroll:true});const fullFile=await save(full.artifact,'full-page.png');
  const region=await call('page.screenshot.region',{tabRef,region:{x:0,y:1850,width:120,height:80},captureMethod:'scroll',allowScroll:true});const regionFile=await save(region.artifact,'page-region.png');
  assert.deepEqual(await call('page.viewport.get',{tabRef}),before);
  const pixels=async(file,positions)=>pageEvaluate(workerClient,async({data,positions})=>{
   const image=await createImageBitmap(new Blob([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],{type:'image/png'}));
   try {const canvas=new OffscreenCanvas(image.width,image.height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
    return {width:image.width,height:image.height,colors:positions.map(([x,y])=>[...ctx.getImageData(Math.min(x,image.width-1),Math.min(y,image.height-1),1,1).data])};
   }finally{image.close();}
  },{data:(await readFile(file)).toString('base64'),positions});
  const fullPixels=await pixels(fullFile,[[10,1750],[10,1950]]),regionPixels=await pixels(regionFile,[[50,40]]);
  observations.push({evidence:'full-page and region pixel observations',fullPixels,regionPixels});
  assert.ok(fullPixels.height>=2000);assert.deepEqual(fullPixels.colors[0],[20,80,160,255]);assert.deepEqual(fullPixels.colors[1],[30,180,60,255]);
  assert.deepEqual(regionPixels.colors[0],[30,180,60,255]);
  assert.equal(full.scrollRestored,true);assert.ok(full.tiles>1);assert.equal(region.scrollRestored,true);
  // Explicitly change only this isolated fixture's browser zoom to exercise
  // fractional device pixels and a nonzero original scroll in the real engine.
  await call('page.zoom.set',{tabRef,factor:1.25});
  const fractionalBefore=await until(async()=>{const value=await call('page.viewport.get',{tabRef});return value.devicePixelRatio===1.25?value:null;},'Fixture zoom did not settle at fractional DPR');
  const fractional=await call('page.screenshot.fullPage',{tabRef,captureMethod:'scroll',allowScroll:true});
  const fractionalFile=await save(fractional.artifact,'full-page-dpr-1.25.png');
  const fractionalRegion=await call('page.screenshot.region',{tabRef,region:{x:0,y:1850,width:120,height:80},captureMethod:'scroll',allowScroll:true});
  const fractionalRegionFile=await save(fractionalRegion.artifact,'page-region-dpr-1.25.png');
  assert.deepEqual(await call('page.viewport.get',{tabRef}),fractionalBefore);
  const fractionalPixels=await pixels(fractionalFile,[[10,Math.floor(1750*1.25)],[10,Math.floor(1950*1.25)],[fractional.width-1,Math.floor(1950*1.25)]]);
  const fractionalRegionPixels=await pixels(fractionalRegionFile,[[50,40]]);
  observations.push({evidence:'fractional DPR full-page final column and bottom-region pixels with restored nonzero scroll',fractionalBefore,fractionalPixels,fractionalRegionPixels});
  assert.equal(fractionalPixels.height,2500);assert.deepEqual(fractionalPixels.colors,[[20,80,160,255],[30,180,60,255],[30,180,60,255]]);
  assert.deepEqual([fractionalRegionPixels.width,fractionalRegionPixels.height],[150,100]);assert.deepEqual(fractionalRegionPixels.colors[0],[30,180,60,255]);
  await pageEvaluate(page,()=>{document.querySelector('main').style.height='100px';});
  const shortViewport=await pageEvaluate(page,()=>({width:visualViewport.width,height:visualViewport.height,dpr:devicePixelRatio}));
  const shortBefore=await call('page.viewport.get',{tabRef});
  const shortPage=await call('page.screenshot.fullPage',{tabRef,captureMethod:'scroll',allowScroll:true});
  const shortFile=await save(shortPage.artifact,'short-page-dpr-1.25.png');
  const shortPixels=await pixels(shortFile,[[10,50],[10,150],[shortPage.width-1,shortPage.height-1]]);
  observations.push({evidence:'fractional DPR non-scrolling viewport uses the actual final pixel',shortViewport,shortPixels,sourceRect:shortPage.sourceRect});
  assert.deepEqual([shortPage.width,shortPage.height],[Math.round(shortViewport.width*shortViewport.dpr),Math.round(shortViewport.height*shortViewport.dpr)]);
  assert.equal(shortPage.tiles,1);assert.deepEqual(shortPixels.colors,[[20,80,160,255],[30,180,60,255],[20,80,160,255]]);
  assert.deepEqual(await call('page.viewport.get',{tabRef}),shortBefore);
  await call('page.zoom.set',{tabRef,factor:before.zoom});
  await until(async()=>(await call('page.viewport.get',{tabRef})).devicePixelRatio===before.devicePixelRatio,'Fixture zoom restoration unavailable');
  // Independent direct-CDP coverage on a fixture whose original layout has no scrollbar.
  // The full scrolling fixture and its exact footer pixels above remain mandatory.
  await pageEvaluate(page,()=>{document.querySelector('main').style.height='100px';});
  const directBefore=await call('page.viewport.get',{tabRef});
  const direct=await call('page.screenshot.fullPage',{tabRef});const directFile=await save(direct.artifact,'direct-cdp.png');
  assert.deepEqual(await call('page.viewport.get',{tabRef}),directBefore);assert.equal(direct.route,'cdp');
  const directPixels=await pixels(directFile,[[10,50],[10,150]]);assert.deepEqual(directPixels.colors,[[20,80,160,255],[30,180,60,255]]);
  observations.push({evidence:'direct CDP capture preserves the original scrollbar-free geometry',directPixels});
  observations.push({evidence:'binary DOM upload, native downloads, full page and region pixels',upload:actual,fullPixels,regionPixels});
  await call('debugger.detach',{tabRef});
  return {status:'passed',observations:observations.length,sampleRoot};
 }finally{
  if(tabRef)await call('debugger.detach',{tabRef}).catch(()=>{});
  for(const artifactRef of artifacts)await call('artifact.release',{artifactRef}).catch(()=>{});
  if(targetId)await browserClient.send('Target.closeTarget',{targetId}).catch(()=>{});
  page?.close();await writeFile(path.join(sampleRoot,'evidence.json'),JSON.stringify(observations,null,2));
 }
}
