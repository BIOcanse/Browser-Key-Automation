import { COMMAND_CATALOG } from "../generated/command-config.js";
import { assertScriptingTargetAvailable } from "./browser-service.js";
import { DomServiceError, resolveNodeRefTarget } from "./dom-service.js";
import type { PointerOffset } from "./dom-pointer-service.js";
import { assertResolvedTabTarget, resolveTabTarget } from "./tab-service.js";

interface PointGeometry { readonly point: PointerOffset; readonly width: number; readonly height: number }
interface PointElement {
  readonly isConnected: boolean; readonly ownerDocument: unknown;
  readonly parentElement: PointElement | null;
  readonly shadowRoot?: PointRoot | null;
  readonly contentWindow?: unknown;
  readonly offsetWidth: number; readonly offsetHeight: number; readonly clientLeft: number; readonly clientTop: number;
  getRootNode(): { readonly host?: PointElement };
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
  getClientRects(): Iterable<{ left: number; top: number; right: number; bottom: number }>;
  getAttribute(name: string): string | null;
  matches(selector: string): boolean;
}
interface PointRoot {
  elementFromPoint(x: number, y: number): PointElement | null;
  querySelectorAll(selector: string): Iterable<PointElement>;
}
interface PointPage {
  readonly document: PointRoot; readonly innerWidth: number; readonly innerHeight: number;
  readonly performance: { now(): number };
  getComputedStyle(element: PointElement): Record<string, string>;
  readonly __BKA_DOM_NODE_REGISTRY_V1__?: { nodes: Map<string, { element: PointElement; expiresAt: number }> };
}

/** Hittable candidates follow the existing real-click center/quarter-point rule. */
export function pointInDocument(nodeRef: string, offset: PointerOffset | null, maximum: number): PointGeometry {
  const page = globalThis as unknown as PointPage;
  const entry = page.__BKA_DOM_NODE_REGISTRY_V1__?.nodes.get(nodeRef);
  if (!entry || entry.expiresAt <= page.performance.now() || !entry.element.isConnected || entry.element.ownerDocument !== page.document) throw new Error("node_stale");
  const element = entry.element, bounds = element.getBoundingClientRect();
  if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") throw new Error("node_disabled");
  const candidates: PointerOffset[] = [];
  if (offset !== null) {
    if (offset.x < 0 || offset.y < 0 || offset.x >= bounds.width || offset.y >= bounds.height) throw new Error("offset_outside_element");
    candidates.push({ x: bounds.x + offset.x, y: bounds.y + offset.y });
  } else {
    let rectangles = 0;
    for (const rect of element.getClientRects()) {
      if (++rectangles > maximum) throw new Error("point_candidate_limit");
      const left = Math.max(0, rect.left), top = Math.max(0, rect.top), right = Math.min(page.innerWidth, rect.right), bottom = Math.min(page.innerHeight, rect.bottom);
      if (right <= left || bottom <= top) continue;
      for (const x of [0.5, 0.25, 0.75]) for (const y of [0.5, 0.25, 0.75]) candidates.push({ x: left + (right - left) * x, y: top + (bottom - top) * y });
    }
  }
  for (const candidate of candidates) {
    const point = { x: Math.round(candidate.x), y: Math.round(candidate.y) };
    if (point.x < 0 || point.y < 0 || point.x >= page.innerWidth || point.y >= page.innerHeight) continue;
    let hit = page.document.elementFromPoint(point.x, point.y);
    const visited = new Set<PointElement>();
    while (hit?.shadowRoot && visited.size < maximum && !visited.has(hit)) {
      visited.add(hit);
      const nested = hit.shadowRoot.elementFromPoint(point.x, point.y);
      if (!nested || nested === hit) break;
      hit = nested;
    }
    visited.clear();
    while (hit && visited.size < maximum && !visited.has(hit)) {
      if (hit === element) return { point, width: page.innerWidth, height: page.innerHeight };
      visited.add(hit); hit = hit.parentElement ?? hit.getRootNode().host ?? null;
    }
  }
  throw new Error("element_point_not_hittable");
}

interface FrameMeasurement { readonly result: Promise<PointGeometry>; readonly cancel: () => void }
/** A short-lived source-window handshake identifies a cross-origin frame without
 * changing page DOM, names, styles or focus. Only measured geometry is returned. */
function frameMeasurement(mode: "begin" | "read" | "cancel", token: string, child: PointGeometry, timeoutMs: number, maximum: number): Promise<PointGeometry | null> | null {
  const page = globalThis as unknown as PointPage & {
    __BKA_FRAME_POINTS_V1__?: Map<string, FrameMeasurement>;
    addEventListener(type: string, listener: (event: MessageEvent) => void): void;
    removeEventListener(type: string, listener: (event: MessageEvent) => void): void;
  };
  const records = page.__BKA_FRAME_POINTS_V1__ ??= new Map();
  const existing = records.get(token);
  if (mode === "cancel") { existing?.cancel(); return null; }
  if (mode === "read") return existing?.result ?? Promise.reject(new Error("frame_measurement_expired"));
  if (records.size >= maximum || existing) throw new Error("frame_measurement_limit");
  let resolve!: (value: PointGeometry) => void, reject!: (reason: unknown) => void;
  const result = new Promise<PointGeometry>((yes, no) => { resolve = yes; reject = no; });
  void result.catch(() => undefined);
  const finish = () => { clearTimeout(timer); page.removeEventListener("message", listener); records.delete(token); };
  const listener = (event: MessageEvent) => {
    if (typeof event.data !== "object" || event.data === null || event.data.bkaFramePoint !== token) return;
    try {
      let element: PointElement | undefined;
      const roots: PointRoot[] = [page.document], seen = new Set<PointRoot>();
      let scanned = 0;
      while (roots.length > 0 && !element) {
        const root = roots.pop()!;
        if (seen.has(root)) continue;
        seen.add(root);
        for (const candidate of root.querySelectorAll("*")) {
          if (++scanned > maximum) throw new Error("frame_scan_limit");
          if (candidate.contentWindow === event.source) { element = candidate; break; }
          if (candidate.shadowRoot) roots.push(candidate.shadowRoot);
        }
      }
      if (!element || !element.isConnected) return;
      const visited = new Set<PointElement>();
      let ancestor: PointElement | null = element;
      while (ancestor) {
        if (visited.size >= maximum || visited.has(ancestor)) throw new Error("frame_ancestor_limit");
        visited.add(ancestor);
        const style = page.getComputedStyle(ancestor);
        // Bounding rectangles determine axis-aligned scale exactly. Reject a
        // rotation/perspective instead of silently treating its AABB as content.
        if (style.perspective && style.perspective !== "none" || style.rotate && style.rotate !== "none" && style.rotate !== "0deg") throw new Error("frame_transform_unsupported");
        if (style.transform && style.transform !== "none") {
          const match = /^matrix\(([^)]+)\)$/u.exec(style.transform);
          const parts = match?.[1]?.split(",").map(Number);
          if (!parts || parts.length !== 6 || parts[1] !== 0 || parts[2] !== 0 || (parts[0] ?? 0) <= 0 || (parts[3] ?? 0) <= 0) throw new Error("frame_transform_unsupported");
        }
        ancestor = ancestor.parentElement ?? ancestor.getRootNode().host ?? null;
      }
      const rect = element.getBoundingClientRect(), style = page.getComputedStyle(element);
      const number = (value: string | undefined) => Number.parseFloat(value ?? "0") || 0;
      const sx = rect.width / element.offsetWidth, sy = rect.height / element.offsetHeight;
      const left = element.clientLeft + number(style.paddingLeft), top = element.clientTop + number(style.paddingTop);
      const contentWidth = element.offsetWidth - left - number(style.borderRightWidth) - number(style.paddingRight);
      const contentHeight = element.offsetHeight - top - number(style.borderBottomWidth) - number(style.paddingBottom);
      const point = { x: Math.round(rect.x + sx * (left + child.point.x * contentWidth / child.width)),
        y: Math.round(rect.y + sy * (top + child.point.y * contentHeight / child.height)) };
      if (![point.x, point.y].every(Number.isFinite) || point.x < 0 || point.y < 0 || point.x >= page.innerWidth || point.y >= page.innerHeight) throw new Error("frame_point_outside_viewport");
      let hit = page.document.elementFromPoint(point.x, point.y);
      const hits = new Set<PointElement>();
      while (hit?.shadowRoot && !hits.has(hit) && hits.size < maximum) { hits.add(hit); const nested = hit.shadowRoot.elementFromPoint(point.x, point.y); if (!nested || nested === hit) break; hit = nested; }
      if (hit !== element) throw new Error("frame_obstructed");
      // Retain only the settled result until the already scheduled read consumes it.
      page.removeEventListener("message", listener);
      resolve({ point, width: page.innerWidth, height: page.innerHeight });
    } catch (error) { page.removeEventListener("message", listener); reject(error); }
  };
  const timer = setTimeout(() => { finish(); reject(new Error("frame_measurement_timeout")); }, timeoutMs);
  records.set(token, { result, cancel: () => { finish(); reject(new Error("frame_measurement_canceled")); } });
  void records.get(token)!.result.catch(() => undefined);
  page.addEventListener("message", listener);
  return null;
}
function postFramePoint(token: string): void {
  (globalThis as unknown as { parent: { postMessage(value: unknown, targetOrigin: string): void } }).parent.postMessage({ bkaFramePoint: token }, "*");
}

export async function resolveElementPoint(nodeRef: string, offset: PointerOffset | null, deadline: number): Promise<PointerOffset> {
  const node = resolveNodeRefTarget(nodeRef), tab = await resolveTabTarget(node.tabRef);
  await assertScriptingTargetAvailable(tab);
  const maximum = COMMAND_CATALOG.limits["command.dom.pointer.maximum_ancestors"];
  const frames = await chrome.webNavigation.getAllFrames({ tabId: node.tabId });
  let frame = frames.find((value) => value.frameId === node.frameId && value.documentId === node.documentId);
  if (!frame) throw new DomServiceError("TARGET_REF_STALE", "Element document changed");
  const entries = await chrome.scripting.executeScript({ target: { tabId: node.tabId, documentIds: [node.documentId] }, world: "ISOLATED", func: pointInDocument, args: [nodeRef, offset, maximum] });
  const initial = entries[0]?.result;
  if (!initial || entries.length !== 1 || entries[0]?.documentId !== node.documentId) throw new DomServiceError("DOM_OPERATION_FAILED", "Element has no usable point");
  let geometry: PointGeometry = initial;
  const visited = new Set<number>();
  while (frame.frameId !== 0) {
    if (visited.size >= maximum || visited.has(frame.frameId)) throw new DomServiceError("LIMIT_EXCEEDED", "Frame depth exceeded");
    visited.add(frame.frameId);
    const parent = frames.find((value) => value.frameId === frame!.parentFrameId);
    if (!parent?.documentId) throw new DomServiceError("TARGET_REF_STALE", "Parent frame changed");
    const timeoutMs = Math.floor(deadline - performance.now());
    if (timeoutMs <= 0) throw new DomServiceError("DOM_OPERATION_FAILED", "Element point deadline expired");
    const token = crypto.randomUUID(), target = { tabId: node.tabId, documentIds: [parent.documentId] };
    const scan = COMMAND_CATALOG.limits["command.ensure.maximum_locator_scan_nodes"];
    await chrome.scripting.executeScript({ target, world: "ISOLATED", func: frameMeasurement, args: ["begin", token, geometry, timeoutMs, scan] });
    try {
      await chrome.scripting.executeScript({ target: { tabId: node.tabId, documentIds: [frame.documentId!] }, world: "ISOLATED", func: postFramePoint, args: [token] });
      const mapped: readonly ChromeScriptingInjectionResult<PointGeometry | null>[] = await chrome.scripting.executeScript({ target, world: "ISOLATED", func: frameMeasurement, args: ["read", token, geometry, timeoutMs, scan] });
      if (!mapped[0]?.result || mapped[0].documentId !== parent.documentId) throw new DomServiceError("DOM_OPERATION_FAILED", "Frame point could not be mapped");
      geometry = mapped[0].result;
    } finally {
      await chrome.scripting.executeScript({ target, world: "ISOLATED", func: frameMeasurement, args: ["cancel", token, geometry, timeoutMs, scan] }).catch(() => undefined);
    }
    frame = parent;
  }
  assertResolvedTabTarget(tab);
  const current = await chrome.webNavigation.getAllFrames({ tabId: node.tabId });
  for (const id of [...visited, 0]) if (!current.some((value) => value.frameId === id && value.documentId === frames.find((old) => old.frameId === id)?.documentId)) throw new DomServiceError("TARGET_REF_STALE", "Frame chain changed during geometry measurement");
  return geometry.point;
}
