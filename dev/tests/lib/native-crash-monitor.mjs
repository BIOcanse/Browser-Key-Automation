import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Explicit, test-only first-chance capture for the observed illegal instruction.
// Never register ProcDump globally or discover/attach a browser by process name.
export async function monitorNativeCrash({ executable, browserPid, directory }) {
  assert.ok(path.isAbsolute(executable));
  assert.ok(Number.isSafeInteger(browserPid) && browserPid > 0);
  await mkdir(directory, { recursive: true });
  const child = spawn(executable, ["-accepteula", "-mm", "-e", "1", "-f", "C000001D", "-n", "1", String(browserPid), directory], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ProcDump did not confirm attachment within 10s")), 10_000);
    const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
    child.once("error", finish);
    child.once("exit", (code) => finish(new Error(`ProcDump exited before attachment: ${code}`)));
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf16le");
      stream.on("data", (chunk) => {
        output += chunk;
        process.stdout.write(chunk);
        if (/Press Ctrl-C|Exception monitor.*set up/iu.test(output)) finish();
      });
    }
  });
  const stop = async () => {
    if (child.exitCode === null) {
      const cancel = spawn(executable, ["-cancel", String(browserPid)], { windowsHide: true, stdio: "ignore" });
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        const done = () => { clearTimeout(timer); resolve(); };
        cancel.once("exit", done); cancel.once("error", done);
      });
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(resolve, 5_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    await writeFile(path.join(directory, "procdump.log"), output);
  };
  try { await ready; } catch (error) { await stop(); throw error; }
  return { stop };
}
