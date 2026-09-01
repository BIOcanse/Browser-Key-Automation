import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import { getRuntimeSettings, updateRuntimeSettings } from "../out/extension/background/settings-service.js";
import { readArtifact, releaseArtifact } from "../out/extension/background/artifact-service.js";
import { COMMAND_CATALOG } from "../out/extension/generated/command-config.js";

test("resource fetch owns abort, byte-limit cleanup, reader failure and successful timer cleanup", async () => {
  const previousFetch = globalThis.fetch;
  const previousTimer = globalThis.setTimeout;
  const settings = await getRuntimeSettings();
  await updateRuntimeSettings({ ...settings, expectedRevision: settings.revision, artifactMaximumBytes: 1024 });
  const { fetchResource } = await import("../out/extension/background/capture-service.js");
  globalThis.setTimeout = (callback, milliseconds, ...args) => previousTimer(callback,
    milliseconds === COMMAND_CATALOG.limits["command.resource.fetch.timeout_ms"] ? 20 : milliseconds, ...args);
  const run = () => fetchResource("fixture-owner", "https://example.invalid/resource", "omit", "no-store");
  try {
    let signal;
    let cancelled = false;
    globalThis.fetch = async (_url, options) => {
      signal = options.signal;
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-length": "1025" } });
    };
    await assert.rejects(run(), (error) => error.code === "LIMIT_EXCEEDED");
    assert.equal(cancelled, true);
    assert.equal(signal.aborted, true);

    cancelled = false;
    globalThis.fetch = async (_url, options) => {
      signal = options.signal;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(1025)); },
        cancel() { cancelled = true; },
      }));
    };
    await assert.rejects(run(), (error) => error.code === "LIMIT_EXCEEDED");
    assert.equal(cancelled, true);
    assert.equal(signal.aborted, true);

    globalThis.fetch = async (_url, options) => {
      signal = options.signal;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      }));
    };
    await assert.rejects(run(), (error) => error.code === "CAPABILITY_UNAVAILABLE" && error.details.reason === "CHROMIUM_API_FAILED");
    assert.equal(signal.aborted, true);

    globalThis.fetch = async (_url, options) => {
      signal = options.signal;
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error("private network detail")); } }));
    };
    await assert.rejects(run(), (error) => error.code === "CAPABILITY_UNAVAILABLE" && !error.message.includes("private"));

    globalThis.fetch = async (_url, options) => { signal = options.signal; return new Response("complete body"); };
    const result = await run();
    await new Promise((resolve) => previousTimer(resolve, 40));
    assert.equal(signal.aborted, false, "successful body completion cancels its deadline");
    const body = await readArtifact("fixture-owner", result.artifact.artifactRef, 0, 100);
    assert.equal(Buffer.from(body.dataBase64Url, "base64url").toString(), "complete body");
    await releaseArtifact("fixture-owner", result.artifact.artifactRef);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousTimer;
  }
});
