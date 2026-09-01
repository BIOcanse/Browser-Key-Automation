import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(workspaceRoot, "apps", "extension", "manifest.json"), "utf8"));
const version = manifest.version;
const releaseRoot = path.join(workspaceRoot, "out", "github-release", `v${version}`);
const extensionName = `browser-key-automation-extension-v${version}`;
const appName = `browser-key-automation-local-app-v${version}`;
const extensionRoot = path.join(releaseRoot, extensionName);
const appRoot = path.join(releaseRoot, appName);
const extensionZip = path.join(releaseRoot, `${extensionName}.zip`);
const appZip = path.join(releaseRoot, `${appName}.zip`);
const releaseAssets = JSON.parse(await readFile(path.join(releaseRoot, "release-assets.json"), "utf8"));

assert.equal(releaseAssets.tag, `v${version}`);
assert.equal(releaseAssets.assets.length, 2);
assert.deepEqual(releaseAssets.assets.map(({ kind, name }) => [kind, name]), [
  ["extension", `${extensionName}.zip`],
  ["local-app", `${appName}.zip`],
]);
assert.equal(releaseAssets.assets.some(({ name }) => /dev|chrome-web-store/iu.test(name)), false);

const packagedManifest = JSON.parse(await readFile(path.join(extensionRoot, "manifest.json"), "utf8"));
assert.equal(packagedManifest.version, version);
assert.equal(packagedManifest.key, manifest.key);
const extensionStart = await readFile(path.join(extensionRoot, "START-HERE.md"), "utf8");
assert.match(extensionStart, new RegExp(`版本：\`${escapeRegExp(version)}\``, "u"));
assert.match(extensionStart, new RegExp(`${escapeRegExp(appName)}\\.zip`, "u"));
assert.match(extensionStart, /Chrome Web Store 发布当前暂停/u);

assert.deepEqual((await readdir(appRoot)).sort(), [
  "SHA256SUMS.txt",
  "START-HERE.md",
  "client",
  "linux-x86_64",
  "protocol",
  "skill",
  "windows-x86_64",
]);
const windowsRelay = await readFile(path.join(appRoot, "windows-x86_64", "browser-key-relay.exe"));
const linuxRelay = await readFile(path.join(appRoot, "linux-x86_64", "browser-key-relay"));
assert.equal(windowsRelay.subarray(0, 2).toString("ascii"), "MZ");
assert.deepEqual([...linuxRelay.subarray(0, 4)], [0x7f, 0x45, 0x4c, 0x46]);
const appStart = await readFile(path.join(appRoot, "START-HERE.md"), "utf8");
assert.match(appStart, /\.\\windows-x86_64\\browser-key-relay\.exe/u);
assert.match(appStart, /\.\/linux-x86_64\/browser-key-relay/u);
assert.match(appStart, /Linux 包当前提供路由和文件落地，但不声明 `native\.input\.click\.v1`/u);
const help = JSON.parse(await run("node", [path.join(appRoot, "client", "browser-key-cli.mjs"), "help"]));
assert.equal(help.command, "help");
assert.ok(help.usage.some((line) => line.includes("page-shot")));
assert.ok(help.usage.some((line) => line.includes("demo-open")));

const extensionFileCount = await verifyChecksums(extensionRoot);
const appFileCount = await verifyChecksums(appRoot);
assert.ok(extensionFileCount > appFileCount);
for (const [zipPath, packageRoot] of [[extensionZip, extensionRoot], [appZip, appRoot]]) {
  const entries = await listZipFiles(zipPath);
  const expected = await listRegularFiles(packageRoot);
  assert.deepEqual(entries, expected);
  assert.equal(entries.some((entry) => entry.startsWith(`${path.basename(packageRoot)}/`)), false);
  const extractionRoot = await mkdtemp(path.join(os.tmpdir(), "bka-github-release-"));
  try {
    await run("tar.exe", ["-xf", zipPath, "-C", extractionRoot]);
    assert.deepEqual(await listRegularFiles(extractionRoot), expected);
    await verifyChecksums(extractionRoot);
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

const checksumLines = (await readFile(path.join(releaseRoot, "SHA256SUMS.txt"), "utf8")).trimEnd().split("\n");
assert.equal(checksumLines.length, 2);
const releaseNotes = await readFile(path.join(releaseRoot, "RELEASE-NOTES.md"), "utf8");
for (const [index, file] of [extensionZip, appZip].entries()) {
  const bytes = await readFile(file);
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(releaseAssets.assets[index].sha256, digest);
  assert.equal(releaseAssets.assets[index].bytes, bytes.length);
  assert.equal(checksumLines[index], `${digest}  ${path.basename(file)}`);
  assert.match(releaseNotes, new RegExp(`${digest}  ${escapeRegExp(path.basename(file))}`, "u"));
}
assert.match(releaseNotes, /exactly two downloads/u);
assert.match(releaseNotes, /Chrome Web Store publication remains paused and requires separate user authorization/u);

console.log(JSON.stringify({ ok: true, tag: releaseAssets.tag, assetCount: 2, extensionFileCount, appFileCount, assets: releaseAssets.assets }));

async function verifyChecksums(root) {
  const entries = (await readFile(path.join(root, "SHA256SUMS.txt"), "utf8")).trimEnd().split(/\r?\n/u).map((line) => {
    const match = /^([a-f0-9]{64})  ([^\r\n]+)$/u.exec(line);
    assert.ok(match, `Invalid checksum line: ${line}`);
    return { digest: match[1], relativeFile: match[2] };
  });
  const files = (await listRegularFiles(root)).filter((file) => file !== "SHA256SUMS.txt");
  assert.deepEqual(entries.map(({ relativeFile }) => relativeFile), files);
  for (const { digest, relativeFile } of entries) {
    const actual = createHash("sha256").update(await readFile(path.join(root, relativeFile))).digest("hex");
    assert.equal(actual, digest, relativeFile);
  }
  return files.length;
}

async function listZipFiles(zipPath) {
  return (await run("tar.exe", ["-tf", zipPath])).split(/\r?\n/u)
    .map((entry) => entry.replaceAll("\\", "/").replace(/^\.\//u, ""))
    .filter((entry) => entry.length > 0 && !entry.endsWith("/"))
    .sort((left, right) => left.localeCompare(right, "en"));
}

async function listRegularFiles(root) {
  const pending = [""];
  const files = [];
  while (pending.length > 0) {
    const relativeDirectory = pending.shift();
    const entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relative = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) pending.push(relative);
      else if (entry.isFile()) files.push(relative.split(path.sep).join("/"));
      else throw new Error("Unsupported filesystem entry in release test");
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
