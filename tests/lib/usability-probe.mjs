import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Uses extension commands for all browser actions. The local HTTP gates merely
// provide deterministic network timing; no personal browser or accounts.
export async function runUsabilityProbe({ forward, cliPath, apiKey, instanceRef, sampleRoot, baseUrl, windowId, gates }) {
  await mkdir(sampleRoot, { recursive: true });
  const observations = [];
  const call = async (method, params, expectedError) => {
    const response = await forward(method, params);
    observations.push({ sequence: observations.length + 1, method, params, response: response.payload });
    if (expectedError) { assert.equal(response.payload.error?.code, expectedError); return response.payload; }
    assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
    return response.payload.result;
  };
  let tabRef;
  try {
    const created = await call("tabs.create", { url: `${baseUrl}usability`, active: false, windowId });
    tabRef = created.tab.tabRef;
    assert.notEqual((await call("page.wait", { tabRef })).status, "timed_out");
    const complete = await call("page.wait", { tabRef });
    assert.equal(complete.status, "already_satisfied"); assert.equal(complete.timeoutMs, 10000);
    const opened = await call("page.tree.open", { targetRef: tabRef });
    const initial = await call("page.tree.view.get", { rootRef: opened.rootRef });
    assert.deepEqual(initial.items.map((item) => item.indexPath), [[0], [1]]);
    const find = async (selector) => (await call("page.tree.find", { rootRef: opened.rootRef, selector })).items[0];
    const shadow = await find("#shadow-action");
    assert.ok(shadow.nodeRef); assert.equal(shadow.label, "Shadow-only action");
    const disabled = await find("#disabled");
    await call("dom.click", { nodeRef: disabled.nodeRef }, "DOM_OPERATION_FAILED");
    const editable = await find("#editable");
    await call("dom.focus", { nodeRef: editable.nodeRef });
    await call("dom.scroll", { nodeRef: editable.nodeRef });
    const edited = await call("dom.setValue", { nodeRef: editable.nodeRef, value: "<b>真实纯文本</b>" });
    assert.equal(edited.descriptor.text, "<b>真实纯文本</b>");
    assert.ok((await call("page.dom.get", { tabRef, root: "body" })).html.includes("&lt;b&gt;真实纯文本&lt;/b&gt;"));
    const removed = await find("#remove");
    await call("dom.click", { nodeRef: removed.nodeRef });
    await call("dom.click", { nodeRef: removed.nodeRef }, "TARGET_REF_STALE");
    const late = await find("#late-button");
    await call("dom.click", { nodeRef: late.nodeRef });
    const lateText = await call("page.wait", { tabRef, until: "text", selector: "#late-text", text: "ready" });
    assert.notEqual(lateText.status, "timed_out");
    assert.equal((await call("page.wait", { tabRef, until: "present", selector: "#missing", timeoutMs: 150 })).status, "timed_out");
    const after = await call("page.tree.view.get", { rootRef: opened.rootRef });
    assert.deepEqual(after.items.map((item) => [item.indexPath, item.expanded]), initial.items.map((item) => [item.indexPath, item.expanded]));

    const output = path.join(sampleRoot, "实际网页另存为.mhtml");
    const saved = await runCli(cliPath, ["page-save", "--tab-ref", tabRef, "--output", output,
      "--instance", instanceRef, "--api-key-env", "BKA_SMOKE_SAVE_KEY"], apiKey);
    observations.push({ sequence: observations.length + 1, command: "page-save", result: saved });
    const bytes = await readFile(output);
    assert.equal(bytes.length, saved.byteLength);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), saved.sha256);
    assert.match(bytes.toString("utf8"), /MIME-Version: 1\.0/i);

    await call("tabs.navigate", { tabRef, url: `${baseUrl}wait-pending` });
    await until(() => gates.pending !== null);
    const pending = await call("page.wait", { tabRef, timeoutMs: 150 });
    assert.equal(pending.status, "timed_out"); assert.equal(pending.observation?.navigationPending, true);
    gates.pending.end("<!doctype html><title>Committed target</title><p>new document</p>"); gates.pending = null;
    assert.notEqual((await call("page.wait", { tabRef, url: `${baseUrl}wait-pending` })).status, "timed_out");

    await call("tabs.navigate", { tabRef, url: `${baseUrl}wait-lifecycle` });
    await until(() => gates.defer !== null && gates.image !== null);
    const committed = await call("page.wait", { tabRef, until: "committed", url: `${baseUrl}wait-lifecycle` });
    assert.equal(committed.status, "already_satisfied");
    const beforeDcl = await call("page.wait", { tabRef, until: "domcontentloaded", timeoutMs: 150 });
    assert.equal(beforeDcl.status, "timed_out");
    assert.equal(beforeDcl.observation.readyState, "interactive"); assert.equal(beforeDcl.observation.domContentLoaded, false);
    gates.defer.end("window.deferredScriptFinished = true;"); gates.defer = null;
    assert.notEqual((await call("page.wait", { tabRef, until: "domcontentloaded" })).status, "timed_out");
    assert.equal((await call("page.wait", { tabRef, until: "domcontentloaded" })).status, "already_satisfied");
    assert.equal((await call("page.wait", { tabRef, timeoutMs: 150 })).status, "timed_out");
    gates.image.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6CkAAAAASUVORK5CYII=", "base64")); gates.image = null;
    assert.notEqual((await call("page.wait", { tabRef })).status, "timed_out");
    assert.equal((await call("page.wait", { tabRef })).status, "already_satisfied");
    return { steps: observations.length, savedFile: output, savedBytes: saved.byteLength, sha256: saved.sha256,
      waitPhases: ["committed", "domcontentloaded", "complete"], explicitConditions: true, defaultsApplied: true,
      domGuards: true, contenteditable: true, findPreservesExpansion: true };
  } finally {
    await writeFile(path.join(sampleRoot, "interaction-samples.json"), JSON.stringify(observations, null, 2) + "\n");
    if (tabRef) await forward("tabs.close", { tabRef }).catch(() => undefined);
  }
}

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "fixture resource gate was not reached");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function runCli(cliPath, args, key) {
  const env = { ...process.env, BKA_SMOKE_SAVE_KEY: key };
  delete env.BKA_API_KEY;
  const child = spawn(process.execPath, [cliPath, ...args], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (value) => { stdout += value; }); child.stderr.on("data", (value) => { stderr += value; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(stdout.includes(key) || stderr.includes(key), false, "CLI must not disclose Key");
  assert.equal(code, 0, stdout + stderr);
  return JSON.parse(stdout.trim());
}
