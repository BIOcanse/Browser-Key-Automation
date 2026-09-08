import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import 'fake-indexeddb/auto';
const event=()=>{const listeners=new Set();return {addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn),fire:(...args)=>{for(const fn of listeners)fn(...args);}};};
const mutationId=()=>`am1.${Date.now()}.${randomBytes(16).toString('base64url')}`;

test('telemetry deadlines release the Key command while retaining exact protocol ownership',async t=>{
 const previous=globalThis.chrome,setTimer=globalThis.setTimeout,storage={},calls=[],onEvent=event(),onDetach=event();
 let sendHook=async()=>({}),shortWait=false;
 globalThis.setTimeout=(callback,ms,...args)=>{const timer=setTimer(callback,shortWait&&ms===5000?5:ms,...args);if(ms>10000)timer.unref();return timer;};
 const tab={id:1,index:0,windowId:1,active:true,highlighted:false,pinned:false,incognito:false,status:'complete',title:'Fixture',url:'https://example.test'};
 globalThis.chrome={runtime:{id:'telemetry-lifecycle',getManifest:()=>({version:'test'})},storage:{session:{async setAccessLevel(){},async get(key){return {[key]:storage[key]};},async set(items){Object.assign(storage,items);}}},
  tabs:{onRemoved:event(),onReplaced:event(),async query(){return [tab];},async get(){return tab;}},
  debugger:{onEvent,onDetach,async attach(){},async detach(target){onDetach.fire(target,'detached');},async sendCommand(_target,method,params){calls.push(method);return sendHook(method,params);}}};
 const dispatch=effect=>effect();
 try{
  const keys=await import('../../out/extension/background/key-service.js');
  const tabs=await import('../../out/extension/background/tab-service.js');tabs.initializeTabService();
  const tabRef=(await tabs.listTabs({afterTabId:null,limit:10})).items[0].tabRef;
  const debug=await import('../../out/extension/background/debugger-service.js');await debug.attachDebugger(tabRef,dispatch);
  const consoleCapture=await import('../../out/extension/background/console-service.js'),performanceCapture=await import('../../out/extension/background/performance-service.js');
  const root={keyId:'root',keyKind:'root',enabled:true,status:'active',expiresAt:null,permissions:[]};
  const newKey=async()=> (await keys.createKey({mutationId:mutationId(),displayName:'deadline fixture',keyKind:'regular',permissions:['console.capture','performance.capture'],enabled:true,expiresAt:Date.now()+3600000})).key;
  const specs=[{kind:'console',domain:'Runtime',start:consoleCapture.startConsole,run:consoleCapture.runConsole,params:{includeExisting:false}},
   {kind:'performance',domain:'Performance',start:performanceCapture.startPerformance,run:performanceCapture.runPerformance,params:{timeDomain:'timeTicks'}}];
  for(const spec of specs){
   const start=(caller=root,gate=dispatch)=>spec.start(caller,{tabRef,durationMs:100000,...spec.params},gate);
   const read=(owner,captureId)=>spec.run(owner,`${spec.kind}.read`,{captureId,afterSequence:0,limit:100});
   await t.test(`${spec.kind}: Key expiry changes do not alter an accepted capture duration`,async()=>{
    const caller=await newKey(),captureId=(await start(caller)).capture.captureId;
    const acceptedDeadline=(await read(caller.keyId,captureId)).capture.expiresAt;
    const deadline=Date.now()+150;
    const changed=await keys.updateKey({mutationId:mutationId(),keyId:caller.keyId,expectedRevision:1,patch:{displayName:caller.displayName,permissions:caller.permissions,enabled:true,expiresAt:deadline}});
    assert.equal((await read(caller.keyId,captureId)).capture.expiresAt,acceptedDeadline);
    await keys.updateKey({mutationId:mutationId(),keyId:caller.keyId,expectedRevision:changed.recordRevision,patch:{displayName:caller.displayName,permissions:caller.permissions,enabled:true,expiresAt:Date.now()+3600000}});
    assert.equal((await read(caller.keyId,captureId)).capture.expiresAt,acceptedDeadline);
    await new Promise(resolve=>setTimer(resolve,Math.max(0,deadline-Date.now())+25));
    onEvent.fire({tabId:1},'Runtime.consoleAPICalled',{type:'log',timestamp:Date.now(),args:[{type:'string',value:'after deadline'}]});
    assert.equal((await read(caller.keyId,captureId)).capture.state,'running');
    assert.equal((await spec.run(caller.keyId,`${spec.kind}.stop`,{captureId})).capture.state,'stopped');
   });
   await t.test(`${spec.kind}: Key revocation during acquisition leaves the accepted start intact`,async()=>{
    const caller=await newKey();let reached,release;
    const arrived=new Promise(resolve=>{reached=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    const old=start(caller,async effect=>{reached();await gate;return effect();});
    await arrived;await keys.revokeKey({mutationId:mutationId(),keyId:caller.keyId,expectedRevision:1});
    const enables=calls.filter(method=>method===`${spec.domain}.enable`).length;release();
    const accepted=await old;assert.equal(accepted.capture.state,'running');assert.equal(calls.filter(method=>method===`${spec.domain}.enable`).length,enables+1);
    assert.equal((await spec.run(caller.keyId,`${spec.kind}.stop`,{captureId:accepted.capture.captureId})).capture.state,'stopped');
   });
   await t.test(`${spec.kind}: a never-returning enable settles start with the same receipt retained`,async()=>{
    shortWait=true;let complete;
    sendHook=async method=>method===`${spec.domain}.enable`?new Promise(resolve=>{complete=resolve;}):{};
    let captureId;
    await assert.rejects(start(),error=>{captureId=error.details.observation?.capture.captureId;return error.details.reason===`${spec.kind.toUpperCase()}_START_FAILED`&&error.details.observation.capture.pendingProtocolCalls===1;});
    assert.ok(captureId);assert.equal((await read('root',captureId)).capture.state,'cleanup_failed');
    await assert.rejects(debug.sendDebuggerProtocol({tabRef,method:`${spec.domain}.enable`,params:{}},dispatch),error=>error.details.reason==='DOMAIN_IN_USE');
    assert.equal(calls.filter(method=>method===`${spec.domain}.disable`).at(-1),`${spec.domain}.disable`);
    const before=calls.filter(method=>method===`${spec.domain}.disable`).length;complete({});
    assert.equal((await spec.run('root',`${spec.kind}.stop`,{captureId})).capture.state,'stopped');
    assert.equal(calls.filter(method=>method===`${spec.domain}.disable`).length,before+1);sendHook=async()=>({});shortWait=false;
   });
  }
  await t.test('performance: a timed-out metrics read never appends its late response or repeats the call',async()=>{
   shortWait=true;const captureId=(await performanceCapture.startPerformance(root,{tabRef,durationMs:100000,timeDomain:'timeTicks'},dispatch)).capture.captureId;
   let complete;sendHook=async method=>method==='Performance.getMetrics'?new Promise(resolve=>{complete=resolve;}):{};
   await assert.rejects(performanceCapture.runPerformance('root','performance.sample',{captureId}),error=>error.details.reason==='PERFORMANCE_OPERATION_TIMEOUT'&&error.details.observation.capture.pendingProtocolCalls===1);
   assert.equal((await performanceCapture.runPerformance('root','performance.read',{captureId,afterSequence:0,limit:10})).items.length,0);
   complete({metrics:[{name:'TaskDuration',value:99}]});await performanceCapture.runPerformance('root','performance.stop',{captureId});
   assert.equal((await performanceCapture.runPerformance('root','performance.read',{captureId,afterSequence:0,limit:10})).items.length,0);
   assert.equal(calls.filter(method=>method==='Performance.getMetrics').length,1);
  });
 }finally{globalThis.chrome=previous;globalThis.setTimeout=setTimer;}
});
