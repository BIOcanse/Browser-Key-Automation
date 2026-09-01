#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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
const API_KEY_SEARCH_PATTERN = /bk1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/u;
const TAB_REF_PATTERN = /^tr1\.[A-Za-z0-9_-]{22}\.[1-9][0-9]*\.[A-Za-z0-9_-]{22}$/u;
const INSTANCE_REF_PATTERN = /^[A-Za-z0-9_-]{22}\/[1-9][0-9]*$/u;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MAXIMUM_CHILD_OUTPUT_BYTES = 16_000_000;

class CaptureError extends Error {
  constructor(code) {
    super(code);
    this.name = "CaptureError";
    this.code = code;
  }
}

function parseArguments(values) {
  const result = { tabRef: null, instance: null, label: null, outputRoot: null };
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
    else if (name === "--instance") result.instance = value;
    else if (name === "--label") result.label = value;
    else if (name === "--output-root") result.outputRoot = value;
    else throw new CaptureError("CAPTURE_USAGE");
    index += 2;
  }
  if (
    values.length !== 8 ||
    typeof result.tabRef !== "string" ||
    !TAB_REF_PATTERN.test(result.tabRef) ||
    typeof result.instance !== "string" ||
    !INSTANCE_REF_PATTERN.test(result.instance) ||
    typeof result.label !== "string" ||
    !LABEL_PATTERN.test(result.label) ||
    typeof result.outputRoot !== "string" ||
    result.outputRoot.length === 0
  ) {
    throw new CaptureError("CAPTURE_USAGE");
  }
  return result;
}

function runCli(apiKey, instance, method, schemaVersion, params) {
  const argumentsList = [
    cliPath,
    "call",
    "--method",
    method,
    "--schema-version",
    String(schemaVersion),
    "--params-json",
    JSON.stringify(params),
    "--instance",
    instance,
    "--read-timeout-ms",
    "20000",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argumentsList, {
      cwd: workspaceRoot,
      env: { ...process.env, BKA_API_KEY: apiKey },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    let stdoutBytes = 0;
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
    child.stderr.resume();
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

function safeIsoTimestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const apiKey = process.env.BKA_API_KEY;
  if (typeof apiKey !== "string" || !API_KEY_PATTERN.test(apiKey)) {
    throw new CaptureError("API_KEY_UNAVAILABLE");
  }

  const opened = await runCli(apiKey, args.instance, "page.tree.open", 1, {
    targetRef: args.tabRef,
  });
  const level0 = await runCli(apiKey, args.instance, "page.tree.view.get", 1, {
    rootRef: opened.rootRef,
    maximumLevel: 0,
  });
  const expanded = await runCli(apiKey, args.instance, "page.tree.view.get", 1, {
    rootRef: opened.rootRef,
  });

  let firstMainSubtree = null;
  let itemIndex = 0;
  while (itemIndex < expanded.items.length) {
    const item = expanded.items[itemIndex];
    if (item?.kind === "element" && item?.role === "main" && Array.isArray(item.indexPath)) {
      firstMainSubtree = await runCli(apiKey, args.instance, "page.tree.view.get", 1, {
        rootRef: opened.rootRef,
        subtree: item.indexPath,
      });
      break;
    }
    itemIndex += 1;
  }

  const capturedAt = new Date().toISOString();
  const snapshot = {
    snapshotVersion: 1,
    kind: "chromium-live-operation-tree",
    sensitivity: "private-browser-content",
    capturedAt,
    label: args.label,
    source: {
      instance: args.instance,
      tabRef: args.tabRef,
      note: "One bounded snapshot of the calling Key's existing expansion state; no node was expanded by this capture tool.",
    },
    open: opened,
    views: {
      maximumLevel0: level0,
      expandedOutline: expanded,
      firstMainSubtree,
    },
  };
  const snapshotJson = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (API_KEY_SEARCH_PATTERN.test(snapshotJson)) {
    throw new CaptureError("SECRET_FOUND_IN_SNAPSHOT");
  }

  const outputDirectory = path.join(
    path.resolve(args.outputRoot),
    `${safeIsoTimestamp()}-${args.label}`,
  );
  await mkdir(outputDirectory, { recursive: false });
  const snapshotName = "operation-tree.json";
  await writeFile(path.join(outputDirectory, snapshotName), snapshotJson, "utf8");

  const snapshotBytes = Buffer.byteLength(snapshotJson, "utf8");
  const metadata = {
    captureVersion: 1,
    kind: "chromium-live-operation-tree",
    sensitivity: "private-browser-content",
    capturedAt,
    label: args.label,
    page: {
      title: opened.title,
      url: opened.url,
      documentRef: opened.documentRef,
      rootRef: opened.rootRef,
      reused: opened.reused,
    },
    views: {
      maximumLevel0Items: level0.items.length,
      expandedOutlineItems: expanded.items.length,
      expandedOutlineTruncated: expanded.truncated,
      firstMainSubtreeItems: firstMainSubtree?.items.length ?? null,
      firstMainSubtreeTruncated: firstMainSubtree?.truncated ?? null,
    },
    files: {
      operationTree: {
        name: snapshotName,
        utf8Bytes: snapshotBytes,
        sha256: sha256(snapshotJson),
      },
    },
    captureMethod: {
      commands: ["page.tree.open.v1", "page.tree.view.get.v1"],
      note: "Live operation-tree projection at capture time; not a DOM serialization and not an original network response.",
    },
  };
  const metadataJson = `${JSON.stringify(metadata, null, 2)}\n`;
  if (API_KEY_SEARCH_PATTERN.test(metadataJson)) {
    throw new CaptureError("SECRET_FOUND_IN_METADATA");
  }
  await writeFile(path.join(outputDirectory, "metadata.json"), metadataJson, "utf8");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    outputDirectory,
    title: opened.title,
    expandedOutlineItems: expanded.items.length,
    expandedOutlineTruncated: expanded.truncated,
    firstMainSubtreeItems: firstMainSubtree?.items.length ?? null,
    snapshotUtf8Bytes: snapshotBytes,
    snapshotSha256: metadata.files.operationTree.sha256,
  })}\n`);
}

main().catch((error) => {
  const code = error instanceof CaptureError ? error.code : "CAPTURE_INTERNAL_ERROR";
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code } })}\n`);
  process.exitCode = 1;
});
