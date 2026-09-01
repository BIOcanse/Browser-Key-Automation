import { COMMAND_CATALOG } from "../generated/command-config.js";

export const ADMIN_PORT_NAME = "browser-key-automation.admin.v1";
export const CURRENT_PERMISSION_IDS = COMMAND_CATALOG.activePermissionIds;

export type PermissionId = (typeof CURRENT_PERMISSION_IDS)[number];
export type KeyKind = "root" | "regular";
export type KeyStatus = "active" | "revoked";

export interface PublicKeyRecord {
  readonly keyId: string;
  readonly displayName: string;
  readonly keyKind: KeyKind;
  readonly secretAvailable: boolean;
  readonly permissions: readonly PermissionId[];
  readonly expiresAt: number | null;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly status: KeyStatus;
  readonly revokedAt: number | null;
  readonly recordRevision: number;
  readonly credentialRevision: number;
  readonly authorizationRevision: number;
  readonly controlEligibilityRevision: number;
}

export interface CreateKeyParams {
  readonly mutationId: string;
  readonly displayName: string;
  readonly keyKind: KeyKind;
  readonly permissions: readonly PermissionId[];
  readonly expiresAt: number | null;
  readonly enabled: boolean;
}

export interface CreateKeyResult {
  readonly key: PublicKeyRecord;
  readonly apiKey: string;
}

export interface ListKeysParams {
  readonly afterKeyId: string | null;
  readonly limit: number;
}

export interface ListKeysResult {
  readonly items: readonly PublicKeyRecord[];
  readonly nextAfterKeyId: string | null;
}

export interface RevealKeyParams {
  readonly keyId: string;
}

export interface RevealKeyResult {
  readonly keyId: string;
  readonly apiKey: string;
}

export interface AttachKeySecretParams {
  readonly mutationId: string;
  readonly keyId: string;
  readonly apiKey: string;
}

export interface UpdateKeyPatch {
  readonly displayName: string;
  readonly permissions: readonly PermissionId[];
  readonly expiresAt: number | null;
  readonly enabled: boolean;
}

export interface UpdateKeyParams {
  readonly mutationId: string;
  readonly keyId: string;
  readonly expectedRevision: number;
  readonly patch: UpdateKeyPatch;
}

export interface RevokeKeyParams {
  readonly mutationId: string;
  readonly keyId: string;
  readonly expectedRevision: number;
}

export interface AdminMethodMap {
  readonly "keys.create": { readonly params: CreateKeyParams; readonly result: CreateKeyResult };
  readonly "keys.list": { readonly params: ListKeysParams; readonly result: ListKeysResult };
  readonly "keys.reveal": { readonly params: RevealKeyParams; readonly result: RevealKeyResult };
  readonly "keys.attachSecret": { readonly params: AttachKeySecretParams; readonly result: PublicKeyRecord };
  readonly "keys.update": { readonly params: UpdateKeyParams; readonly result: PublicKeyRecord };
  readonly "keys.revoke": { readonly params: RevokeKeyParams; readonly result: PublicKeyRecord };
}

export type AdminMethod = keyof AdminMethodMap;

export type AdminRequest = {
  [Method in AdminMethod]: {
    readonly requestId: string;
    readonly method: Method;
    readonly params: AdminMethodMap[Method]["params"];
  };
}[AdminMethod];

export type AdminErrorCode =
  | "ADMIN_MUTATION_CONFLICT"
  | "INTERNAL_ERROR"
  | "KEY_NOT_FOUND"
  | "KEY_REVOKED"
  | "KEY_SECRET_MISMATCH"
  | "REVISION_CONFLICT"
  | "SCHEMA_INVALID"
  | "SECRET_NOT_RECOVERABLE"
  | "STORAGE_UNAVAILABLE";

export interface AdminError {
  readonly code: AdminErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}

export type AdminResponse =
  | { readonly requestId: string; readonly ok: true; readonly result: unknown }
  | { readonly requestId: string; readonly ok: false; readonly error: AdminError };

const requestIdPattern = /^ui1\.[A-Za-z0-9_-]{22}$/u;
const mutationIdPattern = /^am1\.\d{13}\.[A-Za-z0-9_-]{22}$/u;
const keyIdPattern = /^[A-Za-z0-9_-]{22}$/u;
const apiKeyPattern = /^bk1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== allowedKeys.length) return false;
  let index = 0;
  while (index < actualKeys.length) {
    if (!allowedKeys.includes(actualKeys[index] ?? "")) return false;
    index += 1;
  }
  return true;
}

function isSafeRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 1;
}

function isExpiry(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isDisplayName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 1 && value.trim().length <= 128;
}

function isPermissionList(value: unknown): value is readonly PermissionId[] {
  if (!Array.isArray(value) || value.length > CURRENT_PERMISSION_IDS.length) return false;
  const seen = new Set<string>();
  let index = 0;
  while (index < value.length) {
    const item = value[index];
    if (typeof item !== "string" || !CURRENT_PERMISSION_IDS.includes(item as PermissionId) || seen.has(item)) {
      return false;
    }
    seen.add(item);
    index += 1;
  }
  return true;
}

function isCreateParams(value: unknown): value is CreateKeyParams {
  if (!isObject(value) || !hasOnlyKeys(value, ["mutationId", "displayName", "keyKind", "permissions", "expiresAt", "enabled"])) return false;
  return (
    typeof value.mutationId === "string" && mutationIdPattern.test(value.mutationId) &&
    isDisplayName(value.displayName) &&
    (value.keyKind === "root" || value.keyKind === "regular") &&
    isPermissionList(value.permissions) &&
    isExpiry(value.expiresAt) &&
    typeof value.enabled === "boolean"
  );
}

function isListParams(value: unknown): value is ListKeysParams {
  if (!isObject(value) || !hasOnlyKeys(value, ["afterKeyId", "limit"])) return false;
  return (
    (value.afterKeyId === null || (typeof value.afterKeyId === "string" && keyIdPattern.test(value.afterKeyId))) &&
    typeof value.limit === "number" && Number.isSafeInteger(value.limit) && value.limit >= 1 && value.limit <= 100
  );
}

function isRevealParams(value: unknown): value is RevealKeyParams {
  return isObject(value) && hasOnlyKeys(value, ["keyId"]) &&
    typeof value.keyId === "string" && keyIdPattern.test(value.keyId);
}

function isAttachSecretParams(value: unknown): value is AttachKeySecretParams {
  if (!isObject(value) || !hasOnlyKeys(value, ["mutationId", "keyId", "apiKey"])) return false;
  return (
    typeof value.mutationId === "string" && mutationIdPattern.test(value.mutationId) &&
    typeof value.keyId === "string" && keyIdPattern.test(value.keyId) &&
    typeof value.apiKey === "string" && apiKeyPattern.test(value.apiKey)
  );
}

function isUpdatePatch(value: unknown): value is UpdateKeyPatch {
  if (!isObject(value) || !hasOnlyKeys(value, ["displayName", "permissions", "expiresAt", "enabled"])) return false;
  return isDisplayName(value.displayName) && isPermissionList(value.permissions) && isExpiry(value.expiresAt) && typeof value.enabled === "boolean";
}

function isUpdateParams(value: unknown): value is UpdateKeyParams {
  if (!isObject(value) || !hasOnlyKeys(value, ["mutationId", "keyId", "expectedRevision", "patch"])) return false;
  return (
    typeof value.mutationId === "string" && mutationIdPattern.test(value.mutationId) &&
    typeof value.keyId === "string" && keyIdPattern.test(value.keyId) &&
    isSafeRevision(value.expectedRevision) &&
    isUpdatePatch(value.patch)
  );
}

function isRevokeParams(value: unknown): value is RevokeKeyParams {
  if (!isObject(value) || !hasOnlyKeys(value, ["mutationId", "keyId", "expectedRevision"])) return false;
  return (
    typeof value.mutationId === "string" && mutationIdPattern.test(value.mutationId) &&
    typeof value.keyId === "string" && keyIdPattern.test(value.keyId) &&
    isSafeRevision(value.expectedRevision)
  );
}

export function parseAdminRequest(value: unknown): AdminRequest | null {
  if (!isObject(value) || !hasOnlyKeys(value, ["requestId", "method", "params"])) return null;
  if (typeof value.requestId !== "string" || !requestIdPattern.test(value.requestId)) return null;
  if (value.method === "keys.create" && isCreateParams(value.params)) return value as unknown as AdminRequest;
  if (value.method === "keys.list" && isListParams(value.params)) return value as unknown as AdminRequest;
  if (value.method === "keys.reveal" && isRevealParams(value.params)) return value as unknown as AdminRequest;
  if (value.method === "keys.attachSecret" && isAttachSecretParams(value.params)) return value as unknown as AdminRequest;
  if (value.method === "keys.update" && isUpdateParams(value.params)) return value as unknown as AdminRequest;
  if (value.method === "keys.revoke" && isRevokeParams(value.params)) return value as unknown as AdminRequest;
  return null;
}
