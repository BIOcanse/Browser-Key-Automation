import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CdpClient, runtimeEvaluate } from '../../lib/cdp-client.mjs';

assert.equal(process.platform, 'win32', 'This experiment measures Windows APIs only');
assert.ok(process.argv.includes('--execute'), 'Explicit --execute is required: this experiment changes test-window focus and sends system input');
const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '../../..');
const chromeFixture = process.argv.includes('--chrome-fixture');
const useFixture = process.argv.includes('--fixture') || chromeFixture;
const useChromium = useFixture && !chromeFixture;
const quick = process.argv.includes('--quick');
const stagesOnly = process.argv.includes('--stages-only');
const apiOnly = process.argv.includes('--api-only');
const externalPost = process.argv.includes('--external-post');
assert.ok(!apiOnly || useFixture,'--api-only requires an isolated fixture extension');
assert.ok(!externalPost || apiOnly,'--external-post is a small supplement to --api-only');
const executable = useChromium
  ? 'D:/Code/CommonAssets/Tools/PlaywrightBrowsers/chromium-1228/chrome-win64/chrome.exe'
  : 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const artifactParent = path.join(workspace, 'out/test-artifacts');
await mkdir(artifactParent, { recursive: true });
const root = await mkdtemp(path.join(artifactParent, useChromium ? 'native-input-chromium-' : 'native-input-chrome-'));
const profile = path.join(root, 'profile');
await mkdir(profile);
const html = await readFile(path.join(here, 'page.html'));
const environment = { ...process.env };
delete environment.BKA_API_KEY;
const observedEvents = [];
const cases = [];
let currentNativeCase = 'setup';
const evidence = { startedAt: new Date().toISOString(), root, executable, useFixture, chromeFixture, quick, stagesOnly, apiOnly, externalPost,
  scope: 'fresh empty browser profile; no personal relay, user Key or external page',
  observation: 'CDP Runtime.evaluate prepares/reads local fixture; page sessions close before native inputs; no CDP Input methods used',
  observationWaitMs: 600, cases, setups: [], sourceHashes: {}, errors: [] };
for (const file of ['run.mjs','page.html','NativeProbe.cs','probe.ps1','message-input.mjs',...(useFixture?['extension/manifest.json','extension/worker.js']:[])]) {
  evidence.sourceHashes[file] = createHash('sha256').update(await readFile(path.join(here,file))).digest('hex');
}
const server = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/events') {
    let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 32768) break; }
    try { observedEvents.push({ receivedAt: Date.now(), nativeCase: currentNativeCase, event: JSON.parse(body) }); }
    catch { evidence.errors.push({ phase:'event-body', bodyLength:body.length }); }
    response.writeHead(204); response.end(); return;
  }
  if (request.url?.startsWith('/page.html')) { response.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); response.end(html); return; }
  response.writeHead(404); response.end();
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const port = server.address().port;
assert.notEqual(port,32189);
const base = `http://127.0.0.1:${port}`;
let child, browser, native, fixture;
let target, cover, spare, windowA, windowB;
let browserStderr = '';
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
async function save() {
  await writeFile(path.join(root,'results.json'),JSON.stringify(evidence,null,2)+'\n');
  await writeFile(path.join(root,'page-events.json'),JSON.stringify(observedEvents,null,2)+'\n');
}
async function until(probe, predicate, timeout=10000) {
  const deadline = performance.now()+timeout; let value, lastError;
  while(performance.now()<deadline) {
    try { value=await probe(); if(predicate(value)) return value; } catch(error) { lastError=String(error); }
    await pause(70);
  }
  throw new Error(`Bounded experiment wait failed: ${lastError||JSON.stringify(value)}`);
}
async function page(targetInfo, expression) {
  const client=await CdpClient.connect(targetInfo.webSocketDebuggerUrl);
  try { return await runtimeEvaluate(client,expression); } finally { client.close(); }
}
async function pageSnapshot(info) { return page(info,'globalThis.__nativeProbe.snapshot()'); }
async function pageReset(info,id,options={}) { return page(info,`globalThis.__nativeProbe.reset(${JSON.stringify(id)},${JSON.stringify(options)})`); }
async function targets() { return (await fetch(`http://127.0.0.1:${evidence.debugPort}/json/list`)).json(); }
function topFor(snapshot,pageId) {
  const values=snapshot.windows.filter(w=>snapshot.topOrder.includes(w.hwnd) && w.className==='Chrome_WidgetWin_1' && w.title.includes(`BKA Native Probe ${pageId}`));
  assert.equal(values.length,1,`Expected one isolated top window for ${pageId}`); return values[0];
}
function contentFor(snapshot,top,dom) {
  const values=snapshot.windows.filter(w=>w.root===top.hwnd && w.className==='Chrome_RenderWidgetHostHWND' && w.visible && w.clientRect.width>100 && w.clientRect.height>100);
  assert.equal(values.length,1,`Expected one current render HWND for ${top.title}: ${JSON.stringify(values)}`);
  const value=values[0];
  const sx=value.clientRect.width/dom.innerWidth, sy=value.clientRect.height/dom.innerHeight;
  assert.ok(Math.abs(sx-sy)<0.035,`Content viewport unit mismatch: ${sx},${sy}`);
  return value;
}
function point(dom,content) {
  const css={x:dom.rect.x+dom.rect.width/2,y:dom.rect.y+dom.rect.height/2};
  const client={x:Math.round(css.x*content.clientRect.width/dom.innerWidth),y:Math.round(css.y*content.clientRect.height/dom.innerHeight)};
  return {css,client,screen:{x:content.clientOrigin.x+client.x,y:content.clientOrigin.y+client.y}};
}
async function prepare(state, id, options={}) {
  currentNativeCase=`${id}:prepare`;
  await browser.send('Target.activateTarget',{targetId:target.id});
  await native.call('show',{hwnd:windowA.hwnd,command:9});
  await native.call('show',{hwnd:windowB.hwnd,command:9});
  const screen=(await native.call('snapshot')).desktop;
  const availableWidth=screen.primaryWidth, availableHeight=screen.primaryHeight;
  const width=Math.min(900,Math.floor(availableWidth*0.47));
  const height=Math.min(760,availableHeight-120);
  await native.call('position',{hwnd:windowA.hwnd,x:30,y:50,width,height});
  await native.call('position',{hwnd:windowB.hwnd,x:Math.max(30,availableWidth-width-30),y:50,width,height});
  await pageReset(target,id,options);
  await pageReset(cover,id);
  await pageReset(spare,id);
  await browser.send('Target.activateTarget',{targetId:target.id});
  const activation=await native.call('foreground',{hwnd:windowA.hwnd});
  let normalNative,normalDom,normalContent;
  try {
    await until(async()=>{
      normalNative=await native.call('snapshot');
      normalDom=await pageSnapshot(target);
      if(normalNative.foreground.hwnd!==windowA.hwnd)return false;
      normalContent=contentFor(normalNative,windowA,normalDom);return true;
    },Boolean,2500);
  } catch(error) {
    evidence.errors.push({phase:'prepare-foreground',id,activation,native:normalNative,page:normalDom,error:String(error)});
    throw new Error(`Preparation did not establish a foreground, visible renderer: ${id}; requested=${windowA.hwnd}, actual=${normalNative?.foreground?.hwnd}, SetForegroundWindow.ok=${activation.ok}`);
  }
  if(state==='background' || state==='covered' || state==='minimized' || state==='inactive-tab') {
    if(state==='covered') await native.call('position',{hwnd:windowB.hwnd,x:30,y:50,width,height});
    if(state==='inactive-tab') await browser.send('Target.activateTarget',{targetId:spare.id});
    if(state==='minimized') await native.call('show',{hwnd:windowA.hwnd,command:6});
    await browser.send('Target.activateTarget',{targetId:cover.id});
    await native.call('foreground',{hwnd:windowB.hwnd});
  }
  await pause(state==='covered'||state==='minimized'?500:150);
  const dom=await pageSnapshot(target);
  // For hidden/unselected documents, keep the exact previously observed renderer
  // HWND; re-observe it, never quietly substitute the currently active tab.
  const content=await native.call('one',{hwnd:normalContent.hwnd});
  const before=await native.call('snapshot');
  const expectedForeground=state==='foreground'?windowA.hwnd:windowB.hwnd;
  assert.equal(before.foreground.hwnd,expectedForeground,'Requested foreground condition did not hold');
  if(state==='minimized') assert.equal(before.windows.find(w=>w.hwnd===windowA.hwnd).iconic,true);
  currentNativeCase=id;
  return {state,dom,content,normalDom,normalContent,normalNative,before,point:point(normalDom,normalContent)};
}
async function existingPost(hwnd,x,y) {
  const payload=Buffer.from(JSON.stringify({hwnd,backend:'window_message',method:'click',params:{space:'client',x,y,button:'left',clickCount:1}})).toString('base64');
  return new Promise((resolve,reject)=>{
    const processChild=spawn(process.execPath,['D:/Code/app debuger for windows/node_modules/tsx/dist/cli.mjs',path.join(here,'message-input.mjs'),payload],
      {cwd:'D:/Code/app debuger for windows',env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr=''; processChild.stdout.on('data',x=>stdout+=x);processChild.stderr.on('data',x=>stderr+=x);
    const timer=setTimeout(()=>{processChild.kill();reject(new Error('Existing PostMessage asset timed out'));},12000);
    processChild.on('error',error=>{clearTimeout(timer);reject(error);});
    processChild.on('exit',code=>{clearTimeout(timer);if(code!==0) reject(new Error(`PostMessage asset exit ${code}: ${stderr}`)); else {try{resolve(JSON.parse(stdout.trim()));}catch{reject(new Error(`Invalid asset output ${stdout} ${stderr}`));}}});
  });
}
async function inputCase(state,backend,addressing,repeat,options={}) {
  const id=`${state}-${backend}-${addressing}-${repeat}${options.overlay?'-dom-overlay':''}${options.disabled?'-disabled':''}`;
  const record={id,state,backend,addressing,repeat,options,startedAt:Date.now()}; cases.push(record);
  try {
    const prepared=await prepare(state,id,options);
    Object.assign(record,{before:prepared.before,pageBefore:prepared.dom,content:prepared.content,coordinateReference:prepared.normalContent,point:prepared.point});
    const targetTop=record.before.windows.find(w=>w.hwnd===windowA.hwnd);
    const coordinateTop=state==='minimized'?prepared.normalNative.windows.find(w=>w.hwnd===windowA.hwnd):targetTop;
    const hwnd=addressing==='top'?windowA.hwnd:prepared.content.hwnd;
    const clientPoint=addressing==='top'
      ? {x:prepared.point.screen.x-coordinateTop.clientOrigin.x,y:prepared.point.screen.y-coordinateTop.clientOrigin.y}
      : prepared.point.client;
    record.inputTarget={hwnd,clientPoint,coordinateBasis:state==='minimized'?'last-observed-normal-client':'current-client'};
    // Drain setup focus events, then leave the page sessions detached during input.
    await native.call('snapshot');
    record.dispatchAt=Date.now();
    if(backend==='post') record.api=await existingPost(hwnd,clientPoint.x,clientPoint.y);
    else if(backend==='send-timeout') record.api=await native.call('send_timeout',{hwnd,...clientPoint});
    else if(backend==='send-input') record.api=await native.call('send_input',{...prepared.point.screen,expectedRoot:state==='covered'?windowB.hwnd:windowA.hwnd});
    else if(backend==='dom') record.api=await page(target,"document.querySelector('#button').click(); ({invoked:true})");
    else throw new Error('Unknown experiment backend');
    await pause(evidence.observationWaitMs);
    record.after=await native.call('snapshot');
    // Snapshot only after observing the native condition, so Runtime.evaluate
    // cannot be mistaken for the source of focus before/after a native click.
    record.pageAfter=await pageSnapshot(target);
    record.coverAfter=await pageSnapshot(cover);
    record.spareAfter=await pageSnapshot(spare);
    record.observed={trustedDelta:record.pageAfter.trusted-record.pageBefore.trusted,untrustedDelta:record.pageAfter.untrusted-record.pageBefore.untrusted,
      foregroundChanged:record.before.foreground.hwnd!==record.after.foreground.hwnd,
      cursorChanged:JSON.stringify(record.before.cursor)!==JSON.stringify(record.after.cursor),
      geometryChanged:JSON.stringify(targetTop.windowRect)!==JSON.stringify(record.after.windows.find(w=>w.hwnd===windowA.hwnd)?.windowRect),
      foregroundEvents:record.after.nativeEvents.filter(e=>e.ev===3),
      clickEvents:record.pageAfter.events.filter(e=>e.type==='click'),
      eventTypes:record.pageAfter.events.filter(e=>e.at>=record.dispatchAt).map(e=>e.type),
      otherPageClicks:[...record.coverAfter.events,...record.spareAfter.events].filter(e=>e.type==='click'&&e.at>=record.dispatchAt)};
    record.completed=true;
    console.log(JSON.stringify({case:id,...record.observed}));
  } catch(error) { record.error=String(error); record.completed=false; console.log(JSON.stringify({case:id,error:record.error})); }
  record.finishedAt=Date.now(); await save();
}
async function stagedCase(state,addressing,noActivate=false){
  const id=`staged-${state}-${addressing}${noActivate?'-no-activate-style':''}`;
  const record={id,state,addressing,noActivate,stages:[],startedAt:Date.now()};evidence.setups.push(record);
  let downSent=false,prepared,hwnd,clientPoint;
  try{
    prepared=await prepare(state,id);
    record.before=prepared.before;record.pageBefore=prepared.dom;record.point=prepared.point;
    const top=prepared.before.windows.find(w=>w.hwnd===windowA.hwnd);
    hwnd=addressing==='top'?windowA.hwnd:prepared.content.hwnd;
    clientPoint=addressing==='top'?{x:prepared.point.screen.x-top.clientOrigin.x,y:prepared.point.screen.y-top.clientOrigin.y}:prepared.point.client;
    if(noActivate){record.styleChange=await native.call('no_activate',{hwnd:windowA.hwnd,enabled:true});await pause(100);}
    await native.call('snapshot');
    for(const part of ['move','down','up']){
      const step={part,at:Date.now(),api:await native.call('post_part',{hwnd,...clientPoint,part})};
      if(part==='down')downSent=true;if(part==='up')downSent=false;
      await pause(300);step.native=await native.call('snapshot');step.page=await pageSnapshot(target);record.stages.push(step);
      console.log(JSON.stringify({case:id,part,foreground:step.native.foreground,hasFocus:step.page.hasFocus,trusted:step.page.trusted,events:step.page.events.map(e=>e.type)}));
    }
    record.completed=true;
  }catch(error){record.error=String(error);record.completed=false;console.log(JSON.stringify({case:id,error:record.error}));}
  finally{
    if(downSent&&hwnd)record.cleanupRelease=await native.call('post_part',{hwnd,...clientPoint,part:'up'}).catch(error=>({error:String(error)}));
    if(record.styleChange)record.styleRestored=await native.call('no_activate',{hwnd:windowA.hwnd,enabled:false}).catch(error=>({error:String(error)}));
    record.finishedAt=Date.now();await save();
  }
}
async function externalForegroundPost(label){
  const id=`external-foreground-post-${label}`;
  const record={id,backend:'post',addressing:'child',startedAt:Date.now()};evidence.setups.push(record);
  const initial=await native.call('snapshot');
  if(initial.foreground.pid===evidence.browserPid){record.skipped='No other process naturally holds the foreground; no personal window activated to manufacture it';return;}
  currentNativeCase=id;
  await pageReset(target,id);
  record.pageBefore=await pageSnapshot(target);record.before=await native.call('snapshot');
  assert.notEqual(record.before.foreground.pid,evidence.browserPid,'External foreground condition changed before input');
  record.content=contentFor(record.before,windowA,record.pageBefore);
  record.point=point(record.pageBefore,record.content);
  record.dispatchAt=Date.now();
  record.api=await existingPost(record.content.hwnd,record.point.client.x,record.point.client.y);
  await pause(evidence.observationWaitMs);
  record.after=await native.call('snapshot');record.pageAfter=await pageSnapshot(target);
  const beforeTop=record.before.windows.find(w=>w.hwnd===windowA.hwnd);
  const afterTop=record.after.windows.find(w=>w.hwnd===windowA.hwnd);
  record.observed={trustedDelta:record.pageAfter.trusted-record.pageBefore.trusted,
    foregroundChanged:record.before.foreground.hwnd!==record.after.foreground.hwnd,
    foregroundEvents:record.after.nativeEvents.filter(v=>v.ev===3),
    geometryChanged:JSON.stringify(beforeTop.windowRect)!==JSON.stringify(afterTop.windowRect),
    cursorChanged:JSON.stringify(record.before.cursor)!==JSON.stringify(record.after.cursor),
    beforeGui:beforeTop.gui,afterGui:afterTop.gui,clickEvents:record.pageAfter.events.filter(v=>v.type==='click')};
  record.completed=true;record.finishedAt=Date.now();await save();
  console.log(JSON.stringify({case:id,...record.observed}));
}
async function screenshot(info,label) {
  const client=await CdpClient.connect(info.webSocketDebuggerUrl);
  try { const result=await client.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(root,label),Buffer.from(result.data,'base64')); }
  finally {client.close();}
}
class NativeClient {
  constructor(pid) {
    this.next=1;this.pending=new Map();this.stderr='';
    this.child=spawn(environment.BKA_PWSH_PATH||'pwsh.exe',['-NoProfile','-NonInteractive','-File',path.join(here,'probe.ps1'),'-AllowedBrowserPid',String(pid)],
      {env:environment,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.ready=new Promise((resolve,reject)=>{this.onReady=resolve;this.onFailure=reject;});
    this.child.stderr.on('data',data=>{this.stderr+=data;});
    createInterface({input:this.child.stdout}).on('line',line=>{
      let value;try{value=JSON.parse(line);}catch{this.stderr+=line;return;}
      if(value.ready){this.onReady();return;}
      const pending=this.pending.get(value.id);if(!pending)return;this.pending.delete(value.id);clearTimeout(pending.timer);
      if(value.ok)pending.resolve(value.result);else pending.reject(new Error(value.error));
    });
    this.child.on('error',error=>this.fail(error));
    this.child.on('exit',code=>this.fail(new Error(`Native probe exit ${code}: ${this.stderr}`)));
  }
  fail(error){this.onFailure(error);for(const value of this.pending.values()){clearTimeout(value.timer);value.reject(error);}this.pending.clear();}
  async call(method,params={}){await this.ready;const id=this.next++;return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Native method timeout ${method}: ${this.stderr}`));},8000);
    this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,...params})+'\n');
  });}
  async close(){this.child.stdin.end(JSON.stringify({id:0,method:'stop'})+'\n');await Promise.race([new Promise(resolve=>this.child.once('exit',resolve)),pause(1500)]);if(this.child.exitCode===null)this.child.kill();}
}

console.log(`Native input experiment: ${root}`);
try {
  const args=[`--user-data-dir=${profile}`,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--no-first-run','--no-default-browser-check',
    '--disable-sync','--disable-background-networking','--disable-component-update','--disable-session-crashed-bubble','--window-size=900,760',`${base}/page.html?page=target`];
  if(useChromium)args.splice(args.length-1,0,`--load-extension=${path.join(here,'extension')}`);
  if(chromeFixture)args.splice(args.length-1,0,'--enable-unsafe-extension-debugging');
  evidence.args=args;evidence.httpPort=port;
  child=spawn(executable,args,{env:environment,windowsHide:true,stdio:['ignore','ignore','pipe']});
  child.stderr.on('data',data=>{browserStderr+=data;});
  evidence.browserPid=child.pid;
  const activePort=await until(()=>readFile(path.join(profile,'DevToolsActivePort'),'utf8'),value=>value.includes('\n'));
  evidence.debugPort=Number(activePort.split(/\r?\n/)[0]);
  const version=await(await fetch(`http://127.0.0.1:${evidence.debugPort}/json/version`)).json();evidence.version=version;
  browser=await CdpClient.connect(version.webSocketDebuggerUrl);
  if(chromeFixture)evidence.fixtureInstall=await browser.send('Extensions.loadUnpacked',{path:path.join(here,'extension'),enableInIncognito:false});
  if(useFixture){
    const isFixture=v=>v.type==='service_worker'&&(evidence.fixtureInstall
      ?v.url===`chrome-extension://${evidence.fixtureInstall.id}/worker.js`
      :v.url.startsWith('chrome-extension://')&&v.url.endsWith('/worker.js'));
    const service=await until(targets,values=>values.filter(isFixture).length===1).then(values=>values.find(isFixture));
    evidence.fixtureService={id:service.id,url:service.url};
    // Attach this exact short-lived test worker now, before lengthy input groups
    // let MV3 suspend it. This is observation plumbing, not a product heartbeat.
    fixture=await CdpClient.connect(service.webSocketDebuggerUrl);
  }
  target=await until(targets,values=>values.some(v=>v.type==='page'&&v.url===`${base}/page.html?page=target`)).then(values=>values.find(v=>v.url===`${base}/page.html?page=target`));
  await until(()=>page(target,'Boolean(globalThis.__nativeProbe)'),Boolean);
  const spareCreated=await browser.send('Target.createTarget',{url:`${base}/page.html?page=spare`,background:true});
  spare=await until(targets,values=>values.some(v=>v.id===spareCreated.targetId)).then(values=>values.find(v=>v.id===spareCreated.targetId));
  await until(()=>page(spare,'Boolean(globalThis.__nativeProbe)'),Boolean);
  const coverCreated=await browser.send('Target.createTarget',{url:`${base}/page.html?page=cover`,newWindow:true,background:false});
  cover=await until(targets,values=>values.some(v=>v.id===coverCreated.targetId)).then(values=>values.find(v=>v.id===coverCreated.targetId));
  await until(()=>page(cover,'Boolean(globalThis.__nativeProbe)'),Boolean);
  evidence.browserWindows={target:await browser.send('Browser.getWindowForTarget',{targetId:target.id}),spare:await browser.send('Browser.getWindowForTarget',{targetId:spare.id}),cover:await browser.send('Browser.getWindowForTarget',{targetId:cover.id})};
  assert.equal(evidence.browserWindows.target.windowId,evidence.browserWindows.spare.windowId,'Spare must belong to target window');
  native=new NativeClient(child.pid); await Promise.race([native.ready,pause(15000).then(()=>{throw new Error(`Native startup timed out: ${native.stderr}`);})]);
  const initial=await native.call('snapshot');evidence.initialNative=initial;
  windowA=topFor(initial,'target');windowB=topFor(initial,'cover');evidence.windowA=windowA;evidence.windowB=windowB;
  await save();
  if(!stagesOnly&&!apiOnly){
  await inputCase('foreground','dom','child',1);
  await inputCase('background','dom','child',1);
  const states=quick?['foreground','background','covered']:['foreground','background','covered','minimized','inactive-tab'];
  for(const state of states){
    for(const addressing of ['child','top']){
      const repetitions=addressing==='child'&&!quick?3:1;
      for(let trial=1;trial<=repetitions;trial++)await inputCase(state,'post',addressing,trial);
    }
  }
  for(const state of quick?['background']:['foreground','background','covered','minimized'])await inputCase(state,'send-timeout','child',1);
  for(const state of ['foreground','background','covered'])await inputCase(state,'send-input','child',1);
  await inputCase('background','post','child',1,{overlay:true});
  await inputCase('background','post','child',1,{disabled:true});
  }
  if(!apiOnly){
    await stagedCase('background','child');
    await stagedCase('covered','top');
    await stagedCase('background','child',true);
    await stagedCase('covered','top',true);
  }
  if(useFixture){
    const fixtureTabs=await runtimeEvaluate(fixture,`chrome.tabs.query({}).then(values=>values.filter(v=>v.url?.startsWith(${JSON.stringify(base)})).map(v=>({id:v.id,windowId:v.windowId,url:v.url,active:v.active})))`);
    evidence.fixtureTabs=fixtureTabs;
    const fixtureTab=fixtureTabs.find(v=>v.url.endsWith('page=target'));
    assert.ok(fixtureTab,'Exact fixture extension must see its isolated local target tab');
    const fixtureSpare=fixtureTabs.find(v=>v.url.endsWith('page=spare'));
    const fixtureCover=fixtureTabs.find(v=>v.url.endsWith('page=cover'));
    assert.ok(fixtureSpare&&fixtureCover,'Both isolated control tabs must exist');
    currentNativeCase='tabs-update-active-only:prepare';
    evidence.fixturePrepare={
      spare:await runtimeEvaluate(fixture,`chrome.tabs.update(${fixtureSpare.id},{active:true}).then(v=>({id:v.id,active:v.active}))`),
      cover:await runtimeEvaluate(fixture,`chrome.windows.update(${fixtureCover.windowId},{focused:true}).then(v=>({id:v.id,focused:v.focused}))`)};
    await pause(300);
    const before=await native.call('snapshot');
    assert.notEqual(before.foreground.hwnd,windowA.hwnd,'Active-tab-only control requires target window not to be foreground');
    currentNativeCase='tabs-update-active-only';
    const result=await runtimeEvaluate(fixture,`chrome.tabs.update(${fixtureTab.id},{active:true}).then(v=>({id:v.id,windowId:v.windowId,active:v.active}))`);
    await pause(300);const after=await native.call('snapshot');
    evidence.setups.push({id:'chrome.tabs.update-active-only',before,result,after,page:await pageSnapshot(target)});
    if(externalPost)await externalForegroundPost('before-window-focus');
    const beforeFocus=await native.call('snapshot');
    const focused=await runtimeEvaluate(fixture,`chrome.windows.update(${fixtureTab.windowId},{focused:true}).then(v=>({id:v.id,focused:v.focused,left:v.left,top:v.top,width:v.width,height:v.height}))`);
    await pause(300);evidence.setups.push({id:'chrome.windows.update-focused-only',before:beforeFocus,result:focused,after:await native.call('snapshot'),page:await pageSnapshot(target)});
    if(externalPost)await externalForegroundPost('after-window-focus');
  }
  if(!apiOnly){
    const screenshotPrepared=await prepare('foreground','screenshot-success');
    await existingPost(screenshotPrepared.content.hwnd,screenshotPrepared.point.client.x,screenshotPrepared.point.client.y);
    await pause(200);
    await screenshot(target,'target-viewport.png');await screenshot(cover,'cover-viewport.png');
  }
  evidence.completed=cases.every(v=>v.completed)&&evidence.setups.every(v=>v.completed!==false);
} catch(error) {evidence.fatal=String(error);console.error(error);process.exitCode=1;}
finally {
  currentNativeCase='cleanup';
  if(native){evidence.finalNative=await native.call('snapshot').catch(error=>({error:String(error)}));await native.close();}
  fixture?.close();
  if(browser){await browser.send('Browser.close',{},3000).catch(()=>{});browser.close();}
  if(child&&child.exitCode===null){await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(1500)]);if(child.exitCode===null)child.kill();}
  evidence.finishedAt=new Date().toISOString();
  await new Promise(resolve=>server.close(resolve));
  await save();await writeFile(path.join(root,'browser-stderr.log'),browserStderr);
  console.log(JSON.stringify({root,completed:evidence.completed||false,cases:cases.length,failedCases:cases.filter(v=>!v.completed).length,failedSetups:evidence.setups.filter(v=>v.completed===false).length,fatal:evidence.fatal||null}));
}
