import { COMMAND_CATALOG } from "../generated/command-config.js";
import { createTextArtifact, type ArtifactMetadata } from "./artifact-service.js";
import { EXECUTION_TRACE_STORE, requestResult, withReadOnly, withStrictReadWrite } from "./database.js";

const TRACE_REF_PATTERN = /^xr1\.[A-Za-z0-9_-]{43}$/u;
const GENERATION_ATTEMPTS = 8;
const TRACE_SCHEMA_VERSION = 1;
const encoder = new TextEncoder();

export type TraceOutcome = "succeeded" | "failed" | "unknown" | "interrupted";
export type TraceResponseState = "complete" | "partial" | "unavailable" | "not_admitted";

export interface ExecutionTraceEventInput {
  readonly phase: "command" | "condition" | "prepare" | "effect" | "verify";
  readonly operation: string;
  readonly status: string;
  readonly nodeRef?: string | null;
  readonly conditionKind?: string | null;
  readonly attempt?: number | null;
}

export interface ExecutionTraceEvent {
  readonly sequence: number;
  readonly elapsedMs: number;
  readonly phase: ExecutionTraceEventInput["phase"];
  readonly operation: string;
  readonly status: string;
  readonly nodeRef: string | null;
  readonly conditionKind: string | null;
  readonly attempt: number | null;
}

export interface ExecutionTraceRecord {
  readonly traceRef: string;
  readonly traceSchemaVersion: 1;
  readonly method: string;
  readonly commandSchemaVersion: number;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly elapsedMs: number | null;
  readonly outcome: TraceOutcome;
  readonly errorCode: string | null;
  readonly ensureStatus: "satisfied" | "failed" | "unknown" | null;
  readonly ensureStage: "condition" | "prepare" | "effect" | "verify" | null;
  readonly effectEntries: number;
  readonly events: readonly ExecutionTraceEvent[];
  readonly eventsTruncated: boolean;
  readonly droppedEventCount: number;
}

interface StoredExecutionTrace extends Omit<ExecutionTraceRecord, "outcome"> {
  readonly outcome: Exclude<TraceOutcome, "interrupted"> | null;
}

interface TraceRingRecord {
  readonly ownerKeyId: string;
  readonly traces: readonly StoredExecutionTrace[];
}

interface MutableTraceRingRecord {
  readonly ownerKeyId: string;
  readonly traces: StoredExecutionTrace[];
}

export interface ExecutionTraceDraft {
  readonly ownerKeyId: string;
  readonly traceRef: string;
  readonly method: string;
  readonly commandSchemaVersion: number;
  readonly effectKind: string;
  readonly startedAt: number;
  readonly startedMonotonic: number;
  readonly events: ExecutionTraceEvent[];
  effectEntries: number;
  droppedEventCount: number;
}

export interface TraceTerminal {
  readonly outcome: Exclude<TraceOutcome, "interrupted">;
  readonly errorCode: string | null;
  readonly ensureStatus: "satisfied" | "failed" | "unknown" | null;
  readonly ensureStage: "condition" | "prepare" | "effect" | "verify" | null;
}

export class TraceServiceError extends Error {
  readonly code = "TRACE_NOT_FOUND" as const;

  constructor() {
    super("Execution trace is unavailable to this Key");
    this.name = "TraceServiceError";
  }
}

function maximumRecordsPerKey(): number {
  return COMMAND_CATALOG.limits["command.trace.maximum_records_per_key"];
}

function maximumEvents(): number {
  return COMMAND_CATALOG.limits["command.trace.maximum_events"];
}

function maximumRecordBytes(): number {
  return COMMAND_CATALOG.limits["command.trace.maximum_record_json_bytes"];
}

function maximumIoMs(): number {
  return COMMAND_CATALOG.limits["command.trace.maximum_io_ms"];
}

function maximumOwnerRecords(): number {
  return COMMAND_CATALOG.limits["command.trace.maximum_owner_records"];
}

function maximumRetentionMs(): number {
  return COMMAND_CATALOG.limits["command.trace.maximum_retention_ms"];
}

function maximumTotalJsonBytes(): number {
  return COMMAND_CATALOG.limits["command.trace.maximum_total_json_bytes"];
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  let index = 0;
  while (index < bytes.length) {
    binary += String.fromCharCode(bytes[index] ?? 0);
    index += 1;
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function randomTraceRef(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `xr1.${base64Url(bytes)}`;
}

function publicRecord(record: StoredExecutionTrace): ExecutionTraceRecord {
  return { ...record, outcome: record.outcome ?? "interrupted" };
}

function boundedStoredRecord(record: StoredExecutionTrace): StoredExecutionTrace {
  let events = [...record.events];
  let droppedEventCount = record.droppedEventCount;
  let candidate: StoredExecutionTrace = { ...record, events, eventsTruncated: droppedEventCount > 0 };
  while (encoder.encode(JSON.stringify(publicRecord(candidate))).byteLength > maximumRecordBytes() && events.length > 0) {
    events = events.slice(0, -1);
    droppedEventCount += 1;
    candidate = { ...record, events, droppedEventCount, eventsTruncated: true };
  }
  if (encoder.encode(JSON.stringify(publicRecord(candidate))).byteLength > maximumRecordBytes()) {
    throw new Error("Execution trace scalar projection exceeds its configured byte bound");
  }
  return candidate;
}

function storedRecordBytes(record: StoredExecutionTrace): number {
  return encoder.encode(JSON.stringify(publicRecord(record))).byteLength;
}

function liveRings(records: readonly TraceRingRecord[], now: number): MutableTraceRingRecord[] {
  const cutoff = now - maximumRetentionMs();
  const rings: MutableTraceRingRecord[] = [];
  let index = 0;
  while (index < records.length) {
    const record = records[index];
    if (record !== undefined) {
      const traces = record.traces.filter((trace) => trace.startedAt >= cutoff);
      if (traces.length > 0) rings.push({ ownerKeyId: record.ownerKeyId, traces });
    }
    index += 1;
  }
  return rings;
}

function oldestEvictable(
  rings: readonly MutableTraceRingRecord[],
  protectedTraceRef: string,
): { readonly ringIndex: number; readonly traceIndex: number; readonly startedAt: number } | null {
  let selected: { readonly ringIndex: number; readonly traceIndex: number; readonly startedAt: number } | null = null;
  let ringIndex = 0;
  while (ringIndex < rings.length) {
    const ring = rings[ringIndex];
    if (ring !== undefined) {
      let traceIndex = 0;
      while (traceIndex < ring.traces.length) {
        const trace = ring.traces[traceIndex];
        if (trace !== undefined && trace.traceRef !== protectedTraceRef &&
            (selected === null || trace.startedAt < selected.startedAt)) {
          selected = { ringIndex, traceIndex, startedAt: trace.startedAt };
        }
        traceIndex += 1;
      }
    }
    ringIndex += 1;
  }
  return selected;
}

function enforceGlobalBounds(rings: MutableTraceRingRecord[], protectedTraceRef: string): void {
  while (rings.length > maximumOwnerRecords()) {
    const oldest = oldestEvictable(rings, protectedTraceRef);
    if (oldest === null) throw new Error("The protected execution trace exceeds the global owner bound");
    const owner = rings[oldest.ringIndex];
    if (owner === undefined) throw new Error("Execution trace owner selection became invalid");
    owner.traces.splice(oldest.traceIndex, 1);
    if (owner.traces.length === 0) rings.splice(oldest.ringIndex, 1);
  }
  let totalBytes = 0;
  for (const ring of rings) {
    for (const trace of ring.traces) totalBytes += storedRecordBytes(trace);
  }
  while (totalBytes > maximumTotalJsonBytes()) {
    const oldest = oldestEvictable(rings, protectedTraceRef);
    if (oldest === null) throw new Error("The protected execution trace exceeds the global byte bound");
    const owner = rings[oldest.ringIndex];
    const trace = owner?.traces[oldest.traceIndex];
    if (owner === undefined || trace === undefined) throw new Error("Execution trace eviction selection became invalid");
    totalBytes -= storedRecordBytes(trace);
    owner.traces.splice(oldest.traceIndex, 1);
    if (owner.traces.length === 0) rings.splice(oldest.ringIndex, 1);
  }
}

async function replaceStoredRings(
  store: IDBObjectStore,
  previous: readonly TraceRingRecord[],
  next: readonly MutableTraceRingRecord[],
): Promise<void> {
  const liveOwners = new Set(next.map((ring) => ring.ownerKeyId));
  const requests: Promise<unknown>[] = [];
  for (const record of previous) {
    if (!liveOwners.has(record.ownerKeyId)) requests.push(requestResult(store.delete(record.ownerKeyId)));
  }
  for (const ring of next) requests.push(requestResult(store.put(ring satisfies TraceRingRecord)));
  await Promise.all(requests);
}

export function isTraceRefShape(value: unknown): value is string {
  return typeof value === "string" && TRACE_REF_PATTERN.test(value);
}

export async function beginExecutionTrace(
  ownerKeyId: string,
  method: string,
  commandSchemaVersion: number,
  effectKind: string,
): Promise<ExecutionTraceDraft> {
  const startedAt = Date.now();
  const startedMonotonic = performance.now();
  const traceRef = await withStrictReadWrite([EXECUTION_TRACE_STORE], async (transaction) => {
    const store = transaction.objectStore(EXECUTION_TRACE_STORE);
    const previous = await requestResult(store.getAll() as IDBRequest<TraceRingRecord[]>);
    const rings = liveRings(previous, startedAt);
    let owner = rings.find((ring) => ring.ownerKeyId === ownerKeyId);
    if (owner === undefined) {
      owner = { ownerKeyId, traces: [] };
      rings.push(owner);
    }
    const traces = owner.traces;
    let candidate: string | null = null;
    let attempt = 0;
    while (attempt < GENERATION_ATTEMPTS) {
      const generated = randomTraceRef();
      if (!traces.some((item) => item.traceRef === generated)) {
        candidate = generated;
        break;
      }
      attempt += 1;
    }
    if (candidate === null) throw new Error("Unable to allocate a unique TraceRef within the bounded attempt limit");
    const record: StoredExecutionTrace = {
      traceRef: candidate,
      traceSchemaVersion: TRACE_SCHEMA_VERSION,
      method,
      commandSchemaVersion,
      startedAt,
      finishedAt: null,
      elapsedMs: null,
      outcome: null,
      errorCode: null,
      ensureStatus: null,
      ensureStage: null,
      effectEntries: 0,
      events: [],
      eventsTruncated: false,
      droppedEventCount: 0,
    };
    while (traces.length >= maximumRecordsPerKey()) traces.shift();
    traces.push(record);
    enforceGlobalBounds(rings, candidate);
    await replaceStoredRings(store, previous, rings);
    return candidate;
  }, { timeoutMs: maximumIoMs() });
  return {
    ownerKeyId,
    traceRef,
    method,
    commandSchemaVersion,
    effectKind,
    startedAt,
    startedMonotonic,
    events: [],
    effectEntries: 0,
    droppedEventCount: 0,
  };
}

export function appendExecutionTraceEvent(draft: ExecutionTraceDraft, event: ExecutionTraceEventInput): void {
  if (event.operation === "effect_entered") draft.effectEntries += 1;
  if (draft.events.length >= maximumEvents()) {
    draft.droppedEventCount += 1;
    return;
  }
  draft.events.push({
    sequence: draft.events.length + draft.droppedEventCount + 1,
    elapsedMs: Math.max(0, Math.round(performance.now() - draft.startedMonotonic)),
    phase: event.phase,
    operation: event.operation,
    status: event.status,
    nodeRef: event.nodeRef ?? null,
    conditionKind: event.conditionKind ?? null,
    attempt: event.attempt ?? null,
  });
}

async function replaceExecutionTraceRecord(
  ownerKeyId: string,
  traceRef: string,
  record: StoredExecutionTrace,
  observedAt: number,
): Promise<void> {
  await withStrictReadWrite([EXECUTION_TRACE_STORE], async (transaction) => {
    const store = transaction.objectStore(EXECUTION_TRACE_STORE);
    const previous = await requestResult(store.getAll() as IDBRequest<TraceRingRecord[]>);
    const rings = liveRings(previous, observedAt);
    const current = rings.find((ring) => ring.ownerKeyId === ownerKeyId);
    if (current === undefined) throw new TraceServiceError();
    const index = current.traces.findIndex((item) => item.traceRef === traceRef);
    if (index < 0) throw new TraceServiceError();
    current.traces[index] = record;
    enforceGlobalBounds(rings, traceRef);
    await replaceStoredRings(store, previous, rings);
  }, { timeoutMs: maximumIoMs() });
}

export async function checkpointExecutionTrace(draft: ExecutionTraceDraft): Promise<void> {
  const checkpointAt = Date.now();
  const checkpoint = boundedStoredRecord({
    traceRef: draft.traceRef,
    traceSchemaVersion: TRACE_SCHEMA_VERSION,
    method: draft.method,
    commandSchemaVersion: draft.commandSchemaVersion,
    startedAt: draft.startedAt,
    finishedAt: null,
    elapsedMs: null,
    outcome: null,
    errorCode: null,
    ensureStatus: null,
    ensureStage: null,
    effectEntries: draft.effectEntries,
    events: draft.events,
    eventsTruncated: draft.droppedEventCount > 0,
    droppedEventCount: draft.droppedEventCount,
  });
  await replaceExecutionTraceRecord(draft.ownerKeyId, draft.traceRef, checkpoint, checkpointAt);
}

export async function finishExecutionTrace(
  draft: ExecutionTraceDraft,
  terminal: TraceTerminal,
): Promise<ExecutionTraceRecord> {
  const finishedAt = Date.now();
  const complete = boundedStoredRecord({
    traceRef: draft.traceRef,
    traceSchemaVersion: TRACE_SCHEMA_VERSION,
    method: draft.method,
    commandSchemaVersion: draft.commandSchemaVersion,
    startedAt: draft.startedAt,
    finishedAt,
    elapsedMs: Math.max(0, finishedAt - draft.startedAt),
    outcome: terminal.outcome,
    errorCode: terminal.errorCode,
    ensureStatus: terminal.ensureStatus,
    ensureStage: terminal.ensureStage,
    effectEntries: draft.effectEntries,
    events: draft.events,
    eventsTruncated: draft.droppedEventCount > 0,
    droppedEventCount: draft.droppedEventCount,
  });
  await replaceExecutionTraceRecord(draft.ownerKeyId, draft.traceRef, complete, finishedAt);
  return publicRecord(complete);
}

export async function readExecutionTrace(ownerKeyId: string, traceRef: string | null): Promise<ExecutionTraceRecord> {
  const cutoff = Date.now() - maximumRetentionMs();
  const record = await withReadOnly([EXECUTION_TRACE_STORE], async (transaction) => {
    const current = await requestResult(
      transaction.objectStore(EXECUTION_TRACE_STORE).get(ownerKeyId) as IDBRequest<TraceRingRecord | undefined>,
    );
    if (current === undefined) return null;
    if (traceRef !== null) return current.traces.find((item) => item.traceRef === traceRef && item.startedAt >= cutoff) ?? null;
    let index = current.traces.length;
    while (index > 0) {
      index -= 1;
      const candidate = current.traces[index];
      if (candidate !== undefined && candidate.startedAt >= cutoff && candidate.method !== "trace.read" && candidate.method !== "trace.export") return candidate;
    }
    return null;
  }, { timeoutMs: maximumIoMs() });
  if (record === null) throw new TraceServiceError();
  return publicRecord(record);
}

export async function exportExecutionTrace(
  ownerKeyId: string,
  traceRef: string | null,
): Promise<{ readonly traceRef: string; readonly artifact: ArtifactMetadata }> {
  const trace = await readExecutionTrace(ownerKeyId, traceRef);
  const artifact = await createTextArtifact(
    ownerKeyId,
    "application/vnd.browser-key-automation.execution-trace+json",
    `${JSON.stringify(trace, null, 2)}\n`,
  );
  return { traceRef: trace.traceRef, artifact };
}
