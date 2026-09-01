import {
  CURRENT_PERMISSION_IDS,
  type AdminErrorCode,
  type AttachKeySecretParams,
  type CreateKeyParams,
  type CreateKeyResult,
  type ListKeysParams,
  type ListKeysResult,
  type PermissionId,
  type PublicKeyRecord,
  type RevealKeyParams,
  type RevealKeyResult,
  type RevokeKeyParams,
  type UpdateKeyParams,
  type UpdateKeyPatch,
} from "../shared/admin-protocol.js";
import { COMMAND_CATALOG } from "../generated/command-config.js";
import { ADMIN_MUTATION_STORE, KEY_STORE, requestResult, withReadOnly, withStrictReadWrite } from "./database.js";
import { digestCanonicalText, generateKeyMaterial, parseApiKey, verifyParsedApiKey, type ParsedApiKey } from "./key-crypto.js";
import {
  createKeyRecord,
  hasPermission,
  storedApiKey,
  toPublicKeyRecord,
  type KeyRecord,
  type SecretVerifier,
} from "./key-model.js";

const MAX_IDENTIFIER_GENERATION_ATTEMPTS = 8;
const encoder = new TextEncoder();
const DUMMY_VERIFIER: SecretVerifier = {
  version: "sha256-v1",
  salt: "AAAAAAAAAAAAAAAAAAAAAA",
  digest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};
const DUMMY_PARSED_KEY: ParsedApiKey = {
  keyId: "AAAAAAAAAAAAAAAAAAAAAA",
  keyIdBytes: new Uint8Array(16),
  secretBytes: new Uint8Array(32),
};

type MutationMethod = "keys.attachSecret" | "keys.create" | "keys.update" | "keys.revoke";

interface AdminMutationRecord {
  readonly mutationId: string;
  readonly method: MutationMethod;
  readonly intentDigest: string;
  readonly keyId: string;
  readonly result: PublicKeyRecord;
  readonly committedAt: number;
}

interface CreateTransactionResult {
  readonly kind: "created" | "collision" | "duplicate";
  readonly key?: PublicKeyRecord;
  readonly apiKey?: string;
}

export class KeyServiceError extends Error {
  readonly code: AdminErrorCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>> | undefined;

  constructor(
    code: AdminErrorCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
    this.name = "KeyServiceError";
    this.code = code;
    this.details = details;
  }
}

export class KeyManagementAuthorizationError extends Error {
  readonly code = "FORBIDDEN" as const;

  constructor(message: string) {
    super(message);
    this.name = "KeyManagementAuthorizationError";
  }
}

export type AuthenticationResult =
  | { readonly ok: true; readonly key: PublicKeyRecord }
  | { readonly ok: false; readonly code: "FORBIDDEN" | "KEY_DISABLED" | "KEY_EXPIRED" | "UNAUTHENTICATED" };

function normalizeDisplayName(value: string): string {
  return value.trim();
}

function normalizePermissions(values: readonly PermissionId[]): readonly PermissionId[] {
  const unique = new Set<PermissionId>();
  let index = 0;
  while (index < values.length) {
    const permission = values[index];
    if (permission !== undefined && CURRENT_PERMISSION_IDS.includes(permission)) unique.add(permission);
    index += 1;
  }
  return [...unique].sort();
}

function permissionListsEqual(left: readonly PermissionId[], right: readonly PermissionId[]): boolean {
  if (left.length !== right.length) return false;
  let index = 0;
  while (index < left.length) {
    if (left[index] !== right[index]) return false;
    index += 1;
  }
  return true;
}

function canonicalCreateIntent(params: CreateKeyParams): string {
  return JSON.stringify([
    "keys.create.v1",
    normalizeDisplayName(params.displayName),
    params.keyKind,
    params.keyKind === "root" ? [] : normalizePermissions(params.permissions),
    params.expiresAt,
    params.enabled,
  ]);
}

function canonicalUpdateIntent(params: UpdateKeyParams, patch: UpdateKeyPatch): string {
  return JSON.stringify([
    "keys.update.v1",
    params.keyId,
    params.expectedRevision,
    normalizeDisplayName(patch.displayName),
    normalizePermissions(patch.permissions),
    patch.expiresAt,
    patch.enabled,
  ]);
}

function canonicalRevokeIntent(params: RevokeKeyParams): string {
  return JSON.stringify(["keys.revoke.v1", params.keyId, params.expectedRevision]);
}

function canonicalAttachSecretIntent(params: AttachKeySecretParams): string {
  return JSON.stringify(["keys.attachSecret.v1", params.keyId, params.apiKey]);
}

function ensureMutationMatches(existing: AdminMutationRecord, method: MutationMethod, intentDigest: string): void {
  if (existing.method !== method || existing.intentDigest !== intentDigest) {
    throw new KeyServiceError("ADMIN_MUTATION_CONFLICT", "AdminMutationId was already used for a different intent");
  }
}

function normalizeMutationResult(record: PublicKeyRecord): PublicKeyRecord {
  return {
    ...record,
    secretAvailable: record.secretAvailable === true,
  };
}

function getMutation(
  transaction: IDBTransaction,
  mutationId: string,
): Promise<AdminMutationRecord | undefined> {
  return requestResult(
    transaction.objectStore(ADMIN_MUTATION_STORE).get(mutationId) as IDBRequest<AdminMutationRecord | undefined>,
  );
}

function getKey(transaction: IDBTransaction, keyId: string): Promise<KeyRecord | undefined> {
  return requestResult(transaction.objectStore(KEY_STORE).get(keyId) as IDBRequest<KeyRecord | undefined>);
}

async function addMutation(transaction: IDBTransaction, mutation: AdminMutationRecord): Promise<void> {
  await requestResult(transaction.objectStore(ADMIN_MUTATION_STORE).add(mutation));
}

export async function createKey(params: CreateKeyParams): Promise<CreateKeyResult> {
  const normalizedPermissions = params.keyKind === "root" ? [] : normalizePermissions(params.permissions);
  const intentDigest = await digestCanonicalText(canonicalCreateIntent(params));
  let attempt = 0;

  while (attempt < MAX_IDENTIFIER_GENERATION_ATTEMPTS) {
    const material = await generateKeyMaterial();
    const createdAt = Date.now();
    const record = createKeyRecord({
      keyId: material.keyId,
      displayName: normalizeDisplayName(params.displayName),
      keyKind: params.keyKind,
      permissions: normalizedPermissions,
      expiresAt: params.expiresAt,
      enabled: params.enabled,
      createdAt,
      secretVerifier: material.verifier,
      storedApiKey: material.apiKey,
    });

    const transactionResult = await withStrictReadWrite(
      [KEY_STORE, ADMIN_MUTATION_STORE],
      async (transaction): Promise<CreateTransactionResult> => {
        const existingMutation = await getMutation(transaction, params.mutationId);
        if (existingMutation !== undefined) {
          ensureMutationMatches(existingMutation, "keys.create", intentDigest);
          const existingRecord = await getKey(transaction, existingMutation.keyId);
          const apiKey = existingRecord === undefined ? null : storedApiKey(existingRecord);
          if (existingRecord === undefined) {
            throw new KeyServiceError("KEY_NOT_FOUND", "Committed create result no longer has a Key record");
          }
          if (apiKey === null) {
            throw new KeyServiceError(
              "SECRET_NOT_RECOVERABLE",
              "This legacy create mutation committed before repeatable Key storage was enabled",
              { keyId: existingRecord.keyId },
            );
          }
          return { kind: "duplicate", key: toPublicKeyRecord(existingRecord), apiKey };
        }

        const existingKey = await getKey(transaction, material.keyId);
        if (existingKey !== undefined) return { kind: "collision" };

        const publicRecord = toPublicKeyRecord(record);
        await requestResult(transaction.objectStore(KEY_STORE).add(record));
        await addMutation(transaction, {
          mutationId: params.mutationId,
          method: "keys.create",
          intentDigest,
          keyId: record.keyId,
          result: publicRecord,
          committedAt: createdAt,
        });
        return { kind: "created", key: publicRecord };
      },
    );

    if (transactionResult.kind === "created" && transactionResult.key !== undefined) {
      return { key: transactionResult.key, apiKey: material.apiKey };
    }
    if (
      transactionResult.kind === "duplicate" &&
      transactionResult.key !== undefined &&
      transactionResult.apiKey !== undefined
    ) {
      return { key: transactionResult.key, apiKey: transactionResult.apiKey };
    }
    attempt += 1;
  }

  throw new KeyServiceError("INTERNAL_ERROR", "Unable to allocate a unique KeyId within the bounded attempt limit");
}

async function readKeyPage(afterKeyId: string | null, limit: number): Promise<{ items: KeyRecord[]; hasMore: boolean }> {
  return withReadOnly([KEY_STORE], async (transaction) => {
    const store = transaction.objectStore(KEY_STORE);
    const range = afterKeyId === null ? undefined : IDBKeyRange.lowerBound(afterKeyId, true);
    const request = store.openCursor(range);
    return new Promise<{ items: KeyRecord[]; hasMore: boolean }>((resolve, reject) => {
      const items: KeyRecord[] = [];
      request.addEventListener("error", () => reject(request.error ?? new Error("Key cursor failed")), { once: true });
      request.addEventListener("success", () => {
        const cursor = request.result;
        if (cursor === null) {
          resolve({ items, hasMore: false });
          return;
        }
        if (items.length >= limit) {
          resolve({ items, hasMore: true });
          return;
        }
        items.push(cursor.value as KeyRecord);
        cursor.continue();
      });
    });
  });
}

export async function listKeys(params: ListKeysParams): Promise<ListKeysResult> {
  const page = await readKeyPage(
    params.afterKeyId,
    Math.min(params.limit, COMMAND_CATALOG.limits["command.keys.list.maximum_items"]),
  );
  const items: PublicKeyRecord[] = [];
  let index = 0;
  while (index < page.items.length) {
    const item = page.items[index];
    if (item === undefined) break;
    const projected = toPublicKeyRecord(item);
    const candidateBytes = encoder.encode(JSON.stringify({
      items: [...items, projected],
      nextAfterKeyId: projected.keyId,
    })).byteLength;
    if (candidateBytes > COMMAND_CATALOG.limits["command.inline.maximum_result_json_bytes"]) break;
    items.push(projected);
    index += 1;
  }
  const lastItem = items.at(-1);
  const hasMore = page.hasMore || index < page.items.length;
  if (hasMore && lastItem === undefined) {
    throw new KeyServiceError("INTERNAL_ERROR", "One public Key record did not fit the inline result budget");
  }
  return {
    items,
    nextAfterKeyId: hasMore && lastItem !== undefined ? lastItem.keyId : null,
  };
}

export async function getPublicKey(keyId: string): Promise<PublicKeyRecord> {
  const record = await getKeyById(keyId);
  if (record === undefined) throw new KeyServiceError("KEY_NOT_FOUND", "Key does not exist");
  return toPublicKeyRecord(record);
}

function callerHasPermission(caller: PublicKeyRecord, permission: PermissionId): boolean {
  return caller.keyKind === "root" || caller.permissions.includes(permission);
}

function assertCreateCeiling(caller: PublicKeyRecord, params: CreateKeyParams): void {
  if (params.keyKind === "root" && caller.keyKind !== "root") {
    throw new KeyManagementAuthorizationError("Only a Root Key may create another Root Key");
  }
  if (params.keyKind === "root") return;
  for (const permission of params.permissions) {
    if (!callerHasPermission(caller, permission)) {
      throw new KeyManagementAuthorizationError("A Regular Key cannot grant a permission it does not own");
    }
  }
}

export function createKeyForCaller(caller: PublicKeyRecord, params: CreateKeyParams): Promise<CreateKeyResult> {
  assertCreateCeiling(caller, params);
  return createKey(params);
}

export function updateKeyForCaller(
  caller: PublicKeyRecord,
  params: UpdateKeyParams,
): Promise<PublicKeyRecord> {
  return commitKeyUpdate(params, caller);
}

export async function revealKey(params: RevealKeyParams): Promise<RevealKeyResult> {
  const record = await getKeyById(params.keyId);
  if (record === undefined) throw new KeyServiceError("KEY_NOT_FOUND", "Key does not exist");
  const apiKey = storedApiKey(record);
  if (apiKey === null) {
    throw new KeyServiceError(
      "SECRET_NOT_RECOVERABLE",
      "This legacy Key has no stored token; attach the original Key to make it viewable",
      { keyId: record.keyId },
    );
  }
  return { keyId: record.keyId, apiKey };
}

export async function attachKeySecret(params: AttachKeySecretParams): Promise<PublicKeyRecord> {
  const parsed = parseApiKey(params.apiKey);
  if (parsed === null || parsed.keyId !== params.keyId) {
    throw new KeyServiceError("KEY_SECRET_MISMATCH", "The supplied API Key does not match this Key record");
  }

  const snapshot = await getKeyById(params.keyId);
  if (snapshot === undefined) throw new KeyServiceError("KEY_NOT_FOUND", "Key does not exist");
  const snapshotStoredApiKey = storedApiKey(snapshot);
  if (snapshotStoredApiKey !== null && snapshotStoredApiKey !== params.apiKey) {
    throw new KeyServiceError("KEY_SECRET_MISMATCH", "The supplied API Key does not match this Key record");
  }
  if (snapshotStoredApiKey === null) {
    if (snapshot.secretVerifier === null) {
      throw new KeyServiceError(
        "SECRET_NOT_RECOVERABLE",
        "This revoked legacy Key no longer has verifier material for attaching its token",
        { keyId: snapshot.keyId },
      );
    }
    if (!await verifyParsedApiKey(parsed, snapshot.secretVerifier)) {
      throw new KeyServiceError("KEY_SECRET_MISMATCH", "The supplied API Key does not match this Key record");
    }
  }

  const intentDigest = await digestCanonicalText(canonicalAttachSecretIntent(params));
  return withStrictReadWrite([KEY_STORE, ADMIN_MUTATION_STORE], async (transaction) => {
    const existingMutation = await getMutation(transaction, params.mutationId);
    if (existingMutation !== undefined) {
      ensureMutationMatches(existingMutation, "keys.attachSecret", intentDigest);
      return normalizeMutationResult(existingMutation.result);
    }

    const current = await getKey(transaction, params.keyId);
    if (current === undefined) throw new KeyServiceError("KEY_NOT_FOUND", "Key does not exist");
    const currentStoredApiKey = storedApiKey(current);
    if (currentStoredApiKey !== null && currentStoredApiKey !== params.apiKey) {
      throw new KeyServiceError("KEY_SECRET_MISMATCH", "The supplied API Key does not match this Key record");
    }
    if (
      currentStoredApiKey === null &&
      (
        snapshot.secretVerifier === null ||
        current.secretVerifier === null ||
        current.credentialRevision !== snapshot.credentialRevision ||
        !sameVerifier(current.secretVerifier, snapshot.secretVerifier)
      )
    ) {
      throw new KeyServiceError("REVISION_CONFLICT", "Key credentials changed while attaching the stored token");
    }

    const next: KeyRecord = currentStoredApiKey === null
      ? {
          ...current,
          storedApiKey: params.apiKey,
          recordRevision: current.recordRevision + 1,
        }
      : current;
    const publicRecord = toPublicKeyRecord(next);
    if (next !== current) await requestResult(transaction.objectStore(KEY_STORE).put(next));
    await addMutation(transaction, {
      mutationId: params.mutationId,
      method: "keys.attachSecret",
      intentDigest,
      keyId: next.keyId,
      result: publicRecord,
      committedAt: Date.now(),
    });
    return publicRecord;
  });
}

export function updateKey(params: UpdateKeyParams): Promise<PublicKeyRecord> {
  return commitKeyUpdate(params, null);
}

async function commitKeyUpdate(params: UpdateKeyParams, caller: PublicKeyRecord | null): Promise<PublicKeyRecord> {
  const normalizedPatch: UpdateKeyPatch = {
    displayName: normalizeDisplayName(params.patch.displayName),
    permissions: normalizePermissions(params.patch.permissions),
    expiresAt: params.patch.expiresAt,
    enabled: params.patch.enabled,
  };
  const intentDigest = await digestCanonicalText(canonicalUpdateIntent(params, normalizedPatch));

  return withStrictReadWrite([KEY_STORE, ADMIN_MUTATION_STORE], async (transaction) => {
    const existingMutation = await getMutation(transaction, params.mutationId);
    if (existingMutation !== undefined) {
      ensureMutationMatches(existingMutation, "keys.update", intentDigest);
      return normalizeMutationResult(existingMutation.result);
    }

    const current = await getKey(transaction, params.keyId);
    if (current === undefined) throw new KeyServiceError("KEY_NOT_FOUND", "Key does not exist");
    if (current.status === "revoked") throw new KeyServiceError("KEY_REVOKED", "Revoked Key cannot be updated");
    if (current.recordRevision !== params.expectedRevision) {
      throw new KeyServiceError("REVISION_CONFLICT", "Key record changed; reload before updating", {
        expectedRevision: params.expectedRevision,
        actualRevision: current.recordRevision,
      });
    }

    if (caller !== null) {
      if (current.keyKind === "root" && caller.keyKind !== "root") {
        throw new KeyManagementAuthorizationError("Only a Root Key may update a Root Key");
      }
      if (current.keyKind === "regular") {
        for (const permission of normalizedPatch.permissions) {
          if (!current.permissions.includes(permission) && !callerHasPermission(caller, permission)) {
            throw new KeyManagementAuthorizationError("A Regular Key cannot add a permission it does not own");
          }
        }
      }
    }

    const nextPermissions = current.keyKind === "root" ? [] : normalizedPatch.permissions;
    const displayNameChanged = current.displayName !== normalizedPatch.displayName;
    const permissionsChanged = !permissionListsEqual(current.permissions, nextPermissions);
    const expiryChanged = current.expiresAt !== normalizedPatch.expiresAt;
    const enabledChanged = current.enabled !== normalizedPatch.enabled;
    const authorizationChanged = permissionsChanged || expiryChanged || enabledChanged;
    const controlPermissionChanged =
      current.permissions.includes("control.acquire") !==
      nextPermissions.includes("control.acquire");
    const controlEligibilityChanged = expiryChanged || enabledChanged || controlPermissionChanged;
    const anyChanged = displayNameChanged || authorizationChanged;

    const next: KeyRecord = anyChanged
      ? {
          ...current,
          displayName: normalizedPatch.displayName,
          permissions: [...nextPermissions],
          expiresAt: normalizedPatch.expiresAt,
          enabled: normalizedPatch.enabled,
          recordRevision: current.recordRevision + 1,
          authorizationRevision: current.authorizationRevision + (authorizationChanged ? 1 : 0),
          controlEligibilityRevision: current.controlEligibilityRevision + (controlEligibilityChanged ? 1 : 0),
        }
      : current;
    const publicRecord = toPublicKeyRecord(next);
    if (anyChanged) await requestResult(transaction.objectStore(KEY_STORE).put(next));
    await addMutation(transaction, {
      mutationId: params.mutationId,
      method: "keys.update",
      intentDigest,
      keyId: next.keyId,
      result: publicRecord,
      committedAt: Date.now(),
    });
    return publicRecord;
  });
}

export async function revokeKey(params: RevokeKeyParams): Promise<PublicKeyRecord> {
  const intentDigest = await digestCanonicalText(canonicalRevokeIntent(params));
  return withStrictReadWrite([KEY_STORE, ADMIN_MUTATION_STORE], async (transaction) => {
    const existingMutation = await getMutation(transaction, params.mutationId);
    if (existingMutation !== undefined) {
      ensureMutationMatches(existingMutation, "keys.revoke", intentDigest);
      return normalizeMutationResult(existingMutation.result);
    }

    const current = await getKey(transaction, params.keyId);
    if (current === undefined) throw new KeyServiceError("KEY_NOT_FOUND", "Key does not exist");
    if (current.recordRevision !== params.expectedRevision) {
      throw new KeyServiceError("REVISION_CONFLICT", "Key record changed; reload before revoking", {
        expectedRevision: params.expectedRevision,
        actualRevision: current.recordRevision,
      });
    }

    const revokedAt = Date.now();
    const next: KeyRecord = current.status === "revoked"
      ? current
      : {
          ...current,
          secretVerifier: null,
          enabled: false,
          status: "revoked",
          revokedAt,
          recordRevision: current.recordRevision + 1,
          credentialRevision: current.credentialRevision + 1,
          authorizationRevision: current.authorizationRevision + 1,
          controlEligibilityRevision: current.controlEligibilityRevision + 1,
        };
    const publicRecord = toPublicKeyRecord(next);
    if (next !== current) await requestResult(transaction.objectStore(KEY_STORE).put(next));
    await addMutation(transaction, {
      mutationId: params.mutationId,
      method: "keys.revoke",
      intentDigest,
      keyId: next.keyId,
      result: publicRecord,
      committedAt: revokedAt,
    });
    return publicRecord;
  });
}

async function getKeyById(keyId: string): Promise<KeyRecord | undefined> {
  return withReadOnly([KEY_STORE], (transaction) => getKey(transaction, keyId));
}

export async function authenticateApiKey(
  apiKey: string,
  requiredPermission: PermissionId,
): Promise<AuthenticationResult> {
  const parsed = parseApiKey(apiKey);
  const record = parsed === null ? undefined : await getKeyById(parsed.keyId);
  const verifier = record?.status === "active" && record.secretVerifier !== null ? record.secretVerifier : DUMMY_VERIFIER;
  const verified = await verifyParsedApiKey(parsed ?? DUMMY_PARSED_KEY, verifier);

  if (!verified || parsed === null || record === undefined || record.status !== "active" || record.secretVerifier === null) {
    return { ok: false, code: "UNAUTHENTICATED" };
  }

  // WebCrypto runs outside IndexedDB transactions. Re-read after verification so
  // revoke, credential rotation, disable, expiry, and permission edits linearize
  // before this admission result instead of being bypassed by the old snapshot.
  const current = await getKeyById(parsed.keyId);
  if (
    current === undefined ||
    current.status !== "active" ||
    current.secretVerifier === null ||
    current.credentialRevision !== record.credentialRevision ||
    !sameVerifier(current.secretVerifier, record.secretVerifier)
  ) {
    return { ok: false, code: "UNAUTHENTICATED" };
  }
  if (!current.enabled) return { ok: false, code: "KEY_DISABLED" };
  if (current.expiresAt !== null && Date.now() >= current.expiresAt) {
    return { ok: false, code: "KEY_EXPIRED" };
  }
  if (!hasPermission(current, requiredPermission)) return { ok: false, code: "FORBIDDEN" };
  return { ok: true, key: toPublicKeyRecord(current) };
}

function sameVerifier(left: SecretVerifier, right: SecretVerifier): boolean {
  return (
    left.version === right.version &&
    left.salt === right.salt &&
    left.digest === right.digest
  );
}
