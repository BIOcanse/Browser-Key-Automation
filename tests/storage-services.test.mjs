import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import "fake-indexeddb/auto";
import { createKey, getPublicKey, updateKey, updateKeyForCaller } from "../out/extension/background/key-service.js";
import { createTextArtifact, readArtifact, releaseArtifact } from "../out/extension/background/artifact-service.js";
import { ARTIFACT_STORE, ARTIFACT_CHUNK_STORE, requestResult, withReadOnly, withStrictReadWrite } from "../out/extension/background/database.js";

const mutationId = () => `am1.${Date.now()}.${randomBytes(16).toString("base64url")}`;

test("committed Key update replay ignores later target changes without permitting new grants", async () => {
  const created = await createKey({ mutationId: mutationId(), displayName: "target", keyKind: "regular",
    permissions: ["js.execute", "tabs.read"], expiresAt: null, enabled: true });
  const caller = { ...created.key, keyId: randomBytes(16).toString("base64url"), permissions: ["keys.update", "tabs.read"] };
  const original = { keyId: created.key.keyId, mutationId: mutationId(), expectedRevision: 1,
    patch: { displayName: "renamed", permissions: ["js.execute", "tabs.read"], expiresAt: null, enabled: true } };
  const accepted = await updateKeyForCaller(caller, original);
  assert.equal(accepted.recordRevision, 2);
  await updateKey({ ...original, mutationId: mutationId(), expectedRevision: 2,
    patch: { ...original.patch, permissions: ["tabs.read"] } });
  assert.deepEqual(await updateKeyForCaller(caller, original), accepted);
  assert.equal((await getPublicKey(created.key.keyId)).recordRevision, 3);
  await assert.rejects(updateKeyForCaller(caller, { ...original, mutationId: mutationId(), expectedRevision: 3 }),
    (error) => error.code === "FORBIDDEN");
  await assert.rejects(updateKeyForCaller(caller, { ...original, patch: { ...original.patch, displayName: "different intent" } }),
    (error) => error.code === "ADMIN_MUTATION_CONFLICT");
  const root = await createKey({ mutationId: mutationId(), displayName: "root", keyKind: "root",
    permissions: [], expiresAt: null, enabled: true });
  await assert.rejects(updateKeyForCaller(caller, { ...original, mutationId: mutationId(), keyId: root.key.keyId }),
    (error) => error.code === "FORBIDDEN");
});

test("expired Artifact metadata and chunks commit deletion before reporting not found", async () => {
  const artifact = await createTextArtifact("owner", "text/plain", "expired body");
  await withStrictReadWrite([ARTIFACT_STORE], async (transaction) => {
    const store = transaction.objectStore(ARTIFACT_STORE);
    const record = await requestResult(store.get(artifact.artifactRef));
    await requestResult(store.put({ ...record, expiresAt: Date.now() - 1 }));
  });
  await assert.rejects(readArtifact("owner", artifact.artifactRef, 0, 100), (error) => error.code === "ARTIFACT_NOT_FOUND");
  const remaining = await withReadOnly([ARTIFACT_STORE, ARTIFACT_CHUNK_STORE], async (transaction) => ({
    metadata: await requestResult(transaction.objectStore(ARTIFACT_STORE).get(artifact.artifactRef)),
    chunk: await requestResult(transaction.objectStore(ARTIFACT_CHUNK_STORE).get(`${artifact.artifactRef}.000000`)),
  }));
  assert.equal(remaining.metadata, undefined);
  assert.equal(remaining.chunk, undefined);
});

test("live Artifact remains owner-bound and failed write transactions still roll back", async () => {
  const artifact = await createTextArtifact("owner", "text/plain", "live body");
  await assert.rejects(readArtifact("other", artifact.artifactRef, 0, 100), (error) => error.code === "ARTIFACT_NOT_FOUND");
  await assert.rejects(withStrictReadWrite([ARTIFACT_STORE], async (transaction) => {
    await requestResult(transaction.objectStore(ARTIFACT_STORE).delete(artifact.artifactRef));
    throw new Error("rollback fixture");
  }), /rollback fixture/u);
  assert.equal(Buffer.from((await readArtifact("owner", artifact.artifactRef, 0, 100)).dataBase64Url, "base64url").toString(), "live body");
  assert.equal((await releaseArtifact("owner", artifact.artifactRef)).released, true);
});
