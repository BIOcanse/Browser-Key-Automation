import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import "fake-indexeddb/auto";
import { beginArtifactUpload, appendArtifactUpload, commitArtifactUpload, getArtifactMetadata, readArtifact, releaseArtifact } from "../out/extension/background/artifact-service.js";
import { ARTIFACT_STORE, ARTIFACT_CHUNK_STORE, SETTINGS_STORE, requestResult, withReadOnly, withStrictReadWrite } from "../out/extension/background/database.js";
import { defaultRuntimeSettings } from "../out/extension/background/settings-service.js";
import { COMMAND_CATALOG } from "../out/extension/generated/command-config.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const owner = "A".repeat(22), other = "B".repeat(22);
async function receive(bytes) {
  const upload = await beginArtifactUpload(owner, bytes.length, "text/html");
  let offset = 0;
  while (offset < bytes.length) {
    const part = bytes.subarray(offset, offset + upload.chunkBytes);
    const result = await appendArtifactUpload(owner, upload.artifactRef, offset, part.toString("base64url"));
    offset += part.length; assert.equal(result.receivedBytes, offset);
  }
  return upload;
}

test("upload remains private until verified commit and preserves bytes across the storage seam", async () => {
  const storageChunk = COMMAND_CATALOG.limits["build.artifact.chunk_bytes"];
  const bytes = Buffer.alloc(storageChunk + 101, "X"); bytes[storageChunk - 1] = 65; bytes[storageChunk] = 66;
  const upload = await receive(bytes);
  await assert.rejects(getArtifactMetadata(owner, upload.artifactRef), (e) => e.code === "ARTIFACT_NOT_FOUND");
  await assert.rejects(commitArtifactUpload(other, upload.artifactRef, hash(bytes)), (e) => e.code === "ARTIFACT_NOT_FOUND");
  const { artifact } = await commitArtifactUpload(owner, upload.artifactRef, hash(bytes));
  assert.equal(artifact.sha256, hash(bytes)); assert.equal(artifact.byteLength, bytes.length);
  const read = await readArtifact(owner, upload.artifactRef, storageChunk - 16, 64);
  assert.deepEqual(Buffer.from(read.dataBase64Url, "base64url"), bytes.subarray(storageChunk - 16, storageChunk + 48));
  await assert.rejects(readArtifact(other, upload.artifactRef, 0, 64), (e) => e.code === "ARTIFACT_NOT_FOUND");
  await assert.rejects(appendArtifactUpload(owner, upload.artifactRef, bytes.length, "eA"), (e) => e.details?.reason === "ALREADY_COMMITTED");
  await assert.rejects(commitArtifactUpload(owner, upload.artifactRef, hash(bytes)), (e) => e.details?.reason === "ALREADY_COMMITTED");
  await releaseArtifact(owner, upload.artifactRef);
});

test("offset, canonical base64, length, completeness and hash failures do not advance or publish", async () => {
  const bytes = Buffer.from("test"); const upload = await beginArtifactUpload(owner, bytes.length, "text/html");
  const ref = upload.artifactRef;
  await assert.rejects(appendArtifactUpload(other, ref, 0, "dGVzdA"), (e) => e.code === "ARTIFACT_NOT_FOUND");
  for (const data of ["", "A", "eB", "eA==", "!", Buffer.alloc(upload.chunkBytes + 1).toString("base64url")]) {
    await assert.rejects(appendArtifactUpload(owner, ref, 0, data), (e) => e.details?.reason === "INVALID_CHUNK");
  }
  await assert.rejects(appendArtifactUpload(owner, ref, 1, "eA"), (e) => e.details?.reason === "OFFSET_MISMATCH");
  await assert.rejects(appendArtifactUpload(owner, ref, 0, Buffer.from("extra").toString("base64url")), (e) => e.details?.reason === "LENGTH_MISMATCH");
  await assert.rejects(commitArtifactUpload(owner, ref, hash(bytes)), (e) => e.details?.reason === "INCOMPLETE");
  assert.equal((await appendArtifactUpload(owner, ref, 0, bytes.toString("base64url"))).receivedBytes, 4);
  await assert.rejects(commitArtifactUpload(owner, ref, "0".repeat(64)), (e) => e.details?.reason === "HASH_MISMATCH");
  await assert.rejects(readArtifact(owner, ref, 0, 100), (e) => e.code === "ARTIFACT_NOT_FOUND");
  await commitArtifactUpload(owner, ref, hash(bytes)); await releaseArtifact(owner, ref);
});

test("empty upload commits, reservation counts toward existing quotas, and release frees it", async () => {
  const empty = await receive(Buffer.alloc(0));
  const { artifact } = await commitArtifactUpload(owner, empty.artifactRef, hash(Buffer.alloc(0)));
  assert.equal(artifact.byteLength, 0);
  assert.equal((await readArtifact(owner, artifact.artifactRef, 0, 1)).nextOffset, null);
  await releaseArtifact(owner, artifact.artifactRef);
  await withStrictReadWrite([SETTINGS_STORE], async (tx) => requestResult(tx.objectStore(SETTINGS_STORE).put({
    ...defaultRuntimeSettings(), settingsId: "settings.v1", artifactMaximumBytes: 8, artifactMaximumTotalBytes: 8, artifactMaximumCount: 1,
  })));
  let reserved;
  try {
    await assert.rejects(beginArtifactUpload(owner, 9, "text/html"), (e) => e.code === "LIMIT_EXCEEDED");
    reserved = await beginArtifactUpload(owner, 8, "text/html");
    await assert.rejects(beginArtifactUpload(other, 1, "text/html"), (e) => e.code === "LIMIT_EXCEEDED");
    assert.equal((await releaseArtifact(other, reserved.artifactRef)).released, false);
    await releaseArtifact(owner, reserved.artifactRef); reserved = undefined;
    reserved = await beginArtifactUpload(other, 8, "text/html");
  } finally {
    if (reserved) { await releaseArtifact(owner, reserved.artifactRef); await releaseArtifact(other, reserved.artifactRef); }
    await withStrictReadWrite([SETTINGS_STORE], async (tx) => requestResult(tx.objectStore(SETTINGS_STORE).clear()));
  }
});

test("expired partial uploads clean their stored chunks and cannot be opened", async () => {
  const upload = await receive(Buffer.from("partial"));
  await withStrictReadWrite([ARTIFACT_STORE], async (tx) => {
    const store = tx.objectStore(ARTIFACT_STORE), record = await requestResult(store.get(upload.artifactRef));
    await requestResult(store.put({ ...record, expiresAt: Date.now() - 1 }));
  });
  await assert.rejects(getArtifactMetadata(owner, upload.artifactRef), (e) => e.code === "ARTIFACT_NOT_FOUND");
  const remaining = await withReadOnly([ARTIFACT_CHUNK_STORE], async (tx) =>
    requestResult(tx.objectStore(ARTIFACT_CHUNK_STORE).get(`${upload.artifactRef}.000000`)));
  assert.equal(remaining, undefined);
});

test("release during hash verification cannot be undone by the commit callback", async () => {
  const bytes = Buffer.from("race"); const upload = await receive(bytes);
  const original = crypto.subtle.digest.bind(crypto.subtle);
  let releaseHash, hashing;
  const started = new Promise((resolve) => { hashing = resolve; });
  const gate = new Promise((resolve) => { releaseHash = resolve; });
  crypto.subtle.digest = async (...args) => { hashing(); await gate; return original(...args); };
  try {
    const commit = commitArtifactUpload(owner, upload.artifactRef, hash(bytes));
    await started; await releaseArtifact(owner, upload.artifactRef); releaseHash();
    await assert.rejects(commit, (e) => e.code === "ARTIFACT_NOT_FOUND");
    await assert.rejects(getArtifactMetadata(owner, upload.artifactRef), (e) => e.code === "ARTIFACT_NOT_FOUND");
  } finally { crypto.subtle.digest = original; releaseHash(); }
});
