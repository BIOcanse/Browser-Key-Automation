import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';

test('browser data keeps native identities, live coverage, exact time ranges and one-shot mutation receipts',async t=>{
 const original=globalThis.chrome,calls=[];
 const root={id:'root-from-browser',title:'',syncing:false,children:[{id:'nested',title:'must not leak',syncing:false}]};
 const first={id:'10',parentId:root.id,index:0,title:'重复名称',url:'https://example.test/a',syncing:true};
 const second={...first,id:'2',index:1,url:'file:///C:/sample%20file.html'};
 let nodes=[first,second],denied=false,failWrite=false;
 const dispatch=async effect=>{if(denied)throw new Error('authority lost');return effect();};
 const event={addListener(){},removeListener(){}};
 globalThis.chrome={runtime:{id:'browser-data-fixture',getManifest:()=>({version:'test'})},tabs:{onRemoved:event,onReplaced:event},webNavigation:{onCommitted:event},
  bookmarks:{
   async get(id){calls.push(['get',id]);return nodes.filter(node=>node.id===id);},
   async getTree(){calls.push(['getTree']);return [root];},async getChildren(id){calls.push(['getChildren',id]);return [...nodes];},
   async search(query){calls.push(['search',query]);return [...nodes].reverse();},
   async create(details){calls.push(['create',details]);if(failWrite)throw new Error('native failed after dispatch');return {...first,id:'new-native-id',...details};},
   async update(id,changes){calls.push(['update',id,changes]);return {...first,id,...changes};},
   async move(id,destination){calls.push(['move',id,destination]);return {...nodes[0],id,...destination};},
   async remove(id){calls.push(['remove',id]);},async removeTree(id){calls.push(['removeTree',id]);}
  },history:{
   async search(query){calls.push(['history.search',query]);return [{id:'h1',url:first.url,lastVisitTime:1000.5},{id:'h2',url:second.url,lastVisitTime:1000.5}].slice(0,query.maxResults);},
   async getVisits(details){calls.push(['getVisits',details]);return ['v2','v1'].map(visitId=>({id:'h1',visitId,referringVisitId:'0',isLocal:true,transition:'link',visitTime:1000.5}));},
   async addUrl(details){calls.push(['addUrl',details]);if(failWrite)throw new Error('native rejected');},
   async deleteUrl(details){calls.push(['deleteUrl',details]);},async deleteRange(details){calls.push(['deleteRange',details]);},
   async deleteAll(){calls.push(['deleteAll']);}
  }};
 try{
  const {parseCommand}=await import('../../out/extension/background/command-dispatcher.js');
  const {runBookmarks,runHistory}=await import('../../out/extension/background/browser-data-service.js');
  const {readArtifactBytes,releaseArtifact}=await import('../../out/extension/background/artifact-service.js');
  const parsed=(method,params={})=>parseCommand({method,schemaVersion:1,params});
  const run=async(method,params={})=>{const command=parsed(method,params);assert.ok(command,method);return method.startsWith('bookmarks.')?
   runBookmarks('owner',method,command.params,dispatch):runHistory('owner',method,command.params,dispatch);};
  await t.test('closed public params preserve omissions and fractional native timestamps',()=>{
   assert.deepEqual(parsed('bookmarks.list').params,{parentId:null,offset:0,limit:25});
   assert.equal(parsed('bookmarks.update',{bookmarkId:'10',changes:{}}),null);
   assert.equal(parsed('bookmarks.update',{bookmarkId:'10',changes:{title:'',hidden:true}}),null);
   assert.equal(parsed('bookmarks.update',{bookmarkId:'10',changes:{url:null}}),null);
   assert.equal(parsed('bookmarks.move',{bookmarkId:'10'}),null);
   assert.equal(parsed('history.search',{startTime:200,endTime:100}),null);
   assert.equal(parsed('history.search',{endTime:Infinity}),null);
   assert.equal(parsed('history.deleteAll',{confirm:true}),null);
   assert.ok(parsed('history.deleteRange',{startTime:1000.25,endTime:1000.75}));
   assert.ok(parsed('bookmarks.create',{url:"javascript:alert('hello world')"}));
   assert.ok(parsed('history.visits',{url:second.url}));
   assert.equal(parsed('bookmarks.get',{bookmarkId:'10'}).requiredPermission,'bookmarks.read');
   assert.equal(parsed('bookmarks.delete',{bookmarkId:'10'}).requiredPermission,'bookmarks.manage');
  });
  await t.test('root discovery omits descendants and pages explicitly report live mutation behavior',async()=>{
   const roots=await run('bookmarks.list');assert.deepEqual(roots.items.map(item=>item.bookmarkId),[root.id]);assert.equal('children' in roots.items[0],false);
   const page=await run('bookmarks.list',{parentId:root.id,limit:1});assert.equal(page.total,2);assert.equal(page.nextOffset,1);assert.equal(page.view,'live');
   nodes=[second];const next=await run('bookmarks.list',{parentId:root.id,offset:page.nextOffset,limit:1});assert.deepEqual(next.items,[]);assert.equal(next.total,1);assert.equal(next.nextOffset,null);
   nodes=[first,second];const found=await run('bookmarks.search',{query:'重复名称'});assert.deepEqual(found.items.map(item=>item.bookmarkId),['10','2']);
   assert.equal(found.items[1].url,second.url);assert.equal(found.items[0].title,found.items[1].title);
  });
  await t.test('mutations omit unspecified fields and never retry rejected or forbidden effects',async()=>{
   const created=await run('bookmarks.create',{title:'folder'});assert.equal(created.bookmark.bookmarkId,'new-native-id');assert.deepEqual(calls.at(-1),['create',{title:'folder'}]);
   await run('bookmarks.update',{bookmarkId:'10',changes:{title:''}});assert.deepEqual(calls.at(-1),['update','10',{title:''}]);
   await run('bookmarks.move',{bookmarkId:'10',index:0});assert.deepEqual(calls.at(-1),['move','10',{index:0}]);
   await run('bookmarks.delete',{bookmarkId:'10'});assert.deepEqual(calls.at(-1),['remove','10']);
   await run('bookmarks.delete',{bookmarkId:'folder',recursive:true});assert.deepEqual(calls.at(-1),['removeTree','folder']);
   denied=true;const before=calls.length;
   for(const method of ['bookmarks.get','bookmarks.delete'])await assert.rejects(run(method,{bookmarkId:'10'}),/authority lost/);
   assert.equal(calls.length,before);denied=false;failWrite=true;
   await assert.rejects(run('bookmarks.create'),error=>error.details.commandMayHaveRun&&error.details.observation.apiCompleted===false);
   assert.equal(calls.length,before+1);failWrite=false;
  });
  await t.test('large metadata stays complete in an owner Artifact without a second native read',async()=>{
   const large={...first,title:'原始字段'.repeat(10000)};nodes=[large];const before=calls.length;
   const result=await run('bookmarks.get',{bookmarkId:'10'});assert.equal(result.bookmark,null);assert.ok(result.artifact);assert.equal(calls.length,before+1);
   const saved=JSON.parse(new TextDecoder().decode((await readArtifactBytes('owner',result.artifact.artifactRef,500000)).bytes));
   assert.equal(saved.bookmark.title,large.title);assert.equal(saved.bookmark.bookmarkId,'10');
   await assert.rejects(readArtifactBytes('foreign',result.artifact.artifactRef,500000));
   await releaseArtifact('owner',result.artifact.artifactRef);
  });
  await t.test('a storage fault after native success retains the node identity and prohibits blind replay',async()=>{
   const transaction=IDBDatabase.prototype.transaction,before=calls.length;
   IDBDatabase.prototype.transaction=function(stores,...args){if(Array.from(typeof stores==='string'?[stores]:stores).includes('artifacts'))throw new DOMException('fixture storage unavailable','UnknownError');return transaction.call(this,stores,...args);};
   try{await assert.rejects(run('bookmarks.move',{bookmarkId:'10',index:0}),error=>
    error.details.reason==='BOOKMARK_RESULT_EXPORT_FAILED'&&error.details.commandMayHaveRun===true&&error.details.observation.bookmarkId==='10'&&error.details.observation.apiCompleted===true);
   }finally{IDBDatabase.prototype.transaction=transaction;}
   assert.equal(calls.length,before+1);nodes=[first,second];
  });
  await t.test('history distinguishes page summaries from visits, keeps ties and does not invent a time cursor',async()=>{
   const result=await run('history.search',{text:'a',startTime:1000.25,endTime:1000.75,maxResults:1});
   assert.deepEqual(calls.at(-1),['history.search',{text:'a',startTime:1000.25,endTime:1000.75,maxResults:1}]);
   assert.equal(result.atLimit,true);assert.equal(result.recordKind,'page_last_visit');assert.equal('nextCursor' in result,false);assert.equal(result.items[0].lastVisitTime,1000.5);
   const defaults=await run('history.search');assert.equal(defaults.endTime-defaults.startTime,86400000);
   const visits=await run('history.visits',{url:first.url,limit:1});assert.equal(visits.recordKind,'visit');assert.equal(visits.items[0].visitId,'v1');assert.equal(visits.total,2);
   const next=await run('history.visits',{url:first.url,offset:visits.nextOffset});assert.equal(next.items[0].visitId,'v2');assert.equal(next.items[0].visitTime,1000.5);
  });
  await t.test('history mutation scopes are exact and an uncertain add is sent only once',async()=>{
   await run('history.add',{url:second.url});assert.deepEqual(calls.at(-1),['addUrl',{url:second.url}]);
   await run('history.deleteUrl',{url:first.url});assert.deepEqual(calls.at(-1),['deleteUrl',{url:first.url}]);
   await run('history.deleteRange',{startTime:1000.25,endTime:1000.75});assert.deepEqual(calls.at(-1),['deleteRange',{startTime:1000.25,endTime:1000.75}]);
   await run('history.deleteAll');assert.deepEqual(calls.at(-1),['deleteAll']);
   failWrite=true;const before=calls.length;await assert.rejects(run('history.add',{url:first.url}),error=>error.details.commandMayHaveRun===true);
   assert.equal(calls.length,before+1);failWrite=false;denied=true;
   await assert.rejects(run('history.deleteAll'),/authority lost/);assert.equal(calls.length,before+1);
  });
 }finally{globalThis.chrome=original;}
});
