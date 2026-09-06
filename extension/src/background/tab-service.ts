import { COMMAND_CATALOG } from "../generated/command-config.js";
import { CapabilityUnavailableError } from "./capability-error.js";

const RUNTIME_EPOCH_STORAGE_KEY = "browser-key-automation.runtime-epoch.v1";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const TAB_REF_PATTERN = /^tr1\.([A-Za-z0-9_-]{22})\.([1-9][0-9]{0,15})\.([A-Za-z0-9_-]{22})$/u;
const TOKEN_GENERATION_ATTEMPTS = 8;

export interface TabsListParams {
  readonly afterTabId: number | null;
  readonly limit: number;
}

export interface TabSummary {
  readonly tabRef: string;
  readonly windowId: number;
  readonly index: number;
  readonly active: boolean;
  readonly highlighted: boolean;
  readonly pinned: boolean;
  readonly incognito: boolean;
  readonly status: "loading" | "complete" | "unloaded" | null;
  readonly title: string | null;
  readonly titleTruncated: boolean;
  readonly url: string | null;
  readonly urlTruncated: boolean;
}

export interface TabDetail extends TabSummary {
  readonly audible: boolean;
  readonly discarded: boolean;
  readonly autoDiscardable: boolean;
  readonly muted: boolean;
}

export interface ResolvedTabTarget {
  readonly tabId: number;
  readonly tabRef: string;
  readonly generation: string;
  readonly url: string | null;
}

export interface TabsListResult {
  readonly items: readonly TabSummary[];
  readonly nextAfterTabId: number | null;
}

export interface TabsCreateParams {
  readonly url: string;
  readonly active: boolean;
  readonly windowId?: number;
}

export class TabServiceError extends Error {
  readonly code = "TAB_REF_STALE" as const;

  constructor() {
    super("TabRef no longer identifies a live tab in this extension runtime");
    this.name = "TabServiceError";
  }
}

const encoder = new TextEncoder();
const generationsByTabId = new Map<number, string>();
let runtimeEpochPromise: Promise<string> | undefined;
let lifecycleAttached = false;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  let index = 0;
  while (index < bytes.length) {
    binary += String.fromCharCode(bytes[index] ?? 0);
    index += 1;
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function uniqueGenerationToken(): string {
  let attempt = 0;
  while (attempt < TOKEN_GENERATION_ATTEMPTS) {
    const candidate = randomToken();
    let collision = false;
    for (const current of generationsByTabId.values()) {
      if (current === candidate) {
        collision = true;
        break;
      }
    }
    if (!collision) return candidate;
    attempt += 1;
  }
  throw new Error("Unable to allocate a unique TabRef generation within the bounded attempt limit");
}

async function loadOrCreateRuntimeEpoch(): Promise<string> {
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  const stored = await chrome.storage.session.get(RUNTIME_EPOCH_STORAGE_KEY);
  const current = stored[RUNTIME_EPOCH_STORAGE_KEY];
  if (typeof current === "string" && TOKEN_PATTERN.test(current)) return current;

  const generated = randomToken();
  await chrome.storage.session.set({ [RUNTIME_EPOCH_STORAGE_KEY]: generated });
  const confirmed = await chrome.storage.session.get(RUNTIME_EPOCH_STORAGE_KEY);
  if (confirmed[RUNTIME_EPOCH_STORAGE_KEY] !== generated) {
    throw new Error("Runtime epoch storage round-trip failed");
  }
  return generated;
}

function getRuntimeEpoch(): Promise<string> {
  runtimeEpochPromise ??= loadOrCreateRuntimeEpoch();
  return runtimeEpochPromise;
}

function generationForTab(tabId: number): string {
  const current = generationsByTabId.get(tabId);
  if (current !== undefined) return current;
  const generated = uniqueGenerationToken();
  generationsByTabId.set(tabId, generated);
  return generated;
}

function makeTabRef(runtimeEpoch: string, tabId: number, generation: string): string {
  return `tr1.${runtimeEpoch}.${tabId}.${generation}`;
}

function boundedText(value: string | undefined): { value: string | null; truncated: boolean } {
  if (value === undefined) return { value: null, truncated: false };
  const maximumBytes = COMMAND_CATALOG.limits["command.tabs.maximum_text_bytes"];
  const characters: string[] = [];
  let usedBytes = 0;
  for (const character of value) {
    const bytes = encoder.encode(character).byteLength;
    if (usedBytes + bytes > maximumBytes) {
      return { value: characters.join(""), truncated: true };
    }
    characters.push(character);
    usedBytes += bytes;
  }
  return { value, truncated: false };
}

function normalizeStatus(status: ChromeTab["status"]): TabSummary["status"] {
  return status === "loading" || status === "complete" || status === "unloaded" ? status : null;
}

function summarizeTab(tab: ChromeTab, runtimeEpoch: string, generation: string): TabSummary {
  if (tab.id === undefined) throw new Error("Chromium returned a tab without an id");
  const title = boundedText(tab.title);
  const url = boundedText(tab.url ?? tab.pendingUrl);
  return {
    tabRef: makeTabRef(runtimeEpoch, tab.id, generation),
    windowId: tab.windowId,
    index: tab.index,
    active: tab.active,
    highlighted: tab.highlighted,
    pinned: tab.pinned,
    incognito: tab.incognito,
    status: normalizeStatus(tab.status),
    title: title.value,
    titleTruncated: title.truncated,
    url: url.value,
    urlTruncated: url.truncated,
  };
}

function detailTab(tab: ChromeTab, runtimeEpoch: string, generation: string): TabDetail {
  return {
    ...summarizeTab(tab, runtimeEpoch, generation),
    audible: tab.audible === true,
    discarded: tab.discarded === true,
    autoDiscardable: tab.autoDiscardable !== false,
    muted: tab.mutedInfo?.muted === true,
  };
}

function parseTabRef(tabRef: string): { runtimeEpoch: string; tabId: number; generation: string } | null {
  const match = TAB_REF_PATTERN.exec(tabRef);
  if (match === null) return null;
  const tabId = Number(match[2]);
  if (!Number.isSafeInteger(tabId) || tabId <= 0) return null;
  return { runtimeEpoch: match[1] ?? "", tabId, generation: match[3] ?? "" };
}

export function isTabRefShape(value: unknown): value is string {
  return typeof value === "string" && parseTabRef(value) !== null;
}

export function tabIdFromTabRef(tabRef: string): number | null {
  return parseTabRef(tabRef)?.tabId ?? null;
}

interface TabSnapshotEntry {
  readonly tab: ChromeTab & { readonly id: number };
  readonly generation: string;
}

export function initializeTabService(): void {
  if (lifecycleAttached) return;
  lifecycleAttached = true;
  chrome.tabs.onRemoved.addListener((tabId) => {
    generationsByTabId.delete(tabId);
  });
  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    generationsByTabId.delete(removedTabId);
    generationsByTabId.delete(addedTabId);
  });
}

export async function listTabs(params: TabsListParams): Promise<TabsListResult> {
  const runtimeEpoch = await getRuntimeEpoch();
  const queried = await chrome.tabs.query({});
  const snapshot: TabSnapshotEntry[] = queried
    .filter(
      (tab): tab is ChromeTab & { readonly id: number } =>
        typeof tab.id === "number" && Number.isSafeInteger(tab.id) && tab.id > 0,
    )
    .sort((left, right) => left.id - right.id)
    .map((tab) => ({ tab, generation: generationForTab(tab.id) }));
  const items: TabSummary[] = [];
  let lastIncludedTabId: number | null = null;
  let hasMore = false;

  for (const entry of snapshot) {
    const tab = entry.tab;
    if (params.afterTabId !== null && tab.id <= params.afterTabId) continue;
    if (items.length >= params.limit) {
      hasMore = true;
      break;
    }
    const summary = summarizeTab(tab, runtimeEpoch, entry.generation);
    const candidateBytes = encoder.encode(
      JSON.stringify({
        items: [...items, summary],
        nextAfterTabId: tab.id,
      }),
    ).byteLength;
    if (candidateBytes > COMMAND_CATALOG.limits["command.inline.maximum_result_json_bytes"]) {
      hasMore = true;
      break;
    }
    items.push(summary);
    lastIncludedTabId = tab.id;
  }

  if (hasMore && lastIncludedTabId === null) {
    throw new Error("A bounded tab summary did not fit the inline result budget");
  }
  return {
    items,
    nextAfterTabId: hasMore ? lastIncludedTabId : null,
  };
}

export async function resolveTab(
  tabRef: string,
): Promise<{ readonly tab: ChromeTab; readonly target: ResolvedTabTarget }> {
  const parsed = parseTabRef(tabRef);
  const runtimeEpoch = await getRuntimeEpoch();
  if (
    parsed === null ||
    parsed.runtimeEpoch !== runtimeEpoch ||
    generationsByTabId.get(parsed.tabId) !== parsed.generation
  ) {
    throw new TabServiceError();
  }

  let tab: ChromeTab;
  try {
    tab = await chrome.tabs.get(parsed.tabId);
  } catch {
    if (generationsByTabId.get(parsed.tabId) === parsed.generation) {
      generationsByTabId.delete(parsed.tabId);
    }
    throw new TabServiceError();
  }
  if (
    tab.id !== parsed.tabId ||
    generationsByTabId.get(parsed.tabId) !== parsed.generation
  ) {
    throw new TabServiceError();
  }
  return {
    tab,
    target: {
      tabId: parsed.tabId,
      tabRef,
      generation: parsed.generation,
      url: tab.url ?? tab.pendingUrl ?? null,
    },
  };
}

export function assertResolvedTabTarget(target: ResolvedTabTarget): void {
  if (generationsByTabId.get(target.tabId) !== target.generation) {
    throw new TabServiceError();
  }
}

export async function resolveTabTarget(tabRef: string): Promise<ResolvedTabTarget> {
  return (await resolveTab(tabRef)).target;
}

// Internal routing only. A document-bound caller must still address and verify
// the exact Chromium documentId; a tab id alone does not revive any old ref.
export async function resolveCurrentTabTarget(tabId: number): Promise<ResolvedTabTarget> {
  if (!Number.isSafeInteger(tabId) || tabId <= 0) throw new TabServiceError();
  const runtimeEpoch = await getRuntimeEpoch();
  return resolveTabTarget(makeTabRef(runtimeEpoch, tabId, generationForTab(tabId)));
}

export async function getTab(tabRef: string): Promise<TabDetail> {
  const resolved = await resolveTab(tabRef);
  return detailTab(resolved.tab, (await getRuntimeEpoch()), resolved.target.generation);
}

async function detailReturnedTab(tab: ChromeTab): Promise<TabDetail> {
  if (tab.id === undefined || !Number.isSafeInteger(tab.id) || tab.id <= 0) {
    throw new CapabilityUnavailableError(
      "platform.extension.tabs",
      "UNEXPECTED_PLATFORM_RESULT",
      "Chromium returned a tab without a usable id",
    );
  }
  const generation = generationForTab(tab.id);
  return detailTab(tab, await getRuntimeEpoch(), generation);
}

export async function createTab(params: TabsCreateParams): Promise<{ readonly tab: TabDetail }> {
  let tab: ChromeTab;
  try {
    tab = await chrome.tabs.create({ url: params.url, active: params.active,
      ...(params.windowId === undefined ? {} : { windowId: params.windowId }) });
  } catch {
    throw new CapabilityUnavailableError(
      "platform.extension.tabs",
      "CHROMIUM_API_FAILED",
      "Chromium could not create the requested tab",
    );
  }
  return { tab: await detailReturnedTab(tab) };
}

export async function updateResolvedTab(
  target: ResolvedTabTarget,
  properties: { readonly url?: string; readonly active?: boolean },
): Promise<{ readonly tab: TabDetail }> {
  assertResolvedTabTarget(target);
  let tab: ChromeTab;
  try {
    tab = await chrome.tabs.update(target.tabId, properties);
  } catch {
    assertResolvedTabTarget(target);
    throw new CapabilityUnavailableError(
      "platform.extension.tabs",
      "CHROMIUM_API_FAILED",
      "Chromium could not update the requested tab",
    );
  }
  assertResolvedTabTarget(target);
  return { tab: await detailReturnedTab(tab) };
}

export async function navigateTab(tabRef: string, url: string): Promise<{ readonly tab: TabDetail }> {
  return updateResolvedTab(await resolveTabTarget(tabRef), { url });
}

export async function activateTab(tabRef: string): Promise<{ readonly tab: TabDetail }> {
  return updateResolvedTab(await resolveTabTarget(tabRef), { active: true });
}

export async function reloadTab(
  tabRef: string,
  bypassCache: boolean,
): Promise<{ readonly tabRef: string; readonly reloaded: true }> {
  const target = await resolveTabTarget(tabRef);
  assertResolvedTabTarget(target);
  try {
    await chrome.tabs.reload(target.tabId, { bypassCache });
  } catch {
    assertResolvedTabTarget(target);
    throw new CapabilityUnavailableError(
      "platform.extension.tabs",
      "CHROMIUM_API_FAILED",
      "Chromium could not reload the requested tab",
    );
  }
  assertResolvedTabTarget(target);
  return { tabRef, reloaded: true };
}

export async function closeTab(tabRef: string): Promise<{ readonly tabRef: string; readonly closed: true }> {
  const target = await resolveTabTarget(tabRef);
  assertResolvedTabTarget(target);
  try {
    await chrome.tabs.remove(target.tabId);
  } catch {
    assertResolvedTabTarget(target);
    throw new CapabilityUnavailableError(
      "platform.extension.tabs",
      "CHROMIUM_API_FAILED",
      "Chromium could not close the requested tab",
    );
  }
  generationsByTabId.delete(target.tabId);
  return { tabRef, closed: true };
}
