import { COMMAND_CATALOG } from "../generated/command-config.js";
import { assertScriptingTargetAvailable } from "./browser-service.js";
import { CapabilityUnavailableError } from "./capability-error.js";
import { DomServiceError } from "./dom-service.js";
import { assertResolvedTabTarget, resolveTab } from "./tab-service.js";

export type PageWaitUntil = "committed" | "domcontentloaded" | "complete" | "url" |
  "present" | "absent" | "visible" | "enabled" | "text";
type PageReadyState = "loading" | "interactive" | "complete";

export interface PageWaitRequest {
  readonly tabRef: string;
  readonly until: PageWaitUntil;
  readonly timeoutMs: number;
  readonly url?: string;
  readonly selector?: string;
  readonly text?: string;
}

export interface PageWaitObservation {
  readonly documentId: string | null;
  readonly url: string | null;
  readonly urlTruncated: boolean;
  readonly navigationPending: boolean;
  readonly readyState: PageReadyState | null;
  readonly domContentLoaded: boolean;
  readonly conditionSatisfied: boolean;
}

export interface PageWaitResult {
  readonly tabRef: string;
  readonly until: PageWaitUntil;
  readonly status: "already_satisfied" | "satisfied" | "timed_out";
  readonly elapsedMs: number;
  readonly timeoutMs: number;
  readonly message: string;
  readonly observation: PageWaitObservation | null;
}

// A single current-document probe. No page listener, global navigation cache,
// persistent watcher, action retry, or untrusted MAIN-world code is installed.
function inspectWaitCondition(until: PageWaitUntil, selector: string | null, text: string | null) {
  type ElementLike = {
    readonly textContent: string | null;
    matches(selector: string): boolean;
    getAttribute(name: string): string | null;
    getClientRects(): { readonly length: number };
  };
  const page = globalThis as unknown as {
    readonly document: { readonly readyState: PageReadyState; querySelector(selector: string): ElementLike | null };
    readonly performance: { getEntriesByType(type: string): readonly { readonly domContentLoadedEventStart: number }[] };
    getComputedStyle(element: ElementLike): { readonly visibility: string; readonly display: string };
  };
  const navigation = page.performance.getEntriesByType("navigation")[0];
  const domContentLoaded = page.document.readyState === "complete" || (navigation?.domContentLoadedEventStart ?? 0) > 0;
  let conditionSatisfied = false;
  if (selector !== null) {
    let element: ElementLike | null;
    try { element = page.document.querySelector(selector); }
    catch { return { invalidSelector: true, readyState: page.document.readyState, domContentLoaded, conditionSatisfied: false }; }
    if (until === "present") conditionSatisfied = element !== null;
    else if (until === "absent") conditionSatisfied = element === null;
    else if (until === "enabled") conditionSatisfied = element !== null && !element.matches(":disabled") &&
      element.getAttribute("aria-disabled") !== "true";
    else if (until === "visible" && element !== null) {
      const style = page.getComputedStyle(element);
      conditionSatisfied = element.getClientRects().length > 0 && style.visibility !== "hidden" &&
        style.visibility !== "collapse" && style.display !== "none";
    } else if (until === "text") conditionSatisfied = element !== null && text !== null &&
      (element.textContent ?? "").includes(text);
  }
  return { invalidSelector: false, readyState: page.document.readyState, domContentLoaded, conditionSatisfied };
}

async function mainFrame(tabId: number): Promise<ChromeWebNavigationFrame | undefined> {
  try { return (await chrome.webNavigation.getAllFrames({ tabId }))?.find((frame) => frame.frameId === 0); }
  catch {
    throw new CapabilityUnavailableError("platform.extension.web_navigation", "CHROMIUM_API_FAILED", "Could not read main-document metadata");
  }
}

async function observe(request: PageWaitRequest, ended: () => boolean): Promise<PageWaitObservation | null> {
  const { tab, target } = await resolveTab(request.tabRef);
  if (ended()) return null;
  const frame = await mainFrame(target.tabId);
  assertResolvedTabTarget(target);
  if (ended()) return null;
  const documentId = frame?.documentId ?? null;
  const needsDom = request.until !== "committed" && request.until !== "url";
  let probe: ReturnType<typeof inspectWaitCondition> | undefined;
  if (documentId !== null && needsDom) {
    await assertScriptingTargetAvailable(target);
    if (ended()) return null;
    try {
      const entries = await chrome.scripting.executeScript({
        target: { tabId: target.tabId, documentIds: [documentId] }, world: "ISOLATED", injectImmediately: true,
        func: inspectWaitCondition, args: [request.until, request.selector ?? null, request.text ?? null],
      });
      assertResolvedTabTarget(target);
      if (ended()) return null;
      if (entries.length === 1 && entries[0]?.documentId === documentId && entries[0].frameId === 0) {
        probe = entries[0].result;
      }
    } catch {
      const current = await resolveTab(request.tabRef);
      if (ended()) return null;
      const currentFrame = await mainFrame(current.target.tabId);
      assertResolvedTabTarget(target);
      // A genuine navigation can retire the exact document between calls.
      if (currentFrame?.documentId !== documentId) return null;
      throw new CapabilityUnavailableError("platform.extension.scripting", "CHROMIUM_API_FAILED", "Could not inspect the wait target");
    }
    if (probe === undefined) throw new DomServiceError("DOM_OPERATION_FAILED", "Invalid page.wait probe result");
    if (probe.invalidSelector) throw new DomServiceError("DOM_OPERATION_FAILED", "Invalid page.wait selector");
  }
  if (ended()) return null;
  const current = await resolveTab(request.tabRef);
  if (ended()) return null;
  const currentFrame = await mainFrame(target.tabId);
  assertResolvedTabTarget(target);
  // Never combine A's DOM with B's URL/readiness, including same-URL reloads.
  if (ended() || currentFrame?.documentId !== frame?.documentId || current.tab.url !== tab.url) return null;
  const pending = typeof current.tab.pendingUrl === "string" ||
    (current.tab.status === "loading" && probe?.readyState === "complete");
  const url = current.tab.url ?? null;
  const maximumUrlBytes = COMMAND_CATALOG.limits["command.tabs.maximum_text_bytes"];
  let boundedUrl = "";
  let urlBytes = 0;
  const encoder = new TextEncoder();
  for (const character of url ?? "") {
    const bytes = encoder.encode(character).byteLength;
    if (urlBytes + bytes > maximumUrlBytes) break;
    boundedUrl += character; urlBytes += bytes;
  }
  const activeDocument = documentId !== null && frame?.errorOccurred !== true &&
    (frame?.documentLifecycle === undefined || frame.documentLifecycle === "active");
  let conditionSatisfied = false;
  if (activeDocument && !pending && (request.url === undefined || url === request.url)) {
    if (request.until === "committed" || request.until === "url") conditionSatisfied = true;
    else if (request.until === "domcontentloaded") conditionSatisfied = probe?.domContentLoaded === true;
    else if (request.until === "complete") conditionSatisfied = current.tab.status === "complete" && probe?.readyState === "complete";
    else conditionSatisfied = probe?.conditionSatisfied === true;
  }
  return {
    documentId, url: url === null ? null : boundedUrl,
    urlTruncated: url !== null && boundedUrl.length !== url.length,
    navigationPending: pending, readyState: probe?.readyState ?? null,
    domContentLoaded: probe?.domContentLoaded ?? false, conditionSatisfied,
  };
}

export async function waitForPage(request: PageWaitRequest): Promise<PageWaitResult> {
  const started = performance.now();
  const expired = Symbol("wait-deadline");
  let ended = false;
  let first = true;
  let observation: PageWaitObservation | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof expired>((resolve) => {
    timeout = setTimeout(() => { ended = true; resolve(expired); }, request.timeoutMs);
  });
  const finish = (status: PageWaitResult["status"]): PageWaitResult => ({
    tabRef: request.tabRef, until: request.until, timeoutMs: request.timeoutMs, status,
    elapsedMs: Math.max(0, Math.round(performance.now() - started)), observation,
    message: status === "already_satisfied" ? `Already satisfied: ${request.until}; no waiting or page action was needed.` :
      status === "satisfied" ? `Observed: ${request.until}. No page action was performed.` :
      `Not observed within ${request.timeoutMs} ms: ${request.until}. This does not imply the previous action failed.`,
  });
  try {
    while (!ended) {
      const value = await Promise.race([observe(request, () => ended), deadline]);
      if (value === expired) return finish("timed_out");
      if (value !== null) observation = value;
      if (value?.conditionSatisfied) return finish(first ? "already_satisfied" : "satisfied");
      first = false;
      const pause = new Promise<void>((resolve) => { poll = setTimeout(resolve, COMMAND_CATALOG.limits["command.page.wait.poll_interval_ms"]); });
      if (await Promise.race([pause, deadline]) === expired) return finish("timed_out");
    }
    return finish("timed_out");
  } finally {
    ended = true;
    clearTimeout(timeout);
    clearTimeout(poll);
  }
}
