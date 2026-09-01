import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("transport isolates generations and bounds handshake, error and stop lifecycles", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalPostMessage = globalThis.postMessage;
  const originalAddEventListener = globalThis.addEventListener;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const workerListeners = new Map();
  const published = [];
  const timers = [];

  class FakeWebSocket {
    static OPEN = 1;
    static instances = [];

    constructor(url, protocol) {
      this.url = url;
      this.protocol = protocol;
      this.readyState = 0;
      this.listeners = new Map();
      this.sent = [];
      FakeWebSocket.instances.push(this);
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    emit(type, event = {}) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }

    send(payload) {
      this.sent.push(new TextDecoder().decode(payload));
    }

    close(code = 1000) {
      if (code !== 1000 && (code < 3000 || code > 4999)) throw new DOMException("Invalid close code", "InvalidAccessError");
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit("close");
    }
  }

  globalThis.WebSocket = FakeWebSocket;
  globalThis.postMessage = (value) => published.push(value);
  globalThis.addEventListener = (type, listener) => workerListeners.set(type, listener);
  globalThis.setTimeout = (callback, milliseconds) => {
    const timer = { callback, milliseconds, active: true };
    timers.push(timer);
    return timers.length;
  };
  globalThis.clearTimeout = (id) => { timers[id - 1].active = false; };

  try {
    const workerUrl = pathToFileURL(
      path.join(workspaceRoot, "out", "extension", "transport-worker.js"),
    );
    await import(`${workerUrl.href}?test=${Date.now()}`);

    assert.equal(FakeWebSocket.instances.length, 1);
    const first = FakeWebSocket.instances[0];
    readySocket(first, "old-relay", ["native.input.click.v1"]);
    assert.deepEqual(published.at(-1), {
      kind: "transport.connected",
      connectionGeneration: 1,
      capabilities: ["native.input.click.v1"],
    });
    first.emit("message", { data: binaryJson({ kind: "route.request", routeId: "1" }) });
    const inbound = published.at(-1);
    assert.equal(inbound.kind, "transport.inbound");
    assert.equal(typeof inbound.connectionGeneration, "number");
    assert.deepEqual(inbound.capabilities, ["native.input.click.v1"]);

    first.close();
    const pendingTimers = timers.filter((timer) => timer.active);
    assert.equal(pendingTimers.length, 1);
    assert.equal(pendingTimers[0].milliseconds, 10_000);
    pendingTimers[0].active = false;
    pendingTimers[0].callback();

    assert.equal(FakeWebSocket.instances.length, 2);
    const second = FakeWebSocket.instances[1];
    readySocket(second, "new-relay");
    second.emit("message", { data: binaryJson({ kind: "route.request", routeId: "2" }) });
    const currentInbound = published.at(-1);
    assert.equal(currentInbound.kind, "transport.inbound");
    assert.notEqual(currentInbound.connectionGeneration, inbound.connectionGeneration);
    const messageListener = workerListeners.get("message");
    assert.equal(typeof messageListener, "function");

    const sentBeforeStaleResponse = second.sent.length;
    messageListener({
      data: {
        kind: "transport.outbound",
        connectionGeneration: inbound.connectionGeneration,
        payload: { kind: "route.response", routeId: "1", payload: { secret: "old" } },
      },
    });
    assert.equal(second.sent.length, sentBeforeStaleResponse);

    messageListener({
      data: {
        kind: "transport.outbound",
        connectionGeneration: currentInbound.connectionGeneration,
        payload: { kind: "route.response", routeId: "2", payload: { value: "current" } },
      },
    });
    assert.equal(second.sent.length, sentBeforeStaleResponse + 1);
    assert.match(second.sent.at(-1), /"value":"current"/u);

    const fireOnlyTimer = () => {
      const active = timers.filter((timer) => timer.active);
      assert.equal(active.length, 1);
      assert.equal(active[0].milliseconds, 10_000);
      active[0].active = false;
      active[0].callback();
    };
    second.close();
    fireOnlyTimer(); // reconnect
    const connecting = FakeWebSocket.instances.at(-1);
    fireOnlyTimer(); // no WebSocket open before handshake deadline
    assert.equal(connecting.readyState, 3);
    fireOnlyTimer(); // reconnect
    const noHello = FakeWebSocket.instances.at(-1);
    noHello.readyState = FakeWebSocket.OPEN;
    noHello.emit("open");
    fireOnlyTimer(); // open socket, no relay hello
    assert.equal(noHello.readyState, 3);
    fireOnlyTimer();
    const noReady = FakeWebSocket.instances.at(-1);
    noReady.readyState = FakeWebSocket.OPEN;
    noReady.emit("open");
    noReady.emit("message", { data: binaryJson({ kind: "relay.hello", product: "browser-key-automation",
      transportProfile: "browser-key-loopback-v1", protocolVersion: 1, relayEpoch: "no-ready" }) });
    fireOnlyTimer(); // hello is not application readiness
    assert.equal(noReady.readyState, 3);
    fireOnlyTimer();
    const errored = FakeWebSocket.instances.at(-1);
    errored.close = () => { errored.readyState = 3; }; // no close callback ever arrives
    errored.emit("error");
    assert.equal(errored.readyState, 3);
    readySocket(noReady, "late-ready"); // stale callbacks must not clear the new reconnect timer
    assert.equal(timers.filter((timer) => timer.active).length, 1);
    fireOnlyTimer();
    const invalidHello = FakeWebSocket.instances.at(-1);
    invalidHello.readyState = FakeWebSocket.OPEN;
    invalidHello.emit("open");
    invalidHello.emit("message", { data: binaryJson({ kind: "wrong-hello" }) });
    assert.equal(invalidHello.readyState, 3);
    fireOnlyTimer();
    const malformed = FakeWebSocket.instances.at(-1);
    readySocket(malformed, "malformed-body");
    malformed.emit("message", { data: new Uint8Array([0xc3, 0x28]).buffer });
    assert.equal(malformed.readyState, 3);
    assert.equal(timers.filter((timer) => timer.active).length, 1);
    messageListener({ data: { kind: "transport.stop" } });
    assert.equal(timers.filter((timer) => timer.active).length, 0);
  } finally {
    globalThis.WebSocket = originalWebSocket;
    globalThis.postMessage = originalPostMessage;
    globalThis.addEventListener = originalAddEventListener;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

function readySocket(socket, relayEpoch, capabilities) {
  socket.readyState = FakeOpenState();
  socket.emit("open");
  socket.emit("message", {
    data: binaryJson({
      kind: "relay.hello",
      product: "browser-key-automation",
      transportProfile: "browser-key-loopback-v1",
      protocolVersion: 1,
      relayEpoch,
    }),
  });
  const ready = { kind: "role.ready", role: "extension" };
  if (capabilities !== undefined) ready.capabilities = capabilities;
  socket.emit("message", { data: binaryJson(ready) });
}

function FakeOpenState() {
  return globalThis.WebSocket.OPEN;
}

function binaryJson(value) {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
}
