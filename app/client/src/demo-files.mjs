import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import { TRANSPORT } from "./generated-config.mjs";

export class DemoFileError extends Error {
  constructor(code, details) { super(code); this.code = code; this.details = details; }
}

// The call owns one authenticated extension session. The extension owns the
// upload reference, capacity, chunk size, completion and tab effects.
export async function openDemoFile({ call, file, tabRef, active, windowId }) {
  if (typeof file !== "string" || !file.trim()) throw new DemoFileError("INPUT_PATH_REQUIRED");
  const input = path.resolve(file);
  let handle;
  let artifactRef;
  try {
    handle = await open(input, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size)) throw new DemoFileError("INPUT_FILE_REQUIRED");
    const upload = await call("artifact.upload.begin", { byteLength: stat.size, mediaType: "text/html" });
    artifactRef = upload?.artifactRef;
    if (typeof artifactRef !== "string" || !/^ar1\.[A-Za-z0-9_-]{43}$/u.test(artifactRef) ||
        upload.byteLength !== stat.size || !Number.isSafeInteger(upload.chunkBytes) || upload.chunkBytes < 1 ||
        upload.chunkBytes > Math.floor(TRANSPORT.maximumMessageBytes / 4) * 3 || upload.receivedBytes !== 0) {
      throw new DemoFileError("UPLOAD_RESULT_INVALID");
    }
    const buffer = Buffer.alloc(upload.chunkBytes);
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < stat.size) {
      const length = Math.min(buffer.length, stat.size - offset);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
        if (bytesRead === 0) throw new DemoFileError("INPUT_FILE_CHANGED");
        filled += bytesRead;
      }
      const bytes = buffer.subarray(0, length);
      hash.update(bytes);
      const appended = await call("artifact.upload.append", { artifactRef, offset, dataBase64Url: bytes.toString("base64url") });
      offset += length;
      if (appended?.artifactRef !== artifactRef || appended.receivedBytes !== offset) throw new DemoFileError("UPLOAD_RESULT_INVALID");
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, stat.size)).bytesRead !== 0) throw new DemoFileError("INPUT_FILE_CHANGED");
    const sha256 = hash.digest("hex");
    const committed = await call("artifact.upload.commit", { artifactRef, sha256 });
    if (committed?.artifact?.artifactRef !== artifactRef || committed.artifact.byteLength !== stat.size ||
        committed.artifact.sha256 !== sha256 || committed.artifact.mediaType !== "text/html") {
      throw new DemoFileError("UPLOAD_RESULT_INVALID");
    }
    const opened = await call("demo.open", { artifactRef, ...(tabRef === undefined ? {} : { tabRef }),
      ...(active === undefined ? {} : { active }), ...(windowId === undefined ? {} : { windowId }) });
    return { input, ...opened };
  } catch (error) {
    const failure = error instanceof DemoFileError || typeof error?.delivery === "string"
      ? error : new DemoFileError("FILE_UPLOAD_FAILED", { ...(typeof error?.code === "string" ? { systemCode: error.code } : {}) });
    failure.details = { ...failure.details, input, ...(artifactRef === undefined ? {} : { artifactRef }) };
    throw failure;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
