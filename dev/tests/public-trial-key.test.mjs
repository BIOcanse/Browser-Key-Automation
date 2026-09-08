import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import "fake-indexeddb/auto";
import { readFile } from "node:fs/promises";
import { PUBLIC_TRIAL_KEY, PUBLIC_TRIAL_KEY_ID } from "../../out/extension/shared/trial-key.js";
import { initializePublicTrialKey, authenticateApiKey, createKey, getPublicKey, listKeys, listKeysForAdmin, revealKey, revokeKey, updateKey } from "../../out/extension/background/key-service.js";
import { createKeyMaterial, parseApiKey, verifyParsedApiKey } from "../../out/extension/background/key-crypto.js";
import { KEY_STORE, ADMIN_MUTATION_STORE, requestResult, withStrictReadWrite } from "../../out/extension/background/database.js";

const mutationId = () => `am1.${Date.now()}.${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url")}`;
async function clearKeys() {
  await withStrictReadWrite([KEY_STORE, ADMIN_MUTATION_STORE], async (transaction) => {
    await requestResult(transaction.objectStore(KEY_STORE).clear());
    await requestResult(transaction.objectStore(ADMIN_MUTATION_STORE).clear());
  });
}
beforeEach(clearKeys);

test("fresh installs get the same ordinary Root Key exactly once, including concurrent install events", async () => {
  const results = await Promise.all([initializePublicTrialKey("install"), initializePublicTrialKey("install")]);
  assert.deepEqual(results.sort(), [false, true]);
  const page = await listKeys({ afterKeyId: null, limit: 100 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].keyId, PUBLIC_TRIAL_KEY_ID);
  assert.equal(page.items[0].keyKind, "root");
  assert.equal(page.items[0].enabled, true);
  assert.equal(page.items[0].expiresAt, null);
  assert.equal(page.items[0].recordRevision, 1);
  assert.equal(page.items[0].secretVerifier, undefined);
  assert.equal(page.items[0].storedApiKey, undefined);
  assert.equal((await revealKey({ keyId: PUBLIC_TRIAL_KEY_ID })).apiKey, PUBLIC_TRIAL_KEY);
  assert.equal((await authenticateApiKey(PUBLIC_TRIAL_KEY, "debugger")).ok, true);
  assert.equal((await authenticateApiKey(PUBLIC_TRIAL_KEY, "dom.click.real")).ok, true);
  await clearKeys(); // Another fresh profile has exactly the same public credential.
  assert.equal(await initializePublicTrialKey("install"), true);
  assert.equal((await revealKey({ keyId: PUBLIC_TRIAL_KEY_ID })).apiKey, PUBLIC_TRIAL_KEY);
});

test("updates never introduce a public Key, and initialization preserves existing private Keys", async () => {
  for (const reason of ["update", "chrome_update", "shared_module_update"]) {
    assert.equal(await initializePublicTrialKey(reason), false);
  }
  assert.equal((await listKeys({ afterKeyId: null, limit: 100 })).items.length, 0);
  const privateKey = await createKey({ mutationId: mutationId(), displayName: "Private", keyKind: "root",
    permissions: [], expiresAt: null, enabled: true });
  assert.notEqual(privateKey.apiKey, PUBLIC_TRIAL_KEY);
  assert.equal(await initializePublicTrialKey("install"), false);
  assert.equal((await authenticateApiKey(PUBLIC_TRIAL_KEY, "system.read")).ok, false);
  assert.equal((await authenticateApiKey(privateKey.apiKey, "system.read")).ok, true);
});

test("ordinary disable, expiry and revoke remain authoritative across initialization replays", async () => {
  await initializePublicTrialKey("install");
  let record = await getPublicKey(PUBLIC_TRIAL_KEY_ID);
  const change = async (enabled, expiresAt) => {
    record = await updateKey({ mutationId: mutationId(), keyId: record.keyId, expectedRevision: record.recordRevision,
      patch: { displayName: "Renamed trial", permissions: [], enabled, expiresAt } });
  };
  const unchangedAfterInstall = async () => {
    for (const reason of ["install", "update", "chrome_update", "shared_module_update"]) {
      assert.equal(await initializePublicTrialKey(reason), false);
    }
    if (record.status === "revoked") await assert.rejects(getPublicKey(record.keyId), { code: "KEY_NOT_FOUND" });
    else assert.deepEqual(await getPublicKey(record.keyId), record);
  };
  await change(false, null);
  await unchangedAfterInstall();
  assert.equal((await authenticateApiKey(PUBLIC_TRIAL_KEY, "system.read")).code, "KEY_DISABLED");
  await change(true, Date.now() - 1);
  await unchangedAfterInstall();
  assert.equal((await authenticateApiKey(PUBLIC_TRIAL_KEY, "system.read")).code, "KEY_EXPIRED");
  await change(true, null);
  assert.equal((await authenticateApiKey(PUBLIC_TRIAL_KEY, "system.read")).ok, true);
  const privateKey = await createKey({ mutationId: mutationId(), displayName: "Replacement", keyKind: "root",
    permissions: [], expiresAt: null, enabled: true });
  assert.equal((await authenticateApiKey(PUBLIC_TRIAL_KEY, "system.read")).ok, true, "creating another Key does not revoke the public one");
  record = await revokeKey({ mutationId: mutationId(), keyId: record.keyId, expectedRevision: record.recordRevision });
  await unchangedAfterInstall();
  assert.equal((await authenticateApiKey(PUBLIC_TRIAL_KEY, "system.read")).code, "UNAUTHENTICATED");
  assert.equal((await authenticateApiKey(privateKey.apiKey, "system.read")).ok, true);
});

test("deleting the only trial Key leaves an empty list and never recreates it", async () => {
  await initializePublicTrialKey("install");
  await revokeKey({ mutationId: mutationId(), keyId: PUBLIC_TRIAL_KEY_ID, expectedRevision: 1 });
  for (const reason of ["install", "update", "chrome_update"]) assert.equal(await initializePublicTrialKey(reason), false);
  assert.deepEqual(await listKeys({ afterKeyId: null, limit: 100 }), { items: [], nextAfterKeyId: null });
  await assert.rejects(revealKey({ keyId: PUBLIC_TRIAL_KEY_ID }), { code: "KEY_NOT_FOUND" });
});

test("fixed material and the packaged skill match the canonical build freedom point", async () => {
  const material = await createKeyMaterial(PUBLIC_TRIAL_KEY);
  const parsed = parseApiKey(PUBLIC_TRIAL_KEY);
  assert.equal(parsed.keyId, PUBLIC_TRIAL_KEY_ID);
  assert.equal(await verifyParsedApiKey(parsed, material.verifier), true);
  await assert.rejects(createKeyMaterial("not-a-key"), /Invalid API Key material/);
  const freedom = JSON.parse(await readFile(new URL("../registries/freedom.registry.json", import.meta.url), "utf8"));
  assert.equal(freedom.points.find((point) => point.pointId === "build.keys.public_trial_key").defaultString, PUBLIC_TRIAL_KEY);
  const skill = await readFile(new URL("../skills/browser-key-automation/SKILL.md", import.meta.url), "utf8");
  assert.ok(skill.includes(`\n${PUBLIC_TRIAL_KEY}\n`), "agents must be given the actual fixed public credential");
});

test("admin warning status is independent of pagination and never enters public command results", async () => {
  await initializePublicTrialKey("install");
  const page = { afterKeyId: PUBLIC_TRIAL_KEY_ID, limit: 1 };
  assert.deepEqual(await listKeys(page), { items: [], nextAfterKeyId: null });
  assert.deepEqual(await listKeysForAdmin(page), { items: [], nextAfterKeyId: null, publicTrialKeyActive: true });
  await revokeKey({ keyId: PUBLIC_TRIAL_KEY_ID, mutationId: mutationId(), expectedRevision: 1 });
  assert.equal((await listKeysForAdmin(page)).publicTrialKeyActive, false);
});
