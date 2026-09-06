import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { runDomPointerDocument, executeDomPointer } from "../../out/extension/background/dom-pointer-service.js";
import { registerDocumentRef, registerNodeRefsForDocument } from "../../out/extension/background/dom-service.js";

function fixture() {
  const events = [], handlers = new Map();
  class SyntheticEvent {
    constructor(type, init) { Object.assign(this, init); this.type = type; this.isTrusted = false; this.defaultPrevented = false; }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  }
  class DataTransfer {
    dropEffect = "none"; effectAllowed = "none"; data = new Map();
    setData(type, value) { this.data.set(type, value); }
    getData(type) { return this.data.get(type) ?? ""; }
  }
  const dispatch = (target, event) => {
    events.push({ target: target.id, event });
    handlers.get(`${target.id}:${event.type}`)?.(event);
    return !event.defaultPrevented;
  };
  const document = { id: "document", dispatchEvent(event) { return dispatch(this, event); }, elementFromPoint: (x) => x < 120 ? source : target };
  const element = (id, x, width = 100) => ({
    id, isConnected: true, ownerDocument: document, parentElement: null, shadowRoot: null,
    getRootNode: () => document, getAttribute: () => null, matches: () => false,
    getBoundingClientRect: () => ({ x, y: 10, width, height: 100 }), getClientRects: () => [1],
    dispatchEvent(event) { return dispatch(this, event); },
  });
  const root = element("root", 0, 400), source = element("source", 10), target = element("target", 160);
  source.parentElement = root; target.parentElement = root;
  const registry = new Map([["source", { element: source, expiresAt: 100 }], ["target", { element: target, expiresAt: 100 }]]);
  const context = vm.createContext({
    Event: SyntheticEvent, PointerEvent: SyntheticEvent, MouseEvent: SyntheticEvent, DragEvent: SyntheticEvent, DataTransfer,
    document, innerWidth: 400, innerHeight: 300, performance: { now: () => 1 },
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    __BKA_DOM_NODE_REGISTRY_V1__: { nodes: registry },
  });
  vm.runInContext(`globalThis.run = ${runDomPointerDocument.toString()};`, context);
  const run = (request, bound = 256) => context.run(request, bound);
  const hover = (params = {}) => run({ kind: "hover", nodeRef: "source", offset: null, phase: "enter", ...params });
  const drag = (params = {}) => run({ kind: "drag", nodeRef: "source", toNodeRef: "target", mode: "pointer", steps: 3, fromOffset: null, toOffset: null, ...params });
  return { events, handlers, document, source, target, root, registry, context, run, hover, drag };
}

test("stateless hover has explicit enter/leave sequences, ancestor semantics and untrusted events", () => {
  const f = fixture(), entered = f.hover();
  assert.equal(entered.ok, true); assert.equal(entered.eventCount, f.events.length);
  assert.deepEqual(f.events.map(({ target, event }) => `${target}:${event.type}`), [
    "source:pointerover", "source:mouseover", "root:pointerenter", "root:mouseenter",
    "source:pointerenter", "source:mouseenter", "source:pointermove", "source:mousemove",
  ]);
  assert.ok(f.events.every(({ event }) => !event.isTrusted && event.clientX === 60 && event.clientY === 60));
  assert.equal(f.events[2].event.bubbles, false); assert.equal(f.events[2].event.cancelable, false);
  f.events.length = 0;
  assert.equal(f.hover({ phase: "leave", offset: { x: 0, y: 0 } }).ok, true);
  assert.deepEqual(f.events.map(({ event }) => event.type), ["pointerout", "mouseout", "pointerleave", "mouseleave", "pointerleave", "mouseleave"]);
  assert.ok(f.events.every(({ event }) => event.clientX === 10 && event.clientY === 10));
});

test("both endpoints are validated before input: stale, disabled, hidden, offscreen, covered, invalid offsets and ancestry", () => {
  const cases = [
    ["target_stale", (f) => { f.target.isConnected = false; }],
    ["target_stale", (f) => { f.target.ownerDocument = {}; }],
    ["target_stale", (f) => { f.registry.get("target").expiresAt = 0; }],
    ["target_disabled", (f) => { f.target.matches = () => true; }],
    ["target_disabled", (f) => { f.target.getAttribute = () => "true"; }],
    ["target_not_visible", (f) => { f.target.getClientRects = () => []; }],
    ["point_outside_viewport", (f) => { f.context.innerWidth = 200; }],
    ["target_obstructed", (f) => { f.document.elementFromPoint = () => f.root; }],
    ["ancestor_limit", (f) => { f.root.parentElement = f.source; }],
  ];
  for (const [reason, mutate] of cases) {
    const f = fixture(); mutate(f);
    assert.equal(f.drag().reason, reason, reason); assert.equal(f.events.length, 0, reason);
  }
  const offset = fixture(); assert.equal(offset.drag({ toOffset: { x: 100, y: 20 } }).reason, "offset_outside_element");
  assert.equal(offset.events.length, 0);
  const bound = fixture();
  assert.equal(bound.run({ kind: "hover", nodeRef: "source", phase: "enter", offset: null }, 1).reason, "ancestor_limit");
  assert.equal(bound.events.length, 0);
});

test("pointer drag accepts distinct positions within one element and ends with released buttons", () => {
  const f = fixture(); f.document.elementFromPoint = () => f.source;
  const result = f.drag({ toNodeRef: "source", fromOffset: { x: 2, y: 3 }, toOffset: { x: 82, y: 63 }, steps: 4 });
  assert.equal(result.ok, true);
  const moves = f.events.filter(({ event }) => event.type === "pointermove");
  assert.equal(moves.length, 4);
  assert.deepEqual(moves.map(({ event }) => [event.clientX, event.clientY, event.buttons]), [
    [32, 28, 1], [52, 43, 1], [72, 58, 1], [92, 73, 1],
  ]);
  assert.deepEqual(f.events.slice(-2).map(({ event }) => [event.type, event.buttons]), [["pointerup", 0], ["mouseup", 0]]);
  assert.equal(f.events.some(({ event }) => event.type === "click"), false);
});

test("canceling pointerdown suppresses compatibility mouse input but preserves pointer release", () => {
  const f = fixture(); f.handlers.set("source:pointerdown", (event) => event.preventDefault());
  assert.equal(f.drag().ok, true);
  assert.equal(f.events.some(({ event }) => ["mousedown", "mouseup", "mousemove"].includes(event.type)), false);
  assert.equal(f.events.at(-1).event.type, "pointerup");
});

test("HTML5 drag shares DataTransfer, bubbles enter/over/drop and respects start/drop cancellation", () => {
  const f = fixture(); let dropped;
  f.handlers.set("source:dragstart", (event) => event.dataTransfer.setData("text/plain", "payload"));
  f.handlers.set("target:dragover", (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; });
  f.handlers.set("target:drop", (event) => { dropped = event.dataTransfer.getData("text/plain"); });
  assert.equal(f.drag({ mode: "html5" }).canceledAt, null);
  assert.equal(dropped, "payload");
  assert.equal(new Set(f.events.map(({ event }) => event.dataTransfer)).size, 1);
  assert.equal(f.events.every(({ event }) => event.bubbles), true);
  assert.equal(f.events[0].event.type, "dragstart"); assert.equal(f.events.at(-1).event.type, "dragend");
  assert.equal(f.events.at(-1).event.cancelable, false);

  const startCanceled = fixture(); startCanceled.handlers.set("source:dragstart", (event) => event.preventDefault());
  assert.equal(startCanceled.drag({ mode: "html5" }).canceledAt, "dragstart");
  assert.equal(startCanceled.events.length, 1);
  const dropRejected = fixture();
  const rejectedResult = dropRejected.drag({ mode: "html5" });
  assert.equal(rejectedResult.canceledAt, "dragover");
  assert.equal(rejectedResult.eventCount, dropRejected.events.length, "include final dragleave and dragend");
  assert.equal(dropRejected.events.some(({ event }) => event.type === "drop"), false);
  assert.equal(dropRejected.events.at(-1).event.dataTransfer.dropEffect, "none");
});

test("target removal after down stops the sequence and emits bounded cancel/release cleanup", () => {
  const f = fixture(); f.handlers.set("source:pointerdown", () => { f.source.isConnected = false; });
  const result = f.drag();
  assert.equal(result.reason, "target_stale"); assert.ok(result.eventCount > 0);
  assert.equal(f.events.some(({ event }) => event.type === "mousedown"), false);
  assert.deepEqual(f.events.slice(-2).map(({ target, event }) => [target, event.type, event.buttons]), [
    ["document", "pointercancel", 0], ["document", "mouseup", 0],
  ]);
});

test("listener removal stops hover leave and in-step HTML5 actions, without suppressing cleanup", () => {
  const leaving = fixture(); leaving.handlers.set("source:pointerout", () => { leaving.source.isConnected = false; });
  const leaveResult = leaving.hover({ phase: "leave" });
  assert.equal(leaveResult.reason, "target_stale"); assert.equal(leaveResult.eventCount, 1);
  assert.deepEqual(leaving.events.map(({ event }) => event.type), ["pointerout"]);
  const dragging = fixture(); dragging.handlers.set("source:drag", () => { dragging.target.isConnected = false; });
  const dragResult = dragging.drag({ mode: "html5", steps: 1 });
  assert.equal(dragResult.reason, "target_stale");
  assert.equal(dragging.events.some(({ event }) => ["dragenter", "dragover", "drop"].includes(event.type)), false);
  assert.equal(dragging.events.at(-1).event.type, "dragend");
  assert.equal(dragResult.eventCount, dragging.events.length);
  const releasing = fixture(); releasing.handlers.set("target:pointerup", () => { releasing.target.isConnected = false; });
  assert.equal(releasing.drag().ok, true);
  assert.equal(releasing.events.at(-1).target, "document");
  assert.equal(releasing.events.at(-1).event.type, "mouseup", "release cleanup survives endpoint removal on pointerup");
});

test("service rejects cross-document endpoints before Chromium injection", async () => {
  const tabRef = `tr1.${"A".repeat(22)}.1.${"B".repeat(22)}`;
  const sourceRef = `nr1.${"S".repeat(43)}`, targetRef = `nr1.${"T".repeat(43)}`;
  const first = registerDocumentRef(tabRef, 1, 0, "pointer-source");
  const second = registerDocumentRef(tabRef, 1, 1, "pointer-target");
  registerNodeRefsForDocument(first, [sourceRef]); registerNodeRefsForDocument(second, [targetRef]);
  await assert.rejects(executeDomPointer({ kind: "drag", nodeRef: sourceRef, toNodeRef: targetRef, mode: "pointer", steps: 2, fromOffset: null, toOffset: null }),
    (error) => error.code === "DOM_OPERATION_FAILED" && error.details.reason === "different_documents" && error.details.commandMayHaveRun === false);
});
