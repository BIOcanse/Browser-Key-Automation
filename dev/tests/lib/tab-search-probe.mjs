import assert from 'node:assert/strict';

export async function runTabSearchProbe({call,baseUrl,windowId,activeTabRef,observations}) {
 const created=[];
 try{
  const firstUrl=new URL('search-fixture',baseUrl),secondUrl=new URL(firstUrl);secondUrl.hostname='localhost';
  for(const url of [firstUrl,secondUrl]){
   const tab=(await call('tabs.create',{windowId,url:url.href,active:false})).tab;created.push(tab.tabRef);
   await call('page.wait',{tabRef:tab.tabRef,until:'complete'});
  }
  const before=(await call('tabs.get',{tabRef:activeTabRef})).tab.active;
  const main=await call('search.tabs',{tabRefs:created,query:'search fixture 中文 a+b'});
  assert.equal(main.items.length,2);assert.equal(main.coverage.complete,true);assert.ok(main.items.every(item=>item.frameId===0));
  for(const item of main.items){assert.match(item.sha256,/^[a-f0-9]{64}$/u);assert.equal(item.snippet.text.slice(item.snippet.matchStart,item.snippet.matchEnd),'Search fixture 中文 A+B');}
  assert.equal((await call('search.tabs',{tabRefs:created,query:'srcdoc 独有正文'})).matchingDocuments,0);
  const srcdoc=await call('search.tabs',{tabRefs:created,query:'srcdoc 独有正文',includeFrames:true});
  assert.equal(srcdoc.items.length,2);assert.equal(srcdoc.coverage.complete,true);assert.ok(srcdoc.items.every(item=>item.frameId!==0));
  const cross=await call('search.tabs',{tabRefs:created,query:'跨域 frame 专属词',includeFrames:true});
  assert.equal(cross.items.length,2);assert.equal(cross.coverage.complete,true);assert.ok(cross.items.every(item=>item.frameId!==0));
  assert.notEqual(new URL(cross.items[0].url).hostname,new URL(main.items[0].url).hostname);
  const sensitive=await call('search.tabs',{tabRefs:created,query:'search fixture',caseSensitive:true});assert.equal(sensitive.matchingDocuments,0);
  const limited=await call('search.tabs',{tabRefs:created,query:'Search fixture',limit:1});assert.equal(limited.items.length,1);assert.equal(limited.matchingDocuments,2);assert.equal(limited.resultsTruncated,true);
  assert.equal((await call('tabs.get',{tabRef:activeTabRef})).tab.active,before);
  for(const tabRef of created)assert.equal((await call('tabs.get',{tabRef})).tab.active,false);
  observations.push({evidence:'two inactive tabs, exact phrase and original snippets, srcdoc and cross-origin frame text without activation',main,srcdoc,cross});
 }finally{for(const tabRef of created)await call('tabs.close',{tabRef}).catch(()=>{});}
}
