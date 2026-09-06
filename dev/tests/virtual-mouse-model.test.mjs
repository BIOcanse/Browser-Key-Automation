import assert from "node:assert/strict";
import test from "node:test";
import { parseMouseActions } from "../../out/extension/background/virtual-mouse-model.js";
import { isVirtualInputResponse } from "../../out/extension/shared/virtual-input-protocol.js";
import { expandMouseShortcut } from "../../out/extension/background/virtual-mouse-shortcuts.js";

const base = { tabRef: `tr1.${"A".repeat(22)}.1.${"B".repeat(22)}`, timeoutMs: 10000 };
const expand = (name, params, maximum = 256) => expandMouseShortcut(`virtualMouse.${name}`, { ...base, ...params }, maximum);

test("mouse shortcuts expand to exact existing actions without reading or copying mouse state", () => {
  assert.deepEqual(expand("move", { x: 8, y: 9 }), [{ kind: "move", x: 8, y: 9 }]);
  assert.deepEqual(expand("click", { at: null, button: "left" }), [{ kind: "button", button: "left", action: "press" }]);
  assert.deepEqual(expand("click", { at: { x: 8, y: 9 }, button: "right" }), [
    { kind: "move", x: 8, y: 9 }, { kind: "button", button: "right", action: "press" },
  ]);
  for (const button of ["left", "right", "middle", "back", "forward"]) {
    for (const action of ["down", "up"]) assert.deepEqual(expand(action, { button }), [{ kind: "button", button, action }]);
  }
  assert.deepEqual(expand("drag", { from: null, to: { x: 30, y: 40 }, via: [], button: "left" }), [
    { kind: "button", button: "left", action: "down" }, { kind: "move", x: 30, y: 40 }, { kind: "button", button: "left", action: "up" },
  ]);
  assert.deepEqual(expand("drag", { from: { x: 1, y: 2 }, to: { x: 30, y: 40 }, via: [{ x: 10, y: 20 }], button: "middle" }), [
    { kind: "move", x: 1, y: 2 }, { kind: "button", button: "middle", action: "down" },
    { kind: "move", x: 10, y: 20 }, { kind: "move", x: 30, y: 40 }, { kind: "button", button: "middle", action: "up" },
  ]);
  assert.deepEqual(expand("scroll", { at: null, deltaX: -120, deltaY: 240 }), [{ kind: "wheel", deltaX: -120, deltaY: 240 }]);
  assert.deepEqual(expand("scroll", { at: { x: 0, y: 0 }, deltaX: 0, deltaY: 0 }), [
    { kind: "move", x: 0, y: 0 }, { kind: "wheel", deltaX: 0, deltaY: 0 },
  ]);
});

test("shortcut validation is closed and capacity counts every expanded meta-action", () => {
  const drag = { from: { x: 1, y: 2 }, to: { x: 8, y: 9 }, via: [{ x: 3, y: 4 }], button: "left" };
  assert.equal(expand("drag", drag, 5).length, 5);
  assert.equal(expand("drag", drag, 4), null);
  assert.equal(expand("drag", { ...drag, from: null }, 4).length, 4);
  for (const patch of [{ from: {} }, { to: { x: 8 } }, { via: [{ x: 1, y: -2 }] }, { via: null },
    { via: [{ x: 1, y: 2, extra: true }] }, { button: "primary" }, { durationMs: 100 }, { steps: 10 }, { actions: [] }]) {
    assert.equal(expand("drag", { ...drag, ...patch }), null, JSON.stringify(patch));
  }
  for (const at of [undefined, [], { x: 1 }, { x: 1.5, y: 2 }, { x: 32768, y: 1 }, { x: 1, y: NaN }]) {
    assert.equal(expand("click", { at, button: "left" }), null);
  }
  assert.equal(expand("click", { at: null, button: "left", count: 2 }), null);
  assert.equal(expand("click", { at: { x: 1, y: 2 }, button: "left" }, 1), null);
  assert.equal(expand("up", { button: "left", at: null }), null);
  assert.equal(expand("scroll", { at: null, deltaX: 0, deltaY: -32769 }), null);
  assert.equal(expand("scroll", { at: null, deltaX: null, deltaY: 0 }), null);
});

test("mouse meta-actions have no hidden move, waits or input backend selection", () => {
  const actions = [{ kind: "move", x: 4, y: 8 }, { kind: "button", button: "left", action: "down" },
    { kind: "move", x: 9, y: 12 }, { kind: "button", button: "left", action: "up" }, { kind: "wheel", deltaX: 0, deltaY: -120 }];
  assert.deepEqual(parseMouseActions(actions, 5), actions);
  assert.equal(parseMouseActions(actions, 4), null);
  for (const action of [{ kind: "click" }, { kind: "button", button: "left" },
    { kind: "button", button: "left", action: "press", x: 1 }, { kind: "move", x: NaN, y: 1 },
    { kind: "move", x: 1, y: 1, backend: "auto" }, { kind: "wait", ms: 1 }, { kind: "wheel", deltaY: 120 }]) {
    assert.equal(parseMouseActions([action], 20), null, JSON.stringify(action));
  }
});

test("input result validator requires one shared state and distinguishes errors", () => {
  const response = { kind: "native.virtualInput.result", requestId: "one", ok: true,
    result: { completedActions: 0, input: { id: 1, mouse: { point: { x: 1, y: 2 }, buttons: 0, known: true },
      keyboard: { keys: Array(256).fill(0), known: true }, windows: [{ windowId: 7, alive: true, interception: false }] } } };
  assert.equal(isVirtualInputResponse(response, "one"), true);
  assert.equal(isVirtualInputResponse(response, "two"), false);
  for (const patch of [{ known: null }, { buttons: 32 }, { point: { x: -1, y: 0 } }]) {
    const broken = structuredClone(response); Object.assign(broken.result.input.mouse, patch);
    assert.equal(isVirtualInputResponse(broken), false);
  }
  for (const patch of [{ keys: [] }, { known: null }]) {
    const broken = structuredClone(response); Object.assign(broken.result.input.keyboard, patch);
    assert.equal(isVirtualInputResponse(broken), false);
  }
  assert.equal(isVirtualInputResponse({ ...response, result: { completedActions: 0, input: null } }), true);
  assert.equal(isVirtualInputResponse({ kind: response.kind, requestId: "one", ok: false, error: { reason: "InputTimeout" } }), true);
});
