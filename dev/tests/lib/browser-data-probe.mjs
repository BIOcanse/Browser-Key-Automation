import assert from 'node:assert/strict';

// Called only by test-isolated's disposable Chromium profile.
export async function runBrowserDataProbe({call,baseUrl,observations}) {
 const title=`BKA-data-${Date.now()}`,firstUrl=new URL(`data-a?fixture=${title}`,baseUrl).href,secondUrl=new URL(`data-b?fixture=${title}`,baseUrl).href;
 let folderId;
 try{
  const roots=await call('bookmarks.list');assert.ok(roots.items.length>0);assert.equal(roots.view,'live');
  const nativeRoot=roots.items[0].bookmarkId;
  const rootChildren=await call('bookmarks.list',{parentId:nativeRoot});assert.ok(rootChildren.items.some(node=>node.folderType));
  const protectedResult=await call('bookmarks.delete',{bookmarkId:nativeRoot},'BROWSER_OPERATION_FAILED');
  assert.equal(protectedResult.details.observation.apiCompleted,false);
  folderId=(await call('bookmarks.create',{title})).bookmark.bookmarkId;
  const first=(await call('bookmarks.create',{parentId:folderId,title:'同名书签',url:firstUrl})).bookmark;
  const second=(await call('bookmarks.create',{parentId:folderId,title:'同名书签',url:secondUrl})).bookmark;
  assert.notEqual(first.bookmarkId,second.bookmarkId);assert.equal(first.title,second.title);
  const page=await call('bookmarks.list',{parentId:folderId,limit:1});assert.equal(page.total,2);assert.equal(page.nextOffset,1);
  const next=await call('bookmarks.list',{parentId:folderId,offset:page.nextOffset,limit:1});assert.equal(next.items[0].bookmarkId,second.bookmarkId);
  const updated=(await call('bookmarks.update',{bookmarkId:first.bookmarkId,changes:{title, url:`${firstUrl}&updated=1`}})).bookmark;
  assert.equal(updated.title,title);assert.equal(updated.url,`${firstUrl}&updated=1`);
  const moved=(await call('bookmarks.move',{bookmarkId:second.bookmarkId,index:0})).bookmark;assert.equal(moved.index,0);assert.equal(moved.parentId,folderId);
  assert.equal((await call('bookmarks.get',{bookmarkId:first.bookmarkId})).bookmark.url,updated.url);
  const matches=await call('bookmarks.search',{query:title});assert.ok(matches.items.some(item=>item.bookmarkId===first.bookmarkId));
  await call('bookmarks.delete',{bookmarkId:folderId},'BROWSER_OPERATION_FAILED');
  assert.equal((await call('bookmarks.list',{parentId:folderId})).total,2);
  await call('bookmarks.delete',{bookmarkId:second.bookmarkId});
  assert.equal((await call('bookmarks.list',{parentId:folderId})).total,1);
  await call('bookmarks.delete',{bookmarkId:folderId,recursive:true});folderId=null;
  const windowStart=Date.now()-1000;
  await call('history.add',{url:firstUrl});await call('history.add',{url:firstUrl});await call('history.add',{url:secondUrl});
  const history=await call('history.search',{text:title,startTime:windowStart,endTime:Date.now()+1000,maxResults:10});
  assert.equal(history.recordKind,'page_last_visit');assert.equal(history.items.length,2);
  assert.ok(history.items.some(item=>item.url===firstUrl&&item.visitCount>=2));
  assert.equal((await call('history.search',{text:title,startTime:windowStart,maxResults:1})).atLimit,true);
  const visits=await call('history.visits',{url:firstUrl,limit:1});assert.ok(visits.total>=2);assert.equal(visits.recordKind,'visit');
  const older=await call('history.visits',{url:firstUrl,offset:visits.nextOffset,limit:1});assert.notEqual(older.items[0].visitId,visits.items[0].visitId);
  await call('history.deleteUrl',{url:secondUrl});assert.equal((await call('history.visits',{url:secondUrl})).total,0);
  const last=visits.items[0].visitTime,prior=older.items[0].visitTime;
  assert.ok(last>prior,'Native repeated visits must have distinct recorded times');
  await call('history.deleteRange',{startTime:(last+prior)/2,endTime:last+1});
  const retained=await call('history.visits',{url:firstUrl});assert.ok(retained.items.some(item=>item.visitId===older.items[0].visitId));
  assert.equal(retained.items.some(item=>item.visitId===visits.items[0].visitId),false);
  await call('history.deleteAll');assert.equal((await call('history.search',{startTime:0,maxResults:100})).items.length,0);
  observations.push({evidence:'native bookmark duplicate identities, root protection, paging, update/move/delete and native history summary/visits/range/all operations',first,second,updated,moved,history,visits,retained});
 }finally{
  if(folderId)await call('bookmarks.delete',{bookmarkId:folderId,recursive:true}).catch(()=>{});
 }
}
