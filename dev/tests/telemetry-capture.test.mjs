import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import 'fake-indexeddb/auto';
const event=()=>{const listeners=new Set();return {addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn),fire:(...args)=>{for(const fn of listeners)fn(...args);}};};

test('console and performance preserve protocol evidence, ownership and asynchronous cleanup receipts',async t=>{
 const original=globalThis.chrome,setTimer=globalThis.setTimeout,storage={},calls=[],onEvent=event(),onDetach=event();
 let sendHook=async()=>({}),authorized=true,shortCleanup=false;
 globalThis.setTimeout=(callback,ms,...args)=>{const handle=setTimer(callback,shortCleanup&&ms===5000?5:ms,...args);if(ms>10000)handle.unref();return handle;};
 const tab={id:1,index:0,windowId:1,active:true,highlighted:false,pinned:false,incognito:false,status:'complete',title:'Fixture',url:'https://example.test'};
 const secondTab={...tab,id:2,index:1,url:'https://second.example.test'};
 globalThis.chrome={runtime:{id:'telemetry-test',getManifest:()=>({version:'test'})},storage:{session:{async setAccessLevel(){},async get(key){return {[key]:storage[key]};},async set(items){Object.assign(storage,items);}}},
  tabs:{onRemoved:event(),onReplaced:event(),async query(){return [tab,secondTab];},async get(id){return id===2?secondTab:tab;}},webNavigation:{onCommitted:event()},
  debugger:{onEvent,onDetach,async attach(){},async detach(target){onDetach.fire(target,'detached');},async sendCommand(target,method,params){calls.push({target,method,params});return sendHook(method,params,target);}}};
 const dispatch=async effect=>{if(!authorized)throw new Error('authority lost');return effect();};
 const caller={keyId:'owner',keyKind:'root',enabled:true,status:'active',expiresAt:null,permissions:[]};
 try{
  const {COMMAND_CATALOG}=await import('../../out/extension/generated/command-config.js');
  const tabs=await import('../../out/extension/background/tab-service.js');tabs.initializeTabService();
  const tabRef=(await tabs.listTabs({afterTabId:null,limit:10})).items[0].tabRef;
  const debug=await import('../../out/extension/background/debugger-service.js');await debug.attachDebugger(tabRef,dispatch);
  const consoleCapture=await import('../../out/extension/background/console-service.js'),performanceCapture=await import('../../out/extension/background/performance-service.js');
  const {parseCommand}=await import('../../out/extension/background/command-dispatcher.js');
  const {readArtifactBytes,releaseArtifact}=await import('../../out/extension/background/artifact-service.js');
  const startConsole=async includeExisting=>(await consoleCapture.startConsole(caller,{tabRef,durationMs:100000,includeExisting:includeExisting??false},dispatch)).capture.captureId;
  const startPerformance=async()=>(await performanceCapture.startPerformance(caller,{tabRef,durationMs:100000,timeDomain:'timeTicks'},dispatch)).capture.captureId;
  const readConsole=captureId=>consoleCapture.runConsole('owner','console.read',{captureId,afterSequence:0,limit:100});
  const fire=(method,params,sessionId)=>onEvent.fire({tabId:1,...(sessionId?{sessionId}:{})},method,params);
  await t.test('strict public schema supplies defaults and rejects hidden or invalid modes',async()=>{
   for(const method of ['console.start','performance.start']){
    const parsed=parseCommand({method,schemaVersion:1,params:{tabRef}});assert.ok(parsed);assert.equal(parsed.params.durationMs,300000);
    assert.equal(parseCommand({method,schemaVersion:1,params:{tabRef,surprise:true}}),null);
   }
   assert.equal(parseCommand({method:'performance.start',schemaVersion:1,params:{tabRef,timeDomain:'percent'}}),null);
   assert.equal(parseCommand({method:'console.start',schemaVersion:1,params:{tabRef,includeExisting:null}}),null);
  });
  await t.test('console snapshots retain primitive values, stack traces and application objectId fields; only emitted handles are released',async()=>{
   const captureId=await startConsole();
   await assert.rejects(debug.sendDebuggerProtocol({tabRef,method:'Runtime.evaluate',params:{}},dispatch),error=>error.details.reason==='DOMAIN_IN_USE');
   fire('Runtime.consoleAPICalled',{type:'log',timestamp:Date.now()-1000,args:[{type:'object',objectId:'historical-handle'}]});
   fire('Runtime.consoleAPICalled',{type:'log',timestamp:Date.now(),args:[{type:'number',unserializableValue:'NaN'},{type:'object',objectId:'object-1',value:{objectId:'application-value'},description:'Object'}]});
   fire('Runtime.exceptionThrown',{timestamp:Date.now(),exceptionDetails:{exceptionId:7,text:'Uncaught',stackTrace:{callFrames:[{functionName:'fixture',url:tab.url,lineNumber:1,columnNumber:2}]},exception:{type:'object',objectId:'error-1',description:'Error: fixture'}}});
   fire('Runtime.exceptionRevoked',{reason:'handled',exceptionId:7});
   fire('Log.entryAdded',{entry:{source:'network',level:'error',text:'fixture',timestamp:Date.now(),args:[{type:'object',objectId:'child-1'}]}},'child-session');
   const read=await readConsole(captureId);assert.equal(read.items.length,4);assert.equal(read.capture.excludedExisting,1);
   assert.equal(read.items[0].params.args[0].unserializableValue,'NaN');assert.deepEqual(read.items[0].params.args[1].value,{objectId:'application-value'});assert.equal(read.items[0].params.args[1].objectId,undefined);
   assert.equal(read.items[1].params.exceptionDetails.stackTrace.callFrames[0].functionName,'fixture');assert.equal(read.items[2].historical,null);
   const page=await consoleCapture.runConsole('owner','console.read',{captureId,afterSequence:1,limit:1});assert.equal(page.nextSequence,2);assert.equal(page.hasMore,true);
   await assert.rejects(consoleCapture.runConsole('foreign','console.read',{captureId,afterSequence:0,limit:10}),error=>error.details.reason==='CAPTURE_NOT_FOUND');
   await assert.rejects(consoleCapture.runConsole('owner','console.export',{captureId}),error=>error.details.reason==='STOP_CAPTURE_BEFORE_EXPORT');
   authorized=false;const stopped=await consoleCapture.runConsole('owner','console.stop',{captureId});authorized=true;
   assert.equal(stopped.capture.state,'stopped');assert.equal(stopped.capture.pendingReleases,0);
   const releases=calls.filter(call=>call.method==='Runtime.releaseObject');assert.deepEqual(releases.map(call=>call.params.objectId).sort(),['child-1','error-1','historical-handle','object-1']);
   assert.equal(releases.find(call=>call.params.objectId==='child-1').target.sessionId,'child-session');
   assert.equal(calls.some(call=>['Runtime.getProperties','Runtime.discardConsoleEntries','Runtime.releaseObjectGroup'].includes(call.method)),false);
   const exported=await consoleCapture.runConsole('owner','console.export',{captureId});const content=JSON.parse(new TextDecoder().decode((await readArtifactBytes('owner',exported.artifact.artifactRef,100000)).bytes));
   assert.deepEqual(content.records,read.items);await releaseArtifact('owner',exported.artifact.artifactRef);
   const historical=await startConsole(true);fire('Runtime.consoleAPICalled',{type:'warning',timestamp:Date.now()-1000,args:[{type:'string',value:'old'}]});
   assert.equal((await readConsole(historical)).items[0].historical,true);await consoleCapture.runConsole('owner','console.stop',{captureId:historical});
  });
  await t.test('original metric names and values survive sampling, current authority is checked, and late reads cannot append after stop',async()=>{
   const captureId=await startPerformance();sendHook=async method=>method==='Performance.getMetrics'?{metrics:[{name:'TaskDuration',value:1.25},{name:'JSHeapUsedSize',value:4096}]}:{};
   const sample=await performanceCapture.runPerformance('owner','performance.sample',{captureId});assert.deepEqual(sample.sample.metrics,[{name:'TaskDuration',value:1.25},{name:'JSHeapUsedSize',value:4096}]);
   authorized=false;await assert.rejects(performanceCapture.runPerformance('owner','performance.sample',{captureId}),/authority lost/);authorized=true;
   let complete;sendHook=async method=>method==='Performance.getMetrics'?new Promise(resolve=>{complete=resolve;}):{};
   const late=performanceCapture.runPerformance('owner','performance.sample',{captureId});const rejected=assert.rejects(late,error=>['CAPTURE_NOT_RUNNING','CAPTURE_INTERRUPTED'].includes(error.details.reason));
   while(!complete)await new Promise(resolve=>setTimer(resolve,0));
   const stopping=performanceCapture.runPerformance('owner','performance.stop',{captureId});complete({metrics:[{name:'TaskDuration',value:2}]});await stopping;await rejected;
   const read=await performanceCapture.runPerformance('owner','performance.read',{captureId,afterSequence:0,limit:10});assert.equal(read.items.length,1);
   const exported=await performanceCapture.runPerformance('owner','performance.export',{captureId});const body=JSON.parse(new TextDecoder().decode((await readArtifactBytes('owner',exported.artifact.artifactRef,100000)).bytes));
   assert.deepEqual(body.samples,read.items);await releaseArtifact('owner',exported.artifact.artifactRef);sendHook=async()=>({});
  });
  await t.test('unresolved disable receipts retain domains and repeated explicit stop never resends them',async()=>{
   shortCleanup=true;
   for(const [service,kind,method,start] of [[consoleCapture,'console','Runtime.disable',startConsole],[performanceCapture,'performance','Performance.disable',startPerformance]]){
    let complete;sendHook=async name=>name===method?new Promise(resolve=>{complete=resolve;}):{};
    const captureId=await start();const run=service[kind==='console'?'runConsole':'runPerformance'];
    assert.equal((await run('owner',`${kind}.stop`,{captureId})).capture.state,'cleanup_failed');const count=calls.filter(call=>call.method===method).length;
    assert.equal((await run('owner',`${kind}.stop`,{captureId})).capture.state,'cleanup_failed');assert.equal(calls.filter(call=>call.method===method).length,count);
    await assert.rejects(debug.sendDebuggerProtocol({tabRef,method:method.replace('disable','enable'),params:{}},dispatch),error=>error.details.reason==='DOMAIN_IN_USE');
    complete({});assert.equal((await run('owner',`${kind}.stop`,{captureId})).capture.state,'stopped');
   }
   shortCleanup=false;sendHook=async()=>({});
  });
  await t.test('Key revocation leaves captures running and explicit stops retain cleanup ownership',async()=>{
   const {createKey,revokeKey}=await import('../../out/extension/background/key-service.js');
   const mutationId=()=>`am1.${Date.now()}.${randomBytes(16).toString('base64url')}`;
   const key=(await createKey({mutationId:mutationId(),displayName:'telemetry revocation',keyKind:'regular',permissions:['console.capture','performance.capture'],enabled:true,expiresAt:null})).key;
   const secondRef=(await tabs.listTabs({afterTabId:null,limit:10})).items[1].tabRef;await debug.attachDebugger(secondRef,dispatch);
   const owned=[];
   for(const targetRef of [tabRef,secondRef]){
    owned.push(['console',(await consoleCapture.startConsole(key,{tabRef:targetRef,durationMs:100000,includeExisting:false},dispatch)).capture.captureId]);
    owned.push(['performance',(await performanceCapture.startPerformance(key,{tabRef:targetRef,durationMs:100000,timeDomain:'timeTicks'},dispatch)).capture.captureId]);
   }
   let first;const firstStop=new Promise(resolve=>{first=resolve;}),pending=[];let releaseAll=false;
   sendHook=async method=>{if(['Runtime.disable','Performance.disable'].includes(method)&&!releaseAll)return new Promise(resolve=>{pending.push(resolve);first();});return {};};
   await revokeKey({mutationId:mutationId(),keyId:key.keyId,expectedRevision:1});
   for(const [kind,captureId] of owned){const run=kind==='console'?consoleCapture.runConsole:performanceCapture.runPerformance;
    assert.equal((await run(key.keyId,`${kind}.read`,{captureId,afterSequence:0,limit:10})).capture.state,'running');
   }
   const stopping=Promise.all(owned.map(([kind,captureId])=>(kind==='console'?consoleCapture.runConsole:performanceCapture.runPerformance)(key.keyId,`${kind}.stop`,{captureId})));
   await firstStop;
   try{
    for(const [kind,captureId] of owned){const run=kind==='console'?consoleCapture.runConsole:performanceCapture.runPerformance;
     assert.equal((await run(key.keyId,`${kind}.read`,{captureId,afterSequence:0,limit:10})).capture.state,'stopping');
    }
   }finally{releaseAll=true;pending.forEach(resolve=>resolve({}));await stopping;sendHook=async()=>({});await debug.detachDebugger(secondRef,dispatch);}
  });
  await t.test('reference pressure is bounded and requires explicit detach when ownership cannot be fully released',async()=>{
   const captureId=await startConsole(),pending=[];shortCleanup=true;
   sendHook=async method=>method==='Runtime.releaseObject'?new Promise(resolve=>pending.push(resolve)):{};
   const maximum=COMMAND_CATALOG.limits['command.console.maximum_pending_releases'];
   fire('Runtime.consoleAPICalled',{type:'log',timestamp:Date.now(),args:Array.from({length:maximum+1},(_,i)=>({type:'object',objectId:`pressure-${i}`}))});
   const read=await readConsole(captureId);assert.equal(read.capture.pendingReleases,maximum);assert.equal(read.capture.untrackedReferences,1);
   // Settle only the already-owned exact releases. The one untracked reference
   // is never declared released and no shared object group is cleared.
   await new Promise(resolve=>setTimer(resolve,0));pending.forEach(resolve=>resolve({}));
   const stopped=await consoleCapture.runConsole('owner','console.stop',{captureId});assert.equal(stopped.capture.state,'cleanup_failed');assert.equal(stopped.capture.recovery,'explicit_debugger_detach');
   await debug.detachDebugger(tabRef,dispatch);assert.equal((await readConsole(captureId)).capture.state,'interrupted');
  });
 }finally{globalThis.chrome=original;globalThis.setTimeout=setTimer;}
});
