import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

test("offscreen diagnostics retain status only while forwarding the full request and generation", async () => {
  const messages = [];
  const outbound = [];
  const listeners = new Map();
  let runtimeListener;
  let nativeResponse;
  let timerId = 0;
  const timers = new Map();
  const context = vm.createContext({
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
  const source = readFileSync(new URL("../out/extension/offscreen.js", import.meta.url), "utf8");
  const executable = source.replace(
    /import \{[\s\S]*?\} from "\.\/shared\/native-input-protocol\.js";\s*/u,
    `const NATIVE_INPUT_MESSAGE_CHANNEL = "browser-key-automation.native-input.v1";
     const isNativeInputClickResponse = (value) => value?.kind === "native.input.result" &&
       typeof value.requestId === "string" && typeof value.ok === "boolean";\n`,
  ).replace("export {};", "");
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
    kind: "transport.connected", connectionGeneration: 7, capabilities: ["native.input.click.v1"],
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
});
