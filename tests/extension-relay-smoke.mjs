import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CdpClient, pageEvaluate, runtimeEvaluate } from "./lib/cdp-client.mjs";
import { NativeWebSocket } from "../apps/client/src/native-websocket.mjs";
import { runUsabilityProbe } from "./lib/usability-probe.mjs";
import { runShotDemoProbe } from "./lib/shot-demo-probe.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { assertIsolatedFixture } = await import("./lib/isolation.mjs");
assertIsolatedFixture(workspaceRoot);
const extensionDir = path.join(workspaceRoot, "out", "extension");
const relayExecutable = path.join(workspaceRoot, "zig-out", "bin", "browser-key-relay.exe");
const runRoot = path.join(
  workspaceRoot,
  "out",
  "test-artifacts",
  `relay-extension-smoke-${process.pid}-${Date.now()}`,
);
const profileDir = path.join(runRoot, "profile");
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const realInputAcceptance = process.argv.includes("--real-input");

const chromiumExecutable = findChromiumExecutable();
assert.ok(chromiumExecutable, "No Chromium executable was found");
assert.ok(existsSync(path.join(extensionDir, "manifest.json")), "Build the extension first");
assert.ok(existsSync(relayExecutable), "Build the relay first");
const builtManifest = JSON.parse(await readFile(path.join(extensionDir, "manifest.json"), "utf8"));
const commandRegistry = JSON.parse(await readFile(path.join(workspaceRoot, "registries", "commands.registry.json"), "utf8"));
const freedomRegistry = JSON.parse(await readFile(path.join(workspaceRoot, "registries", "freedom.registry.json"), "utf8"));
const expectedActiveCommandIds = commandRegistry.commandDeclarations
  .filter((entry) => entry.status === "active")
  .map((entry) => entry.stableCommandId);
const expectedActivePermissionIds = commandRegistry.permissionDeclarations
  .filter((entry) => entry.status === "active")
  .map((entry) => entry.permissionId);
const expectedExtensionId = extensionIdFromManifestKey(builtManifest.key);
const inlineResultByteLimit = freedomRegistry.points.find(
  (point) => point.pointId === "command.inline.maximum_result_json_bytes",
)?.defaultInteger;
assert.equal(typeof inlineResultByteLimit, "number");
const artifactChunkByteLimit = freedomRegistry.points.find(
  (point) => point.pointId === "build.artifact.chunk_bytes",
)?.defaultInteger;
assert.equal(typeof artifactChunkByteLimit, "number");
const bulkDescriptorText = "descriptor-".repeat(40);
const treeLongAttribute = `tree-attribute-${"A".repeat(700)}`;
const treeLongText = `tree-long-text-${"字".repeat(700)}`;
const bulkFrameHtml = `<!doctype html><html><body>${Array.from(
  { length: 100 },
  (_, index) => `<button class="bulk-node" aria-label="${bulkDescriptorText}">bulk-${index}-${bulkDescriptorText}</button>`,
).join("")}</body></html>`;
const largeResourceBytes = Buffer.alloc(1_100_000);
for (let index = 0; index < largeResourceBytes.length; index += 1) {
  largeResourceBytes[index] = index % 251;
}

await mkdir(profileDir, { recursive: true });
const usabilityGates = { pending: null, defer: null, image: null };
const testPageServer = http.createServer((request, response) => {
  if (request.url === "/usability") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end('<!doctype html><title>BKA usability fixture</title><main><h1>网页另存为实际样本</h1>' +
      '<button id="disabled" disabled>Disabled</button><div id="editable" contenteditable="true">before</div>' +
      '<button id="remove" onclick="this.remove()">Remove itself</button><p id="late-text">waiting</p>' +
      '<button id="late-button" onclick="setTimeout(()=>document.getElementById(\'late-text\').textContent=\'ready\',200)">Load data</button>' +
      '<x-panel id="shadow-host"></x-panel></main><script>document.getElementById("shadow-host")' +
      '.attachShadow({mode:"open"}).innerHTML="<button id=shadow-action>Shadow-only action</button>";</script>');
    return;
  }
  if (request.url === "/wait-pending") { usabilityGates.pending = response; return; }
  if (request.url === "/wait-lifecycle") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end('<!doctype html><title>Lifecycle fixture</title><script defer src="/wait-defer.js"></script><p>parsed</p><img src="/wait-slow.png">');
    return;
  }
  if (request.url === "/wait-defer.js") { response.writeHead(200, { "content-type": "application/javascript" }); usabilityGates.defer = response; return; }
  if (request.url === "/wait-slow.png") { response.writeHead(200, { "content-type": "image/png" }); usabilityGates.image = response; return; }
  if (request.url === "/bulk") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(bulkFrameHtml);
    return;
  }
  if (request.url === "/resource.txt") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("resource-body");
    return;
  }
  if (request.url === "/large.bin") {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(largeResourceBytes.byteLength),
    });
    response.end(largeResourceBytes);
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    "<!doctype html><html><head><title>BKA core probe</title>" +
      "<style id=tree-style>/* tree-style-sentinel */ .tree-probe{display:block}</style></head>" +
      "<body><!--tree-comment-sentinel-->" +
      "<header><nav><a href=/navigation>tree-navigation-sentinel</a></nav></header>" +
      `<main data-tree-long="${treeLongAttribute}"><div id=payload>live DOM payload</div>` +
      `<article><h1>tree-primary-title</h1><p id=tree-long-text>${treeLongText}</p>` +
      "<section hidden>tree-hidden-sentinel</section></article>" +
      "<input id=probe-input value=before>" +
      "<button id=probe-button onclick=\"window.buttonClicks=(window.buttonClicks||0)+1\">click</button>" +
      "<select id=probe-select multiple><option value=a>A</option><option value=b>B</option></select>" +
      "<img alt=probe-resource src=/resource.txt><div id=shadow-host></div></main>" +
      "<iframe id=bulk-frame src=/bulk></iframe>" +
      "<script>window.pageOwnedValue=73;window.treeScriptSentinel='tree-script-sentinel';" +
      "window.clickEvidence={trusted:0,untrusted:0};document.querySelector('#probe-button').addEventListener('click',event=>{window.clickEvidence[event.isTrusted?'trusted':'untrusted']+=1});" +
      "document.querySelector('#shadow-host').attachShadow({mode:'open'}).textContent='tree-shadow-sentinel'</script>" +
      "</body></html>",
  );
});
const testPagePort = await listenServer(testPageServer);
const testPageUrl = `http://127.0.0.1:${testPagePort}/`;
const debugPort = await getFreePort();
const chromium = spawn(
  chromiumExecutable,
  [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--enable-extensions",
    "--enable-unsafe-extension-debugging",
    ...(realInputAcceptance ? ["--window-size=1100,800", "--window-position=40,40"] : ["--headless=new"]),
    "--no-first-run",
    "--no-sandbox",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-features=Translate,AutofillServerCommunication,DisableLoadExtensionCommandLineSwitch",
    "--proxy-server=direct://",
    "--proxy-bypass-list=*",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
);

let chromiumStderr = "";
chromium.stderr.setEncoding("utf8");
chromium.stderr.on("data", (chunk) => {
  chromiumStderr = (chromiumStderr + chunk).slice(-65_536);
});

let workerClient;
let browserClient;
let pageClient;
let relay;
let relayOutput = "";
let nativeClient;
let ownsRelay = false;
let preserveRelay = false;
let realInputEvidence = null;
try {
  workerClient = await waitForExtensionWorker(debugPort);
  const extensionId = await runtimeEvaluate(workerClient, "chrome.runtime.id");
  assert.equal(extensionId, expectedExtensionId);
  browserClient = await connectBrowser(debugPort);
  const createdTarget = await browserClient.send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/admin/index.html`,
  });
  const adminTarget = await waitForTarget(
    debugPort,
    (target) =>
      target.id === createdTarget.targetId &&
      String(target.url ?? "").endsWith("/admin/index.html"),
  );
  pageClient = await CdpClient.connect(adminTarget.webSocketDebuggerUrl);
  await pageClient.send("Runtime.enable");
  const initialTransport = await waitForOffscreenTransportState(debugPort, 15_000);
  try {
    nativeClient = await NativeWebSocket.connect({
      path: "/v1/client",
      subprotocol: "browser-key-client-v1",
    });
  } catch {
    relay = spawn(relayExecutable, [], {
      cwd: workspaceRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    ownsRelay = true;
    relay.stdout.setEncoding("utf8");
    relay.stderr.setEncoding("utf8");
    relay.stdout.on("data", (chunk) => {
      relayOutput += chunk;
    });
    relay.stderr.on("data", (chunk) => {
      relayOutput += chunk;
    });
    await waitUntil(() => relayOutput.includes("relay listening"), 5000, "relay startup");
    nativeClient = await NativeWebSocket.connect({
      path: "/v1/client",
      subprotocol: "browser-key-client-v1",
    });
  }

  assert.equal((await nativeClient.readJson()).kind, "relay.hello");
  nativeClient.sendJson({ kind: "role.hello", role: "client", protocolVersion: 1 });
  assert.deepEqual(await nativeClient.readJson(), { kind: "role.ready", role: "client" });

  const connectedTitle = await waitForOffscreenState(debugPort, "transport.connected", 15_000);
  assert.equal(typeof connectedTitle, "number");

  let instanceList;
  const instanceDeadline = Date.now() + 15_000;
  while (Date.now() < instanceDeadline) {
    nativeClient.sendJson({ kind: "instances.list" });
    instanceList = await nativeClient.readJson();
    if (instanceList.instances.length >= 1) break;
    await sleep(100);
  }
  assert.ok(instanceList?.instances.length >= 1, `relay output:\n${relayOutput}`);
  const targetInstance = instanceList.instances.reduce((latest, candidate) =>
    BigInt(candidate.instanceNumber) > BigInt(latest.instanceNumber) ? candidate : latest,
  );
  if (ownsRelay && instanceList.instances.length > 1) preserveRelay = true;
  let reconnectElapsedMs = null;
  if (ownsRelay) {
    reconnectElapsedMs = Date.now() - initialTransport.observedAt;
    assert.ok(reconnectElapsedMs <= 13_000, `reconnected too late: ${reconnectElapsedMs} ms`);
  }

  const createdKey = await pageEvaluate(
    pageClient,
    async (params) => {
      const service = await import(chrome.runtime.getURL("background/key-service.js"));
      return service.createKey(params);
    },
    {
      mutationId: adminMutationId(),
      displayName: "Relay E2E",
      keyKind: "regular",
      permissions: expectedActivePermissionIds,
      expiresAt: null,
      enabled: true,
    },
  );
  assert.equal(typeof createdKey?.apiKey, "string");
  assert.equal(typeof createdKey?.key?.keyId, "string");

  const describeResponse = await forwardSystemDescribe(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "describe-valid",
  );
  assert.equal(describeResponse.kind, "route.response");
  assert.equal(describeResponse.payload.clientRequestId, "describe-valid");
  assert.equal(describeResponse.payload.ok, true);
  assert.equal(describeResponse.payload.result.product, "browser-key-automation");
  assert.deepEqual(describeResponse.payload.result.activeCommandIds, expectedActiveCommandIds);
  assert.deepEqual(describeResponse.payload.result.activePermissionIds, expectedActivePermissionIds);
  assert.ok(describeResponse.payload.result.activeCapabilityIds.includes("platform.extension.tabs"));
  assert.deepEqual(describeResponse.payload.result.effectivePermissions, expectedActivePermissionIds);
  assert.equal(describeResponse.payload.result.callerKeyId, createdKey.key.keyId);
  assert.match(describeResponse.payload.result.buildId, /^extension-[a-f0-9]{24}$/u);

  const longTitle = `BKA stale probe ${"x".repeat(3000)}`;
  const staleTarget = await browserClient.send("Target.createTarget", {
    url: `data:text/html,<title>${encodeURIComponent(longTitle)}</title>`,
  });
  await waitForTarget(debugPort, (target) => target.id === staleTarget.targetId);
  const coreTarget = await browserClient.send("Target.createTarget", { url: testPageUrl });
  await waitForTarget(
    debugPort,
    (target) => target.id === coreTarget.targetId && String(target.url ?? "") === testPageUrl,
  );

  const firstTabPage = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "tabs-page-1",
    "tabs.list",
    { afterTabId: null, limit: 1 },
  );
  assert.equal(firstTabPage.payload.ok, true);
  assert.equal(firstTabPage.payload.result.items.length, 1);
  assert.equal(typeof firstTabPage.payload.result.nextAfterTabId, "number");
  const secondTabPage = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "tabs-page-2",
    "tabs.list",
    {
      afterTabId: firstTabPage.payload.result.nextAfterTabId,
      limit: 1,
    },
  );
  assert.equal(secondTabPage.payload.ok, true);
  assert.equal(secondTabPage.payload.result.items.length, 1);
  assert.notEqual(
    secondTabPage.payload.result.items[0].tabRef,
    firstTabPage.payload.result.items[0].tabRef,
  );

  let staleTab;
  let coreTab;
  let adminTab;
  const tabsDeadline = Date.now() + 5000;
  while (Date.now() < tabsDeadline) {
    const listResponse = await forwardCommand(
      nativeClient,
      targetInstance,
      createdKey.apiKey,
      `tabs-list-${Date.now()}`,
      "tabs.list",
      { afterTabId: null, limit: 100 },
    );
    assert.equal(listResponse.payload.ok, true);
    staleTab = listResponse.payload.result.items.find((tab) =>
      String(tab.title ?? "").startsWith("BKA stale probe"),
    );
    coreTab = listResponse.payload.result.items.find((tab) => tab.title === "BKA core probe");
    adminTab = listResponse.payload.result.items.find((tab) =>
      String(tab.url ?? "").endsWith("/admin/index.html"),
    );
    if (staleTab && coreTab && adminTab) break;
    await sleep(100);
  }
  assert.ok(staleTab, "tabs.list did not expose the stale-ref probe tab");
  assert.match(staleTab.tabRef, /^tr1\.[A-Za-z0-9_-]{22}\.[1-9][0-9]{0,15}\.[A-Za-z0-9_-]{22}$/u);
  assert.equal(staleTab.titleTruncated, true);
  assert.ok(new TextEncoder().encode(staleTab.title).byteLength <= 2048);
  assert.equal(staleTab.urlTruncated, true);
  assert.ok(coreTab, "tabs.list did not expose the HTTP core probe tab");
  assert.ok(adminTab, "tabs.list did not expose the extension admin tab");

  let coreTabStatus = coreTab.status;
  const coreLoadDeadline = Date.now() + 10_000;
  while (coreTabStatus !== "complete" && Date.now() < coreLoadDeadline) {
    const coreLoad = await forwardCommand(
      nativeClient,
      targetInstance,
      createdKey.apiKey,
      `tabs-get-until-core-complete-${Date.now()}`,
      "tabs.get",
      { tabRef: coreTab.tabRef },
    );
    assert.equal(coreLoad.payload.ok, true, JSON.stringify(coreLoad.payload));
    coreTabStatus = coreLoad.payload.result.tab.status;
    if (coreTabStatus !== "complete") await sleep(100);
  }
  assert.equal(coreTabStatus, "complete", "HTTP core probe did not finish loading");

  let usabilitySequence = 0;
  const usability = await runUsabilityProbe({
    forward: (method, params) => forwardCommand(nativeClient, targetInstance, createdKey.apiKey, `usability-${++usabilitySequence}`, method, params),
    cliPath: path.join(workspaceRoot, "apps", "client", "src", "main.mjs"), apiKey: createdKey.apiKey,
    instanceRef: `${targetInstance.relayEpoch}/${targetInstance.instanceNumber}`,
    sampleRoot: path.join(workspaceRoot, "out", "test-artifacts", "usability"), baseUrl: testPageUrl,
    windowId: coreTab.windowId, gates: usabilityGates,
  });

  let shotDemoSequence = 0;
  const shotDemo = await runShotDemoProbe({
    forward: (method, params) => forwardCommand(nativeClient, targetInstance, createdKey.apiKey, `shot-demo-${++shotDemoSequence}`, method, params),
    cliPath: path.join(workspaceRoot, "apps", "client", "src", "main.mjs"), apiKey: createdKey.apiKey,
    instanceRef: `${targetInstance.relayEpoch}/${targetInstance.instanceNumber}`,
    sampleRoot: path.join(workspaceRoot, "out", "test-artifacts", "shot-demo"),
    debugPort, browserClient, windowId: coreTab.windowId, ordinaryTabRef: coreTab.tabRef,
  });
  const restrictedDom = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "page-dom-restricted",
    "page.dom.get",
    { root: "document", tabRef: adminTab.tabRef },
  );
  assert.deepEqual(restrictedDom.payload.error, {
    code: "CAPABILITY_UNAVAILABLE",
    details: {
      capabilityId: "platform.extension.scripting",
      reason: "RESTRICTED_PAGE",
    },
  });
  const restrictedTree = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "page-tree-restricted",
    "page.tree.open",
    { targetRef: adminTab.tabRef },
  );
  assert.deepEqual(restrictedTree.payload.error, {
    code: "CAPABILITY_UNAVAILABLE",
    details: {
      capabilityId: "platform.extension.scripting",
      reason: "RESTRICTED_PAGE",
    },
  });

  const tabGetResponse = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "tabs-get-live",
    "tabs.get",
    { tabRef: staleTab.tabRef },
  );
  assert.equal(tabGetResponse.payload.ok, true);
  assert.equal(tabGetResponse.payload.result.tab.tabRef, staleTab.tabRef);

  const storedRuntimeEpoch = await pageEvaluate(pageClient, async () => {
    const key = "browser-key-automation.runtime-epoch.v1";
    return (await chrome.storage.session.get(key))[key] ?? null;
  });
  assert.match(storedRuntimeEpoch, /^[A-Za-z0-9_-]{22}$/u);

  const domResponse = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "page-dom-live",
    "page.dom.get",
    { root: "document", tabRef: coreTab.tabRef },
  );
  assert.equal(domResponse.payload.ok, true);
  assert.equal(domResponse.payload.result.tabRef, coreTab.tabRef);
  assert.equal(domResponse.payload.result.htmlTruncated, false);
  assert.match(domResponse.payload.result.html, /id="payload">live DOM payload/u);

  const textResponse = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "page-text-live",
    "page.text.get",
    { tabRef: coreTab.tabRef },
  );
  assert.equal(textResponse.payload.ok, true, JSON.stringify(textResponse.payload));
  assert.equal(textResponse.payload.result.textTruncated, false);
  assert.match(textResponse.payload.result.text, /live DOM payload/u);

  const pageTree = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "page-tree-open-main",
    "page.tree.open",
    { targetRef: coreTab.tabRef },
  );
  assert.equal(pageTree.payload.ok, true, JSON.stringify(pageTree.payload));
  assert.equal(pageTree.payload.result.tabRef, coreTab.tabRef);
  assert.equal(pageTree.payload.result.frameId, 0);
  assert.match(pageTree.payload.result.documentRef, /^dr1\.[A-Za-z0-9_-]{43}$/u);
  assert.match(pageTree.payload.result.rootRef, /^tr2\.[A-Za-z0-9_-]{43}$/u);
  assert.equal(pageTree.payload.result.reused, false);
  assert.equal("selection" in pageTree.payload.result, false);
  assert.deepEqual(pageTree.payload.result.limitations, [
    "browser_accessibility_tree_unavailable",
    "closed_shadow_roots_unobservable",
    "unmounted_content_unobservable",
  ]);
  assert.ok(Buffer.byteLength(JSON.stringify(pageTree.payload.result), "utf8") <= inlineResultByteLimit);

  const initialTreeView = await readPageTreeView(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    pageTree.payload.result.rootRef,
    {},
    "page-tree-view-initial",
  );
  assert.equal(initialTreeView.payload.result.truncated, false);
  assert.equal(initialTreeView.payload.result.nextIndexPath, null);
  assert.deepEqual(initialTreeView.payload.result.items.map((item) => item.indexPath), [[0], [1]]);
  assert.deepEqual(initialTreeView.payload.result.items.map((item) => item.level), [0, 0]);
  assert.deepEqual(initialTreeView.payload.result.items.map((item) => item.kind), ["doctype", "element"]);
  assert.equal(initialTreeView.payload.result.items[1]?.name, "HTML");
  assertPageTreeViewItems(initialTreeView.payload.result.items);

  const repeatedOpen = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "page-tree-open-main-repeated",
    "page.tree.open",
    { targetRef: coreTab.tabRef },
  );
  assert.equal(repeatedOpen.payload.ok, true, JSON.stringify(repeatedOpen.payload));
  assert.equal(repeatedOpen.payload.result.rootRef, pageTree.payload.result.rootRef);
  assert.equal(repeatedOpen.payload.result.documentRef, pageTree.payload.result.documentRef);
  assert.equal(repeatedOpen.payload.result.reused, true);

  const wrongExpandSchema = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "page-tree-expand-schema-v1-rejected",
    "page.tree.expand",
    { treeRef: initialTreeView.payload.result.items[1].treeRef },
    1,
  );
  assert.deepEqual(wrongExpandSchema.payload, {
    clientRequestId: "",
    ok: false,
    error: { code: "SCHEMA_INVALID" },
  });
  const invalidTreeViewRange = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "page-tree-view-invalid-range",
    "page.tree.view.get",
    { rootRef: pageTree.payload.result.rootRef, range: { from: [1, 4], toExclusive: [1, 2] } },
  );
  assert.deepEqual(invalidTreeViewRange.payload, {
    clientRequestId: "",
    ok: false,
    error: { code: "SCHEMA_INVALID" },
  });

  const htmlTreeItem = requiredTreeItem(initialTreeView.payload.result.items, [1]);
  assert.notEqual(htmlTreeItem.treeRef, null);
  const expandHtml = await expandPageTree(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    htmlTreeItem.treeRef,
    "page-tree-expand-html",
  );
  assert.deepEqual(expandHtml.payload.result, {
    tabRef: coreTab.tabRef,
    documentRef: pageTree.payload.result.documentRef,
    rootRef: pageTree.payload.result.rootRef,
    treeRef: htmlTreeItem.treeRef,
    expanded: true,
  });

  const levelZeroView = await readPageTreeView(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    pageTree.payload.result.rootRef,
    { maximumLevel: 0 },
    "page-tree-view-level-zero",
  );
  assert.deepEqual(levelZeroView.payload.result.items.map((item) => item.indexPath), [[0], [1]]);
  assert.equal(requiredTreeItem(levelZeroView.payload.result.items, [1]).expanded, true);

  const levelOneView = await readPageTreeView(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    pageTree.payload.result.rootRef,
    { maximumLevel: 1 },
    "page-tree-view-level-one",
  );
  assert.deepEqual(levelOneView.payload.result.items.map((item) => item.indexPath), [[0], [1], [1, 0], [1, 1]]);
  assert.deepEqual(levelOneView.payload.result.items.map((item) => item.name), ["html", "HTML", "HEAD", "BODY"]);
  assertPageTreeViewItems(levelOneView.payload.result.items);

  const bodyTreeItem = requiredTreeItem(levelOneView.payload.result.items, [1, 1]);
  assert.notEqual(bodyTreeItem.treeRef, null);
  await expandPageTree(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    bodyTreeItem.treeRef,
    "page-tree-expand-body",
  );
  const bodyExpandedView = await readPageTreeView(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    pageTree.payload.result.rootRef,
    { maximumLevel: 2 },
    "page-tree-view-body-expanded",
  );
  assert.equal(requiredTreeItem(bodyExpandedView.payload.result.items, [1, 0]).expanded, false);
  assert.equal(requiredTreeItem(bodyExpandedView.payload.result.items, [1, 1]).expanded, true);
  assert.deepEqual(
    directChildItems(bodyExpandedView.payload.result.items, [1, 1]).map((item) => item.name),
    ["#comment", "HEADER", "MAIN", "IFRAME", "SCRIPT"],
  );

  const bodySiblingRange = await readPageTreeView(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    pageTree.payload.result.rootRef,
    { range: { from: [1, 1, 1], toExclusive: [1, 1, 4] } },
    "page-tree-view-body-sibling-range",
  );
  assert.deepEqual(bodySiblingRange.payload.result.items.map((item) => item.indexPath), [
    [1, 1, 1],
    [1, 1, 2],
    [1, 1, 3],
  ]);
  assert.deepEqual(bodySiblingRange.payload.result.items.map((item) => item.name), ["HEADER", "MAIN", "IFRAME"]);

  const mainTreeItem = requiredTreeItem(bodyExpandedView.payload.result.items, [1, 1, 2]);
  assert.notEqual(mainTreeItem.treeRef, null);
  await expandPageTree(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    mainTreeItem.treeRef,
    "page-tree-expand-main",
  );
  const beforeSubtreeView = await readPageTreeView(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    pageTree.payload.result.rootRef,
    {},
    "page-tree-view-before-subtree",
  );
  const mainSubtreeView = await readPageTreeView(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    pageTree.payload.result.rootRef,
    { subtree: [1, 1, 2] },
    "page-tree-view-main-subtree",
  );
  assert.deepEqual(mainSubtreeView.payload.result.items[0]?.indexPath, [1, 1, 2]);
  assert.equal(mainSubtreeView.payload.result.items.some((item) => item.indexPath.length < 3), false);
  const afterSubtreeView = await readPageTreeView(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    pageTree.payload.result.rootRef,
    {},
    "page-tree-view-after-subtree",
  );
  assert.deepEqual(afterSubtreeView.payload.result.items, beforeSubtreeView.payload.result.items);

  const traversedTree = await fullyExpandPageTree(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    pageTree.payload.result.rootRef,
  );
  assert.ok(traversedTree.commandCount < 300);
  assert.equal(traversedTree.view.payload.result.truncated, false);
  assert.equal(traversedTree.items.some((item) => item.kind === "doctype"), true);
  assert.equal(
    traversedTree.items.some((item) => item.kind === "comment" && item.valuePreview === "tree-comment-sentinel"),
    true,
  );
  assert.equal(
    traversedTree.items.some((item) => String(item.valuePreview ?? "").includes("tree-style-sentinel")),
    true,
  );
  assert.equal(
    traversedTree.items.some((item) => String(item.valuePreview ?? "").includes("tree-script-sentinel")),
    true,
  );
  assert.equal(
    traversedTree.items.some((item) => item.valuePreview === "tree-hidden-sentinel"),
    true,
  );
  assert.equal(
    traversedTree.items.some((item) => item.kind === "shadow_root"),
    true,
  );
  assert.equal(
    traversedTree.items.some((item) => item.valuePreview === "tree-shadow-sentinel"),
    true,
  );
  const longAttributeItem = traversedTree.items.find((item) =>
    item.kind === "attribute" && item.name === "data-tree-long" && item.treeRef !== null
  );
  assert.ok(longAttributeItem, "page tree did not retain the long attribute branch");
  assert.equal(readExpandedPageTreeValue(traversedTree.items, longAttributeItem.indexPath), treeLongAttribute);
  const longTextItem = traversedTree.items.find((item) =>
    item.kind === "text" && String(item.valuePreview ?? "").startsWith("tree-long-text-") && item.treeRef !== null
  );
  assert.ok(longTextItem, "page tree did not retain the long text branch");
  assert.equal(readExpandedPageTreeValue(traversedTree.items, longTextItem.indexPath), treeLongText);
  const treeTranscriptPath = path.join(
    workspaceRoot,
    "out",
    "test-artifacts",
    "page-tree-actual-interaction.json",
  );
  await mkdir(path.dirname(treeTranscriptPath), { recursive: true });
  await writeFile(
    treeTranscriptPath,
    `${JSON.stringify({
      schema: "bka-page-tree-actual-interaction-v2",
      capturedAt: new Date().toISOString(),
      fixture: {
        title: "BKA core probe",
        purpose: "Actual extension-relay interaction; no API Key is recorded.",
      },
      initialCommand: {
        method: "page.tree.open",
        params: { targetRef: coreTab.tabRef },
        response: pageTree.payload,
      },
      initialViewCommand: {
        method: "page.tree.view.get",
        params: { rootRef: pageTree.payload.result.rootRef },
        response: initialTreeView.payload,
      },
      layerViews: {
        maximumLevel0: levelZeroView.payload,
        maximumLevel1: levelOneView.payload,
        maximumLevel2AfterBodyExpansion: bodyExpandedView.payload,
      },
      rangeView: bodySiblingRange.payload,
      subtreeView: mainSubtreeView.payload,
      expansionCommands: traversedTree.steps,
      finalView: traversedTree.view.payload,
      exactLongValues: {
        attributeCharacters: treeLongAttribute.length,
        textCharacters: treeLongText.length,
        reassembledExactly: true,
      },
    }, null, 2)}\n`,
    "utf8",
  );

  const settingsBefore = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "settings-get-before",
    "settings.get",
    {},
  );
  assert.equal(settingsBefore.payload.ok, true, JSON.stringify(settingsBefore.payload));
  const settingsUpdate = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "settings-update",
    "settings.update",
    {
      expectedRevision: settingsBefore.payload.result.settings.revision,
      artifactRetentionMs: settingsBefore.payload.result.settings.artifactRetentionMs,
      artifactMaximumBytes: settingsBefore.payload.result.settings.artifactMaximumBytes,
      artifactMaximumCount: settingsBefore.payload.result.settings.artifactMaximumCount,
      artifactMaximumTotalBytes: settingsBefore.payload.result.settings.artifactMaximumTotalBytes,
    },
  );
  assert.equal(settingsUpdate.payload.ok, true, JSON.stringify(settingsUpdate.payload));
  assert.equal(
    settingsUpdate.payload.result.settings.revision,
    settingsBefore.payload.result.settings.revision + 1,
  );
  const settingsAfter = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "settings-get-after",
    "settings.get",
    {},
  );
  assert.deepEqual(settingsAfter.payload.result.settings, settingsUpdate.payload.result.settings);

  const managedKeyCreate = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "keys-create-agent",
    "keys.create",
    {
      mutationId: adminMutationId(),
      displayName: "Managed through command",
      keyKind: "regular",
      permissions: ["tabs.read"],
      expiresAt: null,
      enabled: true,
    },
  );
  assert.equal(managedKeyCreate.payload.ok, true, JSON.stringify(managedKeyCreate.payload));
  const managedKey = managedKeyCreate.payload.result.key;
  const managedApiKey = managedKeyCreate.payload.result.apiKey;
  assert.match(managedApiKey, /^bk1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u);

  const managedKeyGet = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "keys-get-agent",
    "keys.get",
    { keyId: managedKey.keyId },
  );
  assert.deepEqual(managedKeyGet.payload.result.key, managedKey);
  const managedKeyList = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "keys-list-agent",
    "keys.list",
    { afterKeyId: null, limit: 100 },
  );
  assert.equal(
    managedKeyList.payload.result.items.some((key) => key.keyId === managedKey.keyId),
    true,
  );
  const managedKeyReveal = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "keys-reveal-agent",
    "keys.reveal",
    { keyId: managedKey.keyId },
  );
  assert.equal(managedKeyReveal.payload.result.apiKey, managedApiKey);
  const managedKeyUpdate = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "keys-update-agent",
    "keys.update",
    {
      mutationId: adminMutationId(),
      keyId: managedKey.keyId,
      expectedRevision: managedKey.recordRevision,
      patch: {
        displayName: "Managed command updated",
        permissions: ["system.read", "tabs.read"],
        expiresAt: null,
        enabled: true,
      },
    },
  );
  assert.equal(managedKeyUpdate.payload.ok, true, JSON.stringify(managedKeyUpdate.payload));
  assert.deepEqual(managedKeyUpdate.payload.result.key.permissions, ["system.read", "tabs.read"]);
  const managedKeyRevoke = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "keys-revoke-agent",
    "keys.revoke",
    {
      mutationId: adminMutationId(),
      keyId: managedKey.keyId,
      expectedRevision: managedKeyUpdate.payload.result.key.recordRevision,
    },
  );
  assert.equal(managedKeyRevoke.payload.result.key.status, "revoked");
  const revokedKeyReveal = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "keys-reveal-revoked-agent",
    "keys.reveal",
    { keyId: managedKey.keyId },
  );
  assert.equal(revokedKeyReveal.payload.result.apiKey, managedApiKey);

  const domCapture = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "page-dom-capture",
    "page.dom.capture",
    { root: "document", tabRef: coreTab.tabRef },
  );
  assert.equal(domCapture.payload.ok, true, JSON.stringify(domCapture.payload));
  assert.equal(domCapture.payload.result.artifact.mediaType, "text/html;charset=utf-8");
  const domArtifactRead = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "artifact-read-dom",
    "artifact.read",
    { artifactRef: domCapture.payload.result.artifact.artifactRef, offset: 0, maximumBytes: 36_000 },
  );
  assert.equal(domArtifactRead.payload.ok, true, JSON.stringify(domArtifactRead.payload));
  assert.match(
    Buffer.from(domArtifactRead.payload.result.dataBase64Url, "base64url").toString("utf8"),
    /live DOM payload/u,
  );
  const domArtifactRelease = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "artifact-release-dom",
    "artifact.release",
    { artifactRef: domCapture.payload.result.artifact.artifactRef },
  );
  assert.equal(domArtifactRelease.payload.result.released, true);
  const releasedArtifactRead = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "artifact-read-released",
    "artifact.read",
    { artifactRef: domCapture.payload.result.artifact.artifactRef, offset: 0, maximumBytes: 36_000 },
  );
  assert.deepEqual(releasedArtifactRead.payload.error, { code: "ARTIFACT_NOT_FOUND" });

  const resourceList = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "page-resources-list",
    "page.resources.list",
    { tabRef: coreTab.tabRef, limit: 100 },
  );
  assert.equal(resourceList.payload.ok, true, JSON.stringify(resourceList.payload));
  assert.equal(
    resourceList.payload.result.items.some((resource) => resource.url === `${testPageUrl}resource.txt`),
    true,
  );
  const fetchedResource = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "resource-fetch",
    "resource.fetch",
    { url: `${testPageUrl}resource.txt`, credentials: "omit", cache: "no-store" },
  );
  assert.equal(fetchedResource.payload.ok, true, JSON.stringify(fetchedResource.payload));
  assert.equal(fetchedResource.payload.result.status, 200);
  const fetchedResourceRead = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "artifact-read-resource",
    "artifact.read",
    { artifactRef: fetchedResource.payload.result.artifact.artifactRef, offset: 0, maximumBytes: 36_000 },
  );
  assert.equal(
    Buffer.from(fetchedResourceRead.payload.result.dataBase64Url, "base64url").toString("utf8"),
    "resource-body",
  );
  await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "artifact-release-resource",
    "artifact.release",
    { artifactRef: fetchedResource.payload.result.artifact.artifactRef },
  );

  const largeFetchedResource = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "resource-fetch-large",
    "resource.fetch",
    { url: `${testPageUrl}large.bin`, credentials: "omit", cache: "no-store" },
  );
  assert.equal(largeFetchedResource.payload.ok, true, JSON.stringify(largeFetchedResource.payload));
  assert.equal(largeFetchedResource.payload.result.artifact.byteLength, largeResourceBytes.byteLength);
  const crossChunkOffset = artifactChunkByteLimit - 16;
  const largeResourceRead = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "artifact-read-cross-chunk",
    "artifact.read",
    {
      artifactRef: largeFetchedResource.payload.result.artifact.artifactRef,
      offset: crossChunkOffset,
      maximumBytes: 64,
    },
  );
  assert.equal(largeResourceRead.payload.ok, true, JSON.stringify(largeResourceRead.payload));
  assert.deepEqual(
    Buffer.from(largeResourceRead.payload.result.dataBase64Url, "base64url"),
    largeResourceBytes.subarray(crossChunkOffset, crossChunkOffset + 64),
  );
  await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "artifact-release-large",
    "artifact.release",
    { artifactRef: largeFetchedResource.payload.result.artifact.artifactRef },
  );

  const archiveCapture = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "page-archive-capture",
    "page.archive.capture",
    { tabRef: coreTab.tabRef },
  );
  assert.equal(archiveCapture.payload.ok, true, JSON.stringify(archiveCapture.payload));
  assert.equal(archiveCapture.payload.result.artifact.mediaType, "multipart/related");
  const archiveRead = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "artifact-read-archive",
    "artifact.read",
    { artifactRef: archiveCapture.payload.result.artifact.artifactRef, offset: 0, maximumBytes: 36_000 },
  );
  assert.equal(archiveRead.payload.ok, true, JSON.stringify(archiveRead.payload));
  assert.ok(archiveRead.payload.result.dataBase64Url.length > 0);
  await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "artifact-release-archive",
    "artifact.release",
    { artifactRef: archiveCapture.payload.result.artifact.artifactRef },
  );

  const framesList = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "frames-list",
    "frames.list",
    { tabRef: coreTab.tabRef, limit: 20 },
  );
  assert.equal(framesList.payload.ok, true, JSON.stringify(framesList.payload));
  const mainFrame = framesList.payload.result.items.find((frame) => frame.frameId === 0);
  assert.match(mainFrame?.documentRef ?? "", /^dr1\.[A-Za-z0-9_-]{43}$/u);
  const bulkFrame = framesList.payload.result.items.find((frame) => frame.url === `${testPageUrl}bulk`);
  assert.match(bulkFrame?.documentRef ?? "", /^dr1\.[A-Za-z0-9_-]{43}$/u);
  const bulkFrameTree = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "page-tree-open-child-frame",
    "page.tree.open",
    { targetRef: bulkFrame.documentRef },
  );
  assert.equal(bulkFrameTree.payload.ok, true, JSON.stringify(bulkFrameTree.payload));
  assert.equal(bulkFrameTree.payload.result.documentRef, bulkFrame.documentRef);
  assert.equal(bulkFrameTree.payload.result.frameId, bulkFrame.frameId);
  const bulkInitialView = await readPageTreeView(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    bulkFrameTree.payload.result.rootRef,
    {},
    "page-tree-view-child-initial",
  );
  const bulkHtml = requiredTreeItem(bulkInitialView.payload.result.items, [1]);
  await expandPageTree(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    bulkHtml.treeRef,
    "page-tree-expand-child-html",
  );
  const bulkLevelOne = await readPageTreeView(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    bulkFrameTree.payload.result.rootRef,
    { maximumLevel: 1 },
    "page-tree-view-child-level-one",
  );
  const bulkBody = requiredTreeItem(bulkLevelOne.payload.result.items, [1, 1]);
  await expandPageTree(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    bulkBody.treeRef,
    "page-tree-expand-child-body",
  );
  const bulkButtonItems = [];
  for (let from = 0; from < 100; from += 25) {
    const bulkButtonsRange = await readPageTreeView(
      nativeClient,
      targetInstance,
      createdKey.apiKey,
      bulkFrameTree.payload.result.rootRef,
      { range: { from: [1, 1, from], toExclusive: [1, 1, from + 25] } },
      `page-tree-view-child-buttons-${from}-${from + 25}`,
    );
    assert.equal(bulkButtonsRange.payload.result.truncated, false);
    bulkButtonItems.push(...bulkButtonsRange.payload.result.items);
  }
  assert.equal(bulkButtonItems.filter((item) => item.role === "button" && item.nodeRef !== null).length, 100);
  assert.equal(new Set(bulkButtonItems.map((item) => JSON.stringify(item.indexPath))).size, 100);
  const reopenedMainTree = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "page-tree-open-main-after-child",
    "page.tree.open",
    { targetRef: coreTab.tabRef },
  );
  assert.equal(reopenedMainTree.payload.result.rootRef, pageTree.payload.result.rootRef);
  assert.equal(reopenedMainTree.payload.result.reused, true);
  const restoredMainTreeView = await readPageTreeView(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    pageTree.payload.result.rootRef,
    {},
    "page-tree-view-main-restored",
  );
  assert.equal(requiredTreeItem(restoredMainTreeView.payload.result.items, [1]).expanded, true);
  assert.equal(requiredTreeItem(restoredMainTreeView.payload.result.items, [1, 1]).expanded, true);
  assert.equal(requiredTreeItem(restoredMainTreeView.payload.result.items, [1, 1, 2]).expanded, true);
  const bulkQuery = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "dom-query-bulk-frame",
    "dom.query",
    { documentRef: bulkFrame.documentRef, selector: ".bulk-node", limit: 100 },
  );
  assert.equal(bulkQuery.payload.ok, true, JSON.stringify(bulkQuery.payload));
  assert.equal(bulkQuery.payload.result.truncated, true);
  assert.ok(bulkQuery.payload.result.items.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(bulkQuery.payload.result), "utf8") <= inlineResultByteLimit);

  const inputQuery = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "dom-query-input",
    "dom.query",
    { documentRef: mainFrame.documentRef, selector: "#probe-input", limit: 5 },
  );
  assert.equal(inputQuery.payload.ok, true, JSON.stringify(inputQuery.payload));
  assert.equal(inputQuery.payload.result.items.length, 1);
  const inputNodeRef = inputQuery.payload.result.items[0].nodeRef;
  const inputDescribe = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "dom-describe-input",
    "dom.describe",
    { nodeRef: inputNodeRef },
  );
  assert.equal(inputDescribe.payload.result.descriptor.value, "before");
  const inputSetValue = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "dom-set-value-input",
    "dom.setValue",
    { nodeRef: inputNodeRef, value: "after" },
  );
  assert.equal(inputSetValue.payload.result.descriptor.value, "after");
  const inputFocus = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "dom-focus-input",
    "dom.focus",
    { nodeRef: inputNodeRef, preventScroll: true },
  );
  assert.equal(inputFocus.payload.result.applied, true);
  const inputScroll = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "dom-scroll-input",
    "dom.scroll",
    { nodeRef: inputNodeRef, behavior: "auto", block: "center", inline: "nearest" },
  );
  assert.equal(inputScroll.payload.result.applied, true);

  const selectQuery = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "dom-query-select",
    "dom.query",
    { documentRef: mainFrame.documentRef, selector: "#probe-select", limit: 5 },
  );
  const selectNodeRef = selectQuery.payload.result.items[0].nodeRef;
  const selectResult = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "dom-select-values",
    "dom.select",
    { nodeRef: selectNodeRef, values: ["b"] },
  );
  assert.equal(selectResult.payload.result.descriptor.value, "b");

  const buttonQuery = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "dom-query-button",
    "dom.query",
    { documentRef: mainFrame.documentRef, selector: "#probe-button", limit: 5 },
  );
  const buttonClick = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "dom-click-button",
    "dom.click",
    { nodeRef: buttonQuery.payload.result.items[0].nodeRef },
  );
  assert.equal(buttonClick.payload.result.applied, true);
  if (realInputAcceptance) {
    const realClick = await forwardCommand(
      nativeClient,
      targetInstance,
      createdKey.apiKey,
      "dom-click-real-button",
      "dom.click.real",
      { nodeRef: buttonQuery.payload.result.items[0].nodeRef },
    );
    assert.deepEqual(realClick.payload.result, {
      nodeRef: buttonQuery.payload.result.items[0].nodeRef,
      status: "input_sent",
    }, JSON.stringify(realClick.payload));
    const target = await waitForTarget(debugPort, (candidate) => candidate.id === coreTarget.targetId);
    const corePage = await CdpClient.connect(target.webSocketDebuggerUrl);
    try {
      const deadline = Date.now() + 3000;
      let observed;
      while (Date.now() < deadline) {
        observed = await runtimeEvaluate(corePage, "({evidence:window.clickEvidence,title:document.title})");
        if (observed?.evidence?.trusted >= 1) break;
        await sleep(50);
      }
      assert.equal(observed.evidence.untrusted, 1);
      assert.equal(observed.evidence.trusted, 1);
      assert.equal(observed.title, "BKA core probe");
      realInputEvidence = { status: realClick.payload.result.status, ...observed.evidence, titleRestored: true };
    } finally {
      corePage.close();
    }
  }

  const createdTabResponse = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "tabs-create",
    "tabs.create",
    { windowId: coreTab.windowId, url: "about:blank", active: false },
  );
  assert.equal(createdTabResponse.payload.ok, true, JSON.stringify(createdTabResponse.payload));
  const createdTabRef = createdTabResponse.payload.result.tab.tabRef;
  const invisibleScreenshot = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "page-screenshot-invisible",
    "page.screenshot.capture",
    { tabRef: createdTabRef, format: "png", quality: 100 },
  );
  assert.deepEqual(invisibleScreenshot.payload.error, {
    code: "CAPABILITY_UNAVAILABLE",
    details: {
      capabilityId: "platform.extension.visible_tab_capture",
      reason: "TARGET_TAB_NOT_VISIBLE",
    },
  });
  const navigatedTab = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "tabs-navigate",
    "tabs.navigate",
    { tabRef: createdTabRef, url: `${testPageUrl}?created=1` },
  );
  assert.equal(navigatedTab.payload.ok, true, JSON.stringify(navigatedTab.payload));
  const reloadedTab = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "tabs-reload",
    "tabs.reload",
    { tabRef: createdTabRef, bypassCache: true },
  );
  assert.deepEqual(reloadedTab.payload.result, { tabRef: createdTabRef, reloaded: true });
  const activatedTab = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "tabs-activate-created",
    "tabs.activate",
    { tabRef: createdTabRef },
  );
  assert.equal(activatedTab.payload.result.tab.active, true);
  const activateCore = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "tabs-activate-core",
    "tabs.activate",
    { tabRef: coreTab.tabRef },
  );
  assert.equal(activateCore.payload.result.tab.active, true);

  const screenshotCapture = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "page-screenshot-capture",
    "page.screenshot.capture",
    { tabRef: coreTab.tabRef, format: "png", quality: 100 },
  );
  assert.equal(screenshotCapture.payload.ok, true, JSON.stringify(screenshotCapture.payload));
  assert.equal(screenshotCapture.payload.result.artifact.mediaType, "image/png");
  const screenshotRead = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "artifact-read-screenshot",
    "artifact.read",
    { artifactRef: screenshotCapture.payload.result.artifact.artifactRef, offset: 0, maximumBytes: 36_000 },
  );
  assert.equal(screenshotRead.payload.ok, true, JSON.stringify(screenshotRead.payload));
  assert.equal(
    Buffer.from(screenshotRead.payload.result.dataBase64Url, "base64url").subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
  );
  await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "artifact-release-screenshot",
    "artifact.release",
    { artifactRef: screenshotCapture.payload.result.artifact.artifactRef },
  );
  const closedTab = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "tabs-close-created",
    "tabs.close",
    { tabRef: createdTabRef },
  );
  assert.deepEqual(closedTab.payload.result, { tabRef: createdTabRef, closed: true });
  const closedTabGet = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "tabs-get-closed-created",
    "tabs.get",
    { tabRef: createdTabRef },
  );
  assert.deepEqual(closedTabGet.payload.error, { code: "TAB_REF_STALE" });

  const collaboratorKey = await pageEvaluate(
    pageClient,
    async (params) => {
      const service = await import(chrome.runtime.getURL("background/key-service.js"));
      return service.createKey(params);
    },
    {
      mutationId: adminMutationId(),
      displayName: "Collaborator",
      keyKind: "regular",
      permissions: ["control.acquire", "control.release", "js.execute", "page.dom.read", "page.tree.read", "tabs.read"],
      expiresAt: null,
      enabled: true,
    },
  );

  const collaboratorInitialTreeView = await readPageTreeView(
    nativeClient,
    targetInstance,
    collaboratorKey.apiKey,
    pageTree.payload.result.rootRef,
    {},
    "page-tree-view-collaborator-initial",
  );
  assert.deepEqual(collaboratorInitialTreeView.payload.result.items.map((item) => item.indexPath), [[0], [1]]);
  assert.equal(requiredTreeItem(collaboratorInitialTreeView.payload.result.items, [1]).expanded, false);
  await expandPageTree(
    nativeClient,
    targetInstance,
    collaboratorKey.apiKey,
    htmlTreeItem.treeRef,
    "page-tree-expand-collaborator-html",
  );
  const collaboratorLevelOneTreeView = await readPageTreeView(
    nativeClient,
    targetInstance,
    collaboratorKey.apiKey,
    pageTree.payload.result.rootRef,
    { maximumLevel: 1 },
    "page-tree-view-collaborator-level-one",
  );
  assert.equal(requiredTreeItem(collaboratorLevelOneTreeView.payload.result.items, [1]).expanded, true);
  assert.equal(requiredTreeItem(collaboratorLevelOneTreeView.payload.result.items, [1, 1]).expanded, false);
  const ownerTreeViewAfterCollaboratorExpansion = await readPageTreeView(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    pageTree.payload.result.rootRef,
    { maximumLevel: 1 },
    "page-tree-view-owner-after-collaborator",
  );
  assert.equal(requiredTreeItem(ownerTreeViewAfterCollaboratorExpansion.payload.result.items, [1, 1]).expanded, true);

  const firstAcquire = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "control-acquire-a",
    "control.acquire",
    { scope: "tab", tabRef: coreTab.tabRef },
  );
  assert.equal(
    firstAcquire.payload.ok,
    true,
    JSON.stringify(firstAcquire.payload),
  );
  assert.equal(firstAcquire.payload.result.alreadyOwned, false);
  const repeatedAcquire = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "control-acquire-a-repeat",
    "control.acquire",
    { scope: "tab", tabRef: coreTab.tabRef },
  );
  assert.equal(repeatedAcquire.payload.ok, true);
  assert.equal(repeatedAcquire.payload.result.alreadyOwned, true);

  const conflictingAcquire = await forwardCommand(
    nativeClient,
    targetInstance,
    collaboratorKey.apiKey,
    "control-acquire-b-conflict",
    "control.acquire",
    { scope: "tab", tabRef: coreTab.tabRef },
  );
  assert.deepEqual(conflictingAcquire.payload.error, {
    code: "CONTROL_OCCUPIED",
    details: { scope: "tab", tabRef: coreTab.tabRef, ownerKeyId: createdKey.key.keyId },
  });

  const observationWhileOccupied = await forwardCommand(
    nativeClient,
    targetInstance,
    collaboratorKey.apiKey,
    "page-dom-b-observe",
    "page.dom.get",
    { root: "document", tabRef: coreTab.tabRef },
  );
  assert.equal(observationWhileOccupied.payload.ok, true);

  const foreignRelease = await forwardCommand(
    nativeClient,
    targetInstance,
    collaboratorKey.apiKey,
    "control-release-b",
    "control.release",
    { scope: "tab", tabRef: coreTab.tabRef },
  );
  assert.equal(foreignRelease.payload.ok, true);
  assert.equal(foreignRelease.payload.result.previousOwnerKeyId, createdKey.key.keyId);

  const globalAcquire = await forwardCommand(
    nativeClient,
    targetInstance,
    collaboratorKey.apiKey,
    "control-global-b",
    "control.acquire",
    { scope: "global", tabRef: null },
  );
  assert.equal(globalAcquire.payload.ok, true);
  const globalConflict = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "control-tab-a-global-conflict",
    "control.acquire",
    { scope: "tab", tabRef: coreTab.tabRef },
  );
  assert.deepEqual(globalConflict.payload.error, {
    code: "CONTROL_OCCUPIED",
    details: { scope: "global", tabRef: null, ownerKeyId: collaboratorKey.key.keyId },
  });
  const globalForeignRelease = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "control-global-release-a",
    "control.release",
    { scope: "global", tabRef: null },
  );
  assert.equal(globalForeignRelease.payload.result.previousOwnerKeyId, collaboratorKey.key.keyId);

  const mainWorldExecution = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "js-main",
    "js.execute",
    {
      tabRef: coreTab.tabRef,
      world: "MAIN",
      code: "({pageOwnedValue:window.pageOwnedValue,bodyText:document.querySelector('#payload')?.textContent,inputValue:document.querySelector('#probe-input')?.value,selectValue:document.querySelector('#probe-select')?.value,buttonClicks:window.buttonClicks})",
      timeoutMs: 10_000,
    },
  );
  let effectiveMainExecution = mainWorldExecution;
  let userScriptsState = "already-enabled";
  if (!mainWorldExecution.payload.ok) {
    const { setupInstructions, ...capabilityDetails } = mainWorldExecution.payload.error.details;
    assert.match(setupInstructions, /chrome:\/\/extensions/u);
    assert.match(setupInstructions, /Allow User Scripts/u);
    assert.deepEqual({ ...mainWorldExecution.payload.error, details: capabilityDetails }, {
      code: "CAPABILITY_UNAVAILABLE",
      details: {
        capabilityId: "platform.extension.user_scripts",
        reason: "USER_SCRIPTS_NOT_ENABLED",
      },
    });
    const extensionsTarget = await browserClient.send("Target.createTarget", {
      url: `chrome://extensions/?id=${extensionId}`,
    });
    const extensionsPageTarget = await waitForTarget(
      debugPort,
      (target) => target.id === extensionsTarget.targetId,
    );
    const extensionsPageClient = await CdpClient.connect(extensionsPageTarget.webSocketDebuggerUrl);
    await extensionsPageClient.send("Runtime.enable");
    await sleep(1000);
    const toggleClicked = await pageEvaluate(extensionsPageClient, () => {
      const manager = document.querySelector("extensions-manager");
      const detail = manager?.shadowRoot?.querySelector("extensions-detail-view");
      const row = detail?.shadowRoot?.querySelector("#allow-user-scripts");
      const toggle = row?.shadowRoot?.querySelector("#crToggle");
      if (toggle === null || toggle === undefined) return false;
      toggle.click();
      return true;
    });
    assert.equal(toggleClicked, true, "Chrome did not expose its Allow User Scripts toggle");
    await sleep(500);
    effectiveMainExecution = await forwardCommand(
      nativeClient,
      targetInstance,
      createdKey.apiKey,
      "js-main-after-toggle",
      "js.execute",
      {
        tabRef: coreTab.tabRef,
        world: "MAIN",
        code: "({pageOwnedValue:window.pageOwnedValue,bodyText:document.querySelector('#payload')?.textContent,inputValue:document.querySelector('#probe-input')?.value,selectValue:document.querySelector('#probe-select')?.value,buttonClicks:window.buttonClicks})",
        timeoutMs: 10_000,
      },
    );
    userScriptsState = "enabled-through-chrome-details";
    extensionsPageClient.close();
    await browserClient.send("Target.closeTarget", { targetId: extensionsTarget.targetId });
  }
  assert.equal(effectiveMainExecution.payload.ok, true, JSON.stringify(effectiveMainExecution.payload));
  assert.equal(effectiveMainExecution.payload.result.status, "fulfilled");
  assert.deepEqual(JSON.parse(effectiveMainExecution.payload.result.valueJson), {
    pageOwnedValue: 73,
    bodyText: "live DOM payload",
    inputValue: "after",
    selectValue: "b",
    buttonClicks: realInputAcceptance ? 2 : 1,
  });
  const isolatedExecution = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "js-user-script",
    "js.execute",
    {
      tabRef: coreTab.tabRef,
      world: "USER_SCRIPT",
      code: "({pageOwnedType:typeof window.pageOwnedValue,bodyText:document.querySelector('#payload')?.textContent})",
      timeoutMs: 10_000,
    },
  );
  assert.equal(isolatedExecution.payload.result.status, "fulfilled");
  assert.deepEqual(JSON.parse(isolatedExecution.payload.result.valueJson), {
    pageOwnedType: "undefined",
    bodyText: "live DOM payload",
  });

  const jsOnlyKey = await pageEvaluate(
    pageClient,
    async (params) => {
      const service = await import(chrome.runtime.getURL("background/key-service.js"));
      return service.createKey(params);
    },
    {
      mutationId: adminMutationId(),
      displayName: "JS only",
      keyKind: "regular",
      permissions: ["js.execute"],
      expiresAt: null,
      enabled: true,
    },
  );
  const occupiedForJs = await forwardCommand(
    nativeClient,
    targetInstance,
    collaboratorKey.apiKey,
    "control-for-js-gate",
    "control.acquire",
    { scope: "tab", tabRef: coreTab.tabRef },
  );
  assert.equal(occupiedForJs.payload.ok, true);
  const blockedJs = await forwardCommand(
    nativeClient,
    targetInstance,
    jsOnlyKey.apiKey,
    "js-only-blocked",
    "js.execute",
    { tabRef: coreTab.tabRef, world: "MAIN", code: "window.pageOwnedValue", timeoutMs: 10_000 },
  );
  assert.deepEqual(blockedJs.payload.error, {
    code: "CONTROL_OCCUPIED",
    details: { scope: "tab", tabRef: coreTab.tabRef, ownerKeyId: collaboratorKey.key.keyId },
  });
  await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "control-for-js-release",
    "control.release",
    { scope: "tab", tabRef: coreTab.tabRef },
  );
  const independentJs = await forwardCommand(
    nativeClient,
    targetInstance,
    jsOnlyKey.apiKey,
    "js-only-success",
    "js.execute",
    { tabRef: coreTab.tabRef, world: "MAIN", code: "window.pageOwnedValue + 1", timeoutMs: 10_000 },
  );
  assert.equal(independentJs.payload.result.status, "fulfilled");
  assert.equal(independentJs.payload.result.valueJson, "74");

  const systemOnlyKey = await pageEvaluate(
    pageClient,
    async (params) => {
      const service = await import(chrome.runtime.getURL("background/key-service.js"));
      return service.createKey(params);
    },
    {
      mutationId: adminMutationId(),
      displayName: "System only",
      keyKind: "regular",
      permissions: ["system.read"],
      expiresAt: null,
      enabled: true,
    },
  );
  const forbiddenTabs = await forwardCommand(
    nativeClient,
    targetInstance,
    systemOnlyKey.apiKey,
    "tabs-forbidden",
    "tabs.list",
    { afterTabId: null, limit: 10 },
  );
  assert.deepEqual(forbiddenTabs.payload, {
    clientRequestId: "tabs-forbidden",
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  const forbiddenDom = await forwardCommand(
    nativeClient,
    targetInstance,
    systemOnlyKey.apiKey,
    "dom-forbidden",
    "page.dom.get",
    { root: "document", tabRef: coreTab.tabRef },
  );
  assert.deepEqual(forbiddenDom.payload, {
    clientRequestId: "dom-forbidden",
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  const forbiddenTree = await forwardCommand(
    nativeClient,
    targetInstance,
    systemOnlyKey.apiKey,
    "page-tree-forbidden",
    "page.tree.open",
    { targetRef: coreTab.tabRef },
  );
  assert.deepEqual(forbiddenTree.payload, {
    clientRequestId: "page-tree-forbidden",
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  const forbiddenTreeView = await forwardCommand(
    nativeClient,
    targetInstance,
    systemOnlyKey.apiKey,
    "page-tree-view-forbidden",
    "page.tree.view.get",
    { rootRef: pageTree.payload.result.rootRef },
  );
  assert.deepEqual(forbiddenTreeView.payload, {
    clientRequestId: "page-tree-view-forbidden",
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  const forbiddenTreeExpand = await forwardCommand(
    nativeClient,
    targetInstance,
    systemOnlyKey.apiKey,
    "page-tree-expand-forbidden",
    "page.tree.expand",
    { treeRef: htmlTreeItem.treeRef },
  );
  assert.deepEqual(forbiddenTreeExpand.payload, {
    clientRequestId: "page-tree-expand-forbidden",
    ok: false,
    error: { code: "FORBIDDEN" },
  });

  const forbiddenCases = [
    ["upload-begin-forbidden", "artifact.upload.begin", { byteLength: 1, mediaType: "text/html" }],
    ["upload-append-forbidden", "artifact.upload.append", { artifactRef: `ar1.${"A".repeat(43)}`, offset: 0, dataBase64Url: "eA" }],
    ["upload-commit-forbidden", "artifact.upload.commit", { artifactRef: `ar1.${"A".repeat(43)}`, sha256: "0".repeat(64) }],
    ["demo-open-forbidden", "demo.open", { artifactRef: `ar1.${"A".repeat(43)}` }],
    ["control-acquire-forbidden", "control.acquire", { scope: "tab", tabRef: coreTab.tabRef }],
    ["control-release-forbidden", "control.release", { scope: "tab", tabRef: coreTab.tabRef }],
    ["js-forbidden", "js.execute", {
      tabRef: coreTab.tabRef,
      world: "MAIN",
      code: "window.pageOwnedValue",
      timeoutMs: 10_000,
    }],
    ["tabs-get-forbidden", "tabs.get", { tabRef: coreTab.tabRef }],
  ];
  for (const [clientRequestId, method, params] of forbiddenCases) {
    const response = await forwardCommand(
      nativeClient,
      targetInstance,
      systemOnlyKey.apiKey,
      clientRequestId,
      method,
      params,
    );
    assert.deepEqual(response.payload, {
      clientRequestId,
      ok: false,
      error: { code: "FORBIDDEN" },
    });
  }

  const forbiddenDescribe = await forwardSystemDescribe(
    nativeClient,
    targetInstance,
    jsOnlyKey.apiKey,
    "describe-forbidden",
  );
  assert.deepEqual(forbiddenDescribe.payload, {
    clientRequestId: "describe-forbidden",
    ok: false,
    error: { code: "FORBIDDEN" },
  });

  await browserClient.send("Target.closeTarget", { targetId: staleTarget.targetId });
  const staleGetResponse = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "tabs-get-stale",
    "tabs.get",
    { tabRef: staleTab.tabRef },
  );
  assert.deepEqual(staleGetResponse.payload, {
    clientRequestId: "tabs-get-stale",
    ok: false,
    error: { code: "TAB_REF_STALE" },
  });

  const reloadCoreForTreeStaleness = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "tabs-reload-for-tree-staleness",
    "tabs.reload",
    { tabRef: coreTab.tabRef, bypassCache: true },
  );
  assert.deepEqual(reloadCoreForTreeStaleness.payload.result, { tabRef: coreTab.tabRef, reloaded: true });
  let reloadedMainDocumentRef = pageTree.payload.result.documentRef;
  const reloadDeadline = Date.now() + 10_000;
  while (Date.now() < reloadDeadline && reloadedMainDocumentRef === pageTree.payload.result.documentRef) {
    const reloadedFrames = await forwardCommand(
      nativeClient,
      targetInstance,
      createdKey.apiKey,
      `frames-after-core-reload-${Date.now()}`,
      "frames.list",
      { tabRef: coreTab.tabRef, limit: 20 },
    );
    assert.equal(reloadedFrames.payload.ok, true, JSON.stringify(reloadedFrames.payload));
    reloadedMainDocumentRef = reloadedFrames.payload.result.items.find((frame) => frame.frameId === 0)?.documentRef ??
      reloadedMainDocumentRef;
    if (reloadedMainDocumentRef === pageTree.payload.result.documentRef) await sleep(100);
  }
  assert.notEqual(reloadedMainDocumentRef, pageTree.payload.result.documentRef, "reload did not replace the main DocumentRef");
  const staleTreeExpand = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "page-tree-expand-stale",
    "page.tree.expand",
    { treeRef: pageTree.payload.result.rootRef },
  );
  assert.deepEqual(staleTreeExpand.payload, {
    clientRequestId: "page-tree-expand-stale",
    ok: false,
    error: { code: "TARGET_REF_STALE" },
  });
  const staleTreeView = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "page-tree-view-stale",
    "page.tree.view.get",
    { rootRef: pageTree.payload.result.rootRef },
  );
  assert.deepEqual(staleTreeView.payload, {
    clientRequestId: "page-tree-view-stale",
    ok: false,
    error: { code: "TARGET_REF_STALE" },
  });
  const freshTreeAfterReload = await forwardCommand(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "page-tree-open-after-reload",
    "page.tree.open",
    { targetRef: coreTab.tabRef },
  );
  assert.equal(freshTreeAfterReload.payload.ok, true, JSON.stringify(freshTreeAfterReload.payload));
  assert.notEqual(freshTreeAfterReload.payload.result.rootRef, pageTree.payload.result.rootRef);
  assert.equal(freshTreeAfterReload.payload.result.documentRef, reloadedMainDocumentRef);
  assert.equal(freshTreeAfterReload.payload.result.reused, false);

  const restartInteractions = [];
  async function restartTreeCall(method, params, label) {
    const response = await forwardCommand(nativeClient, targetInstance, createdKey.apiKey, label, method, params);
    restartInteractions.push({ method, params, response: response.payload });
    return response.payload;
  }
  const restartRoot = freshTreeAfterReload.payload.result.rootRef;
  const beforeRestart0 = await restartTreeCall("page.tree.view.get",
    { rootRef: restartRoot, maximumLevel: 0 }, "tree-worker-before-level0");
  assert.equal(beforeRestart0.ok, true, JSON.stringify(beforeRestart0));
  const restartHtml = beforeRestart0.result.items.find((item) => item.name === "HTML");
  assert.ok(restartHtml?.treeRef);
  assert.equal((await restartTreeCall("page.tree.expand",
    { treeRef: restartHtml.treeRef }, "tree-worker-expand-html")).ok, true);
  const beforeRestart1 = await restartTreeCall("page.tree.view.get",
    { rootRef: restartRoot, maximumLevel: 1 }, "tree-worker-before-level1");
  assert.equal(beforeRestart1.ok, true, JSON.stringify(beforeRestart1));
  const restartBody = beforeRestart1.result.items.find((item) => item.name === "BODY");
  assert.ok(restartBody?.treeRef);
  assert.equal((await restartTreeCall("page.tree.expand",
    { treeRef: restartBody.treeRef }, "tree-worker-expand-body")).ok, true);
  const beforeRestart2 = await restartTreeCall("page.tree.view.get",
    { rootRef: restartRoot, maximumLevel: 2 }, "tree-worker-before-level2");
  assert.equal(beforeRestart2.ok, true, JSON.stringify(beforeRestart2));
  const expandedTreePaths = (result) => result.items.filter((item) => item.expanded).map((item) => item.indexPath);
  assert.equal(expandedTreePaths(beforeRestart2.result).length, 2);

  await runtimeEvaluate(workerClient, "globalThis.__BKA_TEST_WORKER_SENTINEL = 'before-stop'");
  const workerTarget = await waitForTarget(debugPort, (target) =>
    target.type === "service_worker" && target.url === `chrome-extension://${extensionId}/background.js`);
  const workerStopped = await browserClient.send("Target.closeTarget", { targetId: workerTarget.id });
  assert.equal(workerStopped.success, true);
  workerClient.close();
  workerClient = undefined;

  // The first post-stop request must use an old child ref, before any open/view
  // could return and re-register it. The relay/offscreen path wakes the worker.
  const oldChildAfterRestart = await restartTreeCall("page.tree.expand",
    { treeRef: restartBody.treeRef }, "tree-worker-old-child-after-stop");
  assert.equal(oldChildAfterRestart.ok, true, JSON.stringify(oldChildAfterRestart));
  assert.equal(oldChildAfterRestart.result.rootRef, restartRoot);
  const afterRestart = await restartTreeCall("page.tree.view.get",
    { rootRef: restartRoot, maximumLevel: 2 }, "tree-worker-old-root-after-stop");
  assert.equal(afterRestart.ok, true, JSON.stringify(afterRestart));
  assert.deepEqual(expandedTreePaths(afterRestart.result), expandedTreePaths(beforeRestart2.result));
  assert.equal(afterRestart.result.rootRef, restartRoot);
  assert.notEqual(afterRestart.result.tabRef, beforeRestart2.result.tabRef);
  workerClient = await waitForExtensionWorker(debugPort);
  assert.equal(await runtimeEvaluate(workerClient, "typeof globalThis.__BKA_TEST_WORKER_SENTINEL"), "undefined");

  const oldTabAfterRestart = await restartTreeCall("tabs.get",
    { tabRef: beforeRestart2.result.tabRef }, "tree-worker-old-tab-remains-stale");
  assert.equal(oldTabAfterRestart.ok, false);
  assert.equal(oldTabAfterRestart.error.code, "TAB_REF_STALE");
  const reopenedAfterRestart = await restartTreeCall("page.tree.open",
    { targetRef: afterRestart.result.tabRef }, "tree-worker-reopen-current-tab");
  assert.equal(reopenedAfterRestart.ok, true, JSON.stringify(reopenedAfterRestart));
  assert.equal(reopenedAfterRestart.result.rootRef, restartRoot);
  assert.equal(reopenedAfterRestart.result.reused, true);

  const restartedTabReload = await restartTreeCall("tabs.reload",
    { tabRef: afterRestart.result.tabRef, bypassCache: true }, "tree-worker-refresh-current-tab");
  assert.equal(restartedTabReload.ok, true, JSON.stringify(restartedTabReload));
  let changedDocument = false;
  const restartedReloadDeadline = Date.now() + 10_000;
  while (Date.now() < restartedReloadDeadline && !changedDocument) {
    const frames = await forwardCommand(nativeClient, targetInstance, createdKey.apiKey,
      `tree-worker-refresh-frames-${Date.now()}`, "frames.list", { tabRef: afterRestart.result.tabRef, limit: 20 });
    assert.equal(frames.payload.ok, true, JSON.stringify(frames.payload));
    const currentMain = frames.payload.result.items.find((frame) => frame.frameId === 0);
    changedDocument = currentMain?.documentRef != null && currentMain.documentRef !== afterRestart.result.documentRef;
    if (!changedDocument) await sleep(100);
  }
  assert.equal(changedDocument, true);
  for (const [method, params] of [
    ["page.tree.view.get", { rootRef: restartRoot }],
    ["page.tree.expand", { treeRef: restartBody.treeRef }],
  ]) {
    const stale = await restartTreeCall(method, params, `tree-worker-stale-after-refresh-${method}`);
    assert.equal(stale.ok, false, JSON.stringify(stale));
    assert.equal(stale.error.code, "TARGET_REF_STALE");
  }
  await writeFile(path.join(workspaceRoot, "out", "test-artifacts", "page-tree-worker-restart.json"),
    `${JSON.stringify({ workerStopConfirmed: true, userBrowserTouched: false, interactions: restartInteractions }, null, 2)}\n`);

  const keyParts = createdKey.apiKey.split(".");
  const lastCharacter = keyParts[2].at(-1);
  const wrongApiKey = `${keyParts[0]}.${keyParts[1]}.${keyParts[2].slice(0, -1)}${lastCharacter === "A" ? "B" : "A"}`;
  const wrongKeyResponse = await forwardSystemDescribe(
    nativeClient,
    targetInstance,
    wrongApiKey,
    "describe-wrong-key",
  );
  assert.deepEqual(wrongKeyResponse.payload, {
    clientRequestId: "describe-wrong-key",
    ok: false,
    error: { code: "UNAUTHENTICATED" },
  });

  await pageEvaluate(
    pageClient,
    async (params) => {
      const service = await import(chrome.runtime.getURL("background/key-service.js"));
      return service.revokeKey(params);
    },
    {
      mutationId: adminMutationId(),
      keyId: createdKey.key.keyId,
      expectedRevision: createdKey.key.recordRevision,
    },
  );
  const revokedResponse = await forwardSystemDescribe(
    nativeClient,
    targetInstance,
    createdKey.apiKey,
    "describe-revoked",
  );
  assert.deepEqual(revokedResponse.payload, {
    clientRequestId: "describe-revoked",
    ok: false,
    error: { code: "UNAUTHENTICATED" },
  });

  if (ownsRelay) {
    nativeClient.sendJson({ kind: "instances.list" });
    const finalInstanceList = await nativeClient.readJson();
    const hasExternalInstance = finalInstanceList.instances.some((instance) =>
      instance.instanceNumber !== targetInstance.instanceNumber
    );
    if (hasExternalInstance) {
      preserveRelay = true;
    } else {
      nativeClient.sendJson({ kind: "relay.stop" });
      assert.deepEqual(await nativeClient.readJson(), { kind: "relay.stopping" });
      const relayExitCode = await waitForExit(relay, 5000);
      assert.equal(relayExitCode, 0, `relay output:\n${relayOutput}`);
    }
  }

  console.log(
    JSON.stringify({
      ok: true,
      chromium: path.basename(path.dirname(path.dirname(chromiumExecutable))),
      extensionConnectedThroughOffscreenWorker: true,
      reconnectElapsedMs,
      usedExistingRelay: !ownsRelay,
      relayAssignedInstanceNumber: targetInstance.instanceNumber,
      extensionDidNotReceiveInstanceRef: true,
      systemDescribeAuthenticationStates: ["valid", "wrong-secret", "revoked"],
      tabsReadStates: ["paged", "live", "forbidden", "stale"],
      controlStates: ["acquired", "idempotent", "conflict", "foreign-release", "global-conflict", "effect-gate"],
      liveDomReadThroughScripting: true,
      pageTreeStates: [
        "opened",
        "cached-by-document",
        "expanded-by-key",
        "per-key-isolated",
        "layer-view",
        "sibling-range",
        "subtree-view",
        "fully-expanded",
        "long-values-reassembled",
        "child-frame",
        "forbidden",
        "stale-after-refresh",
        "old-tree-refs-survive-worker-restart",
        "old-tab-ref-not-revived",
        "stale-after-post-restart-refresh",
      ],
      pageTreeFinalItems: traversedTree.items.length,
      pageTreeTraversalCommands: traversedTree.commandCount,
      userScriptsState,
      javascriptPermissionIndependent: true,
      realInput: realInputEvidence,
      usability,
      shotDemo,
      tabRefOwnedByExtension: true,
      tabTextBoundsObserved: true,
    }),
  );
} catch (error) {
  if (chromiumStderr) console.error(chromiumStderr.slice(-8000));
  throw error;
} finally {
  nativeClient?.close();
  pageClient?.close();
  browserClient?.close();
  workerClient?.close();
  await closeServer(testPageServer);
  if (relay?.exitCode === null && preserveRelay) {
    relay.stdout?.destroy();
    relay.stderr?.destroy();
    relay.unref();
  } else if (relay?.exitCode === null) {
    relay.kill();
  }
  await closeBrowser(chromium, debugPort);
  await removeRunRoot();
}

function adminMutationId() {
  return `am1.${Date.now().toString().padStart(13, "0")}.${randomBytes(16).toString("base64url")}`;
}

function extensionIdFromManifestKey(key) {
  assert.equal(typeof key, "string");
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return Array.from(hex, (nibble) =>
    String.fromCharCode("a".charCodeAt(0) + Number.parseInt(nibble, 16)),
  ).join("");
}

async function forwardSystemDescribe(client, targetInstance, apiKey, clientRequestId) {
  return forwardCommand(
    client,
    targetInstance,
    apiKey,
    clientRequestId,
    "system.describe",
    {},
  );
}

async function forwardCommand(
  client,
  targetInstance,
  apiKey,
  clientRequestId,
  method,
  params,
  schemaVersion = method === "page.tree.expand" ? 2 : 1,
) {
  client.sendJson({
    kind: "forward",
    clientRequestId,
    targetInstance,
    auth: { apiKey },
    command: {
      method,
      schemaVersion,
      params,
    },
  });
  return client.readJson(30_000);
}

async function readPageTreeView(client, targetInstance, apiKey, rootRef, params, requestId) {
  const response = await forwardCommand(
    client,
    targetInstance,
    apiKey,
    requestId,
    "page.tree.view.get",
    { rootRef, ...params },
  );
  assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
  assert.equal(response.payload.result.rootRef, rootRef);
  assert.ok(Buffer.byteLength(JSON.stringify(response.payload.result), "utf8") <= inlineResultByteLimit);
  assertPageTreeViewItems(response.payload.result.items);
  return response;
}

async function expandPageTree(client, targetInstance, apiKey, treeRef, requestId) {
  assert.match(treeRef, /^tr2\.[A-Za-z0-9_-]{43}$/u);
  const response = await forwardCommand(
    client,
    targetInstance,
    apiKey,
    requestId,
    "page.tree.expand",
    { treeRef },
  );
  assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
  assert.equal(response.payload.result.treeRef, treeRef);
  assert.equal(response.payload.result.expanded, true);
  assert.ok(Buffer.byteLength(JSON.stringify(response.payload.result), "utf8") <= inlineResultByteLimit);
  return response;
}

async function fullyExpandPageTree(client, targetInstance, apiKey, rootRef) {
  const attemptedRefs = new Set();
  const steps = [];
  let commandCount = 0;
  let cycle = 0;
  while (cycle < 128) {
    const view = await readPageTreeView(
      client,
      targetInstance,
      apiKey,
      rootRef,
      {},
      `page-tree-full-view-${cycle}`,
    );
    assert.equal(view.payload.result.truncated, false, "fixture tree unexpectedly exceeded the inline view bound");
    const candidates = view.payload.result.items.filter((item) =>
      item.treeRef !== null && !item.expanded && !attemptedRefs.has(item.treeRef)
    );
    if (candidates.length === 0) {
      return { items: view.payload.result.items, commandCount, steps, view };
    }
    for (const candidate of candidates) {
      attemptedRefs.add(candidate.treeRef);
      commandCount += 1;
      assert.ok(commandCount <= 500, "page-tree expansion exceeded its deterministic command bound");
      const response = await expandPageTree(
        client,
        targetInstance,
        apiKey,
        candidate.treeRef,
        `page-tree-full-expand-${commandCount}`,
      );
      steps.push({
        sequence: commandCount,
        indexPath: candidate.indexPath,
        request: { method: "page.tree.expand", schemaVersion: 2, params: { treeRef: candidate.treeRef } },
        response: response.payload,
      });
    }
    cycle += 1;
  }
  assert.fail("page-tree expansion did not converge within 128 view cycles");
}

function assertPageTreeViewItems(items) {
  const paths = new Set();
  for (const item of items) {
    assert.equal(Array.isArray(item.indexPath), true);
    assert.ok(item.indexPath.length > 0);
    assert.equal(item.level, item.indexPath.length - 1);
    assert.equal(item.sourceOrder, item.indexPath.at(-1));
    assert.equal(item.indexPath.every((part) => Number.isSafeInteger(part) && part >= 0), true);
    const key = JSON.stringify(item.indexPath);
    assert.equal(paths.has(key), false, `duplicate page-tree canonical index ${key}`);
    paths.add(key);
    assert.equal("importance" in item, false);
    assert.equal("selection" in item, false);
    if (item.treeRef === null) {
      assert.equal(item.expanded, false);
    } else {
      assert.match(item.treeRef, /^tr2\.[A-Za-z0-9_-]{43}$/u);
    }
    if (item.nodeRef !== null) assert.match(item.nodeRef, /^nr1\.[A-Za-z0-9_-]{43}$/u);
  }
}

function requiredTreeItem(items, indexPath) {
  const item = items.find((candidate) => pathsEqual(candidate.indexPath, indexPath));
  assert.ok(item, `page-tree item ${JSON.stringify(indexPath)} is missing`);
  return item;
}

function directChildItems(items, parentPath) {
  return items.filter((item) =>
    item.indexPath.length === parentPath.length + 1 &&
    parentPath.every((part, index) => item.indexPath[index] === part)
  );
}

function pathsEqual(left, right) {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function readExpandedPageTreeValue(items, parentPath) {
  const chunks = directChildItems(items, parentPath).filter((item) => item.kind === "value_chunk");
  assert.ok(chunks.length > 1, `expanded value ${JSON.stringify(parentPath)} did not expose chunks`);
  return chunks.map((item) => item.valuePreview ?? "").join("");
}

function findChromiumExecutable() {
  const explicit = process.env.BKA_CHROMIUM_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const browserRoot = path.join("D:\\", "Code", "CommonAssets", "Tools", "PlaywrightBrowsers");
  if (existsSync(browserRoot)) {
    const directories = readdirSync(browserRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^chromium-\d+$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort(
        (left, right) =>
          Number(right.slice("chromium-".length)) - Number(left.slice("chromium-".length)),
      );
    for (const directory of directories) {
      const executable = path.join(browserRoot, directory, "chrome-win64", "chrome.exe");
      if (existsSync(executable)) return executable;
    }
  }
  return null;
}

async function listenServer(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(address.port);
    });
  });
}

async function closeServer(server) {
  server.closeAllConnections?.();
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function connectBrowser(port) {
  const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
  return CdpClient.connect(version.webSocketDebuggerUrl);
}

async function waitForTarget(port, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    const target = targets.find(predicate);
    if (target?.webSocketDebuggerUrl) return target;
    await sleep(100);
  }
  throw new Error("Timed out waiting for Chromium target");
}

async function waitForExtensionWorker(port) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    for (const target of targets) {
      if (
        target?.type !== "service_worker" ||
        !String(target.url ?? "").startsWith("chrome-extension://") ||
        !target.webSocketDebuggerUrl
      ) {
        continue;
      }
      const client = await CdpClient.connect(target.webSocketDebuggerUrl);
      try {
        await client.send("Runtime.enable");
        const manifest = await runtimeEvaluate(client, "chrome.runtime.getManifest()");
        if (manifest?.name === "Browser Key Automation") return client;
      } catch {
        // Inspect another extension worker.
      }
      client.close();
    }
    await sleep(100);
  }
  throw new Error("Timed out waiting for Browser Key Automation service worker");
}

async function waitForOffscreenState(port, expectedKind, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    const offscreen = targets.find((target) =>
      String(target?.url ?? "").endsWith("/offscreen/index.html"),
    );
    if (offscreen?.title === `BKA ${expectedKind}`) return Date.now();
    if (offscreen?.title === "BKA transport.worker-error") {
      throw new Error("Offscreen transport worker failed to start");
    }
    await sleep(50);
  }
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
  throw new Error(
    `Timed out waiting for ${expectedKind}; targets=${targets
      .map((target) => `${String(target.type)}:${String(target.title)}:${String(target.url)}`)
      .join(",")}`,
  );
}

async function waitForOffscreenTransportState(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    const offscreen = targets.find((target) =>
      String(target?.url ?? "").endsWith("/offscreen/index.html"),
    );
    if (offscreen?.title === "BKA transport.connected") {
      return { kind: "transport.connected", observedAt: Date.now() };
    }
    if (offscreen?.title === "BKA transport.disconnected") {
      return { kind: "transport.disconnected", observedAt: Date.now() };
    }
    if (offscreen?.title === "BKA transport.worker-error") {
      throw new Error("Offscreen transport worker failed to start");
    }
    await sleep(50);
  }
  throw new Error("Timed out waiting for a known offscreen transport state");
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(25);
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for relay exit")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function closeBrowser(child, port) {
  try {
    const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    const client = await CdpClient.connect(version.webSocketDebuggerUrl);
    await client.send("Browser.close").catch(() => undefined);
    client.close();
  } catch {
    // Exact launcher cleanup below is sufficient.
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(3000)]);
  if (child.exitCode === null && child.signalCode === null && process.platform === "win32" && child.pid) {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("exit", resolve);
      killer.once("error", resolve);
    });
  }
}

async function removeRunRoot() {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      await rm(runRoot, { recursive: true, force: true });
      return;
    } catch {
      await sleep(100 * attempt);
    }
  }
}
