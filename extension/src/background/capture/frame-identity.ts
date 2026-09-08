import { COMMAND_CATALOG } from "../../generated/command-config.js";
import { DomServiceError, type NodeRefTarget } from "../dom-service.js";
import { ElementScreenshotError } from "./geometry-model.js";

export interface FrameDocument {
  readonly frameId: number;
  readonly documentId: string;
  readonly parentFrameId: number;
}
export interface DocumentProof { readonly proofId: string; readonly nonce: string; readonly expiresAt: number; }

/** A private isolated-world slot, unrelated to page DOM or the public NodeRef registry. */
export function setFrameDocumentProof(proofId: string, nonce: string, durationMs: number): boolean {
  const page = globalThis as unknown as {__BKA_CAPTURE_DOCUMENT_PROOF_V1__?: DocumentProof; readonly performance: {now(): number}};
  const now = page.performance.now(), existing = page.__BKA_CAPTURE_DOCUMENT_PROOF_V1__;
  if (existing && existing.expiresAt > now && existing.proofId !== proofId) return false;
  page.__BKA_CAPTURE_DOCUMENT_PROOF_V1__ = {proofId, nonce, expiresAt: now + durationMs}; return true;
}

export function clearFrameDocumentProof(proofId: string, nonce: string): void {
  const page = globalThis as unknown as {__BKA_CAPTURE_DOCUMENT_PROOF_V1__?: DocumentProof};
  if (page.__BKA_CAPTURE_DOCUMENT_PROOF_V1__?.proofId === proofId && page.__BKA_CAPTURE_DOCUMENT_PROOF_V1__.nonce === nonce) delete page.__BKA_CAPTURE_DOCUMENT_PROOF_V1__;
}

// Evaluated only in verified same-extension isolated contexts. The expected nonce is never in the expression.
export function readFrameDocumentProof(): {proofId: string; nonce: string} | null {
  const page = globalThis as unknown as {__BKA_CAPTURE_DOCUMENT_PROOF_V1__?: DocumentProof; readonly performance: {now(): number}};
  const proof = page.__BKA_CAPTURE_DOCUMENT_PROOF_V1__;
  return proof && proof.expiresAt > page.performance.now() ? {proofId: proof.proofId, nonce: proof.nonce} : null;
}

/** Bottom-up immutable Chrome document chain, never inferred from URLs or frame order. */
export async function readFrameDocumentChain(target: NodeRefTarget): Promise<readonly FrameDocument[]> {
  const frames = await chrome.webNavigation.getAllFrames({tabId: target.tabId});
  if (frames.length > COMMAND_CATALOG.limits["command.page.screenshot.maximum_geometry_nodes"]) throw new ElementScreenshotError("LIMIT_EXCEEDED", "frame-document-count");
  const byId = new Map(frames.map(frame => [frame.frameId, frame]));
  if (byId.size !== frames.length) throw new DomServiceError("TARGET_REF_STALE", "Ambiguous Chrome frame identity");
  const chain: FrameDocument[] = [], seen = new Set<number>(); let frameId = target.frameId;
  while (frameId >= 0) {
    if (chain.length >= COMMAND_CATALOG.limits["command.page.screenshot.maximum_geometry_depth"]) throw new ElementScreenshotError("LIMIT_EXCEEDED", "frame-document-depth");
    const frame = byId.get(frameId);
    if (!frame || seen.has(frameId) || !frame.documentId || frame.errorOccurred || frame.documentLifecycle !== undefined && frame.documentLifecycle !== "active" ||
        chain.length === 0 && frame.documentId !== target.documentId) throw new DomServiceError("TARGET_REF_STALE", "Screenshot document chain changed");
    seen.add(frameId); chain.push({frameId, documentId: frame.documentId, parentFrameId: frame.parentFrameId}); frameId = frame.parentFrameId;
  }
  if (chain.at(-1)?.frameId !== 0 || chain.at(-1)?.parentFrameId !== -1) throw new DomServiceError("TARGET_REF_STALE", "Screenshot chain has no top document");
  return chain;
}
