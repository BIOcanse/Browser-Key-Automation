import { BrowserOperationError, exact, featureLimit, integer, object, text, waitForFeatureReceipt } from "../browser-feature-model.js";
import { requestResult, SEMANTIC_MODEL_STORE, withReadOnly, withStrictReadWrite } from "../database.js";
import type { DebuggerDispatch } from "../debugger-service.js";
import { SettingsServiceError } from "../settings-service.js";

export const semanticLimit = (name: string): number => featureLimit(`command.semantic.${name}`);
export interface SemanticConfiguration {
  readonly revision: number; readonly endpoint: string; readonly model: string; readonly modelVersion: string;
  readonly dimensions: number; readonly documentPrefix: string; readonly queryPrefix: string; readonly updatedAt: number;
}
interface StoredConfiguration extends SemanticConfiguration {readonly ownerKeyId: string;}

function localEndpoint(value: unknown): value is string {
  if (!text(value, semanticLimit("maximum_metadata_bytes"))) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
export function parseSemanticModelParams(method: string, params: Record<string, unknown>): boolean {
  if (method === "semantic.model.get") return exact(params, []);
  return method === "semantic.model.configure" && exact(params, ["expectedRevision", "endpoint", "model", "modelVersion", "dimensions", "documentPrefix", "queryPrefix"]) &&
    integer(params.expectedRevision) && localEndpoint(params.endpoint) && text(params.model, semanticLimit("maximum_metadata_bytes")) &&
    text(params.modelVersion, semanticLimit("maximum_metadata_bytes"), true) && integer(params.dimensions, 1, semanticLimit("maximum_dimensions")) &&
    text(params.documentPrefix, semanticLimit("maximum_prefix_bytes"), true) && text(params.queryPrefix, semanticLimit("maximum_prefix_bytes"), true);
}
export async function readSemanticConfiguration(ownerKeyId: string): Promise<SemanticConfiguration | null> {
  const stored = await withReadOnly([SEMANTIC_MODEL_STORE], transaction => requestResult(transaction.objectStore(SEMANTIC_MODEL_STORE).get(ownerKeyId) as IDBRequest<StoredConfiguration | undefined>));
  if (!stored) return null;
  const {ownerKeyId: _owner, ...configuration} = stored;
  return configuration;
}
export async function configureSemanticModel(ownerKeyId: string, params: Record<string, unknown>): Promise<SemanticConfiguration> {
  return withStrictReadWrite([SEMANTIC_MODEL_STORE], async transaction => {
    const store = transaction.objectStore(SEMANTIC_MODEL_STORE);
    const current = await requestResult(store.get(ownerKeyId) as IDBRequest<StoredConfiguration | undefined>);
    const revision = current?.revision ?? 0;
    if (revision !== params.expectedRevision) throw new SettingsServiceError(params.expectedRevision as number, revision);
    if (revision === Number.MAX_SAFE_INTEGER) throw new BrowserOperationError("MODEL_REVISION_EXHAUSTED");
    const configuration: SemanticConfiguration = { revision: revision + 1, endpoint: new URL(params.endpoint as string).href,
      model: params.model as string, modelVersion: params.modelVersion as string, dimensions: params.dimensions as number,
      documentPrefix: params.documentPrefix as string, queryPrefix: params.queryPrefix as string, updatedAt: Date.now() };
    await requestResult(store.put({ownerKeyId, ...configuration}));
    return configuration;
  });
}

/** Unit vectors make the cosine calculation explicit; malformed or zero vectors are rejected. */
export function normalizedEmbedding(value: unknown, dimensions: number): readonly number[] {
  if (!Array.isArray(value) || value.length !== dimensions || value.some(item => typeof item !== "number" || !Number.isFinite(item))) throw new BrowserOperationError("INVALID_EMBEDDING_VECTOR");
  let squared = 0;
  for (const item of value) squared += item * item;
  const norm = Math.sqrt(squared);
  if (!Number.isFinite(norm) || norm === 0) throw new BrowserOperationError("INVALID_EMBEDDING_VECTOR");
  return value.map(item => item / norm);
}
export async function generateEmbeddings(configuration: SemanticConfiguration, inputs: readonly string[], kind: "document" | "query", dispatch: DebuggerDispatch, signal?: AbortSignal) {
  const prefix = kind === "document" ? configuration.documentPrefix : configuration.queryPrefix;
  const prepared = inputs.map(value => prefix + value);
  if (prepared.length === 0 || prepared.length > semanticLimit("maximum_batch_size") ||
    prepared.some(value => !text(value, semanticLimit("maximum_input_bytes")))) throw new BrowserOperationError("EMBEDDING_INPUT_LIMIT");
  if (!localEndpoint(configuration.endpoint)) throw new BrowserOperationError("INVALID_EMBEDDING_ENDPOINT");
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener("abort", abort, {once: true}); if (signal?.aborted) controller.abort();
  let launched = false;
  try {
    const receipt = dispatch(async () => {
      if (controller.signal.aborted) throw new BrowserOperationError("EMBEDDING_INTERRUPTED");
      launched = true;
      const response = await fetch(configuration.endpoint, {method: "POST", headers: {"content-type": "application/json"}, credentials: "omit",
        redirect: "error", cache: "no-store", signal: controller.signal,
        body: JSON.stringify({model: configuration.model, input: prepared, encoding_format: "float"})});
      if (!response.ok) throw new BrowserOperationError("EMBEDDING_HTTP_FAILED", true, {status: response.status});
      const maximumBytes = semanticLimit("maximum_response_bytes");
      if (Number(response.headers.get("content-length")) > maximumBytes || !response.body) throw new BrowserOperationError("EMBEDDING_RESPONSE_LIMIT", true);
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          length += part.value.byteLength;
          if (length > maximumBytes) throw new BrowserOperationError("EMBEDDING_RESPONSE_LIMIT", true);
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
      let parsed: unknown;
      try {parsed = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));}
      catch {throw new BrowserOperationError("INVALID_EMBEDDING_RESPONSE", true);}
      if (!object(parsed) || parsed.model !== configuration.model || !Array.isArray(parsed.data) || parsed.data.length !== inputs.length) throw new BrowserOperationError("EMBEDDING_MODEL_OR_COUNT_MISMATCH", true);
      const vectors: (readonly number[] | undefined)[] = Array.from({length: inputs.length});
      for (const entry of parsed.data) {
        if (!object(entry) || !integer(entry.index, 0, inputs.length - 1) || vectors[entry.index] !== undefined) throw new BrowserOperationError("EMBEDDING_INDEX_MISMATCH", true);
        vectors[entry.index] = normalizedEmbedding(entry.embedding, configuration.dimensions);
      }
      if (vectors.some(vector => vector === undefined)) throw new BrowserOperationError("EMBEDDING_INDEX_MISMATCH", true);
      return {vectors: vectors as readonly (readonly number[])[], model: parsed.model};
    });
    return await waitForFeatureReceipt(receipt, semanticLimit("request_timeout_ms"), "EMBEDDING_TIMEOUT", signal);
  } catch (error) {
    if (!launched || error instanceof BrowserOperationError) throw error;
    throw new BrowserOperationError(controller.signal.aborted ? "EMBEDDING_INTERRUPTED" : "EMBEDDING_REQUEST_FAILED", true);
  } finally {controller.abort(); signal?.removeEventListener("abort", abort);}
}
