import { COMMAND_CATALOG } from "../generated/command-config.js";
import { TRANSPORT_CONFIG } from "../generated/transport-config.js";
import type { PublicKeyRecord } from "../shared/admin-protocol.js";
import type { InputOperation, VirtualInputResult } from "../shared/virtual-input-protocol.js";
import { assertScriptingTargetAvailable } from "./browser-service.js";
import { restoreKeyboardWindow } from "./dom-service.js";
import { onKeyChanged } from "./key-service.js";
import { canonicalKeyNameForVirtualKey } from "./keyboard-model.js";
import { registerControlInputCleanup, assertWindowInputControl } from "./occupation-service.js";
import { assertResolvedTabTarget, resolveTabTarget } from "./tab-service.js";
import { requestVirtualInput, virtualInputGeneration, virtualInputRelayEpoch, refreshNativeConnection } from "./transport-controller.js";
import { VirtualMouseError } from "./virtual-mouse-model.js";

const STORAGE_KEY = "browser-key-automation.key-input.v1";
interface Binding {
  readonly keyId: string; readonly inputId: string; readonly generation: number; readonly relayEpoch: string;
  readonly permissions: readonly string[]; readonly expiresAt: number | null;
}
let bindingsPromise: Promise<Map<string, Binding>> | undefined;
let storageTail: Promise<void> = Promise.resolve();
let attached = false;
export interface InputContext {
  readonly routeId: string; readonly key: PublicKeyRecord; readonly timeoutMs: number;
  readonly deadlineMs?: number;
  readonly revalidateAuthority: () => Promise<void>;
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
            !/^[A-Za-z0-9_-]{22}$/u.test(entry.relayEpoch) ||
            !Array.isArray(entry.permissions) || !entry.permissions.every((value: unknown) => typeof value === "string") ||
            !(entry.expiresAt === null || Number.isSafeInteger(entry.expiresAt)) || result.has(entry.keyId)) throw new VirtualMouseError("input_mapping_invalid");
        result.set(entry.keyId, entry as Binding);
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
function permissions(key: PublicKeyRecord): readonly string[] {
  return key.keyKind === "root" ? COMMAND_CATALOG.activePermissionIds : key.permissions;
}
function remaining(deadline: number): number {
  const budget = Math.floor(deadline - performance.now()) - TRANSPORT_CONFIG.nativeInputResponseMarginMs;
  if (budget < 1) throw new VirtualMouseError("timeout");
  return budget;
}
async function request(binding: Binding, operation: InputOperation, routeId?: string, timeoutMs: number = TRANSPORT_CONFIG.virtualMouse.cleanup_timeout_ms) {
  return requestVirtualInput({ kind: "native.virtualInput", requestId: crypto.randomUUID(),
    ...(routeId === undefined ? {} : { routeId }), timeoutMs,
    operation: { ...operation, inputId: binding.inputId } }, binding.generation, binding.expiresAt);
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
  const all = await bindings();
  await refreshNativeConnection();
  const generation = virtualInputGeneration();
  const existing = all.get(context.key.keyId);
  if (existing !== undefined) {
    if (!sameConnection(existing)) throw new VirtualMouseError("input_state_lost_reset_required");
    return existing;
  }
  await context.revalidateAuthority();
  const response = await requestVirtualInput({ kind: "native.virtualInput", requestId: crypto.randomUUID(), routeId: context.routeId,
    timeoutMs: Math.min(context.timeoutMs, TRANSPORT_CONFIG.virtualMouse.cleanup_timeout_ms), operation: { kind: "create" } }, generation, context.key.expiresAt);
  if (response.input === null) throw new VirtualMouseError("native_response_invalid");
  const binding: Binding = { keyId: context.key.keyId, inputId: String(response.input.id), generation,
    relayEpoch: virtualInputRelayEpoch(),
    permissions: permissions(context.key), expiresAt: context.key.expiresAt };
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
function keyboardNames(keys: readonly number[], bit: number): readonly string[] {
  const result: string[] = [];
  for (let vk = 1; vk < keys.length; vk += 1) {
    if (vk === 0x10 || vk === 0x11 || vk === 0x12 || ((keys[vk] ?? 0) & bit) === 0) continue;
    result.push(canonicalKeyNameForVirtualKey(vk) ?? `VK_${vk.toString(16).toUpperCase()}`);
  }
  return result;
}
export function publicInputState(response: VirtualInputResult) {
  const input = response.input;
  return { initialized: input !== null, completedActions: response.completedActions,
    mouse: input?.mouse ?? { point: { x: 0, y: 0 }, buttons: 0, known: true },
    keyboard: { heldKeys: keyboardNames(input?.keyboard.keys ?? [], 0x80), toggledKeys: keyboardNames(input?.keyboard.keys ?? [], 1), known: input?.keyboard.known ?? true },
    windows: input?.windows.filter((window) => window !== null) ?? [], coordinates: "css_viewport" };
}
export async function getKeyInput(context: InputContext) {
  const binding = (await bindings()).get(context.key.keyId);
  await context.revalidateAuthority();
  if (binding === undefined) return publicInputState({ completedActions: 0, input: null });
  await refreshNativeConnection();
  if (!sameConnection(binding)) throw new VirtualMouseError("input_state_lost_reset_required");
  return publicInputState(await request(binding, { kind: "get" }, context.routeId, context.timeoutMs));
}
export async function resetKeyInput(context: InputContext, device: "mouse" | "keyboard") {
  const all = await bindings();
  const binding = all.get(context.key.keyId);
  await context.revalidateAuthority();
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
    await context.revalidateAuthority();
    const current = await chrome.tabs.get(target.tabId);
    const frames = await chrome.webNavigation.getAllFrames({ tabId: target.tabId });
    if (!current.active || current.windowId !== tab.windowId || !frames.some((frame) => frame.frameId === 0 && frame.documentId === page.documentId)) throw new VirtualMouseError("target_changed");
    const response = await request(binding, { ...operation, marker, documentId: page.documentId, viewport: { width: page.width, height: page.height }, windowId: tab.windowId }, context.routeId, remaining(deadline));
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
  onKeyChanged(async (key) => {
    const all = await bindings();
    const binding = all.get(key.keyId);
    if (binding === undefined) return;
    if (!key.enabled || key.status === "revoked" || key.expiresAt !== null && key.expiresAt <= Date.now()) {
      await cleanupWindow(key.keyId, null);
      return;
    }
    const granted = permissions(key);
    await refreshNativeConnection();
    if (!sameConnection(binding)) { await cleanupWindow(key.keyId, null); return; }
    if (binding.permissions.includes("virtualMouse") && !granted.includes("virtualMouse")) await request(binding, { kind: "reset" });
    if (["virtualKeyboard", "keyboard.press"].some((permission) => binding.permissions.includes(permission) && !granted.includes(permission))) await request(binding, { kind: "keyboardReset" });
    const next = { ...binding, permissions: granted, expiresAt: key.expiresAt };
    all.set(key.keyId, next); await persist();
    await request(next, { kind: "get" }); // Refresh only the offscreen expiry, never replay state.
  });
}
