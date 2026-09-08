import { assertScriptingTargetAvailable } from "../browser-service.js";
import { BrowserOperationError, featureLimit, waitForFeatureReceipt } from "../browser-feature-model.js";
import type { DebuggerDispatch } from "../debugger-service.js";
import { registerDocumentRef } from "../dom-service.js";
import { assertResolvedTabTarget, resolveTabTarget } from "../tab-service.js";

export const searchLimit = (name: string): number => featureLimit(`command.search.${name}`);
const encoder = new TextEncoder();
export interface SearchScope { readonly tabRefs: readonly string[]; readonly includeFrames: boolean; }
interface DocumentText {
  readonly text: string; readonly textBytes: number; readonly textTruncated: boolean;
  readonly url: string; readonly urlTruncated: boolean; readonly title: string; readonly titleTruncated: boolean;
  readonly capturedAt: number; readonly hasBody: boolean;
}
export interface SearchSource extends DocumentText {
  readonly tabRef: string; readonly documentRef: string; readonly documentId: string; readonly frameId: number;
  readonly parentFrameId: number; readonly sha256: string; readonly hashScope: "captured_text";
}
interface Failure { readonly tabRef: string; readonly frameId: number | null; readonly reason: string; }
type Observation<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

/** Self-contained isolated-world reader. body.innerText is the explicitly advertised source. */
export function readDocumentSearchText(maximumTextBytes: number, maximumMetadataBytes: number): DocumentText {
  const page = globalThis as unknown as {readonly document: {readonly title: string; readonly body: {readonly innerText: string} | null}; readonly location: {readonly href: string}};
  const bytes = new TextEncoder();
  const bound = (value: string, maximum: number) => {
    let used = 0, end = 0;
    for (const character of value) {
      const count = bytes.encode(character).byteLength;
      if (used + count > maximum) return { value: value.slice(0, end), bytes: used, truncated: true };
      used += count; end += character.length;
    }
    return { value, bytes: used, truncated: false };
  };
  const body = page.document.body, text = bound(body?.innerText ?? "", maximumTextBytes);
  const url = bound(page.location.href, maximumMetadataBytes), title = bound(page.document.title, maximumMetadataBytes);
  return { text: text.value, textBytes: text.bytes, textTruncated: text.truncated, url: url.value, urlTruncated: url.truncated,
    title: title.value, titleTruncated: title.truncated, capturedAt: Date.now(), hasBody: body !== null };
}

export async function readSearchSources(scope: SearchScope, dispatch: DebuggerDispatch) {
  const startedAt = Date.now(), deadline = performance.now() + searchLimit("maximum_duration_ms");
  const sources: SearchSource[] = [], failures: Failure[] = [];
  let textBytes = 0, enumeratedDocuments = 0, omittedFrames = 0;
  const observe = async <T>(operation: () => Promise<T>, reason: string): Promise<Observation<T>> => dispatch(async () => {
    // Authorization failure belongs to dispatch and escapes the partial-source result.
    try {
      if (performance.now() >= deadline) return { ok: false, reason: "SEARCH_DEADLINE" };
      const value = await waitForFeatureReceipt(operation(), Math.max(0, deadline - performance.now()), "SEARCH_DEADLINE");
      if (performance.now() >= deadline) return { ok: false, reason: "SEARCH_DEADLINE" };
      return { ok: true, value };
    } catch (error) {
      return { ok: false, reason: error instanceof BrowserOperationError && error.details.reason === "SEARCH_DEADLINE" ? "SEARCH_DEADLINE" : reason };
    }
  });
  for (const tabRef of scope.tabRefs) {
    const fail = (frameId: number | null, reason: string): void => { failures.push({ tabRef, frameId, reason }); };
    const resolved = await observe(() => resolveTabTarget(tabRef), "TAB_UNAVAILABLE");
    if (!resolved.ok) { fail(null, resolved.reason); continue; }
    const target = resolved.value;
    const available = await observe(() => assertScriptingTargetAvailable(target), "PAGE_ACCESS_UNAVAILABLE");
    if (!available.ok) { fail(null, available.reason); continue; }
    const listed = await observe(() => chrome.webNavigation.getAllFrames({ tabId: target.tabId }), "FRAMES_UNAVAILABLE");
    if (!listed.ok) { fail(null, listed.reason); continue; }
    const selected = listed.value.filter(frame => scope.includeFrames || frame.frameId === 0).sort((a, b) => a.frameId - b.frameId);
    enumeratedDocuments += selected.length;
    if (selected.length === 0) { fail(null, "NO_DOCUMENT"); continue; }
    const frames = selected.slice(0, searchLimit("maximum_frames_per_tab"));
    if (selected.length > frames.length) { omittedFrames += selected.length - frames.length; fail(null, "FRAME_LIMIT"); }
    const captured: {frame: ChromeWebNavigationFrame; text: DocumentText}[] = [];
    for (const frame of frames) {
      if (!frame.documentId || frame.errorOccurred || frame.documentLifecycle !== undefined && frame.documentLifecycle !== "active") {
        fail(frame.frameId, "DOCUMENT_UNAVAILABLE"); continue;
      }
      const remaining = searchLimit("maximum_total_bytes") - textBytes;
      if (remaining <= 0) { fail(frame.frameId, "TEXT_BUDGET_EXHAUSTED"); continue; }
      const maximumBytes = Math.min(searchLimit("maximum_source_bytes"), remaining);
      const result = await observe(() => {
        assertResolvedTabTarget(target);
        return chrome.scripting.executeScript({ target: { tabId: target.tabId, documentIds: [frame.documentId!] }, world: "ISOLATED",
          func: readDocumentSearchText, args: [maximumBytes, searchLimit("maximum_metadata_bytes")] });
      }, "DOCUMENT_READ_FAILED");
      if (!result.ok) { fail(frame.frameId, result.reason); continue; }
      const entry = result.value[0];
      if (result.value.length !== 1 || entry?.documentId !== frame.documentId || entry.frameId !== frame.frameId || !entry.result) {
        fail(frame.frameId, "DOCUMENT_RECEIPT_MISMATCH"); continue;
      }
      const body = entry.result;
      if (!body.hasBody) { fail(frame.frameId, "NO_RENDERED_BODY"); continue; }
      if (typeof body.text !== "string" || encoder.encode(body.text).byteLength > maximumBytes ||
        encoder.encode(body.text).byteLength !== body.textBytes) { fail(frame.frameId, "INVALID_TEXT_RECEIPT"); continue; }
      textBytes += body.textBytes; captured.push({ frame, text: body });
    }
    // Recheck exact current documents after the tab's reads; do not reuse a new page under an old identity.
    const current = await observe(() => {
      assertResolvedTabTarget(target); return chrome.webNavigation.getAllFrames({ tabId: target.tabId });
    }, "DOCUMENT_RECHECK_FAILED");
    if (!current.ok) { for (const item of captured) fail(item.frame.frameId, current.reason); continue; }
    for (const item of captured) {
      const frame = item.frame;
      if (!current.value.some(value => value.frameId === frame.frameId && value.documentId === frame.documentId && !value.errorOccurred &&
        (value.documentLifecycle === undefined || value.documentLifecycle === "active"))) { fail(frame.frameId, "DOCUMENT_CHANGED"); continue; }
      const digest = await observe(() => crypto.subtle.digest("SHA-256", encoder.encode(item.text.text)), "TEXT_HASH_FAILED");
      if (!digest.ok) { fail(frame.frameId, digest.reason); continue; }
      let documentRef: string;
      try { documentRef = registerDocumentRef(tabRef, target.tabId, frame.frameId, frame.documentId!); }
      catch { fail(frame.frameId, "DOCUMENT_REFERENCE_UNAVAILABLE"); continue; }
      const sha256 = Array.from(new Uint8Array(digest.value), byte => byte.toString(16).padStart(2, "0")).join("");
      sources.push({ ...item.text, tabRef, documentRef, documentId: frame.documentId!, frameId: frame.frameId, parentFrameId: frame.parentFrameId,
        sha256, hashScope: "captured_text" });
    }
  }
  const truncatedDocuments = sources.filter(source => source.textTruncated).length;
  return { sources, coverage: { startedAt, completedAt: Date.now(), source: "body.innerText", temporalScope: "per_document_observation",
    includeFrames: scope.includeFrames, requestedTabs: scope.tabRefs.length, enumeratedDocuments, readDocuments: sources.length,
    omittedFrames, truncatedDocuments, textBytes, failures, complete: failures.length === 0 && truncatedDocuments === 0 } };
}
