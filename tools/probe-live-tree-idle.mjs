#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(workspace, "apps/client/src/main.mjs");
const keyShape = /bk1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/u;
const allowedMethods = new Set(["tabs.list", "page.tree.open", "page.tree.expand", "page.tree.view.get"]);

function runCli(argumentsList) {
  let output;
  try {
    output = execFileSync(process.execPath, [cli, ...argumentsList], {
      cwd: workspace,
      windowsHide: true,
      timeout: 25_000,
      maxBuffer: 1_000_000,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (error) {
    if (typeof error.stdout !== "string" || !error.stdout.trim()) throw new Error("CLI_NO_RESPONSE");
    output = error.stdout;
  }
  if (keyShape.test(output)) throw new Error("SECRET_IN_RESPONSE");
  return JSON.parse(output);
}

function expandedPaths(view) {
  return view.items.filter((item) => item.expanded).map((item) => item.indexPath.join("."));
}

async function main() {
  const { values } = parseArgs({ options: {
    "output-root": { type: "string" },
    "page-url": { type: "string" },
  } });
  assert.equal(typeof values["output-root"], "string", "OUTPUT_ROOT_REQUIRED");
  assert.equal(typeof values["page-url"], "string", "PAGE_URL_REQUIRED");

  const instances = runCli(["instances"]);
  assert.equal(instances.ok, true, "RELAY_UNAVAILABLE");
  assert.equal(instances.instances.length, 1, "EXACTLY_ONE_INSTANCE_REQUIRED");
  const instance = `${instances.relayEpoch}/${instances.instances[0].instanceNumber}`;
  if (!/^bk1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u.test(process.env.BKA_API_KEY ?? "")) {
    throw new Error("KEY_UNAVAILABLE");
  }

  const outputDirectory = path.join(path.resolve(values["output-root"]),
    `${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}-tree-idle`);
  await mkdir(outputDirectory);
  const transcriptPath = path.join(outputDirectory, "interaction.jsonl");
  const digest = createHash("sha256");
  let sequence = 0;
  let bytes = 0;
  await writeFile(transcriptPath, "", { flag: "wx" });

  async function call(method, params, tolerateError = false) {
    assert.ok(allowedMethods.has(method), "READ_ONLY_PROBE_METHOD");
    const schemaVersion = method === "page.tree.expand" ? 2 : 1;
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const response = runCli(["call", "--method", method, "--schema-version", String(schemaVersion),
      "--params-json", JSON.stringify(params), "--instance", instance, "--read-timeout-ms", "20000"]);
    sequence += 1;
    const record = { sequence, startedAt, elapsedMs: Math.round(performance.now() - start),
      request: { method, schemaVersion, params }, response };
    const line = `${JSON.stringify(record)}\n`;
    if (keyShape.test(line)) throw new Error("SECRET_IN_TRANSCRIPT");
    digest.update(line);
    bytes += Buffer.byteLength(line);
    await appendFile(transcriptPath, line);
    if (!response.ok && !tolerateError) throw new Error(`${method}:${response.error?.code ?? "COMMAND_FAILED"}`);
    return response;
  }

  const tabs = (await call("tabs.list", { afterTabId: null, limit: 100 })).result;
  const matches = tabs.items.filter((tab) => tab.url === values["page-url"]);
  assert.equal(matches.length, 1, "EXACTLY_ONE_MATCHING_TAB_REQUIRED");
  const tab = matches[0];
  const opened = (await call("page.tree.open", { targetRef: tab.tabRef })).result;
  const view0 = (await call("page.tree.view.get", { rootRef: opened.rootRef, maximumLevel: 0 })).result;
  const html = view0.items.find((item) => item.kind === "element" && item.name === "HTML");
  assert.ok(html?.treeRef, "HTML_REF_MISSING");
  await call("page.tree.expand", { treeRef: html.treeRef });
  const view1 = (await call("page.tree.view.get", { rootRef: opened.rootRef, maximumLevel: 1 })).result;
  const body = view1.items.find((item) => item.kind === "element" && item.name === "BODY");
  assert.ok(body?.treeRef, "BODY_REF_MISSING");
  await call("page.tree.expand", { treeRef: body.treeRef });
  const before = (await call("page.tree.view.get", { rootRef: opened.rootRef, maximumLevel: 2 })).result;
  const idleStartedAt = new Date().toISOString();
  const idleStart = performance.now();
  process.stdout.write(`${JSON.stringify({ stage: "idle-start", outputDirectory, instance, rootRef: opened.rootRef,
    reused: opened.reused, bodyIndexPath: body.indexPath, beforeRows: before.items.length,
    expandedPaths: expandedPaths(before), idleMs: 45_000 })}\n`);

  await delay(45_000);
  const actualIdleMs = Math.round(performance.now() - idleStart);
  const after = await call("page.tree.view.get", { rootRef: opened.rootRef, maximumLevel: 2 }, true);
  const expandAfter = await call("page.tree.expand", { treeRef: html.treeRef }, true);
  const reopened = await call("page.tree.open", { targetRef: tab.tabRef }, true);
  const restored = reopened.ok
    ? await call("page.tree.view.get", { rootRef: reopened.result.rootRef, maximumLevel: 2 }, true)
    : null;
  const freshTabs = await call("tabs.list", { afterTabId: null, limit: 100 });
  const freshMatches = freshTabs.result.items.filter((item) =>
    item.url === tab.url && item.windowId === tab.windowId);
  assert.equal(freshMatches.length, 1, "EXACTLY_ONE_FRESH_MATCHING_TAB_REQUIRED");
  const freshOpened = await call("page.tree.open", { targetRef: freshMatches[0].tabRef }, true);
  const freshView = freshOpened.ok
    ? await call("page.tree.view.get", { rootRef: freshOpened.result.rootRef, maximumLevel: 2 }, true)
    : null;
  const summary = {
    kind: "live-page-tree-idle-probe", sensitivity: "private-browser-content", instance, outputDirectory,
    page: { title: tab.title, url: tab.url }, idleStartedAt, actualIdleMs,
    oldRootView: { ok: after.ok, error: after.error ?? null, delivery: after.delivery },
    oldHtmlExpand: { ok: expandAfter.ok, error: expandAfter.error ?? null, delivery: expandAfter.delivery },
    reopen: { ok: reopened.ok, error: reopened.error ?? null, reused: reopened.result?.reused ?? null,
      sameRoot: reopened.result?.rootRef === opened.rootRef, sameDocument: reopened.result?.documentRef === opened.documentRef },
    expandedPathsBefore: expandedPaths(before),
    expandedPathsAfter: restored?.ok ? expandedPaths(restored.result) : null,
    freshReopen: { ok: freshOpened.ok, error: freshOpened.error ?? null,
      tabRefChanged: freshMatches[0].tabRef !== tab.tabRef,
      reused: freshOpened.result?.reused ?? null,
      sameRoot: freshOpened.result?.rootRef === opened.rootRef,
      sameDocumentRef: freshOpened.result?.documentRef === opened.documentRef,
      expandedPaths: freshView?.ok ? expandedPaths(freshView.result) : null },
    transcript: { name: "interaction.jsonl", records: sequence, utf8Bytes: bytes, sha256: digest.digest("hex") },
    note: "No debugger, page refresh or navigation. Elapsed idle time alone does not prove worker termination.",
  };
  const serialized = `${JSON.stringify(summary, null, 2)}\n`;
  if (keyShape.test(serialized)) throw new Error("SECRET_IN_SUMMARY");
  await writeFile(path.join(outputDirectory, "summary.json"), serialized, { flag: "wx" });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main().catch((error) => {
  const message = keyShape.test(String(error?.message)) ? "PROBE_FAILED" : String(error?.message ?? "PROBE_FAILED");
  process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exitCode = 1;
});
