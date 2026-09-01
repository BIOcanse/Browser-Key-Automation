import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDemoFile } from "../apps/client/src/demo-files.mjs";
import { openDemo, parseArguments } from "../apps/client/src/main.mjs";

const root = fileURLToPath(new URL("../out/test-artifacts/", import.meta.url));
await mkdir(root, { recursive: true });
const artifactRef = `ar1.${"A".repeat(43)}`;
const tabRef = `tr1.${"A".repeat(22)}.1.${"B".repeat(22)}`;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function input(bytes) {
  const file = path.join(await mkdtemp(path.join(root, "demo-file-")), "实际 演示.html");
  await writeFile(file, bytes); return file;
}
function receiver(bytes, chunkBytes = 13) {
  const calls = []; let receivedBytes = 0;
  return { calls, async call(method, params) {
    calls.push({ method, params });
    if (method === "artifact.upload.begin") {
      assert.deepEqual(params, { byteLength: bytes.length, mediaType: "text/html" });
      return { artifactRef, byteLength: bytes.length, chunkBytes, receivedBytes: 0 };
    }
    if (method === "artifact.upload.append") {
      assert.equal(params.artifactRef, artifactRef); assert.equal(params.offset, receivedBytes);
      const part = Buffer.from(params.dataBase64Url, "base64url");
      assert.deepEqual(part, bytes.subarray(receivedBytes, receivedBytes + part.length));
      assert.equal(part.length, Math.min(chunkBytes, bytes.length - receivedBytes));
      receivedBytes += part.length; return { artifactRef, receivedBytes };
    }
    const artifact = { artifactRef, byteLength: bytes.length, sha256: digest(bytes), mediaType: "text/html" };
    if (method === "artifact.upload.commit") {
      assert.deepEqual(params, { artifactRef, sha256: digest(bytes) }); assert.equal(receivedBytes, bytes.length);
      return { artifact };
    }
    assert.equal(method, "demo.open"); return { tab: { tabRef }, artifact };
  } };
}

test("demo-open submits exact Unicode bytes in server-sized chunks and only opens after commit", async () => {
  const bytes = Buffer.from(`<html><script>document.title='测试'</script>${"内容".repeat(15000)}</html>`);
  const file = await input(bytes); const server = receiver(bytes, 36000);
  const result = await openDemoFile({ call: server.call, file });
  assert.equal(result.input, file); assert.equal(result.tab.tabRef, tabRef);
  assert.deepEqual(server.calls.at(-1), { method: "demo.open", params: { artifactRef } });
  assert.equal(server.calls.filter((item) => item.method === "artifact.upload.append").length, Math.ceil(bytes.length / 36000));
  assert.deepEqual(await readFile(file), bytes);
});

test("empty HTML can commit; explicit destination/active options are preserved", async () => {
  const bytes = Buffer.alloc(0); const file = await input(bytes); const server = receiver(bytes);
  await openDemoFile({ call: server.call, file, tabRef, active: false });
  assert.equal(server.calls.some((item) => item.method === "artifact.upload.append"), false);
  assert.deepEqual(server.calls.at(-1).params, { artifactRef, tabRef, active: false });
});

test("bad upload responses, file growth and interrupted transfer never open or silently retry", async () => {
  for (const mode of ["offset", "hash", "growth", "disconnect"]) {
    const bytes = Buffer.from("example HTML with multiple chunks"); const file = await input(bytes); const server = receiver(bytes);
    const call = async (method, params) => {
      const result = await server.call(method, params);
      if (method === "artifact.upload.append" && mode === "offset") result.receivedBytes += 1;
      if (method === "artifact.upload.commit" && mode === "hash") result.artifact.sha256 = "0".repeat(64);
      if (method === "artifact.upload.begin" && mode === "growth") await writeFile(file, Buffer.concat([bytes, Buffer.from("grew")]));
      if (method === "artifact.upload.append" && mode === "disconnect") {
        const error = new Error("lost"); error.code = "ROUTE_DELIVERY_UNKNOWN"; error.delivery = "unknown"; throw error;
      }
      return result;
    };
    await assert.rejects(openDemoFile({ call, file }), (error) => error.details.artifactRef === artifactRef &&
      (mode !== "disconnect" || error.delivery === "unknown"));
    assert.equal(server.calls.some((item) => item.method === "demo.open" || item.method === "artifact.release"), false);
  }
});

test("demo CLI/direct API reject unrelated or contradictory options before connecting", () => {
  assert.equal(typeof openDemo, "function");
  const args = parseArguments(["demo-open", "one.html", "--active", "false", "--window-id", "2"]);
  assert.equal(args.file, "one.html"); assert.equal(args.active, false); assert.equal(args.windowId, 2);
  for (const extra of [["--active", "yes"], ["--output", "x"], ["--format", "png"], ["--window-id", "2", "--tab-ref", tabRef]]) {
    assert.throws(() => parseArguments(["demo-open", "one.html", ...extra]));
  }
  assert.throws(() => openDemo({ file: "x", tabRef: "invalid" }), (error) => error.code === "CLI_USAGE");
  assert.throws(() => openDemo({}), (error) => error.code === "CLI_USAGE");
});
