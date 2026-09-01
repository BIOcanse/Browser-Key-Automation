import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = path.join(workspaceRoot, "out");
const outputRoot = path.join(outRoot, "github-release");
const sourceManifest = JSON.parse(
  await readFile(path.join(workspaceRoot, "apps", "extension", "manifest.json"), "utf8"),
);
const version = sourceManifest.version;
if (!/^\d+(?:\.\d+){0,3}$/u.test(version ?? "")) throw new Error("Invalid extension release version");
const extensionId = extensionIdFromManifestKey(sourceManifest.key);
const tag = `v${version}`;
const releaseRoot = path.join(outputRoot, tag);
const stagingRoot = path.join(outputRoot, `.${tag}-staging-${process.pid}`);
const inputRoot = path.join(outputRoot, `.${tag}-inputs-${process.pid}`);
const extensionName = `browser-key-automation-extension-v${version}`;
const appName = `browser-key-automation-local-app-v${version}`;
const extensionRoot = path.join(stagingRoot, extensionName);
const appRoot = path.join(stagingRoot, appName);
const extensionZip = path.join(stagingRoot, `${extensionName}.zip`);
const appZip = path.join(stagingRoot, `${appName}.zip`);
const devArchives = {
  extension: path.join(outRoot, "browser-key-automation-extension-dev.zip"),
  windows: path.join(outRoot, "browser-key-automation-local-app-windows-x86_64-dev.zip"),
  linux: path.join(outRoot, "browser-key-automation-local-app-linux-x86_64-dev.zip"),
};

await mkdir(outputRoot, { recursive: true });
await rm(stagingRoot, { recursive: true, force: true });
await rm(inputRoot, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });
await mkdir(inputRoot, { recursive: true });

try {
  const extracted = {};
  for (const [kind, archive] of Object.entries(devArchives)) {
    const destination = path.join(inputRoot, kind);
    await mkdir(destination, { recursive: true });
    await run("tar.exe", ["-xf", archive, "-C", destination]);
    await verifyChecksums(destination);
    extracted[kind] = destination;
  }

  const builtManifest = JSON.parse(
    await readFile(path.join(extracted.extension, "manifest.json"), "utf8"),
  );
  if (builtManifest.version !== version || builtManifest.key !== sourceManifest.key) {
    throw new Error("The developer extension archive does not match the source release identity");
  }

  await cp(extracted.extension, extensionRoot, { recursive: true, force: false, errorOnExist: true });
  await writeFile(
    path.join(extensionRoot, "START-HERE.md"),
    await renderTemplate("extension-START-HERE.md", {
      VERSION: version,
      EXTENSION_ID: extensionId,
      APP_PACKAGE: appName,
    }),
    "utf8",
  );
  await writeChecksums(extensionRoot);

  const sharedFiles = await compareSharedAppFiles(extracted.windows, extracted.linux);
  for (const relativeFile of sharedFiles) {
    const destination = path.join(appRoot, relativeFile);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(extracted.windows, relativeFile), destination);
  }
  await mkdir(path.join(appRoot, "windows-x86_64"), { recursive: true });
  await mkdir(path.join(appRoot, "linux-x86_64"), { recursive: true });
  const windowsRelay = await readFile(path.join(extracted.windows, "browser-key-relay.exe"));
  const linuxRelay = await readFile(path.join(extracted.linux, "browser-key-relay"));
  if (windowsRelay.subarray(0, 2).toString("ascii") !== "MZ") throw new Error("Windows relay is not PE");
  if (!linuxRelay.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error("Linux relay is not ELF");
  }
  const expectedOrigin = Buffer.from(`chrome-extension://${extensionId}`);
  if (!windowsRelay.includes(expectedOrigin) || !linuxRelay.includes(expectedOrigin)) {
    throw new Error("A release relay does not contain the extension exact-Origin gate");
  }
  await writeFile(path.join(appRoot, "windows-x86_64", "browser-key-relay.exe"), windowsRelay);
  await writeFile(path.join(appRoot, "linux-x86_64", "browser-key-relay"), linuxRelay);
  await writeFile(
    path.join(appRoot, "START-HERE.md"),
    await renderTemplate("local-app-START-HERE.md", { VERSION: version }),
    "utf8",
  );
  await writeChecksums(appRoot);

  await createZip(extensionRoot, extensionZip);
  await createZip(appRoot, appZip);
  const assets = [];
  for (const [kind, file] of [["extension", extensionZip], ["local-app", appZip]]) {
    const bytes = await readFile(file);
    assets.push({ kind, name: path.basename(file), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
  }
  await writeFile(
    path.join(stagingRoot, "SHA256SUMS.txt"),
    `${assets.map(({ sha256, name }) => `${sha256}  ${name}`).join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    path.join(stagingRoot, "release-assets.json"),
    `${JSON.stringify({ tag, version, assets }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(stagingRoot, "RELEASE-NOTES.md"), releaseNotes(version, assets), "utf8");

  await replaceDirectory(stagingRoot, releaseRoot);
  await rm(inputRoot, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: true, tag, releaseRoot, assets }));
} catch (error) {
  await rm(stagingRoot, { recursive: true, force: true });
  await rm(inputRoot, { recursive: true, force: true });
  throw error;
}

async function compareSharedAppFiles(windowsRoot, linuxRoot) {
  const excluded = new Set(["START-HERE.md", "SHA256SUMS.txt", "browser-key-relay.exe", "browser-key-relay"]);
  const windowsFiles = (await listRegularFiles(windowsRoot)).filter((file) => !excluded.has(file));
  const linuxFiles = (await listRegularFiles(linuxRoot)).filter((file) => !excluded.has(file));
  if (JSON.stringify(windowsFiles) !== JSON.stringify(linuxFiles)) {
    throw new Error("Windows and Linux App packages have different shared file sets");
  }
  for (const relativeFile of windowsFiles) {
    const windowsBytes = await readFile(path.join(windowsRoot, relativeFile));
    const linuxBytes = await readFile(path.join(linuxRoot, relativeFile));
    if (!windowsBytes.equals(linuxBytes)) throw new Error(`Shared App file differs by platform: ${relativeFile}`);
  }
  return windowsFiles;
}

async function renderTemplate(name, values) {
  let text = await readFile(path.join(workspaceRoot, "packaging", "release", name), "utf8");
  for (const [key, value] of Object.entries(values)) text = text.replaceAll(`{{${key}}}`, value);
  if (/\{\{[A-Z_]+\}\}/u.test(text)) throw new Error(`Unresolved release template token in ${name}`);
  return text;
}

async function verifyChecksums(root) {
  const entries = (await readFile(path.join(root, "SHA256SUMS.txt"), "utf8"))
    .trimEnd().split(/\r?\n/u).map((line) => {
      const match = /^([a-f0-9]{64})  ([^\r\n]+)$/u.exec(line);
      if (match === null) throw new Error(`Invalid developer package checksum line: ${line}`);
      return { digest: match[1], relativeFile: match[2].split("/").join(path.sep) };
    });
  const actual = (await listRegularFiles(root)).filter((file) => file !== "SHA256SUMS.txt");
  if (JSON.stringify(entries.map(({ relativeFile }) => relativeFile)) !== JSON.stringify(actual)) {
    throw new Error("Developer package checksum file set does not match its directory");
  }
  for (const { digest, relativeFile } of entries) {
    const actualDigest = createHash("sha256").update(await readFile(path.join(root, relativeFile))).digest("hex");
    if (actualDigest !== digest) throw new Error(`Developer package checksum mismatch: ${relativeFile}`);
  }
}

async function writeChecksums(root) {
  const files = (await listRegularFiles(root)).filter((file) => file !== "SHA256SUMS.txt");
  const lines = [];
  for (const relativeFile of files) {
    const digest = createHash("sha256").update(await readFile(path.join(root, relativeFile))).digest("hex");
    lines.push(`${digest}  ${relativeFile.split(path.sep).join("/")}`);
  }
  await writeFile(path.join(root, "SHA256SUMS.txt"), `${lines.join("\n")}\n`, "utf8");
}

async function createZip(packageRoot, zipPath) {
  const entries = (await readdir(packageRoot)).sort((left, right) => left.localeCompare(right, "en"));
  await run("tar.exe", ["-a", "-cf", zipPath, "-C", packageRoot, ...entries]);
}

async function replaceDirectory(staging, destination) {
  const previous = `${destination}-previous-${process.pid}`;
  await rm(previous, { recursive: true, force: true });
  let movedPrevious = false;
  try {
    await rename(destination, previous);
    movedPrevious = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await rename(staging, destination);
  } catch (error) {
    if (movedPrevious) await rename(previous, destination).catch(() => undefined);
    throw error;
  }
  if (movedPrevious) await rm(previous, { recursive: true, force: true });
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
      else if (entry.isFile()) files.push(relative);
      else throw new Error("Release package contains an unsupported filesystem entry");
    }
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

async function run(executable, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: workspaceRoot, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${executable} failed: code=${String(code)} signal=${String(signal)}`));
    });
  });
}

function extensionIdFromManifestKey(key) {
  if (typeof key !== "string" || key.length === 0) throw new Error("Source manifest key is missing");
  const bytes = Buffer.from(key, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== key) throw new Error("Source manifest key is not canonical base64");
  const hex = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  return Array.from(hex, (nibble) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(nibble, 16))).join("");
}

function releaseNotes(releaseVersion, assets) {
  const lines = [
    `# Browser Key Automation v${releaseVersion}`,
    "",
    "This release intentionally has exactly two downloads:",
    "",
    `1. \`${assets[0].name}\` — unpack and load the directory containing \`manifest.json\` from \`chrome://extensions\`.`,
    `2. \`${assets[1].name}\` — one local App package containing Windows x64 and Linux x64 relays, plus one shared CLI/protocol/Agent skill.`,
    "",
    "Chrome Web Store publication is paused until the final icon design is approved. These are GitHub/manual-install packages.",
    "",
    "## SHA-256",
    "",
    "```text",
    ...assets.map(({ sha256, name }) => `${sha256}  ${name}`),
    "```",
    "",
    "Read each archive's `START-HERE.md` after extracting it.",
    "",
  ];
  return lines.join("\n");
}
