import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// Content identity of build inputs, not runtime/session identity or wall-clock
// versioning. Exclude generated outputs to avoid self-referential hashes.
export async function sourceBuildId(workspace, component) {
  const files = ["protocol/transport-profile.json", "apps/extension/manifest.json", "build.zig",
    "tools/build-identity.mjs", "tools/generate-command-config.mjs", "tools/generate-transport-config.mjs",
    "tools/generate-ui-config.mjs"];
  const pending = ["registries", `apps/${component}/src`];
  if (component === "extension") pending.push("apps/extension/static");
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
