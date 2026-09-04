import { COMMAND_CATALOG } from "../generated/command-config.js";
import { assertScriptingTargetAvailable } from "./browser-service.js";
import { CapabilityUnavailableError } from "./capability-error.js";
import { linearGlobMatch } from "./glob.js";
import { assertResolvedTabTarget, resolveTabTarget } from "./tab-service.js";

const DOCUMENT_REF_PATTERN = /^dr1\.[A-Za-z0-9_-]{43}$/u;
const NODE_REF_PATTERN = /^nr1\.[A-Za-z0-9_-]{43}$/u;
const GENERATION_ATTEMPTS = 8;
const encoder = new TextEncoder();

export interface FrameSummary {
  readonly documentRef: string | null;
  readonly frameId: number;
  readonly parentFrameId: number;
  readonly url: string;
  readonly urlTruncated: boolean;
  readonly errorOccurred: boolean;
  readonly documentLifecycle: string | null;
}

export interface FramesListResult {
  readonly tabRef: string;
  readonly items: readonly FrameSummary[];
  readonly truncated: boolean;
}

export interface DomRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DomDescriptor {
  readonly tagName: string;
  readonly id: string | null;
  readonly classes: readonly string[];
  readonly role: string | null;
  readonly name: string | null;
  readonly text: string | null;
  readonly value: string | null;
  readonly checked: boolean | null;
  readonly disabled: boolean;
  readonly selected: boolean | null;
  readonly rect: DomRect;
}

export interface DomQueryItem {
  readonly nodeRef: string;
  readonly descriptor: DomDescriptor;
}

export interface DomNodeTarget {
  readonly kind: "node";
  readonly nodeRef: string;
}

export interface DomLocatorTarget {
  readonly kind: "locator";
  readonly tabRef: string;
  readonly framePath: readonly DomFrameLocator[];
  readonly selector: string | null;
  readonly role: string | null;
  readonly name: string | null;
  readonly nameMatch: "exact" | "contains";
  readonly match: "unique" | "first";
}

export interface DomFrameLocator {
  readonly urlPattern: string;
  readonly match: "unique" | "first";
}

export type DomTarget = DomNodeTarget | DomLocatorTarget;

export interface DomTargetObservation {
  readonly status: "absent" | "matched";
  readonly nodeRef: string | null;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly unobstructed: boolean;
  readonly focused: boolean;
  readonly text: string | null;
  readonly value: string | null;
  readonly selectedValues: readonly string[];
  readonly rect: DomRect | null;
}

export interface SearchScrollResult {
  readonly tabRef: string;
  readonly moved: boolean;
  readonly frameMatched: boolean;
  readonly nextCursor: number;
  readonly contextKind: "document" | "element" | null;
  readonly contextCount: number;
  readonly scanTruncated: boolean;
  readonly scope: { readonly documentId: string; readonly topologyToken: string } | null;
}

interface DocumentTarget {
  readonly documentRef: string;
  readonly tabRef: string;
  readonly tabId: number;
  readonly frameId: number;
  readonly documentId: string;
  readonly createdAt: number;
}

interface NodeTarget extends DocumentTarget {
  readonly nodeRef: string;
}

export interface DocumentRefTarget {
  readonly documentRef: string;
  readonly tabRef: string;
  readonly tabId: number;
  readonly frameId: number;
  readonly documentId: string;
  readonly createdAt: number;
}

export interface NodeRefTarget extends DocumentRefTarget {
  readonly nodeRef: string;
}

export interface RealClickPreparation {
  readonly point: { readonly x: number; readonly y: number };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly originalTitle: string;
}

export interface KeyboardWindowMarker {
  readonly tabId: number;
  readonly documentId: string;
  readonly originalTitle: string;
}

type DomAction = "click" | "describe" | "focus" | "insertText" | "scroll" | "select" | "setValue";

interface DomActionPayload {
  readonly text?: string;
  readonly value?: string;
  readonly values?: readonly string[];
  readonly preventScroll?: boolean;
  readonly behavior?: "auto" | "smooth";
  readonly block?: "center" | "end" | "nearest" | "start";
  readonly inline?: "center" | "end" | "nearest" | "start";
}

export class DomServiceError extends Error {
  readonly code: "DOM_OPERATION_FAILED" | "LIMIT_EXCEEDED" | "TARGET_AMBIGUOUS" | "TARGET_REF_STALE";

  constructor(code: "DOM_OPERATION_FAILED" | "LIMIT_EXCEEDED" | "TARGET_AMBIGUOUS" | "TARGET_REF_STALE", message: string) {
    super(message);
    this.name = "DomServiceError";
    this.code = code;
  }
}

const documents = new Map<string, DocumentTarget>();
const documentRefsByIdentity = new Map<string, string>();
const nodes = new Map<string, NodeTarget>();

function limit(pointId: string): number {
  const value = COMMAND_CATALOG.limits[pointId as keyof typeof COMMAND_CATALOG.limits];
  if (typeof value !== "number") throw new Error(`Missing generated integer Freedom Point: ${pointId}`);
  return value;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  let index = 0;
  while (index < bytes.length) {
    binary += String.fromCharCode(bytes[index] ?? 0);
    index += 1;
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function randomRef(prefix: "dr1" | "nr1", existing: ReadonlyMap<string, unknown>): string {
  let attempt = 0;
  while (attempt < GENERATION_ATTEMPTS) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const candidate = `${prefix}.${base64Url(bytes)}`;
    if (!existing.has(candidate)) return candidate;
    attempt += 1;
  }
  throw new Error(`Unable to allocate ${prefix} reference within the bounded attempt limit`);
}

function pruneRefs(): void {
  const cutoff = Date.now() - limit("command.dom.reference_ttl_ms");
  for (const [nodeRef, target] of nodes) {
    if (target.createdAt < cutoff) nodes.delete(nodeRef);
  }
  for (const [documentRef, target] of documents) {
    if (target.createdAt >= cutoff) continue;
    documents.delete(documentRef);
    documentRefsByIdentity.delete(`${target.tabRef}\n${target.frameId}\n${target.documentId}`);
  }
}

function boundedText(value: string): { readonly value: string; readonly truncated: boolean } {
  const maximumBytes = limit("command.tabs.maximum_text_bytes");
  const characters: string[] = [];
  let usedBytes = 0;
  for (const character of value) {
    const bytes = encoder.encode(character).byteLength;
    if (usedBytes + bytes > maximumBytes) return { value: characters.join(""), truncated: true };
    characters.push(character);
    usedBytes += bytes;
  }
  return { value, truncated: false };
}

function documentRefFor(
  tabRef: string,
  tabId: number,
  frameId: number,
  documentId: string | undefined,
): string | null {
  if (documentId === undefined || documentId.length === 0) return null;
  pruneRefs();
  const identity = `${tabRef}\n${frameId}\n${documentId}`;
  const currentRef = documentRefsByIdentity.get(identity);
  if (currentRef !== undefined && documents.has(currentRef)) return currentRef;
  if (documents.size >= limit("command.dom.maximum_document_refs")) return null;
  const documentRef = randomRef("dr1", documents);
  documents.set(documentRef, { documentRef, tabRef, tabId, frameId, documentId, createdAt: Date.now() });
  documentRefsByIdentity.set(identity, documentRef);
  return documentRef;
}

export function registerDocumentRef(
  tabRef: string,
  tabId: number,
  frameId: number,
  documentId: string,
): string {
  const documentRef = documentRefFor(tabRef, tabId, frameId, documentId);
  if (documentRef === null) {
    throw new DomServiceError("LIMIT_EXCEEDED", "DocumentRef capacity is exhausted");
  }
  return documentRef;
}

export function registerNodeRefsForDocument(documentRef: string, nodeRefs: readonly string[]): void {
  const documentTarget = requiredDocument(documentRef);
  const now = Date.now();
  for (const nodeRef of nodeRefs) {
    if (!isNodeRefShape(nodeRef)) {
      throw new DomServiceError("DOM_OPERATION_FAILED", "Page returned an invalid NodeRef token");
    }
    nodes.set(nodeRef, { ...documentTarget, nodeRef, createdAt: now });
  }
}

export function isDocumentRefShape(value: unknown): value is string {
  return typeof value === "string" && DOCUMENT_REF_PATTERN.test(value);
}

export function isNodeRefShape(value: unknown): value is string {
  return typeof value === "string" && NODE_REF_PATTERN.test(value);
}

export async function listFrames(tabRef: string, requestedLimit: number): Promise<FramesListResult> {
  const target = await resolveTabTarget(tabRef);
  let frames: readonly ChromeWebNavigationFrame[];
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId: target.tabId });
  } catch {
    assertResolvedTabTarget(target);
    throw new CapabilityUnavailableError(
      "platform.extension.web_navigation",
      "CHROMIUM_API_FAILED",
      "Chromium could not list frames for the target tab",
    );
  }
  assertResolvedTabTarget(target);
  const maximum = Math.min(requestedLimit, limit("command.frames.list.maximum_items"));
  const items: FrameSummary[] = [];
  let index = 0;
  while (index < frames.length && items.length < maximum) {
    const frame = frames[index];
    if (frame !== undefined) {
      const url = boundedText(frame.url);
      const baseItem: FrameSummary = {
        documentRef: frame.documentId === undefined || frame.documentId.length === 0
          ? null
          : `dr1.${"A".repeat(43)}`,
        frameId: frame.frameId,
        parentFrameId: frame.parentFrameId,
        url: url.value,
        urlTruncated: url.truncated,
        errorOccurred: frame.errorOccurred === true,
        documentLifecycle: frame.documentLifecycle ?? null,
      };
      const candidateBytes = encoder.encode(JSON.stringify({
        tabRef,
        items: [...items, baseItem],
        truncated: true,
      })).byteLength;
      if (candidateBytes > limit("command.inline.maximum_result_json_bytes")) break;
      items.push({
        ...baseItem,
        documentRef: documentRefFor(tabRef, target.tabId, frame.frameId, frame.documentId),
      });
    }
    index += 1;
  }
  return { tabRef, items, truncated: index < frames.length };
}

function queryDocument(
  selector: string,
  maximumResults: number,
  maximumRegistryEntries: number,
  ttlMs: number,
  maximumTextCharacters: number,
  maximumResultBytes: number,
):
  | { readonly ok: true; readonly items: readonly DomQueryItem[]; readonly truncated: boolean }
  | { readonly ok: false; readonly reason: "capacity" | "selector" } {
  type RectLike = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  type ElementLike = {
    readonly tagName: string;
    readonly id: string;
    readonly classList: Iterable<string>;
    readonly textContent: string | null;
    readonly value?: unknown;
    readonly checked?: unknown;
    readonly disabled?: unknown;
    readonly selected?: unknown;
    getAttribute(name: string): string | null;
    getBoundingClientRect(): RectLike;
    matches(selector: string): boolean;
  };
  type TextNodeLike = { readonly nodeValue: string | null };
  interface RegistryEntry { readonly element: ElementLike; readonly expiresAt: number }
  interface Registry {
    readonly nodes: Map<string, RegistryEntry>;
    readonly reverse: WeakMap<object, string>;
  }
  const page = globalThis as unknown as {
    readonly document: {
      readonly documentElement?: ElementLike | null;
      querySelector(selector: string): ElementLike | null;
      createTreeWalker(
        root: ElementLike,
        whatToShow: number,
      ): { nextNode(): ElementLike | TextNodeLike | null };
    };
    readonly NodeFilter: { readonly SHOW_ELEMENT: number; readonly SHOW_TEXT: number };
    readonly performance: { now(): number };
    readonly crypto: Crypto;
    __BKA_DOM_NODE_REGISTRY_V1__?: Registry;
  };
  try {
    page.document.querySelector(selector);
  } catch {
    return { ok: false, reason: "selector" };
  }
  const now = page.performance.now();
  const registry = page.__BKA_DOM_NODE_REGISTRY_V1__ ?? { nodes: new Map(), reverse: new WeakMap() };
  page.__BKA_DOM_NODE_REGISTRY_V1__ = registry;
  for (const [token, entry] of registry.nodes) {
    if (entry.expiresAt <= now) registry.nodes.delete(token);
  }
  const matched: ElementLike[] = [];
  let truncated = false;
  const root = page.document.documentElement;
  if (root !== null && root !== undefined) {
    const walker = page.document.createTreeWalker(root, page.NodeFilter.SHOW_ELEMENT);
    let current: ElementLike | null = root;
    while (current !== null) {
      if (current.matches(selector)) {
        if (matched.length >= maximumResults) {
          truncated = true;
          break;
        }
        matched.push(current);
      }
      current = walker.nextNode() as ElementLike | null;
    }
  }

  const makeToken = (): string => {
    const bytes = new Uint8Array(32);
    page.crypto.getRandomValues(bytes);
    let binary = "";
    let byteIndex = 0;
    while (byteIndex < bytes.length) {
      binary += String.fromCharCode(bytes[byteIndex] ?? 0);
      byteIndex += 1;
    }
    return `nr1.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
  };
  const textPreview = (element: ElementLike): string => {
    const walker = page.document.createTreeWalker(element, page.NodeFilter.SHOW_TEXT);
    let output = "";
    let node = walker.nextNode() as TextNodeLike | null;
    while (node !== null && output.length < maximumTextCharacters) {
      const raw = output.length === 0 ? (node.nodeValue ?? "").trimStart() : (node.nodeValue ?? "");
      output += raw.slice(0, maximumTextCharacters - output.length);
      node = walker.nextNode() as TextNodeLike | null;
    }
    return output.trim();
  };
  const classPreview = (element: ElementLike): string[] => {
    const classes: string[] = [];
    for (const value of element.classList) {
      if (classes.length >= 20) break;
      classes.push(value.slice(0, maximumTextCharacters));
    }
    return classes;
  };
  const describe = (element: ElementLike): DomDescriptor => {
    const rect = element.getBoundingClientRect();
    const text = textPreview(element);
    const role = element.getAttribute("role");
    const labelled = element.getAttribute("aria-label") ?? element.getAttribute("title") ?? text;
    return {
      tagName: element.tagName.toLowerCase().slice(0, maximumTextCharacters),
      id: element.id.length === 0 ? null : element.id.slice(0, maximumTextCharacters),
      classes: classPreview(element),
      role: role === null ? null : role.slice(0, maximumTextCharacters),
      name: labelled.length === 0 ? null : labelled.slice(0, maximumTextCharacters),
      text: text.length === 0 ? null : text.slice(0, maximumTextCharacters),
      value: typeof element.value === "string" ? element.value.slice(0, maximumTextCharacters) : null,
      checked: typeof element.checked === "boolean" ? element.checked : null,
      disabled: element.matches(":disabled"),
      selected: typeof element.selected === "boolean" ? element.selected : null,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  };
  const resultEncoder = new TextEncoder();
  const emptyResultBytes = resultEncoder.encode(JSON.stringify({ items: [], truncated: true })).byteLength;
  const prepared: { readonly element: ElementLike; readonly descriptor: DomDescriptor }[] = [];
  let preparedItemBytes = 0;
  const placeholderNodeRef = `nr1.${"A".repeat(43)}`;
  for (const element of matched) {
    const descriptor = describe(element);
    const itemBytes = resultEncoder.encode(JSON.stringify({ nodeRef: placeholderNodeRef, descriptor })).byteLength;
    const separatorBytes = prepared.length === 0 ? 0 : 1;
    if (emptyResultBytes + preparedItemBytes + separatorBytes + itemBytes > maximumResultBytes) {
      truncated = true;
      break;
    }
    prepared.push({ element, descriptor });
    preparedItemBytes += separatorBytes + itemBytes;
  }
  let newEntries = 0;
  for (const entry of prepared) {
    const existing = registry.reverse.get(entry.element as object);
    if (existing === undefined || !registry.nodes.has(existing)) newEntries += 1;
  }
  if (registry.nodes.size + newEntries > maximumRegistryEntries) return { ok: false, reason: "capacity" };

  const items: DomQueryItem[] = [];
  for (const entry of prepared) {
    const element = entry.element;
    let nodeRef = registry.reverse.get(element as object);
    if (nodeRef === undefined || !registry.nodes.has(nodeRef)) {
      nodeRef = makeToken();
      registry.reverse.set(element as object, nodeRef);
      registry.nodes.set(nodeRef, { element, expiresAt: now + ttlMs });
    }
    items.push({ nodeRef, descriptor: entry.descriptor });
  }
  return { ok: true, items, truncated };
}

function observeTargetDocument(
  nodeRef: string | null,
  locator: Pick<DomLocatorTarget, "selector" | "role" | "name" | "nameMatch" | "match"> | null,
  maximumScanNodes: number,
  maximumRegistryEntries: number,
  ttlMs: number,
  maximumTextCharacters: number,
):
  | (DomTargetObservation & { readonly reason: null })
  | { readonly status: "ambiguous" | "capacity" | "scan_limit" | "selector" | "stale"; readonly reason: string } {
  type RectLike = {
    readonly x: number; readonly y: number; readonly width: number; readonly height: number;
    readonly left: number; readonly top: number; readonly right: number; readonly bottom: number;
  };
  type ElementLike = {
    readonly tagName: string;
    readonly id: string;
    readonly classList: Iterable<string>;
    readonly textContent: string | null;
    readonly isConnected: boolean;
    readonly ownerDocument: unknown;
    readonly labels?: Iterable<ElementLike>;
    readonly options?: Iterable<{ readonly value: string; readonly selected: boolean }>;
    readonly value?: unknown;
    readonly shadowRoot?: { elementFromPoint(x: number, y: number): ElementLike | null } | null;
    getAttribute(name: string): string | null;
    getBoundingClientRect(): RectLike;
    getClientRects(): Iterable<RectLike> & { readonly length: number };
    matches(selector: string): boolean;
    contains(node: object | null): boolean;
  };
  type TextNodeLike = { readonly nodeValue: string | null };
  interface RegistryEntry { readonly element: ElementLike; readonly expiresAt: number }
  interface Registry { readonly nodes: Map<string, RegistryEntry>; readonly reverse: WeakMap<object, string> }
  const page = globalThis as unknown as {
    readonly innerWidth: number;
    readonly innerHeight: number;
    readonly performance: { now(): number };
    readonly crypto: Crypto;
    readonly document: {
      readonly documentElement?: ElementLike | null;
      readonly activeElement?: ElementLike | null;
      createTreeWalker(root: ElementLike, whatToShow: number): { nextNode(): ElementLike | TextNodeLike | null };
      elementFromPoint(x: number, y: number): ElementLike | null;
      getElementById(id: string): ElementLike | null;
    };
    readonly NodeFilter: { readonly SHOW_ELEMENT: number; readonly SHOW_TEXT: number };
    getComputedStyle(element: ElementLike): { readonly visibility: string; readonly display: string; readonly opacity: string };
    __BKA_DOM_NODE_REGISTRY_V1__?: Registry;
  };
  const failure = (status: "ambiguous" | "capacity" | "scan_limit" | "selector" | "stale", reason: string) => ({ status, reason });
  const absent = (): DomTargetObservation & { readonly reason: null } => ({
    status: "absent", nodeRef: null, visible: false, enabled: false, unobstructed: false, focused: false,
    text: null, value: null, selectedValues: [], rect: null, reason: null,
  });
  const now = page.performance.now();
  const registry = page.__BKA_DOM_NODE_REGISTRY_V1__ ?? { nodes: new Map(), reverse: new WeakMap() };
  page.__BKA_DOM_NODE_REGISTRY_V1__ = registry;
  for (const [token, entry] of registry.nodes) {
    if (entry.expiresAt <= now) registry.nodes.delete(token);
  }
  const root = page.document.documentElement;
  let remainingTextNodes = maximumScanNodes;
  let textScanExhausted = false;
  const textPreview = (element: ElementLike): string => {
    const walker = page.document.createTreeWalker(element, page.NodeFilter.SHOW_TEXT);
    let output = "";
    let current = walker.nextNode() as TextNodeLike | null;
    while (current !== null && output.length < maximumTextCharacters && remainingTextNodes > 0) {
      remainingTextNodes -= 1;
      const value = output.length === 0 ? (current.nodeValue ?? "").trimStart() : (current.nodeValue ?? "");
      output += value.slice(0, maximumTextCharacters - output.length);
      current = walker.nextNode() as TextNodeLike | null;
    }
    if (current !== null && output.length < maximumTextCharacters && remainingTextNodes === 0) textScanExhausted = true;
    return output.trim();
  };
  const implicitRole = (element: ElementLike): string | null => {
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    if (tag === "button") return "button";
    if ((tag === "a" || tag === "area") && element.getAttribute("href") !== null) return "link";
    if (tag === "select") return element.getAttribute("multiple") === null ? "combobox" : "listbox";
    if (tag === "textarea") return "textbox";
    if (tag === "option") return "option";
    if (tag === "img") return "img";
    if (/^h[1-6]$/u.test(tag)) return "heading";
    if (tag === "li") return "listitem";
    if (tag === "ul" || tag === "ol") return "list";
    if (tag !== "input") return null;
    if (["button", "image", "reset", "submit"].includes(type)) return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (type === "number") return "spinbutton";
    if (type === "hidden") return null;
    return "textbox";
  };
  const accessibleName = (element: ElementLike): string => {
    const direct = element.getAttribute("aria-label")?.trim();
    if (direct !== undefined && direct.length > 0) return direct.slice(0, maximumTextCharacters);
    const labelledBy = element.getAttribute("aria-labelledby")?.trim();
    if (labelledBy !== undefined && labelledBy.length > 0) {
      let output = "";
      const ids = labelledBy.split(/\s+/u);
      let index = 0;
      while (index < ids.length && index < 16 && output.length < maximumTextCharacters) {
        const labelledElement = page.document.getElementById(ids[index] ?? "");
        const text = labelledElement === null ? "" : textPreview(labelledElement)
          .slice(0, maximumTextCharacters - output.length);
        if (text.length > 0) output += `${output.length === 0 ? "" : " "}${text}`;
        index += 1;
      }
      if (output.length > 0) return output.slice(0, maximumTextCharacters);
    }
    if (element.labels !== undefined) {
      let output = "";
      let count = 0;
      for (const label of element.labels) {
        if (count >= 8 || output.length >= maximumTextCharacters) break;
        const text = textPreview(label).slice(0, maximumTextCharacters - output.length);
        if (text.length > 0) output += `${output.length === 0 ? "" : " "}${text}`;
        count += 1;
      }
      if (output.length > 0) return output.slice(0, maximumTextCharacters);
    }
    for (const attribute of ["alt", "value", "title"]) {
      const value = element.getAttribute(attribute)?.trim();
      if (value !== undefined && value.length > 0) return value.slice(0, maximumTextCharacters);
    }
    return textPreview(element).slice(0, maximumTextCharacters);
  };
  let element: ElementLike | null = null;
  if (nodeRef !== null) {
    const entry = registry.nodes.get(nodeRef);
    if (entry === undefined || entry.expiresAt <= now || !entry.element.isConnected || entry.element.ownerDocument !== page.document) {
      registry.nodes.delete(nodeRef);
      return failure("stale", "The exact NodeRef is no longer live");
    }
    element = entry.element;
  } else {
    if (locator === null || root === null || root === undefined) return absent();
    // Chromium's executeScript argument bridge can surface nested null fields as
    // undefined. The command parser has already validated the public shape, so
    // normalize the injected copy once before applying the AND locator rules.
    const requestedSelector = typeof locator.selector === "string" ? locator.selector : null;
    const requestedRole = typeof locator.role === "string" ? locator.role : null;
    const requestedName = typeof locator.name === "string" ? locator.name : null;
    if (requestedSelector !== null) {
      try { root.matches(requestedSelector); }
      catch { return failure("selector", "The locator CSS selector is invalid"); }
    }
    const walker = page.document.createTreeWalker(root, page.NodeFilter.SHOW_ELEMENT);
    let current: ElementLike | null = root;
    let scanned = 0;
    while (current !== null) {
      scanned += 1;
      if (scanned > maximumScanNodes) return failure("scan_limit", "The locator scan bound was reached");
      const selectorMatches = requestedSelector === null || current.matches(requestedSelector);
      const role = current.getAttribute("role") ?? implicitRole(current);
      const roleMatches = requestedRole === null || role === requestedRole;
      let nameMatches = requestedName === null;
      if (!nameMatches && selectorMatches && roleMatches) {
        const name = accessibleName(current);
        if (textScanExhausted) return failure("scan_limit", "The locator accessible-name scan bound was reached");
        nameMatches = locator.nameMatch === "exact" ? name === requestedName : name.includes(requestedName ?? "");
      }
      if (selectorMatches && roleMatches && nameMatches) {
        if (element !== null && locator.match === "unique") return failure("ambiguous", "The unique locator matched more than one element");
        element = current;
        if (locator.match === "first") break;
      }
      current = walker.nextNode() as ElementLike | null;
    }
    if (element === null) return absent();
  }
  const matchedElement = element;
  if (matchedElement === null) return absent();
  let resolvedNodeRef = nodeRef ?? registry.reverse.get(matchedElement as object);
  if (resolvedNodeRef === undefined || !registry.nodes.has(resolvedNodeRef)) {
    if (registry.nodes.size >= maximumRegistryEntries) return failure("capacity", "NodeRef capacity is exhausted");
    let attempt = 0;
    while (attempt < 8) {
      const bytes = new Uint8Array(32);
      page.crypto.getRandomValues(bytes);
      let binary = "";
      let byteIndex = 0;
      while (byteIndex < bytes.length) {
        binary += String.fromCharCode(bytes[byteIndex] ?? 0);
        byteIndex += 1;
      }
      const candidate = `nr1.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
      if (!registry.nodes.has(candidate)) { resolvedNodeRef = candidate; break; }
      attempt += 1;
    }
    if (resolvedNodeRef === undefined) return failure("capacity", "Could not allocate a unique NodeRef");
    registry.reverse.set(matchedElement as object, resolvedNodeRef);
  }
  registry.nodes.set(resolvedNodeRef, { element: matchedElement, expiresAt: now + ttlMs });
  const rect = matchedElement.getBoundingClientRect();
  const style = page.getComputedStyle(matchedElement);
  const visible = matchedElement.getClientRects().length !== 0 && rect.width > 0 && rect.height > 0 &&
    style.visibility !== "hidden" && style.visibility !== "collapse" && style.display !== "none" && style.opacity !== "0";
  const enabled = !matchedElement.matches(":disabled") && matchedElement.getAttribute("aria-disabled") !== "true";
  let unobstructed = false;
  if (visible && page.innerWidth > 0 && page.innerHeight > 0) {
    let rectCount = 0;
    for (const clientRect of matchedElement.getClientRects()) {
      if (rectCount >= 32 || unobstructed) break;
      const left = Math.max(0, clientRect.left);
      const top = Math.max(0, clientRect.top);
      const right = Math.min(page.innerWidth, clientRect.right);
      const bottom = Math.min(page.innerHeight, clientRect.bottom);
      if (right > left && bottom > top) {
        for (const xPart of [0.5, 0.25, 0.75]) {
          if (unobstructed) break;
          for (const yPart of [0.5, 0.25, 0.75]) {
            const x = left + ((right - left) * xPart);
            const y = top + ((bottom - top) * yPart);
            let hit = page.document.elementFromPoint(x, y);
            let depth = 0;
            while (hit?.shadowRoot !== null && hit?.shadowRoot !== undefined && depth < 16) {
              const nested = hit.shadowRoot.elementFromPoint(x, y);
              if (nested === null || nested === hit) break;
              hit = nested;
              depth += 1;
            }
            if (hit === matchedElement || matchedElement.contains(hit as object | null)) { unobstructed = true; break; }
          }
        }
      }
      rectCount += 1;
    }
  }
  const selectedValues: string[] = [];
  if (matchedElement.options !== undefined) {
    let totalCharacters = 0;
    for (const option of matchedElement.options) {
      if (!option.selected) continue;
      const value = option.value.slice(0, maximumTextCharacters);
      if (selectedValues.length >= 64 || totalCharacters + value.length > maximumTextCharacters * 4) break;
      selectedValues.push(value);
      totalCharacters += value.length;
    }
  }
  const text = textPreview(matchedElement);
  if (textScanExhausted) return failure("scan_limit", "The matched target text scan bound was reached");
  return {
    status: "matched",
    nodeRef: resolvedNodeRef,
    visible,
    enabled,
    unobstructed,
    focused: page.document.activeElement === matchedElement,
    text: text.length === 0 ? null : text,
    value: typeof matchedElement.value === "string" ? matchedElement.value.slice(0, maximumTextCharacters) : null,
    selectedValues,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    reason: null,
  };
}

function searchScrollDocument(
  percent: number,
  cursor: number,
  maximumScanNodes: number,
  maximumContexts: number,
  expectedTopologyToken: string | null,
): Omit<SearchScrollResult, "tabRef" | "frameMatched" | "scope"> & { readonly topologyToken: string } {
  const page = globalThis as unknown as {
    readonly document: {
      readonly body?: ScrollElement | null;
      readonly documentElement?: ScrollElement | null;
      readonly scrollingElement?: ScrollElement | null;
      createTreeWalker(root: ScrollElement, whatToShow: number): { nextNode(): ScrollElement | null };
    };
    readonly NodeFilter: { readonly SHOW_ELEMENT: number };
    getComputedStyle(element: ScrollElement): { readonly display: string; readonly visibility: string; readonly overflowY: string };
    __BKA_SCROLL_CONTEXT_REGISTRY_V1__?: { readonly ids: WeakMap<object, number>; nextId: number };
  };
  type ScrollElement = {
    readonly isConnected?: boolean;
    readonly scrollHeight: number;
    readonly clientHeight: number;
    scrollTop: number;
    getBoundingClientRect(): { readonly width: number; readonly height: number };
  };
  const scrolling = page.document.scrollingElement;
  const contexts: { readonly element: ScrollElement; readonly kind: "document" | "element" }[] = [];
  const registry = page.__BKA_SCROLL_CONTEXT_REGISTRY_V1__ ?? { ids: new WeakMap<object, number>(), nextId: 1 };
  page.__BKA_SCROLL_CONTEXT_REGISTRY_V1__ = registry;
  let scanTruncated = false;
  const root = page.document.documentElement;
  if (root !== null && root !== undefined && maximumContexts > 0) {
    const walker = page.document.createTreeWalker(root, page.NodeFilter.SHOW_ELEMENT);
    let current: ScrollElement | null = root;
    let scanned = 0;
    while (current !== null) {
      scanned += 1;
      if (scanned > maximumScanNodes) {
        scanTruncated = true;
        break;
      }
      if (current !== scrolling && current !== page.document.documentElement && current !== page.document.body) {
        const style = page.getComputedStyle(current);
        const rect = current.getBoundingClientRect();
        const overflowAllowsScroll = style.overflowY === "auto" || style.overflowY === "scroll" || style.overflowY === "overlay";
        if (current.isConnected !== false && rect.width > 0 && rect.height > 0 && style.display !== "none" &&
            style.visibility !== "hidden" && overflowAllowsScroll && current.clientHeight > 0 &&
            current.scrollHeight > current.clientHeight + 1) {
          if (contexts.length >= maximumContexts) {
            scanTruncated = true;
            break;
          }
          contexts.push({ element: current, kind: "element" });
        }
      }
      current = walker.nextNode();
    }
  }
  if (scrolling !== null && scrolling !== undefined && scrolling.clientHeight > 0 &&
      scrolling.scrollHeight > scrolling.clientHeight + 1) {
    if (contexts.length >= maximumContexts) scanTruncated = true;
    else contexts.push({ element: scrolling, kind: "document" });
  }
  const contextIds: string[] = [];
  for (const context of contexts) {
    if (context.kind === "document") {
      contextIds.push("d");
      continue;
    }
    let contextId = registry.ids.get(context.element as object);
    if (contextId === undefined) {
      if (!Number.isSafeInteger(registry.nextId) || registry.nextId < 1) registry.nextId = 1;
      contextId = registry.nextId;
      registry.nextId += 1;
      registry.ids.set(context.element as object, contextId);
    }
    contextIds.push(`e${contextId}`);
  }
  const topologyToken = contextIds.join(".");
  if (scanTruncated || contexts.length === 0) {
    return { moved: false, nextCursor: 0, contextKind: null, contextCount: contexts.length, scanTruncated, topologyToken };
  }
  const effectiveCursor = expectedTopologyToken === topologyToken ? cursor : 0;
  const start = ((effectiveCursor % contexts.length) + contexts.length) % contexts.length;
  let offset = 0;
  while (offset < contexts.length) {
    const index = (start + offset) % contexts.length;
    const context = contexts[index];
    if (context !== undefined) {
      const maximum = Math.max(0, context.element.scrollHeight - context.element.clientHeight);
      const before = Math.max(0, Math.min(maximum, context.element.scrollTop));
      const step = Math.max(1, context.element.clientHeight * percent / 100);
      const next = Math.min(maximum, before + step);
      if (next > before) {
        context.element.scrollTop = next;
        const after = Math.max(0, Math.min(maximum, context.element.scrollTop));
        if (after > before) {
          return {
            moved: true,
            nextCursor: (index + 1) % contexts.length,
            contextKind: context.kind,
            contextCount: contexts.length,
            scanTruncated: false,
            topologyToken,
          };
        }
      }
    }
    offset += 1;
  }
  return { moved: false, nextCursor: start, contextKind: null, contextCount: contexts.length, scanTruncated: false, topologyToken };
}

function runNodeAction(
  nodeRef: string,
  action: DomAction,
  payload: DomActionPayload,
  maximumTextCharacters: number,
):
  | { readonly ok: true; readonly descriptor: DomDescriptor }
  | { readonly ok: false; readonly reason: "action" | "stale" } {
  type EventTargetLike = { dispatchEvent(event: Event): boolean };
  type RangeLike = {
    readonly commonAncestorContainer: unknown;
    collapse(toStart?: boolean): void;
    deleteContents(): void;
    insertNode(node: unknown): void;
    selectNodeContents(node: unknown): void;
    setStartAfter(node: unknown): void;
  };
  type SelectionLike = {
    readonly rangeCount: number;
    addRange(range: RangeLike): void;
    getRangeAt(index: number): RangeLike;
    removeAllRanges(): void;
  };
  type ElementLike = EventTargetLike & {
    readonly tagName: string;
    readonly id: string;
    readonly classList: Iterable<string>;
    textContent: string | null;
    readonly isConnected: boolean;
    readonly ownerDocument: unknown;
    readonly isContentEditable?: boolean;
    value?: unknown;
    selectionStart?: unknown;
    selectionEnd?: unknown;
    checked?: unknown;
    disabled?: unknown;
    selected?: unknown;
    readonly options?: Iterable<{ value: string; selected: boolean }>;
    contains(node: unknown): boolean;
    click?: () => void;
    focus?: (options?: { preventScroll?: boolean }) => void;
    setRangeText?: (replacement: string, start: number, end: number, selectionMode?: "end") => void;
    scrollIntoView?: (options?: Readonly<Record<string, unknown>>) => void;
    getAttribute(name: string): string | null;
    matches(selector: string): boolean;
    getBoundingClientRect(): { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  };
  type TextNodeLike = { readonly nodeValue: string | null };
  interface RegistryEntry { readonly element: ElementLike; readonly expiresAt: number }
  const page = globalThis as unknown as {
    readonly performance: { now(): number };
    readonly Event: new (type: string, init?: { bubbles?: boolean }) => Event;
    readonly InputEvent: new (type: string, init?: { bubbles?: boolean; cancelable?: boolean; composed?: boolean; inputType?: string; data?: string }) => Event;
    readonly document: {
      activeElement: ElementLike | null;
      createRange(): RangeLike;
      createTextNode(value: string): unknown;
      createTreeWalker(
        root: ElementLike,
        whatToShow: number,
      ): { nextNode(): TextNodeLike | null };
      getSelection(): SelectionLike | null;
    };
    readonly NodeFilter: { readonly SHOW_TEXT: number };
    __BKA_DOM_NODE_REGISTRY_V1__?: { readonly nodes: Map<string, RegistryEntry> };
  };
  const entry = page.__BKA_DOM_NODE_REGISTRY_V1__?.nodes.get(nodeRef);
  if (entry === undefined || entry.expiresAt <= page.performance.now()) return { ok: false, reason: "stale" };
  const element = entry.element;
  if (!element.isConnected || element.ownerDocument !== page.document) return { ok: false, reason: "stale" };
  try {
    if (action === "click") {
      if (element.click === undefined || element.matches(":disabled")) return { ok: false, reason: "action" };
      element.click();
    } else if (action === "setValue") {
      if (typeof payload.value !== "string") return { ok: false, reason: "action" };
      if ("value" in element) {
        element.value = payload.value;
        element.dispatchEvent(new page.Event("input", { bubbles: true }));
        element.dispatchEvent(new page.Event("change", { bubbles: true }));
      } else if (element.isContentEditable === true) {
        // Explicit plain-text replacement; not HTML insertion or a trusted keyboard event.
        element.textContent = payload.value;
        element.dispatchEvent(new page.InputEvent("input", {
          bubbles: true, composed: true, inputType: "insertReplacementText", data: payload.value,
        }));
      } else {
        return { ok: false, reason: "action" };
      }
    } else if (action === "insertText") {
      if (typeof payload.text !== "string" || payload.text.length === 0 || element.matches(":disabled") ||
          element.getAttribute("readonly") !== null || element.focus === undefined) return { ok: false, reason: "action" };
      element.focus({ preventScroll: true });
      const beforeInput = new page.InputEvent("beforeinput", {
        bubbles: true, cancelable: true, composed: true, inputType: "insertText", data: payload.text,
      });
      if (!element.dispatchEvent(beforeInput)) return { ok: false, reason: "action" };
      if (typeof element.value === "string" && typeof element.selectionStart === "number" &&
          typeof element.selectionEnd === "number" && element.setRangeText !== undefined) {
        element.setRangeText(payload.text, element.selectionStart, element.selectionEnd, "end");
      } else if (element.isContentEditable === true) {
        const selection = page.document.getSelection();
        if (selection === null) return { ok: false, reason: "action" };
        let range: RangeLike;
        if (selection.rangeCount > 0 && element.contains(selection.getRangeAt(0).commonAncestorContainer)) {
          range = selection.getRangeAt(0);
        } else {
          range = page.document.createRange();
          range.selectNodeContents(element);
          range.collapse(false);
        }
        range.deleteContents();
        const inserted = page.document.createTextNode(payload.text);
        range.insertNode(inserted);
        range.setStartAfter(inserted);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      } else {
        return { ok: false, reason: "action" };
      }
      element.dispatchEvent(new page.InputEvent("input", {
        bubbles: true, composed: true, inputType: "insertText", data: payload.text,
      }));
    } else if (action === "select") {
      if (payload.values === undefined || element.options === undefined) return { ok: false, reason: "action" };
      const selected = new Set(payload.values);
      for (const option of element.options) option.selected = selected.has(option.value);
      element.dispatchEvent(new page.Event("input", { bubbles: true }));
      element.dispatchEvent(new page.Event("change", { bubbles: true }));
    } else if (action === "focus") {
      if (element.focus === undefined) return { ok: false, reason: "action" };
      element.focus({ preventScroll: payload.preventScroll === true });
    } else if (action === "scroll") {
      if (element.scrollIntoView === undefined) return { ok: false, reason: "action" };
      element.scrollIntoView({
        behavior: payload.behavior,
        block: payload.block,
        inline: payload.inline,
      });
    }
  } catch {
    return { ok: false, reason: "action" };
  }
  const textWalker = page.document.createTreeWalker(element, page.NodeFilter.SHOW_TEXT);
  let text = "";
  let textNode = textWalker.nextNode();
  while (textNode !== null && text.length < maximumTextCharacters) {
    const raw = text.length === 0 ? (textNode.nodeValue ?? "").trimStart() : (textNode.nodeValue ?? "");
    text += raw.slice(0, maximumTextCharacters - text.length);
    textNode = textWalker.nextNode();
  }
  text = text.trim();
  const classes: string[] = [];
  for (const value of element.classList) {
    if (classes.length >= 20) break;
    classes.push(value.slice(0, maximumTextCharacters));
  }
  const rect = element.getBoundingClientRect();
  const labelled = element.getAttribute("aria-label") ?? element.getAttribute("title") ?? text;
  return {
    ok: true,
    descriptor: {
      tagName: element.tagName.toLowerCase().slice(0, maximumTextCharacters),
      id: element.id.length === 0 ? null : element.id.slice(0, maximumTextCharacters),
      classes,
      role: element.getAttribute("role")?.slice(0, maximumTextCharacters) ?? null,
      name: labelled.length === 0 ? null : labelled.slice(0, maximumTextCharacters),
      text: text.length === 0 ? null : text.slice(0, maximumTextCharacters),
      value: typeof element.value === "string" ? element.value.slice(0, maximumTextCharacters) : null,
      checked: typeof element.checked === "boolean" ? element.checked : null,
      disabled: element.matches(":disabled"),
      selected: typeof element.selected === "boolean" ? element.selected : null,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    },
  };
}

function requiredDocument(documentRef: string): DocumentTarget {
  pruneRefs();
  const target = documents.get(documentRef);
  if (target === undefined) throw new DomServiceError("TARGET_REF_STALE", "DocumentRef is no longer live");
  return target;
}

export function resolveDocumentRefTarget(documentRef: string): DocumentRefTarget {
  const target = requiredDocument(documentRef);
  return {
    documentRef: target.documentRef,
    tabRef: target.tabRef,
    tabId: target.tabId,
    frameId: target.frameId,
    documentId: target.documentId,
    createdAt: target.createdAt,
  };
}

function requiredNode(nodeRef: string): NodeTarget {
  pruneRefs();
  const target = nodes.get(nodeRef);
  if (target === undefined) throw new DomServiceError("TARGET_REF_STALE", "NodeRef is no longer live");
  return target;
}

export function resolveNodeRefTarget(nodeRef: string): NodeRefTarget {
  const target = requiredNode(nodeRef);
  return { ...target };
}

function prepareRealClickDocument(
  nodeRef: string,
  scrollIntoView: boolean,
  marker: string,
):
  | { readonly ok: true; readonly point: { readonly x: number; readonly y: number }; readonly viewport: { readonly width: number; readonly height: number }; readonly originalTitle: string }
  | { readonly ok: false; readonly reason: "disabled" | "layoutless" | "not_visible" | "obstructed" | "stale" } {
  type RectLike = { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
  type ShadowLike = { elementFromPoint(x: number, y: number): ElementLike | null };
  type ElementLike = {
    readonly isConnected: boolean;
    readonly ownerDocument: unknown;
    readonly shadowRoot?: ShadowLike | null;
    matches(selector: string): boolean;
    contains(node: object | null): boolean;
    getClientRects(): Iterable<RectLike>;
    scrollIntoView?(options?: Readonly<Record<string, unknown>>): void;
  };
  interface RegistryEntry { readonly element: ElementLike; readonly expiresAt: number }
  const page = globalThis as unknown as {
    readonly performance: { now(): number };
    readonly innerWidth: number;
    readonly innerHeight: number;
    readonly document: {
      title: string;
      elementFromPoint(x: number, y: number): ElementLike | null;
    };
    __BKA_DOM_NODE_REGISTRY_V1__?: { readonly nodes: Map<string, RegistryEntry> };
  };
  const entry = page.__BKA_DOM_NODE_REGISTRY_V1__?.nodes.get(nodeRef);
  if (entry === undefined || entry.expiresAt <= page.performance.now()) return { ok: false, reason: "stale" };
  const element = entry.element;
  if (!element.isConnected || element.ownerDocument !== page.document) return { ok: false, reason: "stale" };
  if (element.matches(":disabled")) return { ok: false, reason: "disabled" };
  if (scrollIntoView) {
    if (element.scrollIntoView === undefined) return { ok: false, reason: "layoutless" };
    element.scrollIntoView({ behavior: "auto", block: "center", inline: "center" });
  }
  const width = page.innerWidth;
  const height = page.innerHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ok: false, reason: "not_visible" };
  }
  const candidates: { readonly x: number; readonly y: number }[] = [];
  for (const rect of element.getClientRects()) {
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(width, rect.right);
    const bottom = Math.min(height, rect.bottom);
    if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) continue;
    for (const xPart of [0.5, 0.25, 0.75]) {
      for (const yPart of [0.5, 0.25, 0.75]) {
        candidates.push({ x: left + ((right - left) * xPart), y: top + ((bottom - top) * yPart) });
      }
    }
  }
  if (candidates.length === 0) return { ok: false, reason: "layoutless" };
  for (const point of candidates) {
    let hit = page.document.elementFromPoint(point.x, point.y);
    let depth = 0;
    while (hit?.shadowRoot !== null && hit?.shadowRoot !== undefined && depth < 16) {
      const nested = hit.shadowRoot.elementFromPoint(point.x, point.y);
      if (nested === null || nested === hit) break;
      hit = nested;
      depth += 1;
    }
    if (hit === element || element.contains(hit as object | null)) {
      const originalTitle = page.document.title;
      page.document.title = marker;
      return { ok: true, point, viewport: { width, height }, originalTitle };
    }
  }
  return { ok: false, reason: "obstructed" };
}

function restoreRealClickDocumentTitle(marker: string, originalTitle: string): void {
  const page = globalThis as unknown as { readonly document: { title: string } };
  if (page.document.title === marker) page.document.title = originalTitle;
}

export async function prepareRealClickNode(
  nodeRef: string,
  scrollIntoView: boolean,
  marker: string,
): Promise<RealClickPreparation> {
  const nodeTarget = requiredNode(nodeRef);
  const tabTarget = await resolveTabTarget(nodeTarget.tabRef);
  await assertScriptingTargetAvailable(tabTarget);
  assertResolvedTabTarget(tabTarget);
  let entries: readonly ChromeScriptingInjectionResult<ReturnType<typeof prepareRealClickDocument>>[];
  try {
    entries = await chrome.scripting.executeScript({
      target: { tabId: nodeTarget.tabId, documentIds: [nodeTarget.documentId] },
      world: "ISOLATED",
      func: prepareRealClickDocument,
      args: [nodeRef, scrollIntoView, marker],
    });
  } catch {
    assertResolvedTabTarget(tabTarget);
    throw new DomServiceError("TARGET_REF_STALE", "NodeRef no longer resolves to an injectable document");
  }
  assertResolvedTabTarget(tabTarget);
  const entry = entries[0];
  if (entries.length !== 1 || entry === undefined || entry.documentId !== nodeTarget.documentId || entry.result === undefined) {
    nodes.delete(nodeRef);
    throw new DomServiceError("TARGET_REF_STALE", "NodeRef is no longer live in the target document");
  }
  if (!entry.result.ok) {
    if (entry.result.reason === "stale") {
      nodes.delete(nodeRef);
      throw new DomServiceError("TARGET_REF_STALE", "NodeRef is no longer live in the target document");
    }
    throw new DomServiceError("DOM_OPERATION_FAILED", `The target is not safely clickable: ${entry.result.reason}`);
  }
  return entry.result;
}

export async function restoreRealClickTitle(
  target: NodeRefTarget,
  marker: string,
  originalTitle: string,
): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: target.tabId, documentIds: [target.documentId] },
      world: "ISOLATED",
      func: restoreRealClickDocumentTitle,
      args: [marker, originalTitle],
    });
  } catch {
    // A navigated/closed document cannot retain the temporary title marker.
  }
}

function focusKeyboardNodeDocument(nodeRef: string): { readonly ok: true } | { readonly ok: false; readonly reason: "disabled" | "not_focusable" | "stale" } {
  type ElementLike = {
    readonly isConnected: boolean;
    readonly ownerDocument: unknown;
    focus?: (options?: { preventScroll?: boolean }) => void;
    scrollIntoView?: (options?: Readonly<Record<string, unknown>>) => void;
    matches(selector: string): boolean;
  };
  interface RegistryEntry { readonly element: ElementLike; readonly expiresAt: number }
  const page = globalThis as unknown as {
    readonly performance: { now(): number };
    readonly document: unknown;
    __BKA_DOM_NODE_REGISTRY_V1__?: { readonly nodes: Map<string, RegistryEntry> };
  };
  const entry = page.__BKA_DOM_NODE_REGISTRY_V1__?.nodes.get(nodeRef);
  if (entry === undefined || entry.expiresAt <= page.performance.now() || !entry.element.isConnected ||
      entry.element.ownerDocument !== page.document) return { ok: false, reason: "stale" };
  const element = entry.element;
  if (element.matches(":disabled")) return { ok: false, reason: "disabled" };
  if (element.focus === undefined) return { ok: false, reason: "not_focusable" };
  element.scrollIntoView?.({ behavior: "auto", block: "center", inline: "center" });
  element.focus({ preventScroll: true });
  return element.matches(":focus") ? { ok: true } : { ok: false, reason: "not_focusable" };
}

function markKeyboardWindowDocument(marker: string): { readonly originalTitle: string } {
  const page = globalThis as unknown as { readonly document: { title: string } };
  const originalTitle = page.document.title;
  page.document.title = marker;
  return { originalTitle };
}

export async function focusKeyboardNode(nodeRef: string): Promise<void> {
  const nodeTarget = requiredNode(nodeRef);
  const tabTarget = await resolveTabTarget(nodeTarget.tabRef);
  await assertScriptingTargetAvailable(tabTarget);
  assertResolvedTabTarget(tabTarget);
  let entries: readonly ChromeScriptingInjectionResult<ReturnType<typeof focusKeyboardNodeDocument>>[];
  try {
    entries = await chrome.scripting.executeScript({
      target: { tabId: nodeTarget.tabId, documentIds: [nodeTarget.documentId] },
      world: "ISOLATED",
      func: focusKeyboardNodeDocument,
      args: [nodeRef],
    });
  } catch {
    assertResolvedTabTarget(tabTarget);
    throw new DomServiceError("TARGET_REF_STALE", "NodeRef no longer resolves to an injectable document");
  }
  assertResolvedTabTarget(tabTarget);
  const entry = entries[0];
  if (entries.length !== 1 || entry === undefined || entry.documentId !== nodeTarget.documentId || entry.result === undefined) {
    nodes.delete(nodeRef);
    throw new DomServiceError("TARGET_REF_STALE", "NodeRef is no longer live in the target document");
  }
  if (!entry.result.ok) {
    if (entry.result.reason === "stale") {
      nodes.delete(nodeRef);
      throw new DomServiceError("TARGET_REF_STALE", "NodeRef is no longer live in the target document");
    }
    throw new DomServiceError("DOM_OPERATION_FAILED", `The keyboard target is ${entry.result.reason}`);
  }
}

export async function markKeyboardWindow(tabRef: string, marker: string): Promise<KeyboardWindowMarker> {
  const tabTarget = await resolveTabTarget(tabRef);
  await assertScriptingTargetAvailable(tabTarget);
  assertResolvedTabTarget(tabTarget);
  let entries: readonly ChromeScriptingInjectionResult<ReturnType<typeof markKeyboardWindowDocument>>[];
  try {
    entries = await chrome.scripting.executeScript({
      target: { tabId: tabTarget.tabId, frameIds: [0] },
      world: "ISOLATED",
      func: markKeyboardWindowDocument,
      args: [marker],
    });
  } catch {
    assertResolvedTabTarget(tabTarget);
    throw new DomServiceError("DOM_OPERATION_FAILED", "The target tab cannot expose a main-document window marker");
  }
  assertResolvedTabTarget(tabTarget);
  const entry = entries[0];
  if (entries.length !== 1 || entry?.documentId === undefined || entry.result === undefined) {
    throw new DomServiceError("DOM_OPERATION_FAILED", "The target tab did not produce one main-document window marker");
  }
  return { tabId: tabTarget.tabId, documentId: entry.documentId, originalTitle: entry.result.originalTitle };
}

export async function restoreKeyboardWindow(marker: KeyboardWindowMarker, expectedTitle: string): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: marker.tabId, documentIds: [marker.documentId] },
      world: "ISOLATED",
      func: restoreRealClickDocumentTitle,
      args: [expectedTitle, marker.originalTitle],
    });
  } catch {
    // A navigated/closed document cannot retain the temporary title marker.
  }
}

export async function queryDom(
  documentRef: string,
  selector: string,
  requestedLimit: number,
): Promise<{ readonly documentRef: string; readonly items: readonly DomQueryItem[]; readonly truncated: boolean }> {
  const documentTarget = requiredDocument(documentRef);
  const tabTarget = await resolveTabTarget(documentTarget.tabRef);
  await assertScriptingTargetAvailable(tabTarget);
  assertResolvedTabTarget(tabTarget);
  let entries: readonly ChromeScriptingInjectionResult<ReturnType<typeof queryDocument>>[];
  try {
    entries = await chrome.scripting.executeScript({
      target: { tabId: documentTarget.tabId, documentIds: [documentTarget.documentId] },
      world: "ISOLATED",
      func: queryDocument,
      args: [
        selector,
        requestedLimit,
        limit("command.dom.maximum_node_refs_per_document"),
        limit("command.dom.reference_ttl_ms"),
        limit("command.dom.maximum_descriptor_text_characters"),
        limit("command.inline.maximum_result_json_bytes") - 256,
      ],
    });
  } catch {
    assertResolvedTabTarget(tabTarget);
    throw new DomServiceError("TARGET_REF_STALE", "DocumentRef no longer resolves to an injectable document");
  }
  assertResolvedTabTarget(tabTarget);
  const entry = entries[0];
  if (
    entries.length !== 1 ||
    entry === undefined ||
    entry.documentId !== documentTarget.documentId ||
    entry.result === undefined
  ) {
    throw new DomServiceError("TARGET_REF_STALE", "DocumentRef result no longer matches the target document");
  }
  if (!entry.result.ok) {
    throw new DomServiceError(
      entry.result.reason === "capacity" ? "LIMIT_EXCEEDED" : "DOM_OPERATION_FAILED",
      entry.result.reason === "capacity" ? "NodeRef capacity is exhausted" : "CSS selector is invalid",
    );
  }
  const now = Date.now();
  for (const item of entry.result.items) {
    if (!isNodeRefShape(item.nodeRef)) throw new DomServiceError("DOM_OPERATION_FAILED", "Page returned an invalid NodeRef token");
    nodes.set(item.nodeRef, { ...documentTarget, nodeRef: item.nodeRef, createdAt: now });
  }
  return { documentRef, items: entry.result.items, truncated: entry.result.truncated };
}

interface ResolvedLocatorDocument {
  readonly tabRef: string;
  readonly tabId: number;
  readonly frameId: number;
  readonly documentId: string;
}

async function currentFrames(tabId: number, failureMessage: string): Promise<readonly ChromeWebNavigationFrame[]> {
  let frames: readonly ChromeWebNavigationFrame[];
  try { frames = await chrome.webNavigation.getAllFrames({ tabId }); }
  catch {
    throw new CapabilityUnavailableError(
      "platform.extension.web_navigation",
      "CHROMIUM_API_FAILED",
      failureMessage,
    );
  }
  return frames;
}

function resolvedDocumentEquals(
  left: ResolvedLocatorDocument | null,
  right: ResolvedLocatorDocument,
): boolean {
  return left !== null && left.frameId === right.frameId && left.documentId === right.documentId;
}

export function resolveLocatorFrameSnapshot(
  frames: readonly ChromeWebNavigationFrame[],
  framePath: readonly DomFrameLocator[],
  maximumCandidates: number,
): ChromeWebNavigationFrame | null {
  const main = frames.find((frame) => frame.frameId === 0);
  if (main?.documentId === undefined || main.documentId.length === 0) return null;
  let selected = main;
  if (framePath.length > 0 && frames.length > maximumCandidates) {
    throw new DomServiceError("LIMIT_EXCEEDED", "The frame locator candidate bound was reached");
  }
  let pathIndex = 0;
  while (pathIndex < framePath.length) {
    const segment = framePath[pathIndex];
    if (segment === undefined) return null;
    const matches = frames
      .filter((frame) => frame.parentFrameId === selected.frameId && linearGlobMatch(frame.url, segment.urlPattern))
      .sort((left, right) => left.frameId - right.frameId);
    if (matches.length === 0) return null;
    if ((segment.match ?? "unique") === "unique" && matches.length !== 1) {
      throw new DomServiceError("TARGET_AMBIGUOUS", "The unique frame locator matched more than one direct child frame");
    }
    selected = matches[0] as ChromeWebNavigationFrame;
    if (selected.documentId === undefined || selected.documentId.length === 0) return null;
    pathIndex += 1;
  }
  return selected;
}

async function resolveLocatorDocument(target: DomLocatorTarget, tabId: number): Promise<ResolvedLocatorDocument | null> {
  const frames = await currentFrames(tabId, "Chromium could not resolve the current locator frame");
  const framePath = target.framePath ?? [];
  const selected = resolveLocatorFrameSnapshot(
    frames,
    framePath,
    limit("command.ensure.maximum_frame_candidates"),
  );
  if (selected === null) return null;
  return {
    tabRef: target.tabRef,
    tabId,
    frameId: selected.frameId,
    documentId: selected.documentId as string,
  };
}

function absentTargetObservation(): DomTargetObservation {
  return {
    status: "absent",
    nodeRef: null,
    visible: false,
    enabled: false,
    unobstructed: false,
    focused: false,
    text: null,
    value: null,
    selectedValues: [],
    rect: null,
  };
}

export async function observeDomTarget(target: DomTarget): Promise<DomTargetObservation> {
  const exact = target.kind === "node" ? requiredNode(target.nodeRef) : null;
  const tabRef = exact?.tabRef ?? (target as DomLocatorTarget).tabRef;
  const tabTarget = await resolveTabTarget(tabRef);
  await assertScriptingTargetAvailable(tabTarget);
  assertResolvedTabTarget(tabTarget);
  const locator = target.kind === "locator" ? {
    selector: target.selector,
    role: target.role,
    name: target.name,
    nameMatch: target.nameMatch,
    match: target.match,
  } : null;
  let attempt = 0;
  while (attempt < (exact === null ? 2 : 1)) {
    const resolved = exact ?? await resolveLocatorDocument(target as DomLocatorTarget, tabTarget.tabId);
    if (resolved === null) return absentTargetObservation();
    let entries: readonly ChromeScriptingInjectionResult<ReturnType<typeof observeTargetDocument>>[];
    try {
      entries = await chrome.scripting.executeScript({
        target: { tabId: resolved.tabId, documentIds: [resolved.documentId] },
        world: "ISOLATED",
        injectImmediately: true,
        func: observeTargetDocument,
        args: [
          exact?.nodeRef ?? null,
          locator,
          limit("command.ensure.maximum_locator_scan_nodes"),
          limit("command.dom.maximum_node_refs_per_document"),
          limit("command.dom.reference_ttl_ms"),
          limit("command.dom.maximum_descriptor_text_characters"),
        ],
      });
    } catch {
      assertResolvedTabTarget(tabTarget);
      if (exact !== null) {
        nodes.delete(exact.nodeRef);
        throw new DomServiceError("TARGET_REF_STALE", "NodeRef no longer resolves to its exact document");
      }
      const refreshed = await resolveLocatorDocument(target as DomLocatorTarget, tabTarget.tabId);
      if (!resolvedDocumentEquals(refreshed, resolved)) {
        attempt += 1;
        if (attempt < 2) continue;
        return absentTargetObservation();
      }
      throw new CapabilityUnavailableError(
        "platform.extension.scripting",
        "CHROMIUM_API_FAILED",
        "Chromium could not inspect the ensure locator",
      );
    }
    assertResolvedTabTarget(tabTarget);
    const entry = entries[0];
    if (entries.length !== 1 || entry === undefined || entry.frameId !== resolved.frameId ||
        entry.documentId !== resolved.documentId || entry.result === undefined) {
      if (exact !== null) nodes.delete(exact.nodeRef);
      attempt += 1;
      if (exact === null && attempt < 2) continue;
      if (exact === null) return absentTargetObservation();
      throw new DomServiceError("TARGET_REF_STALE", "The observed document no longer matches the requested target");
    }
    if (exact !== null && entry.documentId !== exact.documentId) {
      nodes.delete(exact.nodeRef);
      throw new DomServiceError("TARGET_REF_STALE", "NodeRef observation returned from another document");
    }
    if (exact === null) {
      const refreshed = await resolveLocatorDocument(target as DomLocatorTarget, tabTarget.tabId);
      if (!resolvedDocumentEquals(refreshed, resolved)) {
        attempt += 1;
        if (attempt < 2) continue;
        return absentTargetObservation();
      }
    }
    const result = entry.result;
    if (result.status === "stale") {
      if (exact !== null) nodes.delete(exact.nodeRef);
      throw new DomServiceError("TARGET_REF_STALE", result.reason);
    }
    if (result.status === "ambiguous") throw new DomServiceError("TARGET_AMBIGUOUS", result.reason);
    if (result.status === "capacity" || result.status === "scan_limit") {
      throw new DomServiceError("LIMIT_EXCEEDED", result.reason);
    }
    if (result.status === "selector") throw new DomServiceError("DOM_OPERATION_FAILED", result.reason);
    if (result.status === "matched" && result.nodeRef !== null) {
      if (!isNodeRefShape(result.nodeRef)) throw new DomServiceError("DOM_OPERATION_FAILED", "Page returned an invalid NodeRef token");
      if (exact !== null && result.nodeRef !== exact.nodeRef) {
        throw new DomServiceError("TARGET_REF_STALE", "Exact NodeRef identity changed during observation");
      }
      if (exact === null) {
        const documentRef = registerDocumentRef(tabRef, tabTarget.tabId, resolved.frameId, resolved.documentId);
        registerNodeRefsForDocument(documentRef, [result.nodeRef]);
      }
    }
    if (result.status !== "matched" && result.status !== "absent") {
      throw new DomServiceError("DOM_OPERATION_FAILED", "Unexpected ensure target observation status");
    }
    return result;
  }
  return absentTargetObservation();
}

export async function scrollDomTargetSearch(
  target: DomLocatorTarget,
  percent: number,
  cursor: number,
  expectedScope: SearchScrollResult["scope"],
): Promise<SearchScrollResult> {
  const tabTarget = await resolveTabTarget(target.tabRef);
  await assertScriptingTargetAvailable(tabTarget);
  assertResolvedTabTarget(tabTarget);
  const resolved = await resolveLocatorDocument(target, tabTarget.tabId);
  if (resolved === null) {
    return {
      tabRef: target.tabRef,
      moved: false,
      frameMatched: false,
      nextCursor: cursor,
      contextKind: null,
      contextCount: 0,
      scanTruncated: false,
      scope: null,
    };
  }
  let entries: readonly ChromeScriptingInjectionResult<ReturnType<typeof searchScrollDocument>>[];
  try {
    entries = await chrome.scripting.executeScript({
      target: { tabId: tabTarget.tabId, documentIds: [resolved.documentId] },
      world: "ISOLATED",
      injectImmediately: true,
      func: searchScrollDocument,
      args: [
        percent,
        cursor,
        limit("command.ensure.maximum_locator_scan_nodes"),
        limit("command.ensure.maximum_scroll_contexts"),
        expectedScope?.documentId === resolved.documentId ? expectedScope.topologyToken : null,
      ],
    });
  } catch {
    assertResolvedTabTarget(tabTarget);
    const refreshed = await resolveLocatorDocument(target, tabTarget.tabId);
    if (!resolvedDocumentEquals(refreshed, resolved)) {
      return {
        tabRef: target.tabRef,
        moved: false,
        frameMatched: refreshed !== null,
        nextCursor: cursor,
        contextKind: null,
        contextCount: 0,
        scanTruncated: false,
        scope: null,
      };
    }
    throw new CapabilityUnavailableError(
      "platform.extension.scripting",
      "CHROMIUM_API_FAILED",
      "Chromium could not search-scroll the ensure target document",
    );
  }
  assertResolvedTabTarget(tabTarget);
  const entry = entries[0];
  const refreshed = await resolveLocatorDocument(target, tabTarget.tabId);
  if (entries.length !== 1 || entry === undefined || entry.frameId !== resolved.frameId ||
      entry.documentId !== resolved.documentId || entry.result === undefined || !resolvedDocumentEquals(refreshed, resolved)) {
    return {
      tabRef: target.tabRef,
      moved: false,
      frameMatched: refreshed !== null,
      nextCursor: cursor,
      contextKind: null,
      contextCount: 0,
      scanTruncated: false,
      scope: null,
    };
  }
  if (entry.result.scanTruncated) {
    throw new DomServiceError("LIMIT_EXCEEDED", "The scrollable-context discovery bound was reached");
  }
  const { topologyToken, ...result } = entry.result;
  return {
    tabRef: target.tabRef,
    frameMatched: true,
    ...result,
    scope: { documentId: resolved.documentId, topologyToken },
  };
}

async function executeNodeAction(
  nodeRef: string,
  action: DomAction,
  payload: DomActionPayload,
): Promise<{ readonly nodeRef: string; readonly applied: boolean; readonly descriptor: DomDescriptor }> {
  const nodeTarget = requiredNode(nodeRef);
  const tabTarget = await resolveTabTarget(nodeTarget.tabRef);
  await assertScriptingTargetAvailable(tabTarget);
  assertResolvedTabTarget(tabTarget);
  let entries: readonly ChromeScriptingInjectionResult<ReturnType<typeof runNodeAction>>[];
  try {
    entries = await chrome.scripting.executeScript({
      target: { tabId: nodeTarget.tabId, documentIds: [nodeTarget.documentId] },
      world: "ISOLATED",
      func: runNodeAction,
      args: [nodeRef, action, payload, limit("command.dom.maximum_descriptor_text_characters")],
    });
  } catch {
    assertResolvedTabTarget(tabTarget);
    throw new DomServiceError("TARGET_REF_STALE", "NodeRef no longer resolves to an injectable document");
  }
  assertResolvedTabTarget(tabTarget);
  const entry = entries[0];
  if (
    entries.length !== 1 ||
    entry === undefined ||
    entry.documentId !== nodeTarget.documentId ||
    entry.result === undefined ||
    !entry.result.ok
  ) {
    if (entry?.result !== undefined && !entry.result.ok && entry.result.reason === "action") {
      throw new DomServiceError("DOM_OPERATION_FAILED", "The target element does not support the requested DOM action");
    }
    nodes.delete(nodeRef);
    throw new DomServiceError("TARGET_REF_STALE", "NodeRef is no longer live in the target document");
  }
  return { nodeRef, applied: action !== "describe", descriptor: entry.result.descriptor };
}

export async function describeDomNode(nodeRef: string): Promise<{ readonly nodeRef: string; readonly descriptor: DomDescriptor }> {
  const result = await executeNodeAction(nodeRef, "describe", {});
  return { nodeRef, descriptor: result.descriptor };
}

export function clickDomNode(nodeRef: string): Promise<{ readonly nodeRef: string; readonly applied: boolean; readonly descriptor: DomDescriptor }> {
  return executeNodeAction(nodeRef, "click", {});
}

export function setDomNodeValue(nodeRef: string, value: string): Promise<{ readonly nodeRef: string; readonly applied: boolean; readonly descriptor: DomDescriptor }> {
  return executeNodeAction(nodeRef, "setValue", { value });
}

export function insertDomNodeText(nodeRef: string, text: string): Promise<{ readonly nodeRef: string; readonly applied: boolean; readonly descriptor: DomDescriptor }> {
  return executeNodeAction(nodeRef, "insertText", { text });
}

export function selectDomNodeValues(nodeRef: string, values: readonly string[]): Promise<{ readonly nodeRef: string; readonly applied: boolean; readonly descriptor: DomDescriptor }> {
  return executeNodeAction(nodeRef, "select", { values });
}

export function focusDomNode(nodeRef: string, preventScroll: boolean): Promise<{ readonly nodeRef: string; readonly applied: boolean; readonly descriptor: DomDescriptor }> {
  return executeNodeAction(nodeRef, "focus", { preventScroll });
}

export function scrollDomNode(
  nodeRef: string,
  behavior: "auto" | "smooth",
  block: "center" | "end" | "nearest" | "start",
  inline: "center" | "end" | "nearest" | "start",
): Promise<{ readonly nodeRef: string; readonly applied: boolean; readonly descriptor: DomDescriptor }> {
  return executeNodeAction(nodeRef, "scroll", { behavior, block, inline });
}

export function tabRefForNode(nodeRef: string): string {
  return requiredNode(nodeRef).tabRef;
}
