import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { isVirtualInputResponse, virtualInputFailure } from "../../out/extension/shared/virtual-input-protocol.js";
import { TRANSPORT_CONFIG } from "../../out/extension/generated/transport-config.js";

test("offscreen forwards requests without caching content and retires expired virtual mice without waking the background", async () => {
  const messages = [];
  const outbound = [];
  const listeners = new Map();
  let runtimeListener;
  let nativeResponse;
  let timerId = 0;
  const timers = new Map();
  const intervals = new Map();
  let now = 100;
  const context = vm.createContext({
    isVirtualInputResponse, virtualInputFailure, TRANSPORT_CONFIG,
    Date: { now: () => now },
    crypto: { randomUUID: () => `retirement-${++timerId}` },
    setInterval(callback) { timerId += 1; intervals.set(timerId, callback); return timerId; },
    clearInterval(id) { intervals.delete(id); },
    document: { title: "" },
    Worker: class {
      addEventListener(kind, listener) { listeners.set(kind, listener); }
      postMessage(value) { outbound.push(value); }
    },
    setTimeout(callback) { timerId += 1; timers.set(timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    chrome: { runtime: {
      id: "extension-id",
      getURL: (value) => value,
      onMessage: { addListener(listener) { runtimeListener = listener; } },
      async sendMessage(value) { messages.push(value); return { kind: "route.response", routeId: "123" }; },
    } },
  });
  const source = readFileSync(new URL("../../out/extension/offscreen.js", import.meta.url), "utf8");
  const executable = source.replace(
    /import \{[\s\S]*?\} from "\.\/shared\/native-input-protocol\.js";\s*/u,
    `const NATIVE_INPUT_MESSAGE_CHANNEL = "browser-key-automation.native-input.v1";
     const isNativeInputClickResponse = (value) => value?.kind === "native.input.result" &&
       typeof value.requestId === "string" && typeof value.ok === "boolean";
     const isNativeInputKeyboardResponse = (value) => value?.kind === "native.keyboard.result" &&
       typeof value.requestId === "string" && typeof value.ok === "boolean";\n`,
  ).replace(/^import .*virtual-input-protocol\.js";\s*/mu, "")
   .replace(/^import .*transport-config\.js";\s*/mu, "").replace("export {};", "");
  vm.runInContext(executable, context);
  const inbound = { kind: "transport.inbound", connectionGeneration: 7,
    payload: { kind: "route.request", apiKey: "synthetic-secret-must-not-be-cached", params: { body: "private page" } } };
  listeners.get("message")({ data: inbound });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.at(-1).payload, inbound, "the actual command is not redacted or dropped");
  const diagnostic = JSON.parse(JSON.stringify(context.__BKA_OFFSCREEN_DIAGNOSTIC));
  assert.deepEqual(diagnostic.lastWorkerState, { kind: "transport.inbound" });
  assert.equal(JSON.stringify(diagnostic).includes("synthetic-secret"), false);
  assert.equal(JSON.stringify(diagnostic).includes("private page"), false);
  assert.equal(context.document.title, "BKA transport.inbound");
  assert.equal(outbound.at(-1).connectionGeneration, 7);
  assert.equal(outbound.at(-1).payload.routeId, "123");

  listeners.get("message")({ data: {
    kind: "transport.connected", connectionGeneration: 7, capabilities: ["native.input.click.v1"], relayEpoch: "A".repeat(22),
  } });
  const nativeRequest = {
    kind: "native.input.click", requestId: "ni1.test", routeId: "1", timeoutMs: 1000,
    marker: "BKA real marker", point: { x: 1, y: 1 }, viewport: { width: 10, height: 10 },
  };
  assert.equal(runtimeListener(
    { channel: "browser-key-automation.native-input.v1", connectionGeneration: 7, timeoutMs: 1000, payload: nativeRequest },
    { id: "extension-id" },
    (value) => { nativeResponse = value; },
  ), true);
  assert.deepEqual(JSON.parse(JSON.stringify(outbound.at(-1))), {
    kind: "transport.outbound", connectionGeneration: 7, payload: nativeRequest,
  });
  listeners.get("message")({ data: { kind: "transport.inbound", connectionGeneration: 7, payload: {
    kind: "native.input.result", requestId: "ni1.test", ok: true, result: { status: "input_sent" },
  } } });
  assert.deepEqual(JSON.parse(JSON.stringify(nativeResponse)), {
    kind: "native.input.result", requestId: "ni1.test", ok: true, result: { status: "input_sent" },
  });
  assert.equal(messages.at(-1).payload.kind, "transport.connected", "native child response must not enter command dispatch");

  const keyboardRequest = {
    kind: "native.input.keyboard", requestId: "nk1.test", routeId: "2", timeoutMs: 1000,
    marker: null, operation: { kind: "reset" },
  };
  assert.equal(runtimeListener(
    { channel: "browser-key-automation.native-input.v1", connectionGeneration: 7, timeoutMs: 1000, payload: keyboardRequest },
    { id: "extension-id" },
    (value) => { nativeResponse = value; },
  ), true);
  listeners.get("message")({ data: { kind: "transport.inbound", connectionGeneration: 7, payload: {
    kind: "native.keyboard.result", requestId: "nk1.test", ok: true,
    result: { status: "input_sent", completedActions: 0, submittedScalars: 0, correctedMistakes: 0, heldVirtualKeys: [] },
  } } });
  assert.equal(nativeResponse.kind, "native.keyboard.result");
  const beforeLateReplies = messages.length;
  for (const kind of ["native.input.result", "native.keyboard.result", "native.virtualInput.result"]) {
    listeners.get("message")({ data: { kind: "transport.inbound", connectionGeneration: 7,
      payload: { kind, requestId: "already-timed-out", ok: false, error: { reason: "timeout" } } } });
  }
  assert.equal(messages.length, beforeLateReplies, "late native replies cannot enter routing and disconnect the extension with StaleRoute");

  const createMouse = (id, retireAt) => {
    const requestId = `vm.create.${id}`;
    assert.equal(runtimeListener(
      { channel: "browser-key-automation.native-input.v1", connectionGeneration: 7,
        timeoutMs: 1000, retireAt, payload: { kind: "native.virtualInput", requestId,
          routeId: "3", timeoutMs: 1000, operation: { kind: "create" } } },
      { id: "extension-id" }, (value) => { nativeResponse = value; },
    ), true);
    listeners.get("message")({ data: { kind: "transport.inbound", connectionGeneration: 7, payload: {
      kind: "native.virtualInput.result", requestId, ok: true,
      result: { completedActions: 0, input: { id, mouse: { point: { x: 1, y: 2 }, buttons: 0, known: true }, keyboard: { keys: Array(256).fill(0), known: true }, windows: [] } },
    } } });
    assert.equal(nativeResponse.ok, true);
  };
  const backgroundCount = messages.length;
  const lastTitle = context.document.title;
  createMouse(1, 200);
  createMouse(2, 300);
  assert.equal(intervals.size, 1, "all object deadlines share one bounded timer");
  const sentBeforeExpiry = outbound.length;
  intervals.values().next().value();
  assert.equal(outbound.length, sentBeforeExpiry, "live objects are not retired early");
  now = 200;
  intervals.values().next().value();
  assert.deepEqual(JSON.parse(JSON.stringify(outbound.at(-1).payload.operation)), { kind: "cleanup", inputId: "1" });
  assert.equal(outbound.at(-1).connectionGeneration, 7);
  assert.equal(outbound.at(-1).payload.routeId, undefined, "resource retirement is not a new Key command");
  listeners.get("message")({ data: { kind: "transport.inbound", connectionGeneration: 7, payload: {
    kind: "native.virtualInput.result", requestId: outbound.at(-1).payload.requestId, ok: true,
    result: { completedActions: 0, input: null },
  } } });
  assert.equal(messages.length, backgroundCount, "housekeeping must not dispatch into a sleeping worker");
  assert.equal(context.document.title, lastTitle, "housekeeping must not overwrite the connection diagnostic");
  now = 300;
  intervals.values().next().value();
  assert.equal(outbound.at(-1).payload.operation.inputId, "2");
  const firstCleanup = outbound.at(-1).payload;
  listeners.get("message")({ data: { kind: "transport.inbound", connectionGeneration: 7, payload: {
    kind: "native.virtualInput.result", requestId: firstCleanup.requestId, ok: false, error: { reason: "DetachFailed" },
  } } });
  intervals.values().next().value();
  assert.notEqual(outbound.at(-1).payload.requestId, firstCleanup.requestId, "failed cleanup retains responsibility and is retried, not forgotten");
  listeners.get("message")({ data: { kind: "transport.inbound", connectionGeneration: 7, payload: {
    kind: "native.virtualInput.result", requestId: outbound.at(-1).payload.requestId, ok: true,
    result: { completedActions: 0, input: null },
  } } });
  intervals.values().next().value();
  assert.equal(intervals.size, 0, "only acknowledged cleanup stops polling");

  createMouse(3, 400);
  listeners.get("message")({ data: { kind: "transport.disconnected", connectionGeneration: 7 } });
  assert.equal(intervals.size, 1, "disconnect is not proof of native cleanup");
  listeners.get("message")({ data: { kind: "transport.connected", connectionGeneration: 8, relayEpoch: "A".repeat(22), capabilities: [] } });
  let transport;
  runtimeListener({ channel: "browser-key-automation.native-input.v1", payload: { kind: "transport.state" } },
    { id: "extension-id" }, (value) => { transport = value; });
  assert.equal(transport.connectionGeneration, 8, "worker can recover a surviving connection without a routed command");
  now = 400; intervals.values().next().value();
  assert.equal(outbound.at(-1).connectionGeneration, 8);
  assert.equal(outbound.at(-1).payload.relayEpoch, "A".repeat(22));
});
