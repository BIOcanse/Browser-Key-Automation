import { COMMAND_CATALOG } from "../../generated/command-config.js";
import type { PublicKeyRecord } from "../../shared/admin-protocol.js";
import { BrowserOperationError, featureLimit, object, waitForFeatureReceipt } from "../browser-feature-model.js";
import { getDebuggerFrameSessions, leaseDebuggerDomains, type DebuggerDispatch, type DebuggerEvent, type DebuggerLease } from "../debugger-service.js";
import { DomServiceError, type NodeRefTarget } from "../dom-service.js";
import { collectDocumentGeometry, type DocumentGeometryResult } from "./document-geometry.js";
import { combineFrameGeometry } from "./frame-geometry.js";
import { clearFrameDocumentProof, readFrameDocumentChain, readFrameDocumentProof, setFrameDocumentProof, type FrameDocument } from "./frame-identity.js";
import { ElementScreenshotError, type CaptureGeometry } from "./geometry-model.js";

const limit = (name: string) => featureLimit(`command.page.screenshot.${name}`);
interface Lifetime {readonly ownerKeyId: string; readonly controller: AbortController; expiresAt: number; reason: string | null; timer: ReturnType<typeof setTimeout> | null;}
interface Context {readonly id: number; readonly uniqueId: string; readonly frameId: string; readonly sessionId: string | null;}
interface Proof {readonly document: FrameDocument; readonly nonce: string; context?: Context;}
interface RemoteReference {readonly sessionId: string | null; readonly objectId: string; release: Promise<void> | null;}
export interface FrameMapping {
  geometry(): Promise<CaptureGeometry>;
  guard<T>(effect: () => Promise<T>): Promise<T>;
}
const lifetimes = new Set<Lifetime>();
function stop(lifetime: Lifetime, reason: string): void {lifetime.reason ??= reason; lifetime.controller.abort();}
function arm(lifetime: Lifetime): void {
  if (lifetime.timer !== null) clearTimeout(lifetime.timer);
  lifetime.timer = setTimeout(() => stop(lifetime, "FRAME_MAPPING_DEADLINE"), Math.max(0, lifetime.expiresAt - Date.now()));
}
function geometryResult(result: DocumentGeometryResult): CaptureGeometry {
  if (result.ok) return result.geometry;
  if (result.reason === "stale") throw new DomServiceError("TARGET_REF_STALE", "Screenshot node or owner changed");
  throw new ElementScreenshotError(result.reason === "limit" ? "LIMIT_EXCEEDED" : result.reason === "empty" ? "EMPTY_REGION" : "GEOMETRY_UNSUPPORTED", result.feature);
}
function runtimeValue(result: unknown): unknown {
  if (!object(result) || result.exceptionDetails || !object(result.result)) throw new ElementScreenshotError("GEOMETRY_CHANGED", "frame-context-evaluation");
  return result.result.value;
}

/** Uses only explicitly attached sessions. All temporary resources belong to this one capture. */
export async function withFrameMapping<T>(caller: PublicKeyRecord, target: NodeRefTarget, dispatch: DebuggerDispatch,
  operation: (mapping: FrameMapping) => Promise<T>): Promise<T> {
  if (lifetimes.size >= limit("maximum_frame_mappings")) throw new BrowserOperationError("FRAME_MAPPING_LIMIT");
  const lifetime: Lifetime = {ownerKeyId: caller.keyId, controller: new AbortController(), expiresAt: Date.now() + limit("frame_mapping_timeout_ms"), reason: null, timer: null};
  lifetimes.add(lifetime); arm(lifetime);
  const proofId = crypto.randomUUID(), proofs: Proof[] = [], contexts = new Map<string, Context>();
  const pending = new Set<Promise<unknown>>(), enabled = new Set<string | null>(), retired = new Set<string>();
  const objects = new Map<string, RemoteReference>(), ownerIds: number[] = [];
  let lostReferences = false;
  let lease: DebuggerLease | null = null, closing = false, detached = false, releaseDetached!: () => void;
  let sessionParents = new Map<string, string | null>();
  const detachedReceipt = new Promise<void>(resolve => {releaseDetached = resolve;});
  const keyFor = (sessionId: string | null, uniqueId: string) => `${sessionId ?? "root"}:${uniqueId}`;
  const active = () => {if (closing || lifetime.controller.signal.aborted || Date.now() >= lifetime.expiresAt) throw new BrowserOperationError(lifetime.reason ?? "FRAME_MAPPING_DEADLINE");};
  const gate: DebuggerDispatch = effect => dispatch(async () => {active(); return effect();});
  const track = <V>(receipt: Promise<V>): Promise<V> => {pending.add(receipt); void receipt.finally(() => pending.delete(receipt)).catch(() => undefined); return receipt;};
  const observe = async <V>(receipt: Promise<V>): Promise<V> => {
    const value = await waitForFeatureReceipt(track(receipt), Math.max(0, lifetime.expiresAt - Date.now()), "FRAME_MAPPING_DEADLINE", lifetime.controller.signal); active(); return value;
  };
  const releaseObject = (ref: RemoteReference): void => {
    if (ref.release || !lease || detached) return;
    const identity = JSON.stringify([ref.sessionId, ref.objectId]);
    ref.release = track(lease.cleanup("Runtime.releaseObject", {objectId: ref.objectId}, ref.sessionId ?? undefined)
      .then(() => {objects.delete(identity);}, () => {lostReferences = true;}));
  };
  const rememberObject = (sessionId: string | null, remote: unknown, retain: boolean): void => {
    if (!object(remote) || typeof remote.objectId !== "string" || detached || sessionId !== null && retired.has(sessionId)) return;
    const identity = JSON.stringify([sessionId, remote.objectId]);
    if (objects.has(identity)) return;
    if (objects.size >= limit("maximum_frame_objects")) {lostReferences = true; stop(lifetime, "FRAME_REFERENCE_LIMIT"); return;}
    const ref: RemoteReference = {sessionId, objectId: remote.objectId, release: null}; objects.set(identity, ref);
    if (!retain) releaseObject(ref);
  };
  const receive = (event: DebuggerEvent | null): void => {
    if (event === null) {detached = true; releaseDetached(); stop(lifetime, "DEBUGGER_DETACHED"); return;}
    if (event.method === "Target.detachedFromTarget" && typeof event.params.sessionId === "string") {
      retired.add(event.params.sessionId);
      for (let pass = 0; pass <= sessionParents.size; pass++) {
        let changed = false; for (const [sessionId, parent] of sessionParents) if (parent !== null && retired.has(parent) && !retired.has(sessionId)) {retired.add(sessionId); changed = true;}
        if (!changed) break;
      }
      if (proofs.some(proof => proof.context?.sessionId && retired.has(proof.context.sessionId))) stop(lifetime, "FRAME_SESSION_DETACHED");
    }
    // Runtime.enable can deliver existing console values; they belong to this lease too.
    if (enabled.has(event.sessionId)) {
      if (event.method === "Runtime.consoleAPICalled" && Array.isArray(event.params.args)) for (const arg of event.params.args) rememberObject(event.sessionId, arg, false);
      if (event.method === "Runtime.exceptionThrown" && object(event.params.exceptionDetails)) rememberObject(event.sessionId, event.params.exceptionDetails.exception, false);
      if (event.method === "Runtime.inspectRequested") rememberObject(event.sessionId, event.params.object, false);
    }
    if (event.method === "Runtime.executionContextsCleared") for (const [key, context] of contexts) if (context.sessionId === event.sessionId) contexts.delete(key);
    if (event.method === "Runtime.executionContextDestroyed") for (const [key, context] of contexts) if (context.sessionId === event.sessionId &&
      (event.params.executionContextUniqueId === context.uniqueId || event.params.executionContextId === context.id)) contexts.delete(key);
    if (event.method !== "Runtime.executionContextCreated" || closing || !enabled.has(event.sessionId)) return;
    const context = event.params.context;
    if (!object(context) || context.origin !== `chrome-extension://${chrome.runtime.id}` || !object(context.auxData) || context.auxData.type !== "isolated") return;
    if (!Number.isSafeInteger(context.id) || typeof context.uniqueId !== "string" || typeof context.auxData.frameId !== "string") {stop(lifetime, "FRAME_CONTEXT_INVALID"); return;}
    if (!contexts.has(keyFor(event.sessionId, context.uniqueId)) && contexts.size >= limit("maximum_frame_contexts")) {stop(lifetime, "FRAME_CONTEXT_LIMIT"); return;}
    contexts.set(keyFor(event.sessionId, context.uniqueId), {id: context.id as number, uniqueId: context.uniqueId, frameId: context.auxData.frameId, sessionId: event.sessionId});
  };
  const send = async (method: string, params: Readonly<Record<string, unknown>>, sessionId: string | null): Promise<unknown> => {
    active(); if (!lease) throw new BrowserOperationError("FRAME_MAPPING_NOT_READY");
    const receipt = lease.send(method, params, sessionId ?? undefined, () => {active(); if (method === "Runtime.enable") enabled.add(sessionId);}).then(result => {
      // Keep late-created references so cleanup can release the original exact object.
      if (object(result)) {
        if (method === "DOM.resolveNode") rememberObject(sessionId, result.object, true);
        if (object(result.exceptionDetails)) rememberObject(sessionId, result.exceptionDetails.exception, false);
      }
      return result;
    });
    return observe(receipt);
  };
  const injected = async <A extends readonly unknown[], R>(document: FrameDocument, func: (...args: A) => R, args: A): Promise<R> => {
    const entries = await observe(gate(() => chrome.scripting.executeScript({target: {tabId: target.tabId, documentIds: [document.documentId]}, world: "ISOLATED", func, args})));
    const entry = entries[0];
    if (entries.length !== 1 || entry?.frameId !== document.frameId || entry.documentId !== document.documentId || entry.result === undefined) throw new DomServiceError("TARGET_REF_STALE", "Frame injection receipt changed");
    return entry.result;
  };
  const currentContext = (proof: Proof): Context => {
    const context = proof.context;
    if (!context || !contexts.has(keyFor(context.sessionId, context.uniqueId)) || context.sessionId !== null && retired.has(context.sessionId)) throw new ElementScreenshotError("GEOMETRY_CHANGED", "frame-context-identity");
    return context;
  };
  const checkProof = async (proof: Proof): Promise<void> => {
    currentContext(proof); const actual = await injected(proof.document, readFrameDocumentProof, []);
    if (actual?.proofId !== proofId || actual.nonce !== proof.nonce) throw new ElementScreenshotError("GEOMETRY_CHANGED", "frame-document-proof");
  };
  const geometry = async (): Promise<CaptureGeometry> => {
    const chain = await observe(gate(() => readFrameDocumentChain(target)));
    if (JSON.stringify(chain) !== JSON.stringify(proofs.map(proof => proof.document))) throw new ElementScreenshotError("GEOMETRY_CHANGED", "frame-document-chain");
    for (const proof of proofs) await checkProof(proof);
    const args = [COMMAND_CATALOG.limits["command.page.screenshot.maximum_geometry_nodes"], COMMAND_CATALOG.limits["command.page.screenshot.maximum_geometry_depth"], COMMAND_CATALOG.limits["command.page.screenshot.maximum_geometry_bytes"]] as const;
    let result = geometryResult(await injected(proofs[0]!.document, collectDocumentGeometry, [target.nodeRef, ...args, true]));
    for (let index = 1; index < proofs.length; index++) {
      const child = currentContext(proofs[index - 1]!), parent = currentContext(proofs[index]!);
      const owner = await send("DOM.getFrameOwner", {frameId: child.frameId}, parent.sessionId);
      if (!object(owner) || !Number.isSafeInteger(owner.backendNodeId) || Number(owner.backendNodeId) <= 0) throw new ElementScreenshotError("GEOMETRY_CHANGED", "frame-owner-identity");
      if (ownerIds[index] !== undefined && ownerIds[index] !== owner.backendNodeId) throw new ElementScreenshotError("GEOMETRY_CHANGED", "frame-owner-replaced");
      ownerIds[index] = owner.backendNodeId as number;
      const resolved = await send("DOM.resolveNode", {backendNodeId: owner.backendNodeId, executionContextId: parent.id}, parent.sessionId);
      if (!object(resolved) || !object(resolved.object) || typeof resolved.object.objectId !== "string") throw new ElementScreenshotError("GEOMETRY_CHANGED", "frame-owner-object");
      const objectId = resolved.object.objectId;
      const proof = runtimeValue(await send("Runtime.callFunctionOn", {objectId, functionDeclaration: readFrameDocumentProof.toString(), returnByValue: true, silent: true}, parent.sessionId));
      if (!object(proof) || proof.proofId !== proofId || proof.nonce !== proofs[index]!.nonce) throw new ElementScreenshotError("GEOMETRY_CHANGED", "frame-owner-context");
      // Construct the private null marker inside JS: extension CDP transport may omit null-valued CallArgument.value.
      const collected = runtimeValue(await send("Runtime.callFunctionOn", {objectId,
        functionDeclaration: `function(...args) { return (${collectDocumentGeometry.toString()}).call(this, null, ...args); }`,
        arguments: [...args, true].map(value => ({value})), returnByValue: true, silent: true}, parent.sessionId));
      if (!object(collected) || typeof collected.ok !== "boolean") throw new ElementScreenshotError("GEOMETRY_CHANGED", "frame-owner-geometry");
      result = combineFrameGeometry(result, geometryResult(collected as unknown as DocumentGeometryResult));
    }
    for (const proof of proofs) await checkProof(proof);
    return result;
  };
  let result: T | undefined, error: unknown;
  try {
    active();
    await observe(leaseDebuggerDomains(target.tabRef, ["DOM", "Runtime"], gate, receive).then(value => {lease = value;}));
    const sessions = await observe(gate(() => getDebuggerFrameSessions(target.tabRef))); sessionParents = new Map(sessions.map(session => [session.sessionId, session.parentSessionId]));
    const documents = await observe(gate(() => readFrameDocumentChain(target)));
    for (const document of documents) {
      const proof = {document, nonce: crypto.randomUUID()}; proofs.push(proof);
      if (!await injected(document, setFrameDocumentProof, [proofId, proof.nonce, Math.max(1, lifetime.expiresAt - Date.now())])) throw new ElementScreenshotError("GEOMETRY_UNSUPPORTED", "frame-document-proof-in-use");
    }
    for (const sessionId of [null, ...sessions.map(session => session.sessionId)]) await send("Runtime.enable", {}, sessionId);
    for (const context of [...contexts.values()]) {
      const actual = runtimeValue(await send("Runtime.evaluate", {expression: `(${readFrameDocumentProof.toString()})()`, uniqueContextId: context.uniqueId, returnByValue: true, silent: true}, context.sessionId));
      if (!object(actual) || actual.proofId !== proofId) continue;
      const proof = proofs.find(candidate => candidate.nonce === actual.nonce); if (!proof) continue;
      if (proof.context) throw new ElementScreenshotError("GEOMETRY_CHANGED", "ambiguous-frame-context");
      proof.context = context;
    }
    if (proofs.some(proof => !proof.context)) throw new ElementScreenshotError("GEOMETRY_UNSUPPORTED", "frame-session-not-attached");
    await observe(operation({geometry, guard: effect => observe(gate(effect))}).then(value => {result = value;}));
    await gate(async () => {active();});
  } catch (caught) {error = lifetime.reason ? new BrowserOperationError(lifetime.reason) : caught;}
  closing = true; lifetime.controller.abort(); if (lifetime.timer !== null) clearTimeout(lifetime.timer);
  const finish = () => {lease?.release(); lifetimes.delete(lifetime);};
  const cleanup = (async () => {
    await Promise.race([Promise.allSettled([...pending]), detachedReceipt]);
    let complete = true;
    for (const proof of proofs) {
      try {await chrome.scripting.executeScript({target: {tabId: target.tabId, documentIds: [proof.document.documentId]}, world: "ISOLATED", func: clearFrameDocumentProof, args: [proofId, proof.nonce]});}
      catch { /* An old document cannot be reused; its private proof also expires. */ }
    }
    if (!detached && lease) {
      for (const sessionId of enabled) if (sessionId === null || !retired.has(sessionId)) {
        try {await lease.cleanup("Runtime.disable", {}, sessionId ?? undefined);} catch {complete = false;}
      }
      for (const [identity, ref] of objects) {
        if (ref.sessionId !== null && retired.has(ref.sessionId)) objects.delete(identity);
        else releaseObject(ref);
      }
      await Promise.race([Promise.allSettled([...pending]), detachedReceipt]);
    }
    complete &&= !lostReferences && objects.size === 0;
    if (complete || detached) finish();
    else void detachedReceipt.then(finish);
    return complete || detached;
  })();
  try {
    if (!await waitForFeatureReceipt(cleanup, limit("frame_cleanup_timeout_ms"), "FRAME_MAPPING_CLEANUP_PENDING")) throw new Error("cleanup not confirmed");
  } catch {
    void cleanup.catch(() => undefined); void detachedReceipt.then(finish);
    throw new BrowserOperationError("FRAME_MAPPING_CLEANUP_PENDING", true, {nodeRef: target.nodeRef, captureCompleted: result !== undefined, operationError: error instanceof Error ? error.message : null, requiredAction: "explicit_debugger_detach"});
  }
  if (error !== undefined) throw error;
  return result as T;
}
