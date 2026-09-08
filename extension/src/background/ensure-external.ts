import { COMMAND_CATALOG } from "../generated/command-config.js";
import { isTabRefShape } from "./tab-service.js";
import { getViewport, getWindow, WindowOperationError, type WindowBounds, type WindowState } from "./window-service.js";
import type { PermissionId } from "../shared/admin-protocol.js";

export type ExternalCondition =
  | { readonly kind: "window_state"; readonly windowId: number; readonly state: WindowState }
  | { readonly kind: "window_focused"; readonly windowId: number; readonly focused: boolean }
  | { readonly kind: "window_bounds"; readonly windowId: number; readonly bounds: WindowBounds; readonly tolerance: number }
  | { readonly kind: "viewport"; readonly tabRef: string; readonly width: number | null; readonly height: number | null; readonly zoom: number | null; readonly visibility: "visible" | "hidden" | null; readonly tolerance: number };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
const integer = (value: unknown, minimum = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= COMMAND_CATALOG.limits["command.windows.maximum_dimension"];
export function isExternalCondition(value: unknown): value is ExternalCondition {
  if (!record(value)) return false;
  if (value.kind === "viewport") return exact(value, ["kind", "tabRef", "width", "height", "zoom", "visibility", "tolerance"]) && isTabRefShape(value.tabRef) &&
    (value.width === null || integer(value.width, 1)) && (value.height === null || integer(value.height, 1)) &&
    (value.zoom === null || typeof value.zoom === "number" && Number.isFinite(value.zoom) && value.zoom > 0 && value.zoom <= 5) &&
    (value.visibility === null || value.visibility === "visible" || value.visibility === "hidden") && integer(value.tolerance) &&
    [value.width, value.height, value.zoom, value.visibility].some((item) => item !== null);
  if (typeof value.windowId !== "number" || !Number.isSafeInteger(value.windowId) || value.windowId < 1) return false;
  if (value.kind === "window_state") return exact(value, ["kind", "windowId", "state"]) && ["normal", "minimized", "maximized", "fullscreen"].includes(value.state as string);
  if (value.kind === "window_focused") return exact(value, ["kind", "windowId", "focused"]) && typeof value.focused === "boolean";
  if (value.kind !== "window_bounds" || !exact(value, ["kind", "windowId", "bounds", "tolerance"]) || !record(value.bounds) || !exact(value.bounds, ["left", "top", "width", "height"]) || !integer(value.tolerance)) return false;
  return ["left", "top", "width", "height"].every((key) => value.bounds !== null && record(value.bounds) && (value.bounds[key] === null || integer(value.bounds[key], key === "left" || key === "top" ? -COMMAND_CATALOG.limits["command.windows.maximum_dimension"] : 1))) &&
    Object.values(value.bounds).some((item) => item !== null);
}
export async function observeExternalCondition(condition: ExternalCondition, authorize: (permission: PermissionId) => Promise<void>): Promise<boolean | null> {
  await authorize("windows.read");
  if (condition.kind === "viewport") {
    const current = await getViewport(condition.tabRef);
    return (condition.width === null || Math.abs(current.width - condition.width) <= condition.tolerance) &&
      (condition.height === null || Math.abs(current.height - condition.height) <= condition.tolerance) &&
      (condition.zoom === null || Math.abs(current.zoom - condition.zoom) < 0.000001) &&
      (condition.visibility === null || current.visibility === condition.visibility);
  }
  const window = await getWindow(condition.windowId).catch((error: unknown) => { if(error instanceof WindowOperationError)return null;throw error; });
  if(window===null)return null;
  if (condition.kind === "window_state") return window.state === null ? null : window.state === condition.state;
  if (condition.kind === "window_focused") return window.focused === condition.focused;
  for (const key of ["left", "top", "width", "height"] as const) {
    const wanted = condition.bounds[key], actual = window.bounds[key];
    if (wanted === null) continue;
    if (actual === null) return null;
    if (Math.abs(actual - wanted) > condition.tolerance) return false;
  }
  return true;
}
