import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { resolveLocatorFrameSnapshot } from "../out/extension/background/dom-service.js";

const source = readFileSync(new URL("../out/extension/background/dom-service.js", import.meta.url), "utf8");
const actionSource = source.slice(source.indexOf("function runNodeAction("), source.indexOf("function requiredDocument("));
const realPrepareSource = source.slice(
  source.indexOf("function prepareRealClickDocument("),
  source.indexOf("function restoreRealClickDocumentTitle("),
);
const observeTargetSource = source.slice(
  source.indexOf("function observeTargetDocument("),
  source.indexOf("function searchScrollDocument("),
);
const searchScrollSource = source.slice(
  source.indexOf("function searchScrollDocument("),
  source.indexOf("function runNodeAction("),
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

test("DOM text insertion replaces only the current input selection and advances the caret", () => {
  const state = { events: [] };
  const document = {
    activeElement: null,
    createTreeWalker(element) { let sent = false; return { nextNode() {
      if (sent) return null; sent = true; return { nodeValue: element.textContent };
    } }; },
    getSelection: () => null,
  };
  const element = {
    tagName: "INPUT", id: "field", classList: [], textContent: "", isConnected: true,
    ownerDocument: document, isContentEditable: false, value: "abcd", selectionStart: 1, selectionEnd: 3,
    disabled: false, contains: () => false, getAttribute: () => null,
    matches(selector) { return selector === ":focus" ? document.activeElement === element : false; },
    focus() { document.activeElement = element; },
    setRangeText(value, start, end) {
      this.value = this.value.slice(0, start) + value + this.value.slice(end);
      this.selectionStart = start + value.length; this.selectionEnd = this.selectionStart;
    },
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 20 }),
    dispatchEvent(event) { state.events.push(event); return true; },
  };
  class InputEvent extends Event { constructor(type, init) { super(type, init); this.inputType = init.inputType; this.data = init.data; } }
  const context = vm.createContext({
    document, Event, InputEvent, performance: { now: () => 1 }, NodeFilter: { SHOW_TEXT: 4 },
    __BKA_DOM_NODE_REGISTRY_V1__: { nodes: new Map([["node", { element, expiresAt: 100 }]]) },
  });
  vm.runInContext(`${actionSource}\nglobalThis.run = runNodeAction;`, context);
  const result = context.run("node", "insertText", { text: "XY" }, 256);
  assert.equal(result.ok, true);
  assert.equal(element.value, "aXYd");
  assert.equal(element.selectionStart, 3);
  assert.deepEqual(state.events.map((event) => event.type), ["beforeinput", "input"]);
  assert.equal(state.events.every((event) => event.isTrusted === false), true);
  assert.equal(result.descriptor.value, "aXYd");
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

function observationFixture() {
  const state = { token: 1, hit: null };
  const elements = [];
  const document = {
    documentElement: null,
    activeElement: null,
    createTreeWalker(root, whatToShow) {
      if (whatToShow === 1) {
        let index = elements.indexOf(root) + 1;
        return { nextNode() { return index < elements.length ? elements[index++] : null; } };
      }
      let sent = false;
      return { nextNode() { if (sent) return null; sent = true; return { nodeValue: root.textContent }; } };
    },
    elementFromPoint: () => state.hit,
    getElementById(id) { return elements.find((element) => element.id === id) ?? null; },
  };
  const make = ({ tagName = "DIV", id = "", text = "", attributes = {}, rect = { x: 10, y: 10, width: 80, height: 30 } } = {}) => {
    const normalized = { ...rect, left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height };
    const element = {
      tagName, id, classList: [], textContent: text, isConnected: true, ownerDocument: document,
      labels: [], options: undefined, value: undefined, shadowRoot: null,
      getAttribute(name) { return Object.hasOwn(attributes, name) ? attributes[name] : null; },
      getBoundingClientRect: () => normalized,
      getClientRects: () => [normalized],
      matches(selector) {
        if (selector === ":disabled") return attributes.disabled === "true";
        if (selector === "button") return tagName === "BUTTON";
        if (selector === "#save") return id === "save";
        if (selector === "[") throw new Error("bad selector");
        return false;
      },
      contains(node) { return node === element; },
    };
    elements.push(element);
    return element;
  };
  const context = vm.createContext({
    document,
    innerWidth: 200,
    innerHeight: 120,
    performance: { now: () => 1 },
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4 },
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    crypto: { getRandomValues(bytes) { bytes.fill(state.token++); return bytes; } },
    btoa,
  });
  vm.runInContext(`${observeTargetSource}\nglobalThis.observeTarget = observeTargetDocument;`, context);
  return {
    state, elements, document, make, context,
    run(locator, exact = null, maximum = 100) { return context.observeTarget(exact, locator, maximum, 100, 1000, 256); },
  };
}

test("ensure locator traversal is bounded, deterministic, and never guesses through ambiguity", () => {
  const h = observationFixture();
  const root = h.make({ tagName: "HTML", id: "poison" }); h.document.documentElement = root;
  const first = h.make({ tagName: "BUTTON", id: "save", text: "Save" });
  const originalTreeWalker = h.document.createTreeWalker;
  let rejectPoisonNameScan = true;
  h.document.createTreeWalker = (element, whatToShow) => {
    if (rejectPoisonNameScan && whatToShow === 4 && element.id === "poison") throw new Error("name work must follow selector/role matching");
    return originalTreeWalker(element, whatToShow);
  };
  h.state.hit = first;
  const locator = { selector: "button", role: "button", name: "Save", nameMatch: "exact", match: "unique" };
  const matched = h.run(locator);
  rejectPoisonNameScan = false;
  assert.equal(matched.status, "matched");
  assert.equal(matched.visible, true);
  assert.equal(matched.enabled, true);
  assert.equal(matched.unobstructed, true);
  assert.match(matched.nodeRef, /^nr1\./u);
  const bridgedNull = h.run({ selector: "#save", role: "button", name: undefined, nameMatch: "exact", match: "unique" });
  assert.equal(bridgedNull.status, "matched", "the Chromium injection bridge may surface nested null as undefined");
  assert.equal(h.run(null, matched.nodeRef).nodeRef, matched.nodeRef, "exact observation preserves identity");

  h.make({ tagName: "BUTTON", text: "Save" });
  assert.equal(h.run(locator).status, "ambiguous");
  assert.equal(h.run({ ...locator, match: "first" }).nodeRef, matched.nodeRef);
  assert.equal(h.run({ ...locator, selector: "[" }).status, "selector");
  assert.equal(h.run({ ...locator, selector: null, role: null, name: "missing" }, null, 1).status, "scan_limit");
  first.isConnected = false;
  assert.equal(h.run(null, matched.nodeRef).status, "stale");
});

function searchScrollFixture() {
  const element = (height, viewport, top = 0) => ({
    isConnected: true,
    scrollHeight: height,
    clientHeight: viewport,
    scrollTop: top,
    getBoundingClientRect: () => ({ width: 300, height: viewport }),
    style: { display: "block", visibility: "visible", overflowY: "auto" },
  });
  const root = element(100, 100);
  const first = element(300, 100);
  const second = element(220, 100);
  const page = element(500, 100);
  const elements = [root, first, second];
  const document = {
    documentElement: root,
    body: null,
    scrollingElement: page,
    createTreeWalker(start) {
      let index = elements.indexOf(start) + 1;
      return { nextNode() { return index < elements.length ? elements[index++] : null; } };
    },
  };
  const context = vm.createContext({
    document,
    NodeFilter: { SHOW_ELEMENT: 1 },
    getComputedStyle: (current) => current.style,
  });
  vm.runInContext(`${searchScrollSource}\nglobalThis.searchScroll = searchScrollDocument;`, context);
  return {
    root,
    first,
    second,
    page,
    replaceFirst(replacement) { elements[1] = replacement; },
    makeElement: element,
    run: (cursor = 0, maximumScanNodes = 100, maximumContexts = 32, expectedTopologyToken = null) =>
      context.searchScroll(80, cursor, maximumScanNodes, maximumContexts, expectedTopologyToken),
  };
}

test("ensure search scrolls one bounded nested context at a time before the document root", () => {
  const h = searchScrollFixture();
  const first = h.run();
  assert.deepEqual({ ...first }, {
    moved: true, nextCursor: 1, contextKind: "element", contextCount: 3, scanTruncated: false,
    topologyToken: first.topologyToken,
  });
  assert.equal(h.first.scrollTop, 80);
  assert.equal(h.second.scrollTop, 0);
  assert.equal(h.page.scrollTop, 0);

  const second = h.run(first.nextCursor, 100, 32, first.topologyToken);
  assert.equal(second.contextKind, "element");
  assert.equal(h.second.scrollTop, 80);
  h.first.scrollTop = 200;
  h.second.scrollTop = 120;
  const page = h.run(0);
  assert.equal(page.contextKind, "document");
  assert.equal(h.page.scrollTop, 80);
});

test("ensure scroll discovery refuses partial scans and terminates when every context is exhausted", () => {
  const truncated = searchScrollFixture().run(0, 1);
  assert.equal(truncated.scanTruncated, true);
  assert.equal(truncated.moved, false);

  const h = searchScrollFixture();
  h.first.scrollTop = 200;
  h.second.scrollTop = 120;
  h.page.scrollTop = 400;
  const exhausted = h.run();
  assert.deepEqual({ ...exhausted }, {
    moved: false, nextCursor: 0, contextKind: null, contextCount: 3, scanTruncated: false,
    topologyToken: exhausted.topologyToken,
  });
});

test("ensure scroll cursor restarts when a same-size virtual-list topology is replaced", () => {
  const h = searchScrollFixture();
  const initial = h.run();
  const replacement = h.makeElement(360, 100);
  h.replaceFirst(replacement);
  const afterReplacement = h.run(initial.nextCursor, 100, 32, initial.topologyToken);
  assert.equal(afterReplacement.contextKind, "element");
  assert.equal(replacement.scrollTop, 80, "topology change restarts at the first live scroll context");
  assert.equal(h.second.scrollTop, 0);
  assert.notEqual(afterReplacement.topologyToken, initial.topologyToken);
});

test("framePath resolves direct children deeply and makes unique, first and candidate bounds explicit", () => {
  const frames = [
    { frameId: 0, parentFrameId: -1, documentId: "main", url: "https://root.test/" },
    { frameId: 9, parentFrameId: 0, documentId: "late", url: "https://child.test/widget" },
    { frameId: 3, parentFrameId: 0, documentId: "first", url: "https://child.test/widget" },
    { frameId: 4, parentFrameId: 3, documentId: "deep", url: "https://deep.test/form" },
    { frameId: 5, parentFrameId: 9, documentId: "wrong-parent", url: "https://deep.test/form" },
  ];
  assert.throws(
    () => resolveLocatorFrameSnapshot(frames, [{ urlPattern: "https://child.test/*", match: "unique" }], 10),
    (error) => error.code === "TARGET_AMBIGUOUS",
  );
  const deep = resolveLocatorFrameSnapshot(frames, [
    { urlPattern: "https://child.test/*", match: "first" },
    { urlPattern: "https://deep.test/*", match: "unique" },
  ], 10);
  assert.equal(deep.documentId, "deep", "first means the lowest current Chromium frameId, then traversal stays direct-child scoped");
  assert.throws(
    () => resolveLocatorFrameSnapshot(frames, [{ urlPattern: "*", match: "first" }], 4),
    (error) => error.code === "LIMIT_EXCEEDED",
  );
  assert.equal(resolveLocatorFrameSnapshot(frames, [{ urlPattern: "https://missing.test/*", match: "unique" }], 10), null);
});
