import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import 'fake-indexeddb/auto';
const event=()=>({listeners:[],addListener(listener){this.listeners.push(listener);}});
const state={},documents=new Map(),controls=[];
const tab={id:31,index:0,windowId:7,active:true,highlighted:true,pinned:false,incognito:false,status:'complete',url:'https://record.test/form',title:'Record fixture'};
const documentId='record-document-1';let currentDocumentId=documentId,frameOverrides=null;
let beforeInjection=async()=>{},afterRecorderStart=async()=>{};
globalThis.chrome={
  runtime:{id:'record-extension',getManifest:()=>({name:'fixture',version:'test'})},
  storage:{session:{async setAccessLevel(){},async get(key){return {[key]:structuredClone(state[key])};},async set(items){Object.assign(state,structuredClone(items));}}},
  tabs:{async query(){return [tab];},async get(id){assert.equal(id,tab.id);return {...tab};},async getZoom(){return 1;},onRemoved:event(),onReplaced:event(),onActivated:event(),onZoomChange:event(),onCreated:event(),onAttached:event(),onDetached:event()},
  windows:{async get(id){return {id,state:'normal',focused:true,left:0,top:0,width:1200,height:800};}},
  webNavigation:{async getAllFrames(){return frameOverrides??[{frameId:0,parentFrameId:-1,url:tab.url,documentId:currentDocumentId,errorOccurred:false}];},onCommitted:event(),onHistoryStateUpdated:event(),onReferenceFragmentUpdated:event()},
  permissions:{async contains(){return true;}},
  scripting:{async executeScript(injection){
    await beforeInjection(injection);
    const injectedDocumentId=injection.target.documentIds?.[0]??currentDocumentId;
    if(injection.files)return [{frameId:0,documentId:injectedDocumentId}];
    if(injection.args===undefined)return [{frameId:0,documentId:currentDocumentId,result:{width:1184,height:700,devicePixelRatio:1,visibility:'visible',scrollX:0,scrollY:0}}];
    const [first,operation]=injection.args;
    if(typeof first==='object'&&first!==null&&first.recordingId){documents.set(first.recordingId,{recordingId:first.recordingId,collecting:true,capturedThrough:0,sentThrough:0,lost:0,terminal:null,unfinished:[],pending:[]});await afterRecorderStart(first.recordingId);return [{frameId:0,documentId:injectedDocumentId,result:{...documents.get(first.recordingId)}}];}
    if(typeof first==='string'&&first.startsWith('rr1.')){controls.push(operation);const current=documents.get(first);current.collecting=operation==='resume';return [{frameId:0,documentId:injectedDocumentId,result:{...current}}];}
    throw new Error(`Unexpected injection ${injection.func.name}`);
  }},
};
const {createKey,updateKey}=await import('../../out/extension/background/key-service.js');
const service=await import('../../out/extension/background/recording/service.js');
const {resolveCurrentTabTarget}=await import('../../out/extension/background/tab-service.js');
const {parseCommand,dispatchRouteRequest}=await import('../../out/extension/background/command-dispatcher.js');
const {compileSource}=await import('../../out/extension/background/actions/service.js');
const {loadRecording,readRecordingEvents}=await import('../../out/extension/background/recording/store.js');
const {COMMAND_CATALOG}=await import('../../out/extension/generated/command-config.js');
service.initializeRecordingService();
const mutationId=()=>`am1.${Date.now()}.${randomBytes(16).toString('base64url')}`;
const permissions=['actions.compile','actions.write','recording.dom','recording.manage','recording.read'];
const key=(grants=permissions)=>createKey({mutationId:mutationId(),displayName:'record fixture',keyKind:'regular',permissions:[...grants].sort(),enabled:true,expiresAt:null});
async function start(caller,scope='tab'){const target=await resolveCurrentTabTarget(tab.id);return (await service.startRecording(caller.key,{tabRef:target.tabRef,scope,mode:'dom',includeFrames:true,durationMs:60000,retentionMs:86400000})).recording;}
const locator={selector:'#field',shadowPath:[],role:null,name:null,nameMatch:'exact',match:'unique'};
const sender={id:'record-extension',tab,frameId:0,documentId};
async function send(id,events,override=sender,lost=0){const client=documents.get(id);if(events.length)client.capturedThrough=Math.max(client.capturedThrough,events.at(-1).documentSequence);const response=await service.acceptRecordingEvents({kind:'recording.events',recordingId:id,events,lost},override);if(response.ok)client.sentThrough=response.acceptedThrough;return response;}
const raw=(documentSequence,kind,extra={})=>({documentSequence,gesture:1,at:Date.now(),kind,...extra});
const source=(id)=>({recordingId:id,options:{timing:'none',mergeInputs:'none',includeHover:true}});

test('native batches commit their cursor with events, deduplicate, and roll back on storage failure',async()=>{
 const store=await import('../../out/extension/background/recording/store.js');
 const native=await import('../../out/extension/background/recording/native.js');
 const {RECORDING_EVENT_STORE}=await import('../../out/extension/background/database.js');
 const caller=await key(),dom=await start(caller);await service.stopRecording(caller.key.keyId,dom.recordingId,'stop');
 const baseline=await loadRecording(caller.key.keyId,dom.recordingId),id=`rr1.${crypto.randomUUID()}`;
 await store.createRecording({...baseline,recordingId:id,mode:'real',state:'recording',documents:[],eventCount:0,byteLength:0,lostEvents:0});
 const prepared=await native.prepareNativeSource(id,{connectionGeneration:1,relayEpoch:'a'.repeat(22)}),resourceId=prepared.native.resourceId;
 const rect={left:0,top:0,right:1000,bottom:800},zero='0000000000000000';
 const event=sequence=>({sequence,kind:3,phase:3,message:0x102,threadId:1,messageTime:0,dpi:96,hwnd:'0000000000000001',keyboardLayout:zero,
  qpc:String(1000+sequence),window:rect,clientScreen:rect,visible:true,iconic:false,point:null,wParam:'0000000000000041',keyLParam:zero,
  position:{x:0,y:0,width:0,height:0,flags:0},suggestedRect:rect});
 const result=events=>({resourceId,outcome:'ok',events,calibration:null,status:{reason:0,reserved:events.at(-1)?.sequence??0,acknowledged:0,
  delivered:events.at(-1)?.sequence??0,lost:0,attached:1,detached:0,callbacks:0,cleanup:false,snapshotValid:true,enrolledThreadsOnly:true,
  pendingInstallations:0,startedQpc:'1000',qpcFrequency:'1000',startedUnixMs:baseline.startedAt+250}});
 try{
  await native.saveNativeBatch(id,resourceId,result([event(1)]));
  let saved=await store.readRecordingEvents(caller.key.keyId,id,0,100);
  assert.equal(saved.recording.native.acceptedThrough,1);assert.deepEqual(saved.events.map(event=>event.kind),['native_start','native']);
  assert.equal(saved.events[0].activeMs,250);assert.equal(saved.events[1].activeMs,251);
  await native.saveNativeBatch(id,resourceId,result([event(1)]));
  assert.equal((await loadRecording(caller.key.keyId,id)).eventCount,2);
  await assert.rejects(native.saveNativeBatch(id,resourceId,result([event(3)])),error=>error.details.reason==='NATIVE_EVENT_GAP');
  const original=IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add=function(...args){if(this.name===RECORDING_EVENT_STORE)throw new DOMException('Injected storage failure','QuotaExceededError');return Reflect.apply(original,this,args);};
  try{await assert.rejects(native.saveNativeBatch(id,resourceId,result([event(2)])),/Injected storage failure/);}
  finally{IDBObjectStore.prototype.add=original;}
  saved=await store.readRecordingEvents(caller.key.keyId,id,0,100);
  assert.equal(saved.recording.native.acceptedThrough,1);assert.equal(saved.events.length,2);
  await native.saveNativeBatch(id,resourceId,result([event(2)]));
  saved=await store.readRecordingEvents(caller.key.keyId,id,0,100);
  assert.equal(saved.recording.native.acceptedThrough,2);assert.deepEqual(saved.events.map(event=>event.sequence),[1,2,3]);
 }finally{await store.changeRecording(id,current=>({session:{...current,state:'stopped',native:{...current.native,closed:true}}}));await store.deleteRecording(caller.key.keyId,id);}
});

test('explicit deletion removes an interrupted native draft after its App connection retired',async()=>{
 const store=await import('../../out/extension/background/recording/store.js');
 const native=await import('../../out/extension/background/recording/native.js');
 const caller=await key(),dom=await start(caller);await service.stopRecording(caller.key.keyId,dom.recordingId,'stop');
 const baseline=await loadRecording(caller.key.keyId,dom.recordingId),id=`rr1.${crypto.randomUUID()}`;
 await store.createRecording({...baseline,recordingId:id,mode:'real',state:'recording',documents:[],eventCount:0,byteLength:0});
 await native.prepareNativeSource(id,{connectionGeneration:1,relayEpoch:'a'.repeat(22)});
 await store.changeRecording(id,current=>({session:{...current,state:'interrupted',reason:'WORKER_INTERRUPTED'}}));
 const previousSend=chrome.runtime.sendMessage,previousOffscreen=chrome.offscreen;
 chrome.offscreen={hasDocument:async()=>true};
 chrome.runtime.sendMessage=async message=>{assert.equal(message.payload.kind,'transport.state');return {connectionGeneration:2,relayEpoch:'b'.repeat(22),capabilities:['native.recording.v1']};};
 try{
  assert.deepEqual(await service.deleteRecording(caller.key.keyId,id),{deleted:true});
  await assert.rejects(loadRecording(caller.key.keyId,id),error=>error.details.reason==='NOT_FOUND');
 }finally{chrome.runtime.sendMessage=previousSend;chrome.offscreen=previousOffscreen;}
});

test('window recordings compile five buttons, wheel, changed windows and unchanged native points without CSS geometry',async()=>{
 const {compileRecording}=await import('../../out/extension/background/recording/compiler.js');
 const {compileInstructions}=await import('../../out/extension/background/actions/compiler.js');
 const {isNativeRecordingEvent}=await import('../../out/extension/shared/native-recording-protocol.js');
 const caller=await key(),dom=await start(caller);await service.stopRecording(caller.key.keyId,dom.recordingId,'stop');
 const session={...await loadRecording(caller.key.keyId,dom.recordingId),mode:'real'};
 const resourceId=crypto.randomUUID(),zero='0000000000000000';let sequence=0;
 const raw=(message,point,data=0)=>({kind:'native',recordingId:dom.recordingId,resourceId,sequence:++sequence,activeMs:sequence*10,
  raw:{coordinates:'window',kind:3,phase:4,message,sequence,threadId:1,messageTime:sequence,dpi:144,qpc:String(sequence),
   window:{left:-400,top:100,right:800,bottom:900},clientScreen:{left:-392,top:131,right:792,bottom:892},visible:true,iconic:false,
   hwnd:'0000000000000001',keyboardLayout:zero,point,wParam:BigInt(data).toString(16).padStart(16,'0'),keyLParam:'00000000001e0001',
   position:{x:0,y:0,width:0,height:0,flags:0},suggestedRect:{left:0,top:0,right:0,bottom:0}}});
 const point={x:240,y:190},events=[raw(0x200,point)];
 for(const [down,up,data] of [[0x201,0x202,0],[0x204,0x205,0],[0x207,0x208,0],[0x20b,0x20c,0x10000],[0x20b,0x20c,0x20000]])
  events.push(raw(down,point,data),raw(up,point,data));
 events.push(raw(0x20a,point,0xff880000),raw(0x20e,point,0x00780000));
 const browser={recordingId:dom.recordingId,sequence:++sequence,documentSequence:0,gesture:0,at:session.startedAt+150,activeMs:150,tabId:tab.id,frameId:0,documentId:'browser'};
 events.push({...browser,kind:'window_changed',window:{...session.baseline.window,bounds:{left:90,top:70,width:1000,height:750}}});
 events.push({...browser,kind:'zoom',sequence:++sequence,activeMs:160,factor:2});
 const moved=raw(0x200,point);moved.activeMs=170;events.push(moved);
 assert.ok(isNativeRecordingEvent(events[0].raw));
 assert.equal(isNativeRecordingEvent({...events[0].raw,point:{x:1200,y:100}}),false,'exclusive right edge');
 assert.equal(isNativeRecordingEvent({...events[0].raw,visible:false}),false);
 const compiled=compileRecording(session,events,{timing:'preserve',mergeInputs:'none',includeHover:true});
 assert.equal(compiled.runnable,true,JSON.stringify(compiled.diagnostics));
 assert.equal(compileInstructions(compiled.instructions,parseCommand).runnable,true);
 const mouse=compiled.instructions.filter(item=>item.method==='virtualMouse.input');
 assert.ok(mouse.every(item=>JSON.stringify(item.params.actions[0])===JSON.stringify({kind:'moveWindow',...point})));
 assert.deepEqual(mouse.flatMap(item=>item.params.actions).filter(item=>item.kind==='button').map(item=>[item.button,item.action]),
  ['left','right','middle','back','forward'].flatMap(button=>[[button,'down'],[button,'up']]));
 assert.deepEqual(mouse.flatMap(item=>item.params.actions).filter(item=>item.kind==='wheel'),[{kind:'wheel',deltaX:0,deltaY:-120},{kind:'wheel',deltaX:120,deltaY:0}]);
 assert.ok(compiled.instructions.some(item=>item.method==='windows.setBounds'&&item.params.width===1000));
 assert.ok(!compiled.instructions.some(item=>item.method==='input.calibrate'));
 const legacy=structuredClone(events[0]);delete legacy.raw.coordinates;
 assert.equal(compileRecording(session,[legacy],{timing:'none',mergeInputs:'none',includeHover:true}).runnable,false);
 const held=raw(0x20b,point,0x20000);
 assert.ok(compileRecording(session,[held],{timing:'none',mergeInputs:'none',includeHover:true}).diagnostics.some(item=>item.code==='NATIVE_POINTER_GESTURE_UNFINISHED'));
 await service.deleteRecording(caller.key.keyId,dom.recordingId);
});

test('browser zoom changes are stored and compiled while page-forged zoom events are rejected',async()=>{
 const caller=await key(),recording=await start(caller),id=recording.recordingId;
 assert.equal((await service.acceptRecordingEvents({kind:'recording.events',recordingId:id,events:[raw(1,'zoom',{factor:2})],lost:0},sender)).ok,false);
 for(const listener of chrome.tabs.onZoomChange.listeners)listener({tabId:tab.id,oldZoomFactor:1,newZoomFactor:2});
 let stored;
 for(let attempt=0;attempt<100;attempt++){
  stored=await readRecordingEvents(caller.key.keyId,id,0,100);
  if(stored.events.some(event=>event.kind==='zoom'))break;
  await new Promise(resolve=>setTimeout(resolve,2));
 }
 assert.equal(stored.events.find(event=>event.kind==='zoom')?.factor,2);
 await service.stopRecording(caller.key.keyId,id,'stop');
 const compiled=await compileSource(caller.key.keyId,source(id),parseCommand);
 assert.equal(compiled.runnable,true,JSON.stringify(compiled.diagnostics));
 assert.deepEqual(compiled.instructions.map(item=>[item.method,item.params.factor]),[['page.zoom.set',2]]);
 await service.deleteRecording(caller.key.keyId,id);
});

test('an admitted recording keeps its Key snapshot through baseline and file loading',async()=>{
 const disable=caller=>updateKey({keyId:caller.key.keyId,mutationId:mutationId(),expectedRevision:1,patch:{displayName:'disabled',permissions:[...permissions].sort(),enabled:false,expiresAt:null}});
 for(const stage of ['baseline','files']){
  const caller=await key();let reached,release;
  const blocked=new Promise(resolve=>{reached=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  beforeInjection=async injection=>{if(stage==='files'?Boolean(injection.files):injection.args===undefined&&!injection.files){reached();await gate;}};
  const pending=start(caller);let recording;
  try{await blocked;await disable(caller);release();recording=await pending;assert.equal(recording.state,'recording');assert.equal(documents.get(recording.recordingId).collecting,true);}
  finally{release();beforeInjection=async()=>{};if(recording)await service.stopRecording(caller.key.keyId,recording.recordingId,'stop');}
 }
});

test('Key changes while a recorder start response is pending do not cancel the accepted recording',async()=>{
 const caller=await key();let reached,release,id;
 const blocked=new Promise(resolve=>{reached=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 afterRecorderStart=async recordingId=>{id=recordingId;reached();await gate;};
 const pending=start(caller);
 try{
  await blocked;await updateKey({keyId:caller.key.keyId,mutationId:mutationId(),expectedRevision:1,patch:{displayName:'disabled',permissions:[...permissions].sort(),enabled:false,expiresAt:null}});
  assert.equal(documents.get(id).collecting,true);release();
  assert.equal((await pending).state,'recording');assert.equal((await loadRecording(caller.key.keyId,id)).state,'recording');
 }finally{release();afterRecorderStart=async()=>{};if(id)await service.stopRecording(caller.key.keyId,id,'stop');}
});

test('Key expiry changes leave the accepted recording duration unchanged',async()=>{
 for(const extend of [false,true]){
  const caller=await key(),recording=await start(caller),id=recording.recordingId,deadline=Date.now()+400;
  try{
   await updateKey({keyId:caller.key.keyId,mutationId:mutationId(),expectedRevision:1,patch:{displayName:'expiring',permissions:[...permissions].sort(),enabled:true,expiresAt:deadline}});
   assert.equal((await loadRecording(caller.key.keyId,id)).expiresAt,recording.expiresAt);
   if(extend)await updateKey({keyId:caller.key.keyId,mutationId:mutationId(),expectedRevision:2,patch:{displayName:'extended',permissions:[...permissions].sort(),enabled:true,expiresAt:deadline+30000}});
   await new Promise(resolve=>setTimeout(resolve,Math.max(0,deadline-Date.now())+10));
   const latest=await loadRecording(caller.key.keyId,id);
   assert.equal(latest.expiresAt,recording.expiresAt);assert.equal(latest.state,'recording');
   assert.equal(latest.eventCount,0);assert.equal(documents.get(id).collecting,true);
  }finally{await service.stopRecording(caller.key.keyId,id,'stop');}
 }
});

test('a pause with a stale read cannot overwrite an explicit stop or send a late pause',async()=>{
 const caller=await key(),recording=await start(caller),id=recording.recordingId,originalGet=IDBObjectStore.prototype.get;
 let reached,release,intercepted=false;
 const blocked=new Promise(resolve=>{reached=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 IDBObjectStore.prototype.get=function(value){
  const request=originalGet.call(this,value);
  if(this.name==='recordings'&&this.transaction.mode==='readonly'&&value===id&&!intercepted){
   intercepted=true;const subscribe=request.addEventListener.bind(request);
   request.addEventListener=(type,handler,options)=>subscribe(type,type!=='success'?handler:event=>{reached();void gate.then(()=>handler.call(request,event));},options);
  }
  return request;
 };
 const before=controls.filter(operation=>operation==='pause').length,pending=service.stopRecording(caller.key.keyId,id,'pause');
 try{
  await blocked;await service.stopRecording(caller.key.keyId,id,'stop');
  assert.equal((await loadRecording(caller.key.keyId,id)).state,'stopped');release();
  assert.equal((await pending).recording.state,'stopped');assert.equal((await loadRecording(caller.key.keyId,id)).state,'stopped');
  assert.equal(controls.filter(operation=>operation==='pause').length,before);assert.equal(documents.get(id).collecting,false);
 }finally{release();IDBObjectStore.prototype.get=originalGet;await service.stopRecording(caller.key.keyId,id,'stop');}
});

test('explicit mode permission is required and source-gated batches reject foreign senders and arbitrary commands',async()=>{
  const limited=await key(['recording.manage']),target=await resolveCurrentTabTarget(tab.id);
  const rejected=await dispatchRouteRequest({kind:'route.request',routeId:'998',payload:{clientRequestId:'mode-admission',auth:{apiKey:limited.apiKey},command:{method:'recording.start',schemaVersion:1,params:{tabRef:target.tabRef,mode:'dom'}}}});
  assert.equal(rejected.payload.error.code,'FORBIDDEN');
  const caller=await key(),recording=await start(caller);
  const valid=raw(1,'click',{target:locator});
  for(const forged of [{...sender,id:'foreign'}, {...sender,documentId:'not-attached'},{...sender,tab:{...tab,id:32}}])assert.equal((await send(recording.recordingId,[valid],forged)).ok,false);
  assert.equal((await send(recording.recordingId,[{...valid,method:'js.execute',params:{code:'malicious'}}])).ok,false);
  assert.equal((await send(recording.recordingId,[valid])).ok,true);
  assert.equal((await send(recording.recordingId,[valid])).acceptedThrough,1);
  assert.equal((await loadRecording(caller.key.keyId,recording.recordingId)).eventCount,1);
  await service.stopRecording(caller.key.keyId,recording.recordingId,'stop');
});

test('recorded input and commit stay separate; scrolling and shadow targets compile to editable reusable DOM commands',async()=>{
  const caller=await key(),recording=await start(caller),id=recording.recordingId;
  const target={...locator,shadowPath:['#editor']};
  const events=[raw(1,'focus',{target}),raw(2,'input',{target,value:'你',events:'input',inputType:'insertCompositionText',data:'你',contentEditable:false}),
    raw(3,'input',{target,value:'你好',events:'input',inputType:'insertText',data:'好',contentEditable:false}),raw(4,'input',{target,value:'你好',events:'change',inputType:'',data:null,contentEditable:false}),
    raw(5,'scroll',{target:locator,left:0,top:250})];
  await send(id,events);
  await assert.rejects(compileSource(caller.key.keyId,source(id),parseCommand),e=>e.details.reason==='STOP_BEFORE_COMPILING');
  const stopped=await service.stopRecording(caller.key.keyId,id,'stop');assert.equal(stopped.recording.state,'stopped');
  const compiled=await compileSource(caller.key.keyId,source(id),parseCommand);
  assert.equal(compiled.runnable,true);assert.deepEqual(compiled.instructions.map(step=>step.method),['dom.focus','dom.edit','dom.edit','dom.edit','dom.scrollTo']);
  assert.deepEqual(compiled.instructions.slice(1,4).map(step=>step.params.events),['input','input','change']);
  assert.deepEqual(compiled.instructions[1].bindings[0].source.locator.shadowPath,['#editor']);
  assert.equal(compiled.instructions[1].bindings[0].source.tab.alias,'tab_1');
  assert.equal(compiled.instructions[1].bindings[0].source.tab.selector.urlMatch,'exact');
  assert.equal(JSON.stringify(compiled.instructions).includes('tr1.'),false);
  assert.ok(compiled.recommendations.length>0);
  const other=await key();await assert.rejects(readRecordingEvents(other.key.keyId,id,0,2),e=>e.details.reason==='NOT_FOUND');
  const page=await service.readRecording(caller.key.keyId,id,0,2);assert.equal(page.events.length,2);assert.equal(page.nextAfterSequence,2);
  assert.deepEqual((await service.readRecording(caller.key.keyId,id,2,10)).events.map(e=>e.sequence),[3,4,5]);
});

test('pause preserves a draft, resume continues sequence, explicit merge changes only the preview',async()=>{
  const caller=await key(),recording=await start(caller),id=recording.recordingId;
  await send(id,[raw(1,'input',{target:locator,value:'a',events:'input',inputType:'insertText',data:'a',contentEditable:false})]);
  assert.equal((await service.stopRecording(caller.key.keyId,id,'pause')).recording.state,'paused');
  await service.resumeRecording(caller.key.keyId,id);
  await send(id,[raw(2,'input',{target:locator,value:'ab',events:'input',inputType:'insertText',data:'b',contentEditable:false})]);
  await service.stopRecording(caller.key.keyId,id,'stop');
  const merged=await compileSource(caller.key.keyId,{recordingId:id,options:{timing:'none',mergeInputs:'final',includeHover:true}},parseCommand);
  assert.equal(merged.instructions.length,1);assert.equal(merged.instructions[0].params.value,'ab');
  assert.equal((await readRecordingEvents(caller.key.keyId,id,0,10)).events.length,2);
  assert.ok(controls.includes('pause')&&controls.includes('resume'));
});

test('sequence gaps retain evidence and prevent incomplete recording from being saved as an action',async()=>{
  const caller=await key(),recording=await start(caller),id=recording.recordingId;
  const received=await send(id,[raw(2,'click',{target:locator})]);assert.equal(received.continueRecording,false);
  const compiled=await compileSource(caller.key.keyId,source(id),parseCommand);assert.equal(compiled.runnable,false);
  assert.ok(compiled.diagnostics.some(d=>d.code==='RECORDING_HAS_GAPS'));
  const response=await dispatchRouteRequest({kind:'route.request',routeId:'999',payload:{clientRequestId:'save-gap',auth:{apiKey:caller.apiKey},command:{method:'actions.create',schemaVersion:1,params:{name:'gap',description:'',instructions:source(id)}}}});
  assert.equal(response.payload.error.details.reason,'COMPILATION_INCOMPLETE');
});

test('Key disable does not stop an accepted recording or its event ingestion',async()=>{
  const caller=await key(),recording=await start(caller),id=recording.recordingId;
  await updateKey({keyId:caller.key.keyId,mutationId:mutationId(),expectedRevision:1,patch:{displayName:'disabled',permissions:[...permissions].sort(),enabled:false,expiresAt:null}});
  assert.equal((await loadRecording(caller.key.keyId,id)).state,'recording');
  assert.equal((await send(id,[raw(1,'click',{target:locator})])).ok,true);
  assert.equal(documents.get(id).collecting,true);
  await service.stopRecording(caller.key.keyId,id,'stop');
});

test('storage overflow interrupts without advancing its committed event count',async()=>{
  const before=COMMAND_CATALOG.limits['command.recording.maximum_events'];
  const caller=await key(),recording=await start(caller),id=recording.recordingId;
  try {COMMAND_CATALOG.limits['command.recording.maximum_events']=1;
    assert.equal((await send(id,[raw(1,'click',{target:locator}),raw(2,'click',{target:locator})])).ok,false);
    const record=await loadRecording(caller.key.keyId,id);assert.equal(record.state,'interrupted');assert.equal(record.eventCount,0);assert.equal(record.reason,'RECORDING_LIMIT');
  }finally{COMMAND_CATALOG.limits['command.recording.maximum_events']=before;}
});

test('window scope rechecks the live tab window before accepting an already attached document',async()=>{
  const caller=await key(),recording=await start(caller,'window'),id=recording.recordingId,original=tab.windowId;
  try {
    tab.windowId=original+1;
    assert.equal((await send(id,[raw(1,'click',{target:locator})])).ok,false);
    const saved=await loadRecording(caller.key.keyId,id);assert.equal(saved.state,'interrupted');assert.equal(saved.reason,'TAB_LEFT_SCOPE');assert.equal(saved.eventCount,0);
  }finally{tab.windowId=original;}
});

test('unfinished pointer or IME evidence prevents a complete pause or stop even when every batch was acknowledged',async()=>{
  for(const [operation,unfinished] of [['pause','UNFINISHED_POINTER'],['stop','UNFINISHED_COMPOSITION']]){
    const caller=await key(),recording=await start(caller),id=recording.recordingId;
    await send(id,[raw(1,'click',{target:locator})]);documents.get(id).unfinished=[unfinished];
    const stopped=await service.stopRecording(caller.key.keyId,id,operation);
    assert.equal(stopped.recording.state,'interrupted');assert.equal(stopped.recording.reason,'INCOMPLETE_GESTURE');
    assert.equal((await compileSource(caller.key.keyId,source(id),parseCommand)).runnable,false);
  }
});

test('resuming after paused navigation seals confirmed old tails and compiles the new document context',async()=>{
  const caller=await key(),recording=await start(caller),id=recording.recordingId,originalUrl=tab.url;
  try {
    await send(id,[raw(1,'click',{target:locator})]);
    await service.stopRecording(caller.key.keyId,id,'pause');
    currentDocumentId='record-document-resumed';tab.url='https://record.test/next';
    await service.resumeRecording(caller.key.keyId,id);
    const saved=await loadRecording(caller.key.keyId,id);assert.equal(saved.documents.find(d=>d.documentId===documentId).sealed,true);
    assert.equal((await send(id,[raw(1,'click',{target:locator})],{...sender,documentId:currentDocumentId})).ok,true);
    await service.stopRecording(caller.key.keyId,id,'stop');
    const compiled=await compileSource(caller.key.keyId,source(id),parseCommand);
    assert.equal(compiled.runnable,true);assert.deepEqual(compiled.instructions.map(i=>i.method),['dom.click','tabs.navigate','page.wait','page.wait','dom.click']);
    assert.equal(compiled.instructions[1].params.url,tab.url);
  }finally{currentDocumentId=documentId;tab.url=originalUrl;}
});

test('identical sibling iframe URLs remain readable evidence but compile with a blocking target diagnosis',async()=>{
  const caller=await key();
  frameOverrides=[{frameId:0,parentFrameId:-1,url:tab.url,documentId,errorOccurred:false},...[1,2].map(frameId=>({frameId,parentFrameId:0,url:'https://frame.test/a?x=*',documentId:`frame-${frameId}`,errorOccurred:false}))];
  try{
    const recording=await start(caller),id=recording.recordingId;
    await send(id,[raw(1,'click',{target:locator})],{...sender,frameId:2,documentId:'frame-2'});
    await service.stopRecording(caller.key.keyId,id,'stop');
    const compiled=await compileSource(caller.key.keyId,source(id),parseCommand);
    assert.equal(compiled.runnable,false);assert.ok(compiled.diagnostics.some(d=>d.code==='FRAME_URL_AMBIGUOUS'));
    assert.equal(compiled.instructions[0].bindings[0].source.locator.framePath[0].urlMatch,'exact');
  }finally{frameOverrides=null;}
});

test('pointer drag compilation rejects collinear reversal and overshoot while retaining the recorded path',async()=>{
  for(const [name,points,runnable] of [
    ['forward',[[20,0],[60,0],[90,0]],true],['backtrack',[[70,0],[30,0],[90,0]],false],
    ['overshoot',[[120,0],[100,0]],false],['before start',[[-20,0],[50,0]],false],['curved',[[50,20]],false],
  ]){
    const caller=await key(),recording=await start(caller),id=recording.recordingId;
    const path=points.map(([x,y])=>({x:x+10,y:y+10}));
    const drag=raw(1,'drag',{from:locator,to:{...locator,selector:'#target'},mode:'pointer',fromOffset:{x:10,y:10},toOffset:{x:10,y:10},fromClient:{x:10,y:10},toClient:{x:110,y:10},points:path});
    assert.equal((await send(id,[drag])).ok,true,name);await service.stopRecording(caller.key.keyId,id,'stop');
    const compiled=await compileSource(caller.key.keyId,source(id),parseCommand);assert.equal(compiled.runnable,runnable,name);
    assert.equal(compiled.diagnostics.some(d=>d.code==='POINTER_PATH_NEEDS_VIRTUAL_REPLAY_OR_EDIT'),!runnable,name);
    const events=await readRecordingEvents(caller.key.keyId,id,0,100);assert.deepEqual(events.events[0].points,path,name);
  }
});

test('subframe history and fragment changes preserve browser document evidence without navigating the top tab',async()=>{
  const caller=await key(),child={frameId:1,parentFrameId:0,url:'https://frame.test/start',documentId:'history-child',errorOccurred:false};
  frameOverrides=[{frameId:0,parentFrameId:-1,url:tab.url,documentId,errorOccurred:false},child];
  try{
    const recording=await start(caller),id=recording.recordingId,childSender={...sender,frameId:1,documentId:child.documentId};
    assert.equal((await send(id,[raw(1,'click',{target:locator})],childSender)).ok,true);
    assert.equal((await send(id,[raw(2,'frame_navigation',{url:'https://forged.test'})],childSender)).ok,false,'content transport cannot forge a browser navigation');
    for(const [name,url] of [['onHistoryStateUpdated','https://frame.test/changed'],['onReferenceFragmentUpdated','https://frame.test/changed#part']]){
      child.url=url;for(const listener of chrome.webNavigation[name].listeners)listener({tabId:tab.id,frameId:1,documentId:child.documentId,url});
      let saved;for(let attempt=0;attempt<100;attempt++){
        saved=await readRecordingEvents(caller.key.keyId,id,0,100);if(saved.events.some(event=>event.kind==='frame_navigation'&&event.url===url))break;
        await new Promise(resolve=>setTimeout(resolve,2));
      }
      assert.ok(saved.events.some(event=>event.kind==='frame_navigation'&&event.url===url));
    }
    assert.equal((await send(id,[raw(2,'click',{target:locator})],childSender)).ok,true);await service.stopRecording(caller.key.keyId,id,'stop');
    const stored=await readRecordingEvents(caller.key.keyId,id,0,100),navigation=stored.events.filter(event=>event.kind==='frame_navigation');
    assert.deepEqual(navigation.map(event=>[event.frameId,event.documentId,event.transition]),[[1,child.documentId,'history_state'],[1,child.documentId,'fragment']]);
    const compiled=await compileSource(caller.key.keyId,source(id),parseCommand);
    assert.equal(compiled.runnable,true,JSON.stringify(compiled.diagnostics));
    assert.deepEqual(compiled.instructions.map(item=>item.method),['dom.click','page.wait','page.wait','dom.click']);
    assert.deepEqual(compiled.instructions.filter(item=>item.method==='page.wait').map(item=>[item.params.until,item.params.url,item.params.framePath[0].urlPattern]),[
      ['url','https://frame.test/changed','https://frame.test/changed'],['url','https://frame.test/changed#part','https://frame.test/changed#part'],
    ]);
    assert.equal(compiled.instructions.at(-1).bindings[0].source.locator.framePath[0].urlPattern,'https://frame.test/changed#part');
    assert.equal(stored.recording.documents.find(doc=>doc.documentId===child.documentId).framePath[0].urlPattern,'https://frame.test/start');
  }finally{frameOverrides=null;}
});
