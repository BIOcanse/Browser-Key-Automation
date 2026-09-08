import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import 'fake-indexeddb/auto';
const event=()=>{const listeners=new Set();return {addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn),fire:(...args)=>{for(const fn of listeners)fn(...args);}};};
const mutationId=()=>`am1.${Date.now()}.${randomBytes(16).toString('base64url')}`;

test('network, dialogs and interception close expired/cancelled starts without losing protocol ownership',async t=>{
 const previous=globalThis.chrome,setTimer=globalThis.setTimeout,storage={},calls=[],onEvent=event(),onDetach=event();
 let sendHook=async()=>({}),shortWait=false;
 globalThis.setTimeout=(callback,ms,...args)=>{const timer=setTimer(callback,shortWait&&ms===5000?5:ms,...args);if(ms>10000)timer.unref();return timer;};
 const tabs=[1,2].map(id=>({id,index:id-1,windowId:id,active:true,highlighted:false,pinned:false,incognito:false,status:'complete',title:'Fixture',url:`https://example.test/${id}`}));
 globalThis.chrome={runtime:{id:'legacy-lifecycle',getManifest:()=>({version:'test'})},storage:{session:{async setAccessLevel(){},async get(key){return {[key]:storage[key]};},async set(items){Object.assign(storage,items);}}},
  tabs:{onRemoved:event(),onReplaced:event(),async query(){return tabs;},async get(id){return tabs[id-1];}},
  debugger:{onEvent,onDetach,async attach(){},async detach(target){onDetach.fire(target,'detached');},async sendCommand(target,method,params){calls.push({tabId:target.tabId,method});return sendHook(method,params,target);}}};
 const dispatch=effect=>effect();
 try{
  const keys=await import('../../out/extension/background/key-service.js');
  const tabService=await import('../../out/extension/background/tab-service.js');tabService.initializeTabService();
  const refs=(await tabService.listTabs({afterTabId:null,limit:10})).items.map(tab=>tab.tabRef);
  const debug=await import('../../out/extension/background/debugger-service.js');for(const ref of refs)await debug.attachDebugger(ref,dispatch);
  const network=await import('../../out/extension/background/network-service.js'),dialogs=await import('../../out/extension/background/dialogs-service.js'),intercept=await import('../../out/extension/background/network-intercept-service.js');
  const root={keyId:'root',keyKind:'root',enabled:true,status:'active',expiresAt:null,permissions:[]};
  const newKey=async()=> (await keys.createKey({mutationId:mutationId(),displayName:'legacy deadline',keyKind:'regular',permissions:['dialogs','network.capture','network.intercept'],enabled:true,expiresAt:Date.now()+3600000})).key;
  const specs=[
   {kind:'network',domain:'Network',failure:'NETWORK_START_FAILED',result:'capture',id:'captureId',start:network.startNetwork,run:network.runNetwork,params:{captureBodies:false},read:'network.read',readParams:{afterRequestId:0,limit:100},empty:value=>value.requestCount===0},
   {kind:'dialogs',domain:'Page',failure:'DIALOG_START_FAILED',result:'watch',id:'watchId',start:dialogs.startDialogs,run:dialogs.runDialogs,params:{policy:null},read:'dialogs.get',readParams:{},empty:value=>value.dialog===null},
   {kind:'network.intercept',domain:'Fetch',failure:'INTERCEPT_START_FAILED',result:'intercept',id:'interceptId',start:intercept.startIntercept,run:intercept.runIntercept,params:{rules:[{urlPattern:'*',stage:'request',action:{kind:'continue'}}],requestTimeoutMs:5000},read:'network.intercept.read',readParams:{afterSequence:0,limit:100},empty:value=>value.observed===0}
  ];
  for(const spec of specs){
   const start=(caller=root,gate=dispatch,tabRef=refs[0],durationMs=100000)=>spec.start(caller,{tabRef,durationMs,...spec.params},gate);
   const meta=response=>response[spec.result];
   const read=async(owner,id)=>meta(await spec.run(owner,spec.read,{[spec.id]:id,...spec.readParams}));
   const stop=async(owner,id)=>meta(await spec.run(owner,`${spec.kind}.stop`,{[spec.id]:id}));
   const emit=tabId=>{
    onEvent.fire({tabId},'Network.requestWillBeSent',{requestId:'late',timestamp:1,wallTime:1,request:{url:'https://example.test/late',method:'GET'}});
    onEvent.fire({tabId},'Page.javascriptDialogOpening',{type:'alert',message:'late',url:'https://example.test',hasBrowserHandler:true});
    onEvent.fire({tabId},'Fetch.requestPaused',{requestId:'late',request:{url:'https://example.test/late'}});
   };
   await t.test(`${spec.kind}: Key expiry changes leave the accepted session duration unchanged`,async()=>{
    const caller=await newKey(),id=meta(await start(caller))[spec.id],deadline=Date.now()+150;
    const acceptedDeadline=(await read(caller.keyId,id)).expiresAt;
    const changed=await keys.updateKey({mutationId:mutationId(),keyId:caller.keyId,expectedRevision:1,patch:{displayName:caller.displayName,permissions:caller.permissions,enabled:true,expiresAt:deadline}});
    assert.equal((await read(caller.keyId,id)).expiresAt,acceptedDeadline);
    await keys.updateKey({mutationId:mutationId(),keyId:caller.keyId,expectedRevision:changed.recordRevision,patch:{displayName:caller.displayName,permissions:caller.permissions,enabled:true,expiresAt:Date.now()+3600000}});
    assert.equal((await read(caller.keyId,id)).expiresAt,acceptedDeadline);
    await new Promise(resolve=>setTimer(resolve,Math.max(0,deadline-Date.now())+25));emit(1);
    assert.equal((await read(caller.keyId,id)).state,'running');assert.equal((await stop(caller.keyId,id)).state,'stopped');
   });
   await t.test(`${spec.kind}: revocation during acquisition does not cancel the accepted start`,async()=>{
    const caller=await newKey();let reached,release;const arrived=new Promise(resolve=>{reached=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    const old=start(caller,async effect=>{reached();await gate;return effect();});
    await arrived;await keys.revokeKey({mutationId:mutationId(),keyId:caller.keyId,expectedRevision:1});
    const count=calls.filter(call=>call.method===`${spec.domain}.enable`).length;release();
    const accepted=meta(await old);assert.equal(accepted.state,'running');assert.equal(calls.filter(call=>call.method===`${spec.domain}.enable`).length,count+1);
    assert.equal((await stop(caller.keyId,accepted[spec.id])).state,'stopped');
   });
   await t.test(`${spec.kind}: an unresolved enable keeps its lease and original receipt after the start deadline`,async()=>{
    shortWait=true;let complete,id;const before=calls.filter(call=>call.method===`${spec.domain}.disable`).length;
    sendHook=async method=>method===`${spec.domain}.enable`?new Promise(resolve=>{complete=resolve;}):{};
    await assert.rejects(start(),error=>{const value=error.details.observation?.[spec.result];id=value?.[spec.id];return error.details.reason===spec.failure&&value.pendingProtocolCalls===1;});
    assert.equal((await read('root',id)).state,'cleanup_failed');assert.equal(calls.filter(call=>call.method===`${spec.domain}.disable`).length,before);
    await assert.rejects(debug.sendDebuggerProtocol({tabRef:refs[0],method:`${spec.domain}.enable`,params:{}},dispatch),error=>error.details.reason==='DOMAIN_IN_USE');
    complete({});assert.equal((await stop('root',id)).state,'stopped');assert.equal(calls.filter(call=>call.method===`${spec.domain}.disable`).length,before+1);
    sendHook=async()=>({});shortWait=false;
   });
   await t.test(`${spec.kind}: explicit stops drain both tabs and never resend disable`,async()=>{
    const caller=await newKey(),ids=[];for(const ref of refs)ids.push(meta(await start(caller,dispatch,ref))[spec.id]);
    shortWait=true;let reached,complete;const arrived=new Promise(resolve=>{reached=resolve;});
    sendHook=async(method,_params,target)=>method===`${spec.domain}.disable`&&target.tabId===1?new Promise(resolve=>{complete=resolve;reached();}):{};
    const stopping=Promise.all(ids.map(id=>stop(caller.keyId,id)));await arrived;
    emit(2);const other=await read(caller.keyId,ids[1]);assert.notEqual(other.state,'running');assert.ok(spec.empty(other));
    await stopping;assert.equal((await read(caller.keyId,ids[0])).state,'cleanup_failed');
    const before=calls.filter(call=>call.method===`${spec.domain}.disable`&&call.tabId===1).length;
    assert.equal((await stop(caller.keyId,ids[0])).state,'cleanup_failed');assert.equal(calls.filter(call=>call.method===`${spec.domain}.disable`&&call.tabId===1).length,before);
    complete({});assert.equal((await stop(caller.keyId,ids[0])).state,'stopped');assert.equal(calls.filter(call=>call.method===`${spec.domain}.disable`&&call.tabId===1).length,before);
    sendHook=async()=>({});shortWait=false;
   });
  }
  await t.test('interception preserves sent-but-unconfirmed evidence after stop/detach and a late rejection',async()=>{
   for(const ending of ['stop','detach']){
    let reached,rejectAction;const arrived=new Promise(resolve=>{reached=resolve;});
    sendHook=async method=>method==='Fetch.continueRequest'?new Promise((_resolve,reject)=>{rejectAction=reject;reached();}):{};
    const interceptId=(await intercept.startIntercept(root,{tabRef:refs[0],durationMs:100000,requestTimeoutMs:5000,rules:[{urlPattern:'*',stage:'request',action:{kind:'continue'}}]},dispatch)).intercept.interceptId;
    const startCalls=calls.length;
    onEvent.fire({tabId:1},'Fetch.requestPaused',{requestId:`late-${ending}`,request:{url:'https://example.test/late'}});await arrived;
    if(ending==='stop')await intercept.runIntercept('root','network.intercept.stop',{interceptId});else await debug.detachDebugger(refs[0],dispatch);
    const read=()=>intercept.runIntercept('root','network.intercept.read',{interceptId,afterSequence:0,limit:10});
    assert.equal((await read()).items[0].state,`unconfirmed_after_${ending}`);
    rejectAction(new Error('original action receipt rejected after close'));await new Promise(resolve=>setTimer(resolve,0));
    assert.equal((await read()).items[0].state,`unconfirmed_after_${ending}`);
    const sent=calls.slice(startCalls);assert.equal(sent.filter(call=>call.method==='Fetch.continueRequest').length,1);assert.equal(sent.filter(call=>call.method==='Fetch.disable').length,ending==='stop'?1:0);
   }
  });
 }finally{globalThis.chrome=previous;globalThis.setTimeout=setTimer;}
});
