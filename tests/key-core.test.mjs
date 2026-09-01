import assert from "node:assert/strict";
import test from "node:test";

import {
  generateKeyMaterial,
  parseApiKey,
  verifyParsedApiKey,
} from "../out/extension/background/key-crypto.js";
import {
  createKeyRecord,
  hasPermission,
  storedApiKey,
  toPublicKeyRecord,
} from "../out/extension/background/key-model.js";
import { parseAdminRequest } from "../out/extension/shared/admin-protocol.js";

test("generated API Key has exact v1 shape and verifies", async () => {
  const material = await generateKeyMaterial();
  assert.match(material.apiKey, /^bk1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u);
  const parsed = parseApiKey(material.apiKey);
  assert.notEqual(parsed, null);
  assert.equal(await verifyParsedApiKey(parsed, material.verifier), true);
});

test("a different secret cannot satisfy the verifier", async () => {
  const first = await generateKeyMaterial();
  const second = await generateKeyMaterial();
  const secondSecret = second.apiKey.split(".")[2];
  assert.notEqual(secondSecret, undefined);
  const parsed = parseApiKey(`bk1.${first.keyId}.${secondSecret}`);
  assert.notEqual(parsed, null);
  assert.equal(await verifyParsedApiKey(parsed, first.verifier), false);
});

test("malformed API Keys are rejected before record lookup", () => {
  assert.equal(parseApiKey(""), null);
  assert.equal(parseApiKey("bk1.short.short"), null);
  assert.equal(parseApiKey("bk2.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), null);
  assert.equal(parseApiKey(`bk1.${"A".repeat(21)}B.${"A".repeat(43)}`), null);
});

test("public Key projection never contains verifier or API secret", async () => {
  const material = await generateKeyMaterial();
  const record = createKeyRecord({
    keyId: material.keyId,
    displayName: "test",
    keyKind: "regular",
    permissions: ["system.read"],
    expiresAt: null,
    enabled: true,
    createdAt: 1,
    secretVerifier: material.verifier,
    storedApiKey: material.apiKey,
  });
  const publicRecord = toPublicKeyRecord(record);
  const encoded = JSON.stringify(publicRecord);
  assert.equal(publicRecord.secretAvailable, true);
  assert.equal("secretVerifier" in publicRecord, false);
  assert.equal("storedApiKey" in publicRecord, false);
  assert.equal(encoded.includes(material.verifier.digest), false);
  assert.equal(encoded.includes(material.apiKey), false);

  const legacyRecord = { ...record };
  delete legacyRecord.storedApiKey;
  assert.equal(storedApiKey(legacyRecord), null);
  assert.equal(toPublicKeyRecord(legacyRecord).secretAvailable, false);
});

test("Root and regular permission evaluation remain distinct", async () => {
  const material = await generateKeyMaterial();
  const root = createKeyRecord({
    keyId: material.keyId,
    displayName: "root",
    keyKind: "root",
    permissions: [],
    expiresAt: null,
    enabled: true,
    createdAt: 1,
    secretVerifier: material.verifier,
    storedApiKey: material.apiKey,
  });
  const regular = createKeyRecord({
    keyId: material.keyId,
    displayName: "regular",
    keyKind: "regular",
    permissions: [],
    expiresAt: null,
    enabled: true,
    createdAt: 1,
    secretVerifier: material.verifier,
    storedApiKey: material.apiKey,
  });
  assert.equal(hasPermission(root, "system.read"), true);
  assert.equal(hasPermission(root, "dom.click.real"), true);
  assert.equal(hasPermission(regular, "system.read"), false);
  const ordinaryOnly = { ...regular, permissions: ["dom.click"] };
  const realOnly = { ...regular, permissions: ["dom.click.real"] };
  assert.equal(hasPermission(ordinaryOnly, "dom.click"), true);
  assert.equal(hasPermission(ordinaryOnly, "dom.click.real"), false);
  assert.equal(hasPermission(realOnly, "dom.click.real"), true);
  assert.equal(hasPermission(realOnly, "dom.click"), false);
});

test("admin request parser accepts reveal and attach-secret only with their closed schemas", () => {
  const requestId = "ui1.AAAAAAAAAAAAAAAAAAAAAA";
  const keyId = "BBBBBBBBBBBBBBBBBBBBBB";
  const mutationId = "am1.1756425600000.CCCCCCCCCCCCCCCCCCCCCC";
  const apiKey = `bk1.${keyId}.${"D".repeat(43)}`;
  const reveal = { requestId, method: "keys.reveal", params: { keyId } };
  const attach = { requestId, method: "keys.attachSecret", params: { mutationId, keyId, apiKey } };

  assert.notEqual(parseAdminRequest(reveal), null);
  assert.equal(parseAdminRequest({ ...reveal, params: { keyId, extra: true } }), null);
  assert.notEqual(parseAdminRequest(attach), null);
  assert.equal(parseAdminRequest({ ...attach, params: { ...attach.params, apiKey: "not-a-key" } }), null);
  assert.equal(parseAdminRequest({ ...attach, params: { ...attach.params, unknown: true } }), null);
});

test("admin request parser accepts only the closed create schema", () => {
  const valid = {
    requestId: "ui1.AAAAAAAAAAAAAAAAAAAAAA",
    method: "keys.create",
    params: {
      mutationId: "am1.1756425600000.AAAAAAAAAAAAAAAAAAAAAA",
      displayName: "Agent Key",
      keyKind: "regular",
      permissions: ["system.read"],
      expiresAt: null,
      enabled: true,
    },
  };
  assert.notEqual(parseAdminRequest(valid), null);
  assert.equal(parseAdminRequest({ ...valid, extra: true }), null);
  assert.equal(parseAdminRequest({ ...valid, params: { ...valid.params, permissions: ["system.read", "system.read"] } }), null);
  assert.equal(parseAdminRequest({ ...valid, params: { ...valid.params, unknown: true } }), null);
});
