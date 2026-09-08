import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import 'fake-indexeddb/auto';
import { generateKeyMaterial } from '../../out/extension/background/key-crypto.js';
import { createKeyRecord } from '../../out/extension/background/key-model.js';

const activeMaterial = await generateKeyMaterial();
const revokedMaterial = await generateKeyMaterial();
const makeRecord = material => createKeyRecord({ keyId: material.keyId, displayName: 'Upgrade fixture', keyKind: 'root',
  permissions: [], expiresAt: null, enabled: true, createdAt: 1, secretVerifier: material.verifier, storedApiKey: material.apiKey });
const activeRecord = makeRecord(activeMaterial);
const oldDatabase = await new Promise((resolve, reject) => {
  const request = indexedDB.open('browser-key-automation', 6);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('keys', { keyPath: 'keyId' });
    request.result.createObjectStore('admin_mutations', { keyPath: 'mutationId' });
    request.result.createObjectStore('recordings', { keyPath: 'recordingId' });
  };
  request.onerror = () => reject(request.error);
  request.onsuccess = () => resolve(request.result);
});
await new Promise((resolve, reject) => {
  const transaction = oldDatabase.transaction(['keys', 'recordings'], 'readwrite');
  transaction.objectStore('keys').put(activeRecord);
  transaction.objectStore('keys').put({ ...makeRecord(revokedMaterial), status: 'revoked', enabled: false, secretVerifier: null });
  transaction.objectStore('recordings').put({ recordingId: 'unrelated-recording', marker: 'preserved' });
  transaction.oncomplete = resolve;
  transaction.onabort = () => reject(transaction.error);
});
oldDatabase.close();

const database = await import('../../out/extension/background/database.js');
const keys = await import('../../out/extension/background/key-service.js');
const read = (store, id) => database.withReadOnly([store], transaction => database.requestResult(transaction.objectStore(store).get(id)));
const mutationId = () => `am1.${Date.now()}.${randomBytes(16).toString('base64url')}`;

test('upgrade removes old revoked credentials while preserving active Keys and unrelated data', async () => {
  assert.equal((await database.getDatabase()).version, 7);
  assert.equal(await read('keys', revokedMaterial.keyId), undefined);
  assert.deepEqual(await read('keys', activeMaterial.keyId), activeRecord);
  assert.deepEqual(await read('recordings', 'unrelated-recording'), { recordingId: 'unrelated-recording', marker: 'preserved' });
  await assert.rejects(keys.revealKey({ keyId: revokedMaterial.keyId }), { code: 'KEY_NOT_FOUND' });
});

test('revoke deletes the credential and only retains its idempotent receipt', async () => {
  const params = { mutationId: mutationId(), keyId: activeRecord.keyId, expectedRevision: 1 };
  const receipt = await keys.revokeKey(params);
  assert.equal(receipt.status, 'revoked'); assert.equal(receipt.secretAvailable, false);
  assert.equal(await read('keys', activeRecord.keyId), undefined);
  assert.deepEqual(await keys.listKeys({ afterKeyId: null, limit: 100 }), { items: [], nextAfterKeyId: null });
  assert.deepEqual(await keys.authenticateApiKey(activeMaterial.apiKey, 'system.read'), { ok: false, code: 'UNAUTHENTICATED' });
  await assert.rejects(keys.getPublicKey(activeRecord.keyId), { code: 'KEY_NOT_FOUND' });
  await assert.rejects(keys.revealKey({ keyId: activeRecord.keyId }), { code: 'KEY_NOT_FOUND' });
  assert.deepEqual(await keys.revokeKey(params), receipt);
  assert.equal(JSON.stringify(await read('admin_mutations', params.mutationId)).includes(activeMaterial.apiKey), false);
});

test('replaying a create request after deletion never restores the Key or its secret', async () => {
  const params = { mutationId: mutationId(), displayName: 'Delete then retry', keyKind: 'root', permissions: [], expiresAt: null, enabled: true };
  const created = await keys.createKey(params);
  await keys.revokeKey({ mutationId: mutationId(), keyId: created.key.keyId, expectedRevision: 1 });
  await assert.rejects(keys.createKey(params), { code: 'KEY_NOT_FOUND' });
  assert.deepEqual(await keys.listKeys({ afterKeyId: null, limit: 100 }), { items: [], nextAfterKeyId: null });
});
