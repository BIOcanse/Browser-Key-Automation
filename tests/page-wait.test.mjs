import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { COMMAND_CATALOG } from "../out/extension/generated/command-config.js";

const source = readFileSync(new URL("../out/extension/background/page-wait-service.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?$/gm, "").replaceAll("export ", "");
const turn = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const state = { now: 0, readyState: "complete", dcl: 1, documentId: "doc-A", status: "complete",
    url: "https://fixture.test/A", pendingUrl: undefined, element: null, removed: false, probes: 0,
    beforeProbe: null, afterProbe: null, hang: false, framesError: false };
  const timers = new Map();
  let sequence = 0;
  class DomServiceError extends Error { constructor(code) { super(code); this.code = code; } }
  class CapabilityUnavailableError extends Error { constructor(capabilityId, reason) { super(reason); this.code = "CAPABILITY_UNAVAILABLE"; this.details = { capabilityId, reason }; } }
  const assertLive = () => { if (state.removed) throw new DomServiceError("TAB_REF_STALE"); };
  const context = vm.createContext({
    COMMAND_CATALOG, DomServiceError, CapabilityUnavailableError, TextEncoder,
    performance: { now: () => state.now, getEntriesByType: () => [{ domContentLoadedEventStart: state.dcl }] },
    document: { get readyState() { return state.readyState; }, querySelector(selector) {
      if (selector === "[") throw new Error("invalid selector"); return state.element;
    } },
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    setTimeout(fn, ms) { const id = ++sequence; timers.set(id, { at: state.now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    resolveTab: async (tabRef) => { assertLive(); return {
      tab: { id: 7, url: state.url, pendingUrl: state.pendingUrl, status: state.status },
      target: { tabRef, tabId: 7, generation: "g1", url: state.url },
    }; },
    assertResolvedTabTarget: assertLive,
    assertScriptingTargetAvailable: async () => { if (state.url.startsWith("chrome:")) throw new CapabilityUnavailableError("platform.extension.scripting", "RESTRICTED_PAGE"); },
    chrome: {
      webNavigation: { getAllFrames: async () => {
        if (state.framesError) throw new Error("API failed");
        return [{ frameId: 0, documentId: state.documentId, documentLifecycle: "active" }, { frameId: 1, documentId: "child-complete" }];
      } },
      scripting: { executeScript: async (injection) => {
        state.probes += 1;
        await state.beforeProbe?.();
        if (state.hang) return new Promise(() => {});
        const documentId = state.documentId;
        assert.deepEqual(Array.from(injection.target.documentIds), [documentId]);
        const result = await injection.func(...injection.args);
        await state.afterProbe?.();
        return [{ frameId: 0, documentId, result }];
      } },
    },
  });
  vm.runInContext(`${source}\nglobalThis.wait = waitForPage;`, context);
  return { state, timers, wait: (params = {}) => context.wait({ tabRef: "fixture-tab", until: "complete", timeoutMs: 10000, ...params }),
    async advance(ms) {
      const end = state.now + ms;
      await turn();
      while (true) {
        const entry = [...timers.entries()].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        state.now = entry[1].at; timers.delete(entry[0]); entry[1].fn(); await turn();
      }
      state.now = end; await turn();
    },
  };
}

test("complete is immediately already_satisfied, including repeated calls; no page action", async () => {
  const h = harness();
  for (let index = 0; index < 2; index += 1) {
    const result = await h.wait();
    assert.equal(result.status, "already_satisfied");
    assert.equal(result.elapsedMs, 0);
    assert.match(result.message, /no waiting or page action/);
    assert.equal(h.timers.size, 0);
  }
});

test("pending URL and same-URL reload do not accept the old complete document", async () => {
  for (const sameUrl of [false, true]) {
    const h = harness(); h.state.pendingUrl = sameUrl ? h.state.url : "https://fixture.test/B"; h.state.status = "loading";
    const waiting = h.wait({ until: "committed", url: h.state.pendingUrl });
    let done = false; void waiting.then(() => { done = true; });
    await h.advance(100); assert.equal(done, false);
    h.state.url = h.state.pendingUrl; h.state.pendingUrl = undefined; h.state.documentId = "doc-B"; h.state.readyState = "loading";
    await h.advance(100);
    const result = await waiting;
    assert.equal(result.status, "satisfied"); assert.equal(result.observation.documentId, "doc-B");
    assert.equal(h.state.probes, 0, "committed needs no DOM injection");
    assert.equal(h.timers.size, 0);
  }
});

test("interactive is not DOMContentLoaded; past DCL and BFCache complete satisfy immediately", async () => {
  const h = harness(); h.state.readyState = "interactive"; h.state.status = "loading"; h.state.dcl = 0;
  const waiting = h.wait({ until: "domcontentloaded" });
  let done = false; void waiting.then(() => { done = true; });
  await h.advance(100); assert.equal(done, false);
  h.state.dcl = 20; await h.advance(100);
  assert.equal((await waiting).status, "satisfied");
  assert.equal((await h.wait({ until: "domcontentloaded" })).status, "already_satisfied");
  const complete = h.wait(); await h.advance(100); h.state.status = "complete"; h.state.readyState = "complete";
  await h.advance(100); assert.equal((await complete).status, "satisfied");
  h.state.dcl = 0; assert.equal((await h.wait({ until: "domcontentloaded" })).status, "already_satisfied");
});

test("explicit DOM/text conditions continue after complete and invalid CSS fails honestly", async () => {
  const h = harness();
  const waiting = h.wait({ until: "text", selector: "#late", text: "ready" });
  await h.advance(200);
  h.state.element = { textContent: "ready", matches: () => false, getAttribute: () => null, getClientRects: () => ({ length: 1 }) };
  await h.advance(100); assert.equal((await waiting).status, "satisfied");
  for (const until of ["present", "visible", "enabled"]) assert.equal((await h.wait({ until, selector: "#late" })).status, "already_satisfied");
  h.state.element = null;
  assert.equal((await h.wait({ until: "absent", selector: "#late" })).status, "already_satisfied");
  await assert.rejects(h.wait({ until: "present", selector: "[" }), (error) => error.code === "DOM_OPERATION_FAILED");
  assert.equal(h.timers.size, 0);
});

test("late old-document probe cannot be combined with a newly committed URL", async () => {
  const h = harness();
  h.state.afterProbe = () => {
    h.state.documentId = "doc-B"; h.state.url = "https://fixture.test/B";
    h.state.status = "loading"; h.state.readyState = "loading"; h.state.dcl = 0; h.state.afterProbe = null;
  };
  const waiting = h.wait();
  let done = false; void waiting.then(() => { done = true; });
  await h.advance(100); assert.equal(done, false);
  h.state.status = "complete"; h.state.readyState = "complete";
  await h.advance(100);
  const result = await waiting; assert.equal(result.status, "satisfied"); assert.equal(result.observation.documentId, "doc-B");
});

test("one fixed deadline covers both missing conditions and an unresponsive Chromium probe", async () => {
  for (const timeoutMs of [10000, 200]) {
    const h = harness();
    const waiting = h.wait({ until: "present", selector: "#missing", timeoutMs });
    await h.advance(timeoutMs - 1);
    let done = false; void waiting.then(() => { done = true; }); await turn(); assert.equal(done, false);
    await h.advance(1); const result = await waiting;
    assert.equal(result.status, "timed_out"); assert.equal(result.elapsedMs, timeoutMs);
    assert.match(result.message, /does not imply the previous action failed/);
    assert.equal(h.timers.size, 0);
  }
  const h = harness(); h.state.hang = true;
  const waiting = h.wait({ timeoutMs: 200 }); await h.advance(200);
  assert.equal((await waiting).status, "timed_out"); assert.equal(h.timers.size, 0);
});

test("closed/replaced tab and restricted page fail without rebinding or timing out", async () => {
  const h = harness(); const waiting = h.wait({ until: "present", selector: "#missing" });
  const rejected = assert.rejects(waiting, (error) => error.code === "TAB_REF_STALE");
  await h.advance(100); h.state.removed = true; await h.advance(100); await rejected;
  assert.equal(h.timers.size, 0);
  const restricted = harness(); restricted.state.url = "chrome://settings";
  await assert.rejects(restricted.wait(), (error) => error.code === "CAPABILITY_UNAVAILABLE");
  assert.equal(restricted.timers.size, 0);
});
