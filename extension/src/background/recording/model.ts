import type { DomFrameLocator, DomLocatorTarget } from "../dom-service.js";
import type { ViewportSnapshot, WindowSnapshot } from "../window-service.js";
import type { LocalRouteConnection } from "../../shared/local-route-protocol.js";
import type { NativeRecordingCalibration, NativeRecordingEvent, NativeRecordingStatus, NativeRecordingGeometry } from "../../shared/native-recording-protocol.js";
export type RecordingState = "recording" | "pausing" | "paused" | "stopping" | "stopped" | "interrupted";
export interface RecordingDocument {
  readonly tabId: number; readonly frameId: number; readonly documentId: string; readonly framePath: readonly DomFrameLocator[];
  readonly locatorIssue: "FRAME_URL_AMBIGUOUS" | null;
  readonly acceptedThrough: number; readonly sealed: boolean;
}
export interface RecordingTab { readonly tabId: number; readonly alias: string; readonly initialUrl: string; readonly title: string | null }
export interface RecordingNativeSource {
  readonly resourceId: string; readonly connection: LocalRouteConnection; readonly acceptedThrough: number;
  readonly offsetMs: number; readonly status: NativeRecordingStatus | null;
  readonly calibration: NativeRecordingCalibration | null; readonly closed: boolean;
  readonly geometryKey?: string;
}
export interface RecordingSession {
  readonly recordingId: string; readonly ownerKeyId: string; readonly mode: "dom" | "real"; readonly state: RecordingState;
  readonly scope: "tab" | "window"; readonly tabId: number; readonly windowId: number;
  readonly includeFrames: boolean;
  readonly startedAt: number; readonly updatedAt: number; readonly expiresAt: number; readonly retainUntil: number;
  readonly pausedAt: number | null; readonly pausedMs: number; readonly eventCount: number; readonly byteLength: number;
  readonly lostEvents: number; readonly reason: string | null;
  readonly baseline: { readonly window: WindowSnapshot; readonly viewport: ViewportSnapshot };
  readonly documents: readonly RecordingDocument[]; readonly tabs: readonly RecordingTab[];
  readonly native?: RecordingNativeSource;
}
export type RecordedLocator = Omit<DomLocatorTarget, "kind" | "tabRef" | "framePath">;
export interface RawDomEvent {
  readonly documentSequence: number; readonly at: number; readonly gesture: number;
  readonly kind: "click" | "focus" | "input" | "select" | "scroll" | "hover" | "drag" | "boundary" | "unsupported" | "navigation" | "frame_navigation" | "tab_activated" | "zoom" | "window_changed";
  readonly [key: string]: unknown;
}
export interface RecordedDomEvent extends RawDomEvent {
  readonly recordingId: string; readonly sequence: number; readonly activeMs: number;
  readonly tabId: number; readonly frameId: number; readonly documentId: string;
}
export type RecordedNativeEvent = { readonly recordingId: string; readonly sequence: number; readonly activeMs: number; readonly resourceId: string } & (
  | { readonly kind: "native_start"; readonly startedQpc: string; readonly qpcFrequency: string; readonly calibration: NativeRecordingCalibration | null }
  | { readonly kind: "native"; readonly raw: NativeRecordingEvent }
  | { readonly kind: "native_geometry"; readonly geometry: NativeRecordingGeometry;
      readonly tabId?: number;
      readonly window: WindowSnapshot; readonly viewport: ViewportSnapshot });
export type RecordedEvent = RecordedDomEvent | RecordedNativeEvent;
export function nativeGeometryKey(value: Pick<NativeRecordingEvent,"window"|"clientScreen"|"contentScreen"|"dpi"|"iconic">):string {
  const rect=(value:NativeRecordingEvent["window"]|null|undefined)=>value==null?null:[value.left,value.top,value.right,value.bottom];
  return JSON.stringify([rect(value.window),rect(value.clientScreen),rect(value.contentScreen),value.dpi,value.iconic]);
}
export class RecordingError extends Error {
  readonly code = "RECORDING_OPERATION_FAILED" as const;
  constructor(readonly details: { readonly reason: string }) { super(details.reason); }
}
export function publicRecording(record: RecordingSession) {
  const { ownerKeyId: _owner, documents: _documents, tabs: _tabs, native: _native, ...metadata } = record;
  return { ...metadata, documentCount: record.documents.length, tabCount: record.tabs.length };
}
