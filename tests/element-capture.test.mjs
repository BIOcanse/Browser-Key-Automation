import assert from "node:assert/strict";
import test from "node:test";
import { collectDocumentGeometry } from "../out/extension/background/capture/document-geometry.js";
import { alphaBounds, containRect, paintGeometryMask } from "../out/extension/background/capture/mask-image.js";
import { borderPath, clipPath, overflowPath, shapeLength } from "../out/extension/background/capture/shape-path.js";

class RecordedPath {
  operations = [];
  constructor(data) { if (data !== undefined) this.operations.push(["svg", data]); }
  addPath(...args) { this.operations.push(["add", ...args]); }
  roundRect(...args) { this.operations.push(["round", ...args]); }
  rect(...args) { this.operations.push(["rect", ...args]); }
  ellipse(...args) { this.operations.push(["ellipse", ...args]); }
  moveTo(...args) { this.operations.push(["move", ...args]); }
  lineTo(...args) { this.operations.push(["line", ...args]); }
  closePath() { this.operations.push(["close"]); }
}

function box(overrides = {}) {
  return { parent: -1, selected: true, visible: true, width: 200, height: 100, matrix: [1, 0, 0, 1, 0, 0],
    radii: ["0", "0", "0", "0"], border: [0, 0, 0, 0], padding: [0, 0, 0, 0],
    clipPath: "none", overflowX: false, overflowY: false, overflowEscape: null, svg: null, ...overrides };
}

function globals(values, run) {
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try { return run(); } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
}

function documentFixture(run) {
  const document = {};
  const styles = new Map();
  const nodeRef = `nr1.${"A".repeat(43)}`;
  const nodes = new Map();
  const element = (style = {}, parent = null, properties = {}) => {
    const item = { isConnected: true, ownerDocument: document, tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
      parentElement: parent, children: [], offsetWidth: 100, offsetHeight: 50, getRootNode: () => ({}),
      getBoundingClientRect: () => ({ x: 10, y: 20, width: 100, height: 50 }),
      getClientRects: () => ({ length: 1 }), getAttribute: () => null, ...properties };
    styles.set(item, { width: "100px", height: "50px", opacity: "1", display: "block", boxSizing: "border-box", ...style });
    if (parent) parent.children.push(item);
    return item;
  };
  return globals({ document, top: globalThis, innerWidth: 800, innerHeight: 600,
    getComputedStyle: (item) => styles.get(item), __BKA_DOM_NODE_REGISTRY_V1__: { nodes },
  }, () => run({ element, select(item) { nodes.set(nodeRef, { element: item, expiresAt: performance.now() + 60_000 }); },
    collect: (limits = {}) => collectDocumentGeometry(nodeRef, limits.nodes ?? 100, limits.depth ?? 20, limits.bytes ?? 100_000) }));
}

test("contain sizing centers the largest uniform fit and alpha bounds ignore transparent pixels", () => {
  assert.deepEqual(containRect(200, 100, 80, 80), { x: 0, y: 20, width: 80, height: 40 });
  assert.deepEqual(containRect(100, 200, 81, 81), { x: 20.25, y: 0, width: 40.5, height: 81 });
  const pixels = new Uint8ClampedArray(4 * 5 * 4);
  assert.equal(alphaBounds(pixels, 4, 5), null);
  pixels[(1 * 4 + 2) * 4 + 3] = 1;
  pixels[(3 * 4 + 1) * 4 + 3] = 255;
  assert.deepEqual(alphaBounds(pixels, 4, 5), { x: 1, y: 1, width: 2, height: 3 });
});

test("CSS shape paths preserve fill rules and normalize outer radii before insetting", () => globals({ Path2D: RecordedPath }, () => {
  assert.equal(shapeLength("calc(50% - 10px)", 100), 40);
  assert.throws(() => shapeLength("var(--unknown)", 100), { code: "ELEMENT_SCREENSHOT_FAILED" });
  const rounded = box({ radii: ["100px", "100px", "100px", "100px"], border: [5, 20, 0, 10], overflowX: true, overflowY: true });
  assert.deepEqual(borderPath(rounded).operations[0].at(-1), Array.from({ length: 4 }, () => ({ x: 50, y: 50 })));
  assert.deepEqual(overflowPath(rounded, 1000).operations[0], ["round", 10, 5, 170, 95,
    [{ x: 40, y: 45 }, { x: 30, y: 45 }, { x: 30, y: 50 }, { x: 40, y: 50 }]]);
  assert.equal(clipPath(box({ clipPath: "polygon(evenodd, 0 0, 100% 0, 50% 100%)" })).rule, "evenodd");
  assert.deepEqual(clipPath(box({ clipPath: "circle(25px at 50% 50%)" })).path.operations[0][1].operations[0],
    ["ellipse", 100, 50, 25, 25, 0, 0, Math.PI * 2]);
  assert.throws(() => clipPath(box({ clipPath: "url(#external-mask)" })), (error) => error.details.reason === "GEOMETRY_UNSUPPORTED");
}));

test("mask painting carries SVG fill/stroke styles and ancestor clips without painting ancestors", () => globals({ Path2D: RecordedPath }, () => {
  const calls = [];
  const context = { setTransform() {}, save() {}, restore() {}, clip: (...args) => calls.push(["clip", ...args]),
    fill(path, rule) { calls.push(["fill", rule]); },
    stroke() { calls.push(["stroke", this.lineWidth, this.lineCap, this.lineJoin, this.miterLimit]); } };
  const geometry = { viewport: { x: 0, y: 0, width: 800, height: 600 }, contentViewport: { x: 0, y: 0, width: 785, height: 600 }, rootIndex: 1,
    boxes: [box({ selected: false, visible: false, overflowX: true, overflowY: true }),
      box({ parent: 0, svg: { path: "M0 0L10 10Z", fill: true, fillRule: "evenodd", strokeWidth: 8,
        lineCap: "round", lineJoin: "bevel", miterLimit: 6, originX: 0, originY: 0 } })] };
  paintGeometryMask(context, geometry, 800, 600, { x: 0, y: 0, width: 20, height: 20 });
  assert.deepEqual(calls.filter(([kind]) => kind === "fill"), [["fill", "evenodd"]]);
  assert.deepEqual(calls.filter(([kind]) => kind === "stroke"), [["stroke", 8, "round", "bevel", 6]]);
  assert.equal(calls.filter(([kind]) => kind === "clip").length, 3);
}));

test("hidden branches are pruned before unsupported geometry, visible overrides remain", () => documentFixture(({ element, select, collect }) => {
  const root = element(); select(root);
  element({ display: "none", perspective: "500px", clipPath: "url(#unused)" }, root);
  element({ opacity: "0", maskImage: "url(x)" }, root);
  const hidden = element({ visibility: "hidden" }, root);
  element({ visibility: "visible" }, hidden);
  const result = collect();
  assert.equal(result.ok, true);
  assert.equal(result.geometry.boxes.length, 3);
  assert.deepEqual(result.geometry.boxes.map(({ visible }) => visible), [true, false, true]);
  assert.equal(collect({ nodes: 1 }).reason, "limit");
}));

test("unused hidden clips are skipped but still constrain visible descendants", () => globals({ Path2D: RecordedPath }, () =>
  documentFixture(({ element, select, collect }) => {
    const root = element(); select(root);
    const hidden = element({ visibility: "hidden", clipPath: "url(#unused)" }, root);
    let fills = 0;
    const context = { setTransform() {}, save() {}, restore() {}, clip() {}, fill() { fills += 1; } };
    const hiddenLeaf = collect();
    assert.equal(hiddenLeaf.ok, true);
    assert.deepEqual(hiddenLeaf.geometry.boxes.map(({ visible }) => visible), [true, false]);
    paintGeometryMask(context, hiddenLeaf.geometry, 800, 600, null);
    assert.equal(fills, 1);
    element({ visibility: "visible" }, hidden);
    const visibleOverride = collect();
    assert.equal(visibleOverride.ok, true);
    assert.throws(() => paintGeometryMask(context, visibleOverride.geometry, 800, 600, null),
      (error) => error.details.reason === "GEOMETRY_UNSUPPORTED" && error.details.feature === "clip-url");
  })));

test("content-visibility preserves its own box, prunes children; hidden ancestors give empty", () => documentFixture(({ element, select, collect }) => {
  const root = element({ contentVisibility: "hidden" });
  const child = element({ perspective: "100px" }, root);
  select(root);
  assert.equal(collect().geometry.boxes.length, 1);
  select(child);
  assert.deepEqual(collect(), { ok: false, reason: "empty", feature: "ancestor-contents" });
}));

test("SVG fill rule, caps, joins and miter limit survive collection", () => documentFixture(({ element, select, collect }) => {
  const root = element({ fillRule: "evenodd", stroke: "red", strokeWidth: "8px", strokeLinecap: "round",
    strokeLinejoin: "bevel", strokeMiterlimit: "6" }, null, { tagName: "path", namespaceURI: "http://www.w3.org/2000/svg",
    getBBox: () => ({ x: 0, y: 0, width: 100, height: 50 }),
    getScreenCTM: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), getAttribute: () => "M0 0L100 0L100 50Z" });
  select(root);
  const result = collect();
  assert.equal(result.ok, true);
  assert.deepEqual(result.geometry.boxes[0].svg, { path: "M0 0L100 0L100 50Z", fill: true, fillRule: "evenodd",
    strokeWidth: 8, lineCap: "round", lineJoin: "bevel", miterLimit: 6, originX: -4, originY: -4 });
}));
