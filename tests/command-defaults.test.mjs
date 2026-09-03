import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COMMAND_CATALOG } from "../out/extension/generated/command-config.js";

const originalChrome = globalThis.chrome;
const event = { addListener() {} };
globalThis.chrome = { tabs: { onRemoved: event, onReplaced: event }, webNavigation: { onCommitted: event } };
const { parseCommand } = await import("../out/extension/background/command-dispatcher.js");
if (originalChrome === undefined) delete globalThis.chrome;
else globalThis.chrome = originalChrome;

const workspace = fileURLToPath(new URL("../", import.meta.url));
const tabRef = `tr1.${"A".repeat(22)}.1.${"B".repeat(22)}`;
const nodeRef = `nr1.${"A".repeat(43)}`;
const parse = (method, params) => parseCommand({ method, params, schemaVersion: 1 });

test("command boundary expands declared omissions once and preserves explicit values", () => {
  assert.deepEqual(parse("page.wait", { tabRef }).params, { tabRef, until: "complete", timeoutMs: 10000 });
  assert.equal(parse("page.wait", { tabRef, timeoutMs: 250 }).params.timeoutMs, 250);
  assert.equal(parse("page.wait", { tabRef, until: "text", selector: "#x", text: "ready" }).params.until, "text");
  for (const params of [{ tabRef, timeoutMs: null }, { tabRef, timeoutMs: 0 }, { tabRef, timeoutMs: 60001 },
    { tabRef, until: "ready" }, { tabRef, until: "text" }, { tabRef, until: "url" }, { tabRef, selector: "#x" },
    { tabRef, text: "orphan" }, { tabRef, extra: true }]) assert.equal(parse("page.wait", params), null);
  assert.deepEqual(parse("tabs.list", {}).params, { afterTabId: null, limit: 100 });
  assert.deepEqual(parse("artifact.read", { artifactRef: `ar1.${"A".repeat(43)}` }).params,
    { artifactRef: `ar1.${"A".repeat(43)}`, maximumBytes: 36000, offset: 0 });
  assert.equal(parse("dom.focus", { nodeRef }).params.preventScroll, true);
  assert.deepEqual(parse("dom.click.real", { nodeRef }).params, {
    nodeRef, scrollIntoView: true, timeoutMs: 10000,
  });
  assert.deepEqual(parse("dom.click.real", { nodeRef, scrollIntoView: false, timeoutMs: 60000 }).params, {
    nodeRef, scrollIntoView: false, timeoutMs: 60000,
  });
  for (const params of [
    { nodeRef, scrollIntoView: null }, { nodeRef, timeoutMs: null }, { nodeRef, timeoutMs: 0 },
    { nodeRef, timeoutMs: 60001 }, { nodeRef: "bad" }, { nodeRef, extra: true },
  ]) assert.equal(parse("dom.click.real", params), null);
  assert.deepEqual(parse("page.screenshot.capture", { tabRef }).params, { tabRef, format: "png", quality: 80 });
  assert.equal(parse("page.screenshot.capture", { tabRef, format: "jpeg", quality: 0 }).params.quality, 0);
  assert.equal(parse("page.screenshot.capture", { tabRef, format: null }), null);
  assert.deepEqual(parse("page.screenshot.element", { nodeRef }).params, { nodeRef, width: 1024, height: 768 });
  assert.deepEqual(parse("page.screenshot.element", { nodeRef, width: 640, height: 480, region: { x: 1, y: 2, width: 3, height: 4 } }).params,
    { nodeRef, width: 640, height: 480, region: { x: 1, y: 2, width: 3, height: 4 } });
  for (const params of [{ nodeRef, width: 0 }, { nodeRef, width: null }, { nodeRef, width: 8193 },
    { nodeRef, width: 8192, height: 8192 }, { nodeRef, region: null }, { nodeRef, region: { x: 0, y: 0, width: 0, height: 1 } },
    { nodeRef, region: { x: -1, y: 0, width: 1, height: 1 } }, { nodeRef, format: "jpeg" }]) assert.equal(parse("page.screenshot.element", params), null);
  assert.deepEqual(parse("debugger.attach", { tabRef }).params, { tabRef });
  assert.equal(parse("debugger.detach", { tabRef, extra: true }), null);
  assert.deepEqual(parse("debugger.send", { tabRef, method: "Runtime.enable" }).params,
    { tabRef, method: "Runtime.enable", params: {}, response: "inline" });
  assert.deepEqual(parse("debugger.events.get", { tabRef }).params, { tabRef, afterSequence: 0, limit: 100 });
  assert.equal(parse("debugger.send", { tabRef, method: "Runtime.evaluate", params: { expression: "42" }, sessionId: "child-session", response: "artifact" }).params.sessionId, "child-session");
  for (const params of [{ tabRef, method: "broken" }, { tabRef, method: "Runtime.enable", params: null },
    { tabRef, method: "Runtime.enable", params: [] }, { tabRef, method: "Runtime.enable", params: { text: "x".repeat(48_001) } },
    { tabRef, method: "Runtime.enable", response: "automatic" }, { tabRef, method: "Runtime.enable", sessionId: "" }]) assert.equal(parse("debugger.send", params), null);
  assert.equal(parse("debugger.events.get", { tabRef, afterSequence: -1 }), null);
  assert.equal(parse("debugger.events.get", { tabRef, limit: 0 }), null);
  const artifactRef = `ar1.${"A".repeat(43)}`;
  assert.deepEqual(parse("demo.open", { artifactRef }).params, { artifactRef, tabRef: null, windowId: null, active: true });
  assert.equal(parse("demo.open", { artifactRef, tabRef, windowId: 1 }), null);
  assert.equal(parse("demo.open", { artifactRef, active: false }).params.active, false);
  assert.equal(parse("artifact.upload.begin", { byteLength: 10, mediaType: "text/html" }).kind, "artifact.upload.begin");
  assert.equal(parse("artifact.upload.begin", { byteLength: -1, mediaType: "text/html" }), null);
  assert.equal(parse("dom.focus", { nodeRef, preventScroll: false }).params.preventScroll, false);
  assert.deepEqual(parse("dom.scroll", { nodeRef }).params, { nodeRef, behavior: "auto", block: "center", inline: "nearest" });
  const rootRef = `tr2.${"A".repeat(43)}`;
  assert.equal(parse("page.tree.find", { rootRef }), null);
  assert.equal(parse("page.tree.find", { rootRef, text: "x" }).params.limit, 256);
  assert.equal(parse("page.tree.find", { rootRef, text: "" }), null);
});

test("Freedom mutation reaches actual extension parsing and both CLI endpoint consumers", async () => {
  const artifacts = path.join(workspace, "out", "test-artifacts"); await mkdir(artifacts, { recursive: true });
  const fixture = await mkdtemp(path.join(artifacts, "freedom-generation-"));
  for (const relative of ["apps", "registries", "protocol", "tools", "skills", "build.zig"]) {
    await cp(path.join(workspace, relative), path.join(fixture, relative), { recursive: true, errorOnExist: true, force: false });
  }
  const registryPath = path.join(fixture, "registries", "freedom.registry.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const point = (id) => registry.points.find((item) => item.pointId === id);
  point("command.page.wait.default_timeout_ms").defaultInteger = 7000;
  point("command.dom.click.real.default_scroll_into_view").defaultBoolean = false;
  point("command.dom.click.real.default_timeout_ms").defaultInteger = 7000;
  point("command.dom.click.real.maximum_timeout_ms").defaultInteger = 8000;
  point("command.dom.focus.default_prevent_scroll").defaultBoolean = false;
  point("command.dom.scroll.default_block").defaultString = "start";
  point("command.page.screenshot.default_format").defaultString = "jpeg";
  point("command.page.screenshot.default_quality").defaultInteger = 42;
  point("command.page.screenshot.default_width").defaultInteger = 640;
  point("command.page.screenshot.default_height").defaultInteger = 480;
  point("command.debugger.default_response").defaultString = "artifact";
  point("command.debugger.default_event_limit").defaultInteger = 50;
  point("command.demo.open.default_active").defaultBoolean = false;
  point("build.transport.loopback_bind").defaultLoopbackBind.port = 32190;
  await writeFile(registryPath, JSON.stringify(registry));
  const manifestPath = path.join(fixture, "apps", "extension", "manifest.json");
  await writeFile(manifestPath, (await readFile(manifestPath, "utf8")).replaceAll("32189", "32190"));
  await run(fixture, "tools/generate-command-config.mjs"); await run(fixture, "tools/generate-transport-config.mjs");
  const generated = await readFile(path.join(fixture, "apps", "extension", "src", "generated", "command-config.ts"), "utf8");
  const projected = JSON.parse(generated.slice(generated.indexOf(" = ") + 3).replace(/ as const;\s*$/u, ""));
  const previous = COMMAND_CATALOG.parameterDefaultsByMethod;
  try {
    COMMAND_CATALOG.parameterDefaultsByMethod = projected.parameterDefaultsByMethod;
    assert.equal(parse("page.wait", { tabRef }).params.timeoutMs, 7000);
    assert.deepEqual(parse("dom.click.real", { nodeRef }).params, {
      nodeRef, scrollIntoView: false, timeoutMs: 7000,
    });
    assert.equal(parse("dom.focus", { nodeRef }).params.preventScroll, false);
    assert.equal(parse("dom.scroll", { nodeRef }).params.block, "start");
    assert.equal(parse("page.screenshot.capture", { tabRef }).params.format, "jpeg");
    assert.equal(parse("page.screenshot.capture", { tabRef }).params.quality, 42);
    assert.deepEqual(parse("page.screenshot.element", { nodeRef }).params, { nodeRef, width: 640, height: 480 });
    assert.equal(parse("debugger.send", { tabRef, method: "Runtime.enable" }).params.response, "artifact");
    assert.equal(parse("debugger.events.get", { tabRef }).params.limit, 50);
    assert.equal(parse("demo.open", { artifactRef: `ar1.${"A".repeat(43)}` }).params.active, false);
  } finally { COMMAND_CATALOG.parameterDefaultsByMethod = previous; }
  const transport = await import(pathToFileURL(path.join(fixture, "apps", "client", "src", "generated-config.mjs")));
  assert.equal(transport.TRANSPORT.port, 32190);
  for (const name of ["main.mjs", "native-websocket.mjs"]) {
    const consumer = await readFile(path.join(fixture, "apps", "client", "src", name), "utf8");
    assert.match(consumer, /import \{ TRANSPORT \} from "\.\/generated-config\.mjs"/);
    assert.equal(consumer.includes("32189"), false);
  }
  assert.match(await readFile(path.join(fixture, "apps", "relay", "src", "generated_config.zig"), "utf8"), /loopback_port: u16 = 32190/);
  point("command.dom.click.real.default_timeout_ms").defaultInteger = 9000;
  await writeFile(registryPath, JSON.stringify(registry));
  await assert.rejects(run(fixture, "tools/generate-command-config.mjs"), /dom\.click\.real default timeout/);
  point("command.dom.click.real.default_timeout_ms").defaultInteger = 7000;
  point("command.dom.scroll.default_block").defaultString = "invalid-alignment";
  await writeFile(registryPath, JSON.stringify(registry));
  await assert.rejects(run(fixture, "tools/generate-command-config.mjs"), /typed default/);
  point("command.dom.scroll.default_block").defaultString = "start";
  await writeFile(registryPath, JSON.stringify(registry));
  const commandPath = path.join(fixture, "registries", "commands.registry.json");
  const commands = JSON.parse(await readFile(commandPath, "utf8"));
  commands.schemaDeclarations.find((schema) => schema.schemaId === "schema.dom.focus.params.v1")
    .fields.find((field) => field.fieldName === "preventScroll").defaultFromFreedomPoint = "command.page.wait.default_timeout_ms";
  const focus = commands.commandDeclarations.find((command) => command.method === "dom.focus");
  focus.limitRefs.push("command.page.wait.default_timeout_ms"); focus.limitRefs.sort();
  await writeFile(commandPath, JSON.stringify(commands));
  await assert.rejects(run(fixture, "tools/generate-command-config.mjs"), /parameter default type/);
});

async function run(cwd, script) {
  const child = spawn(process.execPath, [script], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", (value) => { output += value; }); child.stderr.on("data", (value) => { output += value; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  if (code !== 0) throw new Error(output);
}
