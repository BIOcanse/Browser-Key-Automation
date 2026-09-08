import { dispatchRouteRequest } from "./command-dispatcher.js";
import { TRANSPORT_CONFIG } from "../generated/transport-config.js";
import {
  NATIVE_INPUT_MESSAGE_CHANNEL,
  isNativeInputClickResponse,
  isNativeInputKeyboardResponse,
  type NativeInputClickRequest,
  type NativeInputClickResponse,
  type NativeInputKeyboardRequest,
  type NativeInputKeyboardResponse,
} from "../shared/native-input-protocol.js";
import { CapabilityUnavailableError } from "./capability-error.js";
import { NativeInputError } from "./native-input-error.js";
import { isVirtualInputResponse, type VirtualInputRequest } from "../shared/virtual-input-protocol.js";
import { VirtualMouseError } from "./virtual-mouse-model.js";
import { isNativeRecordingResponse, type NativeRecordingRequest } from "../shared/native-recording-protocol.js";
import { RecordingError } from "./recording/model.js";
import { isLocalRouteReceipt, type LocalRouteConnection, type LocalRouteRequest, type LocalRouteReceipt } from "../shared/local-route-protocol.js";

export const TRANSPORT_MESSAGE_CHANNEL = "browser-key-automation.transport.v1";

let creationPromise: Promise<void> | undefined;
let lastDiagnosticState: unknown = null;
let connectedGeneration: number | null = null;
let connectedCapabilities: readonly string[] = [];
let connectedRelayEpoch: string | null = null;

function rememberEpoch(payload: object): void {
  const epoch = Reflect.get(payload, "relayEpoch");
  connectedRelayEpoch = typeof epoch === "string" && /^[A-Za-z0-9_-]{22}$/u.test(epoch) ? epoch : null;
}

/** The offscreen connection outlives a recycled background worker. */
export async function refreshNativeConnection(): Promise<void> {
  await ensureTransportDocument();
  const payload: unknown = await chrome.runtime.sendMessage({ channel: NATIVE_INPUT_MESSAGE_CHANNEL, payload: { kind: "transport.state" } });
  if (typeof payload !== "object" || payload === null) throw new VirtualMouseError("transport_disconnected");
  const generation = Reflect.get(payload, "connectionGeneration");
  const capabilities = Reflect.get(payload, "capabilities");
  connectedGeneration = Number.isSafeInteger(generation) ? generation as number : null;
  connectedCapabilities = Array.isArray(capabilities) && capabilities.every((value) => typeof value === "string") ? capabilities : [];
  rememberEpoch(payload);
}

export function virtualInputRelayEpoch(): string {
  if (connectedRelayEpoch === null) throw new VirtualMouseError("transport_disconnected");
  return connectedRelayEpoch;
}

export function isTrustedTransportMessage(message: unknown, sender: ChromeMessageSender): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    Reflect.get(message, "channel") === TRANSPORT_MESSAGE_CHANNEL &&
    sender.id === chrome.runtime.id &&
    sender.url === chrome.runtime.getURL("offscreen/index.html")
  );
}

export async function acceptTransportMessage(message: unknown): Promise<unknown> {
  const payload = Reflect.get(message as object, "payload");
  if (typeof payload !== "object" || payload === null) return;
  if (Reflect.get(payload, "kind") === "transport.inbound") {
    const generation = Reflect.get(payload, "connectionGeneration");
    const capabilities = Reflect.get(payload, "capabilities");
    if (Number.isSafeInteger(generation) && Array.isArray(capabilities) &&
        capabilities.every((value) => typeof value === "string")) {
      connectedGeneration = generation as number;
      connectedCapabilities = [...capabilities];
      rememberEpoch(payload);
    }
    return dispatchRouteRequest(Reflect.get(payload, "payload"));
  }
  lastDiagnosticState = payload;
  const kind = Reflect.get(payload, "kind");
  if (kind === "transport.connected") {
    rememberEpoch(payload);
    const generation = Reflect.get(payload, "connectionGeneration");
    const capabilities = Reflect.get(payload, "capabilities");
    connectedGeneration = Number.isSafeInteger(generation) ? generation as number : null;
    connectedCapabilities = Array.isArray(capabilities) && capabilities.every((value) => typeof value === "string")
      ? [...capabilities] : [];
    console.info("Browser Key Automation relay connected");
  } else if (kind === "transport.disconnected" || kind === "transport.protocol-error" || kind === "transport.worker-error") {
    connectedGeneration = null;
    connectedCapabilities = [];
    connectedRelayEpoch = null;
    if (kind === "transport.protocol-error") console.warn("Browser Key Automation relay protocol error");
  }
  return undefined;
}

export function virtualInputGeneration(): number {
  if (connectedGeneration === null || !connectedCapabilities.includes(TRANSPORT_CONFIG.virtualMouseCapability)) {
    throw new CapabilityUnavailableError("platform.relay.virtual_mouse", "NATIVE_BACKEND_UNAVAILABLE", "A Windows x64 App with the virtual mouse backend is required");
  }
  return connectedGeneration;
}

async function sendVirtualInput(request: VirtualInputRequest, generation: number, connection?: LocalRouteConnection) {
  let response: unknown;
  try {
    response = await chrome.runtime.sendMessage({ channel: NATIVE_INPUT_MESSAGE_CHANNEL,
      connectionGeneration: generation, timeoutMs: request.timeoutMs + TRANSPORT_CONFIG.nativeInputResponseMarginMs,
      payload: request, ...(connection === undefined ? {} : { relayEpoch: connection.relayEpoch }) });
  } catch { throw new VirtualMouseError("transport_disconnected"); }
  if (!isVirtualInputResponse(response, request.requestId)) throw new VirtualMouseError("native_response_invalid");
  if (!response.ok) throw new VirtualMouseError(response.error.reason, response.error.progress);
  return response.result;
}

export async function requestVirtualInput(request: VirtualInputRequest, expectedGeneration: number, connection?: LocalRouteConnection) {
  if (virtualInputGeneration() !== expectedGeneration) throw new VirtualMouseError("connection_changed");
  assertRouteConnection(connection, expectedGeneration);
  return sendVirtualInput(request, expectedGeneration, connection);
}

function assertRouteConnection(connection: LocalRouteConnection | undefined, generation: number): void {
  if (connection !== undefined && (connection.connectionGeneration !== generation || connection.relayEpoch !== connectedRelayEpoch)) throw new VirtualMouseError("connection_changed");
}

export function localRouteConnection(): LocalRouteConnection {
  if (connectedGeneration === null || connectedRelayEpoch === null || !connectedCapabilities.includes(TRANSPORT_CONFIG.localRouteCapability)) {
    throw new VirtualMouseError("local_route_unavailable");
  }
  return { connectionGeneration: connectedGeneration, relayEpoch: connectedRelayEpoch };
}

export async function requestLocalRoute(request: LocalRouteRequest, connection: LocalRouteConnection): Promise<LocalRouteReceipt> {
  const current = localRouteConnection();
  if (current.connectionGeneration !== connection.connectionGeneration || current.relayEpoch !== connection.relayEpoch) throw new VirtualMouseError("connection_changed");
  let receipt: unknown;
  try { receipt = await chrome.runtime.sendMessage({ channel: NATIVE_INPUT_MESSAGE_CHANNEL, ...connection, payload: request }); }
  catch { throw new VirtualMouseError("transport_disconnected"); }
  if (!isLocalRouteReceipt(receipt, request, connection)) throw new VirtualMouseError("local_route_response_invalid");
  return receipt;
}

export async function requestNativeRecording(request: NativeRecordingRequest, connection: LocalRouteConnection) {
  if (connection.connectionGeneration !== connectedGeneration || connection.relayEpoch !== connectedRelayEpoch)
    throw new RecordingError({ reason: "CONNECTION_CHANGED" });
  if (!connectedCapabilities.includes(TRANSPORT_CONFIG.nativeRecordingCapability)) throw new RecordingError({ reason: "REAL_BACKEND_UNAVAILABLE" });
  let response: unknown;
  try { response = await chrome.runtime.sendMessage({ channel: NATIVE_INPUT_MESSAGE_CHANNEL, ...connection,
    timeoutMs: request.timeoutMs + TRANSPORT_CONFIG.nativeInputResponseMarginMs, payload: request }); }
  catch { throw new RecordingError({ reason: "TRANSPORT_DISCONNECTED" }); }
  if (!isNativeRecordingResponse(response, request.requestId)) throw new RecordingError({ reason: "NATIVE_RESPONSE_INVALID" });
  if (!response.ok) throw new RecordingError({ reason: response.error.reason });
  if (response.result.resourceId !== null && response.result.resourceId !== request.operation.resourceId)
    throw new RecordingError({ reason: "NATIVE_RESOURCE_MISMATCH" });
  return response.result;
}

export function assertNativeInputClickAvailable(): number {
  if (connectedGeneration === null || !connectedCapabilities.includes(TRANSPORT_CONFIG.nativeInputClickCapability)) {
    throw new CapabilityUnavailableError(
      "platform.relay.native_input",
      "NATIVE_BACKEND_UNAVAILABLE",
      "The connected local App does not advertise the native click backend",
    );
  }
  return connectedGeneration;
}

export function assertNativeInputKeyboardAvailable(): number {
  if (connectedGeneration === null || !connectedCapabilities.includes(TRANSPORT_CONFIG.nativeInputKeyboardCapability)) {
    throw new CapabilityUnavailableError(
      "platform.relay.native_keyboard",
      "NATIVE_BACKEND_UNAVAILABLE",
      "The connected local App does not advertise the native keyboard backend",
    );
  }
  return connectedGeneration;
}

export async function requestNativeClick(
  request: NativeInputClickRequest,
  timeoutMs: number,
  connection?: LocalRouteConnection,
): Promise<Extract<NativeInputClickResponse, { readonly ok: true }>> {
  const connectionGeneration = assertNativeInputClickAvailable();
  assertRouteConnection(connection, connectionGeneration);
  let response: unknown;
  try {
    response = await chrome.runtime.sendMessage({
      channel: NATIVE_INPUT_MESSAGE_CHANNEL,
      connectionGeneration,
      timeoutMs,
      payload: request,
      ...(connection === undefined ? {} : { relayEpoch: connection.relayEpoch }),
    });
  } catch {
    throw new NativeInputError({ reason: "transport_disconnected", phase: "input", clickState: "unknown" });
  }
  if (!isNativeInputClickResponse(response, request.requestId)) {
    throw new NativeInputError({ reason: "native_response_invalid", phase: "input", clickState: "unknown" });
  }
  if (!response.ok) throw new NativeInputError(response.error);
  return response;
}

export async function requestNativeKeyboard(
  request: NativeInputKeyboardRequest,
  timeoutMs: number,
  connection?: LocalRouteConnection,
): Promise<Extract<NativeInputKeyboardResponse, { readonly ok: true }>> {
  const connectionGeneration = assertNativeInputKeyboardAvailable();
  assertRouteConnection(connection, connectionGeneration);
  let response: unknown;
  try {
    response = await chrome.runtime.sendMessage({
      channel: NATIVE_INPUT_MESSAGE_CHANNEL,
      connectionGeneration,
      timeoutMs,
      payload: request,
      ...(connection === undefined ? {} : { relayEpoch: connection.relayEpoch }),
    });
  } catch {
    throw new NativeInputError({
      reason: "transport_disconnected", phase: "input", inputState: "unknown", completedActions: 0,
    });
  }
  if (!isNativeInputKeyboardResponse(response, request.requestId)) {
    throw new NativeInputError({
      reason: "native_response_invalid", phase: "input", inputState: "unknown", completedActions: 0,
    });
  }
  if (!response.ok) throw new NativeInputError(response.error);
  return response;
}

export function getTransportDiagnosticState(): unknown {
  return lastDiagnosticState;
}

export async function ensureTransportDocument(): Promise<void> {
  if (creationPromise !== undefined) return creationPromise;
  creationPromise = (async () => {
    if (await chrome.offscreen.hasDocument()) return;
    const creatingState = { kind: "transport.document-creating" };
    lastDiagnosticState = creatingState;
    try {
      await chrome.offscreen.createDocument({
        url: "offscreen/index.html",
        reasons: ["WORKERS"],
        justification: "Keep the loopback relay connection and fixed retry cadence alive.",
      });
      if (lastDiagnosticState === creatingState) {
        lastDiagnosticState = { kind: "transport.document-ready" };
      }
    } catch (error) {
      lastDiagnosticState = {
        kind: "transport.document-error",
        detail: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  })();
  try {
    await creationPromise;
  } finally {
    creationPromise = undefined;
  }
}
