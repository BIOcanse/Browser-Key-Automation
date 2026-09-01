import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builtRoot = path.join(workspaceRoot, "out", "extension");
const outputRoot = path.join(workspaceRoot, "out", "chrome-web-store");
const sourceManifestPath = path.join(workspaceRoot, "apps", "extension", "manifest.json");
const sourceManifest = JSON.parse(await readFile(sourceManifestPath, "utf8"));
const builtManifest = JSON.parse(await readFile(path.join(builtRoot, "manifest.json"), "utf8"));

validateManifest(builtManifest);
if (typeof sourceManifest.key !== "string" || sourceManifest.key.length === 0) {
  throw new Error("The source manifest must retain its fixed development public key");
}
if (builtManifest.key !== sourceManifest.key) {
  throw new Error("The built manifest does not match the source development identity");
}
await validateLocales(builtManifest);
await validateIcons(builtManifest);

const stem = `browser-key-automation-chrome-web-store-initial-upload-v${builtManifest.version}`;
const packageRoot = path.join(outputRoot, stem);
const stagingRoot = path.join(outputRoot, `.${stem}-staging-${process.pid}`);
const zipPath = path.join(outputRoot, `${stem}.zip`);
await mkdir(outputRoot, { recursive: true });
await rm(stagingRoot, { recursive: true, force: true });

try {
  await cp(builtRoot, stagingRoot, { recursive: true, force: false, errorOnExist: true });
  const storeManifest = { ...builtManifest };
  delete storeManifest.key;
  await writeFile(
    path.join(stagingRoot, "manifest.json"),
    `${JSON.stringify(storeManifest, null, 2)}\n`,
    "utf8",
  );
  const files = await listRegularFiles(stagingRoot);
  validatePackageFiles(files);
  await replaceDirectory(stagingRoot, packageRoot);
} catch (error) {
  await rm(stagingRoot, { recursive: true, force: true });
  throw error;
}

await rm(zipPath, { force: true });
const topLevelEntries = (await readdir(packageRoot)).sort((left, right) => left.localeCompare(right, "en"));
await run("tar.exe", ["-a", "-cf", zipPath, "-C", packageRoot, ...topLevelEntries]);
const zipBytes = await readFile(zipPath);
const digest = createHash("sha256").update(zipBytes).digest("hex");
await writeFile(`${zipPath}.sha256.txt`, `${digest}  ${path.basename(zipPath)}\n`, "utf8");
await writeFile(
  path.join(outputRoot, "NEXT-STEPS.md"),
  `# Chrome Web Store next step\n\n` +
    `Upload \`${path.basename(zipPath)}\` with **Add new item** only to create the Dashboard item. ` +
    `Do not publish this initial identity-bootstrap build.\n\n` +
    `After upload, copy the Dashboard Item ID and the public key shown on the Package page. ` +
    `A release identity profile and both paired local Apps must then be built against that identity before publication; ` +
    `the current unpacked development identity remains separate.\n\n` +
    `SHA-256: \`${digest}\`\n`,
  "utf8",
);

console.log(JSON.stringify({
  ok: true,
  kind: "chrome-web-store-initial-upload",
  version: builtManifest.version,
  packageRoot,
  zipPath,
  sha256: digest,
  sourceDevelopmentKeyRetained: true,
  uploadedManifestKeyRemoved: true,
}));

function validateManifest(manifest) {
  if (manifest.manifest_version !== 3) throw new Error("Chrome Web Store package must use Manifest V3");
  if (manifest.name !== "Browser Key Automation") throw new Error("Unexpected extension name");
  if (!/^\d+(?:\.\d+){0,3}$/u.test(manifest.version ?? "")) throw new Error("Invalid Chrome extension version");
  if (typeof manifest.description !== "string" || manifest.description.length === 0) {
    throw new Error("Extension description is missing");
  }
  if (typeof manifest.default_locale !== "string" || manifest.default_locale.length === 0) {
    throw new Error("Extension default_locale is missing");
  }
  if (manifest.minimum_chrome_version !== "138") throw new Error("Unexpected minimum Chrome version");
  if (manifest.background?.service_worker !== "background.js" || manifest.background?.type !== "module") {
    throw new Error("Unexpected background service worker declaration");
  }
}

async function validateLocales(manifest) {
  const localeDirectories = await readdir(path.join(builtRoot, "_locales"), { withFileTypes: true });
  if (!localeDirectories.some((entry) => entry.isDirectory() && entry.name === manifest.default_locale)) {
    throw new Error("The default locale is not packaged");
  }
  for (const entry of localeDirectories) {
    if (!entry.isDirectory()) throw new Error("_locales contains an unsupported entry");
    const messages = JSON.parse(
      await readFile(path.join(builtRoot, "_locales", entry.name, "messages.json"), "utf8"),
    );
    const description = messages.extensionDescription?.message;
    if (typeof description !== "string" || description.length === 0 || [...description].length > 132) {
      throw new Error(`Locale ${entry.name} has an invalid extension description`);
    }
  }
}

async function validateIcons(manifest) {
  const expected = { "16": "icons/icon-16.png", "32": "icons/icon-32.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" };
  if (JSON.stringify(manifest.icons) !== JSON.stringify(expected)) {
    throw new Error("Manifest icons must declare the four release PNG sizes");
  }
  for (const [sizeText, relativeFile] of Object.entries(expected)) {
    const size = Number(sizeText);
    const bytes = await readFile(path.join(builtRoot, relativeFile));
    if (bytes.length < 26 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error(`${relativeFile} is not a PNG file`);
    }
    if (bytes.readUInt32BE(16) !== size || bytes.readUInt32BE(20) !== size) {
      throw new Error(`${relativeFile} has an unexpected size`);
    }
    if (bytes[25] !== 6) throw new Error(`${relativeFile} must be an RGBA PNG`);
  }
}

function validatePackageFiles(files) {
  const normalized = files.map((file) => file.split(path.sep).join("/"));
  if (!normalized.includes("manifest.json")) throw new Error("Packaged manifest is missing");
  for (const file of normalized) {
    const lower = file.toLowerCase();
    if (lower === "key.pem" || lower.endsWith(".pem") || lower.endsWith(".p12") ||
        lower.endsWith(".pfx") || lower.endsWith(".map") ||
        lower === "start-here.md" || lower === "sha256sums.txt") {
      throw new Error(`Forbidden Chrome Web Store package file: ${file}`);
    }
  }
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
    const directory = pending.shift();
    const entries = await readdir(path.join(root, directory), { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relative = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(relative);
      else if (entry.isFile()) files.push(relative);
      else throw new Error("Chrome Web Store package contains an unsupported filesystem entry");
    }
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

async function run(executable, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: workspaceRoot,
      windowsHide: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${executable} failed: code=${String(code)} signal=${String(signal)}`));
    });
  });
}
