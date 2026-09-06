import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// Content identity of build inputs, not runtime/session identity or wall-clock
// versioning. Exclude generated outputs to avoid self-referential hashes.
export async function sourceBuildId(workspace, component) {
  const files = ["dev/protocol/transport-profile.json", "extension/manifest.json", "app/build.zig",
    "dev/tools/build-identity.mjs", "dev/tools/generate-command-config.mjs", "dev/tools/generate-transport-config.mjs",
    "dev/tools/generate-ui-config.mjs"];
  if (component !== "relay" && component !== "extension") throw new Error(`Unknown build component: ${component}`);
  const pending = ["dev/registries", component === "relay" ? "app/src" : "extension/src"];
  if (component === "extension") pending.push("extension/static");
  if (component === "relay") pending.push("app/third_party");
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(path.join(workspace, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== "generated") pending.push(relative);
      else if (entry.isFile() && entry.name !== "generated_config.zig") files.push(relative);
    }
  }
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    const bytes = await readFile(path.join(workspace, file));
    hash.update(file).update("\0").update(String(bytes.length)).update("\0").update(bytes);
  }
  return `${component}-${hash.digest("hex").slice(0, 24)}`;
}
