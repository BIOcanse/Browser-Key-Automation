import { assertScriptingTargetAvailable } from "./browser-service.js";
import { assertResolvedTabTarget, resolveTabTarget } from "./tab-service.js";

export type WindowState = "normal" | "minimized" | "maximized" | "fullscreen";
export interface WindowBounds {
  readonly left: number | null;
  readonly top: number | null;
  readonly width: number | null;
  readonly height: number | null;
}
export interface WindowSnapshot {
  readonly windowId: number;
  readonly focused: boolean;
  readonly state: ChromeWindow["state"] | null;
  readonly bounds: WindowBounds;
  readonly boundsIncludeFrame: true;
}
export interface ViewportSnapshot {
  readonly tabRef: string;
  readonly windowId: number;
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
  readonly zoom: number;
  readonly visibility: "visible" | "hidden";
  readonly scrollX: number;
  readonly scrollY: number;
  readonly coordinates: "css_viewport";
}
export class WindowOperationError extends Error {
  readonly code = "WINDOW_OPERATION_FAILED" as const;
  constructor(readonly details: { readonly reason: "WINDOW_NOT_FOUND" | "UPDATE_FAILED" | "VIEWPORT_UNAVAILABLE" | "ZOOM_FAILED" }) {
    super(details.reason);
  }
}

export function windowSnapshot(windowId: number, value: ChromeWindow): WindowSnapshot {
  return { windowId, focused: value.focused, state: value.state ?? null,
    bounds: { left: value.left ?? null, top: value.top ?? null, width: value.width ?? null, height: value.height ?? null },
    boundsIncludeFrame: true };
}

export async function getWindow(windowId: number): Promise<WindowSnapshot> {
  try { return windowSnapshot(windowId, await chrome.windows.get(windowId)); }
  catch { throw new WindowOperationError({ reason: "WINDOW_NOT_FOUND" }); }
}

export async function setWindowState(windowId: number, state: WindowState): Promise<WindowSnapshot> {
  try { return windowSnapshot(windowId, await chrome.windows.update(windowId, { state })); }
  catch { throw new WindowOperationError({ reason: "UPDATE_FAILED" }); }
}

export async function setWindowBounds(windowId: number, bounds: WindowBounds): Promise<WindowSnapshot> {
  const update: { left?: number; top?: number; width?: number; height?: number } = {};
  if (bounds.left !== null) update.left = bounds.left;
  if (bounds.top !== null) update.top = bounds.top;
  if (bounds.width !== null) update.width = bounds.width;
  if (bounds.height !== null) update.height = bounds.height;
  const current = await getWindow(windowId);
  // Restoring is its own explicit operation: a resize must not silently restore.
  if (current.state !== "normal") throw new WindowOperationError({ reason: "UPDATE_FAILED" });
  try { return windowSnapshot(windowId, await chrome.windows.update(windowId, update)); }
  catch { throw new WindowOperationError({ reason: "UPDATE_FAILED" }); }
}

export async function focusWindow(windowId: number): Promise<WindowSnapshot> {
  try { return windowSnapshot(windowId, await chrome.windows.update(windowId, { focused: true })); }
  catch { throw new WindowOperationError({ reason: "UPDATE_FAILED" }); }
}

export async function getViewport(tabRef: string): Promise<ViewportSnapshot> {
  const target = await resolveTabTarget(tabRef);
  await assertScriptingTargetAvailable(target);
  const tab = await chrome.tabs.get(target.tabId);
  const zoom = await chrome.tabs.getZoom(target.tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId: target.tabId, frameIds: [0] }, world: "ISOLATED",
    func: () => {
      const page = globalThis as unknown as { innerWidth: number; innerHeight: number; devicePixelRatio: number; scrollX: number; scrollY: number; document: { visibilityState: "visible" | "hidden" } };
      return { width: page.innerWidth, height: page.innerHeight, devicePixelRatio: page.devicePixelRatio,
        visibility: page.document.visibilityState, scrollX: page.scrollX, scrollY: page.scrollY };
    },
  });
  assertResolvedTabTarget(target);
  const value = results.find((item) => item.frameId === 0)?.result;
  if (value === undefined || ![value.width, value.height, value.devicePixelRatio, value.scrollX, value.scrollY, zoom].every(Number.isFinite) ||
      value.width < 0 || value.height < 0 || value.devicePixelRatio <= 0 || zoom <= 0 ||
      value.visibility !== "visible" && value.visibility !== "hidden") throw new WindowOperationError({ reason: "VIEWPORT_UNAVAILABLE" });
  return { tabRef, windowId: tab.windowId, ...value, zoom, coordinates: "css_viewport" };
}

export async function setPageZoom(tabRef: string, factor: number): Promise<{ readonly tabRef: string; readonly factor: number }> {
  const target = await resolveTabTarget(tabRef);
  try { await chrome.tabs.setZoom(target.tabId, factor); }
  catch { throw new WindowOperationError({ reason: "ZOOM_FAILED" }); }
  assertResolvedTabTarget(target);
  return { tabRef, factor: await chrome.tabs.getZoom(target.tabId) };
}
