import {
  NATIVE_INPUT_MESSAGE_CHANNEL,
  isNativeInputClickResponse,
  isNativeInputKeyboardResponse,
  type NativeInputClickRequest,
  type NativeInputClickResponse,
  type NativeInputKeyboardRequest,
  type NativeInputKeyboardResponse,
} from "./shared/native-input-protocol.js";

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
const pendingNative = new Map<string, {
  readonly requestKind: "native.input.click" | "native.input.keyboard";
  readonly generation: number;
  readonly timer: number;
  readonly respond: (response: NativeInputClickResponse | NativeInputKeyboardResponse) => void;
}>();

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

function settleNative(response: NativeInputClickResponse | NativeInputKeyboardResponse): boolean {
  const pending = pendingNative.get(response.requestId);
  if (pending === undefined) return false;
  pendingNative.delete(response.requestId);
  clearTimeout(pending.timer);
  pending.respond(response);
  return true;
}

function failPendingNative(reason: string): void {
  for (const [requestId, pending] of [...pendingNative.entries()]) {
    settleNative(pending.requestKind === "native.input.click"
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
      } else if (kind === "transport.disconnected" || kind === "transport.protocol-error") {
        activeGeneration = null;
        failPendingNative("transport_disconnected");
      } else if (kind === "transport.inbound") {
        const response = event.data.payload;
        if ((isNativeInputClickResponse(response) || isNativeInputKeyboardResponse(response)) && settleNative(response)) return;
      }
    }
    publishToBackground(event.data);
  });
  worker.addEventListener("error", () => {
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
  const generation = message.connectionGeneration;
  const timeoutMs = message.timeoutMs;
  if (!isRecord(request) || (request.kind !== "native.input.click" && request.kind !== "native.input.keyboard") ||
      typeof request.requestId !== "string" ||
      !Number.isSafeInteger(generation) || generation !== activeGeneration || !Number.isSafeInteger(timeoutMs) ||
      (timeoutMs as number) < 1 || transportWorker === undefined) {
    const requestId = isRecord(request) && typeof request.requestId === "string" ? request.requestId : "invalid";
    sendResponse(isRecord(request) && request.kind === "native.input.keyboard"
      ? keyboardFailure(requestId, "transport_disconnected", "not_sent")
      : nativeFailure(requestId, "transport_disconnected", "not_sent"));
    return;
  }
  if (pendingNative.has(request.requestId)) {
    sendResponse(request.kind === "native.input.keyboard"
      ? keyboardFailure(request.requestId, "duplicate_request", "not_sent")
      : nativeFailure(request.requestId, "duplicate_request", "not_sent"));
    return;
  }
  const requestId = request.requestId;
  const requestKind = request.kind;
  const timer = setTimeout(() => {
    settleNative(requestKind === "native.input.keyboard"
      ? keyboardFailure(requestId, "native_response_timeout", "unknown")
      : nativeFailure(requestId, "native_response_timeout", "unknown"));
  }, timeoutMs as number);
  pendingNative.set(requestId, {
    requestKind,
    generation: generation as number,
    timer,
    respond: sendResponse,
  });
  transportWorker.postMessage({
    kind: "transport.outbound",
    connectionGeneration: generation,
    payload: request as unknown as NativeInputClickRequest | NativeInputKeyboardRequest,
  });
  return true;
});
