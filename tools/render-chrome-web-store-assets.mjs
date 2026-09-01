import { spawn } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(workspaceRoot, "assets", "chrome-web-store", "small-promo.svg");
const iconSource = path.join(workspaceRoot, "apps", "extension", "static", "icons", "icon-128.png");
const outputRoot = path.join(workspaceRoot, "out", "chrome-web-store", "listing-assets");
const promoOutput = path.join(outputRoot, "small-promo-440x280.png");
const iconOutput = path.join(outputRoot, "store-icon-128.png");
const chromePath = await findChrome();

await mkdir(outputRoot, { recursive: true });
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "bka-store-assets-"));

try {
  const svg = await readFile(source, "utf8");
  assertSelfContainedSvg(svg);
  const htmlPath = path.join(temporaryRoot, "small-promo.html");
  const profilePath = path.join(temporaryRoot, "chrome-profile");
  await mkdir(profilePath, { recursive: true });
  await writeFile(htmlPath, renderDocument(svg), "utf8");
  await renderWithChrome(chromePath, htmlPath, profilePath, promoOutput);
  await validatePng(promoOutput, 440, 280);
  await validatePng(iconSource, 128, 128);
  await copyFile(iconSource, iconOutput);
  await validatePng(iconOutput, 128, 128);
  console.log(JSON.stringify({
    ok: true,
    outputs: [path.relative(workspaceRoot, iconOutput), path.relative(workspaceRoot, promoOutput)],
  }));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function assertSelfContainedSvg(svg) {
  if (!svg.includes('width="440"') || !svg.includes('height="280"')) {
    throw new Error("small-promo.svg must have an intrinsic 440x280 size");
  }
  const forbidden = [/<script\b/iu, /<foreignObject\b/iu, /\b(?:href|src)\s*=\s*["'](?:https?:|data:)/iu, /<image\b/iu];
  if (forbidden.some((pattern) => pattern.test(svg))) {
    throw new Error("small-promo.svg must remain self-contained and code-free");
  }
}

function renderDocument(svg) {
  return "<!doctype html><html><head><meta charset=\"utf-8\"><style>" +
    "html,body{margin:0;width:440px;height:280px;overflow:hidden;background:#0B1020}" +
    "svg{display:block;width:440px;height:280px}" +
    `</style></head><body>${svg}</body></html>`;
}

async function renderWithChrome(executable, htmlPath, profilePath, outputPath) {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--disable-extensions",
    "--no-first-run",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=440,280",
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
      else reject(new Error(`Chrome store asset render failed: code=${String(code)} signal=${String(signal)} stderr=${stderr}`));
    });
  });
}

async function validatePng(file, width, height) {
  const bytes = await readFile(file);
  if (bytes.length < 26 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error(`${path.basename(file)} is not a PNG file`);
  }
  if (bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height || bytes[24] !== 8) {
    throw new Error(`${path.basename(file)} must be an exact ${width}x${height} 8-bit PNG`);
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
