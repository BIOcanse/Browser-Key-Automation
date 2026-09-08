import { COMMAND_CATALOG } from "../generated/command-config.js";
import { createTextArtifact } from "./artifact-service.js";
import { CapabilityUnavailableError } from "./capability-error.js";
import { assertResolvedTabTarget, resolveTabTarget } from "./tab-service.js";

export type DebuggerDispatch = <T>(effect: () => Promise<T>) => Promise<T>;

export interface DebuggerSendRequest {
  readonly tabRef: string;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
  readonly response: "inline" | "artifact";
}

export interface DebuggerEvent {
  readonly sequence: number;
  readonly sessionId: string | null;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface DebuggerFrameSession {
  readonly sessionId: string;
  readonly parentSessionId: string | null;
  readonly targetId: string;
}

interface Connection {
  readonly tabRef: string;
  attached: boolean;
  detachedReason: string | null;
  readonly events: { readonly event: DebuggerEvent; readonly bytes: number }[];
  eventBytes: number;
  droppedThroughSequence: number;
  readonly domains: Map<string, symbol>;
  readonly rawDomains: Map<string,Set<string|null>>;
  readonly rawInFlight: Set<{readonly domain: string; readonly sessionId: string | null; retired: boolean}>;
  readonly listeners: Set<(event: DebuggerEvent | null, reason?: string) => void>;
  readonly frameSessions: Map<string, DebuggerFrameSession>;
  sessionTrackingComplete: boolean;
}

export class DebuggerServiceError extends Error {
  readonly code = "DEBUGGER_OPERATION_FAILED" as const;
  readonly details: { readonly reason: string; readonly commandMayHaveRun: boolean; readonly message: string };

  constructor(reason: string, commandMayHaveRun: boolean, message: string) {
    const sanitized = message.replace(/bk1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/gu, "[redacted-key]");
    // Streaming decode omits an incomplete final UTF-8 character at the bound.
    const bounded = new TextDecoder().decode(new TextEncoder().encode(sanitized)
      .subarray(0, COMMAND_CATALOG.limits["command.tabs.maximum_text_bytes"]), { stream: true });
    super(bounded);
    this.name = "DebuggerServiceError";
    this.details = { reason, commandMayHaveRun, message: bounded };
  }
}

const connections = new Map<number, Connection>();
const lifecycleLanes = new Map<number, Promise<void>>();
const encoder = new TextEncoder();
let nextSequence = 1;
let initialized = false;

function api(): NonNullable<typeof chrome.debugger> {
  if (!chrome.debugger) throw new CapabilityUnavailableError("platform.extension.debugger", "CHROMIUM_API_FAILED", "Chromium debugger permission/API is unavailable");
  return chrome.debugger;
}

function discardThrough(connection: Connection, sequence: number): void {
  while (connection.events.length > 0 && (connection.events[0]?.event.sequence ?? Infinity) <= sequence) {
    connection.eventBytes -= connection.events.shift()?.bytes ?? 0;
  }
  connection.droppedThroughSequence = Math.max(connection.droppedThroughSequence, sequence);
}

export function initializeDebuggerService(): void {
  if (initialized || !chrome.debugger) return;
  initialized = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const connection = source.tabId === undefined ? undefined : connections.get(source.tabId);
    if (!connection) return;
    const sequence = nextSequence++;
    const event: DebuggerEvent = { sequence, sessionId: source.sessionId ?? null, method, params: params ?? {} };
    if (connection.attached && method === "Target.attachedToTarget") {
      const data = event.params, info = data.targetInfo as Record<string, unknown> | undefined;
      if (info?.type === "iframe" && (event.sessionId === null || connection.frameSessions.has(event.sessionId))) {
        const maximum = COMMAND_CATALOG.limits["command.debugger.maximum_frame_sessions"];
        if (typeof data.sessionId !== "string" || typeof info.targetId !== "string" || data.sessionId.length > 128 || info.targetId.length > 128 ||
            connection.frameSessions.size >= maximum && !connection.frameSessions.has(data.sessionId)) connection.sessionTrackingComplete = false;
        else connection.frameSessions.set(data.sessionId, {sessionId: data.sessionId, parentSessionId: event.sessionId, targetId: info.targetId});
      }
    }
    if (method === "Target.detachedFromTarget" && typeof event.params.sessionId === "string") {
      const removed = new Set([event.params.sessionId]);
      // Bound the parent walk by the finite tracked graph; no recursive detach traversal.
      for (let pass = 0; pass <= connection.frameSessions.size; pass++) {
        let changed = false;
        for (const session of connection.frameSessions.values()) if (!removed.has(session.sessionId) && session.parentSessionId !== null && removed.has(session.parentSessionId)) {removed.add(session.sessionId); changed = true;}
        if (!changed) break;
      }
      for (const sessionId of removed) connection.frameSessions.delete(sessionId);
      for (const [domain, sessions] of connection.rawDomains) {
        for (const sessionId of removed) sessions.delete(sessionId);
        if (sessions.size === 0) connection.rawDomains.delete(domain);
      }
      for (const call of connection.rawInFlight) if (call.sessionId !== null && removed.has(call.sessionId)) call.retired = true;
    }
    // Functional subscribers see every event before the lossy diagnostic ring.
    for (const listener of connection.listeners) { try { listener(event); } catch { /* consumer owns its error state */ } }
    const bytes = encoder.encode(JSON.stringify(event)).byteLength;
    if (bytes > COMMAND_CATALOG.limits["command.debugger.maximum_event_bytes"]) { discardThrough(connection, sequence); return; }
    connection.events.push({ event, bytes }); connection.eventBytes += bytes;
    while (connection.events.length > COMMAND_CATALOG.limits["command.debugger.maximum_events"] ||
      connection.eventBytes > COMMAND_CATALOG.limits["command.debugger.maximum_event_buffer_bytes"]) {
      discardThrough(connection, connection.events[0]?.event.sequence ?? sequence);
    }
  });
  chrome.debugger.onDetach.addListener((source, reason) => {
    const connection = source.tabId === undefined ? undefined : connections.get(source.tabId);
    if (connection) retireConnection(connection, reason);
  });
  const remove = (tabId: number) => { const connection = connections.get(tabId); if (connection) retireConnection(connection, "TAB_CLOSED"); connections.delete(tabId); };
  chrome.tabs.onRemoved.addListener(remove);
  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => { remove(addedTabId); remove(removedTabId); });
}

function retireConnection(connection: Connection, reason: string): void {
  connection.attached = false; connection.detachedReason = reason;
  for (const listener of connection.listeners) { try { listener(null, reason); } catch { /* consumer owns its error state */ } }
  connection.listeners.clear(); connection.domains.clear(); connection.rawDomains.clear();
  for (const call of connection.rawInFlight) call.retired = true;
  connection.frameSessions.clear();
}

async function inLifecycleLane<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
  const previous = lifecycleLanes.get(tabId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  lifecycleLanes.set(tabId, current);
  await previous;
  try { return await operation(); }
  finally { release(); if (lifecycleLanes.get(tabId) === current) lifecycleLanes.delete(tabId); }
}

function requiredConnection(tabId: number, tabRef: string): Connection {
  const connection = connections.get(tabId);
  if (!connection || connection.tabRef !== tabRef || !connection.attached) throw new DebuggerServiceError("NOT_ATTACHED", false, "Call debugger.attach explicitly for this tab");
  return connection;
}

function message(error: unknown): string { return error instanceof Error ? error.message : "Chromium rejected the debugging operation"; }

export async function attachDebugger(tabRef: string, dispatch: DebuggerDispatch) {
  const target = await resolveTabTarget(tabRef), debuggerApi = api();
  initializeDebuggerService();
  return inLifecycleLane(target.tabId, async () => {
    let launched = false;
    let connection: Connection | undefined;
    try {
      return await dispatch(async () => {
        assertResolvedTabTarget(target);
        const existing = connections.get(target.tabId);
        if (existing?.tabRef === tabRef && existing.attached) return { tabRef, attached: true, alreadyAttached: true };
        if (!existing && connections.size >= COMMAND_CATALOG.limits["command.debugger.maximum_connections"]) {
          throw new DebuggerServiceError("CONNECTION_LIMIT", false, "Detach unused debugger connections before attaching another tab");
        }
        connection = { tabRef, attached: false, detachedReason: null, events: [], eventBytes: 0, droppedThroughSequence: nextSequence - 1,
          domains: new Map(), rawDomains: new Map(), rawInFlight: new Set(), listeners: new Set(), frameSessions: new Map(), sessionTrackingComplete: true };
        connections.set(target.tabId, connection);
        launched = true;
        // CDP 1.3 is the protocol contract, not a policy default.
        await debuggerApi.attach({ tabId: target.tabId }, "1.3");
        assertResolvedTabTarget(target);
        if (connections.get(target.tabId) !== connection || connection.detachedReason !== null) throw new DebuggerServiceError("DETACHED", true, "Chromium detached while the debugger was connecting");
        connection.attached = true;
        return { tabRef, attached: true, alreadyAttached: false };
      });
    } catch (error) {
      if (connection && connections.get(target.tabId) === connection) connections.delete(target.tabId);
      if (!launched || error instanceof DebuggerServiceError) throw error;
      throw new DebuggerServiceError("ATTACH_FAILED", true, message(error));
    }
  });
}

export async function detachDebugger(tabRef: string, dispatch: DebuggerDispatch) {
  const target = await resolveTabTarget(tabRef), debuggerApi = api();
  return inLifecycleLane(target.tabId, async () => {
    let launched = false;
    try {
      return await dispatch(async () => {
        assertResolvedTabTarget(target);
        const connection = connections.get(target.tabId);
        const detached = connection?.tabRef === tabRef && connection.attached;
        if (detached) { launched = true; await debuggerApi.detach({ tabId: target.tabId }); }
        if (connections.get(target.tabId) === connection) {
          if (connection) retireConnection(connection, "EXPLICIT_DETACH");
          connections.delete(target.tabId);
        }
        return { tabRef, detached, attached: false };
      });
    } catch (error) {
      if (!launched) throw error;
      throw new DebuggerServiceError("DETACH_FAILED", true, message(error));
    }
  });
}

export async function sendDebuggerCommand(ownerKeyId: string, request: DebuggerSendRequest, dispatch: DebuggerDispatch) {
  const response = await sendDebuggerProtocol(request, dispatch);
  try {
    const result = response ?? null;
    if (request.response === "artifact") {
      const artifact = await createTextArtifact(ownerKeyId, "application/json", JSON.stringify(result));
      return { tabRef: request.tabRef, result: null, artifact };
    }
    const output = { tabRef: request.tabRef, result, artifact: null };
    if (encoder.encode(JSON.stringify(output)).byteLength > COMMAND_CATALOG.limits["command.inline.maximum_result_json_bytes"]) {
      throw new DebuggerServiceError("RESULT_TOO_LARGE", true, "The command ran; request response=artifact before commands with large responses. Do not automatically replay this command.");
    }
    return output;
  } catch (error) {
    if (error instanceof DebuggerServiceError) throw error;
    throw new DebuggerServiceError("RESULT_STORAGE_FAILED", true, "The command ran but its result could not be stored; do not automatically replay it");
  }
}

/** Internal protocol transport; never wraps binary protocol payloads in a JSON Artifact. */
export async function sendDebuggerProtocol(
  request: Omit<DebuggerSendRequest, "response">, dispatch: DebuggerDispatch, lease?: symbol, beforeSend?:()=>void,
): Promise<unknown> {
  const target = await resolveTabTarget(request.tabRef), debuggerApi = api();
    let launched = false;
    try {
      return await dispatch(async () => {
        assertResolvedTabTarget(target);
        const connection = requiredConnection(target.tabId, request.tabRef), domain = request.method.split(".")[0]!;
        const holder = connection.domains.get(domain);
        if (lease !== undefined ? holder !== lease : holder !== undefined) throw new DebuggerServiceError("DOMAIN_IN_USE", false, "The protocol domain is owned by another active feature; stop that feature first");
        beforeSend?.();
        launched = true;
        const raw = lease === undefined ? {domain, sessionId: request.sessionId ?? null, retired: false} : null;
        if (raw) connection.rawInFlight.add(raw);
        try {
          const result = await debuggerApi.sendCommand({tabId: target.tabId, ...(request.sessionId === undefined ? {} : {sessionId: request.sessionId})}, request.method, request.params);
          if (raw && !raw.retired) {
            if (request.method.endsWith(".enable") || request.method === "Tracing.start") {
              const sessions=connection.rawDomains.get(domain)??new Set<string|null>();
              sessions.add(request.sessionId??null);connection.rawDomains.set(domain,sessions);
            }
            if (request.method.endsWith(".disable") || request.method === "Tracing.end") {
              const sessions=connection.rawDomains.get(domain);sessions?.delete(request.sessionId??null);
              if(sessions?.size===0)connection.rawDomains.delete(domain);
            }
          }
          return result;
        }finally{
          if (raw) connection.rawInFlight.delete(raw);
        }
      });
    } catch (error) {
      if (!launched) throw error;
      throw new DebuggerServiceError("COMMAND_FAILED", true, message(error));
    }
}

export interface DebuggerLease {
  send(method: string, params?: Readonly<Record<string, unknown>>, sessionId?: string, beforeSend?:()=>void): Promise<unknown>;
  cleanup(method: string, params?: Readonly<Record<string, unknown>>, sessionId?: string): Promise<unknown>;
  release(): void;
}

/** Only sessions already announced on this explicitly attached connection; never attaches targets. */
export async function getDebuggerFrameSessions(tabRef: string): Promise<readonly DebuggerFrameSession[]> {
  const target = await resolveTabTarget(tabRef), connection = requiredConnection(target.tabId, tabRef);
  if (!connection.sessionTrackingComplete) throw new DebuggerServiceError("SESSION_TRACKING_INCOMPLETE", false, "Explicitly detach and reattach before using frame geometry");
  return [...connection.frameSessions.values()].sort((a, b) => a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0);
}

/** Exclusive stateful domain ownership; lifetime and enable/disable belong to the feature. */
export async function leaseDebuggerDomains(tabRef: string, domains: readonly string[], dispatch: DebuggerDispatch,
  listener: (event: DebuggerEvent | null, reason?: string) => void): Promise<DebuggerLease> {
  const target = await resolveTabTarget(tabRef), token = Symbol("debugger-feature");
  const connection = await inLifecycleLane(target.tabId, () => dispatch(async () => {
    assertResolvedTabTarget(target);
    const current = requiredConnection(target.tabId, tabRef);
    if (domains.some((domain) => current.domains.has(domain) || current.rawDomains.has(domain) || [...current.rawInFlight].some(call => call.domain === domain))) throw new DebuggerServiceError("DOMAIN_IN_USE", false, "Stop the active feature or explicitly disable the raw domain before starting another owner");
    for (const domain of domains) current.domains.set(domain, token);
    current.listeners.add(listener);
    return current;
  }));
  return {
    send: (method, params = {}, sessionId, beforeSend) => sendDebuggerProtocol({tabRef,method,params,...(sessionId === undefined ? {} : {sessionId})},dispatch,token,beforeSend),
    cleanup: (method,params={},sessionId) => {
      if(!["Network.disable","Runtime.disable","Runtime.releaseObject","Log.disable","Page.disable","Performance.disable","Fetch.disable","Fetch.continueRequest","Tracing.end","IO.close"].includes(method))throw new DebuggerServiceError("INVALID_CLEANUP",false,"Only owned resource release is permitted during cleanup");
      return sendDebuggerProtocol({tabRef,method,params,...(sessionId===undefined?{}:{sessionId})},effect=>effect(),token);
    },
    release: () => {
      connection.listeners.delete(listener);
      for (const domain of domains) if (connection.domains.get(domain) === token) connection.domains.delete(domain);
    },
  };
}

export async function getDebuggerEvents(tabRef: string, afterSequence: number, limit: number) {
  const target = await resolveTabTarget(tabRef);
  const connection = connections.get(target.tabId);
  const current = connection?.tabRef === tabRef ? connection : undefined;
  const items: DebuggerEvent[] = [];
  const output = { tabRef, attached: current?.attached ?? false, detachedReason: current?.detachedReason ?? null,
    droppedThroughSequence: current?.droppedThroughSequence ?? 0, nextSequence: Math.max(afterSequence, current?.droppedThroughSequence ?? 0), hasMore: false, items };
  for (const item of current?.events ?? []) {
    if (item.event.sequence <= afterSequence) continue;
    if (items.length >= limit || encoder.encode(JSON.stringify({ ...output, items: [...items, item.event] })).byteLength > COMMAND_CATALOG.limits["command.inline.maximum_result_json_bytes"]) {
      output.hasMore = true; break;
    }
    items.push(item.event); output.nextSequence = item.event.sequence;
  }
  return output;
}
