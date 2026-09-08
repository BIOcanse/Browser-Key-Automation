import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import 'fake-indexeddb/auto';
const mutationId=()=>`am1.${Date.now()}.${randomBytes(16).toString('base64url')}`;

test('semantic indexes persist verified generations with private ownership, cancellation and truthful failure receipts',async t=>{
 const previous={chrome:globalThis.chrome,document:globalThis.document,location:globalThis.location,fetch:globalThis.fetch};
 const event={addListener(){},removeListener(){}},storage={},calls=[];
 const tabs=[1,2].map(id=>({id,index:id-1,windowId:1,active:id===1,highlighted:false,pinned:false,incognito:false,status:'complete',title:`Page ${id}`,url:`https://example.test/${id}`}));
 const frames=new Map(tabs.map(tab=>[tab.id,[{frameId:0,parentFrameId:-1,url:tab.url,documentId:`doc-${tab.id}`,documentLifecycle:'active'}]]));
 const documents=new Map([['doc-1','The mechanic replaced worn brake pads.'],['doc-2','Fresh bread baked in the kitchen.']]);
 let fetchHook=null;
 const response=body=>Response.json({model:'fixture-model',data:body.input.map((text,index)=>({index,embedding:/mechanic|automobile/u.test(text)?[1,0,0]:[0,1,0]}))});
 globalThis.fetch=async(url,options)=>{const body=JSON.parse(options.body);calls.push({url,body,signal:options.signal});return fetchHook?fetchHook(body,options):response(body);};
 globalThis.chrome={runtime:{id:'semantic-index-test',getManifest:()=>({version:'test'})},storage:{session:{async setAccessLevel(){},async get(key){return {[key]:storage[key]};},async set(items){Object.assign(storage,items);}}},
  tabs:{onRemoved:event,onReplaced:event,async query(){return tabs;},async get(id){return tabs[id-1];}},permissions:{async contains(){return true;}},
  webNavigation:{onCommitted:event,async getAllFrames({tabId}){return structuredClone(frames.get(tabId));}},scripting:{async executeScript(injection){
   const frame=frames.get(injection.target.tabId).find(value=>value.documentId===injection.target.documentIds[0]);
   globalThis.document={title:`Title ${frame.documentId}`,body:{innerText:documents.get(frame.documentId)}};globalThis.location={href:frame.url};
   return [{frameId:frame.frameId,documentId:frame.documentId,result:injection.func(...injection.args)}];
  }}};
 try{
  await t.test('v5 migration retains old actions and adds the new semantic stores',async()=>{
   const old=await new Promise((resolve,reject)=>{const request=indexedDB.open('browser-key-automation',5);request.onupgradeneeded=()=>request.result.createObjectStore('actions',{keyPath:'actionId',autoIncrement:true});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
   await new Promise((resolve,reject)=>{const tx=old.transaction('actions','readwrite');tx.objectStore('actions').put({actionId:41,name:'retained action'});tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});old.close();
   const db=await import('../../out/extension/background/database.js'),opened=await db.getDatabase();assert.equal(opened.version,7);
   assert.deepEqual(Array.from(opened.objectStoreNames).filter(name=>name.startsWith('semantic_')),['semantic_chunks','semantic_indexes','semantic_models']);
   assert.equal((await db.withReadOnly(['actions'],tx=>db.requestResult(tx.objectStore('actions').get(41)))).name,'retained action');
  });
  const db=await import('../../out/extension/background/database.js'),keys=await import('../../out/extension/background/key-service.js');
  const tabService=await import('../../out/extension/background/tab-service.js');tabService.initializeTabService();
  const refs=(await tabService.listTabs({afterTabId:null,limit:10})).items.map(tab=>tab.tabRef);
  const {parseCommand}=await import('../../out/extension/background/command-dispatcher.js');
  const {runSemanticIndex,splitSemanticText}=await import('../../out/extension/background/search/semantic-index.js');
  const model=await import('../../out/extension/background/search/semantic-model.js');
  const {COMMAND_CATALOG}=await import('../../out/extension/generated/command-config.js');
  const modelParams={expectedRevision:0,endpoint:'http://127.0.0.1:1234/v1/embeddings',model:'fixture-model',modelVersion:'test-v1',dimensions:3,documentPrefix:'document: ',queryPrefix:'query: '};
  const newKey=async()=> (await keys.createKey({mutationId:mutationId(),displayName:'semantic fixture',keyKind:'regular',permissions:['semantic.read','semantic.manage','semantic.search'],enabled:true,expiresAt:Date.now()+3600000})).key;
  const owner=await newKey(),foreign=await newKey();await model.configureSemanticModel(owner.keyId,modelParams);
  const run=async(method,params={},caller=owner,dispatch=effect=>effect())=>{const parsed=parseCommand({method,schemaVersion:1,params});assert.ok(parsed,`parse ${method}`);return runSemanticIndex(caller,method,parsed.params,dispatch);};
  const get=async(indexId,caller=owner)=>(await run('semantic.index.get',{indexId},caller)).index;
  const create=async(caller=owner)=>(await run('semantic.index.create',{name:'same name',tabRefs:refs},caller)).index;
  const build=async(index,caller=owner)=>(await run('semantic.index.build',{indexId:index.indexId,expectedRevision:index.revision},caller)).index;
  const search=async(indexId,caller=owner)=>run('semantic.search',{indexId,query:'automobile maintenance'},caller);
  const allChunks=()=>db.withReadOnly(['semantic_chunks'],tx=>db.requestResult(tx.objectStore('semantic_chunks').getAll()));
  let first;
  await t.test('strict scope parsing, private IDs, duplicate names, live pages and lost-update rejection',async()=>{
   assert.equal(parseCommand({method:'semantic.index.create',schemaVersion:1,params:{tabRefs:[]}}),null);
   assert.equal(parseCommand({method:'semantic.index.create',schemaVersion:1,params:{tabRefs:[refs[0],refs[0]]}}),null);
   first=await create();const duplicate=await create();assert.notEqual(first.indexId,duplicate.indexId);assert.equal(first.name,duplicate.name);
   const page=await run('semantic.index.list',{limit:1});assert.equal(page.items.length,1);assert.ok(page.nextIndexId);
   assert.equal((await run('semantic.index.list',{afterIndexId:page.nextIndexId,limit:1})).items.length,1);
   assert.equal((await run('semantic.index.list',{},foreign)).items.length,0);
   await assert.rejects(get(first.indexId,foreign),error=>error.details.reason==='SEMANTIC_INDEX_NOT_FOUND');
   await assert.rejects(run('semantic.index.update',{indexId:first.indexId,expectedRevision:2,name:'x',tabRefs:refs}),error=>error.code==='REVISION_CONFLICT');
   await run('semantic.index.delete',{indexId:duplicate.indexId,expectedRevision:duplicate.revision});
  });
  await t.test('chunks preserve Unicode text and offsets with explicit incomplete coverage',async()=>{
   const value='甲😀abc\n乙',split=splitSemanticText(value,5,20);assert.equal(split.parts.map(p=>p.text).join(''),value);assert.equal(split.bytes,new TextEncoder().encode(value).length);
   for(const part of split.parts){assert.equal(value.slice(part.start,part.end),part.text);assert.ok(new TextEncoder().encode(part.text).length<=5);}
   assert.equal(splitSemanticText(value,5,1).parts.length,1);assert.equal(splitSemanticText(value,5,0).bytes,0);
   const maximum=COMMAND_CATALOG.limits['command.semantic.maximum_chunks'];COMMAND_CATALOG.limits['command.semantic.maximum_chunks']=1;
   try{first=await build(first);assert.equal(first.state,'partial');assert.ok(first.unindexedTextBytes>0);assert.equal(first.vectorCount,1);assert.equal((await search(first.indexId)).coverage.readDocuments,2);}
   finally{COMMAND_CATALOG.limits['command.semantic.maximum_chunks']=maximum;}
  });
  await t.test('actual protocol calls produce a complete generation and query ranks indexed snapshots',async()=>{
   first=await build(first);assert.equal(first.state,'ready');assert.equal(first.vectorCount,2);assert.equal(first.unindexedTextBytes,0);
   const result=await search(first.indexId);assert.equal(result.items[0].source.documentId,'doc-1');assert.equal(result.items[0].text,documents.get('doc-1'));assert.equal(result.mode,'semantic');assert.equal(result.freshness,'indexed_snapshot');
   assert.equal(calls.at(-1).body.input[0],'query: automobile maintenance');assert.ok(!result.items[0].text.includes('automobile'));
   documents.set('doc-1','Fresh bread is ready.');assert.equal((await search(first.indexId)).items[0].text,'The mechanic replaced worn brake pads.');
   first=await build(first);assert.equal((await search(first.indexId)).items[0].text,'Fresh bread is ready.');assert.equal((await allChunks()).length,2);
   documents.set('doc-1','The mechanic replaced worn brake pads.');
  });
  await t.test('failed atomic replacement keeps every old chunk and can be rebuilt explicitly',async()=>{
   const before=await allChunks(),add=IDBObjectStore.prototype.add;let additions=0;
   IDBObjectStore.prototype.add=function(value,...args){if(this.name==='semantic_chunks'&&++additions===2)throw new DOMException('fixture quota fault','QuotaExceededError');return add.call(this,value,...args);};
   try{await assert.rejects(build(first),error=>error.details.observation.stateSaved===true);}finally{IDBObjectStore.prototype.add=add;}
   assert.deepEqual(await allChunks(),before);first=await get(first.indexId);assert.equal(first.state,'failed');await assert.rejects(search(first.indexId),error=>error.details.reason==='SEMANTIC_INDEX_NOT_READY');first=await build(first);
  });
  await t.test('model revision changes reject old-vector queries and in-flight build commits',async()=>{
   let entered,complete;const arrived=new Promise(resolve=>{entered=resolve;});fetchHook=(body)=>new Promise(resolve=>{complete=()=>resolve(response(body));entered();});
   const pending=build(first),rejected=assert.rejects(pending,error=>error.details.reason==='SEMANTIC_CONFIGURATION_CHANGED');await arrived;
   await model.configureSemanticModel(owner.keyId,{...modelParams,expectedRevision:1,modelVersion:'test-v2'});complete();await rejected;fetchHook=null;
   first=await get(first.indexId);assert.equal(first.requiresRebuild,true);const before=calls.length;await assert.rejects(search(first.indexId),error=>error.details.reason==='SEMANTIC_INDEX_REBUILD_REQUIRED');assert.equal(calls.length,before);first=await build(first);
  });
  await t.test('post-commit Artifact faults preserve the confirmed new index revision',async()=>{
   const inline=COMMAND_CATALOG.limits['command.inline.maximum_result_json_bytes'],transaction=IDBDatabase.prototype.transaction;
   COMMAND_CATALOG.limits['command.inline.maximum_result_json_bytes']=64;
   IDBDatabase.prototype.transaction=function(stores,...args){if(Array.from(typeof stores==='string'?[stores]:stores).includes('artifacts'))throw new DOMException('fixture artifact failure','UnknownError');return transaction.call(this,stores,...args);};
   let receipt;try{await assert.rejects(build(first),error=>{receipt=error.details.observation;return receipt.apiCompleted===true&&receipt.indexId===first.indexId;});}
   finally{COMMAND_CATALOG.limits['command.inline.maximum_result_json_bytes']=inline;IDBDatabase.prototype.transaction=transaction;}
   first=await get(first.indexId);assert.equal(first.revision,receipt.revision);assert.equal(first.state,'ready');
  });
  await t.test('foreign callers cannot observe or reserve another owner busy build',async()=>{
   let entered,complete;const arrived=new Promise(resolve=>{entered=resolve;});fetchHook=body=>new Promise(resolve=>{complete=()=>resolve(response(body));entered();});
   const pending=build(first);await arrived;
   try{await assert.rejects(build(first,foreign),error=>error.details.reason==='SEMANTIC_INDEX_NOT_FOUND');}
   finally{complete();fetchHook=null;first=await pending;}
  });
  await t.test('canceling during the terminal put aborts the generation transaction before commit',async()=>{
   const before=await allChunks(),Abort=globalThis.AbortController,put=IDBObjectStore.prototype.put,controllers=[];let canceled=false;
   globalThis.AbortController=class extends Abort{constructor(){super();controllers.push(this);}};
   IDBObjectStore.prototype.put=function(value,...args){const request=put.call(this,value,...args);
    if(this.name==='semantic_indexes'&&value.state==='ready')request.addEventListener('success',()=>{canceled=true;controllers[0].abort();},{once:true});return request;};
   try{await assert.rejects(build(first),error=>error.details.observation.stateSaved===true&&error.details.observation.apiCompleted===undefined);assert.equal(canceled,true);}
   finally{globalThis.AbortController=Abort;IDBObjectStore.prototype.put=put;}
   assert.deepEqual(await allChunks(),before);first=await get(first.indexId);assert.equal(first.state,'failed');first=await build(first);
  });
  await t.test('a successful failure-state put followed by transaction abort cannot report stateSaved',async()=>{
   const put=IDBObjectStore.prototype.put;let aborted=false;
   fetchHook=body=>Response.json({model:'fixture-model',data:body.input.map((_text,index)=>({index,embedding:[0,0,0]}))});
   IDBObjectStore.prototype.put=function(value,...args){const request=put.call(this,value,...args);
    if(this.name==='semantic_indexes'&&value.state==='failed'){const transaction=this.transaction;request.addEventListener('success',()=>queueMicrotask(()=>{aborted=true;transaction.abort();}),{once:true});}return request;};
   try{await assert.rejects(build(first),error=>error.details.observation.stateSaved===false);assert.equal(aborted,true);}
   finally{IDBObjectStore.prototype.put=put;fetchHook=null;}
   first=await get(first.indexId);assert.equal(first.state,'interrupted');first=await build(first);
  });
  await t.test('full search output uses an owner Artifact without another model call',async()=>{
   const {readArtifactBytes,releaseArtifact}=await import('../../out/extension/background/artifact-service.js');
   const inline=COMMAND_CATALOG.limits['command.inline.maximum_result_json_bytes'];COMMAND_CATALOG.limits['command.inline.maximum_result_json_bytes']=64;
   try{const before=calls.length,result=await search(first.indexId);assert.equal(result.items,null);assert.equal(calls.length,before+1);
    const full=JSON.parse(new TextDecoder().decode((await readArtifactBytes(owner.keyId,result.artifact.artifactRef,100000)).bytes));assert.equal(full.items.length,2);
    await assert.rejects(readArtifactBytes(foreign.keyId,result.artifact.artifactRef,100000));await releaseArtifact(owner.keyId,result.artifact.artifactRef);
   }finally{COMMAND_CATALOG.limits['command.inline.maximum_result_json_bytes']=inline;}
  });
  await t.test('Key revocation leaves an accepted query and its original HTTP request running',async()=>{
   const caller=await newKey();await model.configureSemanticModel(caller.keyId,modelParams);const index=await build(await create(caller),caller);
   let entered,complete;const arrived=new Promise(resolve=>{entered=resolve;});fetchHook=body=>new Promise(resolve=>{complete=()=>resolve(response(body));entered();});
   const pending=search(index.indexId,caller);await arrived;
   await keys.revokeKey({mutationId:mutationId(),keyId:caller.keyId,expectedRevision:1});assert.equal(calls.at(-1).signal.aborted,false);const count=calls.length;complete();fetchHook=null;
   assert.ok((await pending).items.length>0);assert.equal(calls.length,count);
  });
  await t.test('Key expiry edits do not cancel the accepted index build',async()=>{
   const caller=await newKey();await model.configureSemanticModel(caller.keyId,modelParams);let index=await create(caller);
   let entered,complete;const arrived=new Promise(resolve=>{entered=resolve;});fetchHook=body=>new Promise(resolve=>{complete=()=>resolve(response(body));entered();});
   const pending=build(index,caller);await arrived;
   const changed=await keys.updateKey({mutationId:mutationId(),keyId:caller.keyId,expectedRevision:1,patch:{displayName:caller.displayName,permissions:caller.permissions,enabled:true,expiresAt:Date.now()+100}});
   await keys.updateKey({mutationId:mutationId(),keyId:caller.keyId,expectedRevision:changed.recordRevision,patch:{displayName:caller.displayName,permissions:caller.permissions,enabled:true,expiresAt:Date.now()+3600000}});
   await new Promise(resolve=>setTimeout(resolve,120));assert.equal(calls.at(-1).signal.aborted,false);complete();fetchHook=null;
   index=await pending;assert.equal(index.state,'ready');assert.ok(index.vectorCount>0);
  });
  await t.test('admitted callers remain valid; orphaned builds recover and deletion removes all generations',async()=>{
   const caller=await newKey();await model.configureSemanticModel(caller.keyId,modelParams);const index=await create(caller);await keys.revokeKey({mutationId:mutationId(),keyId:caller.keyId,expectedRevision:1});
   assert.equal((await build(index,caller)).state,'ready');
   await db.withStrictReadWrite(['semantic_indexes'],async tx=>{const store=tx.objectStore('semantic_indexes'),value=await db.requestResult(store.get(first.indexId));value.state='building';value.buildId='lost-worker';await db.requestResult(store.put(value));});
   first=await get(first.indexId);assert.equal(first.state,'interrupted');assert.equal(first.errorReason,'BUILD_OWNER_LOST');first=await build(first);
   await run('semantic.index.delete',{indexId:first.indexId,expectedRevision:first.revision});assert.equal((await allChunks()).filter(chunk=>chunk.indexId===first.indexId).length,0);await assert.rejects(get(first.indexId));
  });
 }finally{Object.assign(globalThis,previous);}
});
