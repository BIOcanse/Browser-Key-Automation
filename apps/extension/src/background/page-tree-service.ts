import { COMMAND_CATALOG } from "../generated/command-config.js";
import { assertScriptingTargetAvailable } from "./browser-service.js";
import { CapabilityUnavailableError } from "./capability-error.js";
import {
  isDocumentRefShape,
  isNodeRefShape,
  registerDocumentRef,
  registerNodeRefsForDocument,
  resolveDocumentRefTarget,
} from "./dom-service.js";
import {
  assertResolvedTabTarget,
  isTabRefShape,
  resolveCurrentTabTarget,
  resolveTabTarget,
} from "./tab-service.js";

const TREE_REF_PATTERN = /^tr2\.[A-Za-z0-9_-]{43}$/u;
const TREE_ROUTE_STORAGE_PREFIX = "browser-key-automation.page-tree-route.v1.";
let routeStorageTail: Promise<unknown> = Promise.resolve();

function inRouteStorageOrder<T>(operation: () => Promise<T>): Promise<T> {
  const result = routeStorageTail.then(operation);
  routeStorageTail = result.catch(() => undefined);
  return result;
}

export type PageTreeItemKind =
  | "attribute"
  | "cdata"
  | "comment"
  | "doctype"
  | "document"
  | "document_fragment"
  | "element"
  | "processing_instruction"
  | "property"
  | "shadow_root"
  | "text"
  | "unavailable"
  | "value_chunk";

export interface PageTreeViewItem {
  readonly kind: PageTreeItemKind;
  readonly name: string | null;
  readonly namespace: string | null;
  readonly role: string | null;
  readonly label: string | null;
  readonly valuePreview: string | null;
  readonly valueTruncated: boolean;
  readonly states: readonly string[];
  readonly attributeCount: number;
  readonly childCount: number;
  readonly sourceOrder: number;
  readonly nodeRef: string | null;
  readonly treeRef: string | null;
  readonly indexPath: readonly number[];
  readonly level: number;
  readonly expanded: boolean;
}

export interface PageTreeOpenResult {
  readonly tabRef: string;
  readonly documentRef: string;
  readonly frameId: number;
  readonly url: string;
  readonly title: string;
  readonly rootRef: string;
  readonly reused: boolean;
  readonly limitations: readonly string[];
}

export interface PageTreeExpandResult {
  readonly tabRef: string;
  readonly documentRef: string;
  readonly rootRef: string;
  readonly treeRef: string;
  readonly expanded: true;
}

export interface PageTreeSiblingRange {
  readonly from: readonly number[];
  readonly toExclusive: readonly number[];
}

export interface PageTreeViewRequest {
  readonly rootRef: string;
  readonly maximumLevel?: number;
  readonly range?: PageTreeSiblingRange;
  readonly subtree?: readonly number[];
}

export interface PageTreeViewResult {
  readonly tabRef: string;
  readonly documentRef: string;
  readonly rootRef: string;
  readonly items: readonly PageTreeViewItem[];
  readonly truncated: boolean;
  readonly nextIndexPath: readonly number[] | null;
}

export interface PageTreeFindRequest {
  readonly rootRef: string;
  readonly text?: string;
  readonly role?: string;
  readonly selector?: string;
  readonly subtree?: readonly number[];
  readonly from?: readonly number[];
  readonly limit: number;
}

interface PageTreeTarget {
  readonly rootRef: string;
  readonly tabId: number;
  readonly frameId: number;
  readonly documentId: string;
}

interface RoutedTreeCandidate {
  readonly treeRef: string;
  readonly target: PageTreeTarget;
}

interface PageTreeLimits {
  readonly maximumIndexDepth: number;
  readonly maximumLabelScanNodes: number;
  readonly maximumPreviewCharacters: number;
  readonly maximumTreeRefs: number;
  readonly maximumViewItems: number;
  readonly maximumViewScanNodes: number;
  readonly maximumFindScanNodes: number;
  readonly maximumNodeRefs: number;
  readonly nodeReferenceTtlMs: number;
  readonly maximumResultBytes: number;
  readonly maximumUrlBytes: number;
}

interface NormalizedPageTreeViewRequest {
  readonly maximumLevel: number | null;
  readonly range: PageTreeSiblingRange | null;
  readonly subtree: readonly number[] | null;
}

type PageTreeProjection =
  | {
      readonly ok: true;
      readonly operation: "open";
      readonly url: string;
      readonly title: string;
      readonly rootRef: string;
      readonly reused: boolean;
      readonly limitations: readonly string[];
    }
  | {
      readonly ok: true;
      readonly operation: "expand";
      readonly rootRef: string;
      readonly treeRef: string;
      readonly expanded: true;
    }
  | {
      readonly ok: true;
      readonly operation: "view" | "find";
      readonly rootRef: string;
      readonly items: readonly PageTreeViewItem[];
      readonly truncated: boolean;
      readonly nextIndexPath: readonly number[] | null;
    }
  | { readonly ok: false; readonly reason: "capacity" | "stale" | "unexpected" };

interface PageTreeProjectionEnvelope {
  readonly projection: PageTreeProjection;
  readonly retiredTreeRefs: readonly string[];
}

export class PageTreeServiceError extends Error {
  readonly code: "DOM_OPERATION_FAILED" | "LIMIT_EXCEEDED" | "STORAGE_UNAVAILABLE" | "TARGET_REF_STALE";

  constructor(code: PageTreeServiceError["code"], message: string) {
    super(message);
    this.name = "PageTreeServiceError";
    this.code = code;
  }
}

function limit(pointId: string): number {
  const value = COMMAND_CATALOG.limits[pointId as keyof typeof COMMAND_CATALOG.limits];
  if (typeof value !== "number") throw new Error(`Missing generated integer Freedom Point: ${pointId}`);
  return value;
}

function resolvedLimits(): PageTreeLimits {
  return {
    maximumIndexDepth: limit("command.page.tree.maximum_index_depth"),
    maximumLabelScanNodes: limit("command.page.tree.maximum_label_scan_nodes"),
    maximumPreviewCharacters: limit("command.page.tree.maximum_preview_characters"),
    maximumTreeRefs: limit("command.page.tree.maximum_refs_per_document"),
    maximumViewItems: limit("command.page.tree.maximum_view_items"),
    maximumViewScanNodes: limit("command.page.tree.maximum_view_scan_nodes"),
    maximumFindScanNodes: limit("command.page.tree.maximum_find_scan_nodes"),
    maximumNodeRefs: limit("command.dom.maximum_node_refs_per_document"),
    nodeReferenceTtlMs: limit("command.dom.reference_ttl_ms"),
    maximumResultBytes: limit("command.inline.maximum_result_json_bytes") - 1024,
    maximumUrlBytes: limit("command.tabs.maximum_text_bytes"),
  };
}

export function isPageTreeRefShape(value: unknown): value is string {
  return typeof value === "string" && TREE_REF_PATTERN.test(value);
}

function isStoredTreeTarget(value: unknown): value is PageTreeTarget {
  if (typeof value !== "object" || value === null) return false;
  const target = value as Partial<PageTreeTarget>;
  return isPageTreeRefShape(target.rootRef) &&
    typeof target.tabId === "number" && Number.isSafeInteger(target.tabId) && target.tabId > 0 &&
    typeof target.frameId === "number" && Number.isSafeInteger(target.frameId) && target.frameId >= 0 &&
    typeof target.documentId === "string" && target.documentId.length > 0;
}

async function clearTreeTargets(tabId: number, tabClosed: boolean): Promise<void> {
  const frames = tabClosed ? null : await chrome.webNavigation.getAllFrames({ tabId });
  if (!tabClosed && !Array.isArray(frames)) throw new Error("Current frame metadata is unavailable; tree routes were retained");
  if (frames !== null && frames.some((frame) => !frame.documentId)) {
    throw new Error("Current frame metadata is incomplete; tree routes were retained");
  }
  const currentDocuments = frames === null ? null : new Set(frames.map((frame) => `${frame.frameId}/${frame.documentId}`));
  const stored = await chrome.storage.session.get(null);
  const keys: string[] = [];
  for (const [key, target] of Object.entries(stored)) {
    if (key.startsWith(TREE_ROUTE_STORAGE_PREFIX) && isStoredTreeTarget(target) &&
      target.tabId === tabId &&
      (currentDocuments === null || !currentDocuments.has(`${target.frameId}/${target.documentId}`))) keys.push(key);
  }
  if (keys.length > 0) await chrome.storage.session.remove(keys);
}

function scheduleTreeTargetCleanup(tabId: number, tabClosed: boolean): void {
  void inRouteStorageOrder(() => clearTreeTargets(tabId, tabClosed)).catch(() => {
    console.warn("Page-tree session route cleanup failed; exact Document checks remain required");
  });
}

chrome.tabs.onRemoved.addListener((tabId) => scheduleTreeTargetCleanup(tabId, true));
chrome.tabs.onReplaced.addListener((_addedTabId, removedTabId) => scheduleTreeTargetCleanup(removedTabId, true));
chrome.webNavigation.onCommitted.addListener((details) =>
  scheduleTreeTargetCleanup(details.tabId, false));

async function routedTreeCandidates(tabId: number, frameId: number, documentId: string | null): Promise<RoutedTreeCandidate[]> {
  try {
    return await inRouteStorageOrder(async () => {
      const stored = await chrome.storage.session.get(null);
      const candidates: RoutedTreeCandidate[] = [];
      const maximum = limit("command.page.tree.maximum_refs_per_document") + limit("command.page.tree.maximum_view_items");
      for (const [key, target] of Object.entries(stored)) {
        if (!key.startsWith(TREE_ROUTE_STORAGE_PREFIX) || !isStoredTreeTarget(target) ||
          target.tabId !== tabId || target.frameId !== frameId || documentId !== null && target.documentId !== documentId) continue;
        const treeRef = key.slice(TREE_ROUTE_STORAGE_PREFIX.length);
        if (isPageTreeRefShape(treeRef)) candidates.push({ treeRef, target });
        if (candidates.length >= maximum) break;
      }
      return candidates;
    });
  } catch {
    throw new PageTreeServiceError("STORAGE_UNAVAILABLE", "Page-tree session routes could not be read");
  }
}

async function consumeTreeProjection(
  envelope: PageTreeProjectionEnvelope,
  documentId: string,
  candidates: readonly RoutedTreeCandidate[],
): Promise<PageTreeProjection> {
  if (!Array.isArray(envelope.retiredTreeRefs) || envelope.retiredTreeRefs.length > candidates.length ||
    typeof envelope.projection !== "object" || envelope.projection === null) {
    throw new PageTreeServiceError("DOM_OPERATION_FAILED", "Page returned an invalid operation-tree envelope");
  }
  const known = new Map(candidates.map((candidate) => [candidate.treeRef, candidate.target]));
  const keys = new Set<string>();
  for (const treeRef of envelope.retiredTreeRefs) {
    const target = known.get(treeRef);
    if (target === undefined) throw new PageTreeServiceError("DOM_OPERATION_FAILED", "Page returned an unknown retired TreeRef");
    if (target.documentId === documentId) keys.add(`${TREE_ROUTE_STORAGE_PREFIX}${treeRef}`);
  }
  if (keys.size > 0) {
    try { await inRouteStorageOrder(() => chrome.storage.session.remove([...keys])); }
    catch { throw new PageTreeServiceError("STORAGE_UNAVAILABLE", "Retired page-tree routes could not be removed"); }
  }
  return envelope.projection;
}

async function requiredTreeTarget(treeRef: string): Promise<PageTreeTarget> {
  const key = `${TREE_ROUTE_STORAGE_PREFIX}${treeRef}`;
  let stored: Record<string, unknown>;
  try {
    stored = await inRouteStorageOrder(() => chrome.storage.session.get(key));
  } catch {
    throw new PageTreeServiceError("STORAGE_UNAVAILABLE", "Page-tree session routes could not be read");
  }
  const target = stored[key];
  if (!isStoredTreeTarget(target)) {
    throw new PageTreeServiceError("TARGET_REF_STALE", "TreeRef is no longer routed to a live document");
  }
  return target;
}

async function registerTreeTargets(target: PageTreeTarget, treeRefs: readonly string[]): Promise<void> {
  const records: Record<string, PageTreeTarget> = Object.create(null);
  for (const treeRef of treeRefs) {
    if (!isPageTreeRefShape(treeRef)) {
      throw new PageTreeServiceError("DOM_OPERATION_FAILED", "Page returned an invalid TreeRef token");
    }
    records[`${TREE_ROUTE_STORAGE_PREFIX}${treeRef}`] = target;
  }
  if (treeRefs.length === 0) return;
  try {
    await inRouteStorageOrder(async () => {
      let frames: readonly ChromeWebNavigationFrame[];
      try { frames = await chrome.webNavigation.getAllFrames({ tabId: target.tabId }); }
      catch { throw new PageTreeServiceError("DOM_OPERATION_FAILED", "Current tree document could not be verified"); }
      if (!Array.isArray(frames)) throw new PageTreeServiceError("DOM_OPERATION_FAILED", "Current tree document metadata is unavailable");
      if (!frames.some((frame) => frame.frameId === target.frameId && frame.documentId === target.documentId)) {
        throw new PageTreeServiceError("TARGET_REF_STALE", "Tree document was replaced before its route could be saved");
      }
      await chrome.storage.session.set(records);
    });
  } catch (error) {
    if (error instanceof PageTreeServiceError) throw error;
    throw new PageTreeServiceError("STORAGE_UNAVAILABLE", "Page-tree session routes could not be saved");
  }
}

function returnedRefs(items: readonly PageTreeViewItem[]): {
  readonly treeRefs: readonly string[];
  readonly nodeRefs: readonly string[];
} {
  const treeRefs: string[] = [];
  const nodeRefs: string[] = [];
  for (const item of items) {
    if (item.treeRef !== null) treeRefs.push(item.treeRef);
    if (item.nodeRef !== null) nodeRefs.push(item.nodeRef);
  }
  return { treeRefs, nodeRefs };
}

async function registerReturnedRefs(
  target: PageTreeTarget,
  documentRef: string,
  refs: { readonly treeRefs: readonly string[]; readonly nodeRefs: readonly string[] },
): Promise<void> {
  for (const nodeRef of refs.nodeRefs) {
    if (!isNodeRefShape(nodeRef)) {
      throw new PageTreeServiceError("DOM_OPERATION_FAILED", "Page returned an invalid NodeRef token");
    }
  }
  await registerTreeTargets(target, refs.treeRefs);
  registerNodeRefsForDocument(documentRef, refs.nodeRefs);
}

function projectPageTree(
  operation: "expand" | "open" | "view" | "find",
  requestedTreeRef: string | null,
  keyId: string,
  viewRequest: (Omit<PageTreeViewRequest, "rootRef"> & Partial<Omit<PageTreeFindRequest, "rootRef">>) | null,
  limits: PageTreeLimits,
  routedTreeRefs: readonly string[],
): PageTreeProjectionEnvelope {
  const retiredTreeRefs: string[] = [];
  const project = (): PageTreeProjection => {
  type NodeLike = {
    readonly nodeType: number;
    readonly nodeName: string;
    readonly nodeValue: string | null;
    readonly namespaceURI?: string | null;
    readonly childNodes: ArrayLike<NodeLike>;
    readonly parentNode: NodeLike | null;
    readonly isConnected: boolean;
    readonly ownerElement?: ElementLike | null;
    readonly host?: ElementLike;
    readonly mode?: string;
    readonly publicId?: string;
    readonly systemId?: string;
  };
  type AttributeLike = NodeLike & {
    readonly name: string;
    readonly value: string;
  };
  type ElementLike = NodeLike & {
    readonly tagName: string;
    readonly attributes: ArrayLike<AttributeLike>;
    readonly shadowRoot?: NodeLike | null;
    readonly value?: unknown;
    readonly checked?: unknown;
    readonly selected?: unknown;
    readonly disabled?: unknown;
    readonly required?: unknown;
    readonly readOnly?: unknown;
    readonly indeterminate?: unknown;
    readonly labels?: Iterable<ElementLike> | null;
    hasAttribute(name: string): boolean;
    getAttribute(name: string): string | null;
    getAttributeNode(name: string): AttributeLike | null;
    matches(selector: string): boolean;
  };
  interface DomRegistryEntry { readonly element: ElementLike; readonly expiresAt: number }
  interface DomRegistry {
    readonly nodes: Map<string, DomRegistryEntry>;
    readonly reverse: WeakMap<object, string>;
  }
  type TreeEntry =
    | { readonly mode: "node"; readonly node: NodeLike }
    | { readonly mode: "property"; readonly element: ElementLike; readonly propertyName: string };
  interface TreeRegistry {
    readonly entries: Map<string, TreeEntry>;
    readonly nodeReverse: WeakMap<object, string>;
    readonly propertyReverse: WeakMap<object, Map<string, string>>;
    readonly expandedByKey: Map<string, Set<string>>;
    rootRef: string | null;
  }
  type TreeSource =
    | { readonly kind: "node"; readonly node: NodeLike }
    | { readonly kind: "property"; readonly element: ElementLike; readonly propertyName: string };
  type PageTreeBaseItem = Omit<PageTreeViewItem, "expanded" | "indexPath" | "level" | "nodeRef" | "treeRef">;
  interface Candidate {
    readonly item: PageTreeBaseItem;
    readonly element: ElementLike | null;
    readonly treeSource: TreeSource | null;
  }
  interface PendingViewItem {
    readonly candidate: Candidate;
    readonly indexPath: readonly number[];
    readonly level: number;
    readonly expanded: boolean;
  }
  interface ChildrenFrame {
    readonly kind: "children";
    readonly source: TreeSource;
    readonly parentPath: readonly number[];
    nextIndex: number;
  }
  interface ItemFrame {
    readonly kind: "item";
    readonly candidate: Candidate;
    readonly indexPath: readonly number[];
  }
  type TraversalFrame = ChildrenFrame | ItemFrame;

  const page = globalThis as unknown as {
    readonly document: NodeLike & {
      readonly title: string;
      readonly activeElement?: ElementLike | null;
      getElementById(id: string): ElementLike | null;
      querySelector(selector: string): ElementLike | null;
    };
    readonly location: { readonly href: string };
    readonly performance: { now(): number };
    readonly crypto: Crypto;
    __BKA_PAGE_TREE_REGISTRY_V2__?: TreeRegistry;
    __BKA_DOM_NODE_REGISTRY_V1__?: DomRegistry;
  };
  const ELEMENT_NODE = 1;
  const ATTRIBUTE_NODE = 2;
  const TEXT_NODE = 3;
  const CDATA_NODE = 4;
  const PROCESSING_INSTRUCTION_NODE = 7;
  const COMMENT_NODE = 8;
  const DOCUMENT_NODE = 9;
  const DOCUMENT_TYPE_NODE = 10;
  const DOCUMENT_FRAGMENT_NODE = 11;
  const encoder = new TextEncoder();
  const now = page.performance.now();
  const treeRegistry = page.__BKA_PAGE_TREE_REGISTRY_V2__ ?? {
    entries: new Map(),
    nodeReverse: new WeakMap(),
    propertyReverse: new WeakMap(),
    expandedByKey: new Map(),
    rootRef: null,
  };
  const domRegistry = page.__BKA_DOM_NODE_REGISTRY_V1__ ?? { nodes: new Map(), reverse: new WeakMap() };
  page.__BKA_PAGE_TREE_REGISTRY_V2__ = treeRegistry;
  page.__BKA_DOM_NODE_REGISTRY_V1__ = domRegistry;
  for (const [token, entry] of domRegistry.nodes) {
    if (entry.expiresAt <= now) domRegistry.nodes.delete(token);
  }

  const randomToken = (prefix: "nr1" | "tr2", existing: ReadonlyMap<string, unknown>): string | null => {
    let attempt = 0;
    while (attempt < 8) {
      const bytes = new Uint8Array(32);
      page.crypto.getRandomValues(bytes);
      let binary = "";
      let index = 0;
      while (index < bytes.length) {
        binary += String.fromCharCode(bytes[index] ?? 0);
        index += 1;
      }
      const token = `${prefix}.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
      if (!existing.has(token)) return token;
      attempt += 1;
    }
    return null;
  };
  const asElement = (node: NodeLike): ElementLike | null => node.nodeType === ELEMENT_NODE ? node as ElementLike : null;
  const normalized = (value: string): string => value.replace(/[\t\n\f\r ]+/gu, " ").trim();
  const clipRaw = (value: string): { readonly value: string; readonly truncated: boolean } => {
    if (value.length <= limits.maximumPreviewCharacters) return { value, truncated: false };
    let end = limits.maximumPreviewCharacters;
    const previous = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end -= 1;
    return { value: value.slice(0, end), truncated: true };
  };
  const clipJsonBytes = (value: string, maximum: number): string => {
    if (encoder.encode(JSON.stringify(value)).byteLength <= maximum) return value;
    let output = "";
    for (const character of value) {
      const candidate = output + character;
      if (encoder.encode(JSON.stringify(candidate)).byteLength > maximum) break;
      output = candidate;
    }
    return output;
  };
  const nodeIsLive = (node: NodeLike): boolean => {
    if (node.nodeType === DOCUMENT_NODE) return node === page.document;
    if (node.nodeType === ATTRIBUTE_NODE) {
      const attribute = node as AttributeLike;
      return attribute.ownerElement !== null && attribute.ownerElement !== undefined && attribute.ownerElement.isConnected &&
        attribute.ownerElement.getAttributeNode(attribute.name) === attribute;
    }
    if (node.nodeType === DOCUMENT_FRAGMENT_NODE && node.host !== undefined) return node.host.isConnected;
    return node.isConnected;
  };
  const nodeKind = (node: NodeLike): PageTreeItemKind => {
    switch (node.nodeType) {
      case ATTRIBUTE_NODE: return "attribute";
      case CDATA_NODE: return "cdata";
      case COMMENT_NODE: return "comment";
      case DOCUMENT_NODE: return "document";
      case DOCUMENT_TYPE_NODE: return "doctype";
      case ELEMENT_NODE: return "element";
      case PROCESSING_INSTRUCTION_NODE: return "processing_instruction";
      case DOCUMENT_FRAGMENT_NODE: return node.host === undefined ? "document_fragment" : "shadow_root";
      case TEXT_NODE: return "text";
      default: return "unavailable";
    }
  };
  const isValueNode = (node: NodeLike): boolean =>
    node.nodeType === ATTRIBUTE_NODE || node.nodeType === TEXT_NODE || node.nodeType === CDATA_NODE ||
    node.nodeType === COMMENT_NODE || node.nodeType === PROCESSING_INSTRUCTION_NODE;
  const rawNodeValue = (node: NodeLike): string => node.nodeType === ATTRIBUTE_NODE
    ? (node as AttributeLike).value
    : node.nodeValue ?? "";
  const elementRole = (element: ElementLike): string | null => {
    const explicit = normalized(element.getAttribute("role") ?? "").toLowerCase();
    if (explicit.length > 0) return clipRaw(explicit).value;
    const tag = element.tagName.toLowerCase();
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "img") return "img";
    if (/^h[1-6]$/u.test(tag)) return "heading";
    if (tag === "table") return "table";
    if (tag === "tr") return "row";
    if (tag === "th") return "columnheader";
    if (tag === "td") return "cell";
    if (tag === "ul" || tag === "ol") return "list";
    if (tag === "li") return "listitem";
    if (tag === "main") return "main";
    if (tag === "nav") return "navigation";
    if (tag === "aside") return "complementary";
    if (tag === "form") return "form";
    if (tag === "input") {
      const type = element.getAttribute("type")?.toLowerCase() ?? "text";
      if (type === "button" || type === "reset" || type === "submit") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    return null;
  };
  const selfHidden = (element: ElementLike): boolean => {
    const tag = element.tagName.toLowerCase();
    const type = element.getAttribute("type")?.toLowerCase() ?? "";
    return element.hasAttribute("hidden") || element.hasAttribute("inert") || element.getAttribute("aria-hidden") === "true" ||
      (tag === "input" && type === "hidden");
  };
  const elementStates = (element: ElementLike): string[] => {
    const states: string[] = [];
    if (selfHidden(element)) states.push("hidden");
    if (page.document.activeElement === element) states.push("focused");
    if (element.disabled === true || element.getAttribute("aria-disabled") === "true") states.push("disabled");
    if (element.checked === true || element.getAttribute("aria-checked") === "true") states.push("checked");
    if (element.selected === true || element.getAttribute("aria-selected") === "true") states.push("selected");
    if (element.required === true || element.getAttribute("aria-required") === "true") states.push("required");
    if (element.readOnly === true || element.getAttribute("aria-readonly") === "true") states.push("readonly");
    if (element.indeterminate === true) states.push("indeterminate");
    const invalid = element.getAttribute("aria-invalid");
    if (invalid !== null && invalid !== "false") states.push("invalid");
    const expanded = element.getAttribute("aria-expanded");
    if (expanded === "true") states.push("expanded");
    if (expanded === "false") states.push("collapsed");
    const type = element.getAttribute("type")?.toLowerCase() ?? "";
    if (element.tagName.toLowerCase() === "input" && type === "password") states.push("sensitive");
    if (element.shadowRoot !== undefined && element.shadowRoot !== null) states.push("open-shadow-root");
    return states;
  };
  const textLabel = (root: NodeLike): string | null => {
    const fragments: string[] = [];
    const stack: { node: NodeLike; entered: boolean; nextChild: number }[] = [
      { node: root, entered: false, nextChild: 0 },
    ];
    let visited = 0;
    let characters = 0;
    while (stack.length > 0 && visited < limits.maximumLabelScanNodes && characters <= limits.maximumPreviewCharacters * 2) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;
      const node = frame.node;
      if (!frame.entered) {
        frame.entered = true;
        visited += 1;
        if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_NODE) {
          const value = node.nodeValue ?? "";
          fragments.push(value);
          characters += value.length;
          stack.pop();
        } else {
          const element = asElement(node);
          if (element !== null) {
            const tag = element.tagName.toLowerCase();
            if (["script", "style", "template", "noscript"].includes(tag) || selfHidden(element)) stack.pop();
          }
        }
        continue;
      }
      if (frame.nextChild >= node.childNodes.length) { stack.pop(); continue; }
      // Fetch one descendant at a time. A wide node must not allocate or read its
      // entire child list before the label-scan budget can stop the traversal.
      const child = node.childNodes[frame.nextChild];
      frame.nextChild += 1;
      if (child !== undefined) stack.push({ node: child, entered: false, nextChild: 0 });
    }
    const value = normalized(fragments.join(" "));
    return value.length === 0 ? null : clipRaw(value).value;
  };
  const elementLabel = (element: ElementLike): string | null => {
    const ariaLabel = normalized(element.getAttribute("aria-label") ?? "");
    if (ariaLabel.length > 0) return clipRaw(ariaLabel).value;
    const labelledBy = (element.getAttribute("aria-labelledby") ?? "").trim().split(/\s+/u).filter((value) => value.length > 0);
    if (labelledBy.length > 0) {
      const parts: string[] = [];
      let index = 0;
      while (index < labelledBy.length && index < 16) {
        const label = page.document.getElementById(labelledBy[index] ?? "");
        if (label !== null) parts.push(textLabel(label) ?? "");
        index += 1;
      }
      const value = normalized(parts.join(" "));
      if (value.length > 0) return clipRaw(value).value;
    }
    if (element.labels !== undefined && element.labels !== null) {
      const parts: string[] = [];
      for (const label of element.labels) {
        if (parts.length >= 16) break;
        parts.push(textLabel(label) ?? "");
      }
      const value = normalized(parts.join(" "));
      if (value.length > 0) return clipRaw(value).value;
    }
    for (const attributeName of ["alt", "title", "placeholder"]) {
      const value = normalized(element.getAttribute(attributeName) ?? "");
      if (value.length > 0) return clipRaw(value).value;
    }
    return textLabel(element);
  };
  const liveProperties = (element: ElementLike): readonly { readonly name: string; readonly value: string }[] => {
    const values: { name: string; value: string }[] = [];
    if (typeof element.value === "string" && element.getAttribute("value") !== element.value) {
      values.push({ name: "value", value: element.value });
    }
    const booleanProperties: readonly {
      readonly property: "checked" | "disabled" | "indeterminate" | "readOnly" | "required" | "selected";
      readonly attribute: string;
    }[] = [
      { property: "checked", attribute: "checked" },
      { property: "selected", attribute: "selected" },
      { property: "disabled", attribute: "disabled" },
      { property: "required", attribute: "required" },
      { property: "readOnly", attribute: "readonly" },
      { property: "indeterminate", attribute: "indeterminate" },
    ];
    for (const descriptor of booleanProperties) {
      const propertyValue = element[descriptor.property];
      if (typeof propertyValue === "boolean" && propertyValue !== element.hasAttribute(descriptor.attribute)) {
        values.push({ name: descriptor.property, value: String(propertyValue) });
      }
    }
    return values;
  };
  const doctypeValue = (node: NodeLike): string => {
    const publicId = node.publicId ?? "";
    const systemId = node.systemId ?? "";
    if (publicId.length > 0) return `PUBLIC ${publicId}${systemId.length > 0 ? ` ${systemId}` : ""}`;
    if (systemId.length > 0) return `SYSTEM ${systemId}`;
    return "";
  };
  const hasTreeDetails = (node: NodeLike): boolean => {
    if (isValueNode(node)) return rawNodeValue(node).length > limits.maximumPreviewCharacters;
    if (node.nodeType === DOCUMENT_TYPE_NODE) return doctypeValue(node).length > limits.maximumPreviewCharacters;
    const element = asElement(node);
    if (element !== null) {
      return element.attributes.length > 0 || liveProperties(element).length > 0 ||
        element.shadowRoot !== undefined && element.shadowRoot !== null || element.childNodes.length > 0;
    }
    return node.childNodes.length > 0;
  };
  const candidateForNode = (node: NodeLike, sourceOrder: number): Candidate => {
    const element = asElement(node);
    let rawValue = "";
    if (isValueNode(node)) rawValue = rawNodeValue(node);
    else if (node.nodeType === DOCUMENT_TYPE_NODE) rawValue = doctypeValue(node);
    else if (element !== null && typeof element.value === "string") {
      const inputType = element.tagName.toLowerCase() === "input"
        ? element.getAttribute("type")?.toLowerCase() ?? "text"
        : null;
      if (inputType !== "password") rawValue = element.value;
    }
    const preview = clipRaw(rawValue);
    return {
      item: {
        kind: nodeKind(node),
        name: node.nodeType === ATTRIBUTE_NODE ? (node as AttributeLike).name : node.nodeName,
        namespace: node.namespaceURI ?? null,
        role: element === null ? null : elementRole(element),
        label: element === null ? null : elementLabel(element),
        valuePreview: rawValue.length === 0 ? null : preview.value,
        valueTruncated: preview.truncated,
        states: element === null ? [] : elementStates(element),
        attributeCount: element?.attributes.length ?? 0,
        childCount: node.childNodes.length,
        sourceOrder,
      },
      element,
      treeSource: hasTreeDetails(node) ? { kind: "node", node } : null,
    };
  };
  const candidateForProperty = (
    element: ElementLike,
    propertyName: string,
    propertyValue: string,
    sourceOrder: number,
  ): Candidate => {
    const preview = clipRaw(propertyValue);
    return {
      item: {
        kind: "property",
        name: propertyName,
        namespace: null,
        role: null,
        label: null,
        valuePreview: preview.value,
        valueTruncated: preview.truncated,
        states: [],
        attributeCount: 0,
        childCount: 0,
        sourceOrder,
      },
      element: null,
      treeSource: preview.truncated ? { kind: "property", element, propertyName } : null,
    };
  };
  const adjustedChunkBoundary = (value: string, nominal: number): number => {
    if (nominal <= 0) return 0;
    if (nominal >= value.length) return value.length;
    const previous = value.charCodeAt(nominal - 1);
    const next = value.charCodeAt(nominal);
    return previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF
      ? nominal + 1
      : nominal;
  };
  const valueChunkCount = (value: string): number => {
    if (value.length === 0) return 0;
    let count = Math.ceil(value.length / limits.maximumPreviewCharacters);
    if (count > 1 && adjustedChunkBoundary(value, (count - 1) * limits.maximumPreviewCharacters) >= value.length) {
      count -= 1;
    }
    return count;
  };
  const candidateForValueChunk = (value: string, sourceOrder: number): Candidate | null => {
    if (sourceOrder < 0 || sourceOrder >= valueChunkCount(value)) return null;
    const start = adjustedChunkBoundary(value, sourceOrder * limits.maximumPreviewCharacters);
    const end = adjustedChunkBoundary(value, (sourceOrder + 1) * limits.maximumPreviewCharacters);
    return {
      item: {
        kind: "value_chunk",
        name: null,
        namespace: null,
        role: null,
        label: null,
        valuePreview: value.slice(start, end),
        valueTruncated: false,
        states: [],
        attributeCount: 0,
        childCount: 0,
        sourceOrder,
      },
      element: null,
      treeSource: null,
    };
  };
  const directCandidateAt = (source: TreeSource, sourceOrder: number): Candidate | null => {
    if (!Number.isSafeInteger(sourceOrder) || sourceOrder < 0) return null;
    if (source.kind === "property") {
      const value = String(source.element[source.propertyName as keyof ElementLike] ?? "");
      return candidateForValueChunk(value, sourceOrder);
    }
    const node = source.node;
    if (isValueNode(node)) return candidateForValueChunk(rawNodeValue(node), sourceOrder);
    if (node.nodeType === DOCUMENT_TYPE_NODE) return candidateForValueChunk(doctypeValue(node), sourceOrder);
    const element = asElement(node);
    const attributes = element?.attributes ?? { length: 0 };
    if (sourceOrder < attributes.length) {
      const attribute = attributes[sourceOrder];
      return attribute === undefined ? null : candidateForNode(attribute, sourceOrder);
    }
    const properties = element === null ? [] : liveProperties(element);
    const propertyIndex = sourceOrder - attributes.length;
    if (propertyIndex >= 0 && propertyIndex < properties.length && element !== null) {
      const property = properties[propertyIndex];
      return property === undefined
        ? null
        : candidateForProperty(element, property.name, property.value, sourceOrder);
    }
    const shadowOffset = attributes.length + properties.length;
    const shadowRoot = element?.shadowRoot;
    const hasShadowRoot = shadowRoot !== undefined && shadowRoot !== null;
    if (hasShadowRoot && sourceOrder === shadowOffset) return candidateForNode(shadowRoot, sourceOrder);
    const childIndex = sourceOrder - shadowOffset - (hasShadowRoot ? 1 : 0);
    if (childIndex < 0 || childIndex >= node.childNodes.length) return null;
    const child = node.childNodes[childIndex];
    return child === undefined ? null : candidateForNode(child, sourceOrder);
  };
  const existingTreeRef = (source: TreeSource): string | null => {
    if (source.kind === "node") {
      const token = treeRegistry.nodeReverse.get(source.node as object);
      return token !== undefined && treeRegistry.entries.has(token) ? token : null;
    }
    const token = treeRegistry.propertyReverse.get(source.element as object)?.get(source.propertyName);
    return token !== undefined && treeRegistry.entries.has(token) ? token : null;
  };
  const baseTreeRef = (source: TreeSource): string | null => {
    const existing = existingTreeRef(source);
    if (existing !== null) return existing;
    if (treeRegistry.entries.size >= limits.maximumTreeRefs) return null;
    const token = randomToken("tr2", treeRegistry.entries);
    if (token === null) return null;
    if (source.kind === "node") {
      treeRegistry.nodeReverse.set(source.node as object, token);
      treeRegistry.entries.set(token, { mode: "node", node: source.node });
    } else {
      const refs = treeRegistry.propertyReverse.get(source.element as object) ?? new Map<string, string>();
      treeRegistry.propertyReverse.set(source.element as object, refs);
      refs.set(source.propertyName, token);
      treeRegistry.entries.set(token, { mode: "property", element: source.element, propertyName: source.propertyName });
    }
    return token;
  };
  const nodeRef = (element: ElementLike): string | null => {
    const existing = domRegistry.reverse.get(element as object);
    if (existing !== undefined && domRegistry.nodes.has(existing)) {
      domRegistry.nodes.set(existing, { element, expiresAt: now + limits.nodeReferenceTtlMs });
      return existing;
    }
    if (domRegistry.nodes.size >= limits.maximumNodeRefs) return null;
    const token = randomToken("nr1", domRegistry.nodes);
    if (token === null) return null;
    domRegistry.reverse.set(element as object, token);
    domRegistry.nodes.set(token, { element, expiresAt: now + limits.nodeReferenceTtlMs });
    return token;
  };
  const neededTreeRefs = (pending: readonly PendingViewItem[]): number => {
    const nodes = new Set<object>();
    const properties = new Map<object, Set<string>>();
    for (const item of pending) {
      const source = item.candidate.treeSource;
      if (source === null || existingTreeRef(source) !== null) continue;
      if (source.kind === "node") {
        nodes.add(source.node as object);
      } else {
        const names = properties.get(source.element as object) ?? new Set<string>();
        names.add(source.propertyName);
        properties.set(source.element as object, names);
      }
    }
    let count = nodes.size;
    for (const names of properties.values()) count += names.size;
    return count;
  };
  const neededNodeRefs = (pending: readonly PendingViewItem[]): number => {
    const elements = new Set<object>();
    for (const item of pending) {
      const element = item.candidate.element;
      if (element === null) continue;
      const existing = domRegistry.reverse.get(element as object);
      if (existing === undefined || !domRegistry.nodes.has(existing)) elements.add(element as object);
    }
    return elements.size;
  };
  const materialize = (pending: readonly PendingViewItem[]): PageTreeViewItem[] | null => {
    if (
      treeRegistry.entries.size + neededTreeRefs(pending) > limits.maximumTreeRefs ||
      domRegistry.nodes.size + neededNodeRefs(pending) > limits.maximumNodeRefs
    ) return null;
    const items: PageTreeViewItem[] = [];
    for (const pendingItem of pending) {
      const candidate = pendingItem.candidate;
      const treeRef = candidate.treeSource === null ? null : baseTreeRef(candidate.treeSource);
      const exactNodeRef = candidate.element === null ? null : nodeRef(candidate.element);
      if (candidate.treeSource !== null && treeRef === null || candidate.element !== null && exactNodeRef === null) return null;
      items.push({
        ...candidate.item,
        treeRef,
        nodeRef: exactNodeRef,
        indexPath: pendingItem.indexPath,
        level: pendingItem.level,
        expanded: pendingItem.expanded,
      });
    }
    return items;
  };
  const placeholderTreeRef = `tr2.${"A".repeat(43)}`;
  const placeholderNodeRef = `nr1.${"A".repeat(43)}`;
  const projectedViewItem = (item: PendingViewItem): PageTreeViewItem => ({
    ...item.candidate.item,
    treeRef: item.candidate.treeSource === null ? null : placeholderTreeRef,
    nodeRef: item.candidate.element === null ? null : placeholderNodeRef,
    indexPath: item.indexPath,
    level: item.level,
    expanded: item.expanded,
  });
  const fitsView = (pending: readonly PendingViewItem[], nextIndexPath: readonly number[]): boolean => {
    const projection = {
      rootRef: placeholderTreeRef,
      items: pending.map(projectedViewItem),
      truncated: true,
      nextIndexPath,
    };
    return encoder.encode(JSON.stringify(projection)).byteLength <= limits.maximumResultBytes;
  };
  const entryIsLive = (entry: TreeEntry): boolean => {
    if (entry.mode === "node") return nodeIsLive(entry.node);
    if (!entry.element.isConnected) return false;
    return liveProperties(entry.element).some((property) => property.name === entry.propertyName);
  };
  const requiredEntry = (treeRef: string): TreeEntry | null => {
    const entry = treeRegistry.entries.get(treeRef);
    if (entry === undefined || !entryIsLive(entry)) {
      if (entry !== undefined) treeRegistry.entries.delete(treeRef);
      return null;
    }
    return entry;
  };
  const pruneTreeEntries = (): void => {
    for (const [treeRef, entry] of treeRegistry.entries) {
      if (entryIsLive(entry)) continue;
      treeRegistry.entries.delete(treeRef);
      for (const expandedRefs of treeRegistry.expandedByKey.values()) expandedRefs.delete(treeRef);
    }
  };
  const isExpanded = (source: TreeSource, expandedRefs: ReadonlySet<string>): boolean => {
    const treeRef = existingTreeRef(source);
    return treeRef !== null && expandedRefs.has(treeRef);
  };
  const sameParent = (left: readonly number[], right: readonly number[]): boolean => {
    if (left.length !== right.length || left.length === 0) return false;
    let index = 0;
    while (index < left.length - 1) {
      if (left[index] !== right[index]) return false;
      index += 1;
    }
    return true;
  };
  const inSiblingRange = (path: readonly number[], range: PageTreeSiblingRange | null): boolean => {
    if (range === null) return true;
    if (!sameParent(path, range.from)) return false;
    const value = path[path.length - 1] ?? -1;
    const from = range.from[range.from.length - 1] ?? -1;
    const toExclusive = range.toExclusive[range.toExclusive.length - 1] ?? -1;
    return value >= from && value < toExclusive;
  };
  const resolvePath = (path: readonly number[]): Candidate | null => {
    let source: TreeSource = { kind: "node", node: page.document };
    let candidate: Candidate | null = null;
    let depth = 0;
    while (depth < path.length) {
      candidate = directCandidateAt(source, path[depth] ?? -1);
      if (candidate === null) return null;
      if (depth + 1 < path.length) {
        if (candidate.treeSource === null) return null;
        source = candidate.treeSource;
      }
      depth += 1;
    }
    return candidate;
  };

  pruneTreeEntries();
  for (const treeRef of routedTreeRefs) {
    if (!treeRegistry.entries.has(treeRef)) retiredTreeRefs.push(treeRef);
  }
  const existingRootRef = treeRegistry.rootRef;
  const reusableRoot = existingRootRef !== null && requiredEntry(existingRootRef)?.mode === "node";
  let rootRef = reusableRoot ? existingRootRef : null;
  if (rootRef === null) {
    rootRef = baseTreeRef({ kind: "node", node: page.document });
    if (rootRef === null) return { ok: false, reason: "capacity" };
    treeRegistry.rootRef = rootRef;
  }

  if (operation === "open") {
    const result = {
      ok: true as const,
      operation: "open" as const,
      url: clipJsonBytes(page.location.href, limits.maximumUrlBytes),
      title: clipJsonBytes(page.document.title, limits.maximumUrlBytes),
      rootRef,
      reused: reusableRoot,
      limitations: [
        "browser_accessibility_tree_unavailable",
        "closed_shadow_roots_unobservable",
        "unmounted_content_unobservable",
      ],
    };
    return encoder.encode(JSON.stringify(result)).byteLength <= limits.maximumResultBytes
      ? result
      : { ok: false, reason: "unexpected" };
  }

  if (requestedTreeRef === null) return { ok: false, reason: "stale" };
  if (operation === "expand") {
    const entry = requiredEntry(requestedTreeRef);
    if (entry === null) return { ok: false, reason: "stale" };
    const expandedRefs = treeRegistry.expandedByKey.get(keyId) ?? new Set<string>();
    expandedRefs.add(requestedTreeRef);
    treeRegistry.expandedByKey.set(keyId, expandedRefs);
    return { ok: true, operation: "expand", rootRef, treeRef: requestedTreeRef, expanded: true };
  }

  try {
    if (requestedTreeRef !== rootRef || viewRequest === null) return { ok: false, reason: "stale" };
    if (operation === "find") {
      const find = viewRequest as Omit<PageTreeFindRequest, "rootRef">;
      const basePath = find.subtree ?? [];
      const baseCandidate = basePath.length === 0 ? null : resolvePath(basePath);
      if (basePath.length > 0 && baseCandidate === null) return { ok: false, reason: "stale" };
      // Validate CSS even in an empty document. No separate DOM query index.
      if (find.selector !== undefined) page.document.querySelector(find.selector);
      const expandedRefs = treeRegistry.expandedByKey.get(keyId) ?? new Set<string>();
      const traversal: TraversalFrame[] = [];
      if (find.from !== undefined) {
        const from = find.from;
        if (from.length < basePath.length || basePath.some((value, index) => from[index] !== value)) {
          return { ok: false, reason: "stale" };
        }
        const first = resolvePath(from);
        if (first === null) return { ok: false, reason: "stale" };
        // Seek directly to the inclusive preorder start. Do not rescan the prefix or
        // expand any ancestors; array indices remain canonical, not a new tree.
        let depth = basePath.length;
        while (depth < from.length) {
          const parentPath = from.slice(0, depth);
          const source: TreeSource | null = depth === 0 ? { kind: "node", node: page.document } : resolvePath(parentPath)?.treeSource ?? null;
          if (source === null) return { ok: false, reason: "stale" };
          traversal.push({ kind: "children", source, parentPath, nextIndex: (from[depth] ?? -1) + 1 });
          depth += 1;
        }
        traversal.push({ kind: "item", candidate: first, indexPath: from });
      } else if (baseCandidate === null) {
        traversal.push({ kind: "children", source: { kind: "node", node: page.document }, parentPath: [], nextIndex: 0 });
      } else {
        traversal.push({ kind: "item", candidate: baseCandidate, indexPath: basePath });
      }
      const pending: PendingViewItem[] = [];
      let scanned = 0;
      let nextIndexPath: readonly number[] | null = null;
      let depthLimited = false;
      let truncated = false;
      while (traversal.length > 0) {
        const frame = traversal[traversal.length - 1];
        if (frame === undefined) break;
        if (frame.kind === "children") {
          const candidate = directCandidateAt(frame.source, frame.nextIndex);
          if (candidate === null) { traversal.pop(); continue; }
          const indexPath = [...frame.parentPath, frame.nextIndex];
          frame.nextIndex += 1;
          traversal.push({ kind: "item", candidate, indexPath });
          continue;
        }
        if (scanned >= limits.maximumFindScanNodes) { truncated = true; nextIndexPath = frame.indexPath; break; }
        const candidate = frame.candidate;
        const expanded = candidate.treeSource !== null && isExpanded(candidate.treeSource, expandedRefs);
        const matches = (find.text === undefined || (candidate.item.label ?? "").includes(find.text) ||
            (candidate.item.valuePreview ?? "").includes(find.text)) &&
          (find.role === undefined || candidate.item.role === find.role) &&
          (find.selector === undefined || candidate.item.kind === "element" && candidate.element?.matches(find.selector) === true);
        if (matches) {
          const item = { candidate, indexPath: frame.indexPath, level: frame.indexPath.length - 1, expanded };
          if (pending.length >= find.limit || !fitsView([...pending, item], frame.indexPath)) { truncated = true; nextIndexPath = frame.indexPath; break; }
          pending.push(item);
        }
        traversal.pop();
        scanned += 1;
        if (candidate.treeSource !== null) {
          if (frame.indexPath.length >= limits.maximumIndexDepth) depthLimited = true;
          else traversal.push({ kind: "children", source: candidate.treeSource, parentPath: frame.indexPath, nextIndex: 0 });
        }
      }
      const items = materialize(pending);
      if (items === null) return { ok: false, reason: "capacity" };
      return { ok: true, operation: "find", rootRef, items, truncated: truncated || depthLimited,
        nextIndexPath };
    }
    // Chromium's scripting argument conversion can omit null object members.
    // Normalize once here, after that boundary, not in the background caller.
    const effectiveViewRequest: NormalizedPageTreeViewRequest = {
      maximumLevel: viewRequest.maximumLevel ?? null,
      range: viewRequest.range ?? null,
      subtree: viewRequest.subtree ?? null,
    };
    const rootEntry = requiredEntry(rootRef);
    if (rootEntry === null || rootEntry.mode !== "node" || rootEntry.node !== page.document) {
      return { ok: false, reason: "stale" };
    }
    const expandedRefs = treeRegistry.expandedByKey.get(keyId) ?? new Set<string>();
    const traversal: TraversalFrame[] = [];
    const subtree = effectiveViewRequest.subtree;
    const subtreeCandidate = subtree === null ? null : resolvePath(subtree);
    if (subtree !== null && subtreeCandidate === null) return { ok: false, reason: "stale" };
    const range = effectiveViewRequest.range;
    if (range === null) {
      if (subtree === null) {
        traversal.push({ kind: "children", source: { kind: "node", node: page.document }, parentPath: [], nextIndex: 0 });
      } else if (subtreeCandidate !== null) {
        traversal.push({ kind: "item", candidate: subtreeCandidate, indexPath: subtree });
      }
    } else if (effectiveViewRequest.maximumLevel === null || range.from.length - 1 <= effectiveViewRequest.maximumLevel) {
      if (subtree !== null && subtree.length === range.from.length) {
        if (subtreeCandidate !== null && inSiblingRange(subtree, range)) {
          traversal.push({ kind: "item", candidate: subtreeCandidate, indexPath: subtree });
        }
      } else {
        const parentPath = range.from.slice(0, -1);
        const startPath = subtree ?? [];
        if (startPath.length <= parentPath.length && startPath.every((value, index) => value === parentPath[index])) {
          let source: TreeSource | null = subtree === null
            ? { kind: "node", node: page.document }
            : subtreeCandidate?.treeSource ?? null;
          let depth = startPath.length;
          // Seek directly to the requested parent. A view never expands any ancestor.
          while (source !== null) {
            if (depth > 0 && !isExpanded(source, expandedRefs)) { source = null; break; }
            if (depth === parentPath.length) break;
            source = directCandidateAt(source, parentPath[depth] ?? -1)?.treeSource ?? null;
            depth += 1;
          }
          if (source !== null) {
            traversal.push({ kind: "children", source, parentPath, nextIndex: range.from[range.from.length - 1] ?? 0 });
          }
        }
      }
    }

    const pending: PendingViewItem[] = [];
    let scanned = 0;
    let truncated = false;
    let nextIndexPath: readonly number[] | null = null;
    while (traversal.length > 0 && scanned < limits.maximumViewScanNodes) {
    const frame = traversal[traversal.length - 1];
    if (frame === undefined) break;
    if (frame.kind === "children") {
      if (range !== null && frame.nextIndex >= (range.toExclusive[range.toExclusive.length - 1] ?? 0)) {
        traversal.pop();
        continue;
      }
      const candidate = directCandidateAt(frame.source, frame.nextIndex);
      if (candidate === null) {
        traversal.pop();
        continue;
      }
      const childPath = [...frame.parentPath, frame.nextIndex];
      frame.nextIndex += 1;
      if (childPath.length > limits.maximumIndexDepth) {
        truncated = true;
        nextIndexPath = childPath;
        break;
      }
      traversal.push({ kind: "item", candidate, indexPath: childPath });
      continue;
    }

    traversal.pop();
    scanned += 1;
    const level = frame.indexPath.length - 1;
    const expanded = frame.candidate.treeSource !== null && isExpanded(frame.candidate.treeSource, expandedRefs);
    const withinLevel = effectiveViewRequest.maximumLevel === null || level <= effectiveViewRequest.maximumLevel;
    if (withinLevel && inSiblingRange(frame.indexPath, effectiveViewRequest.range)) {
      const pendingItem: PendingViewItem = { candidate: frame.candidate, indexPath: frame.indexPath, level, expanded };
      if (pending.length >= limits.maximumViewItems || !fitsView([...pending, pendingItem], frame.indexPath)) {
        truncated = true;
        nextIndexPath = frame.indexPath;
        break;
      }
      pending.push(pendingItem);
    }
    if (
      range === null &&
      expanded &&
      frame.candidate.treeSource !== null &&
      (effectiveViewRequest.maximumLevel === null || level < effectiveViewRequest.maximumLevel)
    ) {
      traversal.push({ kind: "children", source: frame.candidate.treeSource, parentPath: frame.indexPath, nextIndex: 0 });
    }
    }
    if (!truncated && scanned >= limits.maximumViewScanNodes) {
      // Exhausted child frames are not evidence of truncation. Find the actual next item.
      while (traversal.length > 0) {
        const frame = traversal[traversal.length - 1];
        if (frame === undefined) break;
        if (frame.kind === "item") { nextIndexPath = frame.indexPath; break; }
        if (range !== null && frame.nextIndex >= (range.toExclusive[range.toExclusive.length - 1] ?? 0)
          || directCandidateAt(frame.source, frame.nextIndex) === null) {
          traversal.pop();
          continue;
        }
        nextIndexPath = [...frame.parentPath, frame.nextIndex];
        break;
      }
      truncated = nextIndexPath !== null;
    }
    const items = materialize(pending);
    if (items === null) return { ok: false, reason: "capacity" };
    return { ok: true, operation: "view", rootRef, items, truncated, nextIndexPath };
  } catch (error) {
    void error;
    return { ok: false, reason: "unexpected" };
  }
  };
  return { projection: project(), retiredTreeRefs };
}

function mapProjectionFailure(failure: Extract<PageTreeProjection, { readonly ok: false }>): never {
  if (failure.reason === "capacity") {
    throw new PageTreeServiceError("LIMIT_EXCEEDED", "Page-tree reference capacity is exhausted");
  }
  if (failure.reason === "stale") {
    throw new PageTreeServiceError("TARGET_REF_STALE", "TreeRef or canonical index is no longer live in the target document");
  }
  throw new PageTreeServiceError("DOM_OPERATION_FAILED", "The page did not return a valid operation tree");
}

interface ResolvedPageTreeDocument {
  readonly tabRef: string;
  readonly tabId: number;
  readonly frameId: number;
  readonly documentId: string | null;
  readonly documentRef: string | null;
}

async function resolvePageTreeDocument(targetRef: string): Promise<ResolvedPageTreeDocument> {
  if (isTabRefShape(targetRef)) {
    const target = await resolveTabTarget(targetRef);
    return { tabRef: targetRef, tabId: target.tabId, frameId: 0, documentId: null, documentRef: null };
  }
  if (!isDocumentRefShape(targetRef)) {
    throw new PageTreeServiceError("TARGET_REF_STALE", "Page-tree target is not a live TabRef or DocumentRef");
  }
  const document = resolveDocumentRefTarget(targetRef);
  const target = await resolveTabTarget(document.tabRef);
  if (target.tabId !== document.tabId) {
    throw new PageTreeServiceError("TARGET_REF_STALE", "DocumentRef no longer belongs to the live tab generation");
  }
  return {
    tabRef: document.tabRef,
    tabId: document.tabId,
    frameId: document.frameId,
    documentId: document.documentId,
    documentRef: document.documentRef,
  };
}

function currentDocumentRef(target: PageTreeTarget, tabRef: string): string {
  return registerDocumentRef(tabRef, target.tabId, target.frameId, target.documentId);
}

export async function openPageTree(targetRef: string, keyId: string): Promise<PageTreeOpenResult> {
  const documentTarget = await resolvePageTreeDocument(targetRef);
  const tabTarget = await resolveTabTarget(documentTarget.tabRef);
  await assertScriptingTargetAvailable(tabTarget);
  assertResolvedTabTarget(tabTarget);
  const candidates = await routedTreeCandidates(documentTarget.tabId, documentTarget.frameId, documentTarget.documentId);
  let entries: readonly ChromeScriptingInjectionResult<PageTreeProjectionEnvelope>[];
  try {
    entries = await chrome.scripting.executeScript({
      target: documentTarget.documentId === null
        ? { tabId: documentTarget.tabId, frameIds: [0] }
        : { tabId: documentTarget.tabId, documentIds: [documentTarget.documentId] },
      world: "ISOLATED",
      func: projectPageTree,
      args: ["open", null, keyId, null, resolvedLimits(), candidates.map((candidate) => candidate.treeRef)],
    });
  } catch {
    assertResolvedTabTarget(tabTarget);
    if (documentTarget.documentId !== null) {
      throw new PageTreeServiceError("TARGET_REF_STALE", "DocumentRef no longer resolves to an injectable document");
    }
    throw new CapabilityUnavailableError(
      "platform.extension.scripting",
      "CHROMIUM_API_FAILED",
      "Chromium could not open the target page operation tree",
    );
  }
  assertResolvedTabTarget(tabTarget);
  const entry = entries[0];
  if (
    entries.length !== 1 || entry === undefined || entry.frameId !== documentTarget.frameId || entry.documentId.length === 0 ||
    documentTarget.documentId !== null && entry.documentId !== documentTarget.documentId || entry.result === undefined
  ) {
    throw new PageTreeServiceError("TARGET_REF_STALE", "Page-tree result no longer matches the requested document");
  }
  if (entry.result === null) {
    throw new PageTreeServiceError("DOM_OPERATION_FAILED", "Chromium did not return a page-tree open result");
  }
  const projection = await consumeTreeProjection(entry.result, entry.documentId, candidates);
  if (!projection.ok) return mapProjectionFailure(projection);
  if (projection.operation !== "open" || !isPageTreeRefShape(projection.rootRef)) {
    throw new PageTreeServiceError("DOM_OPERATION_FAILED", "Chromium returned the wrong page-tree open result");
  }
  const documentRef = documentTarget.documentRef ?? registerDocumentRef(
    documentTarget.tabRef,
    documentTarget.tabId,
    documentTarget.frameId,
    entry.documentId,
  );
  const target: PageTreeTarget = {
    rootRef: projection.rootRef,
    tabId: documentTarget.tabId,
    frameId: documentTarget.frameId,
    documentId: entry.documentId,
  };
  await registerTreeTargets(target, [projection.rootRef]);
  return {
    tabRef: documentTarget.tabRef,
    documentRef,
    frameId: documentTarget.frameId,
    url: projection.url,
    title: projection.title,
    rootRef: projection.rootRef,
    reused: projection.reused,
    limitations: projection.limitations,
  };
}

export async function expandPageTree(treeRef: string, keyId: string): Promise<PageTreeExpandResult> {
  const treeTarget = await requiredTreeTarget(treeRef);
  const tabTarget = await resolveCurrentTabTarget(treeTarget.tabId);
  await assertScriptingTargetAvailable(tabTarget);
  assertResolvedTabTarget(tabTarget);
  const candidates = await routedTreeCandidates(treeTarget.tabId, treeTarget.frameId, treeTarget.documentId);
  let entries: readonly ChromeScriptingInjectionResult<PageTreeProjectionEnvelope>[];
  try {
    entries = await chrome.scripting.executeScript({
      target: { tabId: treeTarget.tabId, documentIds: [treeTarget.documentId] },
      world: "ISOLATED",
      func: projectPageTree,
      args: ["expand", treeRef, keyId, null, resolvedLimits(), candidates.map((candidate) => candidate.treeRef)],
    });
  } catch {
    assertResolvedTabTarget(tabTarget);
    throw new PageTreeServiceError("TARGET_REF_STALE", "TreeRef no longer resolves to an injectable document");
  }
  assertResolvedTabTarget(tabTarget);
  const entry = entries[0];
  if (
    entries.length !== 1 || entry === undefined || entry.documentId !== treeTarget.documentId || entry.frameId !== treeTarget.frameId ||
    entry.result === undefined
  ) {
    throw new PageTreeServiceError("TARGET_REF_STALE", "TreeRef result no longer matches the target document");
  }
  if (entry.result === null) {
    throw new PageTreeServiceError("DOM_OPERATION_FAILED", "Chromium did not return a page-tree expansion result");
  }
  const projection = await consumeTreeProjection(entry.result, entry.documentId, candidates);
  if (!projection.ok) return mapProjectionFailure(projection);
  if (
    projection.operation !== "expand" || projection.treeRef !== treeRef ||
    projection.rootRef !== treeTarget.rootRef || projection.expanded !== true
  ) {
    throw new PageTreeServiceError("DOM_OPERATION_FAILED", "Chromium returned the wrong page-tree expansion result");
  }
  const documentRef = currentDocumentRef(treeTarget, tabTarget.tabRef);
  return {
    tabRef: tabTarget.tabRef,
    documentRef,
    rootRef: treeTarget.rootRef,
    treeRef,
    expanded: true,
  };
}

export function getPageTreeView(keyId: string, request: PageTreeViewRequest): Promise<PageTreeViewResult> {
  return readPageTreeProjection(keyId, request, "view");
}

export function findPageTree(keyId: string, request: PageTreeFindRequest): Promise<PageTreeViewResult> {
  return readPageTreeProjection(keyId, request, "find");
}

async function readPageTreeProjection(keyId: string, request: PageTreeViewRequest | PageTreeFindRequest, operation: "view" | "find"): Promise<PageTreeViewResult> {
  const treeTarget = await requiredTreeTarget(request.rootRef);
  if (request.rootRef !== treeTarget.rootRef) {
    throw new PageTreeServiceError("TARGET_REF_STALE", "View root is not an operation-tree root");
  }
  const tabTarget = await resolveCurrentTabTarget(treeTarget.tabId);
  await assertScriptingTargetAvailable(tabTarget);
  assertResolvedTabTarget(tabTarget);
  const { rootRef, ...viewOptions } = request;
  const candidates = await routedTreeCandidates(treeTarget.tabId, treeTarget.frameId, treeTarget.documentId);
  let entries: readonly ChromeScriptingInjectionResult<PageTreeProjectionEnvelope>[];
  try {
    entries = await chrome.scripting.executeScript({
      target: { tabId: treeTarget.tabId, documentIds: [treeTarget.documentId] },
      world: "ISOLATED",
      func: projectPageTree,
      args: [operation, rootRef, keyId, viewOptions, resolvedLimits(), candidates.map((candidate) => candidate.treeRef)],
    });
  } catch {
    assertResolvedTabTarget(tabTarget);
    throw new PageTreeServiceError("TARGET_REF_STALE", "Operation-tree root no longer resolves to an injectable document");
  }
  assertResolvedTabTarget(tabTarget);
  const entry = entries[0];
  if (
    entries.length !== 1 || entry === undefined || entry.documentId !== treeTarget.documentId || entry.frameId !== treeTarget.frameId ||
    entry.result === undefined
  ) {
    throw new PageTreeServiceError("TARGET_REF_STALE", "Operation-tree view no longer matches the target document");
  }
  if (entry.result === null) {
    throw new PageTreeServiceError("DOM_OPERATION_FAILED", "Chromium did not return an operation-tree view result");
  }
  const projection = await consumeTreeProjection(entry.result, entry.documentId, candidates);
  if (!projection.ok) return mapProjectionFailure(projection);
  if (projection.operation !== operation || projection.rootRef !== request.rootRef) {
    throw new PageTreeServiceError("DOM_OPERATION_FAILED", "Chromium returned the wrong page-tree view result");
  }
  const documentRef = currentDocumentRef(treeTarget, tabTarget.tabRef);
  const refs = returnedRefs(projection.items);
  await registerReturnedRefs(treeTarget, documentRef, refs);
  return {
    tabRef: tabTarget.tabRef,
    documentRef,
    rootRef: request.rootRef,
    items: projection.items,
    truncated: projection.truncated,
    nextIndexPath: projection.nextIndexPath,
  };
}
