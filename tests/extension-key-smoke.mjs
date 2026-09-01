import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CdpClient, pageEvaluate, runtimeEvaluate } from "./lib/cdp-client.mjs";

const currentFile = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(currentFile), "..");
const { assertIsolatedFixture } = await import("./lib/isolation.mjs");
assertIsolatedFixture(workspaceRoot);
const extensionDir = path.join(workspaceRoot, "out", "extension");
const runRoot = path.join(workspaceRoot, "out", "test-artifacts", `key-smoke-${process.pid}-${Date.now()}`);
const profileDir = path.join(runRoot, "profile");
const screenshotPath = path.join(workspaceRoot, "out", "test-artifacts", "admin-ui-smoke.png");
const createDialogScreenshotPath = path.join(workspaceRoot, "out", "test-artifacts", "admin-ui-create-light.png");
const mobileScreenshotPath = path.join(workspaceRoot, "out", "test-artifacts", "admin-ui-mobile.png");
const arabicScreenshotPath = path.join(workspaceRoot, "out", "test-artifacts", "admin-ui-arabic-rtl.png");
const traditionalChineseScreenshotPath = path.join(workspaceRoot, "out", "test-artifacts", "admin-ui-traditional-chinese.png");
const welcomeScreenshotPath = path.join(workspaceRoot, "out", "test-artifacts", "welcome-ui.png");
const welcomeMobileScreenshotPath = path.join(workspaceRoot, "out", "test-artifacts", "welcome-ui-mobile.png");
const welcomeSamplesPath = path.join(workspaceRoot, "out", "test-artifacts", "welcome-interaction.json");
const storeListingRoot = path.join(workspaceRoot, "out", "chrome-web-store", "listing-assets");
const storeWelcomeScreenshotPath = path.join(storeListingRoot, "screenshot-1-setup-1280x800.png");
const storeKeysScreenshotPath = path.join(storeListingRoot, "screenshot-2-key-management-1280x800.png");
const storePermissionsScreenshotPath = path.join(storeListingRoot, "screenshot-3-key-permissions-1280x800.png");
const API_KEY_PATTERN = /^bk1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u;
const builtManifest = JSON.parse(await readFile(path.join(extensionDir, "manifest.json"), "utf8"));
const expectedExtensionId = extensionIdFromManifestKey(builtManifest.key);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function extensionIdFromManifestKey(key) {
  assert.equal(typeof key, "string");
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return Array.from(hex, (nibble) =>
    String.fromCharCode("a".charCodeAt(0) + Number.parseInt(nibble, 16)),
  ).join("");
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

function findChromiumExecutable() {
  const explicit = process.env.BKA_CHROMIUM_PATH;
  if (explicit && existsSync(explicit)) return explicit;

  const browserRoot = path.join("D:\\", "Code", "CommonAssets", "Tools", "PlaywrightBrowsers");
  if (existsSync(browserRoot)) {
    const directories = readdirSync(browserRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^chromium-\d+$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => Number(right.slice("chromium-".length)) - Number(left.slice("chromium-".length)));
    let index = 0;
    while (index < directories.length) {
      const executable = path.join(browserRoot, directories[index] ?? "", "chrome-win64", "chrome.exe");
      if (existsSync(executable)) return executable;
      index += 1;
    }
  }

  const chrome = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");
  return existsSync(chrome) ? chrome : null;
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function waitForTarget(debugPort, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastTargets = [];
  while (Date.now() < deadline) {
    try {
      lastTargets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
      const target = lastTargets.find(predicate);
      if (target?.webSocketDebuggerUrl) return target;
    } catch {
      // Chromium may not have opened the debugging socket yet.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for target; observed=${lastTargets.map((target) => `${target.type}:${target.url}`).join(",")}`);
}

async function waitForExtensionWorker(debugPort) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`).catch(() => []);
    let index = 0;
    while (index < targets.length) {
      const target = targets[index];
      if (target?.type === "service_worker" && /^chrome-extension:\/\//u.test(target.url ?? "") && target.webSocketDebuggerUrl) {
        const client = await CdpClient.connect(target.webSocketDebuggerUrl);
        try {
          await client.send("Runtime.enable");
          const manifest = await runtimeEvaluate(client, "chrome.runtime.getManifest()");
          if (manifest?.name === "Browser Key Automation" && manifest?.background?.service_worker === "background.js") {
            return { target, client };
          }
        } catch {
          // Inspect the next extension worker.
        }
        client.close();
      }
      index += 1;
    }
    await sleep(100);
  }
  throw new Error("Timed out waiting for Browser Key Automation service worker");
}

function extensionIdFromUrl(url) {
  const match = /^chrome-extension:\/\/([^/]+)\//u.exec(String(url ?? ""));
  return match?.[1] ?? "";
}

async function connectBrowser(debugPort) {
  const version = await fetchJson(`http://127.0.0.1:${debugPort}/json/version`);
  assert.equal(typeof version.webSocketDebuggerUrl, "string");
  return CdpClient.connect(version.webSocketDebuggerUrl);
}

async function waitForAdminReady(pageClient) {
  const deadline = Date.now() + 15_000;
  let snapshot = null;
  while (Date.now() < deadline) {
    try {
      snapshot = await pageEvaluate(pageClient, () => ({
        readyState: document.readyState,
        connection: document.querySelector("[data-connection]")?.dataset.state ?? "",
        listLoaded: document.querySelector("[data-key-rows]")?.dataset.loaded ?? "",
        status: document.querySelector("[data-status]")?.textContent ?? "",
        statusKind: document.querySelector("[data-status]")?.dataset.kind ?? "",
        statusVisible: document.querySelector("[data-status]")?.dataset.visible ?? "",
        rowCount: document.querySelectorAll("[data-key-rows] tr").length,
        secretHidden: document.querySelector("[data-secret-panel]")?.hidden === true,
        secretValue: document.querySelector("[data-secret]")?.value ?? "",
      }));
      if (snapshot.readyState === "complete" && snapshot.connection === "connected" && snapshot.listLoaded === "true") return snapshot;
    } catch {
      // Runtime context is replaced during initial navigation/reload.
    }
    await sleep(100);
  }
  throw new Error(`Admin page did not become ready: ${JSON.stringify({ ...snapshot, secretValue: snapshot?.secretValue ? "<redacted>" : "" })}`);
}

async function waitForCondition(pageClient, probe, predicate, label, probeArgument, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let value = null;
  while (Date.now() < deadline) {
    try {
      value = await pageEvaluate(pageClient, probe, probeArgument);
      if (predicate(value)) return value;
    } catch {
      // Retry only within this bounded test wait.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function closeBrowser(child, debugPort) {
  try {
    const version = await fetchJson(`http://127.0.0.1:${debugPort}/json/version`);
    if (version.webSocketDebuggerUrl) {
      const client = await CdpClient.connect(version.webSocketDebuggerUrl);
      await client.send("Browser.close").catch(() => undefined);
      client.close();
    }
  } catch {
    // Fall through to the exact launcher process.
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(3_000)]);
  if (child.exitCode === null && child.signalCode === null && process.platform === "win32" && child.pid) {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/F"], { stdio: "ignore", windowsHide: true });
      killer.once("exit", resolve);
      killer.once("error", resolve);
    });
  }
}

async function removeRunRoot() {
  let attempt = 0;
  while (attempt < 8) {
    try {
      await rm(runRoot, { recursive: true, force: true });
      return;
    } catch {
      attempt += 1;
      await sleep(100 * attempt);
    }
  }
}

async function main() {
  const executable = findChromiumExecutable();
  assert.ok(executable, "No Chromium executable was found");
  assert.ok(existsSync(path.join(extensionDir, "manifest.json")), "Build the extension before running the smoke test");
  const { attachAdminEntry } = await import(
    pathToFileURL(path.join(extensionDir, "background", "admin-entry.js")).href
  );
  let actionListener = null;
  let optionsPageOpenCount = 0;
  attachAdminEntry({
    action: {
      onClicked: {
        addListener(callback) {
          actionListener = callback;
        },
      },
    },
    runtime: {
      async openOptionsPage() {
        optionsPageOpenCount += 1;
      },
    },
  });
  assert.equal(typeof actionListener, "function");
  actionListener();
  assert.equal(optionsPageOpenCount, 1);
  await mkdir(profileDir, { recursive: true });
  const debugPort = await getFreePort();
  let stderrTail = "";
  const child = spawn(executable, [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--enable-extensions",
    "--enable-unsafe-extension-debugging",
    "--headless=new",
    "--window-size=1440,1000",
    "--lang=en-US",
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
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + String(chunk)).slice(-65_536);
  });

  let workerClient = null;
  let browserClient = null;
  let pageClient = null;
  let welcomeClient = null;
  let settingsClient = null;
  try {
    const worker = await waitForExtensionWorker(debugPort);
    workerClient = worker.client;
    const extensionId = extensionIdFromUrl(worker.target.url);
    assert.equal(extensionId, expectedExtensionId);
    assert.equal(builtManifest.action.default_title, "__MSG_actionTitle__");
    assert.deepEqual(builtManifest.action.default_icon, {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
    });
    assert.equal(builtManifest.default_locale, "en");

    browserClient = await connectBrowser(debugPort);
    const welcomeUrl = `chrome-extension://${extensionId}/admin/welcome.html`;
    // No Target.createTarget or tabs.create here: installation itself must open it.
    const welcomeTarget = await waitForTarget(debugPort, (target) => target.url === welcomeUrl);
    welcomeClient = await CdpClient.connect(welcomeTarget.webSocketDebuggerUrl);
    await welcomeClient.send("Runtime.enable"); await welcomeClient.send("Page.enable");
    const setupSnapshot = () => ({
      title: document.title,
      state: document.querySelector("[data-user-scripts-setup]")?.dataset.userScriptsState,
      status: document.querySelector("[data-user-scripts-status]")?.textContent,
      message: document.querySelector("[data-user-scripts-message]")?.textContent,
      settingsUrl: document.querySelector("[data-script-settings-url]")?.value,
      innerWidth: innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
    });
    const welcomeBefore = await waitForCondition(welcomeClient, setupSnapshot,
      (value) => value.state === "required", "fresh-install User Scripts instructions");
    assert.equal(welcomeBefore.settingsUrl, `chrome://extensions/?id=${extensionId}`);
    assert.match(welcomeBefore.message, /Allow User Scripts/u);
    assert.equal(welcomeBefore.clientWidth, welcomeBefore.scrollWidth);
    await mkdir(path.dirname(welcomeScreenshotPath), { recursive: true });
    const welcomeLayout = await welcomeClient.send("Page.getLayoutMetrics");
    const welcomeImage = await welcomeClient.send("Page.captureScreenshot", { format: "png", fromSurface: true,
      captureBeyondViewport: true, clip: { x: 0, y: 0, width: welcomeLayout.cssContentSize.width, height: welcomeLayout.cssContentSize.height, scale: 1 } });
    await writeFile(welcomeScreenshotPath, Buffer.from(welcomeImage.data, "base64"));
    await mkdir(storeListingRoot, { recursive: true });
    await welcomeClient.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    const storeWelcomeLayout = await pageEvaluate(welcomeClient, () => {
      const locale = document.querySelector("[data-locale]");
      locale.value = "en";
      locale.dispatchEvent(new Event("change", { bubbles: true }));
      const theme = document.querySelector("[data-theme]");
      theme.value = "dark";
      theme.dispatchEvent(new Event("change", { bubbles: true }));
      return { lang: document.documentElement.lang, width: innerWidth, height: innerHeight };
    });
    assert.deepEqual(storeWelcomeLayout, { lang: "en", width: 1280, height: 800 });
    const storeWelcomeImage = await welcomeClient.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    await writeFile(storeWelcomeScreenshotPath, Buffer.from(storeWelcomeImage.data, "base64"));
    await welcomeClient.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const welcomeMobile = await pageEvaluate(welcomeClient, setupSnapshot);
    assert.equal(welcomeMobile.innerWidth, 390); assert.equal(welcomeMobile.scrollWidth, 390);
    const welcomeMobileImage = await welcomeClient.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    await writeFile(welcomeMobileScreenshotPath, Buffer.from(welcomeMobileImage.data, "base64"));
    await welcomeClient.send("Emulation.clearDeviceMetricsOverride");

    await pageEvaluate(welcomeClient, () => document.querySelector("[data-open-script-settings]").click());
    const settingsTarget = await waitForTarget(debugPort, (target) =>
      String(target.url ?? "").startsWith("chrome://extensions/") && String(target.url).includes(extensionId));
    settingsClient = await CdpClient.connect(settingsTarget.webSocketDebuggerUrl);
    await settingsClient.send("Runtime.enable");
    await waitForCondition(settingsClient, () => {
      const detail = document.querySelector("extensions-manager")?.shadowRoot?.querySelector("extensions-detail-view");
      const toggle = detail?.shadowRoot?.querySelector("#allow-user-scripts")?.shadowRoot?.querySelector("#crToggle");
      if (!toggle) return false;
      if (!toggle.checked) toggle.click();
      return true;
    }, (value) => value === true, "actual browser User Scripts switch");
    await pageEvaluate(welcomeClient, () => document.querySelector("[data-recheck-user-scripts]").click());
    const welcomeAfter = await waitForCondition(welcomeClient, setupSnapshot,
      (value) => value.state === "ready", "User Scripts check after enabling and page reload");
    await writeFile(welcomeSamplesPath, JSON.stringify({ firstInstallOpenedWelcome: true,
      before: welcomeBefore, mobile: welcomeMobile, settingsOpenedByExtensionButton: true,
      afterEnablingAndRechecking: welcomeAfter }, null, 2) + "\n");
    settingsClient.close(); settingsClient = null;
    await browserClient.send("Target.closeTarget", { targetId: settingsTarget.id });
    welcomeClient.close(); welcomeClient = null;
    await browserClient.send("Target.closeTarget", { targetId: welcomeTarget.id });

    const adminUrl = `chrome-extension://${extensionId}/admin/index.html`;
    assert.equal(
      await runtimeEvaluate(workerClient, "chrome.runtime.openOptionsPage().then(() => true)"),
      true,
    );
    const pageTarget = await waitForTarget(
      debugPort,
      (target) => String(target.url ?? "") === adminUrl,
    );
    pageClient = await CdpClient.connect(pageTarget.webSocketDebuggerUrl);
    await pageClient.send("Runtime.enable");
    await pageClient.send("Page.enable");
    const initial = await waitForAdminReady(pageClient);
    assert.equal(initial.rowCount, 0);
    assert.equal(await pageEvaluate(pageClient, () => document.querySelector("[data-user-scripts-setup]")?.dataset.userScriptsState), "ready");

    const localeSwitch = await pageEvaluate(pageClient, () => {
      const value = crypto.randomUUID();
      globalThis.__bkaAdminPageIdentity = value;
      document.querySelector("[data-open-create]")?.click();
      const name = document.querySelector("[data-create-name]");
      const locale = document.querySelector("[data-locale]");
      name.value = "preserved draft";
      locale.value = "ar";
      locale.dispatchEvent(new Event("change", { bubbles: true }));
      const arabic = { lang: document.documentElement.lang, dir: document.documentElement.dir,
        dialogOpen: document.querySelector("[data-create-dialog]")?.open === true, draft: name.value };
      locale.value = "zh-CN";
      locale.dispatchEvent(new Event("change", { bubbles: true }));
      const chinese = { lang: document.documentElement.lang, dir: document.documentElement.dir,
        dialogOpen: document.querySelector("[data-create-dialog]")?.open === true, draft: name.value,
        saved: localStorage.getItem("browser-key-automation.ui-locale.v1"), choices: locale.options.length };
      document.querySelector("[data-create-dialog]")?.close();
      return { pageIdentity: value, arabic, chinese };
    });
    assert.deepEqual(localeSwitch.arabic, { lang: "ar", dir: "rtl", dialogOpen: true, draft: "preserved draft" });
    assert.deepEqual(localeSwitch.chinese,
      { lang: "zh-CN", dir: "ltr", dialogOpen: true, draft: "preserved draft", saved: "zh-CN", choices: 21 });
    const pageIdentity = localeSwitch.pageIdentity;
    const stoppedWorker = await browserClient.send("Target.closeTarget", {
      targetId: worker.target.id,
    });
    assert.equal(stoppedWorker.success, true);
    workerClient.close();
    workerClient = null;
    await waitForCondition(
      pageClient,
      () => document.querySelector("[data-connection]")?.dataset.state ?? "",
      (value) => value === "disconnected",
      "admin Port disconnect after service worker stop",
    );
    await pageEvaluate(pageClient, () => {
      document.querySelector("[data-refresh]")?.click();
    });
    const recoveredAdmin = await waitForCondition(
      pageClient,
      () => ({
        connection: document.querySelector("[data-connection]")?.dataset.state ?? "",
        rowCount: document.querySelectorAll("[data-key-rows] tr").length,
        pageIdentity: globalThis.__bkaAdminPageIdentity ?? null,
        locale: document.documentElement.lang,
      }),
      (value) => value.connection === "connected" && value.rowCount === 0,
      "admin reconnect without page reload",
    );
    assert.deepEqual(recoveredAdmin, {
      connection: "connected",
      rowCount: 0,
      pageIdentity,
      locale: "zh-CN",
    });
    const restartedWorker = await waitForExtensionWorker(debugPort);
    workerClient = restartedWorker.client;
    assert.equal(extensionIdFromUrl(restartedWorker.target.url), extensionId);

    await pageEvaluate(pageClient, () => {
      document.querySelector("[data-open-create]")?.click();
      document.querySelector("[data-create-name]").value = "Smoke Regular";
      document.querySelector("[data-create-kind]").value = "regular";
      document.querySelector("[data-create-form]").requestSubmit();
    });
    const createdSnapshot = await waitForCondition(
      pageClient,
      () => ({
        apiKey: document.querySelector("[data-secret]")?.value ?? "",
        rowCount: document.querySelectorAll("[data-key-rows] tr").length,
        secretOpen: document.querySelector("[data-secret-dialog]")?.open === true,
      }),
      (value) => API_KEY_PATTERN.test(value.apiKey) && value.rowCount === 1 && value.secretOpen,
      "first Key creation",
    );
    const apiKey = createdSnapshot.apiKey;
    const keyId = apiKey.split(".")[1];

    const authBefore = await pageEvaluate(pageClient, async ({ apiKey: key }) => {
      const service = await import(chrome.runtime.getURL("background/key-service.js"));
      const valid = await service.authenticateApiKey(key, "system.read");
      const parts = key.split(".");
      const wrongLast = parts[2].endsWith("A") ? "B" : "A";
      const wrong = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -1)}${wrongLast}`;
      const invalid = await service.authenticateApiKey(wrong, "system.read");
      return { validOk: valid.ok, invalidOk: invalid.ok, invalidCode: invalid.code ?? null };
    }, { apiKey });
    assert.deepEqual(authBefore, { validOk: true, invalidOk: false, invalidCode: "UNAUTHENTICATED" });

    const hiddenAfterCreate = await pageEvaluate(pageClient, ({ id, key }) => {
      document.querySelector("[data-done-secret]")?.click();
      const row = document.querySelector(`[data-key-id="${id}"]`);
      return {
        secretHidden: document.querySelector("[data-secret-panel]")?.hidden === true,
        secretValue: document.querySelector("[data-secret]")?.value ?? "",
        rowTextHasSecret: row?.textContent?.includes(key) ?? false,
      };
    }, { id: keyId, key: apiKey });
    assert.deepEqual(hiddenAfterCreate, { secretHidden: true, secretValue: "", rowTextHasSecret: false });

    await pageEvaluate(pageClient, ({ id }) => {
      document.querySelector(`[data-key-id="${id}"] [data-key-reveal]`)?.click();
    }, { id: keyId });
    const firstReveal = await waitForCondition(
      pageClient,
      ({ id }) => document.querySelector(`[data-key-id="${id}"] [data-key-token]`)?.textContent ?? "",
      (value) => value === apiKey,
      "first repeatable reveal",
      { id: keyId },
    );
    assert.equal(firstReveal, apiKey);
    await pageEvaluate(pageClient, ({ id }) => {
      document.querySelector(`[data-key-id="${id}"] [data-key-reveal]`)?.click();
    }, { id: keyId });
    await waitForCondition(
      pageClient,
      ({ id }) => document.querySelector(`[data-key-id="${id}"] [data-key-token]`)?.textContent ?? "",
      (value) => !API_KEY_PATTERN.test(value),
      "row Key hide",
      { id: keyId },
    );

    const duplicateProbe = await pageEvaluate(pageClient, async () => {
      const token = () => {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        let binary = "";
        let index = 0;
        while (index < bytes.length) {
          binary += String.fromCharCode(bytes[index] ?? 0);
          index += 1;
        }
        return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
      };
      const port = chrome.runtime.connect({ name: "browser-key-automation.admin.v1" });
      const request = (message) => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("admin probe timeout")), 5000);
        const listener = (response) => {
          if (response?.requestId !== message.requestId) return;
          clearTimeout(timeout);
          resolve(response);
        };
        port.onMessage.addListener(listener);
        port.postMessage(message);
      });
      const mutationId = `am1.${Date.now().toString().padStart(13, "0")}.${token()}`;
      const params = {
        mutationId,
        displayName: "Duplicate Probe",
        keyKind: "regular",
        permissions: ["system.read"],
        expiresAt: null,
        enabled: true,
      };
      const first = await request({ requestId: `ui1.${token()}`, method: "keys.create", params });
      const second = await request({ requestId: `ui1.${token()}`, method: "keys.create", params });
      port.disconnect();
      return {
        firstOk: first.ok,
        firstHasSecret: typeof first.result?.apiKey === "string",
        secondOk: second.ok,
        secondHasSecret: typeof second.result?.apiKey === "string",
        sameSecret: first.result?.apiKey === second.result?.apiKey,
        sameKeyId: first.result?.key?.keyId === second.result?.key?.keyId,
        params,
      };
    });
    assert.deepEqual(
      {
        firstOk: duplicateProbe.firstOk,
        firstHasSecret: duplicateProbe.firstHasSecret,
        secondOk: duplicateProbe.secondOk,
        secondHasSecret: duplicateProbe.secondHasSecret,
        sameSecret: duplicateProbe.sameSecret,
        sameKeyId: duplicateProbe.sameKeyId,
      },
      { firstOk: true, firstHasSecret: true, secondOk: true, secondHasSecret: true, sameSecret: true, sameKeyId: true },
    );

    await pageEvaluate(pageClient, ({ params }) => {
      sessionStorage.setItem("browser-key-automation.pending-create.v1", JSON.stringify(params));
    }, { params: duplicateProbe.params });
    await pageClient.send("Page.reload", { ignoreCache: true });
    const reloaded = await waitForAdminReady(pageClient);
    assert.equal(reloaded.secretHidden, true);
    assert.equal(reloaded.secretValue, "");
    assert.equal(reloaded.rowCount, 2);
    assert.equal(reloaded.statusKind, "error");
    assert.equal(reloaded.statusVisible, "true");
    const reloadLeakCheck = await pageEvaluate(pageClient, ({ key }) => ({
      bodyHasSecret: document.body.textContent?.includes(key) ?? false,
      formName: document.querySelector("[data-create-name]")?.value ?? "",
      pendingStored: sessionStorage.getItem("browser-key-automation.pending-create.v1") !== null,
    }), { key: apiKey });
    assert.deepEqual(reloadLeakCheck, { bodyHasSecret: false, formName: "Duplicate Probe", pendingStored: true });

    await pageEvaluate(pageClient, () => {
      document.querySelector("[data-open-create]")?.click();
      document.querySelector("[data-create-form]")?.requestSubmit();
    });
    const recoveredOutcome = await waitForCondition(
      pageClient,
      () => ({
        recoveredKey: document.querySelector("[data-secret]")?.value ?? "",
        pendingStored: sessionStorage.getItem("browser-key-automation.pending-create.v1") !== null,
        rowCount: document.querySelectorAll("[data-key-rows] tr").length,
      }),
      (value) => API_KEY_PATTERN.test(value.recoveredKey) && !value.pendingStored && value.rowCount === 2,
      "unknown create recovery",
    );
    assert.equal(recoveredOutcome.rowCount, 2);
    await pageEvaluate(pageClient, () => document.querySelector("[data-done-secret]")?.click());

    const madeLegacy = await pageEvaluate(pageClient, async ({ id, key }) => {
      const opened = indexedDB.open("browser-key-automation");
      const database = await new Promise((resolve, reject) => {
        opened.onsuccess = () => resolve(opened.result);
        opened.onerror = () => reject(opened.error);
      });
      const transaction = database.transaction(["keys"], "readwrite");
      const store = transaction.objectStore("keys");
      const record = await new Promise((resolve, reject) => {
        const request = store.get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const matchedBeforeDelete = record?.storedApiKey === key;
      delete record.storedApiKey;
      store.put(record);
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
      return matchedBeforeDelete;
    }, { id: keyId, key: apiKey });
    assert.equal(madeLegacy, true);
    await pageEvaluate(pageClient, () => document.querySelector("[data-refresh]")?.click());
    await waitForCondition(
      pageClient,
      ({ id }) => document.querySelector(`[data-key-id="${id}"] [data-key-attach]`) !== null,
      (value) => value === true,
      "legacy Key attach action",
      { id: keyId },
    );

    await pageEvaluate(pageClient, ({ id, key }) => {
      const parts = key.split(".");
      const last = parts[2].endsWith("A") ? "B" : "A";
      const wrong = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -1)}${last}`;
      document.querySelector(`[data-key-id="${id}"] [data-key-attach]`)?.click();
      document.querySelector("[data-attach-secret]").value = wrong;
      document.querySelector("[data-attach-form]")?.requestSubmit();
    }, { id: keyId, key: apiKey });
    const wrongAttach = await waitForCondition(
      pageClient,
      () => ({
        status: document.querySelector("[data-status]")?.textContent ?? "",
        attachOpen: document.querySelector("[data-attach-dialog]")?.open === true,
        inputEmpty: document.querySelector("[data-attach-secret]")?.value === "",
      }),
      (value) => value.status.includes("不匹配") && value.attachOpen && value.inputEmpty,
      "wrong legacy Key rejection",
    );
    assert.equal(wrongAttach.inputEmpty, true);
    await pageEvaluate(pageClient, ({ key }) => {
      document.querySelector("[data-attach-secret]").value = key;
      document.querySelector("[data-attach-form]")?.requestSubmit();
    }, { key: apiKey });
    await waitForCondition(
      pageClient,
      ({ id }) => ({
        hasReveal: document.querySelector(`[data-key-id="${id}"] [data-key-reveal]`) !== null,
        hasAttach: document.querySelector(`[data-key-id="${id}"] [data-key-attach]`) !== null,
      }),
      (value) => value.hasReveal && !value.hasAttach,
      "legacy Key attach success",
      { id: keyId },
    );

    await pageEvaluate(pageClient, ({ id }) => {
      document.querySelector(`[data-key-id="${id}"] [data-key-edit]`)?.click();
      document.querySelector("[data-edit-enabled]").checked = false;
      document.querySelector("[data-edit-form]")?.requestSubmit();
    }, { id: keyId });
    await waitForCondition(
      pageClient,
      ({ id }) => document.querySelector(`[data-key-id="${id}"] [data-key-state]`)?.dataset.keyState ?? "",
      (value) => value === "disabled",
      "Key disable update",
      { id: keyId },
    );
    const disabledAuth = await pageEvaluate(pageClient, async ({ apiKey: key }) => {
      const service = await import(chrome.runtime.getURL("background/key-service.js"));
      return service.authenticateApiKey(key, "system.read");
    }, { apiKey });
    assert.deepEqual(disabledAuth, { ok: false, code: "KEY_DISABLED" });

    await pageEvaluate(pageClient, ({ id }) => {
      document.querySelector(`[data-key-id="${id}"] [data-key-edit]`)?.click();
      document.querySelector("[data-edit-enabled]").checked = true;
      document.querySelector("[data-edit-form]")?.requestSubmit();
    }, { id: keyId });
    await waitForCondition(
      pageClient,
      ({ id }) => document.querySelector(`[data-key-id="${id}"] [data-key-state]`)?.dataset.keyState ?? "",
      (value) => value === "active",
      "Key re-enable update",
      { id: keyId },
    );

    const revokeDialogOpened = await pageEvaluate(pageClient, ({ id }) => {
      document.querySelector(`[data-key-id="${id}"] [data-key-edit]`)?.click();
      document.querySelector("[data-open-revoke]")?.click();
      return {
        editOpen: document.querySelector("[data-edit-dialog]")?.open === true,
        revokeOpen: document.querySelector("[data-revoke-dialog]")?.open === true,
      };
    }, { id: keyId });
    assert.deepEqual(revokeDialogOpened, { editOpen: false, revokeOpen: true });
    await pageEvaluate(pageClient, () => document.querySelector("[data-confirm-revoke]")?.click());
    await waitForCondition(
      pageClient,
      ({ id }) => document.querySelector(`[data-key-id="${id}"] [data-key-state]`)?.dataset.keyState ?? "",
      (value) => value === "revoked",
      "Key revoke",
      { id: keyId },
    );
    const revokedAuth = await pageEvaluate(pageClient, async ({ apiKey: key }) => {
      const service = await import(chrome.runtime.getURL("background/key-service.js"));
      return service.authenticateApiKey(key, "system.read");
    }, { apiKey });
    assert.deepEqual(revokedAuth, { ok: false, code: "UNAUTHENTICATED" });

    await pageEvaluate(pageClient, ({ id }) => {
      document.querySelector(`[data-key-id="${id}"] [data-key-reveal]`)?.click();
    }, { id: keyId });
    await waitForCondition(
      pageClient,
      ({ id }) => document.querySelector(`[data-key-id="${id}"] [data-key-token]`)?.textContent ?? "",
      (value) => value === apiKey,
      "revoked Key administrative reveal",
      { id: keyId },
    );
    await pageEvaluate(pageClient, ({ id }) => {
      document.querySelector(`[data-key-id="${id}"] [data-key-reveal]`)?.click();
    }, { id: keyId });
    await waitForCondition(
      pageClient,
      ({ id }) => document.querySelector(`[data-key-id="${id}"] [data-key-token]`)?.textContent ?? "",
      (value) => !API_KEY_PATTERN.test(value),
      "revoked Key hide",
      { id: keyId },
    );

    const storedRevoked = await pageEvaluate(pageClient, async ({ id, key }) => {
      const opened = indexedDB.open("browser-key-automation");
      const database = await new Promise((resolve, reject) => {
        opened.onsuccess = () => resolve(opened.result);
        opened.onerror = () => reject(opened.error);
      });
      const transaction = database.transaction(["keys"], "readonly");
      const target = await new Promise((resolve, reject) => {
        const request = transaction.objectStore("keys").get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      database.close();
      return {
        status: target?.status ?? null,
        verifierCleared: target?.secretVerifier === null,
        storedTokenMatches: target?.storedApiKey === key,
        hasPlainApiKeyField: target ? Object.hasOwn(target, "apiKey") : true,
      };
    }, { id: keyId, key: apiKey });
    assert.deepEqual(storedRevoked, {
      status: "revoked",
      verifierCleared: true,
      storedTokenMatches: true,
      hasPlainApiKeyField: false,
    });

    const publicBoundary = await pageEvaluate(pageClient, async ({ key }) => {
      const service = await import(chrome.runtime.getURL("background/key-service.js"));
      const list = await service.listKeys({ afterKeyId: null, limit: 100 });
      const encoded = JSON.stringify(list);
      return {
        containsToken: encoded.includes(key),
        containsStoredField: encoded.includes("storedApiKey"),
        allHaveAvailability: list.items.every((item) => typeof item.secretAvailable === "boolean"),
      };
    }, { key: apiKey });
    assert.deepEqual(publicBoundary, { containsToken: false, containsStoredField: false, allHaveAvailability: true });

    await mkdir(storeListingRoot, { recursive: true });
    await pageClient.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const storeAdminLayout = await pageEvaluate(pageClient, () => {
      const locale = document.querySelector("[data-locale]");
      locale.value = "en";
      locale.dispatchEvent(new Event("change", { bubbles: true }));
      const theme = document.querySelector("[data-theme]");
      theme.value = "light";
      theme.dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector("[data-status]").dataset.visible = "false";
      return { lang: document.documentElement.lang, width: innerWidth, height: innerHeight };
    });
    assert.deepEqual(storeAdminLayout, { lang: "en", width: 1280, height: 800 });
    const storeKeysImage = await pageClient.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    await writeFile(storeKeysScreenshotPath, Buffer.from(storeKeysImage.data, "base64"));
    await pageEvaluate(pageClient, () => document.querySelector("[data-open-create]")?.click());
    const storePermissionsImage = await pageClient.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    await writeFile(storePermissionsScreenshotPath, Buffer.from(storePermissionsImage.data, "base64"));
    await pageEvaluate(pageClient, () => {
      document.querySelector("[data-close-create]")?.click();
      const locale = document.querySelector("[data-locale]");
      locale.value = "zh-CN";
      locale.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await pageClient.send("Emulation.clearDeviceMetricsOverride");

    await mkdir(path.dirname(screenshotPath), { recursive: true });
    await pageEvaluate(pageClient, () => {
      const theme = document.querySelector("[data-theme]");
      theme.value = "light";
      theme.dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector("[data-status]").dataset.visible = "false";
      document.querySelector("[data-open-create]")?.click();
    });
    const createDialogScreenshot = await pageClient.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    await writeFile(createDialogScreenshotPath, Buffer.from(createDialogScreenshot.data, "base64"));
    await pageEvaluate(pageClient, () => {
      document.querySelector("[data-close-create]")?.click();
      const theme = document.querySelector("[data-theme]");
      theme.value = "dark";
      theme.dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector("[data-status]").dataset.visible = "false";
    });
    const screenshot = await pageClient.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
    const rtlLayout = await pageEvaluate(pageClient, () => {
      const locale = document.querySelector("[data-locale]");
      locale.value = "ar";
      locale.dispatchEvent(new Event("change", { bubbles: true }));
      return { lang: document.documentElement.lang, dir: document.documentElement.dir,
        innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth };
    });
    assert.equal(rtlLayout.lang, "ar");
    assert.equal(rtlLayout.dir, "rtl");
    assert.equal(rtlLayout.scrollWidth, rtlLayout.innerWidth);
    const arabicScreenshot = await pageClient.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    await writeFile(arabicScreenshotPath, Buffer.from(arabicScreenshot.data, "base64"));
    await pageEvaluate(pageClient, () => {
      const locale = document.querySelector("[data-locale]");
      locale.value = "zh-TW";
      locale.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const traditionalChineseScreenshot = await pageClient.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    await writeFile(traditionalChineseScreenshotPath, Buffer.from(traditionalChineseScreenshot.data, "base64"));
    await pageEvaluate(pageClient, () => {
      const locale = document.querySelector("[data-locale]");
      locale.value = "zh-CN";
      locale.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await pageClient.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    const mobileLayout = await pageEvaluate(pageClient, () => ({
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      rowDisplay: getComputedStyle(document.querySelector("[data-key-rows] tr")).display,
    }));
    assert.deepEqual(mobileLayout, { innerWidth: 390, scrollWidth: 390, rowDisplay: "grid" });
    const mobileScreenshot = await pageClient.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    await writeFile(mobileScreenshotPath, Buffer.from(mobileScreenshot.data, "base64"));

    console.log(JSON.stringify({
      ok: true,
      chromium: path.basename(path.dirname(path.dirname(executable))),
      extensionLoaded: true,
      toolbarActionOpensAdminPage: true,
      firstInstallOpenedWelcome: true,
      userScriptsSetup: ["not-enabled-instructions", "open-browser-details", "enable-switch", "page-recheck-ready", "admin-check-ready"],
      welcomeScreenshot: path.relative(workspaceRoot, welcomeScreenshotPath),
      welcomeMobileScreenshot: path.relative(workspaceRoot, welcomeMobileScreenshotPath),
      welcomeSamples: path.relative(workspaceRoot, welcomeSamplesPath),
      persistedKeyCount: 2,
      repeatableRevealAndHide: true,
      adminPortRecoversAfterWorkerRestart: true,
      duplicateMutationReturnsExactStoredKey: true,
      unknownCreateRecoveredWithoutDuplicate: true,
      legacyAttachValidated: true,
      revokeUsesConfirmationDialog: true,
      revokedTokenRetainedForAdminReveal: true,
      publicListRedacted: true,
      authenticationStates: ["valid", "invalid", "disabled", "revoked"],
      storeListingScreenshots: [
        path.relative(workspaceRoot, storeWelcomeScreenshotPath),
        path.relative(workspaceRoot, storeKeysScreenshotPath),
        path.relative(workspaceRoot, storePermissionsScreenshotPath),
      ],
      screenshot: path.relative(workspaceRoot, screenshotPath),
      createDialogScreenshot: path.relative(workspaceRoot, createDialogScreenshotPath),
      arabicScreenshot: path.relative(workspaceRoot, arabicScreenshotPath),
      traditionalChineseScreenshot: path.relative(workspaceRoot, traditionalChineseScreenshotPath),
      mobileScreenshot: path.relative(workspaceRoot, mobileScreenshotPath),
    }));
  } catch (error) {
    const safeTail = stderrTail.replace(/bk1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/gu, "<redacted-api-key>");
    if (safeTail) console.error(safeTail.slice(-8_000));
    throw error;
  } finally {
    welcomeClient?.close();
    settingsClient?.close();
    pageClient?.close();
    browserClient?.close();
    workerClient?.close();
    await closeBrowser(child, debugPort);
    await removeRunRoot();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
