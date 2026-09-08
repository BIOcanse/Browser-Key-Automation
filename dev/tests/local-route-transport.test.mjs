import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import * as native from '../../out/extension/shared/native-input-protocol.js';
import * as virtual from '../../out/extension/shared/virtual-input-protocol.js';
import * as local from '../../out/extension/shared/local-route-protocol.js';
import * as recording from '../../out/extension/shared/native-recording-protocol.js';
import { TRANSPORT_CONFIG } from '../../out/extension/generated/transport-config.js';

function fixture() {
  const outbound = [], delivered = [], listeners = new Map(), timers = new Map();
  let listener, timerId = 0;
  const context = vm.createContext({ ...native, ...virtual, ...local, ...recording, TRANSPORT_CONFIG,
    document: { title: '' }, Date, crypto,
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { throw new Error('No input retirement expected'); }, clearInterval() {},
    Worker: class { addEventListener(kind, callback) { listeners.set(kind, callback); } postMessage(value) { outbound.push(value); } },
    chrome: { runtime: { id: 'fixture', getURL: value => value,
      onMessage: { addListener(value) { listener = value; } }, async sendMessage(value) { delivered.push(value); } } },
  });
  const source = readFileSync(new URL('../../out/extension/offscreen.js', import.meta.url), 'utf8').replace(/^import .*;\s*/gmu, '').replace('export {};', '');
  vm.runInContext(source, context);
  const connection = { connectionGeneration: 7, relayEpoch: 'A'.repeat(22) };
  const worker = value => listeners.get('message')({ data: value });
  worker({ kind: 'transport.connected', ...connection, capabilities: [TRANSPORT_CONFIG.localRouteCapability, TRANSPORT_CONFIG.nativeRecordingCapability] });
  return { outbound, delivered, timers, connection, worker, error: () => listeners.get('error')(),
    request(payload, expected = connection) { const replies = []; const admitted = listener({ channel: native.NATIVE_INPUT_MESSAGE_CHANNEL, ...expected, timeoutMs: 100, payload }, { id: 'fixture' }, value => replies.push(structuredClone(value))); return { replies, admitted }; },
    timeout() { assert.equal(timers.size, 1); [...timers.values()][0](); },
  };
}
const open = (requestId = 'open') => ({ kind: 'route.local.open', requestId, durationMs: 1000 });
const success = requestId => ({ kind: 'route.local.result', requestId, ok: true, result: { routeId: '17' } });

test('recording receipts stay on their connection and boundary points cannot enter the raw stream', () => {
  const f=fixture(),resourceId='4ac9818f-f09f-408c-b0c6-c87e3046659b',backgroundMessages=f.delivered.length;
  const event={sequence:1,kind:4,phase:3,message:0x200,threadId:13,messageTime:100,dpi:96,
    hwnd:'0000000000000001',keyboardLayout:'fedcba9876543210',qpc:'9007199254740993',
    window:{left:-50,top:20,right:50,bottom:120},clientScreen:{left:-50,top:20,right:50,bottom:120},visible:true,iconic:false,point:null,
    wParam:'0000000000000000',keyLParam:'0000000000000000',position:{x:0,y:0,width:0,height:0,flags:0},suggestedRect:{left:0,top:0,right:0,bottom:0}};
  assert.equal(recording.isNativeRecordingEvent(event),true);
  assert.equal(recording.isNativeRecordingEvent({...event,point:{x:-1000,y:-1000}}),false);
  assert.equal(recording.isNativeRecordingEvent({...event,kind:3,point:{x:50,y:30}}),false);
  assert.equal(recording.isNativeRecordingEvent({...event,kind:3,point:{x:-20,y:30}}),true);
  assert.equal(recording.isNativeRecordingEvent({...event,kind:3,visible:false,point:{x:-20,y:30}}),true,'preserve a received event from a hidden window; match the native producer filter');
  const request={kind:'native.recording',requestId:'recording-read',timeoutMs:50,operation:{kind:'read',resourceId,acknowledgeThrough:0,limit:32}};
  const pending=f.request(request);
  const response={kind:'native.recording.result',requestId:request.requestId,ok:true,result:{resourceId,outcome:'ok',events:[event],status:null,calibration:null}};
  f.worker({kind:'transport.inbound',...f.connection,connectionGeneration:6,payload:response});
  f.worker({kind:'transport.inbound',...f.connection,relayEpoch:'B'.repeat(22),payload:response});
  assert.equal(pending.replies.length,0);
  f.worker({kind:'transport.inbound',...f.connection,payload:response});
  assert.deepEqual(pending.replies,[response]);
  assert.equal(f.delivered.length,backgroundMessages,'native replies do not reach the background dispatcher');
  const timed=f.request({...request,requestId:'recording-timed'});f.timeout();
  assert.equal(timed.replies[0].error.reason,'native_response_timeout');
  f.worker({kind:'transport.inbound',...f.connection,payload:{...response,requestId:'recording-timed'}});
  assert.equal(timed.replies.length,1);assert.equal(f.outbound.length,2,'no retry after an uncertain native operation');
});

test('local control uses closed schemas and keeps original receipt distinct from timeout', () => {
  const request = open();
  assert.equal(local.isLocalRouteRequest({ ...request, apiKey: 'forbidden' }), false);
  assert.equal(local.isLocalRouteResponse({ ...success('open'), result: { closed: true } }, request), false);
  assert.equal(local.isLocalRouteResponse({ ...success('open'), result: { routeId: '18446744073709551616' } }, request), false);
  const f = fixture(), pending = f.request(request);
  assert.equal(pending.admitted, true); assert.equal(f.outbound.length, 1);
  f.worker({ kind: 'transport.inbound', ...f.connection, payload: success('open') });
  assert.equal(pending.replies[0].confirmed, true); assert.equal(pending.replies[0].response.result.routeId, '17');
  assert.equal(f.timers.size, 0);
  const timed = f.request(open('timed'));
  f.timeout(); assert.equal(timed.replies[0].confirmed, false);
  assert.equal(timed.replies[0].response.error.reason, 'local_route_response_timeout');
  const reused = f.request(open('timed'));
  assert.equal(reused.admitted, undefined);
  assert.equal(reused.replies[0].response.error.reason, 'duplicate_request');
  assert.equal(f.outbound.length, 2);
  const before = f.delivered.length;
  f.worker({ kind: 'transport.inbound', ...f.connection, payload: success('timed') });
  assert.equal(timed.replies.length, 1); assert.equal(f.outbound.length, 2); assert.equal(f.delivered.length, before);
  const afterReceipt = f.request(open('timed'));
  assert.equal(afterReceipt.admitted, true); assert.equal(afterReceipt.replies.length, 0);
  f.worker({ kind: 'transport.inbound', ...f.connection, payload: { ...success('timed'), result: { routeId: '18' } } });
  assert.equal(afterReceipt.replies[0].response.result.routeId, '18');
});

test('local receipts and sends are pinned to both connection generation and App epoch', () => {
  const f = fixture(), pending = f.request(open());
  f.worker({ kind: 'transport.inbound', ...f.connection, relayEpoch: 'B'.repeat(22), payload: success('open') });
  assert.equal(pending.replies.length, 0);
  f.worker({ kind: 'transport.disconnected' });
  assert.equal(pending.replies[0].confirmed, false);
  f.worker({ kind: 'transport.connected', ...f.connection, relayEpoch: 'B'.repeat(22), capabilities: [TRANSPORT_CONFIG.localRouteCapability] });
  const before = f.outbound.length;
  const stale = f.request(open('stale'));
  assert.equal(stale.replies[0].response.error.reason, 'local_route_unavailable'); assert.equal(f.outbound.length, before);
  f.worker({ kind: 'transport.inbound', ...f.connection, payload: success('open') });
  assert.equal(pending.replies.length, 1);
});

test('malformed responses and worker failure settle only the existing request without resending', () => {
  const f = fixture(), pending = f.request(open());
  f.worker({ kind: 'transport.inbound', ...f.connection, payload: { ...success('open'), result: { closed: true } } });
  assert.equal(pending.replies[0].confirmed, false);
  assert.equal(pending.replies[0].response.error.reason, 'local_route_response_invalid');
  const next = f.request(open('next')); f.error();
  assert.equal(next.replies[0].response.error.reason, 'transport_worker_failed');
  assert.equal(f.timers.size, 0); assert.equal(f.outbound.length, 2);
  assert.equal(f.request(open('after')).replies[0].response.error.reason, 'local_route_unavailable');
});
