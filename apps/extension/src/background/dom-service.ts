import { COMMAND_CATALOG } from "../generated/command-config.js";
import { assertScriptingTargetAvailable } from "./browser-service.js";
import { CapabilityUnavailableError } from "./capability-error.js";
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

type DomAction = "click" | "describe" | "focus" | "scroll" | "select" | "setValue";

interface DomActionPayload {
  readonly value?: string;
  readonly values?: readonly string[];
  readonly preventScroll?: boolean;
  readonly behavior?: "auto" | "smooth";
  readonly block?: "center" | "end" | "nearest" | "start";
  readonly inline?: "center" | "end" | "nearest" | "start";
}

export class DomServiceError extends Error {
  readonly code: "DOM_OPERATION_FAILED" | "LIMIT_EXCEEDED" | "TARGET_REF_STALE";

  constructor(code: "DOM_OPERATION_FAILED" | "LIMIT_EXCEEDED" | "TARGET_REF_STALE", message: string) {
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

function runNodeAction(
  nodeRef: string,
  action: DomAction,
  payload: DomActionPayload,
  maximumTextCharacters: number,
):
  | { readonly ok: true; readonly descriptor: DomDescriptor }
  | { readonly ok: false; readonly reason: "action" | "stale" } {
  type EventTargetLike = { dispatchEvent(event: Event): boolean };
  type ElementLike = EventTargetLike & {
    readonly tagName: string;
    readonly id: string;
    readonly classList: Iterable<string>;
    textContent: string | null;
    readonly isConnected: boolean;
    readonly ownerDocument: unknown;
    readonly isContentEditable?: boolean;
    value?: unknown;
    checked?: unknown;
    disabled?: unknown;
    selected?: unknown;
    readonly options?: Iterable<{ value: string; selected: boolean }>;
    click?: () => void;
    focus?: (options?: { preventScroll?: boolean }) => void;
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
    readonly InputEvent: new (type: string, init?: { bubbles?: boolean; composed?: boolean; inputType?: string; data?: string }) => Event;
    readonly document: {
      createTreeWalker(
        root: ElementLike,
        whatToShow: number,
      ): { nextNode(): TextNodeLike | null };
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
