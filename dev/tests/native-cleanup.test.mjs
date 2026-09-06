import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { restoreKeyboardWindow } from "../../out/extension/background/dom-service.js";
import { assertCoveredInput, assertNativeDragDrop, assertOccludedInput } from "./lib/native-boundary-probe.mjs";
import { runPageSaveInvestigation, summarizePageSaveDiagnostics } from "./lib/page-save-investigation.mjs";

test("native title cleanup finishes, rejects, or expires within the caller budget", async (t) => {
  const originalChrome = globalThis.chrome;
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const marker = { tabId: 7, documentId: "original-document", originalTitle: "Original" };
  let injected;
  globalThis.chrome = { scripting: { executeScript: async (request) => { injected = request; return []; } } };
  try {
    await restoreKeyboardWindow(marker, "temporary", 25);
    assert.deepEqual(injected.target, { tabId: 7, documentIds: ["original-document"] });
    assert.deepEqual(injected.args, ["temporary", "Original"]);
    globalThis.chrome.scripting.executeScript = async () => { throw new Error("document closed"); };
    await restoreKeyboardWindow(marker, "temporary", 25);
    let rejectLate;
    globalThis.chrome.scripting.executeScript = () => new Promise((_, reject) => { rejectLate = reject; });
    const pending = restoreKeyboardWindow(marker, "temporary", 25);
    t.mock.timers.tick(25);
    await pending;
    assert.equal(warnings.length, 1);
    rejectLate(new Error("late document removal"));
    await Promise.resolve(); // Late completion has an installed rejection handler.
  } finally { globalThis.chrome = originalChrome; }
});

test("a late title cleanup does not overwrite a newer page title", async () => {
  const originalChrome = globalThis.chrome;
  let injected;
  globalThis.chrome = { scripting: { executeScript: async (request) => { injected = request; return []; } } };
  try {
    await restoreKeyboardWindow({ tabId: 7, documentId: "document", originalTitle: "Original" }, "temporary", 25);
    const context = vm.createContext({ document: { title: "newer-title" } });
    vm.runInContext(`(${injected.func.toString()})("temporary", "Original")`, context);
    assert.equal(context.document.title, "newer-title");
    context.document.title = "temporary";
    vm.runInContext(`(${injected.func.toString()})("temporary", "Original")`, context);
    assert.equal(context.document.title, "Original");
  } finally { globalThis.chrome = originalChrome; }
});

test("MHTML investigation rejects a nonzero recorded failure count", () => {
  const source = readFileSync(new URL("./extension-relay-smoke.mjs", import.meta.url), "utf8");
  const gate = source.match(/assert\.equal\(result\.failures, 0,[^\n]+/u)?.[0];
  assert.ok(gate, "focused investigation must consume its failure count");
  vm.runInNewContext(gate, { assert, result: { failures: 0 } });
  assert.throws(() => vm.runInNewContext(gate, { assert, result: { failures: 1 } }), /MHTML investigation recorded failed saves/u);
  const diagnosticGate = source.match(/assert\.equal\(result\.incompleteDiagnostics, 0,[^\n]+/u)?.[0];
  assert.ok(diagnosticGate);
  vm.runInNewContext(diagnosticGate, { assert, result: { incompleteDiagnostics: 0 } });
  assert.throws(() => vm.runInNewContext(diagnosticGate, { assert, result: { incompleteDiagnostics: 1 } }), /lost operation diagnostics/u);
});

function saveEvents(id = "original-operation") {
  return [["target.resolve", "started"], ["target.resolve", "succeeded"],
    ["capture.mhtml", "started"], ["capture.mhtml", "succeeded"], ["capture.blob", "succeeded"],
    ["settings.read", "started"], ["settings.read", "succeeded"],
    ["blob.read", "started"], ["blob.read", "succeeded"], ["digest", "started"], ["digest", "succeeded"],
    ["database.open", "started"], ["database.open", "succeeded"],
    ["transaction.begin", "started"], ["transaction.begin", "succeeded"],
    ["transaction.requests", "started"], ["metadata.add", "started"], ["metadata.add", "succeeded"],
    ["chunk.add", "started"], ["chunk.add", "succeeded"], ["transaction.requests", "succeeded"],
    ["transaction.commit", "started"], ["transaction.commit", "succeeded"], ["archive.complete", "succeeded"]]
    .map(([phase, status], elapsedMs) => ({ id, sequence: elapsedMs + 1, phase, status, elapsedMs, firstFailure: false }));
}

test("page-save evidence requires one original operation with ordered, complete stages", () => {
  const events = saveEvents();
  assert.deepEqual(summarizePageSaveDiagnostics(events), { operationId: "original-operation", complete: true,
    problems: [], outcome: "succeeded", firstFailure: null });
  for (const corrupt of [
    (value) => { value.length = 0; },
    (value) => { value.shift(); },
    (value) => { value.pop(); },
    (value) => { value[1].id = "unrelated"; },
    (value) => { value[3].elapsedMs = 0; },
    (value) => { value.splice(2, 1); },
    (value) => { value.splice(3, 1); },
    (value) => { value.splice(2, 2); }, // A whole balanced capture stage was lost.
    (value) => { value.splice(7, 2); }, // A whole Blob-read stage was lost.
    (value) => { value[2].firstFailure = true; },
    (value) => { value.push({ ...value.at(-1) }); },
    (value) => { value[1] = { malformedValue: "{" }; },
    (value) => { value[1] = null; },
  ]) {
    const invalid = structuredClone(events); corrupt(invalid);
    assert.equal(summarizePageSaveDiagnostics(invalid).complete, false);
  }
  assert.equal(summarizePageSaveDiagnostics(events, [], new Set(["original-operation"])).complete, false);
  assert.equal(summarizePageSaveDiagnostics(events, ["worker_disconnected"]).outcome, "unknown");
});

test("page-save evidence preserves the first observed failure without replacing it with a later error", () => {
  const events = saveEvents().slice(0, 9);
  events[8] = { ...events[8], status: "failed", firstFailure: true, error: { name: "NotReadableError", message: "original Blob failed" } };
  const result = summarizePageSaveDiagnostics(events);
  assert.equal(result.complete, true); assert.equal(result.outcome, "failed");
  assert.equal(result.firstFailure, events[8]);
  events.push({ ...events[8], sequence: 10, phase: "transaction.abort", elapsedMs: 9, firstFailure: false, error: { name: "AbortError" } });
  assert.equal(summarizePageSaveDiagnostics(events).firstFailure, events[8]);
  events.push(saveEvents().at(-1));
  assert.equal(summarizePageSaveDiagnostics(events).complete, false);
});

test("page-save investigation persists original evidence and stops when its console channel is lost", async () => {
  const artifactRoot = path.resolve("out/test-artifacts");
  await mkdir(artifactRoot, { recursive: true });
  const sampleRoot = await mkdtemp(path.join(artifactRoot, "page-save-collector-"));
  const webSocket = new EventTarget();
  const emit = (value) => webSocket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
    method: "Runtime.consoleAPICalled", params: { args: [{ value: "BKA page-save diagnostic" }, { value }] },
  }) }));
  let attempt = 0;
  const browserVersion = { product: "fixture", revision: "exact-test-revision" };
  const result = await runPageSaveInvestigation({ sampleRoot, attemptCount: 4, browserVersion,
    workerClient: { webSocket, async send() { return {}; } },
    async probe() {
      attempt += 1;
      for (const event of saveEvents(`operation-${attempt}`)) emit(JSON.stringify(event));
      if (attempt === 2) { emit("{"); webSocket.dispatchEvent(new Event("close")); throw new Error("original CLI failure"); }
      return { saved: true };
    },
  });
  assert.equal(result.attempts, 2); assert.equal(result.failures, 1); assert.equal(result.incompleteDiagnostics, 1);
  const attempts = JSON.parse(await readFile(path.join(sampleRoot, "attempts.json"), "utf8"));
  assert.equal(attempts[0].diagnostics.operationId, "operation-1");
  assert.equal(attempts[1].diagnostics.operationId, null);
  assert.match(attempts[1].error, /original CLI failure/u);
  assert.ok(attempts[1].diagnostics.problems.includes("worker_disconnected"));
  const raw = JSON.parse(await readFile(path.join(sampleRoot, "original-operation-diagnostics.json"), "utf8"));
  assert.equal(raw.at(-1).malformedValue, "{");
  assert.deepEqual(JSON.parse(await readFile(path.join(sampleRoot, "browser-version.json"), "utf8")), browserVersion);
});

test("occluded input acceptance rejects visibility, activation, identity, and event false positives", () => {
  const click = { type: "click", target: "hover", trusted: true, x: 88, y: 89 };
  const evidence = {
    before: { documentToken: "same-document" },
    occluded: { documentToken: "same-document", visibility: "hidden", events: [click] },
    after: { documentToken: "same-document", visibility: "hidden", events: [click, click] },
    rootInput: { result: 0, foregroundUnchanged: true, legacyVisibleBefore: false },
    point: { x: 88, y: 89 },
  };
  assertOccludedInput(evidence);
  for (const corrupt of [
    (value) => { value.occluded.visibility = "visible"; },
    (value) => { value.after.visibility = "visible"; },
    (value) => { value.rootInput.foregroundUnchanged = false; },
    (value) => { value.rootInput.legacyVisibleBefore = true; },
    (value) => { value.rootInput.result = 5; },
    (value) => { value.after.documentToken = "new-document"; },
    (value) => { value.after.events.pop(); },
    (value) => { value.after.events[1] = { ...click, trusted: false }; },
    (value) => { value.after.events[1] = { ...click, y: 90 }; },
  ]) {
    const invalid = structuredClone(evidence); corrupt(invalid);
    assert.throws(() => assertOccludedInput(invalid));
  }
});

test("physical occlusion acceptance permits internal visibility but rejects window and input false positives", () => {
  const click = { type: "click", target: "hover", trusted: true, x: 88, y: 89 };
  const evidence = {
    before: { documentToken: "same-document", visibility: "hidden", events: [click] },
    after: { documentToken: "same-document", visibility: "visible", events: [click, click] },
    nativeBefore: { covered: true, rootUnchanged: true, foreground: 42, legacyVisible: false },
    nativeAfter: { covered: true, rootUnchanged: true, foreground: 42, legacyVisible: true },
    response: { ok: true }, point: { x: 88, y: 89 },
  };
  assertCoveredInput(evidence);
  for (const visibility of ["hidden", "visible"]) {
    const value = structuredClone(evidence);
    value.before.visibility = value.after.visibility = visibility;
    assertCoveredInput(value);
  }
  for (const corrupt of [
    (value) => { value.nativeBefore.covered = false; },
    (value) => { value.nativeAfter.covered = false; },
    (value) => { value.nativeBefore.rootUnchanged = false; },
    (value) => { value.nativeAfter.rootUnchanged = false; },
    (value) => { value.nativeAfter.foreground = 7; },
    (value) => { value.response.ok = false; },
    (value) => { value.after.documentToken = "new-document"; },
    (value) => { value.after.events.pop(); },
    (value) => { value.after.events[1].trusted = false; },
    (value) => { value.after.events[1].target = "source"; },
    (value) => { value.after.events[1].x = 89; },
    (value) => { value.after.events.push({ ...click, target: "other" }); },
  ]) {
    const invalid = structuredClone(evidence); corrupt(invalid);
    assert.throws(() => assertCoveredInput(invalid));
  }
});

test("native HTML5 acceptance checks actual drop and completion coordinates, not only DataTransfer", () => {
  const event = { trusted: true, buttons: 0, x: 307, y: 330 };
  const evidence = {
    before: { documentToken: "same-document", events: [] },
    after: { documentToken: "same-document", dropData: "fixture-card", events: [
      { ...event, type: "drop", target: "drop" }, { ...event, type: "dragend", target: "source" },
    ] },
    point: { x: 307, y: 330 },
  };
  assertNativeDragDrop(evidence);
  for (const corrupt of [
    (value) => { value.after.documentToken = "new-document"; },
    (value) => { value.after.dropData = null; },
    (value) => { value.after.events[0].trusted = false; },
    (value) => { value.after.events[0].target = "reject"; },
    (value) => { value.after.events[0].x = 220; },
    (value) => { value.after.events[1].x = 259; value.after.events[1].y = 514; },
    (value) => { value.after.events[1].buttons = 1; },
    (value) => { value.after.events.pop(); },
    (value) => { value.after.events.push({ ...value.after.events[0] }); },
    (value) => { value.before.events = [...value.after.events]; },
  ]) {
    const invalid = structuredClone(evidence); corrupt(invalid);
    assert.throws(() => assertNativeDragDrop(invalid));
  }
});
