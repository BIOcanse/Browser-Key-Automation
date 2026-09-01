import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(workspaceRoot, "out", "extension");
const stagingRoot = path.join(workspaceRoot, "out", `.extension-staging-${process.pid}`);
const extensionRoot = path.join(workspaceRoot, "apps", "extension");

const staticFiles = [
  ["manifest.json", "manifest.json"],
  [path.join("static", "admin", "index.html"), path.join("admin", "index.html")],
  [path.join("static", "admin", "welcome.html"), path.join("admin", "welcome.html")],
  [path.join("static", "admin", "admin.css"), path.join("admin", "admin.css")],
  [path.join("static", "offscreen", "index.html"), path.join("offscreen", "index.html")],
  ...[16, 32, 48, 128].map((size) => [path.join("static", "icons", `icon-${size}.png`), path.join("icons", `icon-${size}.png`)]),
  ...["index.html", "sandbox.html", "viewer.css"].map((name) => [path.join("static", "demo", name), path.join("demo", name)]),
];

async function runTypeScript(projectFile, outDir) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(workspaceRoot, "node_modules", "typescript", "bin", "tsc"),
        "-p",
        projectFile,
        "--outDir",
        outDir,
      ],
      { cwd: workspaceRoot, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`TypeScript failed: code=${String(code)} signal=${String(signal)}`));
    });
  });
}

const { writeChromeLocales } = await import("./generate-ui-config.mjs");
await import("./generate-transport-config.mjs");
await import("./generate-command-config.mjs");
await rm(stagingRoot, { recursive: true, force: true });
await mkdir(path.join(stagingRoot, "admin"), { recursive: true });
await mkdir(path.join(stagingRoot, "offscreen"), { recursive: true });
await mkdir(path.join(stagingRoot, "demo"), { recursive: true });
await mkdir(path.join(stagingRoot, "icons"), { recursive: true });
await runTypeScript(path.join("apps", "extension", "tsconfig.background.json"), stagingRoot);
await runTypeScript(path.join("apps", "extension", "tsconfig.admin.json"), stagingRoot);
await runTypeScript(path.join("apps", "extension", "tsconfig.transport.json"), stagingRoot);

for (const [sourceRelative, outputRelative] of staticFiles) {
  await copyFile(
    path.join(extensionRoot, sourceRelative),
    path.join(stagingRoot, outputRelative),
  );
}
await writeChromeLocales(stagingRoot);

await rm(outputRoot, { recursive: true, force: true });
await rename(stagingRoot, outputRoot);
console.log(`Extension artifact: ${outputRoot}`);
