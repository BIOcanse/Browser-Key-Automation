import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';

test('semantic models have private revisioned settings and bounded real-protocol vector validation',async t=>{
 const {parseSemanticModelParams,readSemanticConfiguration,configureSemanticModel,generateEmbeddings}=await import('../../out/extension/background/search/semantic-model.js');
 const originalFetch=globalThis.fetch,setTimer=globalThis.setTimeout;
 const params={expectedRevision:0,endpoint:'http://127.0.0.1:1234/v1/embeddings',model:'fixture-model',modelVersion:'fixture-v1',dimensions:2,documentPrefix:'document: ',queryPrefix:'query: '};
 const configuration={...params,revision:1,updatedAt:Date.now()};
 const dispatch=effect=>effect();let calls=[];
 try{
  await t.test('configuration is explicit, private and rejects lost updates or non-loopback destinations',async()=>{
   assert.equal(await readSemanticConfiguration('owner'),null);assert.equal(parseSemanticModelParams('semantic.model.configure',params),true);
   for(const endpoint of ['https://remote.example/embeddings','http://localhost.evil.example/','http://user:secret@localhost/embeddings','http://localhost/embeddings?token=secret'])assert.equal(parseSemanticModelParams('semantic.model.configure',{...params,endpoint}),false);
   const saved=await configureSemanticModel('owner',params);assert.equal(saved.revision,1);assert.equal(await readSemanticConfiguration('foreign'),null);
   const updates=await Promise.allSettled([configureSemanticModel('owner',{...params,expectedRevision:1,modelVersion:'a'}),configureSemanticModel('owner',{...params,expectedRevision:1,modelVersion:'b'})]);
   assert.equal(updates.filter(result=>result.status==='fulfilled').length,1);assert.equal(updates.find(result=>result.status==='rejected').reason.code,'REVISION_CONFLICT');
   assert.equal((await readSemanticConfiguration('owner')).revision,2);
  });
  await t.test('batch rows retain their input order, prefixes and unit-vector cosine contract without credentials',async()=>{
   globalThis.fetch=async(endpoint,options)=>{calls.push({endpoint,options});return Response.json({model:'fixture-model',data:[{index:1,embedding:[0,3]},{index:0,embedding:[3,4]}]});};
   const result=await generateEmbeddings(configuration,['first','second'],'document',dispatch);
   assert.deepEqual(result.vectors,[[0.6,0.8],[0,1]]);
   assert.deepEqual(JSON.parse(calls[0].options.body),{model:'fixture-model',input:['document: first','document: second'],encoding_format:'float'});
   assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.credentials,'omit');assert.deepEqual(calls[0].options.headers,{'content-type':'application/json'});
   globalThis.fetch=async(_endpoint,options)=>{assert.deepEqual(JSON.parse(options.body).input,['query: question']);return Response.json({model:'fixture-model',data:[{index:0,embedding:[1,0]}]});};
   await generateEmbeddings(configuration,['question'],'query',dispatch);
  });
  await t.test('bad model identities, counts, indices and vectors fail without another request',async()=>{
   const invalid=[{model:'another-model',data:[{index:0,embedding:[1,0]}]},{model:'fixture-model',data:[]},
    {model:'fixture-model',data:[{index:1,embedding:[1,0]}]},{model:'fixture-model',data:[{index:0,embedding:[0,0]}]},
    {model:'fixture-model',data:[{index:0,embedding:[1,0,0]}]},{model:'fixture-model',data:[{index:0,embedding:[null,0]}]}];
   for(const response of invalid){let count=0;globalThis.fetch=async()=>{count++;return Response.json(response);};await assert.rejects(generateEmbeddings(configuration,['x'],'query',dispatch));assert.equal(count,1);}
   globalThis.fetch=async()=>Response.json({model:'fixture-model',data:[{index:0,embedding:[1,0]},{index:0,embedding:[0,1]}]});
   await assert.rejects(generateEmbeddings(configuration,['a','b'],'document',dispatch),error=>error.details.reason==='EMBEDDING_INDEX_MISMATCH');
  });
  await t.test('transport faults are bounded and neither rejected authority nor timeout retries the POST',async()=>{
   let count=0,finish,requestSignal;
   globalThis.fetch=async(_url,options)=>{count++;requestSignal=options.signal;return new Promise(resolve=>{finish=resolve;});};
   await assert.rejects(generateEmbeddings(configuration,['x'],'query',()=>{throw new Error('authority lost');}),/authority lost/);assert.equal(count,0);
   globalThis.setTimeout=(callback,ms,...args)=>setTimer(callback,ms===30000?5:ms,...args);
   await assert.rejects(generateEmbeddings(configuration,['x'],'query',dispatch),error=>error.details.reason==='EMBEDDING_TIMEOUT');
   assert.equal(count,1);assert.equal(requestSignal.aborted,true);
   finish(Response.json({model:'fixture-model',data:[{index:0,embedding:[1,0]}]}));await new Promise(resolve=>setTimer(resolve,0));assert.equal(count,1);
   globalThis.setTimeout=setTimer;
   globalThis.fetch=async()=>new Response('fixture',{status:500});await assert.rejects(generateEmbeddings(configuration,['x'],'query',dispatch),error=>error.details.reason==='EMBEDDING_HTTP_FAILED'&&error.details.observation.status===500);
   globalThis.fetch=async()=>new Response('fixture',{headers:{'content-length':'999999999'}});await assert.rejects(generateEmbeddings(configuration,['x'],'query',dispatch),error=>error.details.reason==='EMBEDDING_RESPONSE_LIMIT');
  });
  await t.test('stream byte limits and malformed encodings fail before any vector is published',async()=>{
   let signal,count=0;
   const {COMMAND_CATALOG}=await import('../../out/extension/generated/command-config.js'),maximum=COMMAND_CATALOG.limits['command.semantic.maximum_response_bytes'];
   COMMAND_CATALOG.limits['command.semantic.maximum_response_bytes']=64;
   globalThis.fetch=async(_url,options)=>{count++;signal=options.signal;return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(40));controller.enqueue(new Uint8Array(40));controller.close();}}));};
   try{await assert.rejects(generateEmbeddings(configuration,['x'],'query',dispatch),error=>error.details.reason==='EMBEDDING_RESPONSE_LIMIT');assert.equal(count,1);assert.equal(signal.aborted,true);}
   finally{COMMAND_CATALOG.limits['command.semantic.maximum_response_bytes']=maximum;}
   for(const bytes of [new Uint8Array([0xf0,0x9f]),new TextEncoder().encode('{"model":')]){
    globalThis.fetch=async()=>new Response(bytes);await assert.rejects(generateEmbeddings(configuration,['x'],'query',dispatch),error=>error.details.reason==='INVALID_EMBEDDING_RESPONSE');
   }
  });
  await t.test('canceling a waiting dispatch prevents a late first HTTP request',async()=>{
   let enter,release,count=0;const arrived=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;}),controller=new AbortController();
   globalThis.fetch=async()=>{count++;throw new Error('must not send');};
   const pending=generateEmbeddings(configuration,['x'],'query',async effect=>{enter();await gate;return effect();},controller.signal);
   const rejected=assert.rejects(pending);await arrived;controller.abort();await rejected;release();await new Promise(resolve=>setTimer(resolve,1));assert.equal(count,0);
  });
 }finally{globalThis.fetch=originalFetch;globalThis.setTimeout=setTimer;}
});
