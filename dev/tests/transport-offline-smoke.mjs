import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CdpClient, runtimeEvaluate } from "./lib/cdp-client.mjs";
import { assertIsolatedFixture } from "./lib/isolation.mjs";
import { NativeWebSocket } from "../../app/client/src/native-websocket.mjs";
import { TRANSPORT_CONFIG } from "../../out/extension/generated/transport-config.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
assertIsolatedFixture(workspace);
const extension = path.join(workspace, "out", "extension");
const artifacts = path.join(workspace, "out", "test-artifacts");
await mkdir(artifacts, { recursive: true });
const root = await mkdtemp(path.join(artifacts, "transport-offline-"));
const browserRoot = "D:\\Code\\CommonAssets\\Tools\\PlaywrightBrowsers";
const browserDirectories = existsSync(browserRoot) ? readdirSync(browserRoot)
  .filter(name => /^chromium-\d+$/u.test(name)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9))) : [];
const executable = process.env.BKA_CHROMIUM_PATH ?? browserDirectories
  .map(name => path.join(browserRoot, name, "chrome-win64", "chrome.exe")).find(existsSync);
assert.ok(executable, "Set BKA_CHROMIUM_PATH to the test Chromium executable");
const portReservation = net.createServer();
await new Promise(resolve => portReservation.listen(0, "127.0.0.1", resolve));
const debugPort = portReservation.address().port;
await new Promise(resolve => portReservation.close(resolve));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function waitFor(read, description, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out: ${description}`);
}
const browser = spawn(executable, [
  `--user-data-dir=${path.join(root, "profile")}`, `--remote-debugging-port=${debugPort}`,
  `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
  "--enable-extensions", "--enable-unsafe-extension-debugging", "--headless=new",
  "--no-first-run", "--no-sandbox", "--no-default-browser-check", "--disable-default-apps",
  "--disable-sync", "--disable-background-networking",
  "--disable-features=Translate,AutofillServerCommunication,DisableLoadExtensionCommandLineSwitch",
  "--proxy-server=direct://", "--proxy-bypass-list=*", "about:blank",
], { cwd: workspace, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let browserOutput = "";
browser.stderr.on("data", chunk => { browserOutput = (browserOutput + String(chunk)).slice(-65536); });
let relay;
let relayOutput = "";
const clients = [];
const evidence = { root, phases: [] };
let browserClient;
async function startRelay() {
  const outputStart = relayOutput.length;
  relay = spawn(path.join(workspace, "zig-out", "bin", "browser-key-relay.exe"), [],
    { cwd: workspace, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [relay.stdout, relay.stderr]) stream.on("data", chunk => { relayOutput += String(chunk); });
  await waitFor(() => relayOutput.slice(outputStart).includes("relay listening"), "App startup", 10000);
}
async function control() {
  const socket = await NativeWebSocket.connect({ path: "/v1/client", subprotocol: "browser-key-client-v1" });
  assert.equal((await socket.readJson()).kind, "relay.hello");
  socket.sendJson({ kind: "role.hello", role: "client", protocolVersion: 1 });
  assert.equal((await socket.readJson()).kind, "role.ready");
  return socket;
}
async function stopRelay() {
  const socket = await control();
  try {
    socket.sendJson({ kind: "relay.stop" });
    assert.equal((await socket.readJson()).kind, "relay.stopping");
  } finally { await socket.close(); }
  await waitFor(() => relay.exitCode !== null, "App shutdown", 10000);
  assert.equal(relay.exitCode, 0);
}
try {
  const version = await waitFor(async () => {
    try { return await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); } catch { return null; }
  }, "Chromium startup");
  evidence.browser = version.Browser;
  browserClient = await CdpClient.connect(version.webSocketDebuggerUrl);
  clients.push(browserClient);
  const targetList = () => fetch(`http://127.0.0.1:${debugPort}/json/list`).then(response => response.json());
  const worker = await waitFor(async () => (await targetList()).find(target =>
    target.type === "service_worker" && target.url === `chrome-extension://${TRANSPORT_CONFIG.expectedExtensionId}/background.js`), "extension worker");
  const workerClient = await CdpClient.connect(worker.webSocketDebuggerUrl);
  clients.push(workerClient);
  await workerClient.send("Runtime.enable");
  const { targetId } = await browserClient.send("Target.createTarget", { url: "chrome://extensions" });
  const extensionTarget = await waitFor(async () => (await targetList()).find(target => target.id === targetId), "extension management page");
  const extensionsClient = await CdpClient.connect(extensionTarget.webSocketDebuggerUrl);
  clients.push(extensionsClient);
  await extensionsClient.send("Runtime.enable");
  await runtimeEvaluate(extensionsClient, `new Promise(resolve => chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true}, resolve))`);
  await runtimeEvaluate(extensionsClient, `new Promise(resolve => chrome.developerPrivate.updateExtensionConfiguration({extensionId:'${TRANSPORT_CONFIG.expectedExtensionId}', errorCollection:true}, resolve))`);
  const state = () => runtimeEvaluate(workerClient, `chrome.runtime.sendMessage({channel:'browser-key-automation.native-input.v1',payload:{kind:'transport.state'}})`);
  const errors = () => runtimeEvaluate(extensionsClient, `new Promise(resolve => chrome.developerPrivate.getExtensionInfo('${TRANSPORT_CONFIG.expectedExtensionId}', info => resolve(info.runtimeErrors)))`);
  async function checkpoint(phase, connected) {
    const current = await state();
    assert.equal(current.connectionGeneration !== null, connected, JSON.stringify(current));
    const entries = await errors();
    assert.deepEqual(entries, [], `Unexpected extension errors during ${phase}`);
    evidence.phases.push({ phase, state: current, errors: entries });
    console.log(`Transport verified: ${phase}`);
  }
  await sleep(TRANSPORT_CONFIG.retryIntervalMs * 2 + 500);
  await checkpoint("App absent across repeated retries", false);
  await startRelay();
  await waitFor(async () => (await state()).connectionGeneration !== null, "automatic initial connection");
  await checkpoint("App started and automatically connected", true);
  const firstEpoch = (await state()).relayEpoch;
  await stopRelay();
  await waitFor(async () => (await state()).connectionGeneration === null, "disconnection");
  await sleep(TRANSPORT_CONFIG.retryIntervalMs + 500);
  await checkpoint("App stopped and offline retry remained quiet", false);
  await startRelay();
  await waitFor(async () => (await state()).connectionGeneration !== null, "automatic reconnection");
  assert.notEqual((await state()).relayEpoch, firstEpoch);
  await checkpoint("App restarted and automatically reconnected", true);
  const socket = await control();
  try {
    socket.sendJson({ kind: "instances.list" });
    assert.equal((await socket.readJson()).instances.length, 1, "availability checks never register phantom instances");
  } finally { await socket.close(); }
  await stopRelay();
  evidence.ok = true;
} finally {
  if (browserClient) await browserClient.send("Browser.close").catch(() => {});
  for (const client of clients) client.close();
  if (browser.exitCode === null) browser.kill();
  if (relay && relay.exitCode === null) relay.kill();
  await writeFile(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  await writeFile(path.join(root, "browser.log"), browserOutput);
  await writeFile(path.join(root, "relay.log"), relayOutput);
}
console.log(JSON.stringify(evidence, null, 2));
