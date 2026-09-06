import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CdpClient, runtimeEvaluate } from "./cdp-client.mjs";

// Product commands always travel through the real extension/relay. CDP is an
// isolated-test observer for the opaque sandbox, not a shipped demo backend.
export async function runShotDemoProbe({ forward, cliPath, apiKey, instanceRef, sampleRoot, debugPort, browserClient, windowId, ordinaryTabRef }) {
  await mkdir(sampleRoot, { recursive: true });
  const observations = [], artifacts = new Set();
  let tabRef, client;
  const inspectSandbox = (expression) => sandboxEvaluate(client, browserClient, expression);
  const record = (value) => { observations.push({ step: observations.length + 1, ...value }); };
  const call = async (method, params, expectedError) => {
    const response = await forward(method, params); record({ method, params, response: response.payload });
    if (expectedError) { assert.equal(response.payload.error?.code, expectedError); return response.payload.error; }
    assert.equal(response.payload.ok, true, JSON.stringify(response.payload)); return response.payload.result;
  };
  const cli = async (args) => {
    const started = performance.now(); const result = await runCli(cliPath, [...args, "--instance", instanceRef, "--api-key-env", "BKA_SHOT_DEMO_KEY"], apiKey);
    record({ command: args[0], args, elapsedMs: Math.round(performance.now() - started), result }); return result;
  };
  try {
    const source = await readFile(new URL("./fixtures/interactive-demo.html", import.meta.url), "utf8");
    const input = path.join(sampleRoot, "一键演示原始样本.html");
    const bytes = Buffer.from(source + `\n<!-- transport sample: ${"x".repeat(80000)} -->\n`);
    await writeFile(input, bytes);
    record({ observation: "准备自包含 HTML：标题、计数按钮、百分比滑块；附带不可见注释使原始文件超过单帧上限。", input, byteLength: bytes.length, sha256: hash(bytes) });
    const opened = await cli(["demo-open", input, "--window-id", String(windowId)]);
    tabRef = opened.tab.tabRef; artifacts.add(opened.artifact.artifactRef);
    assert.equal(opened.artifact.byteLength, bytes.length); assert.equal(opened.artifact.sha256, hash(bytes));
    const target = await until(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      return targets.find((item) => item.type === "page" && item.url.includes(opened.artifact.artifactRef));
    });
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await waitForViewer(client);
    const initial = await inspectSandbox(`JSON.stringify({heading:document.querySelector('h1').textContent,
      count:document.querySelector('#count').textContent,button:document.querySelector('#add').textContent,
      script:document.querySelector('#script-state').textContent,extensionApi:document.body.dataset.extensionApi,parentAccess:document.body.dataset.parentAccess})`);
    const visible = JSON.parse(initial); assert.equal(visible.script, "脚本已运行"); assert.equal(visible.count, "0");
    assert.equal(visible.extensionApi, "undefined"); assert.equal(visible.parentAccess, "blocked");
    record({ observation: "首次打开：标题为‘一个 HTML，直接展示。’，计数为 0，脚本状态已运行；沙箱没有扩展 API，也读不到外层页面。", visible });
    const screenshot = path.join(sampleRoot, "01-初始演示.png");
    const shot = await cli(["page-shot", "--tab-ref", tabRef, "--output", screenshot]); artifacts.add(shot.artifactRef);
    assert.equal(shot.mediaType, "image/png"); const png = await readFile(screenshot);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]); assert.equal(hash(png), shot.sha256);
    record({ observation: "扩展截图 API 已返回演示页 PNG，文件字节数与 SHA-256 校验一致。", file: screenshot, width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
    const changed = await inspectSandbox(`(() => {document.querySelector('#add').click();
      const slider=document.querySelector('#slider');slider.value='75';slider.dispatchEvent(new Event('input',{bubbles:true}));
      return {count:document.querySelector('#count').textContent,percent:document.querySelector('#percent').textContent};})()`);
    assert.deepEqual(changed, { count: "1", percent: "75%" });
    record({ observation: "通过测试观察通道点击已确认的按钮并调整滑块：计数变为 1，百分比变为 75%。产品没有借用 CDP 来展示或截图。", visible: changed });
    const jpegPath = path.join(sampleRoot, "02-交互后演示.jpg");
    const jpeg = await cli(["page-shot", "--tab-ref", tabRef, "--output", jpegPath, "--format", "jpeg", "--quality", "85"]); artifacts.add(jpeg.artifactRef);
    const jpegBytes = await readFile(jpegPath); assert.equal(jpeg.mediaType, "image/jpeg"); assert.equal(jpegBytes.readUInt16BE(0), 0xffd8);
    assert.equal(hash(jpegBytes), jpeg.sha256);
    await call("demo.open", { artifactRef: shot.artifactRef }, "DEMO_INPUT_INVALID");
    await call("demo.open", { artifactRef: opened.artifact.artifactRef, tabRef: ordinaryTabRef }, "DEMO_INPUT_INVALID");
    const beforeReload = await runtimeEvaluate(client, "performance.timeOrigin");
    await call("tabs.reload", { tabRef, bypassCache: false }); await waitForViewer(client, { previousTimeOrigin: beforeReload });
    assert.equal(await inspectSandbox("document.querySelector('#count').textContent"), "0");
    record({ observation: "刷新后从已提交 Artifact 重建相同演示，按钮计数回到 0；文件内容保留，脚本内存状态不假装持久化。" });
    const updatedPath = path.join(sampleRoot, "更新后的演示原始样本.html");
    await writeFile(updatedPath, source.replace("一个 HTML，直接展示。", "内容已更新，标签页不变。"));
    const updated = await cli(["demo-open", updatedPath, "--tab-ref", tabRef, "--active", "false"]); artifacts.add(updated.artifact.artifactRef);
    assert.equal(updated.tab.tabRef, tabRef); await waitForViewer(client, { artifactRef: updated.artifact.artifactRef });
    assert.equal(await inspectSandbox("document.querySelector('h1').textContent"), "内容已更新，标签页不变。");
    record({ observation: "显式指定原 TabRef 再提交文件，标题更新为‘内容已更新，标签页不变。’，没有新建第二个演示标签。" });
    const incomplete = await call("artifact.upload.begin", { byteLength: 10, mediaType: "text/html" }); artifacts.add(incomplete.artifactRef);
    await call("demo.open", { artifactRef: incomplete.artifactRef }, "ARTIFACT_NOT_FOUND");
    const offsetError = await call("artifact.upload.append", { artifactRef: incomplete.artifactRef, offset: 1, dataBase64Url: "eA" }, "ARTIFACT_UPLOAD_INVALID");
    assert.equal(offsetError.details.reason, "OFFSET_MISMATCH");
    await call("artifact.upload.commit", { artifactRef: incomplete.artifactRef, sha256: "0".repeat(64) }, "ARTIFACT_UPLOAD_INVALID");
    await call("artifact.release", { artifactRef: updated.artifact.artifactRef }); artifacts.delete(updated.artifact.artifactRef);
    await call("tabs.reload", { tabRef, bypassCache: false });
    const missing = await until(async () => { const state = await runtimeEvaluate(client, "({state:document.documentElement?.dataset.state,text:document.querySelector('#status')?.textContent})"); return state.state === "error" && state; });
    assert.match(missing.text, /ARTIFACT_NOT_FOUND/);
    record({ observation: "释放演示副本后刷新，页面明确显示文件不可用并要求重新提交，不继续展示旧副本。", visible: missing });
    const nonUtf8Input = path.join(sampleRoot, "不支持的UTF-16LE编码样本.html");
    await writeFile(nonUtf8Input, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, "utf16le")]));
    const wrongEncoding = await cli(["demo-open", nonUtf8Input, "--tab-ref", tabRef]); artifacts.add(wrongEncoding.artifact.artifactRef);
    const encodingError = await until(async () => {
      const state = await runtimeEvaluate(client, "({state:document.documentElement?.dataset.state,text:document.querySelector('#status')?.textContent,url:location.href})");
      return state.url.includes(wrongEncoding.artifact.artifactRef) && state.state === "error" && state;
    });
    assert.match(encodingError.text, /必须使用 UTF-8 编码/);
    record({ observation: "UTF-16LE 文件完成原始字节提交，但展示页明确提示必须另存为 UTF-8；打开命令只代表浏览器接受导航，不冒充渲染成功。", input: nonUtf8Input, visible: encodingError });
    return { steps: observations.length, input, screenshot, jpeg: jpegPath, uploadBytes: bytes.length,
      defaultPng: true, inlineJavaScript: true, interactiveControls: true, sandboxIsolation: true, refresh: true,
      explicitSameTabUpdate: true, nonUtf8Error: true, noHttpDemoServer: true, cliTimings: observations.filter((step) => step.command).map(({ command, elapsedMs }) => ({ command, elapsedMs })) };
  } finally {
    client?.close();
    if (tabRef) await forward("tabs.close", { tabRef }).catch(() => undefined);
    for (const artifactRef of artifacts) await forward("artifact.release", { artifactRef }).catch(() => undefined);
    const output = JSON.stringify(observations, null, 2);
    assert.equal(output.includes(apiKey), false);
    await writeFile(path.join(sampleRoot, "interaction-samples.json"), output + "\n");
  }
}

async function waitForViewer(client, { artifactRef, previousTimeOrigin } = {}) {
  return until(async () => {
    const state = await runtimeEvaluate(client, "({state:document.documentElement?.dataset.state,text:document.querySelector('#status')?.textContent,url:location.href,timeOrigin:performance.timeOrigin})");
    if (artifactRef !== undefined && !state.url.includes(artifactRef) || previousTimeOrigin !== undefined && state.timeOrigin === previousTimeOrigin) return false;
    assert.notEqual(state.state, "error", state.text); return state.state === "ready";
  });
}
async function sandboxEvaluate(client, browserClient, expression) {
  const document = await client.send("DOM.getDocument");
  const iframe = await client.send("DOM.querySelector", { nodeId: document.root.nodeId, selector: "iframe" });
  const owner = await client.send("DOM.describeNode", { nodeId: iframe.nodeId });
  const frameId = owner.node.frameId;
  assert.ok(frameId, JSON.stringify(owner));
  const targets = await browserClient.send("Target.getTargets");
  const remote = targets.targetInfos.find((target) => target.type === "iframe" && target.targetId === frameId);
  let response;
  if (remote) {
    const { sessionId } = await browserClient.send("Target.attachToTarget", { targetId: remote.targetId, flatten: true });
    try { response = await browserClient.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, 15000, sessionId); }
    finally { await browserClient.send("Target.detachFromTarget", { sessionId }); }
  } else {
    const world = await client.send("Page.createIsolatedWorld", { frameId, worldName: "bka-demo-test-observer" });
    response = await client.send("Runtime.evaluate", { expression, contextId: world.executionContextId, returnByValue: true, awaitPromise: true });
  }
  assert.equal(response.exceptionDetails, undefined, JSON.stringify(response.exceptionDetails)); return response.result?.value;
}
async function until(probe) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = await probe(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 50)); }
  assert.fail("shot/demo observation timed out");
}
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function runCli(cliPath, args, apiKey) {
  const env = { ...process.env, BKA_SHOT_DEMO_KEY: apiKey }; delete env.BKA_API_KEY;
  const child = spawn(process.execPath, [cliPath, ...args], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (value) => { stdout += value; }); child.stderr.on("data", (value) => { stderr += value; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(stdout.includes(apiKey) || stderr.includes(apiKey), false, "CLI disclosed a Key");
  assert.equal(code, 0, stdout + stderr); return JSON.parse(stdout.trim());
}
