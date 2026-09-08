import { TRANSPORT_CONFIG } from "../generated/transport-config.js";

export interface NativeRecordingRect { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
export interface NativeRecordingGeometry {
  readonly qpc: string; readonly dpi: number;
  readonly window: NativeRecordingRect; readonly clientScreen: NativeRecordingRect;
  readonly contentScreen: NativeRecordingRect | null; readonly visible: boolean; readonly iconic: boolean;
}
export interface NativeRecordingEvent {
  readonly coordinates?: "window";
  readonly sequence: number; readonly kind: number; readonly phase: number; readonly message: number;
  readonly threadId: number; readonly messageTime: number; readonly dpi: number;
  readonly hwnd: string; readonly keyboardLayout: string; readonly qpc: string;
  readonly window: NativeRecordingRect; readonly clientScreen: NativeRecordingRect;
  readonly contentScreen?: NativeRecordingRect | null;
  readonly visible: boolean; readonly iconic: boolean; readonly point: { readonly x: number; readonly y: number } | null;
  readonly wParam: string; readonly keyLParam: string;
  readonly position: { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly flags: number };
  readonly suggestedRect: NativeRecordingRect;
}
export interface NativeRecordingStatus {
  readonly reason: number; readonly reserved: number; readonly acknowledged: number; readonly delivered: number;
  readonly lost: number; readonly attached: number; readonly detached: number; readonly callbacks: number;
  readonly cleanup: boolean; readonly snapshotValid: boolean; readonly enrolledThreadsOnly: boolean;
  readonly pendingInstallations: number; readonly startedQpc: string; readonly qpcFrequency: string;
  readonly geometry?: NativeRecordingGeometry | null;
  readonly startedUnixMs?: number;
}
export interface NativeRecordingCalibration {
  readonly root: string; readonly content: string; readonly processId: number;
  readonly rootWidth: number; readonly rootHeight: number; readonly dpi: number;
  readonly x: number; readonly y: number; readonly width: number; readonly height: number;
}
export type NativeRecordingOperation = { readonly resourceId: string } & (
  | { readonly kind: "open"; readonly marker: string; readonly capacity: number; readonly durationMs: number }
  | { readonly kind: "read"; readonly acknowledgeThrough: number; readonly limit: number }
  | { readonly kind: "stop" }
  | { readonly kind: "close"; readonly discardUnacknowledged: boolean });
export interface NativeRecordingRequest {
  readonly kind: "native.recording"; readonly requestId: string; readonly routeId?: string;
  readonly timeoutMs: number; readonly operation: NativeRecordingOperation;
}
export interface NativeRecordingResult {
  readonly resourceId: string | null;
  readonly outcome: "ok" | "invalid" | "target" | "conflict" | "install_failed" | "pending" | "cursor" | "unacknowledged" | "thread_limit";
  readonly status: NativeRecordingStatus | null;
  readonly events: readonly NativeRecordingEvent[];
  readonly calibration: NativeRecordingCalibration | null;
}
export type NativeRecordingResponse = { readonly kind: "native.recording.result"; readonly requestId: string } & (
  | { readonly ok: true; readonly result: NativeRecordingResult }
  | { readonly ok: false; readonly error: { readonly reason: string } });

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const int = (value: unknown, min = 0, max = 0xffffffff): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const hex = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{16}$/u.test(value);
const decimal = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/u.test(value) && BigInt(value) <= 0x7fffffffffffffffn;
export const isNativeRecordingId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
function rect(value: unknown): value is NativeRecordingRect {
  return record(value) && exact(value, ["left", "top", "right", "bottom"]) && Object.values(value).every(item => int(item, -0x80000000, 0x7fffffff));
}
export function isNativeRecordingEvent(value: unknown): value is NativeRecordingEvent {
  if (!record(value) || !exact(value, ["sequence", "kind", "phase", "message", "threadId", "messageTime", "dpi", "hwnd", "keyboardLayout", "qpc", "window", "clientScreen", "visible", "iconic", "point", "wParam", "keyLParam", "position", "suggestedRect", ...(Object.hasOwn(value,"contentScreen")?["contentScreen"]:[]), ...(Object.hasOwn(value,"coordinates")?["coordinates"]:[])]) ||
      !int(value.sequence, 1, 0x7fffffff) || !int(value.kind, 1, 5) || !int(value.phase, 1, 5) || value.coordinates !== undefined && value.coordinates !== "window" ||
      ![value.message, value.threadId, value.messageTime, value.dpi].every(item => int(item)) ||
      ![value.hwnd, value.keyboardLayout, value.wParam, value.keyLParam].every(hex) || !decimal(value.qpc) ||
      !rect(value.window) || !rect(value.clientScreen) || !rect(value.suggestedRect) || value.contentScreen!==undefined&&value.contentScreen!==null&&!rect(value.contentScreen) ||
      typeof value.visible !== "boolean" || typeof value.iconic !== "boolean" || !record(value.position) ||
      !exact(value.position, ["x", "y", "width", "height", "flags"]) || !int(value.position.flags) ||
      ![value.position.x, value.position.y, value.position.width, value.position.height].every(item => int(item, -0x80000000, 0x7fffffff))) return false;
  if (value.point === null) return value.kind !== 5;
  return (value.kind === 3 || value.kind === 5) && record(value.point) && exact(value.point, ["x", "y"]) &&
    int(value.point.x, -0x80000000, 0x7fffffff) && int(value.point.y, -0x80000000, 0x7fffffff) &&
    !value.iconic && (value.coordinates === "window"
      ? value.visible && value.point.x >= 0 && value.point.x < value.window.right - value.window.left && value.point.y >= 0 && value.point.y < value.window.bottom - value.window.top
      : value.point.x >= value.window.left && value.point.x < value.window.right && value.point.y >= value.window.top && value.point.y < value.window.bottom);
}
function status(value: unknown): value is NativeRecordingStatus {
  if (!record(value) || !exact(value, ["reason", "reserved", "acknowledged", "delivered", "lost", "attached", "detached", "callbacks", "cleanup", "snapshotValid", "enrolledThreadsOnly", "pendingInstallations", "startedQpc", "qpcFrequency", ...(Object.hasOwn(value,"geometry")?["geometry"]:[]), ...(Object.hasOwn(value,"startedUnixMs")?["startedUnixMs"]:[])])) return false;
  if(value.startedUnixMs!==undefined&&!int(value.startedUnixMs,0,Number.MAX_SAFE_INTEGER))return false;
  if(value.geometry!==undefined&&value.geometry!==null) {
    const geometry=value.geometry;
    if(!record(geometry)||!exact(geometry,["qpc","dpi","window","clientScreen","contentScreen","visible","iconic"])||
      !decimal(geometry.qpc)||!int(geometry.dpi,1)||!rect(geometry.window)||!rect(geometry.clientScreen)||
      geometry.contentScreen!==null&&!rect(geometry.contentScreen)||typeof geometry.visible!=="boolean"||typeof geometry.iconic!=="boolean")return false;
  }
  return [value.reason, value.reserved, value.acknowledged, value.delivered, value.lost, value.attached, value.detached, value.callbacks, value.pendingInstallations].every(item => int(item)) &&
    [value.cleanup, value.snapshotValid, value.enrolledThreadsOnly].every(item => typeof item === "boolean") && decimal(value.startedQpc) && decimal(value.qpcFrequency) &&
    (value.snapshotValid !== true || (value.acknowledged as number) <= (value.delivered as number) && (value.delivered as number) <= (value.reserved as number));
}
function calibration(value: unknown): value is NativeRecordingCalibration {
  return record(value) && exact(value, ["root", "content", "processId", "rootWidth", "rootHeight", "dpi", "x", "y", "width", "height"]) &&
    hex(value.root) && hex(value.content) && [value.processId, value.rootWidth, value.rootHeight, value.dpi, value.width, value.height].every(item => int(item, 1)) && int(value.x) && int(value.y);
}
export function isNativeRecordingResponse(value: unknown, requestId?: string): value is NativeRecordingResponse {
  if (!record(value) || value.kind !== "native.recording.result" || typeof value.requestId !== "string" || requestId !== undefined && value.requestId !== requestId) return false;
  if (value.ok === false) return exact(value, ["kind", "requestId", "ok", "error"]) && record(value.error) && exact(value.error, ["reason"]) && typeof value.error.reason === "string";
  if (value.ok !== true || !exact(value, ["kind", "requestId", "ok", "result"]) || !record(value.result)) return false;
  const result = value.result;
  return exact(result, ["resourceId", "outcome", "status", "events", "calibration"]) && (result.resourceId === null || isNativeRecordingId(result.resourceId)) &&
    ["ok", "invalid", "target", "conflict", "install_failed", "pending", "cursor", "unacknowledged", "thread_limit"].includes(result.outcome as string) &&
    (result.status === null || status(result.status)) && (result.calibration === null || calibration(result.calibration)) &&
    Array.isArray(result.events) && result.events.length <= TRANSPORT_CONFIG.maximumNativeRecordingBatchEvents && result.events.every(isNativeRecordingEvent);
}
export function nativeRecordingFailure(requestId: string, reason: string): NativeRecordingResponse {
  return { kind: "native.recording.result", requestId, ok: false, error: { reason } };
}
