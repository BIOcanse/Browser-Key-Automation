import { COMMAND_CATALOG } from "../generated/command-config.js";
import { TRANSPORT_CONFIG } from "../generated/transport-config.js";
import type { PublicKeyRecord } from "../shared/admin-protocol.js";
import type { InputOperation, VirtualInputResult } from "../shared/virtual-input-protocol.js";
import { assertScriptingTargetAvailable } from "./browser-service.js";
import { restoreKeyboardWindow } from "./dom-service.js";
import { canonicalKeyNameForVirtualKey } from "./keyboard-model.js";
import { registerControlInputCleanup, assertWindowInputControl } from "./occupation-service.js";
import { assertResolvedTabTarget, resolveTabTarget } from "./tab-service.js";
import { requestVirtualInput, virtualInputGeneration, virtualInputRelayEpoch, refreshNativeConnection } from "./transport-controller.js";
import { VirtualMouseError } from "./virtual-mouse-model.js";
import type { AcquireNativeRoute } from "./local-route-client.js";
import type { LocalRouteConnection } from "../shared/local-route-protocol.js";

const STORAGE_KEY = "browser-key-automation.key-input.v1";
interface Binding {
  readonly keyId: string; readonly inputId: string; readonly generation: number; readonly relayEpoch: string;
}
let bindingsPromise: Promise<Map<string, Binding>> | undefined;
let storageTail: Promise<void> = Promise.resolve();
let attached = false;
export interface InputContext {
  readonly routeId: string; readonly key: PublicKeyRecord; readonly timeoutMs: number;
  readonly deadlineMs?: number | undefined;
  readonly acquireNativeRoute?: AcquireNativeRoute | undefined;
  readonly routeConnection?: LocalRouteConnection;
  readonly validateControl?: () => Promise<void>;
}
async function bindings(): Promise<Map<string, Binding>> {
  if (bindingsPromise === undefined) {
    const attempt = (async () => {
      await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      const stored = (await chrome.storage.session.get(STORAGE_KEY))[STORAGE_KEY];
      const result = new Map<string, Binding>();
      if (stored === undefined) return result;
      if (!Array.isArray(stored) || stored.length > COMMAND_CATALOG.limits["command.virtualMouse.maximum_objects"]) throw new VirtualMouseError("input_mapping_invalid");
      for (const entry of stored) {
        if (typeof entry !== "object" || entry === null || !/^[A-Za-z0-9_-]{22}$/u.test(entry.keyId) ||
            !/^[1-9][0-9]{0,15}$/u.test(entry.inputId) || !Number.isSafeInteger(entry.generation) ||
            !/^[A-Za-z0-9_-]{22}$/u.test(entry.relayEpoch) || result.has(entry.keyId)) throw new VirtualMouseError("input_mapping_invalid");
        result.set(entry.keyId, { keyId: entry.keyId, inputId: entry.inputId, generation: entry.generation, relayEpoch: entry.relayEpoch });
      }
      return result;
    })();
    bindingsPromise = attempt;
    void attempt.catch(() => { if (bindingsPromise === attempt) bindingsPromise = undefined; });
  }
  return bindingsPromise;
}
async function persist(): Promise<void> {
  const writing = storageTail.then(async () => chrome.storage.session.set({ [STORAGE_KEY]: [...(await bindings()).values()] }));
  storageTail = writing.catch(() => undefined);
  await writing;
}
function remaining(deadline: number): number {
  const budget = Math.floor(deadline - performance.now()) - TRANSPORT_CONFIG.nativeInputResponseMarginMs;
  if (budget < 1) throw new VirtualMouseError("timeout");
  return budget;
}
async function request(binding: Binding, operation: InputOperation, routeId?: string, timeoutMs: number = TRANSPORT_CONFIG.virtualMouse.cleanup_timeout_ms, connection?: LocalRouteConnection) {
  return requestVirtualInput({ kind: "native.virtualInput", requestId: crypto.randomUUID(),
    ...(routeId === undefined ? {} : { routeId }), timeoutMs,
    operation: { ...operation, inputId: binding.inputId } }, binding.generation, connection);
}
async function cleanupBinding(binding: Binding): Promise<void> {
  await refreshNativeConnection();
  // The original App epoch prevents an old numeric input ID from touching a new App object.
  await requestVirtualInput({ kind: "native.virtualInput", requestId: crypto.randomUUID(),
    timeoutMs: TRANSPORT_CONFIG.virtualMouse.cleanup_timeout_ms, relayEpoch: binding.relayEpoch,
    operation: { kind: "cleanup", inputId: binding.inputId } }, virtualInputGeneration());
}
function sameConnection(binding: Binding): boolean {
  return binding.generation === virtualInputGeneration() && binding.relayEpoch === virtualInputRelayEpoch();
}

/** Called only by an admitted input effect. Reads never allocate an App object. */
export async function ensureKeyInput(context: InputContext): Promise<Binding> {
  const deadline = Math.min(performance.now() + context.timeoutMs, context.deadlineMs ?? Infinity);
  const all = await bindings();
  await refreshNativeConnection();
  const generation = virtualInputGeneration();
  const existing = all.get(context.key.keyId);
  if (existing !== undefined) {
    if (!sameConnection(existing)) throw new VirtualMouseError("input_state_lost_reset_required");
    return existing;
  }
  const route = await context.acquireNativeRoute?.(deadline);
  await context.validateControl?.();
  const response = await requestVirtualInput({ kind: "native.virtualInput", requestId: crypto.randomUUID(), routeId: route?.routeId ?? context.routeId,
    timeoutMs: Math.min(remaining(deadline), TRANSPORT_CONFIG.virtualMouse.cleanup_timeout_ms), operation: { kind: "create" } }, generation, route?.connection ?? context.routeConnection);
  if (response.input === null) throw new VirtualMouseError("native_response_invalid");
  const binding: Binding = { keyId: context.key.keyId, inputId: String(response.input.id), generation,
    relayEpoch: virtualInputRelayEpoch() };
  all.set(binding.keyId, binding);
  try { await persist(); }
  catch (error) {
    // Allocation had no input; clean the unexposed native object if session persistence fails.
    await request(binding, { kind: "cleanup" }).catch(() => undefined);
    all.delete(binding.keyId);
    throw error;
  }
  return binding;
}
function keyboardNames(keys: readonly number[], bit: number, extended: readonly boolean[] = []): readonly string[] {
  const result: string[] = [];
  for (let vk = 1; vk < keys.length; vk += 1) {
    if (vk === 0x10 || vk === 0x11 || vk === 0x12 || ((keys[vk] ?? 0) & bit) === 0) continue;
    result.push(canonicalKeyNameForVirtualKey(vk, extended[vk] ?? false) ?? `VK_${vk.toString(16).toUpperCase()}`);
  }
  return result;
}
export function publicInputState(response: VirtualInputResult) {
  const input = response.input;
  return { initialized: input !== null, completedActions: response.completedActions, submittedScalars: response.submittedScalars ?? 0,
    mouse: input?.mouse ?? { point: { x: 0, y: 0 }, buttons: 0, known: true },
    keyboard: { heldKeys: keyboardNames(input?.keyboard.keys ?? [], 0x80, input?.keyboard.extended), toggledKeys: keyboardNames(input?.keyboard.keys ?? [], 1), known: input?.keyboard.known ?? true },
    windows: input?.windows.filter((window) => window !== null) ?? [], coordinates: input?.mouse.coordinates ?? "css_viewport" };
}
export async function getKeyInput(context: InputContext) {
  const binding = (await bindings()).get(context.key.keyId);
  if (binding === undefined) return publicInputState({ completedActions: 0, input: null });
  await refreshNativeConnection();
  if (!sameConnection(binding)) throw new VirtualMouseError("input_state_lost_reset_required");
  return publicInputState(await request(binding, { kind: "get" }, context.routeId, context.timeoutMs));
}
export async function resetKeyInput(context: InputContext, device: "mouse" | "keyboard") {
  const all = await bindings();
  const binding = all.get(context.key.keyId);
  if (binding === undefined) return publicInputState({ completedActions: 0, input: null });
  await refreshNativeConnection();
  if (!sameConnection(binding)) {
    await cleanupBinding(binding);
    all.delete(binding.keyId); await persist();
    return publicInputState({ completedActions: 0, input: null });
  }
  try {
    return publicInputState(await request(binding, { kind: device === "mouse" ? "reset" : "keyboardReset" }, context.routeId, context.timeoutMs));
  } catch (error) {
    if (!(error instanceof VirtualMouseError) || error.reason !== "InputNotFound") throw error;
    all.delete(binding.keyId); await persist();
    return publicInputState({ completedActions: 0, input: null });
  }
}
function markDocument(marker: string) {
  const page = globalThis as unknown as { innerWidth: number; innerHeight: number; document: { title: string } };
  const result = { originalTitle: page.document.title, width: page.innerWidth, height: page.innerHeight };
  page.document.title = marker;
  return result;
}
export async function operateKeyInput(context: InputContext, tabRef: string, operation: InputOperation, admittedWindowId: number) {
  const deadline = Math.min(performance.now() + context.timeoutMs, context.deadlineMs ?? Infinity);
  remaining(deadline);
  const route = await context.acquireNativeRoute?.(deadline);
  if (route !== undefined) {
    context = { ...context, routeId: route.routeId, routeConnection: route.connection, acquireNativeRoute: undefined, deadlineMs: deadline };
    remaining(deadline);
  }
  const target = await resolveTabTarget(tabRef);
  await assertScriptingTargetAvailable(target);
  const tab = await chrome.tabs.get(target.tabId);
  if (tab.windowId !== admittedWindowId) throw new VirtualMouseError("target_changed");
  if (!tab.active || tab.discarded) throw new VirtualMouseError("target_not_active");
  await assertWindowInputControl(context.key.keyId, tabRef);
  const binding = await ensureKeyInput({ ...context, timeoutMs: remaining(deadline) });
  const marker = `BKA input ${crypto.randomUUID()}`;
  const entries = await chrome.scripting.executeScript({ target: { tabId: target.tabId, frameIds: [0] }, world: "ISOLATED", func: markDocument, args: [marker] });
  const entry = entries[0];
  if (entries.length !== 1 || entry?.documentId === undefined || entry.result === undefined) throw new VirtualMouseError("document_unavailable");
  const page = { tabId: target.tabId, documentId: entry.documentId, ...entry.result };
  try {
    assertResolvedTabTarget(target);
    await context.validateControl?.();
    const current = await chrome.tabs.get(target.tabId);
    const frames = await chrome.webNavigation.getAllFrames({ tabId: target.tabId });
    if (!current.active || current.windowId !== tab.windowId || !frames.some((frame) => frame.frameId === 0 && frame.documentId === page.documentId)) throw new VirtualMouseError("target_changed");
    const response = await request(binding, { ...operation, marker, documentId: page.documentId, viewport: { width: page.width, height: page.height }, windowId: tab.windowId }, context.routeId, remaining(deadline), context.routeConnection);
    if (operation.kind === "calibrate") {
      if (response.calibration === undefined || response.calibration === null) throw new VirtualMouseError("native_response_invalid");
      return { windowId: tab.windowId, updated: response.calibration.updated, coordinates: "css_viewport" };
    }
    return publicInputState(response);
  } finally { await restoreKeyboardWindow(page, marker, Math.max(0, deadline - performance.now())); }
}
async function cleanupWindow(keyId: string, windowId: number | null): Promise<void> {
  const binding = (await bindings()).get(keyId);
  if (binding === undefined) return;
  await refreshNativeConnection();
  if (windowId === null || !sameConnection(binding)) {
    await cleanupBinding(binding);
    (await bindings()).delete(keyId); await persist();
    return;
  }
  const result = await request(binding, windowId === null ? { kind: "cleanup" } : { kind: "releaseWindow", windowId });
  if (windowId === null || result.input === null) { (await bindings()).delete(keyId); await persist(); }
}
export function initializeVirtualInputService(): void {
  if (attached) return;
  attached = true;
  registerControlInputCleanup(cleanupWindow);
}
