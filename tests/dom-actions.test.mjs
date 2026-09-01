import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../out/extension/background/dom-service.js", import.meta.url), "utf8");
const actionSource = source.slice(source.indexOf("function runNodeAction("), source.indexOf("function requiredDocument("));
const realPrepareSource = source.slice(
  source.indexOf("function prepareRealClickDocument("),
  source.indexOf("function restoreRealClickDocumentTitle("),
);
function fixture() {
  const state = { clicks: 0, events: [] };
  const document = { createTreeWalker(element) { let sent = false; return { nextNode() {
    if (sent) return null; sent = true; return { nodeValue: element.textContent };
  } }; } };
  const element = { tagName: "DIV", id: "fixture", classList: [], textContent: "before", isConnected: true,
    ownerDocument: document, isContentEditable: true, disabled: false,
    click() { state.clicks += 1; }, matches: () => false, getAttribute: () => null,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
    dispatchEvent(event) { state.events.push(event); return true; },
  };
  class InputEvent extends Event { constructor(type, init) { super(type, init); this.inputType = init.inputType; this.data = init.data; } }
  const context = vm.createContext({ document, Event, InputEvent, performance: { now: () => 1 }, NodeFilter: { SHOW_TEXT: 4 },
    __BKA_DOM_NODE_REGISTRY_V1__: { nodes: new Map([["node", { element, expiresAt: 100 }]]) },
  });
  vm.runInContext(`${actionSource}\nglobalThis.run = runNodeAction;`, context);
  return { state, element, run: (action, payload = {}) => context.run("node", action, payload, 256) };
}

test("disconnected/adopted nodes fail before actions and inherited disabled controls cannot click", () => {
  const detached = fixture(); detached.element.isConnected = false;
  assert.equal(detached.run("click").reason, "stale"); assert.equal(detached.state.clicks, 0);
  const adopted = fixture(); adopted.element.ownerDocument = {};
  assert.equal(adopted.run("click").reason, "stale"); assert.equal(adopted.state.clicks, 0);
  const disabled = fixture(); disabled.element.matches = (selector) => selector === ":disabled";
  assert.equal(disabled.run("click").reason, "action"); assert.equal(disabled.state.clicks, 0);
  assert.equal(disabled.run("describe").descriptor.disabled, true);
});

test("contenteditable replacement is plaintext and emits an untrusted input event", () => {
  const editable = fixture();
  const result = editable.run("setValue", { value: "<b>plain</b>" });
  assert.equal(result.ok, true); assert.equal(editable.element.textContent, "<b>plain</b>");
  assert.equal(result.descriptor.text, "<b>plain</b>");
  assert.equal(editable.state.events.length, 1); assert.equal(editable.state.events[0].type, "input");
  assert.equal(editable.state.events[0].isTrusted, false);
  assert.equal(editable.state.events[0].inputType, "insertReplacementText");
});

function realFixture() {
  const state = { scrolls: 0 };
  const document = { title: "original", elementFromPoint: () => element };
  const element = {
    isConnected: true,
    ownerDocument: document,
    matches: () => false,
    contains: () => false,
    getClientRects: () => [{ left: 10, top: 20, right: 110, bottom: 80 }],
    scrollIntoView: () => { state.scrolls += 1; },
    shadowRoot: null,
  };
  const context = vm.createContext({
    document,
    innerWidth: 200,
    innerHeight: 120,
    performance: { now: () => 1 },
    __BKA_DOM_NODE_REGISTRY_V1__: { nodes: new Map([["node", { element, expiresAt: 100 }]]) },
  });
  vm.runInContext(`${realPrepareSource}\nglobalThis.runReal = prepareRealClickDocument;`, context);
  return { state, document, element, context, run: (scroll = true) => context.runReal("node", scroll, "BKA real marker") };
}

test("real click preparation changes no input and requires one visible unobstructed live point", () => {
  const ready = realFixture();
  const result = ready.run(false);
  assert.equal(result.ok, true);
  assert.deepEqual({ ...result.point }, { x: 60, y: 50 });
  assert.deepEqual({ ...result.viewport }, { width: 200, height: 120 });
  assert.equal(result.originalTitle, "original");
  assert.equal(ready.document.title, "BKA real marker");
  assert.equal(ready.state.scrolls, 0);

  const scrolling = realFixture();
  assert.equal(scrolling.run(true).ok, true);
  assert.equal(scrolling.state.scrolls, 1);

  const detached = realFixture(); detached.element.isConnected = false;
  assert.equal(detached.run().reason, "stale"); assert.equal(detached.document.title, "original");
  const disabled = realFixture(); disabled.element.matches = (selector) => selector === ":disabled";
  assert.equal(disabled.run().reason, "disabled"); assert.equal(disabled.document.title, "original");
  const layoutless = realFixture(); layoutless.element.getClientRects = () => [];
  assert.equal(layoutless.run().reason, "layoutless"); assert.equal(layoutless.document.title, "original");
  const obstructed = realFixture(); obstructed.document.elementFromPoint = () => ({ shadowRoot: null });
  assert.equal(obstructed.run().reason, "obstructed"); assert.equal(obstructed.document.title, "original");
});
