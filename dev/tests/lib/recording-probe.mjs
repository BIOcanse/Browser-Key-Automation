import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pageEvaluate} from './cdp-client.mjs';

// This fixture owns its browser target and window. CDP generates trusted page
// input without touching the user's browser, foreground or physical cursor.
export async function runRecordingProbe({forward,browserClient,connectPage,baseUrl,sampleRoot,workerClient}) {
  await mkdir(sampleRoot,{recursive:true});
  const log=[],openRecordings=new Set(),fixtureUrl=new URL('recording',baseUrl).href;
  let targetId,page,tabRef;
  const call=async(method,params={})=>{
    const response=await forward(method,params);log.push({method,params,response:response.payload});
    assert.equal(response.payload.ok,true,JSON.stringify(response.payload));return response.payload.result;
  };
  const until=async(probe,message)=>{
    const end=Date.now()+6000;
    while(Date.now()<end){const value=await probe();if(value)return value;await new Promise(resolve=>setTimeout(resolve,40));}
    throw new Error(message);
  };
  const inspect=()=>pageEvaluate(page,()=>window.snapshot());
  const point=(selector,shadow=false)=>pageEvaluate(page,({selector,shadow})=>{
    const root=shadow?document.querySelector('#shadow').shadowRoot:document;
    const box=root.querySelector(selector).getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2};
  },{selector,shadow});
  const click=async(selector,shadow=false)=>{
    const position=await point(selector,shadow);
    await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',...position});
    await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...position,button:'left',buttons:1,clickCount:1});
    await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...position,button:'left',buttons:0,clickCount:1});
  };
  const start=async(scope='tab',includeFrames=false)=>{
    const {recording}=await call('recording.start',{tabRef,mode:'dom',scope,includeFrames,durationMs:60000});
    openRecordings.add(recording.recordingId);return recording.recordingId;
  };
  const stop=async(recordingId)=>{const result=await call('recording.stop',{recordingId});openRecordings.delete(recordingId);return result.recording;};
  const raw=async(recordingId)=>{
    const events=[];let afterSequence=0;
    for(let index=0;index<500;index++){
      const page=await call('recording.read',{recordingId,afterSequence,limit:100});events.push(...page.events);
      if(page.nextAfterSequence===null)return events;afterSequence=page.nextAfterSequence;
    }
    throw new Error('Recording page bound exceeded');
  };
  const source=recordingId=>({recordingId,options:{timing:'none',mergeInputs:'none',includeHover:false}});
  const navigate=async(url)=>{
    await page.send('Page.navigate',{url,transitionType:'typed'});
    await until(()=>pageEvaluate(page,()=>document.readyState==='complete'&&typeof window.snapshot==='function').catch(()=>false),'Fixture navigation did not finish');
    await call('page.wait',{tabRef,until:'url',url});await call('page.wait',{tabRef,until:'complete'});
  };
  try {
    targetId=(await browserClient.send('Target.createTarget',{url:fixtureUrl,newWindow:true})).targetId;
    page=await connectPage(targetId);await page.send('Runtime.enable');
    const tab=await until(async()=> (await call('tabs.list',{limit:100})).items.find(item=>item.url===fixtureUrl),'Fixture tab unavailable');tabRef=tab.tabRef;
    await call('page.wait',{tabRef,until:'complete'});await pageEvaluate(page,()=>window.reset());
    const id=await start();
    await click('#field');await page.send('Input.insertText',{text:'你好'});
    await click('#check');await click('#click');
    await click('#select option[value="b"]');
    await click('#editor');await page.send('Input.insertText',{text:'纯文本'});
    await click('#shadow-field',true);await page.send('Input.insertText',{text:'shadow'});
    const scrollPoint=await point('#scroll',true);
    await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',...scrollPoint});
    await page.send('Input.dispatchMouseEvent',{type:'mouseWheel',...scrollPoint,deltaX:0,deltaY:135});
    await until(async()=> (await inspect()).shadowScroll>0,'Trusted wheel did not scroll the shadow root');
    const before=await inspect();assert.equal(before.count,1);assert.equal(before.checked,true);assert.equal(before.value,'你好');assert.equal(before.editor,'纯文本');assert.equal(before.shadowValue,'shadow');
    assert.ok(before.evidence.some(event=>event.type==='input'&&event.trusted));
    const stopped=await stop(id);assert.equal(stopped.state,'stopped',JSON.stringify(stopped));assert.equal(stopped.lostEvents,0);
    const events=await raw(id);assert.equal(events.filter(e=>e.kind==='click'&&e.target?.selector==='[id="check"]').length,1);
    assert.ok(events.some(e=>e.kind==='hover'&&e.phase==='leave'));assert.ok(events.some(e=>e.kind==='scroll'&&e.target.shadowPath.length===1));
    const preview=await call('actions.compile',{instructions:source(id)});assert.equal(preview.runnable,true,JSON.stringify(preview));
    const saved=await call('actions.create',{name:'recording acceptance',description:'Trusted input through DOM recording and replay',instructions:source(id)});
    await pageEvaluate(page,()=>window.reset());
    const run=await call('actions.run',{actionId:saved.action.actionId});assert.equal(run.status,'succeeded',JSON.stringify(run));
    const after=await inspect();for(const field of ['count','checked','value','selected','editor','shadowValue','shadowScroll'])assert.deepEqual(after[field],before[field],field);
    assert.equal((await call('recording.get',{recordingId:id})).recording.eventCount,stopped.eventCount);
    log.push({evidence:'trusted input -> raw -> compile -> save -> run',before,after,run});

    const drawing=await start();
    const drawingOrigin=await pageEvaluate(page,()=>{const bounds=document.querySelector('#pad').getBoundingClientRect();return {x:bounds.x,y:bounds.y};});
    await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:drawingOrigin.x+20,y:drawingOrigin.y+45});
    await page.send('Input.dispatchMouseEvent',{type:'mousePressed',x:drawingOrigin.x+20,y:drawingOrigin.y+45,button:'left',buttons:1,clickCount:1});
    for(const x of [100,180,260])await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:drawingOrigin.x+x,y:drawingOrigin.y+45,button:'left',buttons:1});
    await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:drawingOrigin.x+260,y:drawingOrigin.y+45,button:'left',buttons:0,clickCount:1});
    assert.equal((await stop(drawing)).state,'stopped');
    assert.ok((await raw(drawing)).some(event=>event.kind==='drag'&&event.mode==='pointer'));
    const drawingAction=await call('actions.create',{name:'recorded drawing',description:'Recorded pointer gesture',instructions:source(drawing)});
    await pageEvaluate(page,()=>{window.pointerPath=[];window.pointerDrawing=false;});
    const drawingRun=await call('actions.run',{actionId:drawingAction.action.actionId});assert.equal(drawingRun.status,'succeeded',JSON.stringify(drawingRun));
    const drawingResult=await pageEvaluate(page,()=>({points:window.pointerPath,drawing:window.pointerDrawing}));
    assert.deepEqual(drawingResult.points,[[100,45],[180,45],[260,45]]);assert.equal(drawingResult.drawing,false);
    log.push({evidence:'trusted pointer drawing records, saves and replays the path with released buttons',drawingResult});

    const drag=await start(),dragFrom=await point('#drag-source'),dragTo=await point('#drop');
    let dragData;
    const dragListener=event=>{const message=JSON.parse(String(event.data));if(message.method==='Input.dragIntercepted')dragData=message.params.data;};
    page.webSocket.addEventListener('message',dragListener);
    await page.send('Input.setInterceptDrags',{enabled:true});
    try{
      await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',...dragFrom});
      await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...dragFrom,button:'left',buttons:1,clickCount:1});
      for(const ratio of [.1,.5])await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:dragFrom.x+(dragTo.x-dragFrom.x)*ratio,y:dragFrom.y+(dragTo.y-dragFrom.y)*ratio,button:'left',buttons:1});
      await until(()=>dragData,'Browser did not start a trusted HTML5 drag');
      assert.ok(dragData.items.some(item=>item.mimeType==='text/plain'&&item.data==='recorded-card'));
      for(const type of ['dragEnter','dragOver','drop'])await page.send('Input.dispatchDragEvent',{type,...dragTo,data:dragData});
    }finally{
      page.webSocket.removeEventListener('message',dragListener);
      await page.send('Input.setInterceptDrags',{enabled:false});
      await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...dragTo,button:'left',buttons:0,clickCount:1});
    }
    await until(()=>pageEvaluate(page,()=>window.dropData==='recorded-card'),'Trusted HTML5 drop failed');
    assert.equal((await stop(drag)).state,'stopped');assert.ok((await raw(drag)).some(event=>event.kind==='drag'&&event.mode==='html5'));
    const dragAction=await call('actions.create',{name:'recorded HTML5 drag',description:'Recorded DataTransfer gesture',instructions:source(drag)});
    await pageEvaluate(page,()=>window.dropData=null);
    const dragRun=await call('actions.run',{actionId:dragAction.action.actionId});assert.equal(dragRun.status,'succeeded',JSON.stringify(dragRun));
    assert.equal(await pageEvaluate(page,()=>window.dropData),'recorded-card');
    log.push({evidence:'trusted HTML5 drag records, saves and replays DataTransfer to the accepting target'});

    const synthetic=await start();await pageEvaluate(page,()=>document.querySelector('#click').click());await stop(synthetic);
    assert.equal((await raw(synthetic)).filter(e=>e.kind==='click').length,0);
    const paused=await start();await click('#click');await call('recording.pause',{recordingId:paused});await click('#click');
    await call('recording.resume',{recordingId:paused});await click('#click');assert.equal((await stop(paused)).state,'stopped');
    assert.equal((await raw(paused)).filter(e=>e.kind==='click').length,2);

    const unfinished=await start(),pad=await point('#pad');
    await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...pad,button:'left',buttons:1,clickCount:1});
    try {const result=await stop(unfinished);assert.equal(result.state,'interrupted');assert.equal(result.reason,'INCOMPLETE_GESTURE');}
    finally {await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...pad,button:'left',buttons:0,clickCount:1});}
    assert.equal((await call('actions.compile',{instructions:source(unfinished)})).runnable,false);

    const ime=await start();await click('#field');
    await page.send('Input.imeSetComposition',{text:'ni',selectionStart:2,selectionEnd:2});
    try {const result=await stop(ime);assert.equal(result.state,'interrupted');assert.equal(result.reason,'INCOMPLETE_GESTURE');}
    finally {await page.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});}
    assert.ok((await raw(ime)).some(e=>e.kind==='unsupported'&&e.reason==='UNFINISHED_COMPOSITION'));

    await navigate(fixtureUrl);
    const resumed=await start();await click('#click');await call('recording.pause',{recordingId:resumed});
    await navigate(`${fixtureUrl}?stage=paused`);await call('recording.resume',{recordingId:resumed});await click('#click');
    assert.equal((await stop(resumed)).state,'stopped');
    const resumedPreview=await call('actions.compile',{instructions:source(resumed)});assert.equal(resumedPreview.runnable,true,JSON.stringify(resumedPreview));
    assert.ok(resumedPreview.instructions.some(step=>step.method==='tabs.navigate'&&step.params.url.endsWith('stage=paused')));

    await navigate(fixtureUrl);
    const navigation=await start();await click('#click');await navigate(`${fixtureUrl}?stage=external`);
    await until(async()=> (await raw(navigation)).some(event=>event.kind==='boundary'&&event.reason==='DOCUMENT_ATTACHED'&&event.url===`${fixtureUrl}?stage=external`),'Navigation recorder start evidence missing');await click('#click');
    const navStopped=await stop(navigation);assert.equal(navStopped.state,'stopped',JSON.stringify(navStopped));
    const navPreview=await call('actions.compile',{instructions:source(navigation)});assert.equal(navPreview.runnable,true,JSON.stringify(navPreview));
    const navAction=await call('actions.create',{name:'recording navigation',description:'Address navigation remains an explicit step',instructions:source(navigation)});
    await navigate(fixtureUrl);const navRun=await call('actions.run',{actionId:navAction.action.actionId});assert.equal(navRun.status,'succeeded',JSON.stringify(navRun));
    assert.equal(await pageEvaluate(page,()=>location.search),'?stage=external');assert.equal((await inspect()).count,1);

    await navigate(`${fixtureUrl}?frames=1`);
    await until(()=>pageEvaluate(page,()=>[...document.querySelectorAll('iframe')].every(frame=>frame.contentDocument?.querySelector('#frame-input'))),'Child fixtures did not load');
    const prepareFrames=async()=>{
      await pageEvaluate(page,()=>{const frames=document.querySelectorAll('iframe');Object.assign(frames[0].style,{position:'fixed',left:'380px',top:'10px',height:'90px',background:'white'});frames[1].style.display='none';frames[1].src='/recording-frame?sibling=2';});
      await until(()=>pageEvaluate(page,()=>document.querySelectorAll('iframe')[1].contentDocument?.URL.endsWith('?sibling=2')&&document.querySelectorAll('iframe')[1].contentDocument?.readyState==='complete'),'Distinct sibling frame did not load');
    };
    await prepareFrames();
    const frameRecording=await start('tab',true);
    const childClick=async selector=>{
      const position=await pageEvaluate(page,selector=>{const frame=document.querySelector('iframe'),outer=frame.getBoundingClientRect(),inner=frame.contentDocument.querySelector(selector).getBoundingClientRect();return {x:outer.x+frame.clientLeft+inner.x+inner.width/2,y:outer.y+frame.clientTop+inner.y+inner.height/2};},selector);
      await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',...position});
      await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...position,button:'left',buttons:1,clickCount:1});
      await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...position,button:'left',buttons:0,clickCount:1});
    };
    await childClick('#frame-history');await until(async()=> (await raw(frameRecording)).some(event=>event.kind==='frame_navigation'&&event.transition==='history_state'),'Child history evidence missing');
    await childClick('#frame-hash');await until(async()=> (await raw(frameRecording)).some(event=>event.kind==='frame_navigation'&&event.transition==='fragment'),'Child fragment evidence missing');
    await childClick('#frame-input');await page.send('Input.insertText',{text:'iframe 中文'});
    await childClick('#frame-next');await until(async()=> (await raw(frameRecording)).some(event=>event.kind==='boundary'&&event.reason==='DOCUMENT_ATTACHED'&&event.frameId!==0&&event.url===new URL('recording-frame?stage=next',baseUrl).href),'Child replacement recorder start evidence missing');
    await until(()=>pageEvaluate(page,()=>document.querySelector('iframe').contentDocument?.querySelector('#frame-input')),'Replacement child fixture did not load');
    await childClick('#frame-input');await page.send('Input.insertText',{text:'replacement'});
    const frameStopped=await stop(frameRecording);
    if(frameStopped.state!=='stopped')log.push({evidence:'child-stop-diagnostics',collectors:await pageEvaluate(workerClient,async id=>{
      const store=await import(chrome.runtime.getURL('background/recording/store.js')),dom=await import(chrome.runtime.getURL('background/recording/dom.js'));
      const session=(await store.inventoryRecordings()).find(item=>item.recordingId===id);
      return {session,receipts:await Promise.allSettled(session.documents.map(doc=>dom.controlDomRecorder(id,doc,'read')))};
    },frameRecording)});
    assert.equal(frameStopped.state,'stopped',JSON.stringify(frameStopped));
    const frameRaw=await raw(frameRecording),framePreview=await call('actions.compile',{instructions:source(frameRecording)});
    assert.ok(frameRaw.some(event=>event.kind==='input'&&event.value==='iframe 中文'&&event.frameId!==0));
    assert.ok(frameRaw.some(event=>event.kind==='input'&&event.value==='replacement'&&event.frameId!==0));
    const frameNavigations=frameRaw.filter(event=>event.kind==='frame_navigation');assert.ok(frameNavigations.length>=3);assert.ok(frameNavigations.every(event=>event.frameId!==0&&event.documentId!=='browser'));
    assert.equal(framePreview.runnable,true,JSON.stringify(framePreview.diagnostics));
    assert.equal(framePreview.instructions.some(step=>step.method==='tabs.navigate'),false);
    assert.ok(framePreview.instructions.filter(step=>step.method==='page.wait').every(step=>step.params.framePath?.length>0));
    const frameAction=await call('actions.create',{name:'recording child navigation',description:'History, fragment and replaced child document',instructions:source(frameRecording)});
    await navigate(`${fixtureUrl}?frames=1`);await prepareFrames();
    const frameRun=await call('actions.run',{actionId:frameAction.action.actionId});
    assert.equal(frameRun.status,'succeeded',JSON.stringify(frameRun));
    const frameResult=await pageEvaluate(page,()=>({topUrl:location.href,childUrl:document.querySelector('iframe').contentDocument.URL,value:document.querySelector('iframe').contentDocument.querySelector('#frame-input').value}));
    assert.equal(frameResult.topUrl,`${fixtureUrl}?frames=1`);assert.equal(frameResult.childUrl,new URL('recording-frame?stage=next',baseUrl).href);assert.equal(frameResult.value,'replacement');
    log.push({evidence:'trusted child history/hash and document replacement compile, save and replay against fresh child identities',frameNavigations,frameStopped,frameResult});
    await navigate(`${fixtureUrl}?stage=external`);
    const scope=await start('window');
    await pageEvaluate(workerClient,async({url})=>{
      const tab=(await chrome.tabs.query({})).find(item=>item.url===url);
      const others=(await chrome.tabs.query({})).filter(item=>item.windowId!==tab.windowId);
      if(others.length===0)throw new Error('Expected another isolated fixture window');
      await chrome.tabs.move(tab.id,{windowId:others[0].windowId,index:-1});
    },{url:`${fixtureUrl}?stage=external`});
    await until(async()=> (await call('recording.get',{recordingId:scope})).recording.state==='interrupted','Moved tab did not interrupt window capture');
    const scoped=await stop(scope);assert.equal(scoped.reason,'TAB_LEFT_SCOPE');
    return {status:'passed',recordedEvents:stopped.eventCount,checks:['DOM replay','shadow input and scroll','hover leave','checkbox once','recorded pointer drawing replay','recorded HTML5 drag replay','synthetic exclusion','pause','unfinished pointer','unfinished IME','pause navigation','external navigation replay','subframe history/hash and replacement replay','window scope']};
  } finally {
    for(const recordingId of openRecordings)await call('recording.stop',{recordingId}).catch(()=>undefined);
    page?.close();if(targetId)await browserClient.send('Target.closeTarget',{targetId}).catch(()=>undefined);
    await writeFile(path.join(sampleRoot,'evidence.json'),JSON.stringify(log,null,2)+'\n');
  }
}
