import { COMMAND_CATALOG } from "../generated/command-config.js";
import { TRANSPORT_CONFIG } from "../generated/transport-config.js";
import type {
  NativeInputKeyboardRequest,
  NativeKeyboardOperation,
} from "../shared/native-input-protocol.js";
import { CapabilityUnavailableError } from "./capability-error.js";
import {
  focusKeyboardNode,
  isNodeRefShape,
  markKeyboardWindow,
  resolveNodeRefTarget,
  restoreKeyboardWindow,
  tabRefForNode,
  type NodeRefTarget,
} from "./dom-service.js";
import {
  buildHumanTypingPlan,
  canonicalKeyNameForVirtualKey,
  type NativeKeyboardAction,
} from "./keyboard-model.js";
import { NativeInputError } from "./native-input-error.js";
import { assertResolvedTabTarget, isTabRefShape, resolveTabTarget } from "./tab-service.js";
import { assertNativeInputKeyboardAvailable, requestNativeKeyboard } from "./transport-controller.js";

export interface KeyboardDispatchContext {
  readonly routeId: string;
  readonly timeoutMs: number;
  readonly revalidateAuthority: () => Promise<void>;
}

export interface KeyboardTargetDispatchContext extends KeyboardDispatchContext {
  readonly targetRef: string;
}

function failure(reason: string, phase: "prepare" | "input" = "prepare"): NativeInputError {
  return new NativeInputError({ reason, phase, inputState: phase === "prepare" ? "not_sent" : "unknown", completedActions: 0 });
}

function randomToken(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${prefix}${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
}

function randomSeed(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] ?? 0;
}

function remainingMs(deadline: number): number {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining < 1) throw failure("timeout");
  return remaining;
}

function sameNodeTarget(left: NodeRefTarget, right: NodeRefTarget): boolean {
  return left.nodeRef === right.nodeRef && left.tabRef === right.tabRef && left.tabId === right.tabId &&
    left.frameId === right.frameId && left.documentId === right.documentId;
}

function heldNames(virtualKeys: readonly number[]): readonly string[] {
  const names: string[] = [];
  for (const virtualKey of virtualKeys) {
    const name = canonicalKeyNameForVirtualKey(virtualKey);
    if (name === null) throw failure("native_response_invalid", "input");
    names.push(name);
  }
  return names;
}

export function tabRefForKeyboardTarget(targetRef: string): string {
  if (isTabRefShape(targetRef)) return targetRef;
  if (isNodeRefShape(targetRef)) return tabRefForNode(targetRef);
  throw new Error("Validated keyboard target became invalid");
}

async function activateExactTab(tabRef: string): Promise<void> {
  const target = await resolveTabTarget(tabRef);
  assertResolvedTabTarget(target);
  try {
    const activated = await chrome.tabs.update(target.tabId, { active: true });
    await chrome.windows.update(activated.windowId, { focused: true });
  } catch {
    throw new CapabilityUnavailableError(
      "platform.extension.tabs",
      "CHROMIUM_API_FAILED",
      "Chromium could not activate the exact native-keyboard target tab and window",
    );
  }
  assertResolvedTabTarget(target);
}

async function executeTargeted(
  context: KeyboardTargetDispatchContext,
  operation: NativeKeyboardOperation,
): Promise<Extract<Awaited<ReturnType<typeof requestNativeKeyboard>>, { readonly ok: true }>["result"]> {
  const deadline = performance.now() + context.timeoutMs;
  assertNativeInputKeyboardAvailable();
  const nodeTarget = isNodeRefShape(context.targetRef) ? resolveNodeRefTarget(context.targetRef) : null;
  const tabRef = nodeTarget?.tabRef ?? context.targetRef;
  if (!isTabRefShape(tabRef)) throw new Error("Validated keyboard target became invalid");
  await activateExactTab(tabRef);
  remainingMs(deadline);
  if (nodeTarget !== null) await focusKeyboardNode(nodeTarget.nodeRef);

  const marker = `BKA keys ${randomToken("")}`;
  let windowMarker = await markKeyboardWindow(tabRef, marker);
  try {
    remainingMs(deadline);
    await context.revalidateAuthority();
    const currentTab = await resolveTabTarget(tabRef);
    assertResolvedTabTarget(currentTab);
    if (nodeTarget !== null) {
      const currentNode = resolveNodeRefTarget(nodeTarget.nodeRef);
      if (!sameNodeTarget(nodeTarget, currentNode)) throw failure("target_changed");
      await focusKeyboardNode(nodeTarget.nodeRef);
    }
    const verifiedMarker = await markKeyboardWindow(tabRef, marker);
    if (verifiedMarker.originalTitle !== marker) windowMarker = verifiedMarker;
    const timeoutMs = remainingMs(deadline);
    const nativeTimeoutMs = timeoutMs - TRANSPORT_CONFIG.nativeInputResponseMarginMs;
    if (nativeTimeoutMs < 1) throw failure("timeout");
    const request: NativeInputKeyboardRequest = {
      kind: "native.input.keyboard",
      requestId: randomToken("nk1."),
      routeId: context.routeId,
      timeoutMs: nativeTimeoutMs,
      marker,
      operation,
    };
    return (await requestNativeKeyboard(request, timeoutMs)).result;
  } finally {
    await restoreKeyboardWindow(windowMarker, marker);
  }
}

export async function typeKeyboardText(
  context: KeyboardTargetDispatchContext,
  text: string,
): Promise<{ readonly targetRef: string; readonly status: "input_sent"; readonly submittedScalars: number }> {
  const result = await executeTargeted(context, { kind: "type", text });
  return { targetRef: context.targetRef, status: result.status, submittedScalars: result.submittedScalars };
}

export async function typeKeyboardTextHuman(
  context: KeyboardTargetDispatchContext,
  text: string,
  charactersPerMinute: number,
  mistakePercent: number,
  requestedSeed: number | null,
): Promise<{
  readonly targetRef: string;
  readonly status: "input_sent";
  readonly submittedScalars: number;
  readonly correctedMistakes: number;
  readonly randomSeed: number;
}> {
  const seed = requestedSeed ?? randomSeed();
  const plan = buildHumanTypingPlan(text, charactersPerMinute, mistakePercent, seed);
  if (plan.estimatedDurationMs + TRANSPORT_CONFIG.nativeInputResponseMarginMs >= context.timeoutMs) {
    throw failure("timeout");
  }
  const result = await executeTargeted(context, {
    kind: "type_human",
    text,
    delaysMs: plan.delaysMs,
    mistakes: plan.mistakes,
  });
  return {
    targetRef: context.targetRef,
    status: result.status,
    submittedScalars: result.submittedScalars,
    correctedMistakes: result.correctedMistakes,
    randomSeed: plan.randomSeed,
  };
}

export async function pressKeyboard(
  context: KeyboardTargetDispatchContext,
  actions: readonly NativeKeyboardAction[],
): Promise<{
  readonly targetRef: string;
  readonly status: "input_sent";
  readonly completedActions: number;
  readonly heldKeys: readonly string[];
}> {
  const result = await executeTargeted(context, { kind: "press", actions });
  return {
    targetRef: context.targetRef,
    status: result.status,
    completedActions: result.completedActions,
    heldKeys: heldNames(result.heldVirtualKeys),
  };
}

export async function resetKeyboard(context: KeyboardDispatchContext): Promise<{
  readonly status: "input_sent";
  readonly completedActions: number;
  readonly heldKeys: readonly string[];
}> {
  const deadline = performance.now() + context.timeoutMs;
  assertNativeInputKeyboardAvailable();
  await context.revalidateAuthority();
  const timeoutMs = remainingMs(deadline);
  const nativeTimeoutMs = timeoutMs - TRANSPORT_CONFIG.nativeInputResponseMarginMs;
  if (nativeTimeoutMs < 1) throw failure("timeout");
  const request: NativeInputKeyboardRequest = {
    kind: "native.input.keyboard",
    requestId: randomToken("nk1."),
    routeId: context.routeId,
    timeoutMs: nativeTimeoutMs,
    marker: null,
    operation: { kind: "reset" },
  };
  const result = (await requestNativeKeyboard(request, timeoutMs)).result;
  return { status: result.status, completedActions: result.completedActions, heldKeys: heldNames(result.heldVirtualKeys) };
}

export const KEYBOARD_MAXIMUM_TEXT_BYTES = COMMAND_CATALOG.limits["command.keyboard.maximum_text_bytes"];
