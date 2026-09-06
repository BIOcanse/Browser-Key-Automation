import { isTabRefShape, tabIdFromTabRef } from "./tab-service.js";

const OCCUPATION_STORAGE_KEY = "browser-key-automation.occupations.v1";
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;

export type ControlScope = "global" | "tab" | "window";
export interface ControlTarget {
  readonly scope: ControlScope;
  readonly tabRef: string | null;
  readonly windowId?: number;
}
export interface ControlConflict extends ControlTarget { readonly ownerKeyId: string }
export interface AcquireControlResult extends ControlTarget { readonly ownerKeyId: string; readonly alreadyOwned: boolean }
export interface ReleaseControlResult extends ControlTarget { readonly released: boolean; readonly previousOwnerKeyId: string | null }
interface TabOccupation { readonly tabRef: string; readonly ownerKeyId: string }
interface OccupationState {
  readonly globalOwnerKeyId: string | null;
  readonly tabOwners: ReadonlyMap<number, TabOccupation>;
  readonly windowOwners: ReadonlyMap<number, string>;
}
interface InputDelivery { readonly keyId: string; readonly windowId: number; readonly completion: Promise<unknown> }
type InputCleanup = (keyId: string, windowId: number | null) => Promise<void>;

export class ControlOccupiedError extends Error {
  readonly code = "CONTROL_OCCUPIED" as const;
  constructor(readonly details: ControlConflict) {
    super("The requested scope is occupied or being released");
    this.name = "ControlOccupiedError";
  }
}
export class WindowOccupationRequiredError extends Error {
  readonly code = "CONTROL_OCCUPIED" as const;
  readonly details: { readonly reason: "window_occupation_required"; readonly windowId: number };
  constructor(windowId: number) {
    super("Virtual input requires this Key to occupy the whole window first");
    this.details = { reason: "window_occupation_required", windowId };
  }
}
let statePromise: Promise<OccupationState> | undefined;
let controlLaneTail: Promise<void> = Promise.resolve();
let lifecycleAttached = false;
let cleanupInput: InputCleanup = async () => undefined;
const inputDeliveries = new Set<InputDelivery>();
const releasing = new Map<string, { readonly target: ControlTarget; readonly ownerKeyId: string; readonly completion: Promise<ReleaseControlResult> }>();

function emptyState(): OccupationState {
  return { globalOwnerKeyId: null, tabOwners: new Map(), windowOwners: new Map() };
}
function isKeyId(value: unknown): value is string { return typeof value === "string" && KEY_ID_PATTERN.test(value); }
function positiveId(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function requiredTabId(tabRef: string | null): number {
  const id = tabIdFromTabRef(tabRef ?? "");
  if (id === null) throw new Error("Invalid TabRef reached occupation service");
  return id;
}
function requiredWindowId(target: ControlTarget): number {
  if (!positiveId(target.windowId)) throw new Error("Invalid windowId reached occupation service");
  return target.windowId;
}
function parseStoredState(value: unknown): OccupationState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  // v2 is the released tab/global session format. Do not lose its live occupations.
  const legacy = record.version === 2;
  const expected = legacy ? ["globalOwnerKeyId", "tabOwners", "version"] : ["globalOwnerKeyId", "tabOwners", "version", "windowOwners"];
  if (Object.keys(record).sort().join() !== expected.join() || (!legacy && record.version !== 3) ||
      !(record.globalOwnerKeyId === null || isKeyId(record.globalOwnerKeyId)) || !Array.isArray(record.tabOwners)) return null;
  const tabOwners = new Map<number, TabOccupation>();
  let previous = 0;
  for (const entry of record.tabOwners) {
    if (!Array.isArray(entry) || entry.length !== 3 || !positiveId(entry[0]) || entry[0] <= previous ||
        !isTabRefShape(entry[1]) || tabIdFromTabRef(entry[1]) !== entry[0] || !isKeyId(entry[2])) return null;
    tabOwners.set(entry[0], { tabRef: entry[1], ownerKeyId: entry[2] });
    previous = entry[0];
  }
  const windowOwners = new Map<number, string>();
  if (!legacy) {
    if (!Array.isArray(record.windowOwners)) return null;
    previous = 0;
    for (const entry of record.windowOwners) {
      if (!Array.isArray(entry) || entry.length !== 2 || !positiveId(entry[0]) || entry[0] <= previous || !isKeyId(entry[1])) return null;
      windowOwners.set(entry[0], entry[1]);
      previous = entry[0];
    }
  }
  return { globalOwnerKeyId: record.globalOwnerKeyId, tabOwners, windowOwners };
}
async function persistState(state: OccupationState): Promise<void> {
  await chrome.storage.session.set({ [OCCUPATION_STORAGE_KEY]: {
    version: 3, globalOwnerKeyId: state.globalOwnerKeyId,
    tabOwners: [...state.tabOwners].sort(([a], [b]) => a - b).map(([id, value]) => [id, value.tabRef, value.ownerKeyId]),
    windowOwners: [...state.windowOwners].sort(([a], [b]) => a - b),
  } });
}
async function loadState(): Promise<OccupationState> {
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  const stored = (await chrome.storage.session.get(OCCUPATION_STORAGE_KEY))[OCCUPATION_STORAGE_KEY];
  if (stored === undefined) return emptyState();
  const state = parseStoredState(stored) ?? emptyState();
  await persistState(state);
  return state;
}
function currentState(): Promise<OccupationState> {
  if (statePromise === undefined) {
    const attempt = loadState();
    statePromise = attempt;
    void attempt.catch(() => { if (statePromise === attempt) statePromise = undefined; });
  }
  return statePromise;
}
async function publish(state: OccupationState): Promise<void> {
  await persistState(state);
  statePromise = Promise.resolve(state);
}
async function runInControlLane<T>(operation: () => Promise<T>): Promise<T> {
  const previous = controlLaneTail;
  let release!: () => void;
  controlLaneTail = new Promise<void>((resolve) => { release = resolve; });
  await previous.catch(() => undefined);
  try { return await operation(); } finally { release(); }
}
function targetId(target: ControlTarget): string {
  return target.scope === "global" ? "global" : target.scope === "window" ? "window:" + requiredWindowId(target) : "tab:" + requiredTabId(target.tabRef);
}
function ownerFor(state: OccupationState, target: ControlTarget): string | null {
  return target.scope === "global" ? state.globalOwnerKeyId : target.scope === "window" ?
    state.windowOwners.get(requiredWindowId(target)) ?? null : state.tabOwners.get(requiredTabId(target.tabRef))?.ownerKeyId ?? null;
}
function windowConflict(state: OccupationState, windowId: number, keyId: string): ControlConflict | null {
  if (state.globalOwnerKeyId !== null && state.globalOwnerKeyId !== keyId) return { scope: "global", tabRef: null, ownerKeyId: state.globalOwnerKeyId };
  const ownerKeyId = state.windowOwners.get(windowId);
  if (ownerKeyId !== undefined && ownerKeyId !== keyId) return { scope: "window", tabRef: null, windowId, ownerKeyId };
  for (const release of releasing.values()) {
    if (release.target.scope === "global" || release.target.scope === "window" && release.target.windowId === windowId) {
      return { ...release.target, ownerKeyId: release.ownerKeyId };
    }
  }
  return null;
}
async function tabConflict(state: OccupationState, tabRef: string, keyId: string): Promise<ControlConflict | null> {
  const tabId = requiredTabId(tabRef);
  const tab = await chrome.tabs.get(tabId);
  return resolvedTabConflict(state, tabRef, tab.windowId, keyId);
}
function resolvedTabConflict(state: OccupationState, tabRef: string, windowId: number, keyId: string): ControlConflict | null {
  const tabId = requiredTabId(tabRef);
  const conflict = windowConflict(state, windowId, keyId);
  if (conflict !== null) return conflict;
  const occupation = state.tabOwners.get(tabId);
  const release = releasing.get("tab:" + tabId);
  if (release !== undefined) return { ...release.target, ownerKeyId: release.ownerKeyId };
  return occupation !== undefined && occupation.ownerKeyId !== keyId ? { scope: "tab", ...occupation } : null;
}
async function conflictForTarget(state: OccupationState, target: ControlTarget, keyId: string): Promise<ControlConflict | null> {
  if (target.scope === "tab") return tabConflict(state, target.tabRef ?? "", keyId);
  if (target.scope === "window") {
    await chrome.windows.get(requiredWindowId(target));
    const conflict = windowConflict(state, requiredWindowId(target), keyId);
    if (conflict !== null) return conflict;
  } else {
    if (state.globalOwnerKeyId !== null && state.globalOwnerKeyId !== keyId) return { scope: "global", tabRef: null, ownerKeyId: state.globalOwnerKeyId };
    for (const release of releasing.values()) return { ...release.target, ownerKeyId: release.ownerKeyId };
    for (const [windowId, ownerKeyId] of state.windowOwners) {
      if (ownerKeyId !== keyId) return { scope: "window", tabRef: null, windowId, ownerKeyId };
    }
  }
  for (const [tabId, occupation] of state.tabOwners) {
    if (occupation.ownerKeyId === keyId) continue;
    if (target.scope === "window") {
      let tab: ChromeTab;
      try { tab = await chrome.tabs.get(tabId); } catch { continue; }
      if (tab.windowId !== target.windowId) continue;
    }
    return { scope: "tab", ...occupation };
  }
  return null;
}
function withOwner(state: OccupationState, target: ControlTarget, owner: string | null): OccupationState {
  if (target.scope === "global") return { ...state, globalOwnerKeyId: owner };
  if (target.scope === "window") {
    const windowOwners = new Map(state.windowOwners);
    if (owner === null) windowOwners.delete(requiredWindowId(target)); else windowOwners.set(requiredWindowId(target), owner);
    return { ...state, windowOwners };
  }
  const tabOwners = new Map(state.tabOwners);
  if (owner === null) tabOwners.delete(requiredTabId(target.tabRef));
  else tabOwners.set(requiredTabId(target.tabRef), { tabRef: target.tabRef ?? "", ownerKeyId: owner });
  return { ...state, tabOwners };
}
export async function acquireControl(keyId: string, target: ControlTarget, validateTarget?: () => void): Promise<AcquireControlResult> {
  return runInControlLane(async () => {
    validateTarget?.();
    const state = await currentState();
    const conflict = await conflictForTarget(state, target, keyId);
    if (conflict !== null) throw new ControlOccupiedError(conflict);
    const alreadyOwned = ownerFor(state, target) === keyId;
    if (!alreadyOwned) await publish(withOwner(state, target, keyId));
    return { ...target, ownerKeyId: keyId, alreadyOwned };
  });
}
export function registerControlInputCleanup(cleanup: InputCleanup): void { cleanupInput = cleanup; }
export async function releaseControl(target: ControlTarget): Promise<ReleaseControlResult> {
  const started = await runInControlLane(async () => {
    const existing = releasing.get(targetId(target));
    if (existing !== undefined) return { completion: existing.completion };
    const state = await currentState();
    const ownerKeyId = ownerFor(state, target);
    if (ownerKeyId === null) return { completion: Promise.resolve({ ...target, released: false, previousOwnerKeyId: null }) };
    // Keep ownership published while draining, but do not hold the admission lane.
    let resolve!: (result: ReleaseControlResult) => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<ReleaseControlResult>((yes, no) => { resolve = yes; reject = no; });
    releasing.set(targetId(target), { target, ownerKeyId, completion });
    const deliveries = [...inputDeliveries].filter((delivery) => delivery.keyId === ownerKeyId &&
      (target.scope === "global" || target.scope === "window" && delivery.windowId === target.windowId));
    void (async () => {
      try {
        await Promise.allSettled(deliveries.map((delivery) => delivery.completion));
        if (target.scope !== "tab") await cleanupInput(ownerKeyId, target.scope === "window" ? requiredWindowId(target) : null);
        await runInControlLane(async () => { await publish(withOwner(await currentState(), target, null)); });
        resolve({ ...target, released: true, previousOwnerKeyId: ownerKeyId });
      } catch (error) { reject(error); }
      finally { releasing.delete(targetId(target)); }
    })();
    return { completion };
  });
  return started.completion;
}
export async function dispatchWithControlGate<T>(keyId: string, tabRef: string, dispatch: () => Promise<T>): Promise<T> {
  const launched = await runInControlLane(async () => {
    const conflict = await tabConflict(await currentState(), tabRef, keyId);
    if (conflict !== null) throw new ControlOccupiedError(conflict);
    return { completion: dispatch() };
  });
  return launched.completion;
}
export async function assertControlGate(keyId: string, tabRef: string): Promise<void> {
  await runInControlLane(async () => {
    const conflict = await tabConflict(await currentState(), tabRef, keyId);
    if (conflict !== null) throw new ControlOccupiedError(conflict);
  });
}
export async function assertWindowInputControl(keyId: string, tabRef: string): Promise<void> {
  await runInControlLane(async () => {
    const state = await currentState();
    const tab = await chrome.tabs.get(requiredTabId(tabRef));
    const conflict = resolvedTabConflict(state, tabRef, tab.windowId, keyId);
    if (conflict !== null) throw new ControlOccupiedError(conflict);
    if (state.globalOwnerKeyId !== keyId && state.windowOwners.get(tab.windowId) !== keyId) throw new WindowOccupationRequiredError(tab.windowId);
  });
}
export async function dispatchWithInputControlGate<T>(keyId: string, tabRef: string, requireWindow: boolean, dispatch: (windowId: number) => Promise<T>): Promise<T> {
  const launched = await runInControlLane(async () => {
    const state = await currentState();
    const tab = await chrome.tabs.get(requiredTabId(tabRef));
    const conflict = resolvedTabConflict(state, tabRef, tab.windowId, keyId);
    if (conflict !== null) throw new ControlOccupiedError(conflict);
    if (requireWindow && state.globalOwnerKeyId !== keyId && state.windowOwners.get(tab.windowId) !== keyId) throw new WindowOccupationRequiredError(tab.windowId);
    const completion = dispatch(tab.windowId);
    const delivery: InputDelivery = { keyId, windowId: tab.windowId, completion };
    inputDeliveries.add(delivery);
    void completion.then(() => inputDeliveries.delete(delivery), () => inputDeliveries.delete(delivery));
    return { completion };
  });
  return launched.completion;
}
export async function dispatchWithWindowControlGate<T>(keyId: string, windowId: number, dispatch: () => Promise<T>): Promise<T> {
  const launched = await runInControlLane(async () => {
    const conflict = windowConflict(await currentState(), windowId, keyId);
    if (conflict !== null) throw new ControlOccupiedError(conflict);
    return { completion: dispatch() };
  });
  return launched.completion;
}
export async function dispatchWithGlobalControlGate<T>(keyId: string, dispatch: () => Promise<T>): Promise<T> {
  const launched = await runInControlLane(async () => {
    const state = await currentState();
    if (state.globalOwnerKeyId !== null && state.globalOwnerKeyId !== keyId) throw new ControlOccupiedError({ scope: "global", tabRef: null, ownerKeyId: state.globalOwnerKeyId });
    return { completion: dispatch() };
  });
  return launched.completion;
}
export function initializeOccupationService(): void {
  if (lifecycleAttached) return;
  lifecycleAttached = true;
  const forgetTabs = (ids: readonly number[]) => {
    void runInControlLane(async () => {
      const state = await currentState();
      const tabOwners = new Map(state.tabOwners);
      let changed = false;
      for (const id of ids) changed = tabOwners.delete(id) || changed;
      if (changed) await publish({ ...state, tabOwners });
    }).catch(() => undefined);
  };
  chrome.tabs.onRemoved.addListener((id) => forgetTabs([id]));
  chrome.tabs.onReplaced.addListener((added, removed) => forgetTabs([added, removed]));
  chrome.windows.onRemoved.addListener((windowId) => {
    void releaseControl({ scope: "window", windowId, tabRef: null }).catch(() => undefined);
  });
}
