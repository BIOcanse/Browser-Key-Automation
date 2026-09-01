import { isTabRefShape, tabIdFromTabRef } from "./tab-service.js";

const OCCUPATION_STORAGE_KEY = "browser-key-automation.occupations.v1";
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;

export type ControlScope = "global" | "tab";

export interface ControlTarget {
  readonly scope: ControlScope;
  readonly tabRef: string | null;
}

export interface ControlConflict {
  readonly scope: ControlScope;
  readonly tabRef: string | null;
  readonly ownerKeyId: string;
}

export interface AcquireControlResult extends ControlTarget {
  readonly ownerKeyId: string;
  readonly alreadyOwned: boolean;
}

export interface ReleaseControlResult extends ControlTarget {
  readonly released: boolean;
  readonly previousOwnerKeyId: string | null;
}

interface OccupationState {
  readonly globalOwnerKeyId: string | null;
  readonly tabOwners: ReadonlyMap<number, TabOccupation>;
}

interface TabOccupation {
  readonly tabRef: string;
  readonly ownerKeyId: string;
}

interface StoredOccupationState {
  readonly version: 2;
  readonly globalOwnerKeyId: string | null;
  readonly tabOwners: readonly (readonly [number, string, string])[];
}

export class ControlOccupiedError extends Error {
  readonly code = "CONTROL_OCCUPIED" as const;
  readonly details: ControlConflict;

  constructor(details: ControlConflict) {
    super("The requested control scope is occupied by another Key");
    this.name = "ControlOccupiedError";
    this.details = details;
  }
}

let statePromise: Promise<OccupationState> | undefined;
let controlLaneTail: Promise<void> = Promise.resolve();
let lifecycleAttached = false;

function emptyState(): OccupationState {
  return { globalOwnerKeyId: null, tabOwners: new Map<number, TabOccupation>() };
}

function isKeyId(value: unknown): value is string {
  return typeof value === "string" && KEY_ID_PATTERN.test(value);
}

function parseStoredState(value: unknown): OccupationState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== "globalOwnerKeyId" || keys[1] !== "tabOwners" || keys[2] !== "version") {
    return null;
  }
  if (record.version !== 2) return null;
  if (!(record.globalOwnerKeyId === null || isKeyId(record.globalOwnerKeyId))) return null;
  if (!Array.isArray(record.tabOwners)) return null;

  const tabOwners = new Map<number, TabOccupation>();
  let previousTabId = 0;
  let index = 0;
  while (index < record.tabOwners.length) {
    const entry = record.tabOwners[index];
    if (
      !Array.isArray(entry) ||
      entry.length !== 3 ||
      typeof entry[0] !== "number" ||
      !Number.isSafeInteger(entry[0]) ||
      entry[0] <= previousTabId ||
      !isTabRefShape(entry[1]) ||
      tabIdFromTabRef(entry[1]) !== entry[0] ||
      !isKeyId(entry[2])
    ) {
      return null;
    }
    tabOwners.set(entry[0], { tabRef: entry[1], ownerKeyId: entry[2] });
    previousTabId = entry[0];
    index += 1;
  }
  return {
    globalOwnerKeyId: record.globalOwnerKeyId,
    tabOwners,
  };
}

function storedState(state: OccupationState): StoredOccupationState {
  const tabOwners = [...state.tabOwners.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([tabId, occupation]) => [tabId, occupation.tabRef, occupation.ownerKeyId] as const);
  return {
    version: 2,
    globalOwnerKeyId: state.globalOwnerKeyId,
    tabOwners,
  };
}

async function persistState(state: OccupationState): Promise<void> {
  await chrome.storage.session.set({ [OCCUPATION_STORAGE_KEY]: storedState(state) });
}

async function loadState(): Promise<OccupationState> {
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  const stored = await chrome.storage.session.get(OCCUPATION_STORAGE_KEY);
  const value = stored[OCCUPATION_STORAGE_KEY];
  if (value === undefined) return emptyState();
  const parsed = parseStoredState(value);
  if (parsed !== null) return parsed;

  const reset = emptyState();
  await persistState(reset);
  return reset;
}

function currentState(): Promise<OccupationState> {
  if (statePromise === undefined) {
    const attempt = loadState();
    statePromise = attempt;
    void attempt.catch(() => {
      if (statePromise === attempt) statePromise = undefined;
    });
  }
  return statePromise;
}

async function runInControlLane<T>(operation: () => Promise<T>): Promise<T> {
  const previous = controlLaneTail;
  let release!: () => void;
  controlLaneTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
}

function requiredTabId(tabRef: string): number {
  const tabId = tabIdFromTabRef(tabRef);
  if (tabId === null) throw new Error("Invalid TabRef reached the occupation service");
  return tabId;
}

function tabConflict(state: OccupationState, tabRef: string, keyId: string): ControlConflict | null {
  if (state.globalOwnerKeyId !== null && state.globalOwnerKeyId !== keyId) {
    return { scope: "global", tabRef: null, ownerKeyId: state.globalOwnerKeyId };
  }
  const tabOccupation = state.tabOwners.get(requiredTabId(tabRef));
  return tabOccupation !== undefined && tabOccupation.ownerKeyId !== keyId
    ? { scope: "tab", tabRef: tabOccupation.tabRef, ownerKeyId: tabOccupation.ownerKeyId }
    : null;
}

function globalConflict(state: OccupationState, keyId: string): ControlConflict | null {
  if (state.globalOwnerKeyId !== null && state.globalOwnerKeyId !== keyId) {
    return { scope: "global", tabRef: null, ownerKeyId: state.globalOwnerKeyId };
  }
  const tabOwners = [...state.tabOwners.entries()].sort((left, right) => left[0] - right[0]);
  for (const [, occupation] of tabOwners) {
    if (occupation.ownerKeyId !== keyId) {
      return { scope: "tab", tabRef: occupation.tabRef, ownerKeyId: occupation.ownerKeyId };
    }
  }
  return null;
}

function conflictForTarget(state: OccupationState, target: ControlTarget, keyId: string): ControlConflict | null {
  if (target.scope === "global") return globalConflict(state, keyId);
  return tabConflict(state, target.tabRef ?? "", keyId);
}

export async function acquireControl(
  keyId: string,
  target: ControlTarget,
  validateTarget?: () => void,
): Promise<AcquireControlResult> {
  return runInControlLane(async () => {
    validateTarget?.();
    const state = await currentState();
    const conflict = conflictForTarget(state, target, keyId);
    if (conflict !== null) throw new ControlOccupiedError(conflict);

    if (target.scope === "global") {
      const alreadyOwned = state.globalOwnerKeyId === keyId;
      if (!alreadyOwned) {
        const next = { globalOwnerKeyId: keyId, tabOwners: state.tabOwners };
        await persistState(next);
        statePromise = Promise.resolve(next);
      }
      return { ...target, ownerKeyId: keyId, alreadyOwned };
    }

    const tabRef = target.tabRef ?? "";
    const tabId = requiredTabId(tabRef);
    const current = state.tabOwners.get(tabId);
    const alreadyOwned = current?.ownerKeyId === keyId;
    if (!alreadyOwned) {
      const tabOwners = new Map(state.tabOwners);
      tabOwners.set(tabId, { tabRef, ownerKeyId: keyId });
      const next = { globalOwnerKeyId: state.globalOwnerKeyId, tabOwners };
      await persistState(next);
      statePromise = Promise.resolve(next);
    }
    return { ...target, ownerKeyId: keyId, alreadyOwned };
  });
}

export async function releaseControl(target: ControlTarget): Promise<ReleaseControlResult> {
  return runInControlLane(async () => {
    const state = await currentState();
    if (target.scope === "global") {
      const previousOwnerKeyId = state.globalOwnerKeyId;
      if (previousOwnerKeyId !== null) {
        const next = { globalOwnerKeyId: null, tabOwners: state.tabOwners };
        await persistState(next);
        statePromise = Promise.resolve(next);
      }
      return { ...target, released: previousOwnerKeyId !== null, previousOwnerKeyId };
    }

    const tabRef = target.tabRef ?? "";
    const tabId = requiredTabId(tabRef);
    const previousOwnerKeyId = state.tabOwners.get(tabId)?.ownerKeyId ?? null;
    if (previousOwnerKeyId !== null) {
      const tabOwners = new Map(state.tabOwners);
      tabOwners.delete(tabId);
      const next = { globalOwnerKeyId: state.globalOwnerKeyId, tabOwners };
      await persistState(next);
      statePromise = Promise.resolve(next);
    }
    return { ...target, released: previousOwnerKeyId !== null, previousOwnerKeyId };
  });
}

async function forgetTabOccupations(tabIds: readonly number[]): Promise<void> {
  await runInControlLane(async () => {
    const state = await currentState();
    const tabOwners = new Map(state.tabOwners);
    let changed = false;
    for (const tabId of tabIds) changed = tabOwners.delete(tabId) || changed;
    if (!changed) return;
    const next = { globalOwnerKeyId: state.globalOwnerKeyId, tabOwners };
    await persistState(next);
    statePromise = Promise.resolve(next);
  });
}

export function initializeOccupationService(): void {
  if (lifecycleAttached) return;
  lifecycleAttached = true;
  chrome.tabs.onRemoved.addListener((tabId) => {
    void forgetTabOccupations([tabId]).catch(() => undefined);
  });
  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    void forgetTabOccupations([addedTabId, removedTabId]).catch(() => undefined);
  });
}

export async function dispatchWithControlGate<T>(
  keyId: string,
  tabRef: string,
  dispatch: () => Promise<T>,
): Promise<T> {
  const launched = await runInControlLane(async () => {
    const state = await currentState();
    const conflict = tabConflict(state, tabRef, keyId);
    if (conflict !== null) throw new ControlOccupiedError(conflict);
    return { completion: dispatch() };
  });
  return launched.completion;
}

export async function assertControlGate(keyId: string, tabRef: string): Promise<void> {
  await runInControlLane(async () => {
    const state = await currentState();
    const conflict = tabConflict(state, tabRef, keyId);
    if (conflict !== null) throw new ControlOccupiedError(conflict);
  });
}

export async function dispatchWithGlobalControlGate<T>(
  keyId: string,
  dispatch: () => Promise<T>,
): Promise<T> {
  const launched = await runInControlLane(async () => {
    const state = await currentState();
    if (state.globalOwnerKeyId !== null && state.globalOwnerKeyId !== keyId) {
      throw new ControlOccupiedError({ scope: "global", tabRef: null, ownerKeyId: state.globalOwnerKeyId });
    }
    return { completion: dispatch() };
  });
  return launched.completion;
}
