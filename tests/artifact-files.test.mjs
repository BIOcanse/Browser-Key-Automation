import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { saveArtifactFile, savePageFile, saveScreenshotFile } from "../apps/client/src/artifact-files.mjs";
import { parseArguments, savePage, saveScreenshot } from "../apps/client/src/main.mjs";

const root = fileURLToPath(new URL("../out/test-artifacts/", import.meta.url));
await mkdir(root, { recursive: true });
const artifactRef = `ar1.${"A".repeat(43)}`;
const tabRef = `tr1.${"A".repeat(22)}.1.${"B".repeat(22)}`;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function destination(name = "page.mhtml") { return path.join(await mkdtemp(path.join(root, "file-save-")), name); }
function source(bytes, chunkSize = 7) {
  const calls = [];
  return { calls, async call(method, params) {
    calls.push({ method, params });
    if (method === "page.archive.capture") return { tabRef, artifact: { artifactRef } };
    assert.equal(method, "artifact.read");
    assert.equal(params.maximumBytes, undefined, "chunk policy is extension-owned");
    const end = Math.min(bytes.length, params.offset + chunkSize);
    return { artifactRef, mediaType: "multipart/related", sha256: digest(bytes), byteLength: bytes.length,
      offset: params.offset, nextOffset: end === bytes.length ? null : end,
      dataBase64Url: bytes.subarray(params.offset, end).toString("base64url") };
  } };
}

test("one page-save produces a verified real file, supports Unicode/spaces, captures exactly once", async () => {
  const output = await destination("实际 页面.mhtml");
  const bytes = Buffer.from("MIME-Version: 1.0\r\nContent-Type: multipart/related\r\n\r\n实际样本");
  const fixture = source(bytes);
  const saved = await savePageFile({ call: fixture.call, tabRef, output });
  assert.equal(saved.output, output); assert.equal(saved.sha256, digest(bytes));
  assert.deepEqual(await readFile(output), bytes);
  assert.equal(fixture.calls.filter((call) => call.method === "page.archive.capture").length, 1);
  assert.equal(fixture.calls.some((call) => call.method === "artifact.release"), false);
  assert.deepEqual(await readdir(path.dirname(output)), [path.basename(output)]);
});

test("empty Artifact is valid; existing output is never overwritten or recaptured", async () => {
  const output = await destination(); const fixture = source(Buffer.alloc(0));
  await saveArtifactFile({ call: fixture.call, artifactRef, output });
  assert.equal((await readFile(output)).length, 0);
  fixture.calls.length = 0;
  await assert.rejects(savePageFile({ call: fixture.call, tabRef, output }), (error) => error.code === "OUTPUT_EXISTS");
  assert.equal(fixture.calls.length, 0);
});

test("integrity, non-progress, changing metadata and interrupted read leave no final/partial file", async () => {
  for (const failure of ["hash", "offset", "metadata", "disconnect"]) {
    const output = await destination(); const fixture = source(Buffer.from("two chunks of data"), 7);
    let calls = 0;
    const call = async (method, params) => {
      calls += 1;
      const chunk = await fixture.call(method, params);
      if (failure === "hash") chunk.sha256 = "0".repeat(64);
      if (failure === "offset") { chunk.dataBase64Url = ""; chunk.nextOffset = params.offset; }
      if (failure === "metadata" && calls > 1) chunk.mediaType = "different";
      if (failure === "disconnect" && calls > 1) { const error = new Error("lost"); error.code = "ROUTE_DELIVERY_UNKNOWN"; error.delivery = "unknown"; throw error; }
      return chunk;
    };
    await assert.rejects(saveArtifactFile({ call, artifactRef, output }), (error) => error.details.artifactRef === artifactRef &&
      (failure !== "disconnect" || error.delivery === "unknown"));
    assert.deepEqual(await readdir(path.dirname(output)), []);
  }
});

test("a file created concurrently during transfer is preserved", async () => {
  const output = await destination(); const fixture = source(Buffer.from("new"));
  const call = async (...args) => { await writeFile(output, "user-created", { flag: "wx" }); return fixture.call(...args); };
  await assert.rejects(saveArtifactFile({ call, artifactRef, output }), (error) => error.code === "OUTPUT_EXISTS");
  assert.equal(await readFile(output, "utf8"), "user-created");
  assert.deepEqual(await readdir(path.dirname(output)), [path.basename(output)]);
});

test("CLI and direct function share argument validation; importing starts no connection", () => {
  assert.equal(typeof savePage, "function");
  const parsed = parseArguments(["page-save", "--tab-ref", tabRef, "--output", "one.mhtml"]);
  assert.equal(parsed.tabRef, tabRef); assert.equal(parsed.output, "one.mhtml");
  assert.throws(() => parseArguments(["page-save", "--tab-ref", tabRef, "--output", "x", "--method", "js.execute"]));
  assert.throws(() => parseArguments(["call", "--method", "tabs.list", "--output", "x"]));
  assert.throws(() => savePage({ tabRef: "invalid", output: "x" }), (error) => error.code === "CLI_USAGE");
  assert.equal(typeof saveScreenshot, "function");
  assert.equal(parseArguments(["page-shot", "--tab-ref", tabRef, "--output", "x.png"]).format, undefined);
  assert.equal(parseArguments(["page-shot", "--tab-ref", tabRef, "--output", "x.jpg", "--format", "jpeg", "--quality", "0"]).quality, 0);
  assert.throws(() => parseArguments(["page-shot", "--tab-ref", tabRef, "--output", "x", "--quality", "101"]));
  assert.throws(() => parseArguments(["page-save", "--tab-ref", tabRef, "--output", "x", "--format", "png"]));
});

test("page-shot captures once, leaves defaults to the extension and preserves explicit image options", async () => {
  for (const options of [{}, { format: "jpeg", quality: 0 }]) {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const output = await destination("截图.png");
    const fixture = source(bytes);
    let captures = 0;
    const call = async (method, params) => {
      if (method === "page.screenshot.capture") {
        captures += 1;
        assert.deepEqual(params, { tabRef, ...options });
        return { tabRef, artifact: { artifactRef } };
      }
      return fixture.call(method, params);
    };
    await saveScreenshotFile({ call, tabRef, output, ...options });
    assert.deepEqual(await readFile(output), bytes);
    assert.equal(captures, 1);
    await assert.rejects(saveScreenshotFile({ call, tabRef, output }), (error) => error.code === "OUTPUT_EXISTS");
    assert.equal(captures, 1);
  }
});
