import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { COMMAND_CATALOG } from "../../out/extension/generated/command-config.js";

// Execute the built, unmodified service and injected function; only Chrome/DOM boundaries are synthetic.
const source = readFileSync(new URL("../../out/extension/background/page-tree-service.js", import.meta.url), "utf8");
const body = source.slice(source.indexOf("const TREE_REF_PATTERN")).replaceAll("export ", "");
export const routePrefix = "browser-key-automation.page-tree-route.v1.";
export const syntheticRef = (letter) => `tr2.${letter.repeat(43)}`;
export const turn = () => new Promise((resolve) => setImmediate(resolve));
export function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
export function textNode(value) {
  return { nodeType: 3, nodeName: "#text", nodeValue: value, childNodes: [], parentNode: null, isConnected: true };
}
export function element(name, children = []) {
  const node = {
    nodeType: 1, nodeName: name, tagName: name, nodeValue: null, childNodes: children,
    parentNode: null, isConnected: true, attributes: [],
    hasAttribute() { return false; }, getAttribute() { return null; }, getAttributeNode() { return null; },
    matches(selector) { return selector.toLowerCase() === name.toLowerCase(); },
  };
  for (const child of children) child.parentNode = node;
  return node;
}
export function treeHarness(children, limits = {}) {
  const state = {
    stored: Object.create(null), committed: [], removed: [], replaced: [],
    frames: [{ frameId: 0, documentId: "fixture-document" }], documentId: "fixture-document",
    beforeRemove: null, beforeSet: null, afterProjection: null,
  };
  const document = {
    nodeType: 9, nodeName: "#document", nodeValue: null, childNodes: children,
    parentNode: null, isConnected: true, title: "synthetic operation tree",
    getElementById() { return null; },
    querySelector(selector) { if (selector === "[") throw new Error("invalid selector"); return null; },
  };
  for (const child of children) child.parentNode = document;
  const target = { tabId: 7, tabRef: "synthetic-tab", generation: "generation", url: "https://example.test/" };
  const context = vm.createContext({
    document, location: { href: target.url }, crypto: webcrypto,
    performance: { now: () => 10 }, TextEncoder, btoa,
    console: { warn() {} },
    COMMAND_CATALOG: { limits: { ...COMMAND_CATALOG.limits, ...limits } },
    isNodeRefShape: (value) => /^nr1\.[A-Za-z0-9_-]{43}$/.test(value),
    isDocumentRefShape: () => false, isTabRefShape: () => true,
    resolveTabTarget: async () => target, resolveCurrentTabTarget: async () => target,
    assertResolvedTabTarget() {}, assertScriptingTargetAvailable: async () => {},
    registerDocumentRef: () => `dr1.${"A".repeat(43)}`, registerNodeRefsForDocument() {},
    chrome: {
      storage: { session: {
        async get(key) { return key === null ? { ...state.stored } : { [key]: state.stored[key] }; },
        async set(records) { await state.beforeSet?.(records); Object.assign(state.stored, records); },
        async remove(keys) { await state.beforeRemove?.(keys); for (const key of keys) delete state.stored[key]; },
      } },
      tabs: {
        onRemoved: { addListener: (listener) => state.removed.push(listener) },
        onReplaced: { addListener: (listener) => state.replaced.push(listener) },
      },
      webNavigation: {
        async getAllFrames() { return state.frames; },
        onCommitted: { addListener: (listener) => state.committed.push(listener) },
      },
      scripting: { async executeScript(injection) {
        const documentId = state.documentId;
        // Observed Chromium scripting conversion omits null object members, but preserves array positions.
        const args = JSON.parse(JSON.stringify(injection.args, (_key, value) => value === null ? undefined : value));
        const result = injection.func(...args);
        await state.afterProjection?.(injection, result);
        return [{ frameId: 0, documentId, result }];
      } },
    },
  });
  vm.runInContext(`${body}\nglobalThis.api={openPageTree,getPageTreeView,expandPageTree,findPageTree};`, context);
  const api = context.api;
  return {
    api, context, document, state,
    open: (key = "A") => api.openPageTree(target.tabRef, key),
    view: (rootRef, request = {}, key = "A") => api.getPageTreeView(key, { rootRef, ...request }),
    find: (rootRef, request = {}, key = "A") => api.findPageTree(key, { rootRef, limit: 256, ...request }),
    expand: (treeRef, key = "A") => api.expandPageTree(treeRef, key),
    routeCount: () => Object.keys(state.stored).filter((key) => key.startsWith(routePrefix)).length,
  };
}
