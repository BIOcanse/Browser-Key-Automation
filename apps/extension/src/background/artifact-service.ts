import { COMMAND_CATALOG } from "../generated/command-config.js";
import {
  ARTIFACT_CHUNK_STORE,
  ARTIFACT_STORE,
  requestResult,
  SETTINGS_STORE,
  withStrictReadWrite,
} from "./database.js";
import { defaultRuntimeSettings, getRuntimeSettings, type RuntimeSettings } from "./settings-service.js";

const ARTIFACT_REF_PATTERN = /^ar1\.[A-Za-z0-9_-]{43}$/u;
const GENERATION_ATTEMPTS = 8;

export interface ArtifactMetadata {
  readonly artifactRef: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface ArtifactRecord extends ArtifactMetadata {
  readonly ownerKeyId: string;
  readonly chunkCount?: number;
  readonly bytes?: ArrayBuffer | Blob;
  // Present only while receiving an upload. Reserved byteLength counts toward
  // the existing quota; reads cannot observe a body before verified completion.
  readonly receivedBytes?: number;
}

interface ArtifactChunkRecord {
  readonly chunkKey: string;
  readonly artifactRef: string;
  readonly chunkIndex: number;
  readonly bytes: ArrayBuffer;
}

export interface ArtifactReadResult extends ArtifactMetadata {
  readonly offset: number;
  readonly dataBase64Url: string;
  readonly nextOffset: number | null;
}

export class ArtifactServiceError extends Error {
  readonly code: "ARTIFACT_NOT_FOUND" | "LIMIT_EXCEEDED" | "ARTIFACT_UPLOAD_INVALID";
  readonly details?: { readonly reason: string };

  constructor(code: ArtifactServiceError["code"], message: string, reason?: string) {
    super(message);
    this.name = "ArtifactServiceError";
    this.code = code;
    if (reason !== undefined) this.details = { reason };
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  let index = 0;
  while (index < bytes.byteLength) {
    binary += String.fromCharCode(bytes[index] ?? 0);
    index += 1;
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function randomArtifactRef(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `ar1.${base64Url(bytes)}`;
}

function artifactChunkBytes(): number {
  return COMMAND_CATALOG.limits["build.artifact.chunk_bytes"];
}

function chunkKey(artifactRef: string, chunkIndex: number): string {
  return `${artifactRef}.${chunkIndex.toString().padStart(6, "0")}`;
}

function deleteChunkRecordsWithoutWaiting(transaction: IDBTransaction, record: ArtifactRecord): void {
  const chunkCount = record.chunkCount ?? 0;
  const store = transaction.objectStore(ARTIFACT_CHUNK_STORE);
  let chunkIndex = 0;
  while (chunkIndex < chunkCount) {
    store.delete(chunkKey(record.artifactRef, chunkIndex));
    chunkIndex += 1;
  }
}

async function deleteChunkRecords(transaction: IDBTransaction, record: ArtifactRecord): Promise<void> {
  const chunkCount = record.chunkCount ?? 0;
  const store = transaction.objectStore(ARTIFACT_CHUNK_STORE);
  let chunkIndex = 0;
  while (chunkIndex < chunkCount) {
    await requestResult(store.delete(chunkKey(record.artifactRef, chunkIndex)));
    chunkIndex += 1;
  }
}

function metadata(record: ArtifactMetadata): ArtifactMetadata {
  return {
    artifactRef: record.artifactRef,
    mediaType: record.mediaType,
    byteLength: record.byteLength,
    sha256: record.sha256,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

function digestHex(buffer: ArrayBuffer): Promise<string> {
  return crypto.subtle.digest("SHA-256", buffer).then((digest) => {
    const bytes = new Uint8Array(digest);
    let output = "";
    let index = 0;
    while (index < bytes.length) {
      output += (bytes[index] ?? 0).toString(16).padStart(2, "0");
      index += 1;
    }
    return output;
  });
}

async function inventoryAndExpire(
  transaction: IDBTransaction,
  now: number,
): Promise<{ readonly count: number; readonly totalBytes: number }> {
  const store = transaction.objectStore(ARTIFACT_STORE);
  const request = store.openCursor();
  return new Promise((resolve, reject) => {
    let count = 0;
    let totalBytes = 0;
    request.addEventListener("error", () => reject(request.error ?? new Error("Artifact cursor failed")), { once: true });
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (cursor === null) {
        resolve({ count, totalBytes });
        return;
      }
      const record = cursor.value as ArtifactRecord;
      if (record.expiresAt <= now) {
        cursor.delete();
        deleteChunkRecordsWithoutWaiting(transaction, record);
      }
      else {
        count += 1;
        totalBytes += record.byteLength;
      }
      cursor.continue();
    });
  });
}

async function currentSettingsInTransaction(transaction: IDBTransaction): Promise<RuntimeSettings> {
  const stored = await requestResult(
    transaction.objectStore(SETTINGS_STORE).get("settings.v1") as IDBRequest<(RuntimeSettings & { settingsId: string }) | undefined>,
  );
  return stored ?? defaultRuntimeSettings();
}

export function isArtifactRefShape(value: unknown): value is string {
  return typeof value === "string" && ARTIFACT_REF_PATTERN.test(value);
}

export async function createArtifact(ownerKeyId: string, mediaType: string, bytes: Blob): Promise<ArtifactMetadata> {
  const initialSettings = await getRuntimeSettings();
  if (
    bytes.size > COMMAND_CATALOG.limits["build.artifact.hard_maximum_bytes"] ||
    bytes.size > initialSettings.artifactMaximumBytes
  ) {
    throw new ArtifactServiceError("LIMIT_EXCEEDED", "Artifact exceeded the configured per-artifact byte limit");
  }
  const buffer = await bytes.arrayBuffer();
  const sha256 = await digestHex(buffer);
  const byteLength = buffer.byteLength;
  const chunkBytes = artifactChunkBytes();
  const chunkCount = Math.ceil(byteLength / chunkBytes);
  let attempt = 0;
  while (attempt < GENERATION_ATTEMPTS) {
    const artifactRef = randomArtifactRef();
    const result = await withStrictReadWrite(
      [ARTIFACT_CHUNK_STORE, ARTIFACT_STORE, SETTINGS_STORE],
      async (transaction): Promise<ArtifactMetadata | null> => {
        const settings = await currentSettingsInTransaction(transaction);
        if (byteLength > settings.artifactMaximumBytes) {
          throw new ArtifactServiceError("LIMIT_EXCEEDED", "Artifact exceeded the configured per-artifact byte limit");
        }
        const now = Date.now();
        const inventory = await inventoryAndExpire(transaction, now);
        if (
          inventory.count >= settings.artifactMaximumCount ||
          inventory.totalBytes + byteLength > settings.artifactMaximumTotalBytes
        ) {
          throw new ArtifactServiceError("LIMIT_EXCEEDED", "Artifact storage capacity is exhausted");
        }
        const store = transaction.objectStore(ARTIFACT_STORE);
        const existing = await requestResult(store.get(artifactRef) as IDBRequest<ArtifactRecord | undefined>);
        if (existing !== undefined) return null;
        const record: ArtifactRecord = {
          artifactRef,
          ownerKeyId,
          mediaType,
          byteLength,
          sha256,
          createdAt: now,
          expiresAt: now + settings.artifactRetentionMs,
          chunkCount,
        };
        await requestResult(store.add(record));
        const chunkStore = transaction.objectStore(ARTIFACT_CHUNK_STORE);
        let chunkIndex = 0;
        while (chunkIndex < chunkCount) {
          const start = chunkIndex * chunkBytes;
          const chunk: ArtifactChunkRecord = {
            chunkKey: chunkKey(artifactRef, chunkIndex),
            artifactRef,
            chunkIndex,
            bytes: buffer.slice(start, Math.min(byteLength, start + chunkBytes)),
          };
          await requestResult(chunkStore.add(chunk));
          chunkIndex += 1;
        }
        return metadata(record);
      },
    );
    if (result !== null) return result;
    attempt += 1;
  }
  throw new Error("Unable to allocate a unique ArtifactRef within the bounded attempt limit");
}

export function createTextArtifact(ownerKeyId: string, mediaType: string, text: string): Promise<ArtifactMetadata> {
  return createArtifact(ownerKeyId, mediaType, new Blob([text], { type: mediaType }));
}

export async function readArtifact(
  ownerKeyId: string,
  artifactRef: string,
  offset: number,
  maximumBytes: number,
): Promise<ArtifactReadResult> {
  const limit = COMMAND_CATALOG.limits["command.artifact.read.maximum_raw_bytes"];
  const snapshot = await withStrictReadWrite([ARTIFACT_CHUNK_STORE, ARTIFACT_STORE], async (transaction) => {
    const store = transaction.objectStore(ARTIFACT_STORE);
    const current = await requestResult(store.get(artifactRef) as IDBRequest<ArtifactRecord | undefined>);
    if (current === undefined || current.ownerKeyId !== ownerKeyId) return null;
    if (current.expiresAt <= Date.now()) {
      await requestResult(store.delete(artifactRef));
      await deleteChunkRecords(transaction, current);
      return null;
    }
    if (current.receivedBytes !== undefined) return null;
    if (offset > current.byteLength) {
      throw new ArtifactServiceError("ARTIFACT_NOT_FOUND", "Artifact read offset is outside the committed body");
    }
    const end = Math.min(current.byteLength, offset + Math.min(maximumBytes, limit));
    if (current.bytes !== undefined || end === offset) return { record: current, chunks: [] as ArtifactChunkRecord[], end };
    const committedChunkCount = current.chunkCount;
    if (typeof committedChunkCount !== "number" || !Number.isSafeInteger(committedChunkCount) || committedChunkCount < 0) {
      throw new Error("Artifact metadata has no readable body projection");
    }
    const chunkBytes = artifactChunkBytes();
    const firstChunk = Math.floor(offset / chunkBytes);
    const lastChunkExclusive = Math.ceil(end / chunkBytes);
    if (lastChunkExclusive > committedChunkCount) {
      throw new Error("Artifact metadata chunk count is inconsistent with its byte length");
    }
    const chunkStore = transaction.objectStore(ARTIFACT_CHUNK_STORE);
    const chunks: ArtifactChunkRecord[] = [];
    let chunkIndex = firstChunk;
    while (chunkIndex < lastChunkExclusive) {
      const chunk = await requestResult(
        chunkStore.get(chunkKey(artifactRef, chunkIndex)) as IDBRequest<ArtifactChunkRecord | undefined>,
      );
      if (
        chunk === undefined ||
        chunk.artifactRef !== artifactRef ||
        chunk.chunkIndex !== chunkIndex ||
        !(chunk.bytes instanceof ArrayBuffer)
      ) {
        throw new Error("Artifact chunk projection is missing or invalid");
      }
      chunks.push(chunk);
      chunkIndex += 1;
    }
    return { record: current, chunks, end };
  });
  if (snapshot === null) {
    throw new ArtifactServiceError("ARTIFACT_NOT_FOUND", "Artifact is unavailable to this Key");
  }
  const record = snapshot.record;
  let data: Uint8Array;
  if (record.bytes instanceof Blob) {
    data = new Uint8Array(await record.bytes.slice(offset, snapshot.end).arrayBuffer());
  } else if (record.bytes instanceof ArrayBuffer) {
    data = new Uint8Array(record.bytes.slice(offset, snapshot.end));
  } else {
    data = new Uint8Array(snapshot.end - offset);
    const chunkBytes = artifactChunkBytes();
    for (const chunk of snapshot.chunks) {
      const chunkStart = chunk.chunkIndex * chunkBytes;
      const sourceStart = Math.max(0, offset - chunkStart);
      const sourceEnd = Math.min(chunk.bytes.byteLength, snapshot.end - chunkStart);
      if (sourceEnd > sourceStart) {
        data.set(
          new Uint8Array(chunk.bytes, sourceStart, sourceEnd - sourceStart),
          (chunkStart + sourceStart) - offset,
        );
      }
    }
  }
  return {
    ...metadata(record),
    offset,
    dataBase64Url: base64Url(data),
    nextOffset: snapshot.end < record.byteLength ? snapshot.end : null,
  };
}

export async function releaseArtifact(ownerKeyId: string, artifactRef: string): Promise<{ readonly released: boolean }> {
  return withStrictReadWrite([ARTIFACT_CHUNK_STORE, ARTIFACT_STORE], async (transaction) => {
    const store = transaction.objectStore(ARTIFACT_STORE);
    const current = await requestResult(store.get(artifactRef) as IDBRequest<ArtifactRecord | undefined>);
    if (current === undefined || current.ownerKeyId !== ownerKeyId) return { released: false };
    await requestResult(store.delete(artifactRef));
    await deleteChunkRecords(transaction, current);
    return { released: true };
  });
}

export async function getArtifactMetadata(ownerKeyId: string, artifactRef: string): Promise<ArtifactMetadata> {
  return metadata(await readArtifact(ownerKeyId, artifactRef, 0, 1));
}

function invalidUpload(reason: string): ArtifactServiceError {
  return new ArtifactServiceError("ARTIFACT_UPLOAD_INVALID", "The upload cannot perform this transition", reason);
}

export async function beginArtifactUpload(ownerKeyId: string, byteLength: number, mediaType: "text/html") {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > COMMAND_CATALOG.limits["build.artifact.hard_maximum_bytes"]) {
    throw new ArtifactServiceError("LIMIT_EXCEEDED", "Upload exceeds the Artifact hard size limit");
  }
  let attempt = 0;
  while (attempt < GENERATION_ATTEMPTS) {
    const artifactRef = randomArtifactRef();
    const result = await withStrictReadWrite([ARTIFACT_CHUNK_STORE, ARTIFACT_STORE, SETTINGS_STORE], async (transaction) => {
      const settings = await currentSettingsInTransaction(transaction);
      const now = Date.now();
      const inventory = await inventoryAndExpire(transaction, now);
      if (byteLength > settings.artifactMaximumBytes || inventory.count >= settings.artifactMaximumCount ||
          inventory.totalBytes + byteLength > settings.artifactMaximumTotalBytes) {
        throw new ArtifactServiceError("LIMIT_EXCEEDED", "Upload exceeds the current Artifact capacity");
      }
      const store = transaction.objectStore(ARTIFACT_STORE);
      if (await requestResult(store.get(artifactRef)) !== undefined) return null;
      const record: ArtifactRecord = { artifactRef, ownerKeyId, mediaType, byteLength, sha256: "", createdAt: now,
        expiresAt: now + settings.artifactRetentionMs, chunkCount: 0, receivedBytes: 0 };
      await requestResult(store.add(record));
      return { artifactRef, byteLength, receivedBytes: 0, chunkBytes: COMMAND_CATALOG.limits["command.artifact.upload.maximum_raw_bytes"] };
    });
    if (result !== null) return result;
    attempt += 1;
  }
  throw new Error("Unable to allocate an upload ArtifactRef within the bounded attempt limit");
}

async function uploadRecord(transaction: IDBTransaction, ownerKeyId: string, artifactRef: string): Promise<ArtifactRecord> {
  const record = await requestResult(transaction.objectStore(ARTIFACT_STORE).get(artifactRef) as IDBRequest<ArtifactRecord | undefined>);
  if (record === undefined || record.ownerKeyId !== ownerKeyId || record.expiresAt <= Date.now()) {
    throw new ArtifactServiceError("ARTIFACT_NOT_FOUND", "Upload is unavailable to this Key");
  }
  if (record.receivedBytes === undefined) throw invalidUpload("ALREADY_COMMITTED");
  return record;
}

export async function appendArtifactUpload(ownerKeyId: string, artifactRef: string, offset: number, dataBase64Url: string) {
  const maximum = COMMAND_CATALOG.limits["command.artifact.upload.maximum_raw_bytes"];
  if (dataBase64Url.length > Math.ceil(maximum * 4 / 3) || !/^[A-Za-z0-9_-]+$/u.test(dataBase64Url)) throw invalidUpload("INVALID_CHUNK");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const binary = atob(dataBase64Url.replaceAll("-", "+").replaceAll("_", "/"));
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  } catch { throw invalidUpload("INVALID_CHUNK"); }
  if (bytes.byteLength === 0 || bytes.byteLength > maximum || base64Url(bytes) !== dataBase64Url) throw invalidUpload("INVALID_CHUNK");
  return withStrictReadWrite([ARTIFACT_CHUNK_STORE, ARTIFACT_STORE], async (transaction) => {
    const record = await uploadRecord(transaction, ownerKeyId, artifactRef);
    if (offset !== record.receivedBytes) throw invalidUpload("OFFSET_MISMATCH");
    const end = offset + bytes.byteLength;
    if (end > record.byteLength) throw invalidUpload("LENGTH_MISMATCH");
    const store = transaction.objectStore(ARTIFACT_CHUNK_STORE);
    const chunkBytes = artifactChunkBytes();
    let consumed = 0;
    while (consumed < bytes.byteLength) {
      const position = offset + consumed;
      const chunkIndex = Math.floor(position / chunkBytes);
      const prefixLength = position % chunkBytes;
      const length = Math.min(bytes.byteLength - consumed, chunkBytes - prefixLength);
      const combined = new Uint8Array(prefixLength + length);
      if (prefixLength > 0) {
        const previous = await requestResult(store.get(chunkKey(artifactRef, chunkIndex)) as IDBRequest<ArtifactChunkRecord | undefined>);
        if (previous?.artifactRef !== artifactRef || previous.chunkIndex !== chunkIndex ||
            !(previous.bytes instanceof ArrayBuffer) || previous.bytes.byteLength !== prefixLength) {
          throw new Error("Upload storage chunk is inconsistent with its received offset");
        }
        combined.set(new Uint8Array(previous.bytes));
      }
      combined.set(bytes.subarray(consumed, consumed + length), prefixLength);
      const chunk: ArtifactChunkRecord = { chunkKey: chunkKey(artifactRef, chunkIndex), artifactRef, chunkIndex, bytes: combined.buffer };
      await requestResult(store.put(chunk));
      consumed += length;
    }
    await requestResult(transaction.objectStore(ARTIFACT_STORE).put({ ...record, receivedBytes: end, chunkCount: Math.ceil(end / chunkBytes) }));
    return { artifactRef, receivedBytes: end };
  });
}

export async function commitArtifactUpload(ownerKeyId: string, artifactRef: string, sha256: string): Promise<{ readonly artifact: ArtifactMetadata }> {
  const buffer = await withStrictReadWrite([ARTIFACT_CHUNK_STORE, ARTIFACT_STORE], async (transaction) => {
    const record = await uploadRecord(transaction, ownerKeyId, artifactRef);
    if (record.receivedBytes !== record.byteLength) throw invalidUpload("INCOMPLETE");
    const data = new Uint8Array(record.byteLength);
    const store = transaction.objectStore(ARTIFACT_CHUNK_STORE);
    const chunkBytes = artifactChunkBytes();
    let offset = 0;
    while (offset < record.byteLength) {
      const chunkIndex = Math.floor(offset / chunkBytes);
      const chunk = await requestResult(store.get(chunkKey(artifactRef, chunkIndex)) as IDBRequest<ArtifactChunkRecord | undefined>);
      if (chunk?.artifactRef !== artifactRef || chunk.chunkIndex !== chunkIndex || !(chunk.bytes instanceof ArrayBuffer) ||
          chunk.bytes.byteLength !== Math.min(chunkBytes, record.byteLength - offset)) throw new Error("Incomplete upload storage");
      data.set(new Uint8Array(chunk.bytes), offset);
      offset += chunk.bytes.byteLength;
    }
    return data.buffer;
  });
  const actualSha256 = await digestHex(buffer);
  if (actualSha256 !== sha256) throw invalidUpload("HASH_MISMATCH");
  const artifact = await withStrictReadWrite([ARTIFACT_STORE, SETTINGS_STORE], async (transaction) => {
    const record = await uploadRecord(transaction, ownerKeyId, artifactRef);
    const settings = await currentSettingsInTransaction(transaction);
    if (record.receivedBytes !== buffer.byteLength || record.byteLength !== buffer.byteLength) throw invalidUpload("LENGTH_MISMATCH");
    if (record.byteLength > settings.artifactMaximumBytes) throw new ArtifactServiceError("LIMIT_EXCEEDED", "Current Artifact size limit changed");
    const { receivedBytes: _receivedBytes, ...committed } = record;
    const complete = { ...committed, sha256: actualSha256 };
    await requestResult(transaction.objectStore(ARTIFACT_STORE).put(complete));
    return metadata(complete);
  });
  return { artifact };
}
