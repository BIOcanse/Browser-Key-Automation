import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import 'fake-indexeddb/auto';

test('tab search shares exact-document text, literal Unicode snippets and honest partial coverage',async t=>{
 const original={chrome:globalThis.chrome,document:globalThis.document,location:globalThis.location,setTimeout:globalThis.setTimeout};
 const event={addListener(){},removeListener(){}};const storage={},injections=[];
 const tabs=[1,2].map(id=>({id,index:id-1,windowId:1,active:id===1,highlighted:false,pinned:false,incognito:false,status:'complete',title:`Page ${id}`,url:`https://example.test/${id}`}));
 let denied=false,wrongReceipt=false,navigate=false,shortTimer=false,readHook=null;
 const frames=new Map(tabs.map(tab=>[tab.id,[{frameId:0,parentFrameId:-1,url:tab.url,documentId:`doc-${tab.id}`,documentLifecycle:'active'}]]));
 frames.get(1).push({frameId:3,parentFrameId:0,url:'https://frame.test',documentId:'child-1',documentLifecycle:'active'});
 const documents=new Map([['doc-1','😀 begin A+B 中文内容 END'],['doc-2','second a+b 中文内容'],['child-1','iframe 独有文本']]);
 globalThis.setTimeout=(callback,ms,...args)=>original.setTimeout(callback,shortTimer&&ms>1000?5:ms,...args);
 globalThis.chrome={runtime:{id:'tab-search-test',getManifest:()=>({version:'test'})},storage:{session:{async setAccessLevel(){},async get(key){return {[key]:storage[key]};},async set(items){Object.assign(storage,items);}}},
  tabs:{onRemoved:event,onReplaced:event,async query(){return tabs;},async get(id){const tab=tabs.find(item=>item.id===id);if(!tab)throw new Error('closed');return tab;}},
  permissions:{async contains(){return true;}},webNavigation:{onCommitted:event,async getAllFrames({tabId}){return structuredClone(frames.get(tabId));}},
  scripting:{async executeScript(injection){
   injections.push(injection.target);if(readHook)return readHook(injection);
   const frame=frames.get(injection.target.tabId).find(value=>value.documentId===injection.target.documentIds[0]);assert.ok(frame);
   globalThis.document={title:`Title ${frame.documentId}`,body:{innerText:documents.get(frame.documentId)}};globalThis.location={href:frame.url};
   const result=injection.func(...injection.args);
   if(navigate)frames.get(injection.target.tabId)[0]={...frame,documentId:'replacement-document'};
   return [{frameId:frame.frameId,documentId:wrongReceipt?'wrong-document':frame.documentId,result}];
  }}};
 try{
  const tabService=await import('../../out/extension/background/tab-service.js');tabService.initializeTabService();
  const tabRefs=(await tabService.listTabs({afterTabId:null,limit:10})).items.map(tab=>tab.tabRef);
  const {parseCommand}=await import('../../out/extension/background/command-dispatcher.js');
  const {searchTabs,keywordSnippet}=await import('../../out/extension/background/search/keyword-service.js');
  const {readDocumentSearchText}=await import('../../out/extension/background/search/sources.js');
  const {COMMAND_CATALOG}=await import('../../out/extension/generated/command-config.js');
  const parse=params=>parseCommand({method:'search.tabs',schemaVersion:1,params});
  const run=async params=>{const command=parse({tabRefs,query:'a+b',...params});assert.ok(command);return searchTabs('owner',command.params,async effect=>{if(denied)throw new Error('authority lost');return effect();});};
  await t.test('scope is explicit and regex syntax remains literal with original Unicode offsets',()=>{
   assert.equal(parse({query:'x'}),null);assert.equal(parse({tabRefs:[],query:'x'}),null);assert.equal(parse({tabRefs:[tabRefs[0],tabRefs[0]],query:'x'}),null);
   assert.equal(parse({tabRefs,query:'x',mode:'semantic'}),null);
   const snippet=keywordSnippet('😀 prefix A+B suffix','a+b',false,2);assert.equal(snippet.text.slice(snippet.matchStart,snippet.matchEnd),'A+B');assert.equal(snippet.sourceStart,10);
   assert.equal(keywordSnippet('abbbbb','a+b',false,3),null);assert.equal(keywordSnippet('İX a+b','A+B',false,20).sourceStart,3);
  });
  await t.test('each selected tab has its own verified document and content hash without frame opt-in',async()=>{
   const result=await run({});assert.equal(result.items.length,2);assert.equal(result.coverage.complete,true);assert.equal(result.coverage.readDocuments,2);
   assert.ok(injections.every(target=>target.documentIds?.length===1&&target.frameIds===undefined));
   assert.equal(result.items[0].sha256,createHash('sha256').update(documents.get('doc-1')).digest('hex'));
   assert.equal(result.items[0].documentId,'doc-1');assert.equal(result.items[0].hashScope,'captured_text');
   assert.equal((await run({caseSensitive:true})).matchingDocuments,1);
   const limited=await run({limit:1});assert.equal(limited.resultsTruncated,true);assert.equal(limited.matchingDocuments,2);assert.equal(limited.coverage.readDocuments,2);
  });
  await t.test('child-frame scope is explicit and inaccessible frames stay in coverage failures',async()=>{
   assert.equal((await run({query:'独有文本'})).items.length,0);
   const result=await run({query:'独有文本',includeFrames:true});assert.equal(result.items.length,1);assert.equal(result.items[0].frameId,3);
   frames.get(1)[1].errorOccurred=true;
   const failed=await run({query:'独有文本',includeFrames:true});assert.equal(failed.items.length,0);assert.equal(failed.coverage.complete,false);
   assert.ok(failed.coverage.failures.some(value=>value.frameId===3&&value.reason==='DOCUMENT_UNAVAILABLE'));delete frames.get(1)[1].errorOccurred;
  });
  await t.test('navigation and mismatched receipts never substitute a newer document',async()=>{
   wrongReceipt=true;const mismatch=await run({tabRefs:[tabRefs[0]]});wrongReceipt=false;
   assert.equal(mismatch.items.length,0);assert.equal(mismatch.coverage.failures[0].reason,'DOCUMENT_RECEIPT_MISMATCH');
   navigate=true;const changed=await run({tabRefs:[tabRefs[0]]});navigate=false;
   assert.equal(changed.items.length,0);assert.equal(changed.coverage.failures[0].reason,'DOCUMENT_CHANGED');frames.get(1)[0].documentId='doc-1';
  });
  await t.test('UTF-8 truncation never splits characters and absent matches disclose partial text',async()=>{
   globalThis.document={title:'标题',body:{innerText:'中😀x'}};globalThis.location={href:'https://example.test'};
   const bounded=readDocumentSearchText(7,100);assert.equal(bounded.text,'中😀');assert.equal(bounded.textBytes,7);assert.equal(bounded.textTruncated,true);
   const saved=documents.get('doc-1');documents.set('doc-1','x'.repeat(COMMAND_CATALOG.limits['command.search.maximum_source_bytes'])+'tail-marker');
   const result=await run({tabRefs:[tabRefs[0]],query:'tail-marker'});documents.set('doc-1',saved);
   assert.equal(result.items.length,0);assert.equal(result.coverage.complete,false);assert.equal(result.coverage.truncatedDocuments,1);
  });
  await t.test('deadline discards late read results and revoked authority cannot become partial success',async()=>{
   shortTimer=true;let finish;
   readHook=()=>new Promise(resolve=>{finish=resolve;});
   const result=await run({tabRefs:[tabRefs[0]]});assert.equal(result.coverage.complete,false);assert.equal(result.coverage.failures[0].reason,'SEARCH_DEADLINE');
   finish([{frameId:0,documentId:'doc-1',result:{text:'a+b'}}]);await new Promise(resolve=>original.setTimeout(resolve,1));assert.equal(result.items.length,0);
   readHook=null;shortTimer=false;denied=true;const before=injections.length;await assert.rejects(run({}),/authority lost/);assert.equal(injections.length,before);denied=false;
  });
  await t.test('the final content hash obeys the same deadline and its late result cannot complete coverage',async()=>{
   const digest=crypto.subtle.digest;let complete;shortTimer=true;
   crypto.subtle.digest=()=>new Promise(resolve=>{complete=resolve;});
   try{
    const result=await run({tabRefs:[tabRefs[0]]});assert.equal(result.items.length,0);assert.equal(result.coverage.complete,false);assert.equal(result.coverage.readDocuments,0);
    assert.equal(result.coverage.failures[0].frameId,0);assert.equal(result.coverage.failures[0].reason,'SEARCH_DEADLINE');
    complete(new ArrayBuffer(32));await new Promise(resolve=>original.setTimeout(resolve,1));assert.equal(result.coverage.readDocuments,0);
   }finally{crypto.subtle.digest=digest;shortTimer=false;}
  });
 }finally{globalThis.chrome=original.chrome;globalThis.document=original.document;globalThis.location=original.location;globalThis.setTimeout=original.setTimeout;}
});
