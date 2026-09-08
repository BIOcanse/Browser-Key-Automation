import {
  NATIVE_INPUT_MESSAGE_CHANNEL,
  isNativeInputClickResponse,
  isNativeInputKeyboardResponse,
  type NativeInputClickRequest,
  type NativeInputClickResponse,
  type NativeInputKeyboardRequest,
  type NativeInputKeyboardResponse,
} from "./shared/native-input-protocol.js";
import { isVirtualInputResponse, virtualInputFailure, type VirtualInputResponse, type VirtualInputRequest } from "./shared/virtual-input-protocol.js";
import { isNativeRecordingResponse, nativeRecordingFailure, type NativeRecordingResponse, type NativeRecordingRequest } from "./shared/native-recording-protocol.js";
import { TRANSPORT_CONFIG } from "./generated/transport-config.js";
import { isLocalRouteRequest, isLocalRouteResponse, localRouteFailure,
  type LocalRouteConnection, type LocalRouteRequest, type LocalRouteResponse, type LocalRouteReceipt } from "./shared/local-route-protocol.js";

const TRANSPORT_MESSAGE_CHANNEL = "browser-key-automation.transport.v1";
const offscreenDocument = (
  globalThis as typeof globalThis & { document: { title: string } }
).document;

interface OffscreenDiagnostic {
  scriptStarted: boolean;
  portCreated: boolean;
  workerCreated: boolean;
  lastWorkerState: unknown;
  lastDeliveryError: string | null;
}

const diagnostic: OffscreenDiagnostic = {
  scriptStarted: true,
  portCreated: false,
  workerCreated: false,
  lastWorkerState: null,
  lastDeliveryError: null,
};
offscreenDocument.title = "BKA transport.offscreen-ready";
(globalThis as typeof globalThis & { __BKA_OFFSCREEN_DIAGNOSTIC?: OffscreenDiagnostic })
  .__BKA_OFFSCREEN_DIAGNOSTIC = diagnostic;

let lastWorkerState: unknown = null;
let transportWorker: Worker | undefined;
let activeGeneration: number | null = null;
let activeRelayEpoch: string | null = null;
let activeCapabilities: readonly string[] = [];
const pendingLocal = new Map<string, {
  readonly request: LocalRouteRequest;
  readonly connection: LocalRouteConnection;
  readonly timer: number;
  respond: ((receipt: LocalRouteReceipt) => void) | null;
}>();

function settleLocal(response: LocalRouteResponse, connection: LocalRouteConnection, confirmed: boolean, retire = confirmed): void {
  const pending = pendingLocal.get(response.requestId);
  if (!pending || pending.connection.connectionGeneration !== connection.connectionGeneration || pending.connection.relayEpoch !== connection.relayEpoch) return;
  if (retire) pendingLocal.delete(response.requestId);
  clearTimeout(pending.timer);
  const respond = pending.respond; pending.respond = null;
  respond?.({ ...connection, confirmed, response });
}
function failPendingLocal(reason: string): void {
  for (const pending of [...pendingLocal.values()]) settleLocal(localRouteFailure(pending.request.requestId, reason), pending.connection, false, true);
}
const pendingNative = new Map<string, {
  readonly requestKind: "native.input.click" | "native.input.keyboard" | "native.virtualInput" | "native.recording";
  readonly generation: number;
  readonly relayEpoch?: string;
  readonly cleanupInputId?: string;
  readonly timer: number;
  readonly respond: (response: NativeInputClickResponse | NativeInputKeyboardResponse | VirtualInputResponse | NativeRecordingResponse) => void;
}>();
const inputRetirements = new Map<string, { readonly inputId: string; readonly at: number; readonly relayEpoch: string; inFlight: boolean }>();
function retirementKey(relayEpoch: string, inputId: string): string { return `${relayEpoch}:${inputId}`; }
let retirementTimer: number | undefined;

function startRetirementTimer(): void {
  if (retirementTimer !== undefined) return;
  // The offscreen host survives background-worker suspension. This stores only
  // resource deadlines, never Keys or an independent copy of mouse state.
  retirementTimer = setInterval(() => {
    for (const record of inputRetirements.values()) {
      const inputId = record.inputId;
      if (activeGeneration === null || transportWorker === undefined || Date.now() < record.at || record.inFlight) continue;
      record.inFlight = true;
      const requestId = crypto.randomUUID();
      const timeoutMs = TRANSPORT_CONFIG.virtualMouse.cleanup_timeout_ms;
      const timer = setTimeout(() => settleNative(virtualInputFailure(requestId, "native_response_timeout")), timeoutMs + TRANSPORT_CONFIG.nativeInputResponseMarginMs);
      pendingNative.set(requestId, { requestKind: "native.virtualInput", generation: activeGeneration,
        cleanupInputId: inputId, relayEpoch: record.relayEpoch, timer, respond: (response) => {
          record.inFlight = false;
          if (!response.ok) diagnostic.lastDeliveryError = `Native input cleanup pending: ${response.error.reason}`;
        } });
      // Only idempotent resource cleanup is retried, never a user input action.
      transportWorker.postMessage({ kind: "transport.outbound", connectionGeneration: activeGeneration,
        payload: { kind: "native.virtualInput", requestId, relayEpoch: record.relayEpoch,
          timeoutMs, operation: { kind: "cleanup", inputId } } });
    }
    if (inputRetirements.size === 0) { clearInterval(retirementTimer); retirementTimer = undefined; }
  }, TRANSPORT_CONFIG.virtualMouse.retirement_poll_ms);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nativeFailure(requestId: string, reason: string, clickState: "not_sent" | "unknown"): NativeInputClickResponse {
  return {
    kind: "native.input.result",
    requestId,
    ok: false,
    error: { reason, phase: "input", clickState },
  };
}

function keyboardFailure(
  requestId: string,
  reason: string,
  inputState: "not_sent" | "partially_sent" | "unknown",
): NativeInputKeyboardResponse {
  return {
    kind: "native.keyboard.result",
    requestId,
    ok: false,
    error: { reason, phase: "input", inputState, completedActions: 0 },
  };
}

function settleNative(response: NativeInputClickResponse | NativeInputKeyboardResponse | VirtualInputResponse | NativeRecordingResponse): boolean {
  const pending = pendingNative.get(response.requestId);
  if (pending === undefined) return false;
  pendingNative.delete(response.requestId);
  clearTimeout(pending.timer);
  if (response.kind === "native.virtualInput.result" && response.ok && pending.cleanupInputId !== undefined) {
    if (pending.relayEpoch !== undefined) inputRetirements.delete(retirementKey(pending.relayEpoch, pending.cleanupInputId));
  }
  pending.respond(response);
  return true;
}

function failPendingNative(reason: string): void {
  for (const [requestId, pending] of [...pendingNative.entries()]) {
    settleNative(pending.requestKind === "native.recording" ? nativeRecordingFailure(requestId, reason) : pending.requestKind === "native.virtualInput" ? virtualInputFailure(requestId, reason) : pending.requestKind === "native.input.click"
      ? nativeFailure(requestId, reason, "unknown")
      : keyboardFailure(requestId, reason, "unknown"));
  }
}

function publishToBackground(payload: unknown): void {
  diagnostic.portCreated = true;
  void chrome.runtime
    .sendMessage({ channel: TRANSPORT_MESSAGE_CHANNEL, payload })
    .then((response) => {
      diagnostic.lastDeliveryError = null;
      if (
        typeof payload === "object" &&
        payload !== null &&
        Reflect.get(payload, "kind") === "transport.inbound" &&
        Number.isSafeInteger(Reflect.get(payload, "connectionGeneration")) &&
        response !== undefined
      ) {
        transportWorker?.postMessage({
          kind: "transport.outbound",
          connectionGeneration: Reflect.get(payload, "connectionGeneration"),
          payload: response,
        });
      }
    })
    .catch((error: unknown) => {
      diagnostic.lastDeliveryError = error instanceof Error ? error.message : String(error);
    });
}

publishToBackground({ kind: "transport.offscreen-ready" });

try {
  const worker = new Worker(chrome.runtime.getURL("transport-worker.js"), { type: "module" });
  transportWorker = worker;
  diagnostic.workerCreated = true;
  worker.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (isRecord(event.data) && event.data.kind === "transport.inbound" && isRecord(event.data.payload) && event.data.payload.kind === "native.recording.result") {
      const response = event.data.payload;
      const pending = typeof response.requestId === "string" ? pendingNative.get(response.requestId) : undefined;
      if (pending?.requestKind === "native.recording" && pending.generation === event.data.connectionGeneration && pending.relayEpoch === event.data.relayEpoch)
        settleNative(isNativeRecordingResponse(response) ? response : nativeRecordingFailure(response.requestId as string, "native_response_invalid"));
      return;
    }
    if (isRecord(event.data) && event.data.kind === "transport.inbound" && isRecord(event.data.payload) && event.data.payload.kind === "route.local.result") {
      const response = event.data.payload;
      const pending = typeof response.requestId === "string" ? pendingLocal.get(response.requestId) : undefined;
      if (pending && pending.connection.connectionGeneration === event.data.connectionGeneration && pending.connection.relayEpoch === event.data.relayEpoch) {
        const valid = isLocalRouteResponse(response, pending.request);
        settleLocal(valid ? response : localRouteFailure(pending.request.requestId, "local_route_response_invalid"), pending.connection, valid);
      }
      return; // Unknown/late control receipts must never enter the command dispatcher.
    }
    if (isRecord(event.data) && event.data.kind === "transport.inbound" && isRecord(event.data.payload) &&
        ["native.virtualInput.result", "native.input.result", "native.keyboard.result"].includes(String(event.data.payload.kind))) {
      const response = event.data.payload;
      if (isVirtualInputResponse(response) || isNativeInputClickResponse(response) || isNativeInputKeyboardResponse(response)) settleNative(response);
      else if (typeof response.requestId === "string") {
        settleNative(response.kind === "native.virtualInput.result" ? virtualInputFailure(response.requestId, "native_response_invalid") :
          response.kind === "native.input.result" ? nativeFailure(response.requestId, "native_response_invalid", "unknown") :
            keyboardFailure(response.requestId, "native_response_invalid", "unknown"));
      }
      return; // Late, unmatched or malformed native replies are never routed commands.
    }
    if (typeof event.data === "object" && event.data !== null) {
      const kind = Reflect.get(event.data, "kind");
      if (typeof kind === "string") {
        lastWorkerState = { kind };
        diagnostic.lastWorkerState = lastWorkerState;
        offscreenDocument.title = `BKA ${kind}`;
      }
    }
    if (isRecord(event.data)) {
      const kind = event.data.kind;
      if (kind === "transport.connected") {
        activeGeneration = Number.isSafeInteger(event.data.connectionGeneration)
          ? event.data.connectionGeneration as number : null;
        activeRelayEpoch = typeof event.data.relayEpoch === "string" ? event.data.relayEpoch : null;
        activeCapabilities = Array.isArray(event.data.capabilities) ? event.data.capabilities as string[] : [];
      } else if (kind === "transport.disconnected" || kind === "transport.protocol-error") {
        activeGeneration = null;
        activeRelayEpoch = null;
        activeCapabilities = [];
        failPendingNative("transport_disconnected");
        failPendingLocal("transport_disconnected");
      }
    }
    publishToBackground(event.data);
  });
  worker.addEventListener("error", () => {
    activeGeneration = null; activeRelayEpoch = null; activeCapabilities = [];
    failPendingNative("transport_worker_failed"); failPendingLocal("transport_worker_failed");
    lastWorkerState = { kind: "transport.worker-error" };
    diagnostic.lastWorkerState = lastWorkerState;
    offscreenDocument.title = "BKA transport.worker-error";
    publishToBackground(lastWorkerState);
  });
} catch {
  lastWorkerState = { kind: "transport.worker-error" };
  diagnostic.lastWorkerState = lastWorkerState;
  offscreenDocument.title = "BKA transport.worker-error";
  publishToBackground(lastWorkerState);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isRecord(message) || message.channel !== NATIVE_INPUT_MESSAGE_CHANNEL || sender.id !== chrome.runtime.id) return;
  const request = message.payload;
  if (isRecord(request) && (request.kind === "route.local.open" || request.kind === "route.local.close")) {
    const connection: LocalRouteConnection = {
      connectionGeneration: typeof message.connectionGeneration === "number" ? message.connectionGeneration : -1,
      relayEpoch: typeof message.relayEpoch === "string" ? message.relayEpoch : "",
    };
    const requestId = typeof request.requestId === "string" ? request.requestId : "invalid";
    const reject = (reason: string): void => sendResponse({ ...connection, confirmed: false, response: localRouteFailure(requestId, reason) });
    if (!isLocalRouteRequest(request) || (request.kind === "route.local.open" && request.durationMs > TRANSPORT_CONFIG.localRoute.maximumDurationMs)) {
      reject("local_route_request_invalid"); return;
    }
    if (transportWorker === undefined || connection.connectionGeneration !== activeGeneration || connection.relayEpoch !== activeRelayEpoch ||
        !activeCapabilities.includes(TRANSPORT_CONFIG.localRouteCapability)) { reject("local_route_unavailable"); return; }
    if (pendingLocal.has(requestId)) { reject("duplicate_request"); return; }
    if (pendingLocal.size >= TRANSPORT_CONFIG.maximumPendingRoutes) { reject("local_route_capacity"); return; }
    const timer = setTimeout(() => settleLocal(localRouteFailure(requestId, "local_route_response_timeout"), connection, false), TRANSPORT_CONFIG.localRoute.responseTimeoutMs);
    pendingLocal.set(requestId, { request, connection, timer, respond: sendResponse });
    try { transportWorker.postMessage({ kind: "transport.outbound", connectionGeneration: connection.connectionGeneration, payload: request }); }
    catch { settleLocal(localRouteFailure(requestId, "transport_disconnected"), connection, false); }
    return true;
  }
  if (isRecord(request) && request.kind === "transport.state") {
    sendResponse({ connectionGeneration: activeGeneration, relayEpoch: activeRelayEpoch, capabilities: activeCapabilities });
    return;
  }
  const generation = message.connectionGeneration;
  const timeoutMs = message.timeoutMs;
  if (!isRecord(request) || (request.kind !== "native.input.click" && request.kind !== "native.input.keyboard" && request.kind !== "native.virtualInput" && request.kind !== "native.recording") ||
      typeof request.requestId !== "string" ||
      !Number.isSafeInteger(generation) || generation !== activeGeneration || !Number.isSafeInteger(timeoutMs) ||
      (message.relayEpoch !== undefined && message.relayEpoch !== activeRelayEpoch) ||
      (timeoutMs as number) < 1 || transportWorker === undefined) {
    const requestId = isRecord(request) && typeof request.requestId === "string" ? request.requestId : "invalid";
    sendResponse(isRecord(request) && request.kind === "native.recording" ? nativeRecordingFailure(requestId, "transport_disconnected") : isRecord(request) && request.kind === "native.virtualInput" ? virtualInputFailure(requestId, "transport_disconnected") : isRecord(request) && request.kind === "native.input.keyboard"
      ? keyboardFailure(requestId, "transport_disconnected", "not_sent")
      : nativeFailure(requestId, "transport_disconnected", "not_sent"));
    return;
  }
  if (request.kind === "native.recording" && !activeCapabilities.includes(TRANSPORT_CONFIG.nativeRecordingCapability)) {
    sendResponse(nativeRecordingFailure(request.requestId, "REAL_BACKEND_UNAVAILABLE")); return;
  }
  if (pendingNative.has(request.requestId)) {
    sendResponse(request.kind === "native.recording" ? nativeRecordingFailure(request.requestId, "duplicate_request") : request.kind === "native.virtualInput" ? virtualInputFailure(request.requestId, "duplicate_request") : request.kind === "native.input.keyboard"
      ? keyboardFailure(request.requestId, "duplicate_request", "not_sent")
      : nativeFailure(request.requestId, "duplicate_request", "not_sent"));
    return;
  }
  const requestId = request.requestId;
  const requestKind = request.kind;
  const cleanupInputId = requestKind === "native.virtualInput" && isRecord(request.operation) &&
    request.operation.kind === "cleanup" && typeof request.operation.inputId === "string" ? request.operation.inputId : undefined;
  const relayEpoch = typeof request.relayEpoch === "string" ? request.relayEpoch : activeRelayEpoch;
  if (cleanupInputId !== undefined && relayEpoch !== null) {
    inputRetirements.set(retirementKey(relayEpoch, cleanupInputId), { inputId: cleanupInputId, at: Date.now(), relayEpoch, inFlight: true });
    startRetirementTimer();
  }
  const timer = setTimeout(() => {
    settleNative(requestKind === "native.recording" ? nativeRecordingFailure(requestId, "native_response_timeout") : requestKind === "native.virtualInput" ? virtualInputFailure(requestId, "native_response_timeout") : requestKind === "native.input.keyboard"
      ? keyboardFailure(requestId, "native_response_timeout", "unknown")
      : nativeFailure(requestId, "native_response_timeout", "unknown"));
  }, timeoutMs as number);
  pendingNative.set(requestId, {
    requestKind,
    generation: generation as number,
    ...(relayEpoch === null ? {} : { relayEpoch }),
    ...(cleanupInputId === undefined ? {} : { cleanupInputId }),
    timer,
    respond: (response) => {
      if (cleanupInputId !== undefined && relayEpoch !== null) {
        const record = inputRetirements.get(retirementKey(relayEpoch, cleanupInputId));
        if (record !== undefined) record.inFlight = false;
      }
      sendResponse(response);
    },
  });
  transportWorker.postMessage({
    kind: "transport.outbound",
    connectionGeneration: generation,
    payload: request as unknown as NativeInputClickRequest | NativeInputKeyboardRequest | VirtualInputRequest | NativeRecordingRequest,
  });
  return true;
});
