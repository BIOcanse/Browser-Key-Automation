import { COMMAND_CATALOG } from "../../generated/command-config.js";
import type { PublicKeyRecord } from "../../shared/admin-protocol.js";
import { createTextArtifact } from "../artifact-service.js";
import { BrowserOperationError, exact, integer, text, waitForFeatureReceipt } from "../browser-feature-model.js";
import { requestResult, SEMANTIC_CHUNK_STORE, SEMANTIC_INDEX_STORE, SEMANTIC_MODEL_STORE, withReadOnly, withStrictReadWrite } from "../database.js";
import type { DebuggerDispatch } from "../debugger-service.js";
import { SettingsServiceError } from "../settings-service.js";
import { isTabRefShape } from "../tab-service.js";
import { readSearchSources, searchLimit, type SearchScope, type SearchSource } from "./sources.js";
import { generateEmbeddings, readSemanticConfiguration, semanticLimit, type SemanticConfiguration } from "./semantic-model.js";

type SourceMetadata = Omit<SearchSource, "text">;
type Coverage = Awaited<ReturnType<typeof readSearchSources>>["coverage"];
interface IndexRecord {
  readonly indexId: string; readonly ownerKeyId: string; name: string; scope: SearchScope; revision: number;
  state: "empty" | "stale" | "building" | "ready" | "partial" | "failed" | "interrupted";
  readonly createdAt: number; updatedAt: number; builtAt: number | null; buildId: string | null; generation: string | null;
  configuration: SemanticConfiguration | null; providerModel: string | null;
  sources: readonly SourceMetadata[]; coverage: Coverage | null; vectorCount: number; unindexedTextBytes: number;
  progress: {phase: string; completedChunks: number; totalChunks: number} | null; errorReason: string | null;
}
interface Chunk {readonly indexId: string; readonly generation: string; readonly chunkIndex: number; readonly sourceIndex: number;
  readonly start: number; readonly end: number; readonly text: string; readonly vector: readonly number[];}
interface Operation {readonly ownerKeyId: string;readonly controller: AbortController;
  expiresAt: number;reason: string | null;timer: ReturnType<typeof setTimeout> | null;}
interface Build extends Operation {readonly indexId: string;readonly buildId: string;}
const builds = new Map<string, Build>();
const encoder = new TextEncoder();
const indexShape = (value: unknown): value is string => typeof value === "string" && /^si1\.[a-f0-9-]{36}$/u.test(value);
function validScope(params: Record<string, unknown>): boolean {
  return Array.isArray(params.tabRefs) && params.tabRefs.length > 0 && params.tabRefs.length <= searchLimit("maximum_tabs") &&
    params.tabRefs.every(isTabRefShape) && new Set(params.tabRefs).size === params.tabRefs.length && typeof params.includeFrames === "boolean";
}
export function parseSemanticIndexParams(method: string, params: Record<string, unknown>): boolean {
  if (method === "semantic.index.create" || method === "semantic.index.update") return exact(params, method.endsWith("create") ? ["name", "tabRefs", "includeFrames"] : ["indexId", "expectedRevision", "name", "tabRefs", "includeFrames"]) &&
    text(params.name, semanticLimit("maximum_metadata_bytes"), true) && validScope(params) &&
    (method.endsWith("create") || indexShape(params.indexId) && integer(params.expectedRevision, 1));
  if (method === "semantic.index.list") return exact(params, ["afterIndexId", "limit"]) && (params.afterIndexId === null || indexShape(params.afterIndexId)) && integer(params.limit, 1, semanticLimit("maximum_results"));
  if (method === "semantic.index.get") return exact(params, ["indexId"]) && indexShape(params.indexId);
  if (method === "semantic.index.delete" || method === "semantic.index.build") return exact(params, ["indexId", "expectedRevision"]) && indexShape(params.indexId) && integer(params.expectedRevision, 1);
  if (method === "semantic.search") return exact(params, ["indexId", "query", "limit", "minScore"]) && indexShape(params.indexId) &&
    text(params.query, semanticLimit("maximum_query_bytes")) && integer(params.limit, 1, semanticLimit("maximum_results")) &&
    (params.minScore === null || typeof params.minScore === "number" && Number.isFinite(params.minScore) && params.minScore >= -1 && params.minScore <= 1);
  return false;
}
const scope = (params: Record<string, unknown>): SearchScope => ({tabRefs: [...params.tabRefs as string[]], includeFrames: params.includeFrames as boolean});
const range = (indexId: string, generation?: string) => generation === undefined ? IDBKeyRange.bound([indexId], [indexId, []]) : IDBKeyRange.bound([indexId, generation], [indexId, generation, []]);
async function required(transaction: IDBTransaction, ownerKeyId: string, indexId: string): Promise<IndexRecord> {
  const index = await requestResult(transaction.objectStore(SEMANTIC_INDEX_STORE).get(indexId) as IDBRequest<IndexRecord | undefined>);
  if (!index || index.ownerKeyId !== ownerKeyId) throw new BrowserOperationError("SEMANTIC_INDEX_NOT_FOUND");
  return index;
}
function checkRevision(index: IndexRecord, expectedRevision: number): void {
  if (index.revision !== expectedRevision) throw new SettingsServiceError(expectedRevision, index.revision);
  if (index.revision >= Number.MAX_SAFE_INTEGER - 2) throw new BrowserOperationError("INDEX_REVISION_EXHAUSTED");
  if (index.state === "building") throw new BrowserOperationError("SEMANTIC_INDEX_BUSY");
}
function arm(operation: Operation): void {
  if (operation.timer !== null) clearTimeout(operation.timer);
  operation.timer = setTimeout(() => {operation.reason = "SEMANTIC_DEADLINE"; operation.controller.abort();}, Math.max(0, operation.expiresAt - Date.now()));
}
function startOperation(caller: PublicKeyRecord, timeout: number): Operation {
  const operation: Operation = {ownerKeyId: caller.keyId, controller: new AbortController(), reason: null, timer: null,
    expiresAt: Date.now() + timeout};
  arm(operation); return operation;
}
function active(operation: Operation): void {
  if (operation.controller.signal.aborted || Date.now() >= operation.expiresAt) throw new BrowserOperationError(operation.reason ?? "SEMANTIC_DEADLINE");
}
function finish(operation: Operation): void {
  if (operation.timer !== null) clearTimeout(operation.timer); operation.controller.abort();
}
function bindCancellation(operation: Operation, transaction: IDBTransaction): void {
  const abort = () => {try {transaction.abort();} catch { /* A committed transaction retains its confirmed outcome. */ }};
  const cleanup = () => operation.controller.signal.removeEventListener("abort", abort);
  transaction.addEventListener("complete", cleanup, {once: true}); transaction.addEventListener("abort", cleanup, {once: true});
  operation.controller.signal.addEventListener("abort", abort, {once: true});
  if (operation.controller.signal.aborted) abort(); active(operation);
}
async function initialize(): Promise<void> {
  await withStrictReadWrite([SEMANTIC_INDEX_STORE], async transaction => {
    const store = transaction.objectStore(SEMANTIC_INDEX_STORE), values = await requestResult(store.getAll() as IDBRequest<IndexRecord[]>);
    for (const index of values) if (index.state === "building" && !builds.has(index.indexId)) {
      index.state = "interrupted"; index.errorReason = "BUILD_OWNER_LOST"; index.buildId = null; index.updatedAt = Date.now(); index.revision++;
      await requestResult(store.put(index));
    }
  });
}
function summary(index: IndexRecord, configuration: SemanticConfiguration | null) {
  return {indexId: index.indexId, name: index.name, revision: index.revision, state: index.state, createdAt: index.createdAt, updatedAt: index.updatedAt,
    builtAt: index.builtAt, vectorCount: index.vectorCount, sourceCount: index.sources.length, progress: index.progress, errorReason: index.errorReason,
    configurationRevision: index.configuration?.revision ?? null, requiresRebuild: index.configuration === null || configuration?.revision !== index.configuration.revision || !["ready", "partial"].includes(index.state)};
}
async function present(owner: string, result: Record<string, unknown>, content: readonly string[]) {
  const complete = {...result, artifact: null}, body = JSON.stringify(complete);
  if (encoder.encode(body).byteLength <= COMMAND_CATALOG.limits["command.inline.maximum_result_json_bytes"] / 2) return complete;
  const artifact = await createTextArtifact(owner, "application/json", body), inline: Record<string, unknown> = {...result, artifact};
  for (const key of content) inline[key] = null;
  return inline;
}
async function getIndex(owner: string, indexId: string) {return withReadOnly([SEMANTIC_INDEX_STORE], transaction => required(transaction, owner, indexId));}
async function progress(build: Build, phase: string, completedChunks: number, totalChunks: number): Promise<void> {
  await withStrictReadWrite([SEMANTIC_INDEX_STORE], async transaction => {
    bindCancellation(build, transaction);
    const index = await required(transaction, build.ownerKeyId, build.indexId);
    if (index.buildId !== build.buildId || index.state !== "building") throw new BrowserOperationError("SEMANTIC_BUILD_CHANGED");
    index.progress = {phase, completedChunks, totalChunks}; index.updatedAt = Date.now();
    await requestResult(transaction.objectStore(SEMANTIC_INDEX_STORE).put(index));
  });
}

export function splitSemanticText(value: string, maximumBytes: number, maximumChunks: number): {parts: {start: number;end: number;text: string}[];bytes: number} {
  const parts: {start: number;end: number;text: string}[] = [];
  if (maximumBytes <= 0 || maximumChunks <= 0) return {parts, bytes: 0};
  let start = 0, end = 0, bytes = 0, currentBytes = 0;
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (size > maximumBytes) break;
    if (currentBytes + size > maximumBytes) {
      parts.push({start, end, text: value.slice(start, end)}); bytes += currentBytes;
      if (parts.length === maximumChunks) return {parts, bytes};
      start = end; currentBytes = 0;
    }
    currentBytes += size; end += character.length;
  }
  if (end > start && parts.length < maximumChunks) {parts.push({start, end, text: value.slice(start, end)}); bytes += currentBytes;}
  return {parts, bytes};
}

async function buildIndex(caller: PublicKeyRecord, indexId: string, expectedRevision: number, dispatch: DebuggerDispatch) {
  await getIndex(caller.keyId, indexId);
  if (builds.has(indexId)) throw new BrowserOperationError("SEMANTIC_INDEX_BUSY");
  const operation = startOperation(caller, semanticLimit("build_timeout_ms"));
  const build = Object.assign(operation, {indexId, buildId: crypto.randomUUID()});
  builds.set(indexId, build);
  const gate: DebuggerDispatch = effect => dispatch(async () => {active(build); return effect();});
  let started = false, committed: IndexRecord | null = null;
  try {
    active(build);
    const configuration = await readSemanticConfiguration(caller.keyId);
    if (!configuration) throw new BrowserOperationError("SEMANTIC_MODEL_NOT_CONFIGURED");
    const initial = await gate(() => withStrictReadWrite([SEMANTIC_INDEX_STORE], async transaction => {
    bindCancellation(build, transaction);
    const index = await required(transaction, caller.keyId, indexId); checkRevision(index, expectedRevision);
    active(build); index.state = "building"; index.buildId = build.buildId; index.revision++; index.updatedAt = Date.now(); index.progress = {phase: "reading", completedChunks: 0, totalChunks: 0}; index.errorReason = null;
    await requestResult(transaction.objectStore(SEMANTIC_INDEX_STORE).put(index)); return index;
    }));
    started = true;
    const snapshot = await waitForFeatureReceipt(readSearchSources(initial.scope, gate), Math.max(0, build.expiresAt - Date.now()), "SEMANTIC_DEADLINE", build.controller.signal); active(build);
    const chunks: Chunk[] = [], sources: SourceMetadata[] = [];
    let indexedBytes = 0, capturedBytes = 0, storedBytes = 0;
    for (const source of snapshot.sources) {
      const {text: sourceText, ...metadata} = source, sourceIndex = sources.length; sources.push(metadata); capturedBytes += source.textBytes;
      const remaining = semanticLimit("maximum_chunks") - chunks.length;
      if (remaining <= 0) continue;
      const split = splitSemanticText(sourceText, Math.min(semanticLimit("chunk_bytes"), semanticLimit("maximum_input_bytes") - encoder.encode(configuration.documentPrefix).byteLength), remaining);
      indexedBytes += split.bytes;
      for (const part of split.parts) chunks.push({indexId, generation: build.buildId, chunkIndex: chunks.length, sourceIndex, ...part, vector: []});
    }
    await progress(build, "embedding", 0, chunks.length);
    let providerModel: string | null = null;
    for (let offset = 0; offset < chunks.length; offset += semanticLimit("maximum_batch_size")) {
      active(build); const batch = chunks.slice(offset, offset + semanticLimit("maximum_batch_size"));
      const embedded = await generateEmbeddings(configuration, batch.map(chunk => chunk.text), "document", gate, build.controller.signal); active(build);
      providerModel = embedded.model;
      for (let index = 0; index < batch.length; index++) {
        const current = {...batch[index]!, vector: embedded.vectors[index]!}; chunks[offset + index] = current;
        storedBytes += encoder.encode(JSON.stringify(current)).byteLength;
        if (storedBytes > semanticLimit("maximum_index_bytes")) throw new BrowserOperationError("SEMANTIC_INDEX_BYTE_LIMIT");
      }
      await progress(build, "embedding", offset + batch.length, chunks.length);
    }
    active(build); await progress(build, "committing", chunks.length, chunks.length);
    const completed = await gate(() => withStrictReadWrite([SEMANTIC_INDEX_STORE, SEMANTIC_CHUNK_STORE, SEMANTIC_MODEL_STORE], async transaction => {
      bindCancellation(build, transaction);
      const index = await required(transaction, caller.keyId, indexId);
      const currentConfiguration = await requestResult(transaction.objectStore(SEMANTIC_MODEL_STORE).get(caller.keyId) as IDBRequest<SemanticConfiguration | undefined>);
      if (index.buildId !== build.buildId || index.state !== "building") throw new BrowserOperationError("SEMANTIC_BUILD_CHANGED");
      if (currentConfiguration?.revision !== configuration.revision) throw new BrowserOperationError("SEMANTIC_CONFIGURATION_CHANGED");
      active(build); const store = transaction.objectStore(SEMANTIC_CHUNK_STORE); await requestResult(store.delete(range(indexId)));
      for (const chunk of chunks) await requestResult(store.add(chunk));
      index.state = snapshot.coverage.complete && indexedBytes === capturedBytes ? "ready" : "partial";
      index.sources = sources; index.coverage = snapshot.coverage; index.configuration = configuration; index.providerModel = providerModel;
      index.vectorCount = chunks.length; index.unindexedTextBytes = capturedBytes - indexedBytes; index.generation = build.buildId;
      index.buildId = null; index.progress = null; index.errorReason = null; index.revision++; index.builtAt = Date.now(); index.updatedAt = index.builtAt;
      if (storedBytes + encoder.encode(JSON.stringify(index)).byteLength > semanticLimit("maximum_index_bytes")) throw new BrowserOperationError("SEMANTIC_INDEX_BYTE_LIMIT");
      active(build); await requestResult(transaction.objectStore(SEMANTIC_INDEX_STORE).put(index)); return index;
    }));
    committed = completed;
    return await gate(() => present(caller.keyId, {index: {...summary(completed, configuration), scope: completed.scope, coverage: completed.coverage, unindexedTextBytes: completed.unindexedTextBytes}}, ["index"]));
  } catch (error) {
    build.controller.abort();
    if (!started) throw error;
    const reason = build.reason ?? (error instanceof BrowserOperationError ? error.details.reason : "SEMANTIC_BUILD_FAILED");
    if (committed) throw new BrowserOperationError(reason, true, {indexId, revision: committed.revision, apiCompleted: true, state: committed.state});
    let stateSaved = false;
    try {stateSaved = await withStrictReadWrite([SEMANTIC_INDEX_STORE], async transaction => {
      const index = await required(transaction, caller.keyId, indexId);
      if (index.buildId !== build.buildId || index.state !== "building") return false;
      index.state = build.reason ? "interrupted" : "failed"; index.errorReason = reason; index.buildId = null; index.updatedAt = Date.now(); index.revision++;
      await requestResult(transaction.objectStore(SEMANTIC_INDEX_STORE).put(index)); return true;
    });} catch { /* Report that the durable terminal state could not be confirmed. */ }
    throw new BrowserOperationError(reason, true, {indexId, buildId: build.buildId, stateSaved});
  } finally {finish(build); builds.delete(indexId);}
}

export async function runSemanticIndex(caller: PublicKeyRecord, method: string, params: Record<string, unknown>, dispatch: DebuggerDispatch): Promise<unknown> {
  await initialize();
  const owner = caller.keyId, indexId = params.indexId as string;
  if (method === "semantic.index.create") {
    const index = await dispatch(() => withStrictReadWrite([SEMANTIC_INDEX_STORE], async transaction => {
      const store = transaction.objectStore(SEMANTIC_INDEX_STORE), existing = await requestResult(store.getAll() as IDBRequest<IndexRecord[]>);
      if (existing.length >= semanticLimit("maximum_indexes") || existing.filter(value => value.ownerKeyId === owner).length >= semanticLimit("maximum_indexes_per_key")) throw new BrowserOperationError("SEMANTIC_INDEX_LIMIT");
      const now = Date.now(), created: IndexRecord = {indexId: `si1.${crypto.randomUUID()}`, ownerKeyId: owner, name: params.name as string, scope: scope(params), revision: 1, state: "empty",
        createdAt: now, updatedAt: now, builtAt: null, buildId: null, generation: null, configuration: null, providerModel: null, sources: [], coverage: null, vectorCount: 0, unindexedTextBytes: 0, progress: null, errorReason: null};
      await requestResult(store.add(created)); return created;
    }));
    return {index: summary(index, null)};
  }
  if (method === "semantic.index.list") {
    const values = await withReadOnly([SEMANTIC_INDEX_STORE], transaction => requestResult(transaction.objectStore(SEMANTIC_INDEX_STORE).getAll() as IDBRequest<IndexRecord[]>));
    const selected = values.filter(index => index.ownerKeyId === owner && (params.afterIndexId === null || index.indexId > String(params.afterIndexId))).sort((a, b) => a.indexId < b.indexId ? -1 : 1);
    const configuration = await readSemanticConfiguration(owner), page = selected.slice(0, Number(params.limit));
    return dispatch(() => present(owner, {items: page.map(index => summary(index, configuration)), nextIndexId: selected.length > page.length ? page.at(-1)!.indexId : null}, ["items"]));
  }
  if (method === "semantic.index.get") {
    const index = await getIndex(owner, indexId), configuration = await readSemanticConfiguration(owner);
    return dispatch(() => present(owner, {index: {...summary(index, configuration), scope: index.scope, configuration: index.configuration, providerModel: index.providerModel,
      sources: index.sources, coverage: index.coverage, unindexedTextBytes: index.unindexedTextBytes, freshness: "indexed_snapshot"}}, ["index"]));
  }
  if (method === "semantic.index.build") return buildIndex(caller, indexId, params.expectedRevision as number, dispatch);
  if (method === "semantic.index.update" || method === "semantic.index.delete") {
    const configuration = await readSemanticConfiguration(owner);
    const index = await dispatch(() => withStrictReadWrite([SEMANTIC_INDEX_STORE, SEMANTIC_CHUNK_STORE], async transaction => {
      const index = await required(transaction, owner, indexId); checkRevision(index, params.expectedRevision as number);
      if (method === "semantic.index.delete") {await requestResult(transaction.objectStore(SEMANTIC_CHUNK_STORE).delete(range(indexId))); await requestResult(transaction.objectStore(SEMANTIC_INDEX_STORE).delete(indexId)); return index;}
      const nextScope = scope(params); if (JSON.stringify(index.scope) !== JSON.stringify(nextScope)) index.state = "stale";
      index.scope = nextScope; index.name = params.name as string; index.updatedAt = Date.now(); index.revision++;
      await requestResult(transaction.objectStore(SEMANTIC_INDEX_STORE).put(index)); return index;
    }));
    return method === "semantic.index.delete" ? {indexId, deleted: true} : {index: summary(index, configuration)};
  }
  if (method !== "semantic.search") throw new BrowserOperationError("UNKNOWN_SEMANTIC_COMMAND");
  const operation = startOperation(caller, semanticLimit("request_timeout_ms"));
  const gate: DebuggerDispatch = effect => dispatch(async () => {active(operation); return effect();});
  try {
  active(operation);
  const snapshot = await withReadOnly([SEMANTIC_INDEX_STORE, SEMANTIC_CHUNK_STORE, SEMANTIC_MODEL_STORE], async transaction => {
    const index = await required(transaction, owner, indexId);
    const configuration = await requestResult(transaction.objectStore(SEMANTIC_MODEL_STORE).get(owner) as IDBRequest<SemanticConfiguration | undefined>);
    if (!configuration || !index.configuration || configuration.revision !== index.configuration.revision) throw new BrowserOperationError("SEMANTIC_INDEX_REBUILD_REQUIRED");
    if (!["ready", "partial"].includes(index.state) || index.generation === null) throw new BrowserOperationError("SEMANTIC_INDEX_NOT_READY");
    const chunks = await requestResult(transaction.objectStore(SEMANTIC_CHUNK_STORE).getAll(range(indexId, index.generation)) as IDBRequest<Chunk[]>);
    if (chunks.length !== index.vectorCount) throw new BrowserOperationError("SEMANTIC_INDEX_INCOMPLETE");
    return {index, configuration, chunks};
  });
  const embedded = await generateEmbeddings(snapshot.configuration, [params.query as string], "query", gate, operation.controller.signal); active(operation);
  const vector = embedded.vectors[0]!, scored = [];
  for (const chunk of snapshot.chunks) {
    if (chunk.vector.length !== vector.length) throw new BrowserOperationError("SEMANTIC_INDEX_DIMENSION_MISMATCH");
    if (!integer(chunk.sourceIndex, 0, snapshot.index.sources.length - 1) || chunk.vector.some(value => !Number.isFinite(value))) throw new BrowserOperationError("SEMANTIC_INDEX_INCOMPLETE");
    let score = 0; for (let index = 0; index < vector.length; index++) score += vector[index]! * chunk.vector[index]!;
    score = Math.min(1, Math.max(-1, score));
    if (score >= (params.minScore === null ? -1 : Number(params.minScore))) scored.push({chunk, score});
  }
  scored.sort((a, b) => b.score - a.score || a.chunk.chunkIndex - b.chunk.chunkIndex);
  const items = scored.slice(0, Number(params.limit)).map(({chunk, score}) => ({score, text: chunk.text, start: chunk.start, end: chunk.end, offsetUnit: "utf16_code_unit", source: snapshot.index.sources[chunk.sourceIndex]}));
  return await gate(async () => {
    const current = await getIndex(owner, indexId), configuration = await readSemanticConfiguration(owner);
    if (current.revision !== snapshot.index.revision || configuration?.revision !== snapshot.configuration.revision) throw new BrowserOperationError("SEMANTIC_INDEX_CHANGED");
    active(operation); return present(owner, {indexId, revision: snapshot.index.revision, items, mode: "semantic", metric: "cosine_similarity", freshness: "indexed_snapshot",
      scoredChunks: snapshot.chunks.length, matchingChunks: scored.length, resultsTruncated: scored.length > items.length,
      coverage: snapshot.index.coverage, unindexedTextBytes: snapshot.index.unindexedTextBytes}, ["items", "coverage"]);
  });
  } catch (error) {if (operation.reason) throw new BrowserOperationError(operation.reason); throw error;}
  finally {finish(operation);}
}
