import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import { COMMAND_CATALOG } from "../out/extension/generated/command-config.js";
import { readArtifact, releaseArtifact } from "../out/extension/background/artifact-service.js";

function event() {
  const listeners = new Set();
  return { addListener: (listener) => listeners.add(listener), fire: (...args) => { for (const listener of listeners) listener(...args); } };
}
const makeTab = (id) => ({ id, index: id - 1, windowId: 1, active: id === 1, highlighted: false, pinned: false,
  incognito: false, status: "complete", title: `Tab ${id}`, url: `https://example.test/${id}` });

test("debugger is explicit, independently dispatch-gated, bounded and honest about post-send errors", async () => {
  const originalChrome = globalThis.chrome;
  const storage = {}, onRemoved = event(), onReplaced = event(), onEvent = event(), onDetach = event();
  const tabs = [makeTab(1), makeTab(2), makeTab(3)];
  const calls = [];
  let attachHook = async () => {}, sendHook = async () => ({ value: 42 });
  const debuggerApi = { onEvent, onDetach,
    async attach(target, version) { calls.push({ action: "attach", target, version }); await attachHook(target); },
    async detach(target) { calls.push({ action: "detach", target }); onDetach.fire(target, "canceled_by_user"); },
    async sendCommand(target, method, params) { calls.push({ action: "send", target, method, params }); return sendHook(); } };
  globalThis.chrome = { storage: { session: { async setAccessLevel() {}, async get(key) { return { [key]: storage[key] }; },
    async set(items) { Object.assign(storage, items); } } }, tabs: { onRemoved, onReplaced,
    async query() { return tabs; }, async get(id) { return tabs.find((tab) => tab.id === id); } } };
  const tabService = await import("../out/extension/background/tab-service.js");
  const service = await import("../out/extension/background/debugger-service.js");
  const dispatch = (effect) => effect();
  try {
    tabService.initializeTabService();
    const listed = await tabService.listTabs({ afterTabId: null, limit: 100 });
    const [tabRef, secondRef, thirdRef] = listed.items.map((item) => item.tabRef);
    service.initializeDebuggerService();
    await assert.rejects(service.attachDebugger(tabRef, dispatch), (error) => error.code === "CAPABILITY_UNAVAILABLE");
    globalThis.chrome.debugger = debuggerApi;
    service.initializeDebuggerService(); service.initializeDebuggerService();
    assert.equal(calls.length, 0, "bootstrapping must not attach or activate a tab");
    const request = { tabRef, method: "Runtime.evaluate", params: { expression: "42" }, response: "inline" };
    await assert.rejects(service.sendDebuggerCommand("owner", request, dispatch), (error) => error.details.reason === "NOT_ATTACHED" && !error.details.commandMayHaveRun);

    let unlock, entered;
    const started = new Promise((resolve) => { entered = resolve; });
    attachHook = () => { entered(); return new Promise((resolve) => { unlock = resolve; }); };
    const first = service.attachDebugger(tabRef, dispatch);
    await started;
    const second = service.attachDebugger(tabRef, dispatch);
    unlock();
    const attached = await Promise.all([first, second]);
    assert.deepEqual(attached.map((item) => item.alreadyAttached), [false, true]);
    assert.equal(calls.filter((item) => item.action === "attach").length, 1);
    assert.equal(calls[0].version, "1.3");
    attachHook = async () => {};
    const denied = Object.assign(new Error("occupation changed before dispatch"), { code: "OCCUPIED" });
    const count = calls.length;
    await assert.rejects(service.sendDebuggerCommand("owner", request, async () => { throw denied; }), (error) => error === denied);
    assert.equal(calls.length, count);
    const inline = await service.sendDebuggerCommand("owner", { ...request, sessionId: "child-session" }, dispatch);
    assert.deepEqual(inline, { tabRef, result: { value: 42 }, artifact: null });
    assert.deepEqual(calls.at(-1).target, { tabId: 1, sessionId: "child-session" });

    onEvent.fire({ tabId: 1 }, "Runtime.consoleAPICalled", { type: "log" });
    onEvent.fire({ tabId: 1, sessionId: "child-session" }, "Runtime.executionContextCreated", { context: {} });
    const page = await service.getDebuggerEvents(tabRef, 0, 1);
    assert.equal(page.items.length, 1); assert.equal(page.hasMore, true);
    assert.deepEqual(await service.getDebuggerEvents(tabRef, 0, 1), page, "event reads do not drain another Key's queue");
    const next = await service.getDebuggerEvents(tabRef, page.nextSequence, 1);
    assert.equal(next.items[0].sessionId, "child-session");
    assert.ok(next.nextSequence > page.nextSequence); assert.equal(next.hasMore, false);
    onEvent.fire({ tabId: 1 }, "oversized", { data: "x".repeat(COMMAND_CATALOG.limits["command.debugger.maximum_event_bytes"]) });
    const dropped = await service.getDebuggerEvents(tabRef, 0, 100);
    assert.equal(dropped.items.length, 0); assert.ok(dropped.droppedThroughSequence > next.nextSequence);
    assert.equal(dropped.nextSequence, dropped.droppedThroughSequence);
    for (let index = 0; index < COMMAND_CATALOG.limits["command.debugger.maximum_events"] + 1; index += 1) onEvent.fire({ tabId: 1 }, "bounded", { index });
    const bounded = await service.getDebuggerEvents(tabRef, 0, 1);
    assert.equal(bounded.items[0].params.index, 1); assert.ok(bounded.droppedThroughSequence > dropped.nextSequence);

    const bigResult = { body: "x".repeat(COMMAND_CATALOG.limits["command.inline.maximum_result_json_bytes"]) };
    sendHook = async () => bigResult;
    const beforeLarge = calls.length;
    await assert.rejects(service.sendDebuggerCommand("owner", request, dispatch), (error) => error.details.reason === "RESULT_TOO_LARGE" && error.details.commandMayHaveRun);
    assert.equal(calls.length, beforeLarge + 1, "an oversized reply never replays CDP");
    const saved = await service.sendDebuggerCommand("owner", { ...request, response: "artifact" }, dispatch);
    assert.equal(saved.result, null); assert.equal(saved.artifact.mediaType, "application/json");
    const chunk = await readArtifact("owner", saved.artifact.artifactRef, 0, 100);
    assert.match(Buffer.from(chunk.dataBase64Url, "base64url").toString(), /^\{"body":"x/);
    await releaseArtifact("owner", saved.artifact.artifactRef);
    sendHook = async () => { throw new Error(`CDP error bk1.${"A".repeat(22)}.${"B".repeat(43)}`); };
    await assert.rejects(service.sendDebuggerCommand("owner", request, dispatch), (error) => error.details.reason === "COMMAND_FAILED" &&
      error.details.commandMayHaveRun && !error.details.message.includes("bk1."));

    onDetach.fire({ tabId: 1 }, "replaced_with_devtools");
    const disconnected = await service.getDebuggerEvents(tabRef, 0, 1);
    assert.equal(disconnected.attached, false); assert.equal(disconnected.detachedReason, "replaced_with_devtools");
    await service.attachDebugger(tabRef, dispatch);
    onEvent.fire({ tabId: 1 }, "after-reattach", {});
    const reattached = await service.getDebuggerEvents(tabRef, bounded.nextSequence, 100);
    assert.ok(reattached.items[0].sequence > bounded.nextSequence, "reattachment does not reuse earlier cursors");
    assert.deepEqual(await service.detachDebugger(tabRef, dispatch), { tabRef, detached: true, attached: false });
    assert.deepEqual(await service.detachDebugger(tabRef, dispatch), { tabRef, detached: false, attached: false });

    attachHook = () => new Promise((resolve) => { unlock = resolve; });
    const closing = service.attachDebugger(secondRef, dispatch);
    for (let attempts = 0; attempts < 10 && calls.at(-1).target.tabId !== 2; attempts += 1) await Promise.resolve();
    onRemoved.fire(2); unlock();
    await assert.rejects(closing, (error) => error.details.commandMayHaveRun);
    attachHook = async () => {};
    await service.attachDebugger(thirdRef, dispatch);
    onReplaced.fire(4, 3);
    await assert.rejects(service.getDebuggerEvents(thirdRef, 0, 10), (error) => error.code === "TAB_REF_STALE");
  } finally { globalThis.chrome = originalChrome; }
});
