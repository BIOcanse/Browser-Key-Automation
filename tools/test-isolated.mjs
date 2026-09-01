import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suites = {
  protocol: "relay-protocol-smoke.mjs", client: "client-cli-smoke.mjs",
  extension: "extension-key-smoke.mjs", "extension-relay": "extension-relay-smoke.mjs",
};
const selected = process.argv[2] ?? "all";
const selectedArguments = process.argv.slice(3);
const exportStoreListingAssets = selectedArguments.includes("--export-store-listing-assets");
const forwardedArguments = selectedArguments.filter((argument) => argument !== "--export-store-listing-assets");
assert.ok(selected === "all" || Object.hasOwn(suites, selected), "Unknown isolated smoke suite");
assert.ok(!exportStoreListingAssets || selected === "extension", "Store listing assets can be exported only from the extension suite");
const artifacts = path.join(workspace, "out", "test-artifacts");
await mkdir(artifacts, { recursive: true });
const root = await mkdtemp(path.join(artifacts, "isolated-"));
const reservation = net.createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const port = reservation.address().port;
assert.notEqual(port, 32189);
const environment = { ...process.env };
delete environment.BKA_API_KEY;
delete environment.BKA_CLIENT_SMOKE_RELAY;
delete environment.BKA_CLIENT_SMOKE_CLI;
const evidence = { root, host: "127.0.0.1", port, copiedFiles: [], commands: [] };
console.log(`Isolated test fixture: ${root} (127.0.0.1:${port})`);
try {
  for (const relative of ["apps/client/src", "apps/relay/src", "apps/extension/manifest.json", "out/extension", "registries", "tests/lib", "build.zig"]) {
    await cp(path.join(workspace, relative), path.join(root, relative), { recursive: true, errorOnExist: true, force: false });
  }
  for (const script of Object.values(suites)) {
    await cp(path.join(workspace, "tests", script), path.join(root, "tests", script));
  }
  for (const relative of ["apps/client/src/generated-config.mjs",
    "apps/relay/src/generated_config.zig", "apps/extension/manifest.json", "out/extension/manifest.json",
    "out/extension/generated/transport-config.js"]) {
    const file = path.join(root, relative);
    const original = await readFile(file, "utf8");
    assert.ok(original.includes("32189"), `Missing endpoint fixture projection: ${relative}`);
    const projected = original.replaceAll("32189", String(port));
    evidence.copiedFiles.push({ path: relative, originalSha256: hash(original), fixtureSha256: hash(projected) });
    await writeFile(file, projected);
  }
  await writeFile(path.join(root, ".bka-test-isolation.json"), JSON.stringify({ root, host: "127.0.0.1", port }));
  if (selected !== "extension") await run(process.env.BKA_ZIG_PATH ?? "zig", ["build", "-Doptimize=ReleaseSafe"], "build-relay");
  await new Promise((resolve) => reservation.close(resolve));
  const names = selected === "all" ? Object.keys(suites) : [selected];
  for (const name of names) await run(
    process.execPath,
    [path.join(root, "tests", suites[name]), ...(selected === "all" ? [] : forwardedArguments)],
    name,
  );
  if (exportStoreListingAssets) {
    const names = [
      "screenshot-1-setup-1280x800.png",
      "screenshot-2-key-management-1280x800.png",
      "screenshot-3-key-permissions-1280x800.png",
    ];
    const sourceRoot = path.join(root, "out", "chrome-web-store", "listing-assets");
    const destinationRoot = path.join(workspace, "out", "chrome-web-store", "listing-assets");
    await mkdir(destinationRoot, { recursive: true });
    for (const name of names) {
      await copyFile(path.join(sourceRoot, name), path.join(destinationRoot, name));
    }
    evidence.exportedArtifacts = names.map((name) => path.join("out", "chrome-web-store", "listing-assets", name));
    console.log(JSON.stringify({ ok: true, exportedStoreListingAssets: evidence.exportedArtifacts }));
  }
  evidence.ok = true;
} finally {
  if (reservation.listening) await new Promise((resolve) => reservation.close(resolve));
  await writeFile(path.join(root, "results.json"), JSON.stringify(evidence, null, 2) + "\n");
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
async function run(executable, args, label) {
  const started = Date.now();
  const child = spawn(executable, args, { cwd: root, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (value) => { output += value; process.stdout.write(value); });
  }
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  await writeFile(path.join(root, `${label}.log`), output);
  evidence.commands.push({ label, executable, args, code, elapsedMs: Date.now() - started });
  assert.equal(code, 0, `${label} failed; see ${root}`);
}
