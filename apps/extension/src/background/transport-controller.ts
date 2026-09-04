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

export const TRANSPORT_MESSAGE_CHANNEL = "browser-key-automation.transport.v1";

let creationPromise: Promise<void> | undefined;
let lastDiagnosticState: unknown = null;
let connectedGeneration: number | null = null;
let connectedCapabilities: readonly string[] = [];

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
    }
    return dispatchRouteRequest(Reflect.get(payload, "payload"));
  }
  lastDiagnosticState = payload;
  const kind = Reflect.get(payload, "kind");
  if (kind === "transport.connected") {
    const generation = Reflect.get(payload, "connectionGeneration");
    const capabilities = Reflect.get(payload, "capabilities");
    connectedGeneration = Number.isSafeInteger(generation) ? generation as number : null;
    connectedCapabilities = Array.isArray(capabilities) && capabilities.every((value) => typeof value === "string")
      ? [...capabilities] : [];
    console.info("Browser Key Automation relay connected");
  } else if (kind === "transport.disconnected" || kind === "transport.protocol-error") {
    connectedGeneration = null;
    connectedCapabilities = [];
    if (kind === "transport.protocol-error") console.warn("Browser Key Automation relay protocol error");
  }
  return undefined;
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
): Promise<Extract<NativeInputClickResponse, { readonly ok: true }>> {
  const connectionGeneration = assertNativeInputClickAvailable();
  let response: unknown;
  try {
    response = await chrome.runtime.sendMessage({
      channel: NATIVE_INPUT_MESSAGE_CHANNEL,
      connectionGeneration,
      timeoutMs,
      payload: request,
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
): Promise<Extract<NativeInputKeyboardResponse, { readonly ok: true }>> {
  const connectionGeneration = assertNativeInputKeyboardAvailable();
  let response: unknown;
  try {
    response = await chrome.runtime.sendMessage({
      channel: NATIVE_INPUT_MESSAGE_CHANNEL,
      connectionGeneration,
      timeoutMs,
      payload: request,
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
