import { TRANSPORT_CONFIG } from "../../generated/transport-config.js";
import { COMMAND_CATALOG } from "../../generated/command-config.js";
import type { LocalRouteConnection } from "../../shared/local-route-protocol.js";
import type { NativeRecordingOperation, NativeRecordingResult } from "../../shared/native-recording-protocol.js";
import { localRouteConnection, refreshNativeConnection, requestNativeRecording } from "../transport-controller.js";
import type { AcquireNativeRoute } from "../local-route-client.js";
import { markKeyboardWindow, restoreKeyboardWindow } from "../dom-service.js";
import { RecordingError, type RecordedNativeEvent, type RecordingSession } from "./model.js";
import { changeRecording, loadRecording } from "./store.js";

export interface NativeRecordingContext { readonly routeId: string; readonly acquireNativeRoute?: AcquireNativeRoute }
const readers = new Map<string, Promise<void>>();
const finishing = new Map<string, Promise<RecordingSession>>();
const timeout = () => TRANSPORT_CONFIG.virtualMouse.default_timeout_ms;

// The service owns start/stop order. Only this source advances the native cursor,
// in the same transaction that saves the corresponding events.
export async function prepareNativeSource(id: string, connection: LocalRouteConnection): Promise<RecordingSession> {
  return changeRecording(id, current => {
    if (current.mode !== "real" || current.state !== "recording") throw new RecordingError({ reason: "NOT_RECORDING" });
    if (current.native !== undefined && !current.native.closed) throw new RecordingError({ reason: "NATIVE_RESOURCE_ACTIVE" });
    return { session: { ...current, native: { resourceId: crypto.randomUUID(), connection, acceptedThrough: 0,
      offsetMs: Math.max(0, Date.now() - current.startedAt - current.pausedMs), status: null, calibration: null, closed: false } } };
  });
}

export async function saveNativeBatch(id: string, resourceId: string, result: NativeRecordingResult): Promise<RecordingSession> {
  return changeRecording(id, current => {
    const source = current.native;
    if (current.mode !== "real" || source === undefined || source.resourceId !== resourceId || source.closed || result.resourceId !== resourceId)
      throw new RecordingError({ reason: "NATIVE_RESOURCE_MISMATCH" });
    const status = result.status;
    if (status === null || !status.snapshotValid) {
      if (result.events.length > 0) throw new RecordingError({ reason: "NATIVE_STATUS_MISSING" });
      return { session: current };
    }
    if (BigInt(status.qpcFrequency) <= 0n || status.acknowledged > source.acceptedThrough ||
        source.status !== null && (status.startedQpc !== source.status.startedQpc || status.qpcFrequency !== source.status.qpcFrequency))
      throw new RecordingError({ reason: "NATIVE_CURSOR_INVALID" });
    let acceptedThrough = source.acceptedThrough;
    const offsetMs=source.status===null&&status.startedUnixMs!==undefined?Math.max(0,status.startedUnixMs-current.startedAt-current.pausedMs):source.offsetMs;
    const events: RecordedNativeEvent[] = [];
    const calibration = source.calibration ?? result.calibration;
    if (source.status === null) events.push({ kind: "native_start", recordingId: id, sequence: current.eventCount + 1,
      activeMs: offsetMs, resourceId, startedQpc: status.startedQpc, qpcFrequency: status.qpcFrequency, calibration });
    for (const raw of result.events) {
      if (raw.sequence <= acceptedThrough) continue;
      if (raw.sequence !== acceptedThrough + 1 || raw.sequence > status.delivered || BigInt(raw.qpc) < BigInt(status.startedQpc))
        throw new RecordingError({ reason: "NATIVE_EVENT_GAP" });
      events.push({ kind: "native", recordingId: id, sequence: current.eventCount + events.length + 1, resourceId,
        activeMs: offsetMs + Number((BigInt(raw.qpc) - BigInt(status.startedQpc)) * 1000n / BigInt(status.qpcFrequency)), raw });
      acceptedThrough = raw.sequence;
    }
    return { session: { ...current, lostEvents: current.lostEvents + Math.max(0, status.lost - (source.status?.lost ?? 0)),
      native: { ...source, offsetMs, acceptedThrough, status, calibration } }, events };
  });
}

export async function callNativeSource(session: RecordingSession, operation: NativeRecordingOperation, timeoutMs: number, routeId?: string) {
  if (session.native === undefined || session.native.resourceId !== operation.resourceId || session.native.closed)
    throw new RecordingError({ reason: "NATIVE_RESOURCE_MISMATCH" });
  const result = await requestNativeRecording({ kind: "native.recording", requestId: crypto.randomUUID(), timeoutMs,
    operation, ...(routeId === undefined ? {} : { routeId }) }, session.native.connection);
  if (result.resourceId !== null) await saveNativeBatch(session.recordingId, operation.resourceId, result);
  if (result.outcome !== "ok" && result.outcome !== "pending") throw new RecordingError({ reason: `NATIVE_${result.outcome.toUpperCase()}` });
  return result;
}

// App events already contain window-relative coordinates. Reading only drains
// the existing source; no DOM/viewport measurements accompany each batch.
export async function readNativeSource(ownerKeyId:string,id:string,timeoutMs:number):Promise<NativeRecordingResult> {
  const current=await loadRecording(ownerKeyId,id);
  if(current.native===undefined||current.native.closed)throw new RecordingError({reason:"NATIVE_RESOURCE_MISMATCH"});
  return callNativeSource(current,{kind:"read",resourceId:current.native.resourceId,acknowledgeThrough:current.native.acceptedThrough,
    limit:TRANSPORT_CONFIG.maximumNativeRecordingBatchEvents},timeoutMs);
}

export async function closeNativeSource(ownerKeyId: string, id: string, timeoutMs: number, discardUnacknowledged = false) {
  const session = await loadRecording(ownerKeyId, id);
  if (session.native === undefined || session.native.closed) return true;
  // Close frees the C resource. Its receipt is metadata, never another batch.
  let result: NativeRecordingResult;
  try {
    result = await requestNativeRecording({ kind: "native.recording", requestId: crypto.randomUUID(), timeoutMs,
      operation: { kind: "close", resourceId: session.native.resourceId, discardUnacknowledged } }, session.native.connection);
  } catch (error) {
    // A response from the original connection proves an uncertain open left no
    // resource. A disconnected/different App provides no such receipt.
    if (!(error instanceof RecordingError) || error.details.reason !== "RecordingNotFound") throw error;
    await changeRecording(id, current => ({ session: current.native?.resourceId === session.native!.resourceId
      ? { ...current, native: { ...current.native, closed: true } } : current }));
    return true;
  }
  if (result.outcome !== "ok") return false;
  if (result.resourceId !== session.native.resourceId || result.status?.cleanup !== true)
    throw new RecordingError({ reason: "NATIVE_CLEANUP_UNCONFIRMED" });
  await changeRecording(id, current => {
    if (current.native?.resourceId !== session.native!.resourceId) throw new RecordingError({ reason: "NATIVE_RESOURCE_MISMATCH" });
    return { session: { ...current, native: { ...current.native, status: result.status, closed: true } } };
  });
  return true;
}

export async function openNativeRecording(session: RecordingSession, tabRef: string, context: NativeRecordingContext): Promise<void> {
  const deadline = performance.now() + timeout();
  await refreshNativeConnection();
  const acquired = await context.acquireNativeRoute?.(deadline);
  const connection = acquired?.connection ?? localRouteConnection();
  const prepared = await prepareNativeSource(session.recordingId, connection);
  const marker = `BKA recording ${crypto.randomUUID()}`;
  const page = await markKeyboardWindow(tabRef, marker);
  try {
    const tab = await chrome.tabs.get(page.tabId);
    if (!tab.active || tab.windowId !== session.windowId) throw new RecordingError({ reason: "TARGET_NOT_ACTIVE" });
    const remaining = Math.floor(deadline - performance.now());
    const durationMs = Math.floor(session.expiresAt - Date.now());
    if (remaining < 1 || durationMs < 1) throw new RecordingError({ reason: "DURATION_EXPIRED" });
    const opened = await callNativeSource(prepared, { kind: "open", resourceId: prepared.native!.resourceId, marker,
      capacity: COMMAND_CATALOG.limits["command.recording.maximum_pending_events"], durationMs }, remaining, acquired?.routeId ?? context.routeId);
    if (opened.outcome !== "ok" || opened.status?.reason !== 0) throw new RecordingError({ reason: "NATIVE_START_INCOMPLETE" });
    await readNativeSource(session.ownerKeyId,session.recordingId,Math.max(1,Math.floor(deadline-performance.now())));
  } finally { await restoreKeyboardWindow(page, marker, Math.max(0, deadline - performance.now())); }
}

async function finishNativeRecording(ownerKeyId: string, id: string, operation: "pause" | "stop"): Promise<RecordingSession> {
  const deadline = performance.now() + timeout();
  const current = await loadRecording(ownerKeyId, id);
  if (current.native !== undefined && !current.native.closed) {
    if(current.native.status?.reason===0)await readNativeSource(ownerKeyId,id,timeout());
    const result = await callNativeSource(current, { kind: "stop", resourceId: current.native.resourceId }, timeout());
    if (result.outcome !== "ok" || result.status?.cleanup !== true) return current;
    let drained = false;
    const maximumBatches = Math.ceil(COMMAND_CATALOG.limits["command.recording.maximum_pending_events"] / TRANSPORT_CONFIG.maximumNativeRecordingBatchEvents) + 1;
    for (let batch = 0; batch < maximumBatches; batch++) {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining < 1) break;
      const result = await readNativeSource(ownerKeyId, id, remaining);
      if (result.status?.acknowledged === result.status?.reserved) { drained = true; break; }
      if (result.events.length === 0) break;
    }
    const remaining = Math.floor(deadline - performance.now());
    if (!drained || remaining < 1 || !await closeNativeSource(ownerKeyId, id, remaining)) return loadRecording(ownerKeyId, id);
  }
  return changeRecording(id, session => {
    const reason = session.native?.status?.reason;
    const failed = session.state === "interrupted" || session.lostEvents > 0 || reason !== undefined && ![1, 2].includes(reason);
    const paused = operation === "pause" && session.state === "pausing";
    return { session: { ...session, state: failed ? "interrupted" : paused ? "paused" : "stopped",
      pausedAt: paused ? Date.now() : null, reason: failed ? session.reason ?? "NATIVE_RECORDING_INTERRUPTED" : session.reason } };
  });
}

export async function stopNativeRecording(ownerKeyId: string, id: string, operation: "pause" | "stop"): Promise<RecordingSession> {
  await changeRecording(id, session => ({ session: ["interrupted", "stopped", "stopping"].includes(session.state) ? session :
    { ...session, state: operation === "pause" ? "pausing" : "stopping" } }));
  const pending = finishing.get(id);
  if (pending !== undefined) return pending;
  const result = (async () => { await readers.get(id); return finishNativeRecording(ownerKeyId, id, operation); })();
  finishing.set(id, result);
  try { return await result; } finally { finishing.delete(id); }
}

export async function discardNativeRecording(session: RecordingSession): Promise<void> {
  await readers.get(session.recordingId);
  await finishing.get(session.recordingId);
  if(session.native===undefined||session.native.closed)return;
  await refreshNativeConnection();
  if (!await closeNativeSource(session.ownerKeyId, session.recordingId, timeout(), true)) throw new RecordingError({ reason: "NATIVE_CLEANUP_UNCONFIRMED" });
}

export function readNativeRecordingContinuously(session: RecordingSession): void {
  if (readers.has(session.recordingId)) return;
  const running = (async () => {
    let failure: unknown;
    try {
      while (Date.now() < session.expiresAt) {
        const current = await loadRecording(session.ownerKeyId, session.recordingId);
        if (current.state !== "recording") return;
        const result = await readNativeSource(session.ownerKeyId, session.recordingId, timeout());
        if (result.status !== null && result.status.reason !== 0) break;
        if (result.events.length < TRANSPORT_CONFIG.maximumNativeRecordingBatchEvents)
          await new Promise<void>(resolve => setTimeout(resolve, COMMAND_CATALOG.limits["command.recording.flush_interval_ms"]));
      }
      await changeRecording(session.recordingId, current => ({ session: current.state === "recording" ? { ...current, state: "stopping" } : current }));
      await finishNativeRecording(session.ownerKeyId, session.recordingId, "stop");
    } catch (error) { failure = error; }
    finally { readers.delete(session.recordingId); }
    if (failure !== undefined) {
      await changeRecording(session.recordingId, current => ({ session: { ...current, state: "interrupted", lostEvents: current.lostEvents + 1,
        reason: failure instanceof RecordingError ? failure.details.reason : "NATIVE_READ_FAILED" } }));
      await closeNativeSource(session.ownerKeyId, session.recordingId, timeout(), true).catch(() => undefined);
    }
  })();
  readers.set(session.recordingId, running);
  void running.catch(() => undefined);
}
