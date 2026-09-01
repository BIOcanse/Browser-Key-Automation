import type { SecretVerifier } from "./key-model.js";

const KEY_ID_BYTE_LENGTH = 16;
const SECRET_BYTE_LENGTH = 32;
const SALT_BYTE_LENGTH = 16;
const DOMAIN_SEPARATOR = new TextEncoder().encode("browser-key-automation/key-verifier/sha256-v1\0");

export interface GeneratedKeyMaterial {
  readonly keyId: string;
  readonly apiKey: string;
  readonly verifier: SecretVerifier;
}

export interface ParsedApiKey {
  readonly keyId: string;
  readonly keyIdBytes: Uint8Array<ArrayBuffer>;
  readonly secretBytes: Uint8Array<ArrayBuffer>;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  let index = 0;
  while (index < bytes.length) {
    binary += String.fromCharCode(bytes[index] ?? 0);
    index += 1;
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) return null;
  const remainder = value.length % 4;
  if (remainder === 1) return null;
  const padding = remainder === 0 ? "" : "=".repeat(4 - remainder);
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
    const bytes = new Uint8Array(binary.length);
    let index = 0;
    while (index < binary.length) {
      bytes[index] = binary.charCodeAt(index);
      index += 1;
    }
    return encodeBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function encodeLength(length: number): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, length, false);
  return output;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let totalLength = 0;
  let index = 0;
  while (index < parts.length) {
    totalLength += parts[index]?.byteLength ?? 0;
    index += 1;
  }
  const output = new Uint8Array(totalLength);
  let offset = 0;
  index = 0;
  while (index < parts.length) {
    const part = parts[index];
    if (part !== undefined) {
      output.set(part, offset);
      offset += part.byteLength;
    }
    index += 1;
  }
  return output;
}

async function verifierDigest(
  keyIdBytes: Uint8Array,
  saltBytes: Uint8Array,
  secretBytes: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const input = concatenate([
    DOMAIN_SEPARATOR,
    encodeLength(keyIdBytes.byteLength),
    keyIdBytes,
    encodeLength(saltBytes.byteLength),
    saltBytes,
    encodeLength(secretBytes.byteLength),
    secretBytes,
  ]);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

export function parseApiKey(value: string): ParsedApiKey | null {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "bk1") return null;
  const keyIdBytes = decodeBase64Url(parts[1] ?? "");
  const secretBytes = decodeBase64Url(parts[2] ?? "");
  if (keyIdBytes?.byteLength !== KEY_ID_BYTE_LENGTH || secretBytes?.byteLength !== SECRET_BYTE_LENGTH) return null;
  return { keyId: parts[1] ?? "", keyIdBytes, secretBytes };
}

export async function generateKeyMaterial(): Promise<GeneratedKeyMaterial> {
  const keyIdBytes = randomBytes(KEY_ID_BYTE_LENGTH);
  const secretBytes = randomBytes(SECRET_BYTE_LENGTH);
  const saltBytes = randomBytes(SALT_BYTE_LENGTH);
  const keyId = encodeBase64Url(keyIdBytes);
  const secret = encodeBase64Url(secretBytes);
  const digest = await verifierDigest(keyIdBytes, saltBytes, secretBytes);
  return {
    keyId,
    apiKey: `bk1.${keyId}.${secret}`,
    verifier: {
      version: "sha256-v1",
      salt: encodeBase64Url(saltBytes),
      digest: encodeBase64Url(digest),
    },
  };
}

export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  let index = 0;
  while (index < left.byteLength) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
    index += 1;
  }
  return difference === 0;
}

export async function verifyParsedApiKey(parsed: ParsedApiKey, verifier: SecretVerifier): Promise<boolean> {
  if (verifier.version !== "sha256-v1") return false;
  const salt = decodeBase64Url(verifier.salt);
  const expectedDigest = decodeBase64Url(verifier.digest);
  if (salt?.byteLength !== SALT_BYTE_LENGTH || expectedDigest?.byteLength !== 32) return false;
  const actualDigest = await verifierDigest(parsed.keyIdBytes, salt, parsed.secretBytes);
  return constantTimeEqual(actualDigest, expectedDigest);
}

export async function digestCanonicalText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return encodeBase64Url(new Uint8Array(digest));
}
