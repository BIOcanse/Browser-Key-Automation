import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHumanTypingPlan,
  canonicalKeyNameForVirtualKey,
  parseKeyboardActions,
  resolveKeyboardKey,
} from "../out/extension/background/keyboard-model.js";

test("keyboard names and aliases resolve to stable virtual keys", () => {
  assert.deepEqual({ ...resolveKeyboardKey("ctrl") }, {
    name: "ControlLeft", virtualKey: 0xa2, extended: false, modifier: true,
  });
  assert.equal(resolveKeyboardKey("Arrow-Down").virtualKey, 0x28);
  assert.equal(resolveKeyboardKey("Plus").virtualKey, 0xbb);
  assert.equal(resolveKeyboardKey("+") , null);
  assert.equal(canonicalKeyNameForVirtualKey(0xa3), "ControlRight");
  assert.equal(resolveKeyboardKey("NoSuchKey"), null);
});

test("plain names are complete presses and explicit down/up survives across actions", () => {
  const parsed = parseKeyboardActions([
    { key: "ShiftLeft", action: "down" },
    "ArrowDown",
    { waitMs: 80 },
    { key: "ShiftLeft", action: "up" },
  ], 12, 4, 64, 8, 5000);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), [
    { kind: "down", keys: [{ virtualKey: 0xa0, extended: false }] },
    { kind: "wait", waitMs: 4 },
    { kind: "press", keys: [{ virtualKey: 0x28, extended: true }], holdMs: 12 },
    { kind: "wait", waitMs: 4 },
    { kind: "wait", waitMs: 80 },
    { kind: "wait", waitMs: 4 },
    { kind: "up", keys: [{ virtualKey: 0xa0, extended: false }] },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(parseKeyboardActions("Ctrl+Shift+P", 0, 0, 64, 8, 5000))), [{
    kind: "press",
    keys: [
      { virtualKey: 0xa2, extended: false },
      { virtualKey: 0xa0, extended: false },
      { virtualKey: 0x50, extended: false },
    ],
    holdMs: 0,
  }]);
});

test("keyboard action grammar is closed and bounded", () => {
  assert.equal(parseKeyboardActions([], 0, 0, 64, 8, 5000), null);
  assert.equal(parseKeyboardActions("Ctrl++P", 0, 0, 64, 8, 5000), null);
  assert.equal(parseKeyboardActions([{ key: "A", action: "tap" }], 0, 0, 64, 8, 5000), null);
  assert.equal(parseKeyboardActions([{ waitMs: 5001 }], 0, 0, 64, 8, 5000), null);
  assert.equal(parseKeyboardActions({ key: "A", action: "down" }, 0, 0, 64, 8, 5000), null);
});

test("human plan is deterministic, Unicode-scalar based, and corrects only neighbor-capable letters", () => {
  const first = buildHumanTypingPlan("Aa🙂。", 400, 100, 1234);
  const second = buildHumanTypingPlan("Aa🙂。", 400, 100, 1234);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
  assert.equal(first.delaysMs.length, 4);
  assert.deepEqual(first.mistakes.map((entry) => entry.index), [0, 1]);
  assert.ok(first.delaysMs[3] > first.delaysMs[2]);
  assert.ok(first.estimatedDurationMs >= first.delaysMs.reduce((sum, value) => sum + value, 0));
});
