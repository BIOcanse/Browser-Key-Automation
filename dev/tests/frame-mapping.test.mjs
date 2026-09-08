import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import 'fake-indexeddb/auto';
import {COMMAND_CATALOG} from '../../out/extension/generated/command-config.js';

const event=()=>{const listeners=new Set();return {addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn),fire:(...args)=>{for(const fn of listeners)fn(...args);}};};
const mutationId=()=>`am1.${Date.now()}.${randomBytes(16).toString('base64url')}`;
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const viewport={x:0,y:0,width:100,height:80};
const box={parent:-1,selected:true,visible:true,width:100,height:80,matrix:[1,0,0,1,0,0],radii:['0','0','0','0'],border:[0,0,0,0],padding:[0,0,0,0],clipPath:'none',overflowX:false,overflowY:false,overflowEscape:null,svg:null};
const childGeometry={viewport,contentViewport:viewport,rootIndex:0,boxes:[{...box,width:20,height:10,matrix:[1,0,0,1,7,9]}]};
const parentGeometry={viewport:{...viewport,width:800,height:600},contentViewport:{...viewport,width:800,height:600},rootIndex:0,boxes:[{...box,matrix:[1,0,0,1,100,50]}]};

test('frame mapping proves exact document/session ownership and retains cleanup through cancellation',async t=>{
 const previous=globalThis.chrome,storage={},calls=[],proofs=new Map(),onEvent=event(),onDetach=event();
 const tab={id:1,index:0,windowId:1,active:true,highlighted:false,pinned:false,incognito:false,status:'complete',title:'Fixture',url:'https://same.test'};
 const frames=[{frameId:0,parentFrameId:-1,documentId:'top',url:tab.url},{frameId:4,parentFrameId:0,documentId:'child',url:tab.url},{frameId:5,parentFrameId:0,documentId:'sibling',url:tab.url}];
 let hook=async()=>undefined,objectSequence=0;
 const emit=(sessionId,method,params)=>onEvent.fire({tabId:1,...(sessionId===null?{}:{sessionId})},method,params);
 const context=(document,sessionId)=>({id:document==='top'?11:document==='child'?22:33,uniqueId:`unique-${document}`,origin:'chrome-extension://frame-mapping',auxData:{type:'isolated',frameId:`cdp-${document}`}});
 globalThis.chrome={runtime:{id:'frame-mapping',getManifest:()=>({version:'test'})},storage:{session:{async setAccessLevel(){},async get(key){return {[key]:storage[key]};},async set(items){Object.assign(storage,items);}}},
  tabs:{onRemoved:event(),onReplaced:event(),async query(){return [tab];},async get(){return tab;}},webNavigation:{async getAllFrames(){return frames.map(frame=>({...frame}));}},
  scripting:{async executeScript(request){
   const frame=frames.find(frame=>frame.documentId===request.target.documentIds[0]);assert.ok(frame,'only an exact live document can be injected');
   let result;const {func,args}=request;
   if(func.name==='setFrameDocumentProof'){proofs.set(frame.documentId,{proofId:args[0],nonce:args[1]});result=true;}
   else if(func.name==='clearFrameDocumentProof'){const proof=proofs.get(frame.documentId);if(proof?.proofId===args[0]&&proof.nonce===args[1])proofs.delete(frame.documentId);}
   else if(func.name==='readFrameDocumentProof')result=proofs.get(frame.documentId)??null;
   else if(func.name==='collectDocumentGeometry'){assert.equal(frame.documentId,'child');result={ok:true,geometry:childGeometry};}
   else assert.fail(`unexpected injection ${func.name}`);
   return [{frameId:frame.frameId,documentId:frame.documentId,result}];
  }},debugger:{onEvent,onDetach,async attach(){calls.push({method:'attach'});},async detach(target){onDetach.fire(target,'detached');},async sendCommand(target,method,params){
   const sessionId=target.sessionId??null;calls.push({sessionId,method,params});
   const custom=await hook({sessionId,method,params});if(custom!==undefined)return custom;
   if(method==='Runtime.enable'){
    for(const document of sessionId===null?['top','sibling']:['child'])emit(sessionId,'Runtime.executionContextCreated',{context:context(document,sessionId)});
   }
   if(method==='Runtime.evaluate'){
    assert.ok(params.uniqueContextId);assert.equal(params.contextId,undefined);
    assert.ok(!params.expression.includes([...proofs.values()][0].nonce),'expected nonce must not be passed into the context being proved');
    return {result:{value:proofs.get(params.uniqueContextId.slice(7))??null}};
   }
   if(method==='DOM.getFrameOwner'){assert.equal(sessionId,null);assert.equal(params.frameId,'cdp-child');return {backendNodeId:77};}
   if(method==='DOM.resolveNode'){assert.equal(params.backendNodeId,77);assert.equal(params.executionContextId,11);return {object:{objectId:`owner-${++objectSequence}`}};}
   if(method==='Runtime.callFunctionOn'){
    if(params.functionDeclaration.includes('collectDocumentGeometry'))assert.ok(params.arguments.every(argument=>argument.value!==null),'private null marker must be constructed inside the function');
    return {result:{value:params.functionDeclaration.includes('collectDocumentGeometry')?{ok:true,geometry:parentGeometry}:proofs.get('top')}};
   }
   return {};
  }}};
 const dispatch=effect=>effect();
 const keys=await import('../../out/extension/background/key-service.js');
 const tabs=await import('../../out/extension/background/tab-service.js');tabs.initializeTabService();
 const tabRef=(await tabs.listTabs({afterTabId:null,limit:10})).items[0].tabRef;
 const debug=await import('../../out/extension/background/debugger-service.js');
 const {withFrameMapping}=await import('../../out/extension/background/capture/frame-mapping.js');
 const target={tabId:1,tabRef,frameId:4,documentId:'child',nodeRef:`nr1.${'A'.repeat(43)}`};
 const newKey=async()=> (await keys.createKey({mutationId:mutationId(),displayName:'mapping fixture',keyKind:'regular',permissions:['page.screenshot.capture'],enabled:true,expiresAt:Date.now()+3600000})).key;
 const reset=async(attachedChild=true)=>{
  await debug.detachDebugger(tabRef,dispatch).catch(()=>{});await debug.attachDebugger(tabRef,dispatch);calls.length=0;proofs.clear();hook=async()=>undefined;
  if(attachedChild)emit(null,'Target.attachedToTarget',{sessionId:'oopif',targetInfo:{type:'iframe',targetId:'child-target'}});
 };
 try{
  await t.test('duplicate URLs resolve by unique contexts, geometry and all exact object releases',async()=>{
   await reset();const caller=await newKey();
   hook=async({method,sessionId})=>{if(method==='Runtime.enable'){
    emit(sessionId,'Runtime.consoleAPICalled',{args:[{objectId:`console-${sessionId}`},{objectId:`console-${sessionId}`} ]});
    emit(sessionId,'Runtime.exceptionThrown',{exceptionDetails:{exception:{objectId:`exception-${sessionId}`}}});
    emit(sessionId,'Runtime.inspectRequested',{object:{objectId:`inspect-${sessionId}`}});
   }};
   const result=await withFrameMapping(caller,target,dispatch,async mapping=>{
    const first=await mapping.geometry(),second=await mapping.geometry();assert.deepEqual(first,second);return first;
   });
   assert.deepEqual(result.boxes[1].matrix,[1,0,0,1,107,59]);assert.equal(proofs.size,0);
   const releases=calls.filter(call=>call.method==='Runtime.releaseObject');assert.equal(releases.length,8);
   assert.equal(new Set(releases.map(call=>JSON.stringify([call.sessionId,call.params.objectId]))).size,8);
   assert.deepEqual(calls.filter(call=>call.method==='Runtime.disable').map(call=>call.sessionId),[null,'oopif']);
   assert.equal(calls.some(call=>call.method==='attach'||call.method.startsWith('Target.')),false,'mapping must never attach');
   const lease=await debug.leaseDebuggerDomains(tabRef,['Runtime','DOM'],dispatch,()=>{});lease.release();
  });
  await t.test('missing OOPIF sessions reject without auto-attach and release the seeded proofs',async()=>{
   await reset(false);let executed=false;
   await assert.rejects(withFrameMapping(await newKey(),target,dispatch,async()=>{executed=true;}),error=>error.details.feature==='frame-session-not-attached');
   assert.equal(executed,false);assert.equal(proofs.size,0);assert.equal(calls.some(call=>call.method.startsWith('Target.')),false);
  });
  await t.test('a destroyed exact context cannot be replaced by the same numeric ID',async()=>{
   await reset();
   await assert.rejects(withFrameMapping(await newKey(),target,dispatch,async mapping=>{
    emit('oopif','Runtime.executionContextDestroyed',{executionContextUniqueId:'unique-child',executionContextId:22});
    emit('oopif','Runtime.executionContextCreated',{context:{...context('child','oopif'),uniqueId:'replacement'}});
    return mapping.geometry();
   }),error=>error.details.feature==='frame-context-identity');
   assert.equal(calls.filter(call=>call.method==='DOM.getFrameOwner').length,0);assert.equal(proofs.size,0);
  });
  await t.test('a capture deadline while resolveNode is pending retains the lease and releases its late object exactly once',async()=>{
   await reset();const caller=await newKey(),arrived=deferred(),resolved=deferred();
   hook=async({method})=>{if(method==='DOM.resolveNode'){arrived.resolve();return resolved.promise;}};
   const timeout=COMMAND_CATALOG.limits['command.page.screenshot.frame_cleanup_timeout_ms'];COMMAND_CATALOG.limits['command.page.screenshot.frame_cleanup_timeout_ms']=15;
   const mappingTimeout=COMMAND_CATALOG.limits['command.page.screenshot.frame_mapping_timeout_ms'];COMMAND_CATALOG.limits['command.page.screenshot.frame_mapping_timeout_ms']=40;
   try{
    const run=withFrameMapping(caller,target,dispatch,mapping=>mapping.geometry());
    const rejected=assert.rejects(run,error=>error.details.reason==='FRAME_MAPPING_CLEANUP_PENDING'&&error.details.observation.requiredAction==='explicit_debugger_detach');
    await arrived.promise;await rejected;
    await assert.rejects(debug.leaseDebuggerDomains(tabRef,['Runtime'],dispatch,()=>{}),error=>error.details.reason==='DOMAIN_IN_USE');
    resolved.resolve({object:{objectId:'late-owner'}});
    for(let i=0;i<100&&!calls.some(call=>call.method==='Runtime.releaseObject'&&call.params.objectId==='late-owner');i++)await new Promise(resolve=>setTimeout(resolve,2));
    assert.equal(calls.filter(call=>call.method==='DOM.resolveNode').length,1);assert.equal(calls.filter(call=>call.method==='Runtime.releaseObject'&&call.params.objectId==='late-owner').length,1);
    await new Promise(resolve=>setTimeout(resolve,5));const lease=await debug.leaseDebuggerDomains(tabRef,['Runtime'],dispatch,()=>{});lease.release();
   }finally{COMMAND_CATALOG.limits['command.page.screenshot.frame_cleanup_timeout_ms']=timeout;COMMAND_CATALOG.limits['command.page.screenshot.frame_mapping_timeout_ms']=mappingTimeout;resolved.resolve({object:{objectId:'late-owner'}});}
  });
  await t.test('untracked reference overflow cannot advertise a clean lease until explicit detach',async()=>{
   await reset();const release=deferred(),maximum=COMMAND_CATALOG.limits['command.page.screenshot.maximum_frame_objects'];
   COMMAND_CATALOG.limits['command.page.screenshot.maximum_frame_objects']=1;
   hook=async({method,sessionId})=>{
    if(method==='Runtime.enable')emit(sessionId,'Runtime.consoleAPICalled',{args:[{objectId:'one'},{objectId:'two'}]});
    if(method==='Runtime.releaseObject')return release.promise;
   };
   const timeout=COMMAND_CATALOG.limits['command.page.screenshot.frame_cleanup_timeout_ms'];COMMAND_CATALOG.limits['command.page.screenshot.frame_cleanup_timeout_ms']=15;
   try{
    await assert.rejects(withFrameMapping(await newKey(),target,dispatch,async()=>assert.fail('overflow cannot run screenshot')),error=>error.details.reason==='FRAME_MAPPING_CLEANUP_PENDING');
    release.resolve({});await new Promise(resolve=>setTimeout(resolve,5));
    await assert.rejects(debug.leaseDebuggerDomains(tabRef,['Runtime'],dispatch,()=>{}),error=>error.details.reason==='DOMAIN_IN_USE');
    await debug.detachDebugger(tabRef,dispatch);await debug.attachDebugger(tabRef,dispatch);
    const lease=await debug.leaseDebuggerDomains(tabRef,['Runtime'],dispatch,()=>{});lease.release();
   }finally{release.resolve({});COMMAND_CATALOG.limits['command.page.screenshot.maximum_frame_objects']=maximum;COMMAND_CATALOG.limits['command.page.screenshot.frame_cleanup_timeout_ms']=timeout;}
  });
 }finally{await debug.detachDebugger(tabRef,dispatch).catch(()=>{});globalThis.chrome=previous;}
});
