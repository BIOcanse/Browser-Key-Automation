import { TRANSPORT_CONFIG } from "../generated/transport-config.js";
import type { NativeInputClickRequest } from "../shared/native-input-protocol.js";
import { CapabilityUnavailableError } from "./capability-error.js";
import {
  prepareRealClickNode,
  resolveNodeRefTarget,
  restoreRealClickTitle,
  type NodeRefTarget,
} from "./dom-service.js";
import { NativeInputError } from "./native-input-error.js";
import { assertNativeInputClickAvailable, requestNativeClick } from "./transport-controller.js";

export interface RealClickRequest {
  readonly routeId: string;
  readonly nodeRef: string;
  readonly scrollIntoView: boolean;
  readonly timeoutMs: number;
  readonly revalidateAuthority: () => Promise<void>;
}

function randomToken(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${prefix}${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
}

function sameTarget(left: NodeRefTarget, right: NodeRefTarget): boolean {
  return left.nodeRef === right.nodeRef && left.tabRef === right.tabRef && left.tabId === right.tabId &&
    left.frameId === right.frameId && left.documentId === right.documentId;
}

function remainingMs(deadline: number): number {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining < 1) {
    throw new NativeInputError({ reason: "timeout", phase: "prepare", clickState: "not_sent" });
  }
  return remaining;
}

export async function clickRealDomNode(
  request: RealClickRequest,
): Promise<{ readonly nodeRef: string; readonly status: "input_sent" }> {
  const deadline = performance.now() + request.timeoutMs;
  // The old App/platform path must fail before tab activation, focus, scroll or title mutation.
  assertNativeInputClickAvailable();
  const target = resolveNodeRefTarget(request.nodeRef);
  if (target.frameId !== 0) {
    throw new NativeInputError({ reason: "frame_not_supported", phase: "prepare", clickState: "not_sent" });
  }
  try {
    const activated = await chrome.tabs.update(target.tabId, { active: true });
    await chrome.windows.update(activated.windowId, { focused: true });
  } catch {
    throw new CapabilityUnavailableError(
      "platform.extension.tabs",
      "CHROMIUM_API_FAILED",
      "Chromium could not activate the exact target tab and window",
    );
  }
  remainingMs(deadline);

  const requestId = randomToken("ni1.");
  const marker = `BKA real ${randomToken("")}`;
  let restoreTitle: string | null = null;
  try {
    const prepared = await prepareRealClickNode(request.nodeRef, request.scrollIntoView, marker);
    restoreTitle = prepared.originalTitle;
    remainingMs(deadline);
    await request.revalidateAuthority();
    const currentTarget = resolveNodeRefTarget(request.nodeRef);
    if (!sameTarget(target, currentTarget)) {
      throw new NativeInputError({ reason: "target_changed", phase: "prepare", clickState: "not_sent" });
    }
    const verified = await prepareRealClickNode(request.nodeRef, false, marker);
    if (verified.originalTitle !== marker) restoreTitle = verified.originalTitle;
    const timeoutMs = remainingMs(deadline);
    const nativeTimeoutMs = timeoutMs - TRANSPORT_CONFIG.nativeInputResponseMarginMs;
    if (nativeTimeoutMs < 1) {
      throw new NativeInputError({ reason: "timeout", phase: "prepare", clickState: "not_sent" });
    }
    const nativeRequest: NativeInputClickRequest = {
      kind: "native.input.click",
      requestId,
      routeId: request.routeId,
      timeoutMs: nativeTimeoutMs,
      marker,
      point: verified.point,
      viewport: verified.viewport,
    };
    const response = await requestNativeClick(nativeRequest, timeoutMs);
    if (response.result.status !== "input_sent") {
      throw new NativeInputError({ reason: "native_response_invalid", phase: "input", clickState: "unknown" });
    }
    return { nodeRef: request.nodeRef, status: "input_sent" };
  } finally {
    if (restoreTitle !== null) await restoreRealClickTitle(target, marker, restoreTitle);
  }
}
