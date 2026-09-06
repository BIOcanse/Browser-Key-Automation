import type { KeyKind, PermissionId, PublicKeyRecord } from "../shared/admin-protocol.js";

const storedApiKeyPattern = /^bk1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u;

export interface SecretVerifier {
  readonly version: "sha256-v1";
  readonly salt: string;
  readonly digest: string;
}

export interface KeyRecord extends Omit<PublicKeyRecord, "secretAvailable"> {
  readonly storageClass: "ordinary";
  readonly secretVerifier: SecretVerifier | null;
  readonly storedApiKey?: string | null;
}

export interface NewKeyRecordInput {
  readonly keyId: string;
  readonly displayName: string;
  readonly keyKind: KeyKind;
  readonly permissions: readonly PermissionId[];
  readonly expiresAt: number | null;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly secretVerifier: SecretVerifier;
  readonly storedApiKey: string;
}

export function createKeyRecord(input: NewKeyRecordInput): KeyRecord {
  return {
    keyId: input.keyId,
    displayName: input.displayName,
    keyKind: input.keyKind,
    storageClass: "ordinary",
    secretVerifier: input.secretVerifier,
    storedApiKey: input.storedApiKey,
    permissions: input.keyKind === "root" ? [] : [...input.permissions],
    expiresAt: input.expiresAt,
    enabled: input.enabled,
    createdAt: input.createdAt,
    status: "active",
    revokedAt: null,
    recordRevision: 1,
    credentialRevision: 1,
    authorizationRevision: 1,
    controlEligibilityRevision: 1,
  };
}

export function toPublicKeyRecord(record: KeyRecord): PublicKeyRecord {
  return {
    keyId: record.keyId,
    displayName: record.displayName,
    keyKind: record.keyKind,
    secretAvailable: storedApiKey(record) !== null,
    permissions: [...record.permissions],
    expiresAt: record.expiresAt,
    enabled: record.enabled,
    createdAt: record.createdAt,
    status: record.status,
    revokedAt: record.revokedAt,
    recordRevision: record.recordRevision,
    credentialRevision: record.credentialRevision,
    authorizationRevision: record.authorizationRevision,
    controlEligibilityRevision: record.controlEligibilityRevision,
  };
}

export function storedApiKey(record: KeyRecord): string | null {
  if (typeof record.storedApiKey !== "string" || !storedApiKeyPattern.test(record.storedApiKey)) return null;
  return record.storedApiKey.split(".")[1] === record.keyId ? record.storedApiKey : null;
}

export function hasPermission(record: KeyRecord, permissionId: PermissionId): boolean {
  return record.keyKind === "root" || record.permissions.includes(permissionId);
}
