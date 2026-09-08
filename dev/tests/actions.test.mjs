import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import 'fake-indexeddb/auto';
const event = { addListener() {} };
const session = {};
let windowReads = 0, changed = [], beforeWindowRead = async () => {};
let windowState = { state: 'normal', focused: true, left: -100, top: 0, width: 1200, height: 800 };
const tab = { id: 81, index: 0, windowId: 7, active: true, highlighted: true, pinned: false, incognito: false, status: 'complete', url: 'https://action.test/form', title: 'Action fixture' };
globalThis.chrome = {
  runtime: { id: 'fixture', getManifest: () => ({ name: 'fixture', version: 'test' }) },
  tabs: { onRemoved: event, onReplaced: event, async query() { return [tab]; }, async get(id) { assert.equal(id, tab.id); return { ...tab }; } },
  webNavigation: { onCommitted: event },
  windows: { async get(id) { await beforeWindowRead(); windowReads++; return { id, ...windowState }; },
    async update(id, update) { changed.push(update); Object.assign(windowState,update); return this.get(id); } },
  storage: { session: { async setAccessLevel() {}, async get(key) { return { [key]: structuredClone(session[key]) }; }, async set(items) { Object.assign(session, structuredClone(items)); } } },
};
const { parseCommand, dispatchRouteRequest } = await import('../../out/extension/background/command-dispatcher.js');
const { compileInstructions } = await import('../../out/extension/background/actions/compiler.js');
const { saveAction, listActions, readAction, snapshotAction, deleteAction } = await import('../../out/extension/background/actions/store.js');
const { runAction } = await import('../../out/extension/background/actions/runner.js');
const { compileSource } = await import('../../out/extension/background/actions/service.js');
const { createTextArtifact } = await import('../../out/extension/background/artifact-service.js');
const { createKey, updateKey, revokeKey } = await import('../../out/extension/background/key-service.js');
const { readExecutionTrace } = await import('../../out/extension/background/execution-trace-service.js');
const { COMMAND_CATALOG } = await import('../../out/extension/generated/command-config.js');
const { observeExternalCondition } = await import('../../out/extension/background/ensure-external.js');
const instruction = (method = 'windows.get', params = { windowId: 7 }, rest = {}) => ({ method, schemaVersion: 1, params, ...rest });
const compile = (steps) => compileInstructions(steps, parseCommand);
const mutationId = () => `am1.${Date.now()}.${randomBytes(16).toString('base64url')}`;
const key = (permissions) => createKey({ mutationId: mutationId(), displayName: 'actions fixture', keyKind: 'regular', permissions: [...permissions].sort(), enabled: true, expiresAt: null });
let route = 0;
const dispatch = async (apiKey, method, params, schemaVersion = 1) => (await dispatchRouteRequest({ kind: 'route.request', routeId: String(++route), payload: {
  clientRequestId: String(route), auth: { apiKey }, command: { method, schemaVersion, params },
} })).payload;

test('duplicate names have distinct stable IDs; paging, revision conflicts, delete and nonreuse are transactional', async () => {
  const steps = compile([instruction(), instruction('windows.setState', { windowId: 7, state: 'normal' })]).instructions;
  const first = await saveAction('same name', 'one', steps);
  const second = await saveAction('same name', 'two', steps);
  assert.ok(second.actionId > first.actionId);
  const page = await listActions(first.actionId - 1, 1, 'same name');
  assert.deepEqual(page.items.map((a) => a.actionId), [first.actionId]);
  assert.equal(page.nextAfterActionId, first.actionId);
  assert.deepEqual((await listActions(page.nextAfterActionId, 1, 'same name')).items.map((a) => a.actionId), [second.actionId]);
  const body = await readAction(first.actionId, 0, 1);
  assert.equal(body.instructions.length, 1); assert.equal(body.nextOffset, 1);
  const snapshot = await snapshotAction(first.actionId);
  const raced = await Promise.allSettled([saveAction('renamed', 'one', steps.slice(0,1), {actionId:first.actionId,revision:1}), saveAction('racer', 'two', steps, {actionId:first.actionId,revision:1})]);
  assert.equal(raced.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(raced.find((r) => r.status === 'rejected').reason.details.reason, 'REVISION_CONFLICT');
  assert.equal(snapshot.instructions.length, 2);
  await deleteAction(first.actionId, 2);
  await assert.rejects(snapshotAction(first.actionId), (e) => e.details.reason === 'NOT_FOUND');
  assert.ok((await saveAction('same name', '', steps)).actionId > second.actionId);
});

test('compile is pure, rejects nested action runs and frozen refs, and roundtrips public shortcut parameters', async () => {
  const before = windowReads;
  const first = compile([instruction()]);
  assert.equal(windowReads, before);
  assert.deepEqual(compile(first.instructions).instructions, first.instructions);
  assert.throws(() => compile([instruction('actions.run',{actionId:1})]), (e) => e.details.reason === 'COMMAND_NOT_ALLOWED');
  assert.throws(() => compile([instruction('windows.get',{windowId:-1})]), (e) => e.details.reason === 'PARAMS_INVALID');
  const frozen = `tr1.${'A'.repeat(22)}.1.${'B'.repeat(22)}`;
  assert.throws(() => compile([instruction('tabs.get',{tabRef:frozen})]), (e) => e.details.reason === 'DURABLE_BINDING_REQUIRED');
  const mouse = compile([instruction('virtualMouse.click', {tabRef:null}, { bindings:[{path:['tabRef'],source:{kind:'input',name:'target',valueType:'tab_ref'}}] })]);
  assert.equal(Object.hasOwn(mouse.instructions[0].params, 'actions'), false);
  assert.deepEqual(compile(mouse.instructions).instructions, mouse.instructions);
});

test('bindings reject forward results, overlapping paths, prototype access and invalid source types', () => {
  const step = (bindings) => instruction('windows.get',{windowId:null},{bindings});
  for (const bindings of [
    [{path:['windowId'],source:{kind:'result',step:0,path:['windowId'],valueType:'window_id'}}],
    [{path:['__proto__','polluted'],source:{kind:'input',name:'x',valueType:'string'}}],
    [{path:['windowId'],source:{kind:'input',name:'x',valueType:'invalid'}}],
    [{path:['windowId'],source:{kind:'input',name:'x',valueType:'window_id'}},{path:['windowId'],source:{kind:'input',name:'y',valueType:'window_id'}}],
  ]) assert.throws(() => compile([step(bindings)]), (e) => e.code === 'ACTION_OPERATION_FAILED');
  assert.equal({}.polluted, undefined);
});

test('real dispatcher executes by ID without re-entering its Key lane and checks each child permission', { timeout: 4000 }, async () => {
  const maker = await key(['actions.write', 'actions.read', 'actions.run', 'windows.read']);
  const saved = await dispatch(maker.apiKey, 'actions.create', {name:'read window',description:'',instructions:[instruction()]});
  assert.equal(saved.ok, true);
  const run = await dispatch(maker.apiKey,'actions.run',{actionId:saved.result.action.actionId});
  assert.equal(run.ok, true); assert.equal(run.result.status,'succeeded'); assert.equal(run.result.completedSteps,1);
  assert.equal(run.result.results[0].windowId,7);
  const trace = await readExecutionTrace(maker.key.keyId, run.trace.traceRef);
  assert.ok(trace.events.some((e) => e.actionId === saved.result.action.actionId && e.stepIndex === 0));
  const limited = await key(['actions.run']);
  const before = windowReads;
  const forbidden = await dispatch(limited.apiKey,'actions.run',{actionId:saved.result.action.actionId});
  assert.equal(forbidden.ok, false); assert.equal(forbidden.error.code, 'FORBIDDEN');
  assert.equal(windowReads, before);
  assert.equal(forbidden.trace.traceRef, null);
});

test('accepted queued actions survive later Key changes and keep the submitted revision', { timeout: 6000 }, async () => {
  for (const change of ['revoke', 'disable', 'expire', 'permissions']) {
    const caller = await key(['actions.run', 'windows.read']);
    const saved = await saveAction('Queued snapshot', '', compile([instruction(), instruction()]).instructions);
    let entered, release, admitted;
    const arrived = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    beforeWindowRead = async () => { entered(); await gate; };
    const blocker = dispatch(caller.apiKey, 'windows.get', { windowId: 7 }); await arrived;
    const accepted = new Promise(resolve => { admitted = resolve; });
    const getAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function (...args) {
      if (this.name === 'action_steps' && this.transaction.mode === 'readonly') this.transaction.addEventListener('complete', () => setImmediate(admitted), { once: true });
      return Reflect.apply(getAll, this, args);
    };
    const queued = dispatch(caller.apiKey, 'actions.run', { actionId: saved.actionId });
    try {
      await accepted; IDBObjectStore.prototype.getAll = getAll;
      if (change === 'revoke') await revokeKey({ mutationId: mutationId(), keyId: caller.key.keyId, expectedRevision: 1 });
      else await updateKey({ mutationId: mutationId(), keyId: caller.key.keyId, expectedRevision: 1,
        patch: { displayName: caller.key.displayName, permissions: change === 'permissions' ? [] : caller.key.permissions,
          enabled: change !== 'disable', expiresAt: change === 'expire' ? Date.now() + 60 : null } });
      if (change === 'expire') await new Promise(resolve => setTimeout(resolve, 90));
      await deleteAction(saved.actionId, saved.revision);
      release(); assert.equal((await blocker).ok, true);
      const result = await queued;
      assert.equal(result.ok, true, change); assert.equal(result.result.status, 'succeeded', change);
      assert.equal(result.result.revision, saved.revision); assert.equal(result.result.completedSteps, 2);
      assert.equal((await dispatch(caller.apiKey, 'windows.get', { windowId: 7 })).ok, false, 'New submissions must use the new Key state');
    } finally { release(); beforeWindowRead = async () => {}; IDBObjectStore.prototype.getAll = getAll; await Promise.allSettled([blocker, queued]); }
  }
});

test('revocation during one action step does not prevent its remaining steps', { timeout: 3000 }, async () => {
  const caller = await key(['actions.run', 'windows.read']);
  const saved = await saveAction('Accepted sequence', '', compile([instruction(), instruction()]).instructions);
  let entered, release;
  const arrived = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  beforeWindowRead = async () => { entered(); await gate; };
  const pending = dispatch(caller.apiKey, 'actions.run', { actionId: saved.actionId });
  try {
    await arrived; await revokeKey({ mutationId: mutationId(), keyId: caller.key.keyId, expectedRevision: 1 }); release();
    const result = await pending; assert.equal(result.result.status, 'succeeded'); assert.equal(result.result.completedSteps, 2);
  } finally { release(); beforeWindowRead = async () => {}; await pending; }
});

test('an input value and an earlier result bind by type, then a missing input stops later effects', async () => {
  const body = compile([
    instruction('windows.get',{windowId:null},{bindings:[{path:['windowId'],source:{kind:'input',name:'window',valueType:'window_id'}}]}),
    instruction('windows.get',{windowId:null},{bindings:[{path:['windowId'],source:{kind:'result',step:0,path:['windowId'],valueType:'window_id'}}]}),
    instruction('windows.get',{windowId:null},{bindings:[{path:['windowId'],source:{kind:'input',name:'missing',valueType:'window_id'}}]}), instruction(),
  ]).instructions;
  const meta = await saveAction('binding', '', body);
  const executions = [];
  const result = await runAction(await snapshotAction(meta.actionId), {window:7},1000,{
    parse:parseCommand, authorize:async()=>{}, execute:async(c,i)=>{executions.push(i);return {windowId:c.params.windowId};},
    normalizeError:e=>({code:e.code,details:e.details}),stepEvent:()=>{},
  });
  assert.deepEqual(executions,[0,1]); assert.equal(result.status,'failed'); assert.equal(result.completedSteps,2);
});

test('unknown effect results stop and do not retry or continue', async () => {
  const meta = await saveAction('unknown', '', compile([instruction(),instruction()]).instructions);
  let effects = 0;
  const result = await runAction(await snapshotAction(meta.actionId),{},1000,{
    parse:parseCommand,authorize:async()=>{},execute:async()=>{effects++;return {status:'unknown'};},normalizeError:e=>({code:e.code}),stepEvent:()=>{},
  });
  assert.equal(effects,1);assert.equal(result.status,'unknown');assert.equal(result.stoppedAt,0);
});

test('complete action JSON imports through owner-bound integrity-checked Artifacts', async () => {
  const artifact = await createTextArtifact('owner','application/json',JSON.stringify([instruction()]));
  assert.equal((await compileSource('owner',{artifactRef:artifact.artifactRef},parseCommand)).instructions.length,1);
  await assert.rejects(compileSource('other',{artifactRef:artifact.artifactRef},parseCommand),(e)=>e.code==='ARTIFACT_NOT_FOUND');
  const incomplete = await createTextArtifact('owner','application/json','[{');
  await assert.rejects(compileSource('owner',{artifactRef:incomplete.artifactRef},parseCommand),(e)=>e.details.reason==='SOURCE_JSON_INVALID');
});

test('window parser keeps negative positions, explicit restore and no implied focus', async () => {
  assert.equal(parseCommand(instruction('windows.setBounds',{windowId:7,left:-400,width:1000})).params.left,-400);
  assert.equal(parseCommand(instruction('windows.setBounds',{windowId:7})),null);
  assert.equal(parseCommand(instruction('windows.setBounds',{windowId:7,width:0})),null);
  assert.equal(parseCommand(instruction('windows.setState',{windowId:7,state:'normal',focused:true})),null);
  const caller = await key(['windows.update']); changed=[];
  const result=await dispatch(caller.apiKey,'windows.setBounds',{windowId:7,left:-400,width:1000});
  assert.equal(result.ok,true);assert.deepEqual(changed,[{left:-400,width:1000}]);
});

test('a settled late final step reports the deadline and retains its known result', async () => {
  const meta = await saveAction('late', '', compile([instruction()]).instructions);
  const result = await runAction(await snapshotAction(meta.actionId),{},50,{
    parse:parseCommand,authorize:async()=>{},execute:async()=>{await new Promise(r=>setTimeout(r,80));return {known:'complete'};},normalizeError:e=>({code:e.code}),stepEvent:()=>{},
  });
  assert.equal(result.status,'failed');assert.equal(result.error.details.reason,'DEADLINE_AFTER_STEP');
  assert.equal(result.completedSteps,1);assert.equal(result.results[0].known,'complete');
});

test('oversized success and unknown results are materialized before insertion and stop later effects', async () => {
  const previous=COMMAND_CATALOG.limits['command.actions.maximum_result_bytes'];
  try {
    COMMAND_CATALOG.limits['command.actions.maximum_result_bytes']=100;
    const meta=await saveAction('result bound','',compile([instruction(),instruction()]).instructions);
    for(const status of ['succeeded','unknown']) {
      let calls=0, materialized;
      const result=await runAction(await snapshotAction(meta.actionId),{},1000,{
        parse:parseCommand,authorize:async()=>{},execute:async()=>{calls++;return {status,body:'x'.repeat(500)};},
        normalizeError:e=>({code:e.code}),stepEvent:()=>{},materializeResult:async(value)=>{materialized=value;return {artifactRef:'fixture'};},
      });
      assert.equal(calls,1);assert.equal(materialized.body.length,500);assert.deepEqual(result.results,[]);
      assert.deepEqual(result.resultArtifact,{artifactRef:'fixture'});assert.equal(result.status,status==='succeeded'?'failed':'unknown');
    }
  } finally {COMMAND_CATALOG.limits['command.actions.maximum_result_bytes']=previous;}
});

test('ensure v2 checks, restores, resizes, rechecks, executes and verifies; v1 rejects the new contract', async () => {
  windowState={state:'minimized',focused:false,left:0,top:0,width:800,height:600};changed=[];
  const caller=await key(['workflow.run','windows.read','windows.update']);
  const params={
    precondition:{kind:'all',conditions:[{kind:'window_state',windowId:7,state:'normal'},{kind:'window_bounds',windowId:7,bounds:{left:null,top:null,width:1200,height:null},tolerance:0}]},
    corrections:[instruction('windows.setState',{windowId:7,state:'normal'}),instruction('windows.setBounds',{windowId:7,width:1200})],
    action:instruction('windows.setState',{windowId:7,state:'maximized'}),
    goal:{kind:'window_state',windowId:7,state:'maximized'},scrollIntoView:false,searchByScrolling:false,
  };
  assert.equal(parseCommand({method:'ensure.run',schemaVersion:1,params}),null);
  assert.ok(parseCommand({method:'ensure.run',schemaVersion:2,params}));
  const result=await dispatch(caller.apiKey,'ensure.run',params,2);
  assert.equal(result.ok,true);assert.equal(result.result.status,'satisfied');
  assert.deepEqual(changed,[{state:'normal'},{width:1200},{state:'maximized'}]);
  assert.deepEqual(result.result.corrections,{attempts:1,completed:2,effectMayHaveRun:true});
  assert.equal(windowState.focused,false);
  assert.equal(parseCommand({method:'ensure.run',schemaVersion:2,params:{...params,correctionAttempts:2}}),null);
});

test('false external conditions and lost correction permission send no main effect; unknown geometry is not false', async () => {
  windowState={state:'minimized',focused:false,left:0,top:0,width:800,height:600};changed=[];
  const caller=await key(['workflow.run','windows.read']);
  const params={precondition:{kind:'window_state',windowId:7,state:'normal'},corrections:[instruction('windows.setState',{windowId:7,state:'normal'})],
    action:instruction('windows.setState',{windowId:7,state:'maximized'}),scrollIntoView:false,searchByScrolling:false};
  const result=await dispatch(caller.apiKey,'ensure.run',params,2);
  assert.equal(result.result.status,'failed');assert.equal(result.result.error.code,'FORBIDDEN');assert.equal(result.result.effectSent,false);assert.deepEqual(changed,[]);
  assert.equal(await observeExternalCondition({kind:'window_focused',windowId:7,focused:false},async()=>{}),true);
  windowState.width=undefined;
  assert.equal(await observeExternalCondition({kind:'window_bounds',windowId:7,bounds:{left:null,top:null,width:1200,height:null},tolerance:0},async()=>{}),null);
});
