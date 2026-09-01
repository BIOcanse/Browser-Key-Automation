import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

export function assertIsolatedFixture(root) {
  let marker;
  try { marker = JSON.parse(readFileSync(path.join(root, ".bka-test-isolation.json"), "utf8")); }
  catch { throw new Error("Run through tools/test-isolated.mjs; smoke tests must not use the personal relay"); }
  assert.equal(marker.root, root);
  assert.equal(marker.host, "127.0.0.1");
  assert.ok(Number.isInteger(marker.port) && marker.port > 0 && marker.port <= 65535 && marker.port !== 32189);
  assert.equal(process.env.BKA_CLIENT_SMOKE_RELAY, undefined);
  assert.equal(process.env.BKA_CLIENT_SMOKE_CLI, undefined);
}
