import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.resolve(workspaceRoot, process.argv[3] ?? "out");
const outputRelative = path.relative(path.join(workspaceRoot, "out"), outputRoot);
if (path.isAbsolute(outputRelative) || outputRelative === ".." || outputRelative.startsWith(`..${path.sep}`)) {
  throw new Error("Package output must be out or one of its subdirectories");
}
await mkdir(outputRoot, { recursive: true });
const expectedExtensionId = "dbbbehdkedibhielmkaoohbeebnbfjbo";
const extensionName = "browser-key-automation-extension-dev";
const windowsAppName = "browser-key-automation-local-app-windows-x86_64-dev";
const linuxAppName = "browser-key-automation-local-app-linux-x86_64-dev";
const extensionRoot = path.join(outputRoot, extensionName);
const windowsAppRoot = path.join(outputRoot, windowsAppName);
const linuxAppRoot = path.join(outputRoot, linuxAppName);
const packageMode = process.argv[2] ?? "all";
if (!new Set(["all", "extension", "local-app"]).has(packageMode)) {
  throw new Error("Package mode must be one of: all, extension, local-app");
}
const includeExtension = packageMode === "all" || packageMode === "extension";
const includeLocalApp = packageMode === "all" || packageMode === "local-app";

if (includeExtension) {
  const manifest = JSON.parse(
    await readFile(path.join(workspaceRoot, "out", "extension", "manifest.json"), "utf8"),
  );
  if (extensionIdFromManifestKey(manifest.key) !== expectedExtensionId) {
    throw new Error("Built extension ID does not match the local App Origin gate");
  }
  if (manifest.minimum_chrome_version !== "138") {
    throw new Error("Built extension has an unexpected minimum Chrome version");
  }
}

let builtExtensionRoot = extensionRoot;
let builtWindowsAppRoot = windowsAppRoot;
let builtLinuxAppRoot = linuxAppRoot;
if (includeExtension) builtExtensionRoot = await buildExtensionPackage();
if (includeLocalApp) {
  builtWindowsAppRoot = await buildLocalAppPackage({
    packageName: windowsAppName,
    packageRoot: windowsAppRoot,
    platform: "Windows x86_64",
    sourceExecutable: path.join(
      workspaceRoot,
      "out",
      "cross",
      "windows-x86_64",
      "bin",
      "browser-key-relay.exe",
    ),
    executableName: "browser-key-relay.exe",
    prepareCommand: "无需额外准备；若 Windows 显示来源提示，只在确认文件哈希来自本开发包后继续。",
    startCommand: ".\\browser-key-relay.exe",
  });
  builtLinuxAppRoot = await buildLocalAppPackage({
    packageName: linuxAppName,
    packageRoot: linuxAppRoot,
    platform: "Linux x86_64",
    sourceExecutable: path.join(
      workspaceRoot,
      "out",
      "cross",
      "linux-x86_64",
      "bin",
      "browser-key-relay",
    ),
    executableName: "browser-key-relay",
    prepareCommand: "执行 `chmod +x ./browser-key-relay`。",
    startCommand: "./browser-key-relay",
  });
}

if (process.platform === "win32") {
  if (includeExtension) await createZip(builtExtensionRoot, `${extensionRoot}.zip`);
  if (includeLocalApp) {
    await createZip(builtWindowsAppRoot, `${windowsAppRoot}.zip`);
    await createZip(builtLinuxAppRoot, `${linuxAppRoot}.zip`);
  }
} else {
  console.warn("Selected split package directories were built; ZIP creation currently uses Windows bsdtar.");
}

if (includeExtension) console.log(`Extension package: ${builtExtensionRoot}`);
if (includeLocalApp) {
  console.log(`Windows local App package: ${builtWindowsAppRoot}`);
  console.log(`Linux local App package: ${builtLinuxAppRoot}`);
}

async function buildExtensionPackage() {
  const stagingRoot = path.join(outputRoot, `.${extensionName}-staging-${process.pid}`);
  await rm(stagingRoot, { recursive: true, force: true });
  try {
    await cp(path.join(workspaceRoot, "out", "extension"), stagingRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    await copyFile(
      path.join(workspaceRoot, "packaging", "dev", "extension-START-HERE.md"),
      path.join(stagingRoot, "START-HERE.md"),
    );
    await writeChecksums(stagingRoot);
    return await replaceDirectory(stagingRoot, extensionRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

async function buildLocalAppPackage({
  packageName,
  packageRoot,
  platform,
  sourceExecutable,
  executableName,
  prepareCommand,
  startCommand,
}) {
  const stagingRoot = path.join(outputRoot, `.${packageName}-staging-${process.pid}`);
  await rm(stagingRoot, { recursive: true, force: true });
  try {
    await mkdir(path.join(stagingRoot, "client"), { recursive: true });
    await mkdir(path.join(stagingRoot, "protocol"), { recursive: true });
    await mkdir(path.join(stagingRoot, "skill"), { recursive: true });
    await copyFile(sourceExecutable, path.join(stagingRoot, executableName));
    await copyFile(
      path.join(workspaceRoot, "apps", "client", "src", "main.mjs"),
      path.join(stagingRoot, "client", "browser-key-cli.mjs"),
    );
    await copyFile(
      path.join(workspaceRoot, "apps", "client", "src", "native-websocket.mjs"),
      path.join(stagingRoot, "client", "native-websocket.mjs"),
    );
    for (const name of ["generated-config.mjs", "artifact-files.mjs", "demo-files.mjs"]) {
      await copyFile(path.join(workspaceRoot, "apps", "client", "src", name), path.join(stagingRoot, "client", name));
    }
    await copyFile(
      path.join(workspaceRoot, "protocol", "transport-profile.json"),
      path.join(stagingRoot, "protocol", "transport-profile.json"),
    );
    await cp(
      path.join(workspaceRoot, "skills", "browser-key-automation"),
      path.join(stagingRoot, "skill", "browser-key-automation"),
      { recursive: true, force: false, errorOnExist: true },
    );
    await copyFile(
      path.join(workspaceRoot, "registries", "commands.registry.json"),
      path.join(stagingRoot, "skill", "browser-key-automation", "references", "commands.registry.json"),
    );
    await copyFile(
      path.join(workspaceRoot, "registries", "freedom.registry.json"),
      path.join(stagingRoot, "skill", "browser-key-automation", "references", "freedom.registry.json"),
    );
    const template = await readFile(
      path.join(workspaceRoot, "packaging", "dev", "local-app-START-HERE.md"),
      "utf8",
    );
    const startHere = template
      .replaceAll("{{PLATFORM}}", platform)
      .replaceAll("{{PREPARE_COMMAND}}", prepareCommand)
      .replaceAll("{{START_COMMAND}}", startCommand);
    if (startHere.includes("{{")) throw new Error("Local App START-HERE contains an unresolved token");
    await writeFile(path.join(stagingRoot, "START-HERE.md"), startHere, "utf8");
    await writeChecksums(stagingRoot);
    return await replaceDirectory(stagingRoot, packageRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

async function replaceDirectory(stagingRoot, finalRoot) {
  const backupRoot = path.join(
    path.dirname(finalRoot),
    `.${path.basename(finalRoot)}-previous-${process.pid}`,
  );
  await rm(backupRoot, { recursive: true, force: true });
  let previousMoved = false;
  try {
    await rename(finalRoot, backupRoot);
    previousMoved = true;
  } catch (error) {
    if (error?.code !== "ENOENT") return publishBesideLockedDirectory(stagingRoot, finalRoot, error);
  }
  try {
    await rename(stagingRoot, finalRoot);
  } catch (error) {
    if (previousMoved) await rename(backupRoot, finalRoot).catch(() => undefined);
    throw error;
  }
  if (previousMoved) {
    await rm(backupRoot, { recursive: true, force: true }).catch((error) => {
      console.warn(`Previous package directory remains in use: ${backupRoot} (${error?.code ?? "unknown"})`);
    });
  }
  return finalRoot;
}

async function publishBesideLockedDirectory(stagingRoot, finalRoot, originalError) {
  if (!new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"]).has(originalError?.code)) {
    throw originalError;
  }
  const checksumText = await readFile(path.join(stagingRoot, "SHA256SUMS.txt"), "utf8");
  const suffix = createHash("sha256").update(checksumText).digest("hex").slice(0, 12);
  const alternateRoot = `${finalRoot}-build-${suffix}`;
  try {
    await rename(stagingRoot, alternateRoot);
  } catch (error) {
    if (!new Set(["EEXIST", "ENOTEMPTY"]).has(error?.code)) throw error;
    const existingChecksums = await readFile(path.join(alternateRoot, "SHA256SUMS.txt"), "utf8");
    if (existingChecksums !== checksumText) throw new Error(`Package fallback collision: ${alternateRoot}`);
    await rm(stagingRoot, { recursive: true, force: true });
  }
  console.warn(`Package directory is in use; published the new unpacked build beside it: ${alternateRoot}`);
  return alternateRoot;
}

async function writeChecksums(root) {
  const packagedFiles = await listRegularFiles(root);
  const checksumLines = [];
  for (const relativeFile of packagedFiles) {
    const bytes = await readFile(path.join(root, relativeFile));
    const digest = createHash("sha256").update(bytes).digest("hex");
    checksumLines.push(`${digest}  ${relativeFile.split(path.sep).join("/")}`);
  }
  await writeFile(path.join(root, "SHA256SUMS.txt"), `${checksumLines.join("\n")}\n`, "utf8");
}

async function createZip(packageRoot, zipPath) {
  const entries = (await readdir(packageRoot)).sort((left, right) => left.localeCompare(right, "en"));
  await rm(zipPath, { force: true });
  await run("tar.exe", ["-a", "-cf", zipPath, "-C", packageRoot, ...entries]);
  const bytes = await readFile(zipPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(`${zipPath}.sha256.txt`, `${digest}  ${path.basename(zipPath)}\n`, "utf8");
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

function extensionIdFromManifestKey(key) {
  if (typeof key !== "string") throw new Error("Built manifest key is missing");
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return Array.from(hex, (nibble) =>
    String.fromCharCode("a".charCodeAt(0) + Number.parseInt(nibble, 16)),
  ).join("");
}
