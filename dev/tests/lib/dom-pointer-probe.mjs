import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { saveArtifactFile } from "../../../app/client/src/artifact-files.mjs";
import { pageEvaluate } from "./cdp-client.mjs";

// Product-protocol test, isolated profile only. No physical cursor movement.
export async function runDomPointerProbe({ forward, scopedForward, sampleRoot, baseUrl, windowId, workerClient }) {
  await mkdir(sampleRoot, { recursive: true });
  await writeFile(path.join(sampleRoot, "original.html"), await readFile(new URL("./fixtures/dom-pointer.html", import.meta.url)));
  const observations = [];
  const fixtureUrl = new URL("dom-pointer", baseUrl).href;
  let tabRef, otherTabRef, keyWithControl, debuggerAttached = false;
  const call = async (method, params, expectedError, channel = forward) => {
    const started = performance.now(), response = await channel(method, params);
    observations.push({ step: observations.length + 1, method, params, response: response.payload, elapsedMs: performance.now() - started });
    if (expectedError) { assert.equal(response.payload.error?.code, expectedError, JSON.stringify(response.payload)); return response.payload.error; }
    assert.equal(response.payload.ok, true, JSON.stringify(response.payload)); return response.payload.result;
  };
  // Fixed test instrumentation reads the fixture independently of js.execute.
  // Keep Allow User Scripts disabled to verify ordinary DOM needs no such grant.
  const inspect = async (operation) => pageEvaluate(workerClient, async ({ fixtureUrl, operation }) => {
    const matches = (await chrome.tabs.query({})).filter((tab) => tab.url === fixtureUrl);
    if (matches.length !== 1) throw new Error("Expected exactly one isolated pointer fixture");
    const results = await chrome.scripting.executeScript({ target: { tabId: matches[0].id }, world: "MAIN",
      func: (operation) => {
        if (operation === "version") return navigator.userAgent;
        if (operation === "reset") { globalThis.__pointerProbe.reset(); return true; }
        if (operation === "cancelStart") { globalThis.__pointerProbe.cancelStart(); return true; }
        if (operation === "snapshot") return globalThis.__pointerProbe.snapshot();
        throw new Error("Unknown test observation");
      }, args: [operation] });
    return results[0].result;
  }, { fixtureUrl, operation });
  const cdp = (method, params = {}) => call("debugger.send", { tabRef, method, params });
  try {
    tabRef = (await call("tabs.create", { url: fixtureUrl, active: true, windowId })).tab.tabRef;
    await call("page.wait", { tabRef });
    const frames = await call("frames.list", { tabRef });
    const main = frames.items.find((frame) => frame.frameId === 0);
    const query = async (selector, documentRef = main.documentRef) => {
      const found = await call("dom.query", { documentRef, selector, limit: 1 });
      assert.equal(found.items.length, 1, selector); return found.items[0].nodeRef;
    };
    const hover = await query("#hover"), pad = await query("#pad"), source = await query("#source"), drop = await query("#drop"), reject = await query("#reject");
    const hoverOnly = await scopedForward(["dom.hover"]);
    await call("dom.drag", { nodeRef: source, toNodeRef: drop }, "FORBIDDEN", hoverOnly);
    await call("dom.hover", { nodeRef: hover }, undefined, hoverOnly);
    let snapshot = await inspect("snapshot");
    assert.equal(snapshot.hoverText, "hovered"); assert.equal(snapshot.cssHover, false);
    assert.equal(snapshot.events.every((event) => !event.trusted), true);
    observations.push({ observation: "DOM enter 显示 hovered，但 CSS hover 颜色不变；没有 debugger 或系统光标动作。", snapshot });
    await call("dom.hover", { nodeRef: hover, phase: "leave" });
    assert.equal((await inspect("snapshot")).hoverText, "left");

    await inspect("reset");
    await call("dom.drag", { nodeRef: pad, toNodeRef: pad, fromOffset: { x: 15, y: 20 }, toOffset: { x: 300, y: 90 }, steps: 8 });
    snapshot = await inspect("snapshot");
    assert.equal(snapshot.points.length, 8); assert.deepEqual(snapshot.points.at(-1), [300, 90]); assert.equal(snapshot.drawing, false);
    observations.push({ observation: "Canvas 从内部 (15,20) 到 (300,90) 绘出线段，收到 8 个移动点，末尾按钮释放。", snapshot });
    await call("dom.drag", { nodeRef: source, toNodeRef: drop, mode: "html5" });
    snapshot = await inspect("snapshot");
    assert.equal(snapshot.dropData, "fixture-card");
    assert.ok(snapshot.events.find((event) => event.type === "dragenter" && event.bubbles));
    observations.push({ observation: "HTML5 放置区显示 Received: fixture-card，同一个 DataTransfer 从源传到目标。", snapshot });
    const captured = await call("page.screenshot.capture", { tabRef });
    await saveArtifactFile({ call: (method, params) => call(method, params), artifactRef: captured.artifact.artifactRef,
      output: path.join(sampleRoot, "ordinary.png") });
    await call("artifact.release", { artifactRef: captured.artifact.artifactRef });
    assert.equal((await call("dom.drag", { nodeRef: source, toNodeRef: reject, mode: "html5" })).canceledAt, "dragover");
    await inspect("cancelStart");
    assert.equal((await call("dom.drag", { nodeRef: source, toNodeRef: drop, mode: "html5" })).canceledAt, "dragstart");
    const blocked = await query("#blocked");
    const blockedResult = await call("dom.hover", { nodeRef: blocked }, "DOM_OPERATION_FAILED");
    assert.equal(blockedResult.details.reason, "target_obstructed"); assert.equal(blockedResult.details.commandMayHaveRun, false);
    const child = frames.items.find((frame) => frame.frameId !== 0);
    const childNode = await query("#inside", child.documentRef);
    await call("dom.hover", { nodeRef: childNode });
    assert.equal((await call("dom.describe", { nodeRef: childNode })).descriptor.text, "frame hovered");
    assert.equal((await call("dom.drag", { nodeRef: source, toNodeRef: childNode }, "DOM_OPERATION_FAILED")).details.reason, "different_documents");

    keyWithControl = await scopedForward(["control.acquire", "control.release"]);
    await call("control.acquire", { scope: "tab", tabRef }, undefined, keyWithControl);
    await call("dom.hover", { nodeRef: hover }, "CONTROL_OCCUPIED");
    await call("dom.drag", { nodeRef: pad, toNodeRef: pad }, "CONTROL_OCCUPIED");
    await call("control.release", { scope: "tab", tabRef }, undefined, keyWithControl); keyWithControl = null;
    await inspect("reset");
    const ensured = await call("ensure.run", {
      action: { method: "dom.hover", schemaVersion: 1, target: { kind: "node", nodeRef: hover }, params: {} },
      goal: { kind: "text_contains", target: { kind: "node", nodeRef: await query("#hover-status") }, text: "hovered" },
    });
    assert.equal(ensured.status, "satisfied");

    // Preparation evidence for a future independent virtualMouse namespace.
    // These are existing explicit debugger commands, NOT new virtual commands.
    await call("debugger.attach", { tabRef }); debuggerAttached = true;
    const version = await inspect("version");
    await inspect("reset");
    const rect = (await inspect("snapshot")).rects.hover;
    const pointerPoint = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...pointerPoint });
    snapshot = await inspect("snapshot");
    assert.equal(snapshot.cssHover, true); assert.equal(snapshot.hoverText, "hovered");
    assert.ok(snapshot.events.some((event) => event.type === "pointermove" && event.trusted));
    observations.push({ experiment: "cdp-pointer", version, observation: "CDP mouseMoved 触发 trusted 指针事件与真实 CSS hover。", snapshot });
    await inspect("reset");
    const padRect = snapshot.rects.pad;
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: padRect.x + 15, y: padRect.y + 20 });
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: padRect.x + 15, y: padRect.y + 20, button: "left", buttons: 1, clickCount: 1 });
    try {
      for (const [x, y] of [[90, 40], [180, 60], [300, 90]]) {
        await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: padRect.x + x, y: padRect.y + y, buttons: 1 });
      }
    } finally {
      await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: padRect.x + 300, y: padRect.y + 90, button: "left", buttons: 0, clickCount: 1 });
    }
    snapshot = await inspect("snapshot");
    assert.equal(snapshot.drawing, false); assert.deepEqual(snapshot.points.at(-1), [300, 90]);
    assert.ok(snapshot.events.filter((event) => ["pointerdown", "pointermove", "pointerup"].includes(event.type)).every((event) => event.trusted));
    observations.push({ experiment: "cdp-pointer-drag", observation: "跨指令按下、移动、抬起完成 Canvas 线段，目标收到 trusted 指针事件，末尾释放。", snapshot });
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
    await inspect("reset");
    try {
      await cdp("Input.setIgnoreInputEvents", { ignore: true });
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...pointerPoint });
      snapshot = await inspect("snapshot");
      observations.push({ experiment: "cdp-ignore", observation: "开启 ignore 后重新向元素移动；以实际事件与 CSS 状态判断，不能只看命令返回成功。", snapshot });
      assert.equal(snapshot.events.filter((event) => event.type === "pointermove").length, 0);
      assert.equal(snapshot.cssHover, false);
    } finally { await cdp("Input.setIgnoreInputEvents", { ignore: false }); }
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...pointerPoint });
    assert.equal((await inspect("snapshot")).cssHover, true);

    otherTabRef = (await call("tabs.create", { url: "about:blank", active: true, windowId })).tab.tabRef;
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
    await inspect("reset");
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...pointerPoint });
    snapshot = await inspect("snapshot");
    const active = (await call("tabs.get", { tabRef: otherTabRef })).tab.active;
    observations.push({ experiment: "cdp-inactive-tab", activeTabUnchanged: active, snapshot });
    assert.equal(active, true);
    await call("debugger.detach", { tabRef }); debuggerAttached = false;
    await inspect("reset");
    await call("dom.hover", { nodeRef: hover });
    assert.equal((await inspect("snapshot")).hoverText, "hovered");
    observations.push({ observation: "切换到其他标签页后，普通 DOM hover 仍能操作原页；调试连接已释放。" });
    return { sampleRoot, steps: observations.length, ordinary: "passed", virtualMouse: "input-path-experiment-only" };
  } finally {
    if (keyWithControl && tabRef) await call("control.release", { scope: "tab", tabRef }, undefined, keyWithControl).catch(() => {});
    if (debuggerAttached && tabRef) await cdp("Input.setIgnoreInputEvents", { ignore: false }).catch(() => {});
    if (debuggerAttached && tabRef) await call("debugger.detach", { tabRef }).catch(() => {});
    for (const ref of [otherTabRef, tabRef]) if (ref) await call("tabs.close", { tabRef: ref }).catch(() => {});
    await writeFile(path.join(sampleRoot, "observations.json"), JSON.stringify(observations, null, 2) + "\n");
  }
}
