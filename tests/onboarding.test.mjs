import assert from "node:assert/strict";
import test from "node:test";
import { openWelcomeOnInstall } from "../out/extension/background/admin-entry.js";
import { isUserScriptsAvailable, USER_SCRIPTS_SETUP_REQUIRED } from "../out/extension/shared/user-scripts.js";
import { CapabilityUnavailableError } from "../out/extension/background/capability-error.js";

test("only a fresh install opens the packaged guide; updates/reloads do not add welcome tabs", async () => {
  const tabs = [];
  const chromeApi = {
    runtime: { getURL: (file) => `chrome-extension://fixture/${file}` },
    tabs: { async create(properties) { tabs.push(properties); } },
  };
  for (const reason of ["update", "chrome_update", "shared_module_update"]) {
    assert.equal(await openWelcomeOnInstall(reason, chromeApi), false);
  }
  assert.deepEqual(tabs, []);
  assert.equal(await openWelcomeOnInstall("install", chromeApi), true);
  assert.deepEqual(tabs, [{ url: "chrome-extension://fixture/admin/welcome.html", active: true }]);
  await assert.rejects(openWelcomeOnInstall("install", {
    ...chromeApi, tabs: { async create() { throw new Error("browser refused tab"); } },
  }), /browser refused tab/);
});

test("user-script availability uses one read-only probe and handles missing, thrown and rejected APIs", async () => {
  const previous = globalThis.chrome;
  try {
    globalThis.chrome = {};
    assert.equal(await isUserScriptsAvailable(), false);
    globalThis.chrome = { get userScripts() { throw new Error("access disabled"); } };
    assert.equal(await isUserScriptsAvailable(), false);
    globalThis.chrome = { userScripts: { getScripts() { throw new Error("sync revoked"); } } };
    assert.equal(await isUserScriptsAvailable(), false);
    globalThis.chrome = { userScripts: { async getScripts() { throw new Error("async revoked"); } } };
    assert.equal(await isUserScriptsAvailable(), false);
    let probes = 0;
    globalThis.chrome = { userScripts: {
      async getScripts() { probes += 1; return []; },
      execute() { assert.fail("availability must not execute arbitrary code"); },
    } };
    assert.equal(await isUserScriptsAvailable(), true);
    assert.equal(probes, 1);
  } finally {
    if (previous === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous;
  }
});

test("only the script-toggle error exposes actionable packaged setup instructions to the Agent", () => {
  const unavailable = new CapabilityUnavailableError("platform.extension.user_scripts", "USER_SCRIPTS_NOT_ENABLED", "internal message");
  assert.equal(unavailable.details.setupInstructions, USER_SCRIPTS_SETUP_REQUIRED);
  assert.match(JSON.stringify(unavailable.details), /chrome:\/\/extensions/);
  const other = new CapabilityUnavailableError("platform.extension.scripting", "CHROMIUM_API_FAILED", "private Chromium exception");
  assert.deepEqual(other.details, { capabilityId: "platform.extension.scripting", reason: "CHROMIUM_API_FAILED" });
  assert.equal(JSON.stringify(other.details).includes("private Chromium exception"), false);
});
