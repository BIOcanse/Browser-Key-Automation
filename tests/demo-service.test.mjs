import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import { createTextArtifact, releaseArtifact } from "../out/extension/background/artifact-service.js";
import { openDemo, isTrustedDemoPort, attachDemoRouter } from "../out/extension/background/demo-service.js";
import { createTab } from "../out/extension/background/tab-service.js";
import { acquireControl, releaseControl } from "../out/extension/background/occupation-service.js";
import { DEMO_PORT_NAME } from "../out/extension/shared/demo-protocol.js";
import { COMMAND_CATALOG } from "../out/extension/generated/command-config.js";

const owner = "A".repeat(22), other = "B".repeat(22);
const extensionId = "a".repeat(32), prefix = `chrome-extension://${extensionId}/`;
const session = Object.create(null), tabs = new Map(), effects = [];
globalThis.chrome = {
  runtime: { id: extensionId, getURL: (file) => prefix + file },
  storage: { session: { async setAccessLevel() {}, async get(key) { return { [key]: session[key] }; }, async set(value) { Object.assign(session, value); } } },
  tabs: {
    async create(params) {
      effects.push(params); const id = tabs.size + 1;
      const tab = { id, index: id - 1, windowId: params.windowId ?? 1, active: params.active, highlighted: false, pinned: false,
        incognito: false, title: "Demo", status: "complete", url: params.url };
      tabs.set(id, tab); return { ...tab };
    },
    async get(id) { const tab = tabs.get(id); if (!tab) throw new Error("missing"); return { ...tab }; },
    async update(id, params) { effects.push(params); Object.assign(tabs.get(id), params); return { ...tabs.get(id) }; },
  },
};
const params = (artifactRef, more = {}) => ({ artifactRef, tabRef: null, windowId: null, active: true, ...more });

test("demo opens/updates only extension demo tabs and respects cross-Key occupations", async () => {
  const artifact = await createTextArtifact(owner, "text/html", "<!doctype html><title>Demo</title>");
  const ordinary = await createTab({ url: "https://example.test/", active: true, windowId: 2 });
  const before = effects.length;
  await assert.rejects(openDemo(owner, params(artifact.artifactRef, { tabRef: ordinary.tab.tabRef })), (e) => e.details?.reason === "NOT_DEMO_TAB");
  await assert.rejects(openDemo(other, params(artifact.artifactRef)), (e) => e.code === "ARTIFACT_NOT_FOUND");
  assert.equal(effects.length, before);
  await acquireControl(other, { scope: "global", tabRef: null });
  await assert.rejects(openDemo(owner, params(artifact.artifactRef)), (e) => e.code === "CONTROL_OCCUPIED");
  await releaseControl({ scope: "global", tabRef: null });
  const opened = await openDemo(owner, params(artifact.artifactRef, { active: false, windowId: 2 }));
  assert.equal(opened.tab.active, false); assert.equal(opened.tab.windowId, 2);
  assert.equal(new URL(opened.tab.url).searchParams.get("ownerKeyId"), owner);
  assert.equal(opened.tab.url.includes("bk1."), false);
  await acquireControl(other, { scope: "tab", tabRef: opened.tab.tabRef });
  await assert.rejects(openDemo(owner, params(artifact.artifactRef, { tabRef: opened.tab.tabRef })), (e) => e.code === "CONTROL_OCCUPIED");
  await releaseControl({ scope: "tab", tabRef: opened.tab.tabRef });
  const updated = await openDemo(owner, params(artifact.artifactRef, { tabRef: opened.tab.tabRef }));
  assert.equal(updated.tab.tabRef, opened.tab.tabRef); assert.equal(updated.tab.active, true);
  tabs.get(2).pendingUrl = "https://example.test/user-navigation";
  await assert.rejects(openDemo(owner, params(artifact.artifactRef, { tabRef: opened.tab.tabRef })), (e) => e.details?.reason === "NAVIGATION_PENDING");
  delete tabs.get(2).pendingUrl;
  const plain = await createTextArtifact(owner, "text/plain", "not HTML");
  await assert.rejects(openDemo(owner, params(plain.artifactRef)), (e) => e.details?.reason === "NOT_HTML");
  await releaseArtifact(owner, plain.artifactRef); await releaseArtifact(owner, artifact.artifactRef);
});

test("internal reader is restricted to the fixed outer-page address, not sandbox/content messages", async () => {
  const source = "<h1>private demo</h1>" + "x".repeat(COMMAND_CATALOG.limits["command.artifact.read.maximum_raw_bytes"]);
  const artifact = await createTextArtifact(owner, "text/html", source);
  const address = `${prefix}demo/index.html?ownerKeyId=${owner}&artifactRef=${artifact.artifactRef}`;
  const port = (url = address, id = extensionId) => ({ name: DEMO_PORT_NAME, sender: { url, id } });
  assert.equal(isTrustedDemoPort(port()), true);
  for (const candidate of [port(address, "b".repeat(32)), port(address.replace("index.html", "sandbox.html")),
    port(address.replace("index.html", "index.html.evil")), port(address + "&offset=0"), port(address + "#extra"),
    { ...port(), name: "wrong" }, port("https://example.test/")]) assert.equal(isTrustedDemoPort(candidate), false);
  let onMessage, disconnected = false, resolveReply;
  let reply = new Promise((resolve) => { resolveReply = resolve; });
  attachDemoRouter({ ...port(), disconnect() { disconnected = true; }, postMessage(value) { resolveReply(value); },
    onDisconnect: { addListener() {} }, onMessage: { addListener(listener) { onMessage = listener; } } });
  onMessage({ offset: 0 });
  const response = await reply; assert.equal(response.ok, true);
  assert.notEqual(response.chunk.nextOffset, null);
  // A real Port delivers the next request as another event, after the reader's
  // finally. Do not let a synchronous mock mistake reading=true for validation.
  await new Promise((resolve) => setImmediate(resolve));
  reply = new Promise((resolve) => { resolveReply = resolve; });
  onMessage({ offset: response.chunk.nextOffset });
  const tail = await reply; assert.equal(tail.ok, true); assert.equal(tail.chunk.nextOffset, null);
  assert.equal(Buffer.concat([response, tail].map((part) => Buffer.from(part.chunk.dataBase64Url, "base64url"))).toString(), source);
  assert.equal(disconnected, false);
  await new Promise((resolve) => setImmediate(resolve));
  // The invalid shape is the first request on a fresh port: no in-flight read
  // can short-circuit this assertion before the field whitelist is checked.
  attachDemoRouter({ ...port(), disconnect() { disconnected = true; }, postMessage() { assert.fail("invalid request was read"); },
    onDisconnect: { addListener() {} }, onMessage: { addListener(listener) { onMessage = listener; } } });
  onMessage({ offset: 0, artifactRef: "different" }); assert.equal(disconnected, true);
  await releaseArtifact(owner, artifact.artifactRef);
});
