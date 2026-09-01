import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("retired TabRefs fail after an in-flight Chromium read", async () => {
  const originalChrome = globalThis.chrome;
  const sessionState = Object.create(null);
  let tabs = [makeTab(1), makeTab(2)];
  let resolveGet;
  let removedListener;
  let replacedListener;

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
        return tabs;
      },
      get() {
        return new Promise((resolve) => {
          resolveGet = resolve;
        });
      },
      onRemoved: {
        addListener(listener) {
          removedListener = listener;
        },
      },
      onReplaced: {
        addListener(listener) {
          replacedListener = listener;
        },
      },
    },
  };

  try {
    const moduleUrl = pathToFileURL(
      path.join(workspaceRoot, "out", "extension", "background", "tab-service.js"),
    );
    const service = await import(`${moduleUrl.href}?test=${Date.now()}`);
    service.initializeTabService();
    assert.equal(typeof removedListener, "function");
    assert.equal(typeof replacedListener, "function");

    const firstPage = await service.listTabs({
      afterTabId: null,
      limit: 1,
    });
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.nextAfterTabId, 1);

    const pendingGet = service.getTab(firstPage.items[0].tabRef);
    await Promise.resolve();
    removedListener(1);
    resolveGet(makeTab(1));
    await assert.rejects(pendingGet, (error) => error?.code === "TAB_REF_STALE");
  } finally {
    globalThis.chrome = originalChrome;
  }
});

function makeTab(id) {
  return {
    id,
    index: id - 1,
    windowId: 1,
    active: id === 1,
    highlighted: id === 1,
    pinned: false,
    incognito: false,
    status: "complete",
    title: `Tab ${id}`,
    url: `https://example.test/${id}`,
  };
}
