import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { TRANSPORT_CONFIG } from '../../out/extension/generated/transport-config.js';
import { VirtualMouseError } from '../../out/extension/background/virtual-mouse-model.js';
import { COMMAND_CATALOG } from '../../out/extension/generated/command-config.js';
import { NativeInputError } from '../../out/extension/background/native-input-error.js';

function loadModule(context, file, exported) {
  const source = readFileSync(new URL(`../../out/extension/background/${file}.js`, import.meta.url), 'utf8')
    .replace(/^import\b[\s\S]*?;\s*/gmu, '').replace(/^export\s+(?=(?:async )?(?:function|class|const|let)\b)/gmu, '');
  return vm.runInContext(`${source}\n${exported}`, context);
}

function fixture() {
  let now = 100, connection = { connectionGeneration: 7, relayEpoch: 'A'.repeat(22) };
  const sent = [];
  const state = { open: null, refresh: async () => {} };
  const context = vm.createContext({ TRANSPORT_CONFIG, VirtualMouseError, crypto, console: { warn() {} },
    performance: { now: () => now }, Date: { now: () => now },
    refreshNativeConnection: () => state.refresh(), localRouteConnection: () => ({ ...connection }),
    async requestLocalRoute(request, expected) {
      if (expected.connectionGeneration !== connection.connectionGeneration || expected.relayEpoch !== connection.relayEpoch) throw new VirtualMouseError('connection_changed');
      sent.push(structuredClone(request));
      if (request.kind === 'route.local.open' && state.open) return state.open(request, expected);
      return { ...expected, confirmed: true, response: { kind: 'route.local.result', requestId: request.requestId, ok: true,
        result: request.kind === 'route.local.open' ? { routeId: '17' } : { closed: true } } };
    },
  });
  const Owner = loadModule(context, 'local-route-client', 'LocalCommandRoute');
  return { state, sent, context, create: () => new Owner(10000), setNow(value) { now = value; }, reconnect() { connection = { ...connection, connectionGeneration: 8 }; } };
}

test('local route is lazy and shared beyond a short first step without reopening on reconnect', async () => {
  const f = fixture(), owner = f.create();
  assert.equal(f.sent.length, 0);
  assert.equal((await owner.acquire(1000)).routeId, '17');
  assert.equal(f.sent[0].durationMs, 9900);
  f.setNow(1500); assert.equal((await owner.acquire(2000)).routeId, '17');
  assert.equal(f.sent.length, 1);
  f.reconnect(); await assert.rejects(owner.acquire(2000), error => error.reason === 'connection_changed');
  await owner.finish(); assert.equal(f.sent.length, 1);
  await assert.rejects(owner.acquire(2000), error => error.reason === 'local_route_finished');
});

test('late open cannot restart step budget and late connection refresh cannot open after finish', async () => {
  const f = fixture(); let release, entered;
  const gate = new Promise(resolve => { entered = resolve; });
  f.state.open = (request, expected) => new Promise(resolve => { release = () => resolve({ ...expected, confirmed: true,
    response: { kind: 'route.local.result', requestId: request.requestId, ok: true, result: { routeId: '17' } } }); entered(); });
  const owner = f.create(), operation = owner.acquire(1000);
  await gate; f.setNow(1500); release();
  await assert.rejects(operation, error => error.reason === 'timeout');
  await owner.finish(); await owner.finish();
  assert.deepEqual(f.sent.map(request => request.kind), ['route.local.open', 'route.local.close']);
  const second = fixture(); let refresh;
  second.state.refresh = () => new Promise(resolve => { refresh = resolve; });
  const waiting = second.create();
  const preparation = waiting.acquire(1000);
  assert.equal(typeof refresh, 'function');
  await waiting.finish(); refresh();
  await assert.rejects(preparation, error => error.reason === 'local_route_finished');
  assert.equal(second.sent.length, 0);
});

test('unknown open is not retried and only the command deadline bounds its route', async () => {
  const f = fixture();
  f.state.open = async (request, expected) => ({ ...expected, confirmed: false,
    response: { kind: 'route.local.result', requestId: request.requestId, ok: false, error: { reason: 'local_route_response_timeout' } } });
  const owner = f.create();
  await assert.rejects(owner.acquire(1000)); await assert.rejects(owner.acquire(1000)); await owner.finish();
  assert.equal(f.sent.length, 1);
  const second = fixture(), bounded = second.create();
  await bounded.acquire(5000); assert.equal(second.sent[0].durationMs, 9900);
  second.setNow(500); await bounded.acquire(5000);
  second.setNow(10001); await assert.rejects(bounded.acquire(15000), error => error.reason === 'timeout');
  await bounded.finish(); assert.equal(second.sent.filter(request => request.kind === 'route.local.open').length, 1);
});

for (const service of ['real-input-service', 'keyboard-service', 'virtual-input-service']) {
  test(`${service} keeps the accepted command budget across later Key changes`, async () => {
    for (const phase of ['next_step', 'opening', 'preparing']) {
      const f = fixture(), native = [], saved = {};
      const key = { keyId: 'key', keyKind: 'root', expiresAt: null, enabled: true };
      const owner = f.create();
      if (phase === 'next_step') { await owner.acquire(5000); key.expiresAt = 50; }
      if (phase === 'opening') f.state.open = async (request, expected) => {
        key.expiresAt = 50;
        return { ...expected, confirmed: true, response: { kind: 'route.local.result', requestId: request.requestId, ok: true, result: { routeId: '17' } } };
      };
      const prepare = () => { if (phase === 'preparing') { key.expiresAt = 50; key.enabled = false; } };
      const target = { nodeRef: 'node', tabRef: 'tab', tabId: 1, frameId: 0, documentId: 'document' };
      const tab = { windowId: 7, active: true, discarded: false };
      const result = { completedActions: 1, submittedScalars: 1, status: 'input_sent',
        input: { id: 8, mouse: { point: { x: 0, y: 0 }, buttons: 0, known: true }, keyboard: { keys: [], known: true }, windows: [] } };
      Object.assign(f.context, { COMMAND_CATALOG, NativeInputError, btoa,
        chrome: {
          tabs: { async get() { return tab; }, async update() { return tab; } }, windows: { async update() {} },
          webNavigation: { async getAllFrames() { return [{ frameId: 0, documentId: 'document' }]; } },
          scripting: { async executeScript() { prepare(); return [{ documentId: 'document', result: { originalTitle: 'fixture', width: 800, height: 600 } }]; } },
          storage: { session: { async setAccessLevel() {}, async get(key) { return { [key]: saved[key] }; }, async set(value) { Object.assign(saved, value); } } },
        },
        resolveNodeRefTarget: () => target, restoreRealClickTitle: async () => {},
        async prepareRealClickNode() { prepare(); return { originalTitle: 'fixture', point: { x: 10, y: 20 } }; },
        assertNativeInputClickAvailable() {}, assertNativeInputKeyboardAvailable() {},
        async requestNativeClick(request) { native.push(request); return { ok: true, result }; },
        async requestNativeKeyboard(request) { native.push(request); return { ok: true, result }; },
        isNodeRefShape: value => value === 'node', isTabRefShape: value => value === 'tab', tabRefForNode: () => 'tab',
        resolveTabTarget: async () => target, assertResolvedTabTarget() {}, focusKeyboardNode: async () => {},
        async markKeyboardWindow() { prepare(); return { originalTitle: 'fixture', documentId: 'document', viewport: { width: 800, height: 600 } }; },
        restoreKeyboardWindow: async () => {}, ensureKeyInput: async () => ({ inputId: '8' }),
        assertScriptingTargetAvailable: async () => {}, assertWindowInputControl: async () => {},
        virtualInputGeneration: () => 7, virtualInputRelayEpoch: () => 'A'.repeat(22),
        async requestVirtualInput(request) { native.push(request); return result; },
      });
      const context = { routeId: 'ui1.diagnostic', key, timeoutMs: 5000,
        acquireNativeRoute: owner.acquire, validateControl: async () => {} };
      if (service === 'real-input-service') await loadModule(f.context, service, 'clickRealDomNode')({ ...context, nodeRef: 'node', scrollIntoView: false });
      else if (service === 'keyboard-service') await loadModule(f.context, service, 'typeKeyboardText')({ ...context, targetRef: 'tab', admittedWindowId: 7 }, 'x');
      else await loadModule(f.context, service, 'operateKeyInput')(context, 'tab', { kind: 'input', actions: [] }, 7);
      assert.ok(native.length > 0, phase);
      assert.ok(native.every(request => request.routeId === '17' && request.timeoutMs === (request.operation?.kind === 'create' ? TRANSPORT_CONFIG.virtualMouse.cleanup_timeout_ms : 5000 - TRANSPORT_CONFIG.nativeInputResponseMarginMs)), JSON.stringify({ phase, native }));
      assert.equal((await owner.acquire(5000)).routeId, '17');
      await owner.finish();
      assert.deepEqual(f.sent.map(request => request.kind), ['route.local.open', 'route.local.close']);
      assert.equal(f.sent[0].durationMs, 9900, 'The shared App route retains the accepted command lifetime');
    }
  });
}
