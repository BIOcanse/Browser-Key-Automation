import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NativeWebSocket } from "../apps/client/src/native-websocket.mjs";
import { assertIsolatedFixture } from "./lib/isolation.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assertIsolatedFixture(workspaceRoot);
const executable = path.join(workspaceRoot, "zig-out", "bin", "browser-key-relay.exe");
const manifest = JSON.parse(
  await readFile(path.join(workspaceRoot, "apps", "extension", "manifest.json"), "utf8"),
);
const extensionOrigin = `chrome-extension://${extensionIdFromManifestKey(manifest.key)}`;
const relay = spawn(executable, [], {
  cwd: workspaceRoot,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});

let relayOutput = "";
relay.stdout.setEncoding("utf8");
relay.stderr.setEncoding("utf8");
relay.stdout.on("data", (chunk) => {
  relayOutput += chunk;
});
relay.stderr.on("data", (chunk) => {
  relayOutput += chunk;
});

const sockets = [];
try {
  await waitUntil(() => relayOutput.includes("relay listening"), 5000, "relay startup");

  const client = await NativeWebSocket.connect({
    path: "/v1/client",
    subprotocol: "browser-key-client-v1",
  });
  sockets.push(client);
  const clientHello = await client.readJson();
  assert.equal(clientHello.kind, "relay.hello");
  client.sendJson({ kind: "role.hello", role: "client", protocolVersion: 1 });
  assert.deepEqual(await client.readJson(), { kind: "role.ready", role: "client" });

  client.sendJson({ kind: "instances.list" });
  const emptyList = await client.readJson();
  assert.equal(emptyList.kind, "instances.list.result");
  assert.deepEqual(emptyList.instances, []);

  await assert.rejects(
    NativeWebSocket.connect({
      path: "/v1/extension",
      subprotocol: "browser-key-extension-v1",
      origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    }),
    /Relay closed during HTTP upgrade|Unexpected upgrade status/u,
  );

  const firstExtension = await connectExtension();
  sockets.push(firstExtension);
  client.sendJson({ kind: "instances.list" });
  const firstList = await client.readJson();
  assert.equal(firstList.instances.length, 1);
  assert.equal(firstList.instances[0].instanceNumber, "1");
  assert.equal(firstList.instances[0].relayEpoch, firstList.relayEpoch);

  const pendingRequest = {
    kind: "forward", clientRequestId: "disconnect-pending", targetInstance: firstList.instances[0],
    auth: { apiKey: "synthetic-key" }, command: { method: "system.describe", schemaVersion: 1, params: {} },
  };
  client.sendJson(pendingRequest);
  const routed = await firstExtension.readJson();
  assert.equal(routed.kind, "route.request", "request reached the retiring instance");
  firstExtension.sendJson({
    kind: "native.input.keyboard",
    requestId: "nk1.reset-route-owned",
    routeId: routed.routeId,
    timeoutMs: 1000,
    marker: null,
    operation: { kind: "reset" },
  });
  const resetResult = await firstExtension.readJson();
  assert.equal(resetResult.kind, "native.keyboard.result");
  if (process.platform === "win32") {
    assert.deepEqual(resetResult, {
      kind: "native.keyboard.result",
      requestId: "nk1.reset-route-owned",
      ok: true,
      result: { status: "input_sent", completedActions: 0, submittedScalars: 0, correctedMistakes: 0, heldVirtualKeys: [] },
    });
  } else {
    assert.equal(resetResult.ok, false);
    assert.equal(resetResult.error.reason, "backend_unavailable");
  }
  firstExtension.sendJson({
    kind: "native.input.keyboard",
    requestId: "nk1.stale-route",
    routeId: "999999",
    timeoutMs: 1000,
    marker: null,
    operation: { kind: "reset" },
  });
  const staleKeyboard = await firstExtension.readJson();
  assert.deepEqual(staleKeyboard.error, {
    reason: "stale_route", phase: "prepare", inputState: "not_sent", completedActions: 0,
  });
  firstExtension.close();
  assert.deepEqual(await client.readJson(), { kind: "transport.error", error: "EXTENSION_DISCONNECTED" });
  client.sendJson({ ...pendingRequest, clientRequestId: "after-unregister" });
  assert.deepEqual(await client.readJson(), { kind: "transport.error", error: "STALE_INSTANCE" });
  await waitUntilAsync(async () => {
    client.sendJson({ kind: "instances.list" });
    return (await client.readJson()).instances.length === 0;
  }, 5000, "extension unregister");

  const secondExtension = await connectExtension();
  sockets.push(secondExtension);
  client.sendJson({ kind: "instances.list" });
  const secondList = await client.readJson();
  assert.equal(secondList.instances.length, 1);
  assert.equal(secondList.instances[0].instanceNumber, "2");

  client.sendJson({ kind: "relay.stop" });
  assert.deepEqual(await client.readJson(), { kind: "relay.stopping" });
  const exit = await waitForExit(relay, 5000);
  assert.equal(exit.code, 0, `relay output:\n${relayOutput}`);

  console.log(
    JSON.stringify({
      ok: true,
      relayEpochChangedOnlyOnProcessStart: true,
      instanceNumbers: ["1", "2"],
      relayStoppedByCommand: true,
      pendingRouteFailedAndLateWriteRejected: true,
    }),
  );
} finally {
  for (const socket of sockets) socket.close();
  if (relay.exitCode === null) relay.kill();
}

async function connectExtension() {
  const socket = await NativeWebSocket.connect({
    path: "/v1/extension",
    subprotocol: "browser-key-extension-v1",
    origin: extensionOrigin,
  });
  const hello = await socket.readJson();
  assert.equal(hello.kind, "relay.hello");
  socket.sendJson({ kind: "role.hello", role: "extension", protocolVersion: 1 });
  assert.deepEqual(await socket.readJson(), {
    kind: "role.ready",
    role: "extension",
    capabilities: process.platform === "win32" ? ["native.input.click.v1", "native.input.keyboard.v1"] : [],
  });
  return socket;
}

function extensionIdFromManifestKey(key) {
  assert.equal(typeof key, "string");
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return Array.from(hex, (nibble) =>
    String.fromCharCode("a".charCodeAt(0) + Number.parseInt(nibble, 16)),
  ).join("");
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}: ${relayOutput}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitUntilAsync(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for relay exit: ${relayOutput}`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}
