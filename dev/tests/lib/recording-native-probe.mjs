import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

// Mouse capture/visibility is exercised on a private desktop by window.c.
// This browser check covers the real public App -> extension -> storage path.
export async function runNativeRecordingProbe({forward,browserClient,baseUrl,sampleRoot}) {
 await mkdir(sampleRoot,{recursive:true});
 const evidence={scope:'external App resource lifecycle, browser window recording, persistence, compile/save/run; no physical mouse stimulus',checks:[]};
 const call=async(method,params={})=>{const response=(await forward(method,params)).payload;assert.equal(response.ok,true,JSON.stringify(response));return response.result;};
 let targetId,recordingId,action,windowId,tabRef;
 try {
  const url=new URL('recording?external-window=1',baseUrl).href;
  targetId=(await browserClient.send('Target.createTarget',{url,newWindow:true})).targetId;
  let tab;const deadline=Date.now()+6000;
  while(Date.now()<deadline){tab=(await call('tabs.list')).items.find(item=>item.url===url);if(tab)break;await new Promise(resolve=>setTimeout(resolve,30));}
  assert.ok(tab);tabRef=tab.tabRef;windowId=tab.windowId;await call('page.wait',{tabRef});
  await call('control.acquire',{scope:'window',windowId});
  const started=await call('recording.start',{tabRef,mode:'real',scope:'window'});recordingId=started.recording.recordingId;
  const initial=(await call('windows.get',{windowId})).bounds;
  await call('windows.setBounds',{windowId,left:initial.left+30,top:initial.top+25,width:initial.width-40,height:initial.height-30});
  const paused=await call('recording.pause',{recordingId});assert.equal(paused.recording.state,'paused');
  await call('windows.setBounds',{windowId,...initial});
  assert.equal((await call('recording.resume',{recordingId})).recording.state,'recording');
  await call('windows.setBounds',{windowId,left:initial.left+60,top:initial.top+45,width:initial.width-50,height:initial.height-35});
  const stopped=await call('recording.stop',{recordingId});assert.equal(stopped.recording.state,'stopped');
  const events=[];let afterSequence=0;
  for(let page=0;page<100;page++){const batch=await call('recording.read',{recordingId,afterSequence,limit:100});events.push(...batch.events);if(batch.nextAfterSequence===null)break;afterSequence=batch.nextAfterSequence;}
  assert.equal(events.filter(event=>event.kind==='native_start').length,2);
  const raw=events.filter(event=>event.kind==='native').map(event=>event.raw);
  assert.ok(raw.some(event=>event.kind===2),'App records window changes while pointer need not be in the window');
  assert.ok(raw.every(event=>event.coordinates==='window'));
  assert.ok(events.some(event=>event.kind==='window_changed'));
  const source={recordingId,options:{timing:'none',mergeInputs:'none',includeHover:true}};
  const preview=await call('actions.compile',{instructions:source});assert.equal(preview.runnable,true,JSON.stringify(preview));
  const saved=await call('actions.create',{name:'External window recording',description:'Recorded window changes from the external App',instructions:source});action=saved.action;
  const run=await call('actions.run',{actionId:action.actionId});assert.equal(run.status,'succeeded');
  evidence.checks.push('start/pause/resume/stop','two App segments persisted','window changes outside pointer capture','native cleanup acknowledged','compile/save/run');
  evidence.events=events;evidence.run=run;evidence.stopped=stopped.recording;
  return {sampleRoot,checks:evidence.checks};
 } finally {
  if(action)await call('actions.delete',{actionId:action.actionId,revision:action.revision}).catch(()=>{});
  if(recordingId){await call('recording.stop',{recordingId}).catch(()=>{});await call('recording.delete',{recordingId}).catch(()=>{});}
  await call('virtualMouse.reset').catch(()=>{});if(windowId)await call('control.release',{scope:'window',windowId}).catch(()=>{});
  if(targetId)await browserClient.send('Target.closeTarget',{targetId}).catch(()=>{});
  await writeFile(path.join(sampleRoot,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
 }
}
