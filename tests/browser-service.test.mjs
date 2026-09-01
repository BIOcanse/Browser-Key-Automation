import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("live DOM and arbitrary JavaScript adapters return bounded explicit results", async () => {
  const originalChrome = globalThis.chrome;
  const originalDocument = globalThis.document;
  const originalLocation = globalThis.location;
  const sessionState = Object.create(null);
  let removedListener;
  let replacedListener;
  let userScriptsAvailable = true;
  let hostAccessAvailable = true;
  let executeUserScript = async () => [{ documentId: "doc-1", frameId: 0, result: 42 }];
  const tab = makeTab(7);

  globalThis.document = {
    documentElement: { outerHTML: "<html><body>unit</body></html>" },
    body: { outerHTML: "<body>unit</body>", innerText: "unit" },
  };
  globalThis.location = { href: "https://example.test/unit" };
  globalThis.chrome = {
    storage: {
      session: {
        async setAccessLevel() {},
        async get(key) {
          return { [key]: sessionState[key] };
        },
        async set(items) {
          Object.assign(sessionState, items);
        },
      },
    },
    tabs: {
      async query() {
        return [tab];
      },
      async get(tabId) {
        assert.equal(tabId, tab.id);
        return tab;
      },
      onRemoved: { addListener(listener) { removedListener = listener; } },
      onReplaced: { addListener(listener) { replacedListener = listener; } },
    },
    scripting: {
      async executeScript(injection) {
        assert.equal(injection.target.tabId, tab.id);
        assert.equal(injection.world, "ISOLATED");
        const result = injection.func(...injection.args);
        return [{ documentId: "doc-1", frameId: 0, result }];
      },
    },
    permissions: {
      async contains(permissions) {
        assert.equal(Array.isArray(permissions.origins), true);
        return hostAccessAvailable;
      },
    },
    userScripts: {
      async getScripts() {
        if (!userScriptsAvailable) throw new Error("Allow User Scripts disabled");
        return [];
      },
      execute(injection) {
        assert.equal(injection.target.tabId, tab.id);
        assert.ok(injection.world === "USER_SCRIPT" || injection.world === "MAIN");
        assert.equal(typeof injection.js[0].code, "string");
        return executeUserScript(injection);
      },
    },
  };

  try {
    const tabModuleUrl = pathToFileURL(
      path.join(workspaceRoot, "out", "extension", "background", "tab-service.js"),
    );
    const browserModuleUrl = pathToFileURL(
      path.join(workspaceRoot, "out", "extension", "background", "browser-service.js"),
    );
    const tabs = await import(tabModuleUrl.href);
    const browser = await import(`${browserModuleUrl.href}?test=${Date.now()}`);
    tabs.initializeTabService();
    assert.equal(typeof removedListener, "function");
    assert.equal(typeof replacedListener, "function");
    const listed = await tabs.listTabs({ afterTabId: null, limit: 10 });
    const tabRef = listed.items[0].tabRef;

    const dom = await browser.getPageDom(tabRef, "document");
    assert.deepEqual(dom, {
      tabRef,
      root: "document",
      url: "https://example.test/unit",
      urlTruncated: false,
      html: "<html><body>unit</body></html>",
      htmlTruncated: false,
    });

    globalThis.document.documentElement.outerHTML = `<!doctype html><p>${"\"".repeat(30_000)}</p>`;
    const boundedDom = await browser.getPageDom(tabRef, "document");
    assert.equal(boundedDom.htmlTruncated, true);
    assert.ok(new TextEncoder().encode(JSON.stringify(boundedDom.html).slice(1, -1)).byteLength <= 45_000);

    await browser.ensureUserScriptsAvailable();
    const target = await tabs.resolveTabTarget(tabRef);
    await assert.rejects(
      browser.assertScriptingTargetAvailable({ ...target, url: "chrome://settings/" }),
      (error) => error?.details?.reason === "RESTRICTED_PAGE" &&
        error?.details?.capabilityId === "platform.extension.scripting",
    );
    hostAccessAvailable = false;
    await assert.rejects(
      browser.assertScriptingTargetAvailable(target),
      (error) => error?.details?.reason === "HOST_ACCESS_UNAVAILABLE" &&
        error?.details?.capabilityId === "platform.extension.scripting",
    );
    hostAccessAvailable = true;
    const value = await browser.executeJavaScript(target, "USER_SCRIPT", "42", 1000);
    assert.equal(value.status, "fulfilled");
    assert.equal(value.valueJson, "42");

    executeUserScript = async () => [{ documentId: "doc-1", frameId: 0, result: undefined }];
    const undefinedValue = await browser.executeJavaScript(target, "MAIN", "undefined", 1000);
    assert.equal(undefinedValue.status, "fulfilled");
    assert.equal(undefinedValue.valueJson, '{"type":"undefined"}');

    executeUserScript = async () => [{ documentId: "doc-1", frameId: 0, error: "unit failure" }];
    const rejected = await browser.executeJavaScript(target, "USER_SCRIPT", "throw 1", 1000);
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.errorMessage, "unit failure");

    executeUserScript = async () => [{ documentId: "doc-1", frameId: 0, result: "x".repeat(60_000) }];
    const large = await browser.executeJavaScript(target, "USER_SCRIPT", "large", 1000);
    assert.equal(large.status, "fulfilled");
    assert.equal(large.valueTruncated, true);
    assert.ok(new TextEncoder().encode(JSON.stringify(large.valueJson).slice(1, -1)).byteLength <= 45_000);

    executeUserScript = () => new Promise(() => {});
    const timedOut = await browser.executeJavaScript(target, "USER_SCRIPT", "pending", 5);
    assert.equal(timedOut.status, "timed_out");
    assert.equal(timedOut.valueJson, null);

    executeUserScript = async () => {
      userScriptsAvailable = false;
      throw new Error("access revoked");
    };
    await assert.rejects(
      browser.executeJavaScript(target, "USER_SCRIPT", "42", 1000),
      (error) => error?.code === "CAPABILITY_UNAVAILABLE" &&
        error?.details?.capabilityId === "platform.extension.user_scripts",
    );

    userScriptsAvailable = true;
    executeUserScript = () => {
      throw new Error("synchronous API failure");
    };
    await assert.rejects(
      browser.executeJavaScript(target, "MAIN", "42", 1000),
      (error) => error?.code === "CAPABILITY_UNAVAILABLE" &&
        error?.details?.capabilityId === "platform.extension.user_scripts",
    );

    globalThis.chrome.userScripts = undefined;
    await assert.rejects(
      browser.ensureUserScriptsAvailable(),
      (error) => error?.code === "CAPABILITY_UNAVAILABLE" &&
        error?.details?.capabilityId === "platform.extension.user_scripts" &&
        error?.details?.reason === "USER_SCRIPTS_NOT_ENABLED",
    );
  } finally {
    globalThis.chrome = originalChrome;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});

function makeTab(id) {
  return {
    id,
    index: 0,
    windowId: 1,
    active: true,
    highlighted: true,
    pinned: false,
    incognito: false,
    status: "complete",
    title: "Unit",
    url: "https://example.test/unit",
  };
}
