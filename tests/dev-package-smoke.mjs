import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.resolve(workspaceRoot, process.argv[2] ?? "out");
const extensionRoot = path.join(outputRoot, "browser-key-automation-extension-dev");
const windowsAppRoot = path.join(
  outputRoot,
  "browser-key-automation-local-app-windows-x86_64-dev",
);
const linuxAppRoot = path.join(
  outputRoot,
  "browser-key-automation-local-app-linux-x86_64-dev",
);

const extensionTopLevel = await readdir(extensionRoot);
assert.ok(extensionTopLevel.includes("manifest.json"));
assert.ok(extensionTopLevel.includes("START-HERE.md"));
assert.equal(extensionTopLevel.includes("extension"), false);

assert.deepEqual((await readdir(windowsAppRoot)).sort(), [
  "SHA256SUMS.txt",
  "START-HERE.md",
  "browser-key-relay.exe",
  "client",
  "protocol",
  "skill",
]);
assert.deepEqual((await readdir(linuxAppRoot)).sort(), [
  "SHA256SUMS.txt",
  "START-HERE.md",
  "browser-key-relay",
  "client",
  "protocol",
  "skill",
]);

const extensionChecksumCount = await verifyChecksums(extensionRoot);
const windowsChecksumCount = await verifyChecksums(windowsAppRoot);
const linuxChecksumCount = await verifyChecksums(linuxAppRoot);

const manifest = JSON.parse(await readFile(path.join(extensionRoot, "manifest.json"), "utf8"));
assert.equal(manifest.name, "Browser Key Automation");
assert.equal(manifest.version, "0.0.0.1");
assert.equal(manifest.minimum_chrome_version, "138");
assert.equal(manifest.action.default_title, "__MSG_actionTitle__");
assert.deepEqual(manifest.action.default_icon, {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
});
assert.deepEqual(manifest.icons, {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png",
});
assert.equal(manifest.default_locale, "en");
assert.equal(Object.hasOwn(manifest.action, "default_popup"), false);
assert.equal(manifest.options_page, "admin/index.html");
await stat(path.join(extensionRoot, "admin", "welcome.html"));
await stat(path.join(extensionRoot, "admin", "setup.js"));
await stat(path.join(extensionRoot, "shared", "user-scripts.js"));
for (const size of [16, 32, 48, 128]) await stat(path.join(extensionRoot, "icons", `icon-${size}.png`));
assert.deepEqual(manifest.sandbox.pages, ["demo/sandbox.html"]);
for (const name of ["index.html", "sandbox.html", "viewer.js", "viewer.css"]) await stat(path.join(extensionRoot, "demo", name));

const windowsRelay = await readFile(path.join(windowsAppRoot, "browser-key-relay.exe"));
assert.equal(windowsRelay.subarray(0, 2).toString("ascii"), "MZ");
const linuxRelay = await readFile(path.join(linuxAppRoot, "browser-key-relay"));
assert.deepEqual([...linuxRelay.subarray(0, 4)], [0x7f, 0x45, 0x4c, 0x46]);

const windowsStartHere = await readFile(path.join(windowsAppRoot, "START-HERE.md"), "utf8");
const linuxStartHere = await readFile(path.join(linuxAppRoot, "START-HERE.md"), "utf8");
assert.match(windowsStartHere, /Windows x86_64/u);
assert.match(windowsStartHere, /\.\\browser-key-relay\.exe/u);
assert.match(linuxStartHere, /Linux x86_64/u);
assert.match(linuxStartHere, /chmod \+x \.\/browser-key-relay/u);
assert.equal(windowsStartHere.includes("{{"), false);
assert.equal(linuxStartHere.includes("{{"), false);

for (const appRoot of [windowsAppRoot, linuxAppRoot]) {
  await stat(path.join(appRoot, "client", "demo-files.mjs"));
  await stat(path.join(appRoot, "skill", "browser-key-automation", "references", "quick-shot-and-demo.md"));
  const skillText = await readFile(
    path.join(appRoot, "skill", "browser-key-automation", "SKILL.md"),
    "utf8",
  );
  assert.match(skillText, /^---\nname: browser-key-automation\n/gu);
  const operationTreeReference = await readFile(
    path.join(appRoot, "skill", "browser-key-automation", "references", "operation-tree.md"),
    "utf8",
  );
  assert.match(operationTreeReference, /page\.tree\.open/gu);
  const commandRegistry = JSON.parse(
    await readFile(
      path.join(appRoot, "skill", "browser-key-automation", "references", "commands.registry.json"),
      "utf8",
    ),
  );
  assert.equal(
    await readFile(
      path.join(appRoot, "skill", "browser-key-automation", "references", "commands.registry.json"),
      "utf8",
    ),
    await readFile(path.join(workspaceRoot, "registries", "commands.registry.json"), "utf8"),
  );
  assert.equal(
    await readFile(
      path.join(appRoot, "skill", "browser-key-automation", "references", "freedom.registry.json"),
      "utf8",
    ),
    await readFile(path.join(workspaceRoot, "registries", "freedom.registry.json"), "utf8"),
  );
  assert.deepEqual(
    commandRegistry.commandDeclarations
      .filter((entry) => entry.status === "active" && entry.method.startsWith("page.tree."))
      .map((entry) => [entry.method, entry.schemaVersion]),
    [["page.tree.expand", 2], ["page.tree.find", 1], ["page.tree.open", 1], ["page.tree.view.get", 1]],
  );
}

const help = await runNode(path.join(windowsAppRoot, "client", "browser-key-cli.mjs"), ["help"]);
assert.equal(help.code, 0, help.stderr);
assert.equal(JSON.parse(help.stdout.trim()).command, "help");
assert.ok(JSON.parse(help.stdout.trim()).usage.some((item) => item.includes("page-shot")));
assert.ok(JSON.parse(help.stdout.trim()).usage.some((item) => item.includes("demo-open")));

if (process.platform === "win32") {
  const extensionZip = `${extensionRoot}.zip`;
  const windowsZip = `${windowsAppRoot}.zip`;
  const linuxZip = `${linuxAppRoot}.zip`;
  const extensionEntries = await listZip(extensionZip);
  const windowsEntries = await listZip(windowsZip);
  const linuxEntries = await listZip(linuxZip);
  assert.ok(extensionEntries.includes("manifest.json"));
  assert.equal(extensionEntries.some((entry) => entry.startsWith("extension/")), false);
  assert.ok(windowsEntries.includes("browser-key-relay.exe"));
  assert.ok(windowsEntries.includes("skill/browser-key-automation/SKILL.md"));
  assert.equal(windowsEntries.includes("browser-key-relay"), false);
  assert.ok(linuxEntries.includes("browser-key-relay"));
  assert.ok(linuxEntries.includes("skill/browser-key-automation/SKILL.md"));
  assert.equal(linuxEntries.includes("browser-key-relay.exe"), false);
  await verifyArchiveDigest(extensionZip);
  await verifyArchiveDigest(windowsZip);
  await verifyArchiveDigest(linuxZip);
  assert.equal(await verifyExtractedArchive(extensionZip), extensionChecksumCount);
  assert.equal(await verifyExtractedArchive(windowsZip), windowsChecksumCount);
  assert.equal(await verifyExtractedArchive(linuxZip), linuxChecksumCount);
}

await assert.rejects(stat(path.join(outputRoot, "browser-key-automation-dev")), { code: "ENOENT" });
await assert.rejects(stat(path.join(outputRoot, "browser-key-automation-dev.zip")), { code: "ENOENT" });

console.log(
  JSON.stringify({
    ok: true,
    extensionManifestAtPackageRoot: true,
    localAppExecutableAtPackageRoot: true,
    extensionChecksumCount,
    windowsChecksumCount,
    linuxChecksumCount,
    windowsRelayFormat: "PE",
    linuxRelayFormat: "ELF",
    splitArchivesVerified: process.platform === "win32",
    legacyCombinedPackageAbsent: true,
  }),
);

async function verifyChecksums(root) {
  const checksumText = await readFile(path.join(root, "SHA256SUMS.txt"), "utf8");
  const checksumEntries = checksumText.trimEnd().split("\n").map((line) => {
    const match = /^([a-f0-9]{64})  ([^\\\r\n]+)$/u.exec(line);
    assert.ok(match, `Invalid checksum line: ${line}`);
    return { digest: match[1], relativePath: match[2] };
  });
  const listedPaths = checksumEntries.map((entry) => entry.relativePath);
  const actualFiles = (await listRegularFiles(root))
    .map((relativePath) => relativePath.split(path.sep).join("/"))
    .filter((relativePath) => relativePath !== "SHA256SUMS.txt");
  assert.deepEqual(listedPaths, actualFiles);
  assert.equal(new Set(listedPaths).size, listedPaths.length);
  for (const entry of checksumEntries) {
    const bytes = await readFile(path.join(root, ...entry.relativePath.split("/")));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.digest, entry.relativePath);
  }
  return checksumEntries.length;
}

async function verifyArchiveDigest(zipPath) {
  const line = (await readFile(`${zipPath}.sha256.txt`, "utf8")).trimEnd();
  const expected = `${createHash("sha256").update(await readFile(zipPath)).digest("hex")}  ${path.basename(zipPath)}`;
  assert.equal(line, expected);
}

async function listZip(zipPath) {
  const result = await runProcess("tar.exe", ["-tf", zipPath]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trimEnd().split(/\r?\n/u);
}

async function verifyExtractedArchive(zipPath) {
  const extractionRoot = await mkdtemp(path.join(os.tmpdir(), "bka-package-smoke-"));
  try {
    const result = await runProcess("tar.exe", ["-xf", zipPath, "-C", extractionRoot]);
    assert.equal(result.code, 0, result.stderr);
    return await verifyChecksums(extractionRoot);
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

async function listRegularFiles(root) {
  const pendingDirectories = [""];
  const result = [];
  while (pendingDirectories.length > 0) {
    const relativeDirectory = pendingDirectories.shift();
    const entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) pendingDirectories.push(relativePath);
      else if (entry.isFile()) result.push(relativePath);
      else throw new Error("Developer package contains an unsupported filesystem entry");
    }
  }
  return result.sort((left, right) => left.localeCompare(right, "en"));
}

async function runNode(script, args) {
  return runProcess(process.execPath, [script, ...args], windowsAppRoot);
}

async function runProcess(executable, args, cwd = workspaceRoot) {
  const child = spawn(executable, args, {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, stdout, stderr };
}
