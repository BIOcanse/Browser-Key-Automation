import { spawn } from "node:child_process";
import { access, lstat, mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const largeSource = path.join(workspaceRoot, "assets", "brand", "browser-key-automation-icon.svg");
const toolbarSource = path.join(workspaceRoot, "assets", "brand", "browser-key-automation-icon-toolbar.svg");
const destination = path.join(workspaceRoot, "apps", "extension", "static", "icons");
const workRoot = path.join(workspaceRoot, "out", "icon-render");
const stagingRoot = path.join(workRoot, `.staging-${process.pid}`);
const stagingIcons = path.join(stagingRoot, "icons");
const chromePath = await findChrome();
const sources = {
  16: await readFlatSvg(toolbarSource, 16),
  32: await readFlatSvg(toolbarSource, 16),
  48: await readFlatSvg(toolbarSource, 16),
  128: await readFlatSvg(largeSource, 128),
};

await removeTree(stagingRoot);
await mkdir(stagingIcons, { recursive: true });

try {
  for (const size of [16, 32, 48, 128]) {
    const htmlPath = path.join(stagingRoot, `icon-${size}.html`);
    const profilePath = path.join(stagingRoot, `profile-${size}`);
    const outputPath = path.join(stagingIcons, `icon-${size}.png`);
    await writeFile(htmlPath, renderDocument(sources[size], size), "utf8");
    await runChrome(chromePath, htmlPath, profilePath, outputPath, size);
    await validatePng(outputPath, size);
    await removeTree(profilePath);
  }
  await replaceDirectory(stagingIcons, destination);
  await removeTree(stagingRoot);
  console.log(JSON.stringify({ ok: true, chromePath, destination, sizes: [16, 32, 48, 128] }));
} catch (error) {
  await removeTree(stagingRoot).catch(() => undefined);
  throw error;
}

async function readFlatSvg(file, expectedSize) {
  const source = await readFile(file, "utf8");
  if (!source.includes(`width="${expectedSize}"`) || !source.includes(`height="${expectedSize}"`)) {
    throw new Error(`${path.basename(file)} has an unexpected intrinsic size`);
  }
  const forbidden = [/<(?:linear|radial)Gradient\b/iu, /\bfilter\s*=/iu, /\bopacity\s*=/iu, /\burl\s*\(/iu];
  if (forbidden.some((pattern) => pattern.test(source))) {
    throw new Error(`${path.basename(file)} must remain a flat icon without gradients, filters, or opacity effects`);
  }
  const colors = new Set([...source.matchAll(/#[0-9A-Fa-f]{6}/gu)].map(([color]) => color.toUpperCase()));
  const expectedColors = new Set(["#2563EB", "#FFFFFF"]);
  if (colors.size !== expectedColors.size || [...colors].some((color) => !expectedColors.has(color))) {
    throw new Error(`${path.basename(file)} must use only #2563EB and #FFFFFF`);
  }
  return source;
}

function renderDocument(svg, size) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>` +
    `html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent}` +
    `svg{display:block;width:${size}px;height:${size}px}` +
    `</style></head><body>${svg}</body></html>`;
}

async function runChrome(executable, htmlPath, profilePath, outputPath, size) {
  await mkdir(profilePath, { recursive: true });
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--disable-extensions",
    "--no-first-run",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--default-background-color=00000000",
    `--window-size=${size},${size}`,
    `--user-data-dir=${profilePath}`,
    `--screenshot=${outputPath}`,
    pathToFileURL(htmlPath).href,
  ];
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: workspaceRoot,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Chrome icon render failed: code=${String(code)} signal=${String(signal)} stderr=${stderr}`));
    });
  });
}

async function validatePng(file, size) {
  const bytes = await readFile(file);
  if (bytes.length < 26 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error(`${path.basename(file)} is not a PNG file`);
  }
  if (bytes.readUInt32BE(16) !== size || bytes.readUInt32BE(20) !== size || bytes[24] !== 8 || bytes[25] !== 6) {
    throw new Error(`${path.basename(file)} must be an exact ${size}px 8-bit RGBA PNG`);
  }
}

async function findChrome() {
  const candidates = [];
  if (process.env.BKA_CHROME_PATH) candidates.push(process.env.BKA_CHROME_PATH);
  if (process.platform === "win32") {
    for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]) {
      if (root) candidates.push(path.join(root, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else {
    candidates.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser");
  }
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through the bounded candidate list.
    }
  }
  throw new Error("Chrome was not found. Set BKA_CHROME_PATH to a compatible Chromium executable.");
}

async function replaceDirectory(staging, target) {
  const previous = `${target}.previous-${process.pid}`;
  await removeTree(previous);
  let movedPrevious = false;
  try {
    await rename(target, previous);
    movedPrevious = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await rename(staging, target);
  } catch (error) {
    if (movedPrevious) await rename(previous, target).catch(() => undefined);
    throw error;
  }
  if (movedPrevious) await removeTree(previous);
}

async function removeTree(root) {
  try {
    await lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const pending = [{ directory: root, visited: false }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current.visited) {
      await rmdir(current.directory);
      continue;
    }
    pending.push({ directory: current.directory, visited: true });
    const entries = await readdir(current.directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current.directory, entry.name);
      if (entry.isDirectory()) pending.push({ directory: absolute, visited: false });
      else if (entry.isFile()) await unlink(absolute);
      else throw new Error(`Refusing to remove unsupported entry: ${absolute}`);
    }
  }
}
