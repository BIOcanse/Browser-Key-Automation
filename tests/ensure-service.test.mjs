import assert from "node:assert/strict";
import test from "node:test";
import { linearGlobMatch, runEnsure } from "../out/extension/background/ensure-service.js";

const turn = () => new Promise((resolve) => setImmediate(resolve));
const tabRef = `tr1.${"A".repeat(22)}.1.${"B".repeat(22)}`;
const secondTabRef = `tr1.${"A".repeat(22)}.2.${"D".repeat(22)}`;
const nodeRef = `nr1.${"C".repeat(43)}`;
const nodeTarget = { kind: "node", nodeRef };

function action(overrides = {}) {
  return {
    method: "tabs.create",
    schemaVersion: 1,
    requiredPermission: "tabs.create",
    params: { url: "https://fixture.test", active: false, windowId: 1 },
    target: null,
    policy: { completion: "result", repeat: "never" },
    derivedGoal: null,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    mode: "ensure",
    timeoutMs: 300,
    scrollIntoView: false,
    searchByScrolling: false,
    precondition: null,
    goal: null,
    action: action(),
    ...overrides,
  };
}

function harness() {
  const state = {
    now: 0,
    active: false,
    url: "https://fixture.test/start",
    loaded: false,
    target: {
      status: "matched", nodeRef, visible: true, enabled: true, unobstructed: true, focused: false,
      text: "fixture", value: "before", selectedValues: [], rect: { x: 1, y: 2, width: 10, height: 20 },
    },
    authorizations: [],
    actions: 0,
    javascriptConditions: 0,
    targetObservations: 0,
    targetScrolls: 0,
    searchAttempts: 0,
    searchScrolls: 0,
    traceEvents: [],
    deniedPermission: null,
    hangPermission: null,
    hangAction: false,
    onObserveTarget: null,
    onAction: null,
    onSearchScroll: null,
  };
  const timers = new Map();
  let sequence = 0;
  const dependencies = {
    authorize: async (permission) => {
      state.authorizations.push(permission);
      if (state.hangPermission === permission) return new Promise(() => {});
      if (state.deniedPermission === permission) throw Object.assign(new Error("denied"), { code: "FORBIDDEN" });
    },
    observeTarget: async (target) => {
      state.targetObservations += 1;
      return state.onObserveTarget?.(target) ?? state.target;
    },
    observeLoaded: async () => state.loaded,
    observeTab: async () => ({ active: state.active, url: state.url }),
    executeJavascriptCondition: async () => { state.javascriptConditions += 1; return false; },
    executeAction: async (currentAction, resolvedNodeRef) => {
      state.actions += 1;
      state.onAction?.(currentAction, resolvedNodeRef);
      if (state.hangAction) return new Promise(() => {});
      return { applied: true };
    },
    scrollTarget: async () => { state.targetScrolls += 1; },
    scrollSearch: async (target, percent, cursor, scope) => {
      state.searchAttempts += 1;
      const result = state.onSearchScroll?.(target, percent, cursor, scope) ?? {
        moved: false, nextCursor: cursor, contextKind: null,
      };
      if (result.moved) state.searchScrolls += 1;
      return result;
    },
    recordEvent: (event) => { state.traceEvents.push(event); },
    checkpointEffect: async () => undefined,
    normalizeError: (error) => ({ code: typeof error?.code === "string" ? error.code : "INTERNAL_ERROR" }),
    now: () => state.now,
    setTimer(callback, milliseconds) {
      const id = ++sequence;
      timers.set(id, { at: state.now + milliseconds, callback });
      return id;
    },
    clearTimer(handle) { timers.delete(handle); },
  };
  return {
    state,
    timers,
    run: (value) => runEnsure(value, dependencies),
    async advance(milliseconds) {
      const end = state.now + milliseconds;
      await turn();
      while (true) {
        const next = [...timers.entries()]
          .filter(([, item]) => item.at <= end)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (next === undefined) break;
        state.now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await turn();
      }
      state.now = end;
      await turn();
    },
  };
}

test("strict false observes once and dispatches no preparation or action", async () => {
  const h = harness();
  await assert.rejects(h.run(request({
    mode: "strict",
    precondition: { kind: "tab_active", tabRef },
  })), (error) => error.code === "CONDITION_NOT_MET" && error.details.conditionKind === "tab_active");
  assert.equal(h.state.actions, 0);
  assert.equal(h.state.targetScrolls, 0);
  assert.equal(h.state.searchAttempts, 0);
  assert.deepEqual(h.state.authorizations, ["page.wait"]);
  assert.equal(h.timers.size, 0);
});

test("strict true and result completion each dispatch exactly once", async () => {
  const h = harness(); h.state.active = true;
  const result = await h.run(request({ mode: "strict", precondition: { kind: "tab_active", tabRef } }));
  assert.equal(result.status, "satisfied");
  assert.equal(result.stage, "effect");
  assert.equal(result.effectAttempts, 1);
  assert.equal(h.state.actions, 1);
  assert.equal(h.state.traceEvents.filter((event) => event.operation === "effect_entered").length, 1);
  assert.equal(h.state.traceEvents.at(-1)?.operation, "workflow_finished");
  assert.equal(h.state.traceEvents.at(-1)?.status, "satisfied");
  assert.equal(h.timers.size, 0);
});

test("an initially satisfied goal performs no effect", async () => {
  const h = harness(); h.state.active = true;
  const result = await h.run(request({ goal: { kind: "tab_active", tabRef } }));
  assert.equal(result.status, "satisfied");
  assert.equal(result.stage, "condition");
  assert.equal(result.effectSent, false);
  assert.equal(h.state.actions, 0);
});

test("a non-repeat action is sent at most once and becomes unknown at the shared deadline", async () => {
  const h = harness();
  const pending = h.run(request({
    goal: { kind: "tab_active", tabRef },
    action: action({
      method: "dom.click",
      requiredPermission: "dom.click",
      target: nodeTarget,
      params: {},
      policy: { completion: "explicit_goal", repeat: "never" },
    }),
  }));
  await h.advance(300);
  const result = await pending;
  assert.equal(result.status, "unknown");
  assert.equal(result.effectAttempts, 1);
  assert.equal(h.state.actions, 1);
  assert.equal(h.state.traceEvents.filter((event) => event.operation === "effect_entered").length, 1);
  assert.equal(h.state.traceEvents.at(-1)?.operation, "workflow_finished");
  assert.equal(h.state.traceEvents.at(-1)?.status, "unknown");
  assert.equal(h.timers.size, 0);
});

test("only a declared safe action repeats, then reports a definite bounded failure", async () => {
  const h = harness();
  const pending = h.run(request({
    goal: { kind: "value_is", target: nodeTarget, value: "after" },
    action: action({
      method: "dom.setValue",
      requiredPermission: "dom.setValue",
      target: nodeTarget,
      params: { value: "after" },
      policy: { completion: "derive_value", repeat: "safe" },
      derivedGoal: { kind: "value_is", target: nodeTarget, value: "after" },
    }),
  }));
  await h.advance(300);
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.ok(result.effectAttempts >= 2);
  assert.equal(result.effectAttempts, h.state.actions);
  assert.equal(h.timers.size, 0);
});

test("a hung effect consumes the same deadline and is never replayed", async () => {
  const h = harness(); h.state.hangAction = true;
  const pending = h.run(request());
  await h.advance(300);
  const result = await pending;
  assert.equal(result.status, "unknown");
  assert.equal(result.effectAttempts, 1);
  assert.equal(h.state.actions, 1);
  assert.equal(h.timers.size, 0);
});

test("permission loss before the effect is a failed no-effect result", async () => {
  const h = harness(); h.state.deniedPermission = "tabs.create";
  const result = await h.run(request());
  assert.equal(result.status, "failed");
  assert.equal(result.effectSent, false);
  assert.equal(result.error.code, "FORBIDDEN");
  assert.equal(h.state.actions, 0);
  assert.equal(h.state.traceEvents.some((event) => event.operation === "effect_entered"), false);
  assert.equal(h.state.traceEvents.at(-1)?.operation, "workflow_finished");
  assert.equal(h.state.traceEvents.at(-1)?.status, "failed");
});

test("one deadline also bounds an unresponsive authorization check before any effect", async () => {
  const h = harness(); h.state.hangPermission = "tabs.create";
  const pending = h.run(request());
  await h.advance(300);
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.equal(result.effectSent, false);
  assert.equal(h.state.actions, 0);
  assert.equal(h.timers.size, 0);
});

test("a locator may be searched downward and re-resolved without rebinding an exact NodeRef", async () => {
  const h = harness();
  const locator = { kind: "locator", tabRef, selector: "button", role: "button", name: "Save", nameMatch: "exact", match: "unique" };
  h.state.onObserveTarget = () => h.state.searchScrolls === 0
    ? { ...h.state.target, status: "absent", nodeRef: null, rect: null, visible: false, enabled: false, unobstructed: false }
    : h.state.target;
  h.state.onSearchScroll = (_target, _percent, cursor) => ({ moved: true, nextCursor: cursor + 1, contextKind: "element" });
  const pending = h.run(request({
    searchByScrolling: true,
    precondition: { kind: "present", target: locator },
    action: action({ method: "dom.click", requiredPermission: "dom.click", target: locator, params: {}, policy: { completion: "result", repeat: "never" } }),
  }));
  await h.advance(100);
  const result = await pending;
  assert.equal(result.status, "satisfied");
  assert.equal(h.state.searchScrolls, 1);
  assert.ok(h.state.targetObservations >= 2);
  assert.equal(h.state.actions, 1);
});

test("a locator is re-resolved immediately before the effect and only the refreshed NodeRef is used", async () => {
  const h = harness();
  const firstNodeRef = `nr1.${"E".repeat(43)}`;
  const refreshedNodeRef = `nr1.${"F".repeat(43)}`;
  const locator = { kind: "locator", tabRef, selector: "button", role: "button", name: "Save", nameMatch: "exact", match: "unique" };
  h.state.onObserveTarget = () => ({
    ...h.state.target,
    nodeRef: h.state.targetObservations === 1 ? firstNodeRef : refreshedNodeRef,
  });
  let executedNodeRef = null;
  h.state.onAction = (_action, resolvedNodeRef) => { executedNodeRef = resolvedNodeRef; };
  const result = await h.run(request({
    action: action({ method: "dom.click", requiredPermission: "dom.click", target: locator, params: {}, policy: { completion: "result", repeat: "never" } }),
  }));
  assert.equal(result.status, "satisfied");
  assert.equal(h.state.targetObservations, 2);
  assert.equal(h.state.actions, 1);
  assert.equal(executedNodeRef, refreshedNodeRef);
});

test("repeated pre-effect locator churn stays retriable until the shared deadline", async () => {
  const h = harness();
  const locator = { kind: "locator", tabRef, selector: "#settles", role: null, name: null, nameMatch: "exact", match: "unique" };
  h.state.onObserveTarget = () => h.state.targetObservations < 4
    ? { ...h.state.target, status: "absent", nodeRef: null, rect: null, visible: false, enabled: false, unobstructed: false }
    : h.state.target;
  const pending = h.run(request({
    timeoutMs: 500,
    action: action({ method: "dom.click", requiredPermission: "dom.click", target: locator, params: {}, policy: { completion: "result", repeat: "never" } }),
  }));
  await h.advance(350);
  const result = await pending;
  assert.equal(result.status, "satisfied");
  assert.equal(h.state.targetObservations, 5, "the settled target is revalidated at the final effect boundary");
  assert.equal(h.state.actions, 1);
});

test("reaching the end of one page does not suppress an explicit locator search in another tab", async () => {
  const h = harness();
  const firstLocator = { kind: "locator", tabRef, selector: "#first", role: null, name: null, nameMatch: "exact", match: "unique" };
  const secondLocator = { kind: "locator", tabRef: secondTabRef, selector: "#second", role: null, name: null, nameMatch: "exact", match: "unique" };
  const searchedTabs = new Set();
  h.state.onObserveTarget = (target) => searchedTabs.has(target.tabRef)
    ? h.state.target
    : { ...h.state.target, status: "absent", nodeRef: null, rect: null, visible: false, enabled: false, unobstructed: false };
  h.state.onSearchScroll = (target, _percent, cursor) => {
    searchedTabs.add(target.tabRef);
    return { moved: true, nextCursor: cursor + 1, contextKind: "document" };
  };
  const pending = h.run(request({
    searchByScrolling: true,
    precondition: { kind: "present", target: firstLocator },
    action: action({ method: "dom.click", requiredPermission: "dom.click", target: secondLocator, params: {}, policy: { completion: "result", repeat: "never" } }),
  }));
  await h.advance(200);
  const result = await pending;
  assert.equal(result.status, "satisfied");
  assert.deepEqual([...searchedTabs], [tabRef, secondTabRef]);
  assert.equal(h.state.searchScrolls, 2);
  assert.equal(h.state.actions, 1);
});

test("a no-effect current bottom is retried after lazy growth and then becomes searchable", async () => {
  const h = harness();
  const locator = { kind: "locator", tabRef, selector: "#lazy", role: null, name: null, nameMatch: "exact", match: "unique" };
  h.state.onObserveTarget = () => h.state.searchAttempts >= 2
    ? h.state.target
    : { ...h.state.target, status: "absent", nodeRef: null, rect: null, visible: false, enabled: false, unobstructed: false };
  h.state.onSearchScroll = (_target, _percent, cursor) => h.state.searchAttempts === 1
    ? { moved: false, nextCursor: cursor, contextKind: null }
    : { moved: true, nextCursor: cursor + 1, contextKind: "element" };
  const pending = h.run(request({
    searchByScrolling: true,
    precondition: { kind: "present", target: locator },
  }));
  await h.advance(200);
  const result = await pending;
  assert.equal(result.status, "satisfied");
  assert.equal(h.state.searchAttempts, 2);
  assert.equal(h.state.searchScrolls, 1);
  assert.equal(h.state.actions, 1);
});

test("composites short-circuit custom JavaScript and glob matching is Unicode-aware", async () => {
  const h = harness(); h.state.active = true;
  const result = await h.run(request({
    goal: { kind: "any", conditions: [
      { kind: "tab_active", tabRef },
      { kind: "javascript", tabRef, world: "USER_SCRIPT", code: "false", timeoutMs: 50 },
    ] },
  }));
  assert.equal(result.status, "satisfied");
  assert.equal(h.state.javascriptConditions, 0);
  assert.equal(linearGlobMatch("https://例.test/😀/done", "https://?.test/?/*"), true);
  assert.equal(linearGlobMatch("abc", "a*d"), false);
});
