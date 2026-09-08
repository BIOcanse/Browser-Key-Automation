import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHumanTypingPlan,
  canonicalKeyNameForVirtualKey,
  parseKeyboardActions,
  parseVirtualKeyboardEvents,
  resolveKeyboardKey,
} from "../../out/extension/background/keyboard-model.js";

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

test("raw virtual events preserve repeat, scan code, extended Enter and explicit loaded layout identity",()=>{
  const events=['down','repeat','up'].map(action=>({action,virtualKey:13,scanCode:28,extended:true,layout:'0000000004090409'}));
  const parsed=parseVirtualKeyboardEvents(events,3);
  assert.deepEqual(parsed.map(item=>item.kind),['down','repeat','up']);
  assert.deepEqual(parsed[1].keys[0],{virtualKey:13,scanCode:28,extended:true,layout:'0000000004090409'});
  assert.equal(canonicalKeyNameForVirtualKey(13,true),'NumpadEnter');assert.equal(resolveKeyboardKey('NumpadEnter').extended,true);
  for(const patch of [{scanCode:256},{virtualKey:0},{layout:'409'},{layout:'0000000000000000'},{extended:1},{action:'press'},{extra:true}])assert.equal(parseVirtualKeyboardEvents([{...events[0],...patch}],3),null);
  assert.equal(parseVirtualKeyboardEvents(events,2),null);
});

test("raw aggregate modifiers normalize to scan/extended sides before shared state",()=>{
  const raw=(virtualKey,scanCode,extended=false)=>({action:'down',virtualKey,scanCode,extended,layout:null});
  const parsed=parseVirtualKeyboardEvents([raw(17,29),raw(17,29,true),raw(18,56),raw(18,56,true),raw(16,42),raw(16,54)],6);
  assert.deepEqual(parsed.map(action=>action.keys[0].virtualKey),[0xa2,0xa3,0xa4,0xa5,0xa0,0xa1]);
  assert.equal(parseVirtualKeyboardEvents([raw(16,0)],1),null);
  assert.equal(parseVirtualKeyboardEvents([raw(16,42,true)],1),null);
});

test("recorded keyboard messages preserve Win32 flags and character units without becoming translated key events",()=>{
  const message=(id,value,lParam)=>({action:'message',message:id,value,lParam,layout:null});
  const parsed=parseVirtualKeyboardEvents([message(0x100,65,'001e0001'),message(0x102,97,'001e0001'),message(0x100,65,'401e0001'),message(0x101,65,'c01e0001'),message(0x102,0xd83d,'00000001'),message(0x102,0xde42,'00000001')],6);
  assert.deepEqual(parsed.map(item=>item.kind),Array(6).fill('message'));
  assert.deepEqual(parsed[3].message,{message:0x101,value:65,bits:0xc01e0001,layout:null});
  assert.equal(parsed[4].message.value,0xd83d);
  for(const patch of [{message:0x10},{value:256},{lParam:'ffffffffc01e0001'},{lParam:'invalid!'},{layout:'0'},{extra:true}])assert.equal(parseVirtualKeyboardEvents([{...message(0x100,65,'001e0001'),...patch}],1),null);
  assert.equal(parseVirtualKeyboardEvents([message(0x102,0x10000,'00000001')],1),null);
  assert.equal(parseVirtualKeyboardEvents([message(0x100,16,'00000001')],1),null);
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
