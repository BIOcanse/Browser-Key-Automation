import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NativeWebSocket } from "../apps/client/src/native-websocket.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { assertIsolatedFixture } = await import("./lib/isolation.mjs");
assertIsolatedFixture(workspaceRoot);
const relayExecutable =
  process.env.BKA_CLIENT_SMOKE_RELAY ??
  path.join(workspaceRoot, "zig-out", "bin", "browser-key-relay.exe");
const cli =
  process.env.BKA_CLIENT_SMOKE_CLI ??
  path.join(workspaceRoot, "apps", "client", "src", "main.mjs");
const manifest = JSON.parse(
  await readFile(path.join(workspaceRoot, "apps", "extension", "manifest.json"), "utf8"),
);
const extensionOrigin = `chrome-extension://${extensionIdFromManifestKey(manifest.key)}`;
const apiKey = `bk1.${"A".repeat(22)}.${"B".repeat(43)}`;

const relay = spawn(relayExecutable, [], {
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

let extension;
let secondExtension;
try {
  await waitUntil(() => relayOutput.includes("relay listening"), 5_000, "relay startup");

  const emptyInstances = await runCli(["instances", "--read-timeout-ms", "5000"]);
  assert.equal(emptyInstances.code, 0, emptyInstances.stderr);
  assert.deepEqual(emptyInstances.json.instances, []);
  const unavailable = await runCli(
    ["call", "--method", "system.describe", "--read-timeout-ms", "5000"],
    apiKey,
  );
  assert.equal(unavailable.code, 4, unavailable.stderr);
  assert.equal(unavailable.json.error.code, "EXTENSION_UNAVAILABLE");
  assert.equal(unavailable.json.delivery, "known_not_delivered");

  extension = await connectExtension();

  const instances = await runCli(["instances", "--read-timeout-ms", "5000"]);
  assert.equal(instances.code, 0, instances.stderr);
  assert.equal(instances.lines.length, 1);
  assert.equal(instances.json.ok, true);
  assert.equal(instances.json.command, "instances");
  assert.equal(instances.json.instances.length, 1);
  assert.equal(instances.json.instances[0].instanceNumber, "1");
  const currentInstance = `${instances.json.relayEpoch}/${instances.json.instances[0].instanceNumber}`;
  const stale = await runCli(
    [
      "call",
      "--method",
      "system.describe",
      "--instance",
      `${instances.json.relayEpoch}/999`,
      "--read-timeout-ms",
      "5000",
    ],
    apiKey,
  );
  assert.equal(stale.code, 4, stale.stderr);
  assert.equal(stale.json.error.code, "STALE_INSTANCE");
  assert.equal(stale.json.delivery, "known_not_delivered");

  secondExtension = await connectExtension();
  const multipleInstances = await runCli(["instances", "--read-timeout-ms", "5000"]);
  assert.equal(multipleInstances.json.instances.length, 2);
  const ambiguous = await runCli(
    ["call", "--method", "system.describe", "--read-timeout-ms", "5000"],
    apiKey,
  );
  assert.equal(ambiguous.code, 4, ambiguous.stderr);
  assert.equal(ambiguous.json.error.code, "TARGET_INSTANCE_REQUIRED");
  assert.equal(ambiguous.json.delivery, "known_not_delivered");
  await assert.rejects(extension.readJson(150), /Timed out/u);
  await assert.rejects(secondExtension.readJson(150), /Timed out/u);
  secondExtension.close();
  secondExtension = null;
  await waitForSingleInstance();

  const successfulCall = runCli(
    [
      "call",
      "--method",
      "system.describe",
      "--params-json",
      "{}",
      "--instance",
      currentInstance,
      "--read-timeout-ms",
      "5000",
    ],
    apiKey,
  );
  const successRoute = await readRouteOrCliExit(extension, successfulCall);
  assert.equal(successRoute.kind, "route.request");
  assert.equal(successRoute.payload.auth.apiKey, apiKey);
  assert.deepEqual(successRoute.payload.command, {
    method: "system.describe",
    schemaVersion: 1,
    params: {},
  });
  extension.sendJson({
    kind: "route.response",
    routeId: successRoute.routeId,
    payload: {
      clientRequestId: successRoute.payload.clientRequestId,
      ok: true,
      result: {
        product: "browser-key-automation",
        reflectedCredential: apiKey,
        embeddedCredential: `before:${apiKey}:after`,
      },
      trace: { state: "complete", traceRef: `xr1.${"T".repeat(43)}` },
    },
  });
  const success = await successfulCall;
  assert.equal(success.code, 0, success.stderr);
  assert.equal(success.lines.length, 1);
  assert.equal(success.json.ok, true);
  assert.equal(success.json.delivery, "extension_response");
  assert.deepEqual(success.json.trace, { state: "complete", traceRef: `xr1.${"T".repeat(43)}` });
  assert.deepEqual(success.json.result, {
    product: "browser-key-automation",
    reflectedCredential: "[REDACTED_API_KEY]",
    embeddedCredential: "before:[REDACTED_API_KEY]:after",
  });
  assert.equal(success.stdout.includes(apiKey), false);
  assert.equal(success.stderr.includes(apiKey), false);

  const rejectedCall = runCli(
    ["call", "--method", "tabs.list", "--params-json", "{\"afterTabId\":null,\"limit\":10}", "--read-timeout-ms", "5000"],
    apiKey,
  );
  const rejectedRoute = await readRouteOrCliExit(extension, rejectedCall);
  extension.sendJson({
    kind: "route.response",
    routeId: rejectedRoute.routeId,
    payload: {
      clientRequestId: rejectedRoute.payload.clientRequestId,
      ok: false,
      error: { code: "FORBIDDEN", details: { reflectedCredential: apiKey } },
      trace: { state: "not_admitted", traceRef: null },
    },
  });
  const rejected = await rejectedCall;
  assert.equal(rejected.code, 5, rejected.stderr);
  assert.equal(rejected.lines.length, 1);
  assert.equal(rejected.json.ok, false);
  assert.equal(rejected.json.delivery, "extension_response");
  assert.deepEqual(rejected.json.trace, { state: "not_admitted", traceRef: null });
  assert.deepEqual(rejected.json.error, {
    code: "FORBIDDEN",
    details: { reflectedCredential: "[REDACTED_API_KEY]" },
  });
  assert.equal(rejected.stdout.includes(apiKey), false);
  assert.equal(rejected.stderr.includes(apiKey), false);

  const partialCall = runCli(
    ["call", "--method", "tabs.list", "--params-json", "{\"afterTabId\":null,\"limit\":10}", "--read-timeout-ms", "5000"],
    apiKey,
  );
  const partialRoute = await readRouteOrCliExit(extension, partialCall);
  extension.sendJson({
    kind: "route.response",
    routeId: partialRoute.routeId,
    payload: {
      clientRequestId: partialRoute.payload.clientRequestId,
      ok: false,
      error: { code: "INTERNAL_ERROR" },
      trace: { state: "partial", traceRef: `xr1.${"P".repeat(43)}` },
    },
  });
  const partial = await partialCall;
  assert.equal(partial.code, 5, partial.stderr);
  assert.deepEqual(partial.json.trace, { state: "partial", traceRef: `xr1.${"P".repeat(43)}` });

  const unavailableCall = runCli(
    ["call", "--method", "system.describe", "--params-json", "{}", "--read-timeout-ms", "5000"],
    apiKey,
  );
  const unavailableRoute = await readRouteOrCliExit(extension, unavailableCall);
  extension.sendJson({
    kind: "route.response",
    routeId: unavailableRoute.routeId,
    payload: {
      clientRequestId: unavailableRoute.payload.clientRequestId,
      ok: true,
      result: { product: "browser-key-automation" },
      trace: { state: "unavailable", traceRef: null },
    },
  });
  const traceUnavailable = await unavailableCall;
  assert.equal(traceUnavailable.code, 0, traceUnavailable.stderr);
  assert.deepEqual(traceUnavailable.json.trace, { state: "unavailable", traceRef: null });

  const malformedTraceCall = runCli(
    ["call", "--method", "system.describe", "--params-json", "{}", "--read-timeout-ms", "5000"],
    apiKey,
  );
  const malformedTraceRoute = await readRouteOrCliExit(extension, malformedTraceCall);
  extension.sendJson({
    kind: "route.response",
    routeId: malformedTraceRoute.routeId,
    payload: {
      clientRequestId: malformedTraceRoute.payload.clientRequestId,
      ok: true,
      result: {},
      trace: { state: "complete", traceRef: null },
    },
  });
  const malformedTrace = await malformedTraceCall;
  assert.equal(malformedTrace.code, 6, malformedTrace.stderr);
  assert.equal(malformedTrace.json.error.code, "ROUTE_RESPONSE_INVALID");
  assert.equal(malformedTrace.json.delivery, "unknown");

  const noKey = await runCli(
    ["call", "--method", "system.describe", "--read-timeout-ms", "5000"],
    null,
  );
  assert.equal(noKey.code, 2, noKey.stderr);
  assert.equal(noKey.lines.length, 1);
  assert.equal(noKey.json.error.code, "API_KEY_UNAVAILABLE");
  assert.equal(noKey.json.delivery, "known_not_delivered");

  const disconnectedCall = runCli(
    ["call", "--method", "system.describe", "--read-timeout-ms", "5000"],
    apiKey,
  );
  await readRouteOrCliExit(extension, disconnectedCall);
  extension.close();
  extension = null;
  const disconnected = await disconnectedCall;
  assert.equal(disconnected.code, 4, disconnected.stderr);
  assert.equal(disconnected.json.error.code, "EXTENSION_DISCONNECTED");
  assert.equal(disconnected.json.delivery, "unknown");

  const stop = await runCli(["stop", "--read-timeout-ms", "5000"]);
  assert.equal(stop.code, 0, stop.stderr);
  assert.equal(stop.lines.length, 1);
  assert.equal(stop.json.ok, true);
  assert.equal(stop.json.stopping, true);
  assert.equal((await waitForExit(relay, 5_000)).code, 0, relayOutput);

  console.log(
    JSON.stringify({
      ok: true,
      productClientOwnsWebSocketImplementation: true,
      instancesBeforeKey: true,
      instanceSelectionStates: ["zero", "single", "multiple", "explicit-current", "explicit-stale"],
      callRoundTrip: true,
      businessErrorExitCode: 5,
      extensionDisconnectDelivery: "unknown",
      apiKeyRedactedFromCliOutput: true,
      relayStoppedByCli: true,
    }),
  );
} finally {
  extension?.close();
  secondExtension?.close();
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

async function runCli(args, key = undefined) {
  const environment = { ...process.env };
  delete environment.BKA_API_KEY;
  if (key !== undefined && key !== null) environment.BKA_API_KEY = key;
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: workspaceRoot,
    env: environment,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = await waitForExit(child, 10_000);
  const lines = stdout.trim().length === 0 ? [] : stdout.trimEnd().split(/\r?\n/u);
  return {
    ...exit,
    stdout,
    stderr,
    lines,
    json: lines.length === 1 ? JSON.parse(lines[0]) : null,
  };
}

async function readRouteOrCliExit(socket, cliPromise) {
  return Promise.race([
    socket.readJson(7_000),
    cliPromise.then((result) => {
      throw new Error(
        `CLI exited before extension route: code=${result.code} stdout=${result.stdout} stderr=${result.stderr} relay=${relayOutput}`,
      );
    }),
  ]);
}

async function waitForSingleInstance() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await runCli(["instances", "--read-timeout-ms", "5000"]);
    if (result.code === 0 && result.json.instances.length === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for one extension instance");
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

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      child.kill();
      reject(new Error("Timed out waiting for child process"));
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
