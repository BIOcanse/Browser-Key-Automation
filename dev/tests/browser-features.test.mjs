import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
const event=()=>{const listeners=new Set();return {addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn),fire:(...args)=>{for(const fn of listeners)fn(...args);},size:()=>listeners.size};};

test('protocol bytes accept large canonical bodies and reject malformed or oversized base64',async()=>{
 const {decodeProtocolBytes}=await import('../../out/extension/background/capture/cdp-service.js');
 const original=Buffer.alloc(1024*1024,231),encoded=original.toString('base64');
 assert.deepEqual(Buffer.from(decodeProtocolBytes(encoded,original.length)),original);
 for(const value of ['A===','AA=A','AB==','AA==\n','AA==AA=='])assert.throws(()=>decodeProtocolBytes(value,100),error=>error.details.reason==='INVALID_OR_OVERSIZED_PROTOCOL_BYTES');
 assert.throws(()=>decodeProtocolBytes(encoded,original.length-1));
});

test('download wait observes event/query races, returns terminal state, and removes listeners on timeout and denial',async()=>{
 const {runDownload,parseDownloadParams}=await import('../../out/extension/background/downloads-service.js');
 const onChanged=event();let denied=false,state='in_progress',searches=0;
 const item=()=>({id:1,url:'https://example.test/file',finalUrl:'https://example.test/file',filename:'isolated/file',mime:'application/octet-stream',state,paused:false,canResume:false,danger:'safe',bytesReceived:1,totalBytes:2,fileSize:2,exists:true,startTime:new Date().toISOString()});
 const original=globalThis.chrome;globalThis.chrome={downloads:{onChanged,async search(){searches++;return [item()];}}};
 const dispatch=effect=>{if(denied)throw new Error('denied');return effect();};
 try{
  assert.equal(parseDownloadParams('downloads.start',{url:'https://example.test',filename:'a/../b',conflictAction:'uniquify'}),false);
  assert.equal(parseDownloadParams('downloads.start',{url:'https://example.test',filename:'C:\\target',conflictAction:'uniquify'}),false);
  const result=await runDownload('downloads.wait',{downloadId:1,timeoutMs:10},dispatch);assert.equal(result.status,'timeout');assert.equal(searches,1);assert.equal(onChanged.size(),0);
  const wait=runDownload('downloads.wait',{downloadId:1,timeoutMs:1000},dispatch);state='complete';onChanged.fire({id:1});assert.equal((await wait).status,'complete');assert.equal(onChanged.size(),0);
  denied=true;await assert.rejects(runDownload('downloads.wait',{downloadId:1,timeoutMs:1000},dispatch),/denied/);assert.equal(onChanged.size(),0);
 }finally{globalThis.chrome=original;}
});

test('download effects retain the known receipt when their post-operation metadata query fails',async()=>{
 const {runDownload}=await import('../../out/extension/background/downloads-service.js');
 const original=globalThis.chrome,calls=[];
 globalThis.chrome={downloads:{async download(){calls.push('start');return 7;},async pause(id){calls.push(['pause',id]);},async resume(id){calls.push(['resume',id]);},async cancel(id){calls.push(['cancel',id]);},async search(){return [];}}};
 try{
  for(const operation of ['start','pause','resume','cancel']){
   await assert.rejects(runDownload(`downloads.${operation}`,{downloadId:7,url:'https://example.test',filename:'test.bin',conflictAction:'uniquify'},effect=>effect()),error=>
    error.details.reason==='DOWNLOAD_NOT_FOUND'&&error.details.commandMayHaveRun===true&&error.details.observation.downloadId===7&&error.details.observation.apiCompleted===true);
  }
  assert.deepEqual(calls,['start',['pause',7],['resume',7],['cancel',7]],'A missing query result never repeats the effect');
 }finally{globalThis.chrome=original;}
});

test('download timeout wake before its monotonic deadline waits again without another query',async()=>{
 const {runDownload}=await import('../../out/extension/background/downloads-service.js');
 const original={chrome:globalThis.chrome,performance:globalThis.performance,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout};
 const onChanged=event(),timers=new Map();let now=0,timerId=0,searches=0,settled=false;
 globalThis.performance={now:()=>now};
 globalThis.setTimeout=(callback,delay)=>{const id=++timerId;timers.set(id,{callback,delay});return id;};
 globalThis.clearTimeout=id=>timers.delete(id);
 globalThis.chrome={downloads:{onChanged,async search(){searches++;return [{id:1,state:'in_progress'}];}}};
 const flush=()=>new Promise(resolve=>setImmediate(resolve));
 const wake=()=>{assert.equal(timers.size,1);const [id,timer]=timers.entries().next().value;timers.delete(id);timer.callback();};
 try{
  const wait=runDownload('downloads.wait',{downloadId:1,timeoutMs:10},effect=>effect()).then(result=>{settled=true;return result;});
  await flush();assert.equal(searches,1);assert.equal(timers.size,1);
  now=9.75;wake();await flush();
  assert.equal(searches,1,'An early timer wake is not a download change');assert.equal(settled,false);assert.equal(timers.size,1);
  now=10;wake();assert.equal((await wait).status,'timeout');assert.equal(searches,1);assert.equal(onChanged.size(),0);assert.equal(timers.size,0);
 }finally{globalThis.chrome=original.chrome;globalThis.performance=original.performance;globalThis.setTimeout=original.setTimeout;globalThis.clearTimeout=original.clearTimeout;}
});

test('managed debugger domains survive authority loss for cleanup, preserve original request bodies and gate stale dialogs at send time',async()=>{
 const {COMMAND_CATALOG}=await import('../../out/extension/generated/command-config.js');let shortNetworkTimeout=false;
 const setTimer=globalThis.setTimeout;globalThis.setTimeout=(callback,ms,...args)=>{const effective=shortNetworkTimeout&&[COMMAND_CATALOG.limits['command.network.body_timeout_ms'],COMMAND_CATALOG.limits['command.network.cleanup_timeout_ms']].includes(ms)?10:ms;const handle=setTimer(callback,effective,...args);if(ms>=10000)handle.unref();return handle;};
 const original=globalThis.chrome,onEvent=event(),onDetach=event(),onRemoved=event(),onReplaced=event(),storage={},calls=[];
 const tab={id:1,index:0,windowId:1,active:true,highlighted:false,pinned:false,incognito:false,status:'complete',title:'Fixture',url:'https://example.test'};
 let sendHook=async()=>({}),gateHook=async()=>{},authorized=true;
 globalThis.chrome={runtime:{id:'test-extension',getManifest:()=>({version:'test'})},storage:{session:{async setAccessLevel(){},async get(key){return {[key]:storage[key]};},async set(items){Object.assign(storage,items);}}},
  tabs:{onRemoved,onReplaced,async query(){return [tab];},async get(){return tab;}},debugger:{onEvent,onDetach,async attach(){},async detach(){onDetach.fire({tabId:1},'detached');},async sendCommand(target,method,params){calls.push({target,method,params});return sendHook(method,params);}}};
 const tabs=await import('../../out/extension/background/tab-service.js'),debug=await import('../../out/extension/background/debugger-service.js');
 const network=await import('../../out/extension/background/network-service.js'),dialogs=await import('../../out/extension/background/dialogs-service.js');
 const artifacts=await import('../../out/extension/background/artifact-service.js');
 const dispatch=async effect=>{await gateHook();if(!authorized)throw new Error('authority lost');return effect();};
 const owner={keyId:'owner',keyKind:'root',enabled:true,status:'active',expiresAt:null,permissions:[]};
 try{
  tabs.initializeTabService();const tabRef=(await tabs.listTabs({afterTabId:null,limit:10})).items[0].tabRef;await debug.attachDebugger(tabRef,dispatch);
  for(const sessionId of ['child-a','child-b'])await debug.sendDebuggerProtocol({tabRef,method:'Network.enable',params:{},sessionId},dispatch);
  await debug.sendDebuggerProtocol({tabRef,method:'Network.disable',params:{},sessionId:'child-a'},dispatch);
  await assert.rejects(network.startNetwork(owner,{tabRef,captureBodies:false,durationMs:100000},dispatch),error=>error.details.reason==='DOMAIN_IN_USE');
  await debug.sendDebuggerProtocol({tabRef,method:'Network.disable',params:{},sessionId:'child-b'},dispatch);
  const captureId=(await network.startNetwork(owner,{tabRef,captureBodies:true,durationMs:100000},dispatch)).capture.captureId;
  await assert.rejects(debug.sendDebuggerProtocol({tabRef,method:'Network.disable',params:{}},dispatch),e=>e.details.reason==='DOMAIN_IN_USE');
  const fire=(method,params)=>onEvent.fire({tabId:1},`Network.${method}`,params);
  sendHook=async method=>method==='Network.getResponseBody'?{body:'AAEC/w==',base64Encoded:true}:{};
  fire('requestWillBeSent',{requestId:'r1',timestamp:2,wallTime:100,request:{url:'https://example.test/a',method:'GET',headers:{}}});
  fire('requestWillBeSent',{requestId:'r1',timestamp:3,wallTime:101,request:{url:'https://example.test/b',method:'GET',headers:{}},redirectResponse:{status:302,statusText:'Found',headers:{location:'/b'}}});
  fire('responseReceived',{requestId:'r1',response:{status:200,statusText:'OK',headers:{},mimeType:'application/octet-stream'}});
  fire('loadingFinished',{requestId:'r1',timestamp:4,encodedDataLength:4});
  await network.runNetwork('owner','network.stop',{captureId});
  const read=await network.runNetwork('owner','network.read',{captureId,afterRequestId:0,limit:10});assert.equal(read.capture.state,'stopped');assert.equal(read.items[0].state,'redirected');assert.equal(read.items[1].redirectFrom,1);assert.equal(read.items[1].bodyStatus,'captured');
  const bytes=await artifacts.readArtifactBytes('owner',read.items[1].body.artifactRef,100);assert.deepEqual([...bytes.bytes],[0,1,2,255]);
  await assert.rejects(network.runNetwork('foreign','network.read',{captureId,afterRequestId:0,limit:10}),e=>e.details.reason==='CAPTURE_NOT_FOUND');
  const deniedCapture=(await network.startNetwork(owner,{tabRef,captureBodies:false,durationMs:100000},dispatch)).capture.captureId;
  authorized=false;assert.equal((await network.runNetwork('owner','network.stop',{captureId:deniedCapture})).capture.state,'stopped');authorized=true;
  shortNetworkTimeout=true;let lateBody;
  sendHook=async method=>method==='Network.getResponseBody'?new Promise(resolve=>{lateBody=resolve;}):{};
  const delayedCapture=(await network.startNetwork(owner,{tabRef,captureBodies:true,durationMs:100000},dispatch)).capture.captureId;
  fire('requestWillBeSent',{requestId:'late-body',timestamp:2,wallTime:100,request:{url:'https://example.test/late',method:'GET',headers:{}}});
  fire('loadingFinished',{requestId:'late-body',timestamp:3,encodedDataLength:4});
  const stoppedLate=await network.runNetwork('owner','network.stop',{captureId:delayedCapture});assert.equal(stoppedLate.capture.state,'stopped');assert.equal(stoppedLate.capture.pendingBodies,0);
  let delayedRead=await network.runNetwork('owner','network.get',{captureId:delayedCapture,requestId:1});assert.equal(delayedRead.request.bodyStatus,'timed_out');assert.equal(delayedRead.request.body,null);
  lateBody({body:'AAEC/w==',base64Encoded:true});await new Promise(resolve=>setTimeout(resolve,1));
  delayedRead=await network.runNetwork('owner','network.get',{captureId:delayedCapture,requestId:1});assert.equal(delayedRead.request.bodyStatus,'timed_out');assert.equal(delayedRead.request.body,null);
  let completeCleanup;sendHook=async method=>method==='Network.disable'?new Promise(resolve=>{completeCleanup=resolve;}):{};
  const cleanupCapture=(await network.startNetwork(owner,{tabRef,captureBodies:false,durationMs:100000},dispatch)).capture.captureId;
  assert.equal((await network.runNetwork('owner','network.stop',{captureId:cleanupCapture})).capture.state,'cleanup_failed');
  const disables=calls.filter(call=>call.method==='Network.disable').length;
  assert.equal((await network.runNetwork('owner','network.stop',{captureId:cleanupCapture})).capture.state,'cleanup_failed');
  assert.equal(calls.filter(call=>call.method==='Network.disable').length,disables,'An unresolved cleanup is observed, not resent');
  await assert.rejects(debug.sendDebuggerProtocol({tabRef,method:'Network.enable',params:{}},dispatch),error=>error.details.reason==='DOMAIN_IN_USE');
  completeCleanup({});assert.equal((await network.runNetwork('owner','network.stop',{captureId:cleanupCapture})).capture.state,'stopped');
  sendHook=async()=>({});shortNetworkTimeout=false;
  const watchId=(await dialogs.startDialogs(owner,{tabRef,durationMs:100000,policy:null},dispatch)).watch.watchId;
  const opening=message=>onEvent.fire({tabId:1},'Page.javascriptDialogOpening',{type:'confirm',message,url:'https://example.test',hasBrowserHandler:true});
  opening('old');const old=(await dialogs.runDialogs('owner','dialogs.get',{watchId})).watch.dialog.dialogId;
  let release;gateHook=()=>new Promise(resolve=>{release=resolve;});
  const answering=dialogs.runDialogs('owner','dialogs.respond',{watchId,dialogId:old,accept:true,promptText:null});
  for(let i=0;i<50&&!release;i++)await new Promise(resolve=>setTimeout(resolve,1));assert.ok(release);
  onEvent.fire({tabId:1},'Page.javascriptDialogClosed',{});opening('new');release();gateHook=async()=>{};
  await assert.rejects(answering,e=>e.details.reason==='DIALOG_STALE');assert.equal(calls.filter(c=>c.method==='Page.handleJavaScriptDialog').length,0);
  const current=(await dialogs.runDialogs('owner','dialogs.get',{watchId})).watch.dialog;assert.equal(current.message,'new');
  await dialogs.runDialogs('owner','dialogs.respond',{watchId,dialogId:current.dialogId,accept:false,promptText:null});assert.equal(calls.filter(c=>c.method==='Page.handleJavaScriptDialog').length,1);
  await dialogs.runDialogs('owner','dialogs.setPolicy',{watchId,policy:{type:'confirm',message:'second',accept:true,promptText:null}});
  opening('first');const first=(await dialogs.runDialogs('owner','dialogs.get',{watchId})).watch.dialog.dialogId;
  let dialogSends=0;sendHook=async method=>{if(method==='Page.handleJavaScriptDialog'&&++dialogSends===1){onEvent.fire({tabId:1},'Page.javascriptDialogClosed',{});opening('second');}return {};};
  await dialogs.runDialogs('owner','dialogs.respond',{watchId,dialogId:first,accept:false,promptText:null});
  for(let i=0;i<50&&dialogSends<2;i++)await new Promise(resolve=>setTimeout(resolve,1));assert.equal(dialogSends,2);
  assert.equal((await dialogs.runDialogs('owner','dialogs.get',{watchId})).watch.policy,null,'Policy is consumed for the newly opened dialog');
  sendHook=async()=>({});
  authorized=false;await dialogs.runDialogs('owner','dialogs.stop',{watchId});authorized=true;
  const intercept=await import('../../out/extension/background/network-intercept-service.js');
  const interceptId=(await intercept.startIntercept(owner,{tabRef,durationMs:100000,requestTimeoutMs:5000,rules:[{urlPattern:'https://example.test/*',stage:'request',action:{kind:'fulfill',status:200,headers:[],artifactRef:read.items[1].body.artifactRef}}]},dispatch)).intercept.interceptId;
  await artifacts.releaseArtifact('owner',read.items[1].body.artifactRef);
  onEvent.fire({tabId:1},'Fetch.requestPaused',{requestId:'fetch-1',request:{url:'https://example.test/file'}});
  for(let i=0;i<50&&!calls.some(call=>call.method==='Fetch.fulfillRequest');i++)await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal(calls.find(call=>call.method==='Fetch.fulfillRequest').params.body,'AAEC/w==','Rule retains validated original bytes after Artifact release');
  let blocked;gateHook=()=>new Promise(resolve=>{blocked=resolve;});
  onEvent.fire({tabId:1},'Fetch.requestPaused',{requestId:'fetch-2',request:{url:'https://example.test/file'}});
  for(let i=0;i<50&&!blocked;i++)await new Promise(resolve=>setTimeout(resolve,1));assert.ok(blocked);
  await intercept.runIntercept('owner','network.intercept.stop',{interceptId});blocked();gateHook=async()=>{};
  await new Promise(resolve=>setTimeout(resolve,1));assert.equal(calls.filter(call=>call.method==='Fetch.fulfillRequest').length,1,'Stopped in-flight policy cannot dispatch a late replacement');
  await debug.detachDebugger(tabRef,dispatch);
 }finally{globalThis.chrome=original;globalThis.setTimeout=setTimer;}
});
