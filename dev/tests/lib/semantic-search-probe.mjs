import assert from 'node:assert/strict';

/** Opt-in only: uses an already running, explicitly identified local embedding model. */
export async function runSemanticSearchProbe({call,baseUrl,windowId,activeTabRef,observations,endpoint,model}) {
 const tabs=[],indexes=[];
 const settings={endpoint,model,modelVersion:'nomic-embed-text-v1.5.Q4_K_M.gguf',dimensions:768,documentPrefix:'search_document: ',queryPrefix:'search_query: '};
 const errorReason=async(method,params,reason)=>{const error=await call(method,params,'BROWSER_OPERATION_FAILED');assert.equal(error.details.reason,reason);};
 try{
  for(let doc=0;doc<3;doc++){
   const url=new URL(`semantic-fixture?doc=${doc}`,baseUrl),tab=(await call('tabs.create',{windowId,url:url.href,active:false})).tab;tabs.push(tab.tabRef);
   await call('page.wait',{tabRef:tab.tabRef,until:'complete'});
  }
  assert.equal((await call('semantic.model.get')).configuration,null);
  let configuration=(await call('semantic.model.configure',settings)).configuration;
  let index=(await call('semantic.index.create',{name:'same name',tabRefs:tabs})).index;indexes.push(index.indexId);
  const duplicate=(await call('semantic.index.create',{name:'same name',tabRefs:tabs})).index;indexes.push(duplicate.indexId);
  assert.notEqual(index.indexId,duplicate.indexId);
  const page=await call('semantic.index.list',{limit:1});assert.equal(page.items.length,1);assert.ok(page.nextIndexId);
  assert.equal((await call('semantic.index.list',{afterIndexId:page.nextIndexId,limit:1})).items.length,1);
  await call('semantic.index.delete',{indexId:duplicate.indexId,expectedRevision:duplicate.revision});
  index=(await call('semantic.index.build',{indexId:index.indexId,expectedRevision:index.revision})).index;
  assert.equal(index.state,'ready');assert.equal(index.vectorCount,3);assert.equal(index.coverage.complete,true);
  const result=await call('semantic.search',{indexId:index.indexId,query:'automobile maintenance',limit:3});
  assert.equal(result.mode,'semantic');assert.equal(result.metric,'cosine_similarity');assert.equal(result.items[0].source.tabRef,tabs[0]);
  assert.ok(result.items[0].score>result.items[1].score);assert.match(result.items[0].text,/brake pads/u);
  assert.ok(!/automobile|maintenance/iu.test(result.items[0].text));
  assert.equal((await call('search.tabs',{tabRefs:tabs,query:'automobile maintenance'})).matchingDocuments,0);
  let metadata=(await call('semantic.index.get',{indexId:index.indexId})).index;
  assert.equal(metadata.providerModel,model);assert.equal(metadata.configuration.dimensions,768);assert.equal(metadata.sources.length,3);
  for(const source of metadata.sources){assert.match(source.sha256,/^[a-f0-9]{64}$/u);assert.ok(source.documentId);assert.ok(source.capturedAt>0);}
  // An explicit fixture navigation is test setup; the search itself must retain its saved snapshot.
  await call('tabs.navigate',{tabRef:tabs[0],url:new URL('semantic-fixture?doc=1',baseUrl).href});await call('page.wait',{tabRef:tabs[0],until:'complete'});
  assert.match((await call('semantic.search',{indexId:index.indexId,query:'automobile maintenance'})).items[0].text,/brake pads/u);
  index=(await call('semantic.index.build',{indexId:index.indexId,expectedRevision:index.revision})).index;
  const refreshed=await call('semantic.search',{indexId:index.indexId,query:'automobile maintenance'});assert.ok(refreshed.items.every(item=>!item.text.includes('brake pads')));
  configuration=(await call('semantic.model.configure',{...settings,expectedRevision:configuration.revision,modelVersion:'same weights; explicit configuration revision'})).configuration;
  assert.equal((await call('semantic.index.get',{indexId:index.indexId})).index.requiresRebuild,true);
  await errorReason('semantic.search',{indexId:index.indexId,query:'automobile maintenance'},'SEMANTIC_INDEX_REBUILD_REQUIRED');
  index=(await call('semantic.index.update',{indexId:index.indexId,expectedRevision:index.revision,name:'partial explicit scope',tabRefs:[tabs[0],tabs[1]]})).index;
  assert.equal(index.state,'stale');await call('tabs.close',{tabRef:tabs[1]});
  index=(await call('semantic.index.build',{indexId:index.indexId,expectedRevision:index.revision})).index;
  assert.equal(index.state,'partial');assert.equal(index.coverage.complete,false);assert.equal(index.vectorCount,1);assert.equal(index.coverage.failures.length,1);
  const partial=await call('semantic.search',{indexId:index.indexId,query:'baking food'});assert.equal(partial.items.length,1);assert.equal(partial.coverage.complete,false);
  assert.equal((await call('tabs.get',{tabRef:activeTabRef})).tab.active,true);
  for(const tabRef of [tabs[0],tabs[2]])assert.equal((await call('tabs.get',{tabRef})).tab.active,false);
  await call('semantic.index.delete',{indexId:index.indexId,expectedRevision:index.revision});assert.equal((await call('semantic.index.list')).items.length,0);
  observations.push({evidence:'real local 768-dimensional embeddings; paraphrase ranks brake-pad source with no literal keyword match; frozen snapshot, explicit rebuild, revision invalidation, partial scope and deletion',configuration,result,refreshed,partial});
 }finally{
  for(const indexId of indexes){try{const index=(await call('semantic.index.get',{indexId})).index;await call('semantic.index.delete',{indexId,expectedRevision:index.revision});}catch{}}
  for(const tabRef of tabs)await call('tabs.close',{tabRef}).catch(()=>{});
 }
}
