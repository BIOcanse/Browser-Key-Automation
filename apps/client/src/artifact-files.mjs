import { createHash, randomBytes } from "node:crypto";
import { link, lstat, open, unlink } from "node:fs/promises";
import path from "node:path";

export class ArtifactFileError extends Error {
  constructor(code, details) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

export async function assertNewOutput(output) {
  if (typeof output !== "string" || output.trim() === "") throw new ArtifactFileError("OUTPUT_PATH_REQUIRED");
  const destination = path.resolve(output);
  try {
    await lstat(destination);
    throw new ArtifactFileError("OUTPUT_EXISTS", { output: destination });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return destination;
}

// call is one authenticated, instance-bound extension session. It returns the
// command result or throws; this module knows neither a Key nor relay routing.
export async function savePageFile({ call, tabRef, output }) {
  return saveCaptureFile({ call, method: "page.archive.capture", params: { tabRef }, output });
}

export async function saveScreenshotFile({ call, tabRef, output, format, quality }) {
  // Omit absent options so the extension expands its registered defaults once.
  const params = { tabRef, ...(format === undefined ? {} : { format }), ...(quality === undefined ? {} : { quality }) };
  return saveCaptureFile({ call, method: "page.screenshot.capture", params, output });
}

async function saveCaptureFile({ call, method, params, output }) {
  const destination = await assertNewOutput(output);
  const captured = await call(method, params);
  if (typeof captured?.artifact?.artifactRef !== "string") throw new ArtifactFileError("CAPTURE_RESULT_INVALID");
  try {
    return await saveArtifactFile({ call, artifactRef: captured.artifact.artifactRef, output: destination });
  } catch (error) {
    error.details = { ...error.details, artifactRef: captured.artifact.artifactRef, output: destination };
    throw error;
  }
}

export async function saveArtifactFile({ call, artifactRef, output }) {
  const destination = await assertNewOutput(output);
  const temporary = `${destination}.bka-part-${randomBytes(12).toString("hex")}`;
  let handle;
  let ownsTemporary = false;
  let published = false;
  try {
    handle = await open(temporary, "wx");
    ownsTemporary = true;
    const hash = createHash("sha256");
    let offset = 0;
    let metadata;
    while (true) {
      // The extension owns the default chunk size; no duplicated client limit.
      const chunk = await call("artifact.read", { artifactRef, offset });
      const bytes = validateChunk(chunk, artifactRef, offset, metadata);
      metadata ??= { byteLength: chunk.byteLength, sha256: chunk.sha256, mediaType: chunk.mediaType };
      await handle.writeFile(bytes);
      hash.update(bytes);
      offset += bytes.length;
      if (chunk.nextOffset === null) break;
    }
    if (offset !== metadata.byteLength || hash.digest("hex") !== metadata.sha256) {
      throw new ArtifactFileError("ARTIFACT_INTEGRITY_FAILED");
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Same-directory hard-link publication is atomic and never replaces an
    // existing destination. A concurrent creator is safe; no overwrite flag.
    await link(temporary, destination);
    published = true;
    return { output: destination, artifactRef, ...metadata };
  } catch (error) {
    const failure = error instanceof ArtifactFileError || typeof error?.delivery === "string"
      ? error
      : new ArtifactFileError(error?.code === "EEXIST" ? "OUTPUT_EXISTS" : "FILE_SAVE_FAILED", {
        ...(typeof error?.code === "string" ? { systemCode: error.code } : {}),
      });
    failure.details = { ...failure.details, artifactRef, output: destination, saved: published };
    throw failure;
  } finally {
    await handle?.close().catch(() => undefined);
    if (ownsTemporary) await unlink(temporary).catch(() => undefined);
  }
}

function validateChunk(chunk, artifactRef, offset, metadata) {
  if (chunk?.artifactRef !== artifactRef || chunk.offset !== offset ||
      !Number.isSafeInteger(chunk.byteLength) || chunk.byteLength < offset ||
      typeof chunk.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(chunk.sha256) ||
      typeof chunk.mediaType !== "string" || typeof chunk.dataBase64Url !== "string" ||
      !/^[A-Za-z0-9_-]*$/u.test(chunk.dataBase64Url)) {
    throw new ArtifactFileError("ARTIFACT_CHUNK_INVALID");
  }
  if (metadata && (chunk.byteLength !== metadata.byteLength || chunk.sha256 !== metadata.sha256 ||
      chunk.mediaType !== metadata.mediaType)) throw new ArtifactFileError("ARTIFACT_METADATA_CHANGED");
  const bytes = Buffer.from(chunk.dataBase64Url, "base64url");
  const end = offset + bytes.length;
  if (bytes.toString("base64url") !== chunk.dataBase64Url || end > chunk.byteLength ||
      (end === chunk.byteLength ? chunk.nextOffset !== null : chunk.nextOffset !== end || bytes.length === 0)) {
    throw new ArtifactFileError("ARTIFACT_CHUNK_INVALID");
  }
  return bytes;
}
