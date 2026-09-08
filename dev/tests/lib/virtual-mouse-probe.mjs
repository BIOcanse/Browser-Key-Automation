import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pageEvaluate } from "./cdp-client.mjs";
import { saveArtifactFile } from "../../../app/client/src/artifact-files.mjs";

// Headed, empty-profile Chromium. Instrumentation reads only; product commands
// perform all input. Physical keyboard cooperation is a separate explicit gate.
export async function runVirtualMouseProbe({ forward, sampleRoot, baseUrl, windowId, workerClient, scopedForward, recycleWorker, realInputAcceptance = false }) {
  await mkdir(sampleRoot, { recursive: true });
  await writeFile(path.join(sampleRoot, "original.html"), await readFile(new URL("./fixtures/dom-pointer.html", import.meta.url)));
  const observations = [];
  const fixtureUrl = new URL("dom-pointer#key-input", baseUrl).href;
  let tabRef, other, extra, extraWindow;
  const call = async (method, params, error, channel = forward) => {
    const response = await channel(method, params);
    assert.ok(response.payload, JSON.stringify(response));
    observations.push({ step: observations.length + 1, method, params, response: response.payload });
    if (error) { assert.equal(response.payload.error?.code, error, JSON.stringify(response.payload)); return response.payload.error; }
    assert.equal(response.payload.ok, true, JSON.stringify(response.payload)); return response.payload.result;
  };
  const inspect = () => pageEvaluate(workerClient, async (fixtureUrl) => {
    const tab = (await chrome.tabs.query({})).find((item) => item.url === fixtureUrl);
    const entries = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: () => globalThis.__pointerProbe?.snapshot() ?? null });
    return entries[0].result;
  }, fixtureUrl);
  const observe = async (predicate) => {
    const deadline = Date.now() + 5000;
    let snapshot;
    do { snapshot = await inspect(); if (snapshot && predicate(snapshot)) return snapshot; await new Promise((resolve) => setTimeout(resolve, 50)); } while (Date.now() < deadline);
    observations.push({ failedObservation: snapshot });
    assert.ok(predicate(snapshot), JSON.stringify(snapshot));
  };
  try {
    tabRef = (await call("tabs.create", { url: fixtureUrl, active: true, windowId })).tab.tabRef;
    await call("page.wait", { tabRef });
    if (process.argv.includes("--window-coordinates-only")) {
      await call("control.acquire", { scope: "window", windowId });
      const at = { x: 260, y: 300 };
      const moved = await call("virtualMouse.moveWindow", { tabRef, ...at });
      assert.equal(moved.coordinates, "window");
      assert.deepEqual(moved.mouse.point, at);
      const first = await observe(value => value.events.some(event => event.type === "mousemove"));
      const initialPoint = first.events.findLast(event => event.type === "mousemove");
      await pageEvaluate(workerClient, async fixtureUrl => {
        const tab = (await chrome.tabs.query({})).find(tab => tab.url === fixtureUrl);
        await chrome.scripting.executeScript({target:{tabId:tab.id},world:"MAIN",func:()=>{
          history.replaceState({windowMouseStage:0},"");history.pushState({windowMouseStage:1},"");
        }});
      }, fixtureUrl);
      const historyStage = () => pageEvaluate(workerClient, async fixtureUrl => {
        const tab = (await chrome.tabs.query({})).find(tab => tab.url === fixtureUrl);
        return (await chrome.scripting.executeScript({target:{tabId:tab.id},world:"MAIN",func:()=>history.state?.windowMouseStage}))[0].result;
      }, fixtureUrl);
      for (const [button, mask, stage] of [["back",8,0],["forward",16,1]]) {
        const down = await call("virtualMouse.down", {tabRef,button});
        assert.equal(down.mouse.buttons,mask);assert.equal(down.coordinates,"window");
        const up = await call("virtualMouse.up", {tabRef,button});assert.equal(up.mouse.buttons,0);
        const deadline = Date.now()+2500;
        while(await historyStage()!==stage&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
        assert.equal(await historyStage(),stage,`${button} must perform the corresponding browser history action`);
      }
      const old = (await call("windows.get", {windowId})).bounds;
      await call("windows.setBounds", {windowId,left:old.left+60,top:old.top+45,width:old.width-40,height:old.height-30});
      const resized = await call("virtualMouse.moveWindow", {tabRef,...at});assert.equal(resized.coordinates,"window");
      const after = await observe(value => value.events.filter(event => event.type === "mousemove").length>1);
      const finalPoint=after.events.findLast(event=>event.type==="mousemove");
      assert.deepEqual([finalPoint.x,finalPoint.y],[initialPoint.x,initialPoint.y]);
      const scroll=await call("virtualMouse.scroll",{tabRef,deltaY:-120,deltaX:120});assert.equal(scroll.coordinates,"window");
      const invalid=await call("virtualMouse.moveWindow",{tabRef,x:32767,y:32767},"NATIVE_INPUT_FAILED");
      assert.equal(invalid.details.progress.completedActions,0);
      await call("virtualMouse.moveWindow",{tabRef,x:450,y:15}); // title bar, not page space
      const toolbar=await call("virtualMouse.moveWindow",{tabRef,x:450,y:65});assert.equal(toolbar.coordinates,"window");
      await call("windows.setBounds",{windowId,...old});
      const saved = await call("actions.create", {name:"Window side buttons",description:"Replay both side buttons at a native window point",instructions:[{
        method:"virtualMouse.input",schemaVersion:1,params:{tabRef:null,actions:[{kind:"moveWindow",...at},
          {kind:"button",button:"back",action:"press"},{kind:"button",button:"forward",action:"press"}]},
        bindings:[{path:["tabRef"],source:{kind:"tab",alias:"window",selector:{urlPattern:fixtureUrl,urlMatch:"exact",title:null,windowId:null}}}],delayMs:0,
      }]});
      assert.equal((await call("actions.run",{actionId:saved.action.actionId})).status,"succeeded");
      assert.equal(await historyStage(),1);
      await call("actions.delete",{actionId:saved.action.actionId,revision:saved.action.revision});
      await call("virtualMouse.moveWindow",{tabRef,x:900,y:600});
      await call("virtualMouse.down",{tabRef,button:"middle"});
      await call("windows.setBounds",{windowId,width:700,height:450});
      assert.equal((await call("virtualMouse.reset",{})).mouse.buttons,0,"resize must not strand a delivered button");
      await call("windows.setBounds",{windowId,...old});
      observations.push({observation:"Window pixels work before CSS calibration; side buttons change history; move/resize preserves relative page position; wheel and non-client motion use the same pointer."});
      return {sampleRoot,observations:observations.length,windowCoordinates:"passed",sideButtons:"passed"};
    }
    assert.equal((await call("virtualMouse.get", {})).initialized, false);
    await call("virtualMouse.move", { tabRef, x: 1, y: 1 }, "CONTROL_OCCUPIED");
    await call("control.acquire", { scope: "window", windowId });
    assert.equal((await inspect()).events.length, 0, "reads and acquire do not synthesize input");
    const uncalibrated = await call("virtualMouse.move", { tabRef, x: 1, y: 1 }, "NATIVE_INPUT_FAILED");
    assert.equal(uncalibrated.details.reason, "CalibrationRequired");
    assert.equal(uncalibrated.details.progress.completedActions, 0);
    assert.equal((await call("input.calibrate", { tabRef })).updated, true);
    await call("virtualMouse.interception", { tabRef, enabled: true });
    const snapshot = await inspect();
    const point = (rect, x, y) => ({ kind: "move", x: Math.round(rect.x + x), y: Math.round(rect.y + y) });
    await call("virtualMouse.input", { tabRef, actions: [point(snapshot.rects.hover, 20, 20)] });
    const hover = await observe((value) => value.cssHover && value.hoverText === "hovered");
    assert.ok(hover.events.some((event) => event.type === "pointermove" && event.trusted));
    observations.push({ observation: "虚拟移动使 Hover target 变色并显示 hovered，收到 trusted 事件。", snapshot: hover });

    await call("virtualMouse.input", { tabRef, actions: [point(snapshot.rects.pad, 15, 20), { kind: "button", button: "left", action: "down" }] });
    assert.equal((await call("virtualMouse.get", {})).mouse.buttons, 1);
    await call("virtualMouse.input", { tabRef, actions: [point(snapshot.rects.pad, 100, 50), point(snapshot.rects.pad, 260, 85)] });
    await call("virtualMouse.reset", {});
    const drawing = await observe((value) => !value.drawing && value.points.length > 0);
    assert.ok(Math.abs(drawing.points.at(-1)[0] - 260) <= 1 && Math.abs(drawing.points.at(-1)[1] - 85) <= 1, "native/CSS round trip must stay within one CSS pixel");
    assert.equal((await call("virtualMouse.get", {})).mouse.buttons, 0);
    observations.push({ observation: "跨命令保留按下状态，Canvas 绘出线段；reset 释放按钮并结束绘制。", snapshot: drawing });

    const xy = (rect, x, y) => { const { kind, ...value } = point(rect, x, y); return value; };
    const hoverAt = xy(snapshot.rects.hover, 20, 20);
    await call("input.calibrate", { tabRef }); // reset released the native resource.
    const moved = await call("virtualMouse.move", { tabRef, ...hoverAt });
    assert.equal(moved.completedActions, 1);
    const beforeClick = (await inspect()).events.length;
    const clicked = await call("virtualMouse.click", { tabRef });
    assert.equal(clicked.completedActions, 1, "one press is one meta-action, not two click counts");
    const clickedPage = await observe((value) => value.events.slice(beforeClick).some((event) => event.type === "click" && event.target === "hover"));
    assert.deepEqual(clickedPage.events.slice(beforeClick).filter((event) => ["mousedown", "mouseup", "click"].includes(event.type)).map((event) => event.type), ["mousedown", "mouseup", "click"]);
    assert.ok(clickedPage.events.slice(beforeClick).every((event) => event.trusted));
    const beforeRight = clickedPage.events.length;
    await call("virtualMouse.click", { tabRef, at: xy(snapshot.rects.hover, 45, 20), button: "right" });
    const rightPage = await observe((value) => value.events.slice(beforeRight).some((event) => event.type === "contextmenu" && event.trusted));
    observations.push({ observation: "快捷 move 悬停；click 收到恰好一次 down/up/click，右键参数收到 trusted contextmenu。", snapshot: rightPage });

    await call("virtualMouse.move", { tabRef, ...xy(snapshot.rects.pad, 20, 95) });
    const held = await call("virtualMouse.down", { tabRef });
    assert.equal(held.mouse.buttons, 1);
    const rejectedClick = await call("virtualMouse.click", { tabRef, at: hoverAt }, "NATIVE_INPUT_FAILED");
    assert.equal(rejectedClick.details.reason, "ButtonAlreadyDown");
    assert.equal(rejectedClick.details.progress.completedActions, 0);
    assert.deepEqual((await call("virtualMouse.get", {})).mouse.point, held.mouse.point, "invalid complete click must not first move");
    await call("virtualMouse.up", { tabRef });
    assert.equal((await call("virtualMouse.get", {})).mouse.buttons, 0);
    const dragged = await call("virtualMouse.drag", { tabRef, from: xy(snapshot.rects.pad, 20, 95),
      via: [xy(snapshot.rects.pad, 100, 70), xy(snapshot.rects.pad, 160, 55)], to: xy(snapshot.rects.pad, 230, 30) });
    assert.equal(dragged.completedActions, 6);
    assert.equal(dragged.mouse.buttons, 0);
    const shortcutDrawing = await observe((value) => !value.drawing && value.points.length > 0);
    assert.ok(Math.abs(shortcutDrawing.points.at(-1)[0] - 230) <= 1 && Math.abs(shortcutDrawing.points.at(-1)[1] - 30) <= 1);
    observations.push({ observation: "快捷 drag 按途经点顺序投递并在终点抬起；页面可能合并中间 move。按住时的 click 被整串拒绝，位置未先改变。", snapshot: shortcutDrawing });
    const beforeBad = (await call("virtualMouse.get", {})).mouse;
    await call("virtualMouse.drag", { tabRef, from: hoverAt, to: { x: 32767, y: 1 } }, "NATIVE_INPUT_FAILED");
    const afterBad = (await call("virtualMouse.get", {})).mouse;
    assert.deepEqual(afterBad.point, beforeBad.point);
    assert.equal(afterBad.buttons, beforeBad.buttons);

    await call("virtualMouse.down", { tabRef });
    const continued = await call("virtualMouse.drag", { tabRef, to: xy(snapshot.rects.pad, 250, 20) });
    assert.equal(continued.completedActions, 3);
    assert.equal(continued.mouse.buttons, 0, "drag explicitly ends with up, including an initially held button");
    await call("virtualMouse.scroll", { tabRef, at: xy(snapshot.rects.scrollbox, 20, 20), deltaY: -120 });
    const scrolled = await observe((value) => value.scrollTop > 0 && value.events.some((event) => event.type === "wheel" && event.trusted));
    observations.push({ observation: "快捷 scroll 在指定内部滚动区产生 trusted wheel，scrollTop 增加。", snapshot: scrolled });
    await call("virtualMouse.scroll", { tabRef, deltaX: 120 });
    const scrolledBoth = await observe((value) => value.scrollLeft > 0 && value.events.some((event) => event.type === "wheel" && event.deltaX > 0 && event.trusted));
    observations.push({ observation: "省略 at 的横向 scroll 沿用当前位置，内部滚动区 scrollLeft 增加并收到 trusted 横向 wheel。", snapshot: scrolledBoth });

    // Investigate, but do not advertise a doubleClick shortcut without a stable
    // native/browser click-count contract. Two presses stay available as input.
    const beforePair = scrolledBoth.events.length;
    await call("virtualMouse.input", { tabRef, actions: [point(snapshot.rects.hover, 85, 20),
      { kind: "button", button: "left", action: "press" }, { kind: "button", button: "left", action: "press" }] });
    const pair = await observe((value) => value.events.slice(beforePair).filter((event) => event.type === "click").length >= 2);
    observations.push({ observation: "两次 press 的浏览器双击实验，不把请求成功当作 dblclick。",
      clickEvents: pair.events.slice(beforePair).filter((event) => ["click", "dblclick"].includes(event.type)) });
    const image = await call("page.screenshot.capture", { tabRef });
    await saveArtifactFile({ call: (method, params) => call(method, params), artifactRef: image.artifact.artifactRef, output: path.join(sampleRoot, "virtual-drag.png") });
    await call("artifact.release", { artifactRef: image.artifact.artifactRef });
    await call("virtualMouse.interception", { tabRef, enabled: false });
    const frames = await call("frames.list", { tabRef });
    const main = frames.items.find((frame) => frame.frameId === 0);
    const query = async (selector, documentRef = main.documentRef) => (await call("dom.query", { documentRef, selector, limit: 1 })).items[0].nodeRef;
    const pad = await query("#pad"), source = await query("#source"), drop = await query("#drop");
    await call("virtualMouse.dragDrop", { fromNodeRef: pad, toNodeRef: pad, fromOffset: { x: 25, y: 35 }, toOffset: { x: 250, y: 85 } });
    await observe((value) => !value.drawing && Math.abs(value.points.at(-1)?.[0] - 250) <= 1);
    observations.push({ observation: "元素快捷拖放按内部偏移绘制 Canvas，终点已抬起。", snapshot: await inspect() });
    await call("virtualMouse.dragDrop", { fromNodeRef: source, toNodeRef: drop });
    const dropped = await observe((value) => value.dropData === "fixture-card");
    observations.push({ observation: "卡片拖入接收区，网页实际显示 Received: fixture-card。", snapshot: dropped });
    const child = frames.items.find((frame) => frame.frameId !== 0);
    const inside = await query("#inside", child.documentRef);
    await call("virtualMouse.dragDrop", { fromNodeRef: inside, toNodeRef: inside, fromOffset: { x: 20, y: 15 }, toOffset: { x: 70, y: 25 } });
    assert.equal((await call("dom.describe", { nodeRef: inside })).descriptor.text, "frame hovered");
    const key = (action, name, target = tabRef) => call("virtualKeyboard.input", { tabRef: target, keys: [{ action, key: name }] });
    await key("down", "Ctrl");
    assert.ok((await call("virtualKeyboard.get", {})).keyboard.heldKeys.includes("ControlLeft"));
    const beforeCtrlClick = (await inspect()).events.length;
    await call("virtualMouse.click", { tabRef, at: hoverAt });
    await observe((value) => value.events.slice(beforeCtrlClick).some((event) => event.type === "click" && event.ctrlKey));
    const beforeSwitch = await call("virtualMouse.get", {});
    other = (await call("tabs.create", { url: fixtureUrl + "-other", active: true, windowId })).tab.tabRef;
    await call("page.wait", { tabRef: other });
    await call("virtualMouse.click", { tabRef }, "NATIVE_INPUT_FAILED");
    assert.deepEqual((await call("virtualMouse.get", {})).mouse, beforeSwitch.mouse);
    assert.equal((await call("virtualMouse.click", { tabRef: other, at: hoverAt }, "NATIVE_INPUT_FAILED")).details.reason, "CalibrationStale");
    await call("input.calibrate", { tabRef: other });
    await call("virtualMouse.click", { tabRef: other, at: hoverAt });
    const otherState = await pageEvaluate(workerClient, async (url) => {
      const tab = (await chrome.tabs.query({})).find((item) => item.url === url);
      return (await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: () => globalThis.__pointerProbe.snapshot() }))[0].result;
    }, fixtureUrl + "-other");
    assert.ok(otherState.events.some((event) => event.type === "click" && event.ctrlKey));
    await key("up", "Ctrl", other);
    await call("tabs.activate", { tabRef });
    await call("input.calibrate", { tabRef });
    await call("dom.focus", { nodeRef: await query("#keys") });
    await call("virtualKeyboard.input", { tabRef, keys: ["A"] });
    await observe((value) => value.keyValue === "a");
    await call("virtualMouse.interception", { tabRef, enabled: true });
    await key("down", "Shift");
    if (realInputAcceptance) await call("keyboard.press", { targetRef: tabRef, keys: ["B"] });
    else await call("virtualKeyboard.input", { tabRef, keys: ["B"] });
    await observe((value) => value.keyValue === "aB");
    if (realInputAcceptance) await observe((value) => value.events.some((event) => event.type === "keyup" && event.code === "KeyB" && event.shiftKey && !event.ctrlKey));
    assert.ok((await call("virtualKeyboard.get", {})).keyboard.heldKeys.includes("ShiftLeft"));
    await key("up", "Shift");
    if (realInputAcceptance) await call("keyboard.press", { targetRef: tabRef, keys: [{ action: "down", key: "Shift" }] });
    else await key("down", "Shift");
    await call("virtualMouse.dragDrop", { fromNodeRef: pad, toNodeRef: pad, fromOffset: { x: 25, y: 35 }, toOffset: { x: 250, y: 85 } });
    assert.ok((await inspect()).events.some((event) => event.type === "pointerdown" && event.shiftKey));
    await key("up", "Shift");
    assert.deepEqual((await call("virtualKeyboard.get", {})).keyboard.heldKeys, []);
    observations.push({ observation: realInputAcceptance ? "虚拟 Ctrl 跨标签页生效；虚拟 Shift 配合真实 B 输入大写；真实 Shift-down 由虚拟 up 配对释放。" :
      "虚拟 Ctrl 跨标签页生效；虚拟 Shift 配合 B 输入大写及拖放后由虚拟 up 释放。此门不发系统键盘事件。", snapshot: await inspect() });
    await call("dom.focus", { nodeRef: await query("#keys") });
    const raw=(action,virtualKey=65,scanCode=30,extended=false,layout=null)=>({action,virtualKey,scanCode,extended,layout});
    const rawStart=await inspect();
    assert.equal((await call("virtualKeyboard.events",{tabRef,events:[raw("repeat")]},"NATIVE_INPUT_FAILED")).details.reason,"KeyNotHeld");
    const repeated=await call("virtualKeyboard.events",{tabRef,events:[raw("down"),raw("repeat"),raw("repeat"),raw("up")]});
    assert.equal(repeated.completedActions,4);
    const repeatedPage=await observe(value=>value.keyValue===rawStart.keyValue+"aaa");
    assert.deepEqual(repeatedPage.events.slice(rawStart.events.length).filter(event=>event.type==="keydown"&&event.code==="KeyA").map(event=>event.repeat),[false,true,true]);
    const message=(id,value,lParam)=>({action:"message",message:id,value,lParam,layout:null});
    const messages=await call("virtualKeyboard.events",{tabRef,events:[message(0x100,65,"001e0001"),message(0x102,97,"001e0001"),message(0x100,65,"401e0001"),message(0x102,97,"401e0001"),message(0x101,65,"c01e0001"),message(0x102,0xd83d,"00000001"),message(0x102,0xde42,"00000001")]});
    assert.equal(messages.completedActions,7);
    const messagePage=await observe(value=>value.keyValue===rawStart.keyValue+"aaaaa🙂");
    assert.deepEqual(messagePage.events.slice(repeatedPage.events.length).filter(event=>event.type==="keydown"&&event.code==="KeyA").map(event=>event.repeat),[false,true]);
    assert.deepEqual((await call("virtualKeyboard.get",{})).keyboard.heldKeys,[]);
    const rawControl={virtualKey:17,scanCode:29,extended:false,layout:null};
    await call("virtualKeyboard.events",{tabRef,events:[{...rawControl,action:"down"}]});
    assert.ok((await call("virtualKeyboard.get",{})).keyboard.heldKeys.includes("ControlLeft"));
    assert.equal((await call("virtualKeyboard.type",{tabRef,text:"blocked"},"NATIVE_INPUT_FAILED")).details.reason,"TextModifierHeld");
    await call("virtualKeyboard.events",{tabRef,events:[{...rawControl,action:"up",layout:"ffffffffffffffff"}]});
    assert.equal((await call("virtualKeyboard.get",{})).keyboard.heldKeys.includes("ControlLeft"),false);
    const typed=await call("virtualKeyboard.type",{tabRef,text:"中文🙂"});assert.equal(typed.submittedScalars,3);
    await observe(value=>value.keyValue===rawStart.keyValue+"aaaaa🙂中文🙂");
    const numpadStart=(await inspect()).events.length;
    await call("virtualKeyboard.events",{tabRef,events:[raw("down",13,28,true)]});
    assert.ok((await call("virtualKeyboard.get",{})).keyboard.heldKeys.includes("NumpadEnter"));
    await call("virtualKeyboard.events",{tabRef,events:[raw("up",13,28,true)]});
    await observe(value=>value.events.slice(numpadStart).some(event=>event.type==="keydown"&&event.code==="NumpadEnter"));
    const unavailable=await call("virtualKeyboard.events",{tabRef,events:[raw("down",65,30,false,"0000000000000001")]},"NATIVE_INPUT_FAILED");
    assert.equal(unavailable.details.reason,"KeyboardLayoutUnavailable");assert.equal(unavailable.details.progress.completedActions,0);
    const waitStart=(await inspect()).events.length;
    const waited=await call("virtualMouse.input",{tabRef,actions:[{kind:"move",...hoverAt},{kind:"button",button:"left",action:"down"},{kind:"wait",waitMs:80},{kind:"button",button:"left",action:"up"}]});
    assert.equal(waited.completedActions,4);
    const waitPage=await observe(value=>value.events.slice(waitStart).some(event=>event.type==="mouseup"));
    const down=waitPage.events.slice(waitStart).find(event=>event.type==="mousedown"),up=waitPage.events.slice(waitStart).find(event=>event.type==="mouseup");
    assert.ok(up.at-down.at>=65,`Explicit 80 ms wait observed ${up.at-down.at} ms`);
    observations.push({observation:"原始键事件保留扫描码、NumpadEnter 和 repeat；Unicode 虚拟提交输入中文/emoji，鼠标 wait 保留按住间隔；全程没有物理 SendInput。",snapshot:await inspect()});
    await key("down", "Ctrl");
    const retained = await call("virtualMouse.get", {});
    const oldDocument = (await inspect()).documentToken;
    await call("tabs.reload", { tabRef, bypassCache: false }); await call("page.wait", { tabRef });
    // reload() can resolve before the navigation starts; complete on the old
    // document is not evidence that its replacement has been loaded.
    await observe((value) => value.documentToken !== oldDocument);
    assert.deepEqual((await call("virtualMouse.get", {})).mouse, retained.mouse);
    assert.deepEqual((await call("virtualKeyboard.get", {})).keyboard, retained.keyboard);
    const refreshed = await inspect();
    observations.push({ observation: "新文档的事件原样保留；浏览器自身可生成 hover/enter，检查的是没有重放输入动作。", snapshot: refreshed });
    assert.deepEqual(refreshed.events.filter((event) => ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "keydown", "keyup", "wheel", "drop"].includes(event.type)), [], "refresh does not replay earlier input actions");
    assert.equal(refreshed.keyValue, "");
    assert.equal(refreshed.dropData, null);
    assert.deepEqual(refreshed.points, []);
    await pageEvaluate(workerClient, async (id) => { await chrome.windows.update(id, { width: 1000, height: 750 }); }, windowId);
    assert.deepEqual((await call("virtualMouse.get", {})).mouse, retained.mouse);
    if (recycleWorker) {
      workerClient = await recycleWorker();
      assert.deepEqual((await call("virtualMouse.get", {})).mouse, retained.mouse);
      assert.deepEqual((await call("virtualKeyboard.get", {})).keyboard, retained.keyboard);
      const tabs = await call("tabs.list", {});
      tabRef = tabs.items.find((tab) => tab.url === fixtureUrl).tabRef;
      other = tabs.items.find((tab) => tab.url === fixtureUrl + "-other").tabRef;
    }
    await call("virtualKeyboard.reset", {});
    assert.equal((await call("virtualMouse.move", { tabRef, x: 1, y: 1 }, "NATIVE_INPUT_FAILED")).details.reason, "CalibrationStale");
    await call("input.calibrate", { tabRef });
    const pendingKeys = call("virtualKeyboard.input", { tabRef, keys: [{ waitMs: 1000 }, "Z"], timeoutMs: 5000 }, "NATIVE_INPUT_FAILED");
    await pageEvaluate(workerClient, async ({ url, otherUrl }) => {
      const tabs = await chrome.tabs.query({});
      const original = tabs.find((tab) => tab.url === url), other = tabs.find((tab) => tab.url === otherUrl);
      let marked = false;
      for (let i = 0; i < 100; ++i) {
        const title = (await chrome.scripting.executeScript({ target: { tabId: original.id }, func: () => document.title }))[0].result;
        if (title.startsWith("BKA input ")) { marked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!marked) throw new Error("Input never entered the marked document");
      await new Promise((resolve) => setTimeout(resolve, 200));
      await chrome.tabs.update(other.id, { active: true });
    }, { url: fixtureUrl, otherUrl: fixtureUrl + "-other" });
    const changedDuringWait = await pendingKeys;
    assert.equal(changedDuringWait.details.reason, "CalibrationStale");
    assert.equal(changedDuringWait.details.progress.completedActions, 1, "only the explicit wait completed");
    const changedPage = await pageEvaluate(workerClient, async (url) => {
      const tab = (await chrome.tabs.query({})).find((item) => item.url === url);
      return (await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: () => globalThis.__pointerProbe.snapshot() }))[0].result;
    }, fixtureUrl + "-other");
    assert.ok(!changedPage.events.some((event) => event.code === "KeyZ"), "remaining keys must not follow a switched active document");
    observations.push({ observation: "键盘序列等待期间切换同窗口标签页，后续 Z 在投递前以 CalibrationStale 停止，新页面没有收到 KeyZ。", snapshot: changedPage });
    await call("tabs.activate", { tabRef });
    await call("input.calibrate", { tabRef });
    if (scopedForward) {
      const secondKey = await scopedForward(), second = secondKey.forward;
      await call("control.acquire", { scope: "window", windowId }, "CONTROL_OCCUPIED", second);
      await call("virtualMouse.click", { tabRef }, "CONTROL_OCCUPIED", second);
      await call("control.release", { scope: "window", windowId }, undefined, second);
      await call("control.acquire", { scope: "window", windowId }, undefined, second);
      await call("input.calibrate", { tabRef }, undefined, second);
      await call("virtualMouse.click", { tabRef, at: hoverAt }, undefined, second);
      await call("virtualKeyboard.input", { tabRef, keys: [{ action: "down", key: "Ctrl" }] }, undefined, second);
      const newWindow = await pageEvaluate(workerClient, async ({ url, windowId }) => {
        await chrome.windows.update(windowId, { state: "normal", left: 0, top: 0, width: 700, height: 700 });
        const created = await chrome.windows.create({ url, focused: true, state: "normal", left: 720, top: 0, width: 700, height: 700 });
        // Chromium startup --window-size/position can override create bounds.
        // Arrange the owned fixture after creation and record actual geometry.
        await chrome.windows.update(created.id, { focused: true, state: "normal", left: 720, top: 0, width: 700, height: 700 });
        return { id: created.id, tabId: created.tabs[0].id };
      }, { url: fixtureUrl + "-window", windowId });
      extraWindow = newWindow.id;
      extra = (await call("tabs.list", {})).items.find((tab) => tab.url === fixtureUrl + "-window").tabRef;
      await call("page.wait", { tabRef: extra });
      await call("control.acquire", { scope: "window", windowId: extraWindow });
      // windows.update resolves before Chromium's renderer necessarily receives
      // its new viewport. Observe this fixture's requested setup before the one-shot calibration.
      let calibrationLayout;
      const layoutDeadline=Date.now()+5000;
      while(Date.now()<layoutDeadline){
        calibrationLayout=await pageEvaluate(workerClient,async({windowId,tabId})=>({
          window:await chrome.windows.get(windowId),tab:await chrome.tabs.get(tabId),
          page:(await chrome.scripting.executeScript({target:{tabId},func:()=>({width:innerWidth,height:innerHeight,dpi:devicePixelRatio,visibility:document.visibilityState})}))[0].result,
        }),{windowId:extraWindow,tabId:newWindow.tabId});
        if(calibrationLayout.page.visibility==='visible'&&calibrationLayout.page.width===calibrationLayout.tab.width&&calibrationLayout.page.height===calibrationLayout.tab.height)break;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      observations.push({initialWindowCalibration:calibrationLayout});
      assert.equal(calibrationLayout.page.visibility,'visible','The owned fixture must finish presentation before initial calibration');
      assert.equal(calibrationLayout.page.width,calibrationLayout.tab.width);
      assert.equal(calibrationLayout.page.height,calibrationLayout.tab.height);
      await call("input.calibrate", { tabRef: extra });
      // Initial measurement needs an available content region; then deliver to
      // this calibrated background window while the first fixture is foreground.
      await pageEvaluate(workerClient, async (id) => chrome.windows.update(id, { focused: true }), windowId);
      await call("virtualMouse.click", { tabRef: extra, at: hoverAt });
      assert.deepEqual((await call("virtualKeyboard.get", {})).keyboard.heldKeys, []);
      assert.ok((await call("virtualKeyboard.get", {}, undefined, second)).keyboard.heldKeys.includes("ControlLeft"));
      await call("control.release", { scope: "window", windowId: extraWindow });
      assert.ok((await call("virtualKeyboard.get", {}, undefined, second)).keyboard.heldKeys.includes("ControlLeft"));
      await call("input.calibrate", { tabRef }, undefined, second);
      await call("virtualMouse.interception", { tabRef, enabled: true }, undefined, second);
      // Administrative mutation must recover the live offscreen transport even
      // when no new routed Key command has reached the replacement worker yet.
      if (recycleWorker) workerClient = await recycleWorker();
      const revoked = await secondKey.revoke();
      assert.equal(revoked.status, "revoked");
      await call("virtualKeyboard.get", {}, "UNAUTHENTICATED", second);
      const liveTabs = (await call("tabs.list", {})).items;
      tabRef = liveTabs.find((tab) => tab.url === fixtureUrl).tabRef;
      other = liveTabs.find((tab) => tab.url === fixtureUrl + "-other").tabRef;
      extra = liveTabs.find((tab) => tab.url === fixtureUrl + "-window").tabRef;
      await call("control.release", { scope: "window", windowId });
      await call("control.acquire", { scope: "window", windowId });
      await call("input.calibrate", { tabRef });
      await call("virtualMouse.click", { tabRef, at: hoverAt });
      observations.push({ observation: "两个 Key 分别操作不同窗口，键盘状态互不污染；后台回收后只经管理入口撤销 Key，完成原生清理，原窗口可重新接管。" });
    }
    observations.push({ observation: "刷新、窗口调整大小与后台回收保留 Key 状态；另一 Key 必须先解除再占据才能接管。" });
    return { sampleRoot, observations: observations.length, nativeVirtualInput: "passed" };
  } finally {
    await call("virtualKeyboard.reset", {}).catch(() => {});
    await call("virtualMouse.reset", {}).catch(() => {});
    await call("control.release", { scope: "window", windowId }).catch(() => {});
    if (extraWindow) await call("control.release", { scope: "window", windowId: extraWindow }).catch(() => {});
    for (const ref of [extra, other, tabRef]) if (ref) await call("tabs.close", { tabRef: ref }).catch(() => {});
    await writeFile(path.join(sampleRoot, "observations.json"), JSON.stringify(observations, null, 2) + "\n");
  }
}
