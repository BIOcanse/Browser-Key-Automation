import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import 'fake-indexeddb/auto';

const event = () => {
  const listeners = [];
  return { addListener(fn) { listeners.push(fn); }, emit(...args) { for (const fn of listeners) fn(...args); } };
};
let effects = 0, readGate = null;
const sessions = {};
globalThis.chrome = {
  runtime: { id: 'fixture', getURL: path => `chrome-extension://fixture/${path}`, getManifest: () => ({ name: 'fixture', version: 'test' }) },
  tabs: { onRemoved: event(), onReplaced: event(), async query() { return []; } },
  webNavigation: { onCommitted: event() },
  windows: { async get(windowId) { ++effects; if (readGate) await readGate; return { id: windowId, state: 'normal', focused: false, left: 0, top: 0, width: 800, height: 600 }; } },
  storage: { session: { async setAccessLevel() {}, async get(key) { return { [key]: sessions[key] }; }, async set(value) { Object.assign(sessions, value); } } },
};
const { attachAdminRouter, isTrustedAdminPort } = await import('../../out/extension/background/admin-router.js');
const { createKey, revokeKey } = await import('../../out/extension/background/key-service.js');
const { parseAdminRequest, ADMIN_PORT_NAME } = await import('../../out/extension/shared/admin-protocol.js');
const { readExecutionTrace } = await import('../../out/extension/background/execution-trace-service.js');
const mutation = () => `am1.${Date.now()}.${randomBytes(16).toString('base64url')}`;
const makeKey = permissions => createKey({ mutationId: mutation(), displayName: 'Admin commands fixture', keyKind: 'regular', permissions: permissions.sort(), expiresAt: null, enabled: true });
const instruction = { method: 'windows.get', schemaVersion: 1, params: { windowId: 7 } };
const params = (keyId, method, body = {}) => ({ keyId, command: { method, schemaVersion: 1, params: body } });
function port() {
  const pending = new Map();
  const value = { name: ADMIN_PORT_NAME, sender: { id: 'fixture', url: chrome.runtime.getURL('admin/actions.html') },
    onMessage: event(), onDisconnect: event(), postMessage(reply) { pending.get(reply.requestId)?.(reply); pending.delete(reply.requestId); } };
  attachAdminRouter(value);
  return { value, request(body) { const requestId = `ui1.${randomBytes(16).toString('base64url')}`;
    const promise = new Promise(resolve => pending.set(requestId, resolve));
    value.onMessage.emit({ requestId, method: 'commands.execute', params: body }); return promise;
  } };
}
const bridge = port();

test('admin command envelope keeps Key selection distinct from business auth and rejects extra fields', () => {
  const request = { requestId: 'ui1.AAAAAAAAAAAAAAAAAAAAAA', method: 'commands.execute', params: params('A'.repeat(22), 'actions.list') };
  assert.ok(parseAdminRequest(request));
  assert.equal(parseAdminRequest({ ...request, params: { ...request.params, apiKey: 'injected' } }), null);
  assert.equal(parseAdminRequest({ ...request, params: { ...request.params, command: { ...request.params.command, auth: 'root' } } }), null);
  assert.equal(isTrustedAdminPort(bridge.value), true);
  assert.equal(isTrustedAdminPort({ ...bridge.value, sender: { id: 'fixture', url: 'https://fixture/admin/actions.html' } }), false);
});

test('selected Key uses real dispatcher, stable IDs, revision checks, child permissions and trace', async () => {
  const owner = await makeKey(['actions.write', 'actions.read', 'actions.compile', 'actions.run', 'windows.read']);
  const call = async (method, body) => {
    const response = await bridge.request(params(owner.key.keyId, method, body));
    assert.equal(response.ok, true); assert.ok(!JSON.stringify(response).includes(owner.apiKey)); return response.result;
  };
  const created = await call('actions.create', { name: 'UI action', description: '', instructions: [instruction] });
  assert.equal(created.ok, true);
  const actionId = created.result.action.actionId;
  const duplicateName = await call('actions.create', { name: 'UI action', description: '', instructions: [instruction] });
  assert.notEqual(duplicateName.result.action.actionId, actionId);
  const updated = await call('actions.update', { actionId, revision: 1, name: 'updated', description: '', instructions: [instruction] });
  assert.equal(updated.result.action.revision, 2);
  const conflict = await call('actions.update', { actionId, revision: 1, name: 'stale', description: '', instructions: [instruction] });
  assert.equal(conflict.ok, false); assert.equal(conflict.error.details.reason, 'REVISION_CONFLICT');
  const ran = await call('actions.run', { actionId });
  assert.equal(ran.ok, true); assert.equal(ran.result.status, 'succeeded');
  const trace = await readExecutionTrace(owner.key.keyId, ran.trace.traceRef);
  assert.ok(trace.events.some(event => event.actionId === actionId && event.stepIndex === 0));
  const limited = await makeKey(['actions.run']);
  const before = effects;
  const forbidden = (await bridge.request(params(limited.key.keyId, 'actions.run', { actionId }))).result;
  assert.equal(forbidden.ok, false); assert.equal(forbidden.error.code, 'FORBIDDEN'); assert.equal(effects, before);
  const writeDenied = (await bridge.request(params(limited.key.keyId, 'actions.create', { name: 'forbidden', description: '', instructions: [instruction] }))).result;
  assert.equal(writeDenied.ok, false); assert.equal(writeDenied.error.code, 'FORBIDDEN');
  await revokeKey({ mutationId: mutation(), keyId: owner.key.keyId, expectedRevision: owner.key.recordRevision });
  const revoked = await bridge.request(params(owner.key.keyId, 'actions.list'));
  assert.equal(revoked.ok, false); assert.equal(revoked.error.code, 'KEY_NOT_FOUND');
});

test('empty virtual input reads and reset remain local without an App or offscreen API', async () => {
  const owner = await makeKey(['virtualMouse']);
  assert.equal(chrome.offscreen, undefined);
  assert.equal(chrome.runtime.sendMessage, undefined);
  for (const method of ['virtualMouse.get', 'virtualMouse.reset']) {
    const response = (await bridge.request(params(owner.key.keyId, method))).result;
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(response.result.initialized, false);
  }
});

test('disconnect during an admitted command does not cancel it or dispatch it again', async () => {
  const owner = await makeKey(['windows.read']);
  const route = port();
  let release;
  readGate = new Promise(resolve => { release = resolve; });
  const before = effects;
  const response = route.request(params(owner.key.keyId, 'windows.get', { windowId: 7 }));
  const deadline = Date.now() + 2000;
  while (effects === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(effects, before + 1, 'The admitted command reached its effect');
  route.value.onDisconnect.emit();
  route.value.onMessage.emit({ requestId: 'ui1.AAAAAAAAAAAAAAAAAAAAAA', method: 'commands.execute', params: params(owner.key.keyId, 'windows.get', { windowId: 7 }) });
  readGate = null; release();
  assert.equal((await response).result.ok, true); assert.equal(effects, before + 1);
});

test('UI request timeout and old Port replies never automatically resend an action', async () => {
  const ports = [];
  chrome.runtime.connect = () => {
    const value = { onMessage: event(), onDisconnect: event(), sent: [], postMessage(message) { this.sent.push(message); } };
    ports.push(value); return value;
  };
  globalThis.window = { setTimeout, clearTimeout };
  const { AdminPortClient, AdminRequestUncertainError } = await import('../../out/extension/admin/port-client.js');
  const client = new AdminPortClient();
  const timed = client.request('commands.execute', params('A'.repeat(22), 'actions.run', { actionId: 1 }), 1);
  await assert.rejects(timed, AdminRequestUncertainError);
  assert.equal(ports.length, 1); assert.equal(ports[0].sent.length, 1);
  ports[0].onDisconnect.emit();
  const next = client.request('commands.execute', params('A'.repeat(22), 'actions.list'), 1000);
  let settled = false; void next.then(() => { settled = true; });
  ports[0].onMessage.emit({ requestId: ports[1].sent[0].requestId, ok: true, result: 'old Port' });
  await Promise.resolve(); assert.equal(settled, false);
  ports[1].onMessage.emit({ requestId: ports[1].sent[0].requestId, ok: true, result: 'new Port' });
  assert.equal(await next, 'new Port'); assert.equal(ports.reduce((sum, port) => sum + port.sent.length, 0), 2);
});
