import assert from "node:assert/strict";

import { COMMAND_CATALOG } from "../../out/extension/generated/command-config.js";

const tracePattern = /^xr1\.[A-Za-z0-9_-]{43}$/u;

function locator(tabRef, selector, framePath = []) {
  return {
    kind: "locator",
    tabRef,
    framePath,
    selector,
    role: null,
    name: null,
    nameMatch: "exact",
    match: "unique",
  };
}

function resultValue(response) {
  assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
  assert.equal(response.payload.result.status, "fulfilled", JSON.stringify(response.payload.result));
  return JSON.parse(response.payload.result.valueJson);
}

export async function runAdvancedEnsureProbe({ forward, baseUrl, frameBaseUrl, windowId }) {
  const created = await forward("tabs.create", { active: false, url: `${baseUrl}advanced`, windowId });
  assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
  const tabRef = created.payload.result.tab.tabRef;
  const loaded = await forward("page.wait", { tabRef, until: "complete", timeoutMs: 10_000 });
  assert.equal(loaded.payload.result.status, "satisfied", JSON.stringify(loaded.payload));
  assert.equal(loaded.payload.result.observation.conditionSatisfied, true, JSON.stringify(loaded.payload));

  const initial = resultValue(await forward("js.execute", {
    tabRef,
    world: "MAIN",
    code: `({crossOrigin:document.querySelector('#advanced-frame').contentDocument===null,scrollY,feedTop:document.querySelector('#feed').scrollTop})`,
    timeoutMs: 3000,
  }));
  assert.deepEqual(initial, { crossOrigin: true, scrollY: 0, feedTop: 0 });

  const virtualTarget = locator(tabRef, "#virtual-target");
  const virtual = await forward("ensure.run", {
    mode: "ensure",
    timeoutMs: 5000,
    scrollIntoView: false,
    searchByScrolling: true,
    precondition: null,
    goal: { kind: "text_contains", target: virtualTarget, text: "done" },
    action: { method: "dom.click", schemaVersion: 1, target: virtualTarget, params: {} },
  });
  assert.equal(virtual.payload.ok, true, JSON.stringify(virtual.payload));
  const virtualState = resultValue(await forward("js.execute", {
    tabRef,
    world: "MAIN",
    code: `({scrollY,feedTop:document.querySelector('#feed').scrollTop,clicks:window.virtualClicks??null,generation:window.virtualGeneration??null,text:document.querySelector('#virtual-target')?.textContent??null})`,
    timeoutMs: 3000,
  }));
  assert.equal(virtual.payload.result.status, "satisfied", JSON.stringify({ result: virtual.payload.result, virtualState }));
  assert.equal(virtual.payload.result.effectAttempts, 1);
  assert.ok(virtual.payload.result.preparations.searchScrollCount >= 1);
  assert.match(virtual.payload.trace.traceRef, tracePattern);
  assert.equal(virtualState.scrollY, 0);
  assert.ok(virtualState.feedTop > 0);
  assert.equal(virtualState.clicks, 1);
  assert.ok(virtualState.generation >= 2);
  assert.equal(virtualState.text, "done");

  const traceRead = await forward("trace.read", { traceRef: virtual.payload.trace.traceRef });
  assert.equal(traceRead.payload.ok, true, JSON.stringify(traceRead.payload));
  const trace = traceRead.payload.result.trace;
  assert.equal(trace.traceRef, virtual.payload.trace.traceRef);
  assert.equal(trace.method, "ensure.run");
  assert.equal(trace.outcome, "succeeded");
  assert.equal(trace.ensureStatus, "satisfied");
  assert.equal(trace.effectEntries, 1);
  assert.equal(trace.events.filter((event) => event.operation === "effect_entered").length, 1);
  assert.ok(trace.events.some((event) => event.operation === "search_scrolled" && event.status === "succeeded"));
  assert.deepEqual(trace.events.map((event) => event.sequence), trace.events.map((_event, index) => index + 1));
  const ordered = [
    (event) => event.phase === "condition" && event.operation === "condition_observed",
    (event) => event.operation === "search_scrolled" && event.status === "succeeded",
    (event) => event.operation === "target_resolved" && event.status === "matched",
    (event) => event.operation === "effect_entered",
    (event) => event.operation === "effect_returned" && event.status === "succeeded",
    (event) => event.phase === "verify" && event.operation === "condition_observed",
    (event) => event.operation === "workflow_finished" && event.status === "satisfied",
  ];
  let previousIndex = -1;
  for (const predicate of ordered) {
    const nextIndex = trace.events.findIndex((event, index) => index > previousIndex && predicate(event));
    assert.ok(nextIndex > previousIndex, JSON.stringify(trace.events));
    previousIndex = nextIndex;
  }

  let diagnosticRead = 0;
  while (diagnosticRead < COMMAND_CATALOG.limits["command.trace.maximum_records_per_key"] + 2) {
    const repeated = await forward("trace.read", { traceRef: trace.traceRef });
    assert.equal(repeated.payload.ok, true, JSON.stringify(repeated.payload));
    assert.equal(repeated.payload.trace.state, "unavailable");
    assert.equal(repeated.payload.trace.traceRef, null);
    diagnosticRead += 1;
  }
  const retainedAfterDiagnostics = await forward("trace.read", { traceRef: trace.traceRef });
  assert.equal(retainedAfterDiagnostics.payload.ok, true, JSON.stringify(retainedAfterDiagnostics.payload));
  assert.equal(retainedAfterDiagnostics.payload.result.trace.traceRef, trace.traceRef);

  const exported = await forward("trace.export", { traceRef: trace.traceRef });
  assert.equal(exported.payload.ok, true, JSON.stringify(exported.payload));
  const artifactRef = exported.payload.result.artifact.artifactRef;
  const traceBytes = await forward("artifact.read", { artifactRef, offset: 0, maximumBytes: 36_000 });
  assert.equal(traceBytes.payload.ok, true, JSON.stringify(traceBytes.payload));
  assert.equal(traceBytes.payload.result.nextOffset, null);
  assert.deepEqual(JSON.parse(Buffer.from(traceBytes.payload.result.dataBase64Url, "base64url").toString("utf8")), trace);
  assert.equal((await forward("artifact.release", { artifactRef })).payload.result.released, true);

  const initialFrames = await forward("frames.list", { tabRef, limit: 20 });
  const generationOne = initialFrames.payload.result.items.find((item) => item.url.includes("generation=1"));
  assert.ok(generationOne?.documentRef, JSON.stringify(initialFrames.payload.result));
  const oldFrameAction = await forward("dom.query", {
    documentRef: generationOne.documentRef, selector: "#frame-action", limit: 1,
  });
  const oldFrameNodeRef = oldFrameAction.payload.result.items[0].nodeRef;
  const childPath = [{ urlPattern: `${frameBaseUrl}frame*`, match: "unique" }];
  const frameAction = locator(tabRef, "#frame-action", childPath);
  const navigatedGoal = locator(tabRef, "#frame-goal", childPath);
  const navigated = await forward("ensure.run", {
    mode: "ensure",
    timeoutMs: 5000,
    scrollIntoView: false,
    searchByScrolling: false,
    precondition: { kind: "ready", target: frameAction },
    goal: { kind: "text_contains", target: navigatedGoal, text: "navigated" },
    action: { method: "dom.click", schemaVersion: 1, target: frameAction, params: {} },
  });
  assert.equal(navigated.payload.result.status, "satisfied", JSON.stringify(navigated.payload));
  assert.equal(navigated.payload.result.effectAttempts, 1);
  const staleAfterNavigation = await forward("dom.describe", { nodeRef: oldFrameNodeRef });
  assert.equal(staleAfterNavigation.payload.ok, false);
  assert.equal(staleAfterNavigation.payload.error.code, "TARGET_REF_STALE");

  const generationTwoFrames = await forward("frames.list", { tabRef, limit: 20 });
  const generationTwo = generationTwoFrames.payload.result.items.find((item) => item.url.includes("generation=2"));
  assert.ok(generationTwo?.documentRef, JSON.stringify(generationTwoFrames.payload.result));
  const oldFrameGoal = await forward("dom.query", {
    documentRef: generationTwo.documentRef, selector: "#frame-goal", limit: 1,
  });
  const oldFrameGoalRef = oldFrameGoal.payload.result.items[0].nodeRef;
  const replaceAction = locator(tabRef, "#replace-frame");
  const replacementGoal = locator(tabRef, "#replacement-goal", childPath);
  const replaced = await forward("ensure.run", {
    mode: "ensure",
    timeoutMs: 5000,
    scrollIntoView: false,
    searchByScrolling: false,
    precondition: { kind: "ready", target: replaceAction },
    goal: { kind: "text_contains", target: replacementGoal, text: "replaced" },
    action: { method: "dom.click", schemaVersion: 1, target: replaceAction, params: {} },
  });
  assert.equal(replaced.payload.result.status, "satisfied", JSON.stringify(replaced.payload));
  assert.equal(replaced.payload.result.effectAttempts, 1);
  const staleAfterReplacement = await forward("dom.describe", { nodeRef: oldFrameGoalRef });
  assert.equal(staleAfterReplacement.payload.ok, false);
  assert.equal(staleAfterReplacement.payload.error.code, "TARGET_REF_STALE");

  return {
    tabRef,
    virtual: {
      pageStayedStill: virtualState.scrollY === 0,
      nestedScrollTop: virtualState.feedTop,
      clickCount: virtualState.clicks,
      replacementGeneration: virtualState.generation,
    },
    iframe: {
      parentCannotReadChildDom: initial.crossOrigin,
      navigationRecovered: navigated.payload.result.status === "satisfied",
      replacementRecovered: replaced.payload.result.status === "satisfied",
      oldRefsStayedStale: true,
    },
    trace: {
      traceRef: trace.traceRef,
      eventCount: trace.events.length,
      effectEntries: trace.effectEntries,
      exportedThroughArtifact: true,
    },
  };
}
