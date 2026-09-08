import type { NativeKeyboardAction } from "./native-input-protocol.js";

export type MouseAction =
  | { readonly kind: "move"; readonly x: number; readonly y: number }
  | { readonly kind: "moveWindow"; readonly x: number; readonly y: number }
  | { readonly kind: "button"; readonly button: "left" | "right" | "middle" | "back" | "forward"; readonly action: "press" | "down" | "up" }
  | { readonly kind: "wait"; readonly waitMs: number }
  | { readonly kind: "wheel"; readonly deltaX: number; readonly deltaY: number };
export interface InputSnapshot {
  readonly id: number;
  readonly mouse: { readonly point: { readonly x: number; readonly y: number }; readonly coordinates?: "css_viewport" | "window"; readonly buttons: number; readonly known: boolean };
  readonly keyboard: { readonly keys: readonly number[]; readonly extended?: readonly boolean[]; readonly known: boolean };
  readonly windows: readonly ({ readonly windowId: number; readonly alive: boolean; readonly interception: boolean } | null)[];
}
export interface InputOperation {
  readonly kind: "create" | "get" | "calibrate" | "input" | "keyboard" | "interception" | "reset" | "keyboardReset" | "destroy" | "releaseWindow" | "cleanup";
  readonly inputId?: string;
  readonly windowId?: number;
  readonly marker?: string;
  readonly documentId?: string;
  readonly refresh?: boolean;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly actions?: readonly MouseAction[];
  readonly keyboardActions?: readonly NativeKeyboardAction[];
  readonly enabled?: boolean;
}
export interface VirtualInputRequest {
  readonly kind: "native.virtualInput";
  readonly requestId: string;
  readonly routeId?: string;
  readonly timeoutMs: number;
  readonly relayEpoch?: string;
  readonly operation: InputOperation;
}
export type VirtualInputResult = { readonly completedActions: number; readonly submittedScalars?: number; readonly input: InputSnapshot | null; readonly calibration?: { readonly updated: boolean } | null };
export type VirtualInputResponse = {
  readonly kind: "native.virtualInput.result";
  readonly requestId: string;
} & ({ readonly ok: true; readonly result: VirtualInputResult }
  | { readonly ok: false; readonly error: { readonly reason: string; readonly progress?: VirtualInputResult } });
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function validResult(value: unknown): boolean {
  if (!record(value) || !integer(value.completedActions)) return false;
  if (value.submittedScalars !== undefined && !integer(value.submittedScalars)) return false;
  if (value.calibration !== undefined && value.calibration !== null && (!record(value.calibration) || typeof value.calibration.updated !== "boolean")) return false;
  const input = value.input;
  if (input === null) return true;
  if (!record(input) || !integer(input.id, 1) || !record(input.mouse) || !record(input.keyboard) || !Array.isArray(input.windows)) return false;
  const mouse = input.mouse, keyboard = input.keyboard;
  return record(mouse.point) && integer(mouse.point.x, 0, 32767) && integer(mouse.point.y, 0, 32767) &&
    (mouse.coordinates === undefined || mouse.coordinates === "css_viewport" || mouse.coordinates === "window") &&
    integer(mouse.buttons, 0, 31) && typeof mouse.known === "boolean" && typeof keyboard.known === "boolean" &&
    Array.isArray(keyboard.keys) && keyboard.keys.length === 256 && keyboard.keys.every((key) => integer(key, 0, 255)) &&
    (keyboard.extended === undefined || Array.isArray(keyboard.extended) && keyboard.extended.length === 256 && keyboard.extended.every((key) => typeof key === "boolean")) &&
    input.windows.every((window) => window === null || record(window) && integer(window.windowId, 1) && typeof window.alive === "boolean" && typeof window.interception === "boolean");
}
export function isVirtualInputResponse(value: unknown, id?: string): value is VirtualInputResponse {
  if (!record(value) || value.kind !== "native.virtualInput.result" || typeof value.requestId !== "string" || id !== undefined && value.requestId !== id) return false;
  if (value.ok === false) return record(value.error) && typeof value.error.reason === "string" &&
    (value.error.progress === undefined || validResult(value.error.progress));
  return value.ok === true && validResult(value.result);
}
export function virtualInputFailure(requestId: string, reason: string): VirtualInputResponse {
  return { kind: "native.virtualInput.result", requestId, ok: false, error: { reason } };
}
