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

interface DebuggerEvent {
  readonly sequence: number;
  readonly sessionId: string | null;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

interface Connection {
  readonly tabRef: string;
  attached: boolean;
  detachedReason: string | null;
  readonly events: { readonly event: DebuggerEvent; readonly bytes: number }[];
  eventBytes: number;
  droppedThroughSequence: number;
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
    if (connection) { connection.attached = false; connection.detachedReason = reason; }
  });
  chrome.tabs.onRemoved.addListener((tabId) => connections.delete(tabId));
  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => { connections.delete(addedTabId); connections.delete(removedTabId); });
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
        connection = { tabRef, attached: false, detachedReason: null, events: [], eventBytes: 0, droppedThroughSequence: nextSequence - 1 };
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
        if (connections.get(target.tabId) === connection) connections.delete(target.tabId);
        return { tabRef, detached, attached: false };
      });
    } catch (error) {
      if (!launched) throw error;
      throw new DebuggerServiceError("DETACH_FAILED", true, message(error));
    }
  });
}

export async function sendDebuggerCommand(ownerKeyId: string, request: DebuggerSendRequest, dispatch: DebuggerDispatch) {
  const target = await resolveTabTarget(request.tabRef), debuggerApi = api();
  let launched = false;
  let response: unknown;
  try {
    response = await dispatch(async () => {
      assertResolvedTabTarget(target); requiredConnection(target.tabId, request.tabRef);
      launched = true;
      return debuggerApi.sendCommand({ tabId: target.tabId, ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }) }, request.method, request.params);
    });
  } catch (error) {
    if (!launched) throw error;
    throw new DebuggerServiceError("COMMAND_FAILED", true, message(error));
  }
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
