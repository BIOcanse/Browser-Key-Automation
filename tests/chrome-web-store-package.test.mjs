import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceManifest = JSON.parse(await readFile(path.join(workspaceRoot, "apps", "extension", "manifest.json"), "utf8"));
const stem = `browser-key-automation-chrome-web-store-initial-upload-v${sourceManifest.version}`;
const outputRoot = path.join(workspaceRoot, "out", "chrome-web-store");
const packageRoot = path.join(outputRoot, stem);
const zipPath = path.join(outputRoot, `${stem}.zip`);
const packagedManifest = JSON.parse(await readFile(path.join(packageRoot, "manifest.json"), "utf8"));

assert.equal(typeof sourceManifest.key, "string");
assert.ok(sourceManifest.key.length > 0);
assert.equal(Object.hasOwn(packagedManifest, "key"), false);
assert.equal(packagedManifest.manifest_version, 3);
assert.equal(packagedManifest.version, "0.0.0.4");
assert.equal(packagedManifest.description, "__MSG_extensionDescription__");
assert.deepEqual(packagedManifest.icons, {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png",
});
assert.deepEqual(packagedManifest.action.default_icon, {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
});

for (const size of [16, 32, 48, 128]) {
  const bytes = await readFile(path.join(packageRoot, "icons", `icon-${size}.png`));
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(bytes.readUInt32BE(16), size);
  assert.equal(bytes.readUInt32BE(20), size);
  assert.equal(bytes[25], 6);
}

const packagedFiles = await listRegularFiles(packageRoot);
assert.ok(packagedFiles.includes("manifest.json"));
assert.equal(packagedFiles.some((file) => file.startsWith("extension/")), false);
assert.equal(packagedFiles.some((file) => /(^|\/)(key\.pem|START-HERE\.md|SHA256SUMS\.txt)$/iu.test(file)), false);
assert.equal(packagedFiles.some((file) => /\.(?:map|pem|p12|pfx)$/iu.test(file)), false);

const archiveEntries = (await run("tar.exe", ["-tf", zipPath]))
  .split(/\r?\n/u)
  .map((entry) => entry.replaceAll("\\", "/").replace(/^\.\//u, ""))
  .filter(Boolean)
  .filter((entry) => !entry.endsWith("/"));
assert.ok(archiveEntries.includes("manifest.json"));
assert.equal(archiveEntries.some((entry) => entry.startsWith(`${stem}/`)), false);
assert.deepEqual([...archiveEntries].sort(), packagedFiles);

const digestText = await readFile(`${zipPath}.sha256.txt`, "utf8");
const digest = createHash("sha256").update(await readFile(zipPath)).digest("hex");
assert.equal(digestText, `${digest}  ${path.basename(zipPath)}\n`);
const nextSteps = await readFile(path.join(outputRoot, "NEXT-STEPS.md"), "utf8");
assert.match(nextSteps, /Do not publish this initial identity-bootstrap build/u);
assert.match(nextSteps, /Item ID/u);
assert.match(nextSteps, /public key/u);
assert.match(nextSteps, new RegExp(digest, "u"));

const extractionRoot = await mkdtemp(path.join(os.tmpdir(), "bka-web-store-"));
try {
  await run("tar.exe", ["-xf", zipPath, "-C", extractionRoot]);
  const extractedManifest = JSON.parse(await readFile(path.join(extractionRoot, "manifest.json"), "utf8"));
  assert.deepEqual(extractedManifest, packagedManifest);
  assert.deepEqual(await listRegularFiles(extractionRoot), packagedFiles);
  await stat(path.join(extractionRoot, "background.js"));
  await stat(path.join(extractionRoot, "admin", "index.html"));
} finally {
  await rm(extractionRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, fileCount: packagedFiles.length, version: packagedManifest.version, sha256: digest }));

async function listRegularFiles(root) {
  const pending = [""];
  const files = [];
  while (pending.length > 0) {
    const directory = pending.shift();
    const entries = await readdir(path.join(root, directory), { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relative = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(relative);
      else if (entry.isFile()) files.push(relative.split(path.sep).join("/"));
      else throw new Error("Unsupported filesystem entry in package test");
    }
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

async function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: workspaceRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${executable} failed: code=${String(code)} signal=${String(signal)} stderr=${stderr}`));
    });
  });
}
