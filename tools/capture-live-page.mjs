#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(currentFile), "..");
const cliPath = path.join(
  workspaceRoot,
  "out",
  "browser-key-automation-local-app-windows-x86_64-dev",
  "client",
  "browser-key-cli.mjs",
);
const API_KEY_PATTERN = /^bk1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u;
const TAB_REF_PATTERN = /^tr1\.[A-Za-z0-9_-]{22}\.[1-9][0-9]*\.[A-Za-z0-9_-]{22}$/u;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MAXIMUM_CHILD_OUTPUT_BYTES = 1_000_000;
const MAXIMUM_CAPTURE_CODE_UNITS = 20_000_000;
const CHUNK_CODE_UNITS = 12_000;

class CaptureError extends Error {
  constructor(code) {
    super(code);
    this.name = "CaptureError";
    this.code = code;
  }
}

function parseArguments(values) {
  const result = { tabRef: null, label: null, outputRoot: null, mode: "full" };
  const seen = new Set();
  let index = 0;
  while (index < values.length) {
    const name = values[index];
    const value = values[index + 1];
    if (typeof name !== "string" || typeof value !== "string" || seen.has(name)) {
      throw new CaptureError("CAPTURE_USAGE");
    }
    seen.add(name);
    if (name === "--tab-ref") result.tabRef = value;
    else if (name === "--label") result.label = value;
    else if (name === "--output-root") result.outputRoot = value;
    else if (name === "--mode") result.mode = value;
    else throw new CaptureError("CAPTURE_USAGE");
    index += 2;
  }
  if (
    (values.length !== 6 && values.length !== 8) ||
    typeof result.tabRef !== "string" ||
    !TAB_REF_PATTERN.test(result.tabRef) ||
    typeof result.label !== "string" ||
    !LABEL_PATTERN.test(result.label) ||
    typeof result.outputRoot !== "string" ||
    result.outputRoot.length === 0 ||
    (result.mode !== "full" && result.mode !== "preview")
  ) {
    throw new CaptureError("CAPTURE_USAGE");
  }
  return result;
}

function runCli(apiKey, method, params) {
  const argumentsList = [
    cliPath,
    "call",
    "--method",
    method,
    "--params-json",
    JSON.stringify(params),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argumentsList, {
      cwd: workspaceRoot,
      env: { ...process.env, BKA_API_KEY: apiKey },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflowed = false;
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAXIMUM_CHILD_OUTPUT_BYTES) {
        overflowed = true;
        child.kill();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAXIMUM_CHILD_OUTPUT_BYTES) {
        overflowed = true;
        child.kill();
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", () => reject(new CaptureError("CLI_START_FAILED")));
    child.once("close", () => {
      if (overflowed) {
        reject(new CaptureError("CLI_OUTPUT_LIMIT_EXCEEDED"));
        return;
      }
      let message;
      try {
        message = JSON.parse(Buffer.concat(stdout).toString("utf8"));
      } catch {
        reject(new CaptureError("CLI_RESPONSE_INVALID"));
        return;
      }
      if (message?.ok !== true || typeof message.result !== "object" || message.result === null) {
        const code = typeof message?.error?.code === "string" ? message.error.code : "COMMAND_FAILED";
        reject(new CaptureError(code));
        return;
      }
      resolve(message.result);
    });
  });
}

async function executeJavaScript(apiKey, tabRef, code) {
  const result = await runCli(apiKey, "js.execute", {
    tabRef,
    world: "USER_SCRIPT",
    code,
    timeoutMs: 30_000,
  });
  if (
    result.status !== "fulfilled" ||
    typeof result.valueJson !== "string" ||
    result.valueTruncated !== false
  ) {
    throw new CaptureError("JAVASCRIPT_RESULT_INCOMPLETE");
  }
  try {
    return JSON.parse(result.valueJson);
  } catch {
    throw new CaptureError("JAVASCRIPT_VALUE_INVALID");
  }
}

function safeIsoTimestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function captureFrozenString({ apiKey, tabRef, propertyName, fieldName, expectedLength, outputPath }) {
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0 || expectedLength > MAXIMUM_CAPTURE_CODE_UNITS) {
    throw new CaptureError("CAPTURE_LENGTH_OUT_OF_RANGE");
  }
  const handle = await open(outputPath, "w");
  const hash = createHash("sha256");
  let offset = 0;
  let utf8Bytes = 0;
  let chunks = 0;
  try {
    while (offset < expectedLength) {
      const code = `(() => { const state = globalThis[${JSON.stringify(propertyName)}]; if (!state) throw new Error("CAPTURE_STATE_MISSING"); const value = state[${JSON.stringify(fieldName)}]; const offset = ${offset}; let end = Math.min(value.length, offset + ${CHUNK_CODE_UNITS}); if (end < value.length) { const tail = value.charCodeAt(end - 1); if (tail >= 0xD800 && tail <= 0xDBFF) end -= 1; } return { offset, nextOffset: end, totalLength: value.length, chunk: value.slice(offset, end) }; })()`;
      const result = await executeJavaScript(apiKey, tabRef, code);
      if (
        result?.offset !== offset ||
        result?.totalLength !== expectedLength ||
        !Number.isSafeInteger(result?.nextOffset) ||
        result.nextOffset <= offset ||
        result.nextOffset > expectedLength ||
        typeof result?.chunk !== "string" ||
        result.chunk.length !== result.nextOffset - offset
      ) {
        throw new CaptureError("CAPTURE_CHUNK_INVALID");
      }
      const encoded = Buffer.from(result.chunk, "utf8");
      await handle.write(encoded);
      hash.update(encoded);
      utf8Bytes += encoded.length;
      chunks += 1;
      offset = result.nextOffset;
    }
  } finally {
    await handle.close();
  }
  return { codeUnits: offset, utf8Bytes, chunks, sha256: hash.digest("hex") };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const apiKey = process.env.BKA_API_KEY;
  if (typeof apiKey !== "string" || !API_KEY_PATTERN.test(apiKey)) {
    throw new CaptureError("API_KEY_UNAVAILABLE");
  }

  const outputRoot = path.resolve(args.outputRoot);
  const preview = await runCli(apiKey, "page.dom.get", { root: "document", tabRef: args.tabRef });
  if (
    typeof preview.url !== "string" ||
    typeof preview.urlTruncated !== "boolean" ||
    typeof preview.html !== "string" ||
    typeof preview.htmlTruncated !== "boolean"
  ) {
    throw new CaptureError("CAPTURE_PREVIEW_INVALID");
  }

  const outputDirectory = path.join(outputRoot, `${safeIsoTimestamp()}-${args.label}`);
  await mkdir(outputDirectory, { recursive: false });
  const previewBytes = Buffer.from(preview.html, "utf8");
  const previewSha256 = createHash("sha256").update(previewBytes).digest("hex");
  await writeFile(path.join(outputDirectory, "dom-api-preview.html"), previewBytes);
  const previewMetadata = {
    captureVersion: 1,
    kind: "chromium-live-dom-preview",
    sensitivity: "private-browser-content",
    label: args.label,
    tabRef: args.tabRef,
    captureStatus: "preview-only",
    requestedMode: args.mode,
    standardDomApi: {
      url: preview.url,
      urlTruncated: preview.urlTruncated,
      htmlTruncated: preview.htmlTruncated,
      previewUtf8Bytes: previewBytes.length,
    },
    files: {
      domApiPreview: {
        name: "dom-api-preview.html",
        utf8Bytes: previewBytes.length,
        sha256: previewSha256,
      },
    },
    captureMethod: {
      snapshot: "page.dom.get bounded live DOM preview",
      note: "Live DOM at capture time; not the original network response or MHTML. A truncated preview is not a full-page sample.",
    },
  };
  await writeFile(
    path.join(outputDirectory, "metadata.json"),
    `${JSON.stringify(previewMetadata, null, 2)}\n`,
    "utf8",
  );
  if (args.mode === "preview") {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      captureStatus: "preview-only",
      outputDirectory,
      url: preview.url,
      previewUtf8Bytes: previewMetadata.standardDomApi.previewUtf8Bytes,
      standardPreviewTruncated: preview.htmlTruncated,
    })}\n`);
    return;
  }

  const propertyName = `__bkaCapture_${randomBytes(16).toString("base64url")}`;
  const freezeCode = `(() => { const html = document.documentElement?.outerHTML ?? ""; const visibleText = document.body?.innerText ?? ""; const state = { html, visibleText }; globalThis[${JSON.stringify(propertyName)}] = state; return { capturedAt: new Date().toISOString(), href: location.href, title: document.title, readyState: document.readyState, language: document.documentElement?.lang ?? "", nodeCount: document.getElementsByTagName("*").length, htmlCodeUnits: html.length, htmlUtf8Bytes: new TextEncoder().encode(html).byteLength, visibleTextCodeUnits: visibleText.length, visibleTextUtf8Bytes: new TextEncoder().encode(visibleText).byteLength }; })()`;

  let frozen;
  let htmlCapture;
  let textCapture;
  try {
    frozen = await executeJavaScript(apiKey, args.tabRef, freezeCode);
    htmlCapture = await captureFrozenString({
      apiKey,
      tabRef: args.tabRef,
      propertyName,
      fieldName: "html",
      expectedLength: frozen.htmlCodeUnits,
      outputPath: path.join(outputDirectory, "live-dom.html"),
    });
    textCapture = await captureFrozenString({
      apiKey,
      tabRef: args.tabRef,
      propertyName,
      fieldName: "visibleText",
      expectedLength: frozen.visibleTextCodeUnits,
      outputPath: path.join(outputDirectory, "visible-text.txt"),
    });
  } catch (error) {
    const code = error instanceof CaptureError ? error.code : "CAPTURE_INTERNAL_ERROR";
    await writeFile(
      path.join(outputDirectory, "metadata.json"),
      `${JSON.stringify({ ...previewMetadata, fullCaptureError: code }, null, 2)}\n`,
      "utf8",
    );
    throw error;
  } finally {
    const cleanupCode = `delete globalThis[${JSON.stringify(propertyName)}]`;
    await executeJavaScript(apiKey, args.tabRef, cleanupCode).catch(() => undefined);
  }

  if (
    htmlCapture.codeUnits !== frozen.htmlCodeUnits ||
    htmlCapture.utf8Bytes !== frozen.htmlUtf8Bytes ||
    textCapture.codeUnits !== frozen.visibleTextCodeUnits ||
    textCapture.utf8Bytes !== frozen.visibleTextUtf8Bytes
  ) {
    throw new CaptureError("CAPTURE_INTEGRITY_MISMATCH");
  }

  const metadata = {
    captureVersion: 1,
    kind: "chromium-live-dom",
    sensitivity: "private-browser-content",
    label: args.label,
    tabRef: args.tabRef,
    captureStatus: "full",
    requestedMode: args.mode,
    page: frozen,
    standardDomApi: {
      url: preview.url,
      urlTruncated: preview.urlTruncated,
      htmlTruncated: preview.htmlTruncated,
      previewUtf8Bytes: Buffer.byteLength(preview.html, "utf8"),
    },
    files: {
      liveDom: { name: "live-dom.html", ...htmlCapture },
      visibleText: { name: "visible-text.txt", ...textCapture },
      domApiPreview: previewMetadata.files.domApiPreview,
    },
    captureMethod: {
      snapshot: "frozen string in extension USER_SCRIPT world",
      transferChunkCodeUnits: CHUNK_CODE_UNITS,
      note: "Live DOM at capture time; not the original network response or MHTML.",
    },
  };
  await writeFile(path.join(outputDirectory, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    outputDirectory,
    title: frozen.title,
    url: frozen.href,
    nodeCount: frozen.nodeCount,
    htmlUtf8Bytes: htmlCapture.utf8Bytes,
    visibleTextUtf8Bytes: textCapture.utf8Bytes,
    standardPreviewTruncated: preview.htmlTruncated,
  })}\n`);
}

main().catch((error) => {
  const code = error instanceof CaptureError ? error.code : "CAPTURE_INTERNAL_ERROR";
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code } })}\n`);
  process.exitCode = 1;
});
