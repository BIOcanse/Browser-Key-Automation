import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { pageEvaluate } from "./cdp-client.mjs";

// Inputs use product APIs, except the explicit occlusion-root experiment which
// consumes the unchanged native backend. CDP arranges/observes empty fixtures.
export async function runNativeBoundaryProbe({ forward, sampleRoot, baseUrl, windowId, workerClient, browserVersion, mode }) {
  assert.ok(["occlusion", "occlusion-root", "occlusion-accessibility", "occlusion-calibrated", "html5", "html5-batch", "html5-diag", "html5-queue-diag", "html5-state-diag", "html5-settle-diag"].includes(mode));
  await mkdir(sampleRoot, { recursive: true });
  await writeFile(path.join(sampleRoot, "original.html"), await readFile(new URL("./fixtures/dom-pointer.html", import.meta.url)));
  if (browserVersion) await writeFile(path.join(sampleRoot, "browser-version.json"), JSON.stringify(browserVersion, null, 2));
  const observations = [];
  let diagnosticDeadlineExpired = false;
  const persist = () => writeFile(path.join(sampleRoot, "observations.json"), JSON.stringify(observations, null, 2));
  const invoke = async (method, params) => {
    if (method.startsWith("virtualMouse.")) params = { timeoutMs: 2000, ...params };
    const record = { method, params, startedAt: Date.now() }; observations.push(record); await persist();
    try {
      const request = forward(method, params);
      let timer;
      try {
        record.response = (await (mode.endsWith("-diag") ? Promise.race([request, new Promise((_, reject) => {
          timer = setTimeout(() => { diagnosticDeadlineExpired = true; reject(new Error("Diagnostic fixture deadline expired; stop this isolated browser without further input")); }, 6000);
        })]) : request)).payload;
      } finally { clearTimeout(timer); }
      return record.response;
    } catch (error) { record.error = String(error); throw error; }
    finally { record.elapsedMs = Date.now() - record.startedAt; await persist(); }
  };
  const call = async (method, params) => {
    const response = await invoke(method, params);
    assert.ok(response?.ok, JSON.stringify(response));
    return response.result;
  };
  const url = new URL(`dom-pointer#native-${mode}`, baseUrl).href;
  let tabRef, coverId, rootProbe, rootTitle;
  const inspect = () => pageEvaluate(workerClient, async (url) => {
    const tab = (await chrome.tabs.query({})).find((entry) => entry.url === url);
    return (await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: () => globalThis.__pointerProbe?.snapshot() ?? null }))[0].result;
  }, url);
  try {
    await pageEvaluate(workerClient, async (windowId) => chrome.windows.update(windowId, { state: "normal", focused: true, left: 80, top: 80, width: 900, height: 650 }), windowId);
    tabRef = (await call("tabs.create", { url, active: true, windowId })).tab.tabRef;
    await call("page.wait", { tabRef });
    await call("control.acquire", { scope: "window", windowId });
    const before = await inspect(); observations.push({ before }); await persist();
    const center = (rect) => ({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });
    let counterNode;
    if (mode === "occlusion-calibrated") {
      const frames = await call("frames.list", { tabRef });
      counterNode = (await call("dom.query", { documentRef: frames.items.find((frame) => frame.frameId === 0).documentRef, selector: "#click-count", limit: 1 })).items[0].nodeRef;
    }
    const ensureClick = async (snapshot, calibrationStatus = "reused") => {
      const response = await invoke("ensure.run", {
        timeoutMs: 3000,
        action: { method: "virtualMouse.click", schemaVersion: 1, params: { tabRef, at: center(snapshot.rects.hover), timeoutMs: 2000 } },
        goal: { kind: "text_contains", target: { kind: "node", nodeRef: counterNode }, text: `${snapshot.clickCount + 1} clicks` },
      });
      assert.equal(response.ok, true, JSON.stringify(response));
      const trace = (await call("trace.read", { traceRef: response.trace.traceRef })).trace;
      assert.deepEqual(trace.events.filter((event) => event.operation === "input_calibration").map((event) => event.status), calibrationStatus === null ? [] : [calibrationStatus]);
      return response.result;
    };
    if (mode === "occlusion-calibrated") {
      for (const [method, params] of [["virtualMouse.click", { tabRef }], ["ensure.run", { mode: "strict", precondition: { kind: "tab_active", tabRef }, action: { method: "virtualMouse.click", schemaVersion: 1, params: { tabRef } } }]]) {
        const rejected = await invoke(method, params);
        assert.equal(rejected.error?.details?.reason, "CalibrationRequired", JSON.stringify(rejected));
        assert.equal(rejected.error.details.progress.completedActions, 0);
      }
      assert.equal((await inspect()).events.filter((e) => e.type === "click").length, 0);
      const prepared = await ensureClick(await inspect(), "updated");
      assert.equal(prepared.status, "satisfied"); assert.equal(prepared.effectSent, true);
    }
    assert.equal((await call("input.calibrate", { tabRef })).updated, true);
    if (mode === "occlusion-calibrated") {
      await pageEvaluate(workerClient, async (id) => chrome.windows.update(id, { width: 950 }), windowId);
      const stale = await invoke("virtualMouse.move", { tabRef, x: 1, y: 1 });
      assert.equal(stale.error?.details?.reason, "CalibrationStale", JSON.stringify(stale));
      assert.equal(stale.error.details.progress.completedActions, 0);
      assert.equal((await ensureClick(await inspect(), "updated")).status, "satisfied");
    }
    if (mode.startsWith("occlusion")) {
      await call("virtualMouse.click", { tabRef, at: center(before.rects.hover) });
      if (mode === "occlusion-root") await call("virtualMouse.reset", {}); // The experiment owns its own root input backend.
      if (["occlusion-root", "occlusion-accessibility", "occlusion-calibrated"].includes(mode)) {
        rootTitle = await pageEvaluate(workerClient, async (url) => {
          const tab = (await chrome.tabs.query({})).find((entry) => entry.url === url);
          const marker = `BKA root probe ${crypto.randomUUID()}`;
          const page = (await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: (marker) => {
            const old = document.title; document.title = marker;
            return { old, width: innerWidth, height: innerHeight };
          }, args: [marker] }))[0].result;
          return { ...page, marker, tabId: tab.id };
        }, url);
        rootProbe = await startRootProbe(rootTitle, center(before.rects.hover));
        observations.push({ nativeCalibration: rootProbe.ready }); await persist();
        if (mode === "occlusion-root") {
          observations.push({ visibleMeasurement: await rootProbe.measure() }); await persist();
          observations.push({ visibleTargetDpiMeasurement: await rootProbe.measureTargetDpi() }); await persist();
        }
      }
      const coverUrl = new URL("dom-pointer#cover", baseUrl).href;
      coverId = await pageEvaluate(workerClient, async (url) => (await chrome.windows.create({ url, focused: true, state: "normal", left: 60, top: 60, width: 1000, height: 740 })).id, coverUrl);
      if (rootProbe) {
        const marker = await pageEvaluate(workerClient, async (url) => {
          let tab;
          for (let i = 0; i < 50; ++i) {
            tab = (await chrome.tabs.query({})).find((entry) => entry.url === url && entry.status === "complete");
            if (tab) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          const marker = `BKA cover ${crypto.randomUUID()}`;
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (title) => { document.title = title; }, args: [marker] });
          return marker;
        }, coverUrl);
        const cover = await rootProbe.cover(marker);
        observations.push({ nativeCover: cover }); await persist();
        assert.ok(cover.coverRaised && cover.coversRoot, "The fixture cover must actually cover the entire target window");
      }
      const occlusionDeadline = Date.now() + 5000;
      let occluded;
      do {
        occluded = await inspect();
        if (occluded.visibility === "hidden") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < occlusionDeadline);
      observations.push({ occluded }); await persist();
      if (mode === "occlusion-calibrated") {
        const nativeBefore = await rootProbe.state(); observations.push({ nativeBefore }); await persist();
        let prior = occluded;
        for (let i = 0; i < 3; ++i) {
          const result = await ensureClick(prior);
          assert.equal(result.status, "satisfied");
          const after = await inspect(), nativeAfter = await rootProbe.state();
          observations.push({ reuseIndex: i, after, nativeAfter }); await persist();
          assertCoveredInput({ before: prior, after, nativeBefore, nativeAfter, response: { ok: true }, point: center(prior.rects.hover) });
          prior = after;
        }
        if (occluded.visibility === "hidden") {
          const unavailable = await invoke("input.calibrate", { tabRef, timeoutMs: 1000 });
          assert.equal(unavailable.error?.details?.reason, "ContentNotMatched", JSON.stringify(unavailable));
          // A failed refresh must not destroy a still-valid calibration.
          assert.equal((await ensureClick(prior)).status, "satisfied");
          await call("virtualMouse.reset", {});
          const failed = await ensureClick(await inspect(), null);
          assert.equal(failed.status, "failed"); assert.equal(failed.stage, "prepare"); assert.equal(failed.effectSent, false);
        }
        observations.push({ observation: "显式校准及 ensure 自动校准通过；尺寸变化拒绝旧校准，连续遮挡点击复用有效测量，窗口不移位、不抢前台。" });
        await persist();
        return { mode, observations: observations.length, sampleRoot, pageVisibility: occluded.visibility };
      }
      if (mode === "occlusion-root") {
        observations.push({ coveredMeasurement: await rootProbe.measure() }); await persist();
        observations.push({ coveredTargetDpiMeasurement: await rootProbe.measureTargetDpi() }); await persist();
      }
      if (mode === "occlusion-accessibility") {
        const nativeBefore = await rootProbe.state(); observations.push({ nativeBefore }); await persist();
        const point = center(before.rects.hover);
        // No MSAA/UIA query precedes this control. A rejected lookup is useful
        // evidence, but a partial input or an unrelated failure ends the probe.
        const controlResponse = await invoke("virtualMouse.click", { tabRef, at: point });
        const controlAfter = await inspect(), nativeControlAfter = await rootProbe.state();
        observations.push({ controlAfter, nativeControlAfter }); await persist();
        assertCoveredWindow(nativeBefore, nativeControlAfter);
        assert.equal(controlAfter.documentToken, before.documentToken);
        if (controlResponse.ok) {
          assertCoveredInput({ before: occluded, after: controlAfter, nativeBefore, nativeAfter: nativeControlAfter, response: controlResponse, point });
        } else {
          assert.equal(controlResponse.error?.details?.reason, "ContentNotMatched", JSON.stringify(controlResponse));
          assert.equal(controlResponse.error.details.progress.completedActions, 0);
          assert.equal(controlAfter.events.length, occluded.events.length, "A rejected control must not deliver partial input");
        }
        observations.push({ accessibilityQuery: await rootProbe.measureUia() }); await persist();
        const deadline = Date.now() + 5000;
        let accessible;
        do {
          accessible = await inspect();
          if (accessible.visibility === "visible") break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        observations.push({ accessible }); await persist();
        const response = await invoke("virtualMouse.click", { tabRef, at: point });
        const after = await inspect(); observations.push({ after }); await persist();
        const nativeAfter = await rootProbe.state(); observations.push({ nativeAfter }); await persist();
        assertCoveredInput({ before: controlAfter, after, nativeBefore, nativeAfter, response, point });
        return { mode, observations: observations.length, sampleRoot, controlSucceeded: controlResponse.ok,
          pageVisibilityBefore: occluded.visibility, pageVisibilityAfter: after.visibility };
      }
      assert.equal(occluded.visibility, "hidden", "The native occlusion tracker must confirm the root/hidden experiment precondition");
      let rootInput;
      if (rootProbe) { rootInput = await rootProbe.click(); observations.push({ rootInput }); await persist(); }
      else await call("virtualMouse.click", { tabRef, at: center(before.rects.hover) });
      const after = await inspect(); observations.push({ after }); await persist();
      assertOccludedInput({ before, occluded, after, rootInput, point: center(before.rects.hover) });
    } else {
      const from = center(before.rects.source), to = center(before.rects.drop);
      if (mode === "html5-batch" || mode.endsWith("-diag")) {
        await call("virtualMouse.drag", { tabRef, from, via: [{ x: from.x + 15, y: from.y + 5 }], to });
      } else {
        await call("virtualMouse.move", { tabRef, ...from });
        await call("virtualMouse.down", { tabRef });
        await call("virtualMouse.move", { tabRef, x: from.x + 15, y: from.y + 5 });
        observations.push({ dragStarted: await inspect() }); await persist();
        await call("virtualMouse.move", { tabRef, ...to });
        await call("virtualMouse.up", { tabRef });
      }
      const deadline = Date.now() + 3000;
      let after;
      do { after = await inspect(); if (after.dropData === "fixture-card") break; await new Promise((resolve) => setTimeout(resolve, 50)); } while (Date.now() < deadline);
      observations.push({ after });
      assertNativeDragDrop({ before, after, point: to });
    }
    return { mode, observations: observations.length, sampleRoot };
  } finally {
    await persist();
    rootProbe?.close();
    if (rootTitle) await pageEvaluate(workerClient, async ({ tabId, marker, old }) => chrome.scripting.executeScript({
      target: { tabId }, world: "MAIN", func: (marker, old) => { if (document.title === marker) document.title = old; }, args: [marker, old],
    }), rootTitle).catch(() => {});
    if (coverId) await pageEvaluate(workerClient, async (id) => chrome.windows.remove(id), coverId).catch(() => {});
    if (!diagnosticDeadlineExpired) {
      await call("virtualMouse.reset", {}).catch(() => {});
      await call("control.release", { scope: "window", windowId }).catch(() => {});
      if (tabRef) await call("tabs.close", { tabRef }).catch(() => {});
    }
    await persist();
  }
}

export function assertNativeDragDrop({ before, after, point }) {
  assert.equal(after.documentToken, before.documentToken, "Native drag must finish in the same document");
  assert.equal(after.dropData, "fixture-card", "Native HTML5 drag must actually deliver DataTransfer at drop");
  const added = after.events.slice(before.events.length);
  for (const [type, target] of [["drop", "drop"], ["dragend", "source"]]) {
    const events = added.filter((event) => event.type === type);
    assert.equal(events.length, 1, `Native drag must produce exactly one new ${type}`);
    assert.equal(events[0].target, target);
    assert.equal(events[0].trusted, true);
    assert.equal(events[0].buttons, 0, `${type} must observe the released button state`);
    assert.deepEqual([events[0].x, events[0].y], [point.x, point.y], `${type} must retain the virtual drop coordinates`);
  }
}

export function assertOccludedInput({ before, occluded, after, rootInput, point }) {
  assert.equal(occluded.visibility, "hidden", "The page-hidden precondition must be observed");
  assert.equal(occluded.documentToken, before.documentToken);
  assert.equal(after.documentToken, before.documentToken);
  if (rootInput) {
    assert.equal(rootInput.result, 0);
    assert.equal(rootInput.foregroundUnchanged, true, "Virtual input must not acquire the OS foreground");
    assert.equal(rootInput.legacyVisibleBefore, false, "The original legacy target must actually be hidden");
  }
  assert.equal(after.visibility, "hidden", "Input must not expose the hidden page as a shortcut");
  const clicks = after.events.slice(occluded.events.length).filter((entry) => entry.type === "click" && entry.target === "hover");
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].trusted, true);
  assert.deepEqual([clicks[0].x, clicks[0].y], [point.x, point.y]);
}

function assertCoveredWindow(before, after) {
  for (const state of [before, after]) {
    assert.equal(state.covered, true, "The target window must remain physically covered");
    assert.equal(state.rootUnchanged, true, "The target window must retain its position and size");
  }
  assert.equal(after.foreground, before.foreground, "Input must not change the OS foreground");
}

export function assertCoveredInput({ before, after, nativeBefore, nativeAfter, response, point }) {
  assertCoveredWindow(nativeBefore, nativeAfter);
  assert.equal(response?.ok, true, JSON.stringify(response));
  assert.equal(after.documentToken, before.documentToken);
  // Page visibility and legacy HWND visibility are recorded, not requirements.
  const clicks = after.events.slice(before.events.length).filter((event) => event.type === "click");
  assert.equal(clicks.length, 1, "Each covered-window command must deliver exactly one new click");
  assert.equal(clicks[0].target, "hover");
  assert.equal(clicks[0].trusted, true);
  assert.deepEqual([clicks[0].x, clicks[0].y], [point.x, point.y]);
}

async function startRootProbe(page, point) {
  const executable = fileURLToPath(new URL("../../../zig-out/bin/occluded-root-probe.exe", import.meta.url));
  const child = spawn(executable, [page.marker, String(page.width), String(page.height), String(point.x), String(point.y)], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const stopped = new Promise((_, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`root probe exited ${code}: ${stderr}`)));
  });
  const read = async () => {
    let timer;
    try {
      const line = await Promise.race([lines.next(), stopped, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("root probe phase timed out")), 5000);
      })]);
      if (line.done) return await stopped;
      return { ...JSON.parse(line.value), diagnostics: stderr };
    } finally { clearTimeout(timer); }
  };
  const close = () => { child.stdin.end(); if (child.exitCode === null) child.kill(); };
  try {
    const ready = await read(); assert.equal(ready.ready, true);
    const command = (value) => { const waiting = read(); child.stdin.write(`${value}\n`); return waiting; };
    return { ready, click: () => command("click"), state: () => command("state"), measure: () => command("measure"), measureTargetDpi: () => command("measure-target-dpi"), measureUia: () => command("measure-uia"),
      cover: (marker) => command(`cover ${marker}`), close };
  } catch (error) { close(); throw error; }
}
