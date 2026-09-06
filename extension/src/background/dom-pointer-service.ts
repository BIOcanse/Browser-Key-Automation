import { COMMAND_CATALOG } from "../generated/command-config.js";
import { assertScriptingTargetAvailable } from "./browser-service.js";
import { DomServiceError, resolveNodeRefTarget } from "./dom-service.js";
import { assertResolvedTabTarget, resolveTabTarget } from "./tab-service.js";

export interface PointerOffset { readonly x: number; readonly y: number }
export type DomPointerRequest =
  | { readonly kind: "hover"; readonly nodeRef: string; readonly phase: "enter" | "leave"; readonly offset: PointerOffset | null }
  | { readonly kind: "drag"; readonly nodeRef: string; readonly toNodeRef: string; readonly mode: "pointer" | "html5";
      readonly steps: number; readonly fromOffset: PointerOffset | null; readonly toOffset: PointerOffset | null };

export interface DomPointerResult {
  readonly nodeRef: string;
  readonly status: "events_dispatched";
  readonly eventCount: number;
  readonly canceledAt: "dragstart" | "dragover" | null;
}

export class DomPointerError extends Error {
  readonly code = "DOM_OPERATION_FAILED" as const;
  readonly details: { readonly reason: string; readonly eventCount: number | null; readonly commandMayHaveRun: boolean };
  constructor(reason: string, eventCount: number | null) {
    super(`DOM pointer sequence failed: ${reason}`);
    this.name = "DomPointerError";
    this.details = { reason, eventCount, commandMayHaveRun: eventCount === null || eventCount > 0 };
  }
}

// Self-contained: Chromium serializes this function into the exact document's
// isolated world. No extension closure, page-global pointer state or OS input.
export function runDomPointerDocument(request: DomPointerRequest, maximumAncestors: number):
  | { readonly ok: true; readonly eventCount: number; readonly canceledAt: DomPointerResult["canceledAt"] }
  | { readonly ok: false; readonly reason: string; readonly eventCount: number } {
  interface ElementLike extends EventTarget {
    readonly isConnected: boolean;
    readonly ownerDocument: unknown;
    readonly parentElement: ElementLike | null;
    readonly shadowRoot?: { elementFromPoint(x: number, y: number): ElementLike | null } | null;
    getRootNode(): { readonly host?: ElementLike };
    getBoundingClientRect(): { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    getClientRects(): { readonly length: number };
    getAttribute(name: string): string | null;
    matches(selector: string): boolean;
  }
  interface Transfer { dropEffect: string; effectAllowed: string }
  const page = globalThis as unknown as {
    readonly document: EventTarget & { elementFromPoint(x: number, y: number): ElementLike | null };
    readonly innerWidth: number;
    readonly innerHeight: number;
    readonly performance: { now(): number };
    readonly MouseEvent: new (type: string, init: Readonly<Record<string, unknown>>) => Event;
    readonly PointerEvent: new (type: string, init: Readonly<Record<string, unknown>>) => Event;
    readonly DragEvent: new (type: string, init: Readonly<Record<string, unknown>>) => Event;
    readonly DataTransfer: new () => Transfer;
    getComputedStyle(element: ElementLike): { readonly visibility: string; readonly display: string; readonly opacity: string };
    readonly __BKA_DOM_NODE_REGISTRY_V1__?: { readonly nodes: Map<string, { readonly element: ElementLike; readonly expiresAt: number }> };
  };
  let eventCount = 0;
  const requiredEndpoints: ElementLike[] = [];
  const fail = (reason: string): never => { throw new Error(reason); };
  const parent = (element: ElementLike): ElementLike | null => element.parentElement ?? element.getRootNode().host ?? null;
  const ancestors = (element: ElementLike | null): ElementLike[] => {
    const items: ElementLike[] = [], visited = new Set<ElementLike>();
    let current = element;
    while (current !== null) {
      if (items.length >= maximumAncestors || visited.has(current)) fail("ancestor_limit");
      visited.add(current); items.push(current); current = parent(current);
    }
    return items;
  };
  const live = (element: ElementLike): void => {
    if (!element.isConnected || element.ownerDocument !== page.document) fail("target_stale");
  };
  const lookup = (nodeRef: string): ElementLike => {
    const entry = page.__BKA_DOM_NODE_REGISTRY_V1__?.nodes.get(nodeRef);
    if (!entry || entry.expiresAt <= page.performance.now()) return fail("target_stale");
    live(entry.element); return entry.element;
  };
  const hitAt = (point: PointerOffset): ElementLike => {
    let hit = page.document.elementFromPoint(point.x, point.y);
    const visited = new Set<ElementLike>();
    while (hit?.shadowRoot) {
      if (visited.size >= maximumAncestors || visited.has(hit)) fail("ancestor_limit");
      visited.add(hit);
      const next = hit.shadowRoot.elementFromPoint(point.x, point.y);
      if (next === null || next === hit) break;
      hit = next;
    }
    return hit ?? fail("point_unavailable");
  };
  const belongsTo = (hit: ElementLike, element: ElementLike): boolean => ancestors(hit).includes(element);
  const pointFor = (element: ElementLike, offset: PointerOffset | null): PointerOffset => {
    live(element);
    if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") fail("target_disabled");
    const rect = element.getBoundingClientRect(), style = page.getComputedStyle(element);
    if (element.getClientRects().length === 0 || rect.width <= 0 || rect.height <= 0 || style.display === "none" ||
        style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") fail("target_not_visible");
    const x = offset?.x ?? rect.width / 2, y = offset?.y ?? rect.height / 2;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= rect.width || y >= rect.height) fail("offset_outside_element");
    const point = { x: rect.x + x, y: rect.y + y };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 ||
        point.x >= page.innerWidth || point.y >= page.innerHeight) fail("point_outside_viewport");
    if (!belongsTo(hitAt(point), element)) fail("target_obstructed");
    // Validate the full path before the first side effect, including enter/leave.
    ancestors(element);
    return point;
  };
  const send = (target: EventTarget, type: string, point: PointerOffset, buttons: number,
    relatedTarget: ElementLike | null = null, transfer: Transfer | null = null, cleanup = false): boolean => {
    // dispatchEvent runs page listeners synchronously. A listener may remove an
    // endpoint; only cancellation/release cleanup may run after that happens.
    if (!cleanup) for (const endpoint of requiredEndpoints) live(endpoint);
    const pointer = type.startsWith("pointer");
    const boundary = transfer === null && (type.endsWith("enter") || type.endsWith("leave"));
    const init: Record<string, unknown> = {
      view: globalThis, bubbles: !boundary, cancelable: !boundary && type !== "pointercancel" && type !== "dragend" && type !== "dragleave",
      composed: transfer === null && !boundary, clientX: point.x, clientY: point.y,
      buttons, button: pointer && (type === "pointermove" || type === "pointerover" || type === "pointerout" || boundary) ? -1 : 0,
      relatedTarget,
    };
    if (pointer) Object.assign(init, { pointerId: 1, pointerType: "mouse", isPrimary: true, pressure: buttons ? 0.5 : 0 });
    if (transfer !== null) init.dataTransfer = transfer;
    const EventClass = transfer !== null ? page.DragEvent : pointer ? page.PointerEvent : page.MouseEvent;
    const event = new EventClass(type, init);
    eventCount += 1;
    return target.dispatchEvent(event);
  };
  const boundary = (from: ElementLike | null, to: ElementLike | null, point: PointerOffset, buttons: number, mouse: boolean): void => {
    if (from === to) return;
    const oldPath = ancestors(from), newPath = ancestors(to);
    if (from !== null) {
      send(from, "pointerout", point, buttons, to);
      if (mouse) send(from, "mouseout", point, buttons, to);
      for (const element of oldPath) {
        if (newPath.includes(element)) break;
        send(element, "pointerleave", point, buttons, to);
        if (mouse) send(element, "mouseleave", point, buttons, to);
      }
    }
    if (to !== null) {
      send(to, "pointerover", point, buttons, from);
      if (mouse) send(to, "mouseover", point, buttons, from);
      let index = newPath.length - 1;
      while (index >= 0) {
        const element = newPath[index--];
        if (element === undefined || oldPath.includes(element)) continue;
        send(element, "pointerenter", point, buttons, from);
        if (mouse) send(element, "mouseenter", point, buttons, from);
      }
    }
  };
  try {
    const source = lookup(request.nodeRef);
    requiredEndpoints.push(source);
    if (request.kind === "hover") {
      const point = pointFor(source, request.offset);
      boundary(request.phase === "enter" ? null : source, request.phase === "enter" ? source : null, point, 0, true);
      if (request.phase === "enter") {
        live(source); send(source, "pointermove", point, 0); send(source, "mousemove", point, 0);
      }
      return { ok: true, eventCount, canceledAt: null };
    }
    const target = lookup(request.toNodeRef);
    if (target !== source) requiredEndpoints.push(target);
    const start = pointFor(source, request.fromOffset), end = pointFor(target, request.toOffset);
    let point = start, last = source;
    let canceledAt: DomPointerResult["canceledAt"] = null;
    if (request.mode === "html5") {
      const transfer = new page.DataTransfer();
      transfer.effectAllowed = "all";
      let started = false, dropped = false;
      try {
        if (!send(source, "dragstart", start, 1, null, transfer)) return { ok: true, eventCount, canceledAt: "dragstart" };
        started = true;
        let accepted = false;
        for (let step = 1; step <= request.steps; step += 1) {
          live(source); live(target);
          point = { x: start.x + (end.x - start.x) * step / request.steps, y: start.y + (end.y - start.y) * step / request.steps };
          const hit = hitAt(point);
          send(source, "drag", point, 1, null, transfer);
          if (step === 1 || hit !== last) {
            send(hit, "dragenter", point, 1, last, transfer);
            if (step !== 1) send(last, "dragleave", point, 1, hit, transfer);
          }
          last = hit;
          accepted = !send(hit, "dragover", point, 1, null, transfer);
        }
        live(source); live(target);
        if (!belongsTo(hitAt(end), target)) fail("target_obstructed");
        if (!accepted) canceledAt = "dragover";
        else { send(last, "drop", end, 0, null, transfer); dropped = true; }
      } finally {
        if (started) {
          if (!dropped) { transfer.dropEffect = "none"; send(last, "dragleave", point, 0, null, transfer, true); }
          send(source, "dragend", point, 0, null, transfer, true);
        }
      }
    } else {
      let pressed = false, released = false, mouse = true;
      try {
        boundary(null, source, start, 0, true);
        live(source); live(target);
        pressed = true;
        mouse = send(source, "pointerdown", start, 1);
        if (mouse) send(source, "mousedown", start, 1);
        for (let step = 1; step <= request.steps; step += 1) {
          live(source); live(target);
          point = { x: start.x + (end.x - start.x) * step / request.steps, y: start.y + (end.y - start.y) * step / request.steps };
          const hit = hitAt(point);
          boundary(last, hit, point, 1, mouse); last = hit;
          send(hit, "pointermove", point, 1);
          if (mouse) send(hit, "mousemove", point, 1);
        }
        live(source); live(target);
        if (!belongsTo(hitAt(end), target)) fail("target_obstructed");
        send(last, "pointerup", end, 0); released = true;
        if (mouse) send(last.isConnected ? last : page.document, "mouseup", end, 0, null, null, true);
      } finally {
        if (pressed && !released) {
          const cleanupTarget = last.isConnected ? last : page.document;
          send(cleanupTarget, "pointercancel", point, 0, null, null, true);
          if (mouse) send(cleanupTarget, "mouseup", point, 0, null, null, true);
        }
      }
    }
    return { ok: true, eventCount, canceledAt };
  } catch (error) {
    const knownReasons = ["target_stale", "ancestor_limit", "target_disabled", "target_not_visible", "offset_outside_element",
      "point_outside_viewport", "target_obstructed", "point_unavailable"];
    const reason = error instanceof Error && knownReasons.includes(error.message) ? error.message : "event_dispatch_failed";
    return { ok: false, reason, eventCount };
  }
}

export async function executeDomPointer(request: DomPointerRequest): Promise<DomPointerResult> {
  const source = resolveNodeRefTarget(request.nodeRef);
  if (request.kind === "drag") {
    const destination = resolveNodeRefTarget(request.toNodeRef);
    if (source.tabRef !== destination.tabRef || source.frameId !== destination.frameId || source.documentId !== destination.documentId) {
      throw new DomPointerError("different_documents", 0);
    }
  }
  const tab = await resolveTabTarget(source.tabRef);
  await assertScriptingTargetAvailable(tab);
  assertResolvedTabTarget(tab);
  let entries: readonly ChromeScriptingInjectionResult<ReturnType<typeof runDomPointerDocument>>[];
  try {
    entries = await chrome.scripting.executeScript({
      target: { tabId: source.tabId, documentIds: [source.documentId] }, world: "ISOLATED",
      func: runDomPointerDocument,
      args: [request, COMMAND_CATALOG.limits["command.dom.pointer.maximum_ancestors"]],
    });
  } catch { throw new DomPointerError("document_execution_lost", null); }
  assertResolvedTabTarget(tab);
  const result = entries.length === 1 && entries[0]?.documentId === source.documentId ? entries[0].result : undefined;
  if (result === undefined) throw new DomPointerError("document_execution_lost", null);
  if (!result.ok) {
    if (result.reason === "target_stale" && result.eventCount === 0) throw new DomServiceError("TARGET_REF_STALE", "NodeRef is no longer live");
    throw new DomPointerError(result.reason, result.eventCount);
  }
  return { nodeRef: request.nodeRef, status: "events_dispatched", eventCount: result.eventCount, canceledAt: result.canceledAt };
}
