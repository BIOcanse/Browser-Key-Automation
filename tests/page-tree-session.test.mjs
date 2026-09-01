import assert from "node:assert/strict";
import test from "node:test";

const prefix = "browser-key-automation.page-tree-route.v1.";
const root = (letter) => `tr2.${letter.repeat(43)}`;

test("tree session routing distinguishes storage failure, stale refs and ordered lifecycle cleanup", async () => {
  const originalChrome = globalThis.chrome;
  const removed = [];
  const committed = [];
  const stored = Object.create(null);
  let failRead = false;
  let finishCleanupRead;
  let pauseCleanupRead = false;
  globalThis.chrome = {
    storage: { session: {
      async get(key) {
        if (failRead) throw new Error("simulated storage outage");
        if (key === null && pauseCleanupRead) {
          await new Promise((resolve) => { finishCleanupRead = resolve; });
        }
        return key === null ? { ...stored } : { [key]: stored[key] };
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key];
      },
    } },
    tabs: { onRemoved: { addListener(listener) { removed.push(listener); } }, onReplaced: { addListener() {} } },
    webNavigation: {
      async getAllFrames() { return [{ frameId: 0, documentId: "new-document" }]; },
      onCommitted: { addListener(listener) { committed.push(listener); } },
    },
  };
  try {
    const service = await import(new URL("../out/extension/background/page-tree-service.js", import.meta.url));
    failRead = true;
    await assert.rejects(service.getPageTreeView("test-key", { rootRef: root("A") }),
      (error) => error.code === "STORAGE_UNAVAILABLE");
    failRead = false;
    await assert.rejects(service.getPageTreeView("test-key", { rootRef: root("A") }),
      (error) => error.code === "TARGET_REF_STALE");
    stored[prefix + root("A")] = { rootRef: root("A"), tabId: 7, frameId: 0, documentId: "old-document" };
    stored[prefix + root("B")] = { rootRef: root("B"), tabId: 7, frameId: 0, documentId: "new-document" };
    stored[prefix + root("C")] = { rootRef: root("C"), tabId: 8, frameId: 0, documentId: "other-tab" };
    stored["unrelated-session-value"] = "retained";
    pauseCleanupRead = true;
    for (const listener of committed) listener({ tabId: 7, frameId: 0, documentId: "new-document" });
    // This read must wait for the already-scheduled cleanup, not see its old route.
    const duringCleanup = service.getPageTreeView("test-key", { rootRef: root("A") });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof finishCleanupRead, "function");
    finishCleanupRead();
    await assert.rejects(duringCleanup, (error) => error.code === "TARGET_REF_STALE");
    assert.equal(prefix + root("A") in stored, false);
    assert.equal(prefix + root("B") in stored, true, "new committed document must be retained");
    assert.equal(prefix + root("C") in stored, true);
    assert.equal(stored["unrelated-session-value"], "retained");
    pauseCleanupRead = false;
    for (const listener of removed) listener(7);
    await assert.rejects(service.getPageTreeView("test-key", { rootRef: root("B") }),
      (error) => error.code === "TARGET_REF_STALE");
    assert.equal(prefix + root("B") in stored, false);
    assert.equal(prefix + root("C") in stored, true, "other tabs must be untouched");
    assert.equal(stored["unrelated-session-value"], "retained");
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("open/view route writes report safe storage errors and wait for pending cleanup", async () => {
  const originalChrome = globalThis.chrome;
  const committed = [];
  const stored = Object.create(null);
  let failRouteWrite = false;
  let pauseCleanupRead = false;
  let finishCleanupRead;
  let routeWriteCount = 0;
  let documentId = "write-test-original-document";
  let rootRef = root("D");
  const childRef = root("E");
  const failureMarker = "private-storage-error-marker";
  globalThis.chrome = {
    storage: { session: {
      async setAccessLevel() {},
      async get(key) {
        if (key === null && pauseCleanupRead) {
          await new Promise((resolve) => { finishCleanupRead = resolve; });
        }
        return key === null ? { ...stored } : { [key]: stored[key] };
      },
      async set(records) {
        if (Object.keys(records).some((key) => key.startsWith(prefix))) {
          routeWriteCount += 1;
          if (failRouteWrite) throw new Error(failureMarker);
        }
        Object.assign(stored, records);
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key];
      },
    } },
    tabs: {
      async get(tabId) { return { id: tabId, url: "https://example.test/tree" }; },
      onRemoved: { addListener() {} },
      onReplaced: { addListener() {} },
    },
    permissions: { async contains() { return true; } },
    webNavigation: {
      async getAllFrames() { return [{ frameId: 0, documentId }]; },
      onCommitted: { addListener(listener) { committed.push(listener); } },
    },
    scripting: { async executeScript(injection) {
      const operation = injection.args[0];
      const result = operation === "open"
        ? { ok: true, operation, rootRef, reused: true, title: "test", url: "https://example.test/tree", limitations: [] }
        : { ok: true, operation, rootRef, truncated: false, nextIndexPath: null,
          items: [{ kind: "element", name: "HTML", namespace: null, role: null, label: null,
            valuePreview: null, valueTruncated: false, states: [], attributeCount: 0, childCount: 0,
            sourceOrder: 0, nodeRef: null, treeRef: childRef, indexPath: [0], level: 0, expanded: false }] };
      return [{ frameId: 0, documentId, result: { projection: result, retiredTreeRefs: [] } }];
    } },
  };
  try {
    const service = await import(new URL("../out/extension/background/page-tree-service.js?write-test", import.meta.url));
    const tabs = await import(new URL("../out/extension/background/tab-service.js", import.meta.url));
    const tab = await tabs.resolveCurrentTabTarget(7);
    const safeStorageError = (error) => {
      assert.equal(error.code, "STORAGE_UNAVAILABLE");
      assert.equal(error.message.includes(failureMarker), false);
      return true;
    };
    failRouteWrite = true;
    await assert.rejects(service.openPageTree(tab.tabRef, "test-key"), safeStorageError);
    assert.equal(prefix + rootRef in stored, false);
    failRouteWrite = false;
    const opened = await service.openPageTree(tab.tabRef, "test-key");
    assert.equal(opened.rootRef, rootRef);
    assert.deepEqual(stored[prefix + rootRef], { rootRef, tabId: 7, frameId: 0, documentId });

    failRouteWrite = true;
    await assert.rejects(service.getPageTreeView("test-key", { rootRef }), safeStorageError);
    assert.equal(prefix + childRef in stored, false);
    failRouteWrite = false;
    const view = await service.getPageTreeView("test-key", { rootRef });
    assert.equal(view.items[0].treeRef, childRef);
    assert.deepEqual(stored[prefix + childRef], { rootRef, tabId: 7, frameId: 0, documentId });

    const oldRoot = rootRef;
    rootRef = root("F");
    documentId = "write-test-next-document";
    pauseCleanupRead = true;
    for (const listener of committed) listener({ tabId: 7, frameId: 0, documentId });
    const writesBeforeCleanup = routeWriteCount;
    const pendingOpen = service.openPageTree(tab.tabRef, "test-key");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof finishCleanupRead, "function");
    assert.equal(routeWriteCount, writesBeforeCleanup, "new route write must wait for the pending cleanup");
    assert.equal(prefix + rootRef in stored, false);
    pauseCleanupRead = false;
    finishCleanupRead();
    assert.equal((await pendingOpen).rootRef, rootRef);
    assert.equal(routeWriteCount, writesBeforeCleanup + 1);
    assert.equal(prefix + oldRoot in stored, false);
    assert.equal(prefix + childRef in stored, false);
    assert.deepEqual(stored[prefix + rootRef], { rootRef, tabId: 7, frameId: 0, documentId });
  } finally {
    globalThis.chrome = originalChrome;
  }
});
