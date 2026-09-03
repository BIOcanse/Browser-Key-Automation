import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pageEvaluate } from "./cdp-client.mjs";
import { saveArtifactFile } from "../../apps/client/src/artifact-files.mjs";

// All browser actions use the product protocol. The test worker's own CDP
// connection is used only to decode output PNG pixels, never to capture them.
export async function runDebuggerElementProbe({ forward, scopedForward, cliPath, apiKey, instanceRef, sampleRoot, baseUrl, windowId, workerClient }) {
  await mkdir(sampleRoot, { recursive: true });
  const observations = [], artifacts = new Set(), shots = [];
  // The preceding viewport probe also consumes Chrome's per-extension quota.
  let tabRef, lastShotAt = Date.now() + 650;
  const record = (value) => observations.push({ step: observations.length + 1, ...value });
  const call = async (method, params, expectedError, channel = forward) => {
    const started = performance.now();
    const response = await channel(method, params);
    record({ method, params, response: response.payload, elapsedMs: Math.round(performance.now() - started) });
    if (expectedError) { assert.equal(response.payload.error?.code, expectedError, JSON.stringify(response.payload)); return response.payload.error; }
    assert.equal(response.payload.ok, true, JSON.stringify(response.payload)); return response.payload.result;
  };
  const screenshotInterval = async () => {
    const remaining = 650 - (Date.now() - lastShotAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    lastShotAt = Date.now();
  };
  const save = async (artifact, file, channel = forward) => {
    artifacts.add(artifact.artifactRef);
    return saveArtifactFile({ call: async (method, params) => call(method, params, undefined, channel), artifactRef: artifact.artifactRef, output: path.join(sampleRoot, file) });
  };
  try {
    const input = path.join(sampleRoot, "element-capture-original.html");
    await writeFile(input, await readFile(new URL("./fixtures/element-capture.html", import.meta.url)));
    const created = await call("tabs.create", { url: new URL("element-capture", baseUrl).href, active: true, windowId });
    tabRef = created.tab.tabRef;
    await call("page.wait", { tabRef });
    const frames = await call("frames.list", { tabRef });
    const documentRef = frames.items.find((frame) => frame.frameId === 0).documentRef;
    const query = async (selector) => {
      const result = await call("dom.query", { documentRef, selector, limit: 1 });
      assert.equal(result.items.length, 1, selector); return result.items[0].nodeRef;
    };
    const captureOnly = await scopedForward(["page.screenshot.capture", "artifact.read", "artifact.release"]);
    const debugOnly = await scopedForward(["debugger"]);
    assert.equal((await call("debugger.events.get", { tabRef })).attached, false);
    await call("debugger.attach", { tabRef }, "FORBIDDEN", captureOnly);
    await screenshotInterval();
    const viewport = await call("page.screenshot.capture", { tabRef });
    await save(viewport.artifact, "00-original-viewport.png");
    record({ observation: "原始网页：蓝色背景；左上是 Canvas 柱状图，其余为圆形、三角形、路径孔洞、旋转方块、离散子元素和 SVG。" });

    const canvasNode = await query("#canvas");
    await screenshotInterval();
    const canvasFile = path.join(sampleRoot, "01-canvas-660x440.png");
    const cli = await runCli(cliPath, ["element-shot", "--node-ref", canvasNode, "--output", canvasFile,
      "--width", "660", "--height", "440", "--instance", instanceRef, "--api-key-env", "BKA_CAPTURE_TEST_KEY"], apiKey);
    artifacts.add(cli.artifactRef);
    record({ command: "element-shot", result: cli, observation: "只传 Canvas 的 NodeRef 和 660×440，得到原柱状图与文字，画面上下透明留白。" });
    const canvasPixels = await pixels(workerClient, canvasFile, [[0, 0], [330, 40], [330, 220], [659, 439], [657, 220]]);
    assert.equal(canvasPixels.width, 660); assert.equal(canvasPixels.height, 440);
    assert.equal(canvasPixels.points[0][3], 0); assert.equal(canvasPixels.points[2][3], 255);
    assert.equal(canvasPixels.points[4][3], 255);
    for (const [index, expected] of [23, 35, 32].entries()) assert.ok(Math.abs(canvasPixels.points[4][index] - expected) <= 2,
      "the right edge belongs to the Canvas, not scrollbar-scaled page background (allow PNG color-profile rounding)");
    assert.equal(cli.sourceRect.width, 220); assert.equal(cli.sourceRect.height, 120);
    assert.equal(cli.contentRect.y, 40); assert.equal(cli.contentRect.height, 360);
    assert.ok(canvasPixels.transparent > 0); shots.push({ file: canvasFile, ...canvasPixels });

    const capture = async (selector, filename, options, points, channel = forward) => {
      const nodeRef = await query(selector);
      await screenshotInterval();
      const result = await call("page.screenshot.element", { nodeRef, ...options }, undefined, channel);
      const file = path.join(sampleRoot, filename);
      await save(result.artifact, filename, channel);
      const pixel = await pixels(workerClient, file, points);
      assert.equal(pixel.width, options.width); assert.equal(pixel.height, options.height);
      assert.equal(result.viewportOnly, true);
      record({ observation: `实际截图 ${selector}`, file, sourceRect: result.sourceRect, contentRect: result.contentRect, pixel });
      shots.push({ file, ...pixel });
      return { ...result, pixel };
    };
    const circle = await capture("#circle", "02-circle.png", { width: 200, height: 160 }, [[20, 0], [100, 80], [199, 159]], captureOnly);
    assert.equal(circle.pixel.points[0][3], 0); assert.equal(circle.pixel.points[1][3], 255); assert.equal(circle.pixel.points[2][3], 0);
    const triangle = await capture("#polygon", "03-triangle.png", { width: 280, height: 240 }, [[0, 0], [140, 160], [279, 0]]);
    assert.equal(triangle.pixel.points[0][3], 0); assert.equal(triangle.pixel.points[1][3], 255);
    const cssHole = await capture("#path-clip", "04-css-hole.png", { width: 120, height: 120 }, [[60, 60], [10, 10]]);
    assert.equal(cssHole.pixel.points[0][3], 0); assert.equal(cssHole.pixel.points[1][3], 255);
    const downsample = await capture("#path-clip", "04b-hole-downsampled.png", { width: 23, height: 23 }, [[11, 11], [2, 2]]);
    assert.equal(downsample.pixel.points[0][3], 0); assert.equal(downsample.pixel.points[1][3], 255);
    assert.ok(downsample.pixel.transparent + downsample.pixel.opaque < 23 * 23, "hole edges exercise partial alpha when downsampling");
    assert.ok(downsample.pixel.visibleRgbRange.min[0] > 225 && downsample.pixel.visibleRgbRange.max[1] < 72 &&
      downsample.pixel.visibleRgbRange.max[2] < 80, "excluded blue hole pixels must not tint downsampled red edges");
    const rotated = await capture("#rotated", "05-rotated.png", { width: 200, height: 200 }, [[0, 0], [100, 100], [199, 199]]);
    assert.equal(rotated.pixel.points[0][3], 0); assert.equal(rotated.pixel.points[1][3], 255);
    const branches = await capture("#branches", "06-descendants.png", { width: 300, height: 200 }, [[60, 60], [150, 100], [240, 160]]);
    assert.equal(branches.pixel.points[0][3], 255); assert.equal(branches.pixel.points[1][3], 0); assert.equal(branches.pixel.points[2][3], 255);
    const clipped = await capture("#overflow", "07-ancestor-clip.png", { width: 240, height: 240 }, [[0, 40], [120, 120]]);
    assert.equal(clipped.pixel.points[0][3], 0); assert.equal(clipped.pixel.points[1][3], 255);
    const svg = await capture("#svg-donut", "08-svg-hole.png", { width: 280, height: 220 }, [[140, 110], [10, 10]]);
    assert.equal(svg.pixel.points[0][3], 0); assert.equal(svg.pixel.points[1][3], 255);
    const line = await capture("#round-line", "09-svg-round-cap.png", { width: 264, height: 24 }, [[0, 0], [132, 12], [4, 12]]);
    assert.equal(line.pixel.points[0][3], 0); assert.equal(line.pixel.points[1][3], 255); assert.equal(line.pixel.points[2][3], 255);
    const region = await capture("#canvas", "10-canvas-region.png", { width: 200, height: 200, region: { x: 0, y: 0, width: 110, height: 60 } }, [[0, 0], [100, 100]]);
    assert.ok(Math.abs(region.sourceRect.width - 110) <= 1); assert.ok(Math.abs(region.sourceRect.height - 60) <= 1);
    assert.equal(region.pixel.points[0][3], 0); assert.equal(region.pixel.points[1][3], 255);
    const partial = await capture("#partial", "11-viewport-crop.png", { width: 120, height: 120 }, [[60, 60]]);
    assert.equal(partial.sourceRect.x, 0); assert.ok(Math.abs(partial.sourceRect.width - 60) <= 1);
    const unsupported = await call("page.screenshot.element", { nodeRef: await query("#masked") }, "ELEMENT_SCREENSHOT_FAILED");
    assert.equal(unsupported.details.reason, "GEOMETRY_UNSUPPORTED");
    await screenshotInterval();
    const offscreen = await call("page.screenshot.element", { nodeRef: await query("#offscreen") }, "ELEMENT_SCREENSHOT_FAILED");
    assert.equal(offscreen.details.reason, "EMPTY_REGION");
    assert.equal((await call("debugger.events.get", { tabRef })).attached, false, "all element captures remain debugger-free");
    record({ observation: "形状外和孔洞内的 Alpha 为 0，内容像素不变；不支持的 CSS mask 明确报错；视口外元素没有隐式滚动或 CDP 附加。" });

    const attached = await call("debugger.attach", { tabRef }, undefined, debugOnly);
    assert.equal(attached.attached, true); assert.equal(attached.alreadyAttached, false);
    assert.equal((await call("debugger.attach", { tabRef })).alreadyAttached, true);
    await call("debugger.send", { tabRef, method: "Runtime.enable" }, undefined, debugOnly);
    const evaluated = await call("debugger.send", { tabRef, method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } }, undefined, debugOnly);
    assert.equal(evaluated.result.result.value, "BKA element capture fixture");
    await call("js.execute", { tabRef, code: "42", world: "MAIN", timeoutMs: 10000 }, "FORBIDDEN", debugOnly);
    await call("debugger.send", { tabRef, method: "Network.enable" });
    await call("debugger.send", { tabRef, method: "Runtime.evaluate", params: { expression: "fetch('/resource.txt').then(r=>r.text())", awaitPromise: true, returnByValue: true } });
    const events = await call("debugger.events.get", { tabRef });
    assert.ok(events.items.some((item) => item.method.startsWith("Runtime.")));
    assert.ok(events.items.some((item) => item.method.startsWith("Network.")));
    const firstEvent = await call("debugger.events.get", { tabRef, limit: 1 });
    assert.deepEqual(await call("debugger.events.get", { tabRef, limit: 1 }), firstEvent, "reading events does not drain the cache");
    const document = await call("debugger.send", { tabRef, method: "DOM.getDocument", params: { depth: 1 }, response: "artifact" });
    await save(document.artifact, "12-debugger-dom.json");
    assert.equal(JSON.parse(await readFile(path.join(sampleRoot, "12-debugger-dom.json"), "utf8")).root.nodeName, "#document");
    await call("control.acquire", { scope: "tab", tabRef });
    try {
      await call("debugger.send", { tabRef, method: "Runtime.evaluate", params: { expression: "window.shouldNotRun=1" } }, "CONTROL_OCCUPIED", debugOnly);
    } finally { await call("control.release", { scope: "tab", tabRef }); }
    const checked = await call("debugger.send", { tabRef, method: "Runtime.evaluate", params: { expression: "typeof window.shouldNotRun", returnByValue: true } });
    assert.equal(checked.result.result.value, "undefined");
    await call("debugger.send", { tabRef, method: "Emulation.setPageScaleFactor", params: { pageScaleFactor: 2 } });
    await call("debugger.send", { tabRef, method: "Runtime.evaluate", params: { expression: "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))", awaitPromise: true } });
    const scaled = await capture("#canvas", "13-canvas-visual-zoom.png", { width: 660, height: 440 }, [[0, 0], [330, 220], [657, 220]]);
    assert.ok(Math.abs(scaled.sourceRect.width - 220) <= 1); assert.ok(Math.abs(scaled.sourceRect.height - 120) <= 1);
    assert.ok(scaled.pixel.points[2][2] < 50, "visual viewport zoom must not mix the blue page background into the Canvas");
    await call("debugger.send", { tabRef, method: "Emulation.setPageScaleFactor", params: { pageScaleFactor: 1 } });
    assert.equal((await call("debugger.detach", { tabRef }, undefined, debugOnly)).detached, true);
    const notAttached = await call("debugger.send", { tabRef, method: "Runtime.enable" }, "DEBUGGER_OPERATION_FAILED");
    assert.equal(notAttached.details.commandMayHaveRun, false);
    await call("tabs.reload", { tabRef, bypassCache: false }); await call("page.wait", { tabRef });
    await call("page.screenshot.element", { nodeRef: canvasNode }, "TARGET_REF_STALE");
    record({ observation: "调试专用 Key 成功执行 Runtime/Network/DOM，不需要 js.execute；占据冲突在命令执行前阻止，显式断开后不自动重连；刷新使旧 NodeRef 失效。" });
    return { steps: observations.length, input, sampleRoot, shots, explicitDebugger: true, independentPermissions: true,
      noImplicitAttach: true, containAndAlpha: true, rawDomArtifact: true };
  } finally {
    if (tabRef) await forward("tabs.close", { tabRef }).catch(() => undefined);
    for (const artifactRef of artifacts) await forward("artifact.release", { artifactRef }).catch(() => undefined);
    const output = JSON.stringify(observations, null, 2);
    assert.equal(output.includes(apiKey), false);
    await writeFile(path.join(sampleRoot, "interaction-samples.json"), output + "\n");
  }
}

async function pixels(client, file, points) {
  const png = await readFile(file);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return pageEvaluate(client, async ({ data, points }) => {
    const source = await createImageBitmap(new Blob([Uint8Array.from(atob(data), (character) => character.charCodeAt(0))], { type: "image/png" }));
    try {
      const canvas = new OffscreenCanvas(source.width, source.height), context = canvas.getContext("2d");
      context.drawImage(source, 0, 0);
      const bytes = context.getImageData(0, 0, source.width, source.height).data;
      let transparent = 0, opaque = 0;
      const min = [255, 255, 255], max = [0, 0, 0];
      for (let index = 3; index < bytes.length; index += 4) {
        if (bytes[index] === 0) transparent += 1;
        if (bytes[index] === 255) opaque += 1;
        if (bytes[index] >= 32) for (let channel = 0; channel < 3; channel += 1) {
          min[channel] = Math.min(min[channel], bytes[index - 3 + channel]);
          max[channel] = Math.max(max[channel], bytes[index - 3 + channel]);
        }
      }
      return { width: source.width, height: source.height, transparent, opaque, visibleRgbRange: { min, max },
        points: points.map(([x, y]) => [...bytes.subarray((y * source.width + x) * 4, (y * source.width + x) * 4 + 4)]) };
    } finally { source.close(); }
  }, { data: png.toString("base64"), points });
}

async function runCli(cliPath, args, apiKey) {
  const env = { ...process.env, BKA_CAPTURE_TEST_KEY: apiKey }; delete env.BKA_API_KEY;
  const child = spawn(process.execPath, [cliPath, ...args], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (value) => { stdout += value; }); child.stderr.on("data", (value) => { stderr += value; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(stdout.includes(apiKey) || stderr.includes(apiKey), false);
  assert.equal(code, 0, stdout + stderr);
  const result = JSON.parse(stdout.trim());
  assert.equal(createHash("sha256").update(await readFile(result.output)).digest("hex"), result.sha256);
  return result;
}
