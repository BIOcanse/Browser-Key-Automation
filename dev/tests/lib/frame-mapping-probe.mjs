import assert from 'node:assert/strict';
import {pageEvaluate} from './cdp-client.mjs';

export async function runFrameMappingProbe({call,baseUrl,windowId,workerClient,observations}) {
 const fixtureUrl=new URL('search-fixture',baseUrl).href;
 const tab=(await call('tabs.create',{windowId,url:fixtureUrl,active:false})).tab;
 try{
  await call('page.wait',{tabRef:tab.tabRef,until:'complete'});
  const frames=(await call('frames.list',{tabRef:tab.tabRef})).items,nodes=[];
  for(const frame of frames)nodes.push({frameId:frame.frameId,documentRef:frame.documentRef,nodeRef:(await call('dom.query',{documentRef:frame.documentRef,selector:'body',limit:1})).items[0]?.nodeRef});
  const mapping=await pageEvaluate(workerClient,async url=>{
   const tabs=await chrome.tabs.query({});const found=tabs.filter(tab=>tab.url===url);if(found.length!==1)throw new Error('nonunique fixture');
   return chrome.scripting.executeScript({target:{tabId:found[0].id,allFrames:true},world:'ISOLATED',func:()=>{
    let parentAccess=null,frameElement=null,index=-1;
    try{frameElement=window.frameElement?{tag:window.frameElement.tagName,id:window.frameElement.id}:null;parentAccess=!!window.parent.document;}catch(error){parentAccess=String(error.name);}
    try{if(window.parent!==window)for(let i=0;i<Math.min(window.parent.length,128);i++)if(window.parent[i]===window){index=i;break;}}catch{}
    return {url:location.href,parentAccess,frameElement,parentIndex:index,hasRegistry:!!globalThis.__BKA_DOM_NODE_REGISTRY_V1__};
   }});
  },fixtureUrl);
  await call('debugger.attach',{tabRef:tab.tabRef});await call('debugger.send',{tabRef:tab.tabRef,method:'Runtime.enable'});
  const events=await call('debugger.events.get',{tabRef:tab.tabRef,limit:100});
  const contexts=events.items.filter(event=>event.method==='Runtime.executionContextCreated').map(event=>({sessionId:event.sessionId,...event.params.context}));
  const found=[];
  for(const context of contexts){
   const expression=`(()=>{const registry=globalThis.__BKA_DOM_NODE_REGISTRY_V1__;return {url:location.href,nodes:${JSON.stringify(nodes.map(node=>node.nodeRef))}.filter(node=>registry?.nodes?.has(node))};})()`;
   const result=await call('debugger.send',{tabRef:tab.tabRef,method:'Runtime.evaluate',params:{expression,contextId:context.id,returnByValue:true}});
   found.push({context,result:result.result});
  }
  const tree=await call('debugger.send',{tabRef:tab.tabRef,method:'Page.getFrameTree'});
  const targets=await pageEvaluate(workerClient,()=>chrome.debugger.getTargets());
  await call('debugger.send',{tabRef:tab.tabRef,method:'Target.setAutoAttach',params:{autoAttach:true,waitForDebuggerOnStart:false,flatten:true}});
  let attached=[];const deadline=Date.now()+3000;
  while(attached.length===0&&Date.now()<deadline){attached=(await call('debugger.events.get',{tabRef:tab.tabRef,limit:100})).items.filter(event=>event.method==='Target.attachedToTarget');if(attached.length===0)await new Promise(resolve=>setTimeout(resolve,20));}
  const children=[];
  for(const attachedEvent of attached){
   const sessionId=attachedEvent.params.sessionId;await call('debugger.send',{tabRef:tab.tabRef,sessionId,method:'Runtime.enable'});
   const childContexts=(await call('debugger.events.get',{tabRef:tab.tabRef,limit:100})).items.filter(event=>event.sessionId===sessionId&&event.method==='Runtime.executionContextCreated');
   for(const event of childContexts){const context=event.params.context;if(!context.origin.startsWith('chrome-extension://'))continue;
    const expression=`(()=>{const registry=globalThis.__BKA_DOM_NODE_REGISTRY_V1__;return {url:location.href,nodes:${JSON.stringify(nodes.map(node=>node.nodeRef))}.filter(node=>registry?.nodes?.has(node))};})()`;
    const result=await call('debugger.send',{tabRef:tab.tabRef,sessionId,method:'Runtime.evaluate',params:{expression,uniqueContextId:context.uniqueId,returnByValue:true}});
    const owner=await call('debugger.send',{tabRef:tab.tabRef,method:'DOM.getFrameOwner',params:{frameId:context.auxData.frameId}});
    children.push({sessionId,context,result,owner,targetInfo:attachedEvent.params.targetInfo});
   }
   await call('debugger.send',{tabRef:tab.tabRef,sessionId,method:'Runtime.disable'});
  }
  await call('debugger.send',{tabRef:tab.tabRef,method:'Target.setAutoAttach',params:{autoAttach:false,waitForDebuggerOnStart:false,flatten:true}});
  observations.push({evidence:'isolated frame mapping investigation; extension document identity and root CDP context coverage, no production mapping claim',nodes,mapping,found,tree,targets,children});
  assert.ok(mapping.length>=3);assert.ok(nodes.every(node=>node.nodeRef));
  assert.equal(children.length,1);assert.ok(children[0].result.result.result.value.nodes.length===1);assert.ok(children[0].owner.result.backendNodeId>0);
  await call('debugger.send',{tabRef:tab.tabRef,method:'Runtime.disable'});await call('debugger.detach',{tabRef:tab.tabRef});
 }finally{await call('debugger.detach',{tabRef:tab.tabRef}).catch(()=>{});await call('tabs.close',{tabRef:tab.tabRef}).catch(()=>{});}
}
