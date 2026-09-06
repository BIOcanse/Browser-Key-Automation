import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LOCALES = Object.freeze([
  { file: "README.md", label: "English" },
  { file: "README.zh-CN.md", label: "简体中文" },
  { file: "README.zh-TW.md", label: "繁體中文" },
  { file: "README.ja.md", label: "日本語" },
  { file: "README.ko.md", label: "한국어" },
  { file: "README.de.md", label: "Deutsch" },
  { file: "README.fr.md", label: "Français" },
  { file: "README.es.md", label: "Español" },
  { file: "README.pt-BR.md", label: "Português (Brasil)" },
  { file: "README.ru.md", label: "Русский" },
]);

const version = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, "extension/manifest.json"), "utf8")).version;
const REQUIRED_SHARED_TOKENS = [
  "Browser Key Automation", "138", "Node.js 20+", "manifest.json", "Allow User Scripts",
  `browser-key-automation-extension-v${version}.zip`, `browser-key-automation-local-app-v${version}.zip`,
  "windows-x86_64", "linux-x86_64", "BKA_API_KEY", "browser-key-cli.mjs instances",
  "system.describe", "page.tree.open", "page.tree.expand.v2", "page.tree.view.get",
  "ensure.run", "input.calibrate", "keyboard.reset", "virtualMouse.*", "virtualKeyboard.*",
  "page-save", "page-shot", "element-shot", "demo-open", "debugger.attach",
  "Root", "Regular", "HTML5/OLE", "dev/skills/browser-key-automation/SKILL.md",
  "Playwright", "Puppeteer", "Selenium", "Chrome DevTools MCP", "Browser MCP", "Chrome MCP Server", "Nanobrowser"
];
const API_KEY_PATTERN = /bk1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/gu;
const freedom = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, "dev/registries/freedom.registry.json"), "utf8"));
const publicTrialKey = freedom.points.find(point => point.pointId === "build.keys.public_trial_key")?.defaultString;
assert.equal(typeof publicTrialKey, "string");

function readRepositoryFile(file) {
  return readFileSync(resolve(REPOSITORY_ROOT, file), "utf8");
}

function readRepositoryJson(file) {
  return JSON.parse(readRepositoryFile(file));
}

function headingCount(text, level) {
  const marker = "#".repeat(level);
  return [...text.matchAll(new RegExp(`^${marker} `, "gmu"))].length;
}

function languageBar(text) {
  const line = text.split(/\r?\n/u).find((candidate) =>
    candidate.includes("English") && candidate.includes("简体中文") && candidate.includes("Русский"));
  assert.ok(line, "language navigation is missing");
  return line;
}

test("repository exposes the same ten complete README locales as the reference repository", () => {
  const actual = readdirSync(REPOSITORY_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^README(?:\.[A-Za-z-]+)?\.md$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(actual, LOCALES.map(({ file }) => file).sort());
});

test("each README keeps exact language navigation and a complete shared contract", () => {
  const baseline = readRepositoryFile("README.md");
  const expectedH2 = headingCount(baseline, 2);
  const expectedH3 = headingCount(baseline, 3);
  assert.equal(expectedH2, 6);
  assert.equal(expectedH3, 0);

  for (const current of LOCALES) {
    const text = readRepositoryFile(current.file);
    assert.match(text, /^# Browser Key Automation\r?$/mu, current.file);
    assert.equal(headingCount(text, 2), expectedH2, `${current.file}: H2 topology drifted`);
    assert.equal(headingCount(text, 3), expectedH3, `${current.file}: H3 topology drifted`);
    assert.equal(text.includes("\\`"), false, `${current.file}: escaped Markdown backtick remains`);
    for (const [value] of text.matchAll(API_KEY_PATTERN)) assert.equal(value, publicTrialKey, `${current.file}: non-public Key in documentation`);

    const segments = languageBar(text).split(" | ");
    assert.equal(segments.length, LOCALES.length, `${current.file}: language count`);
    for (let index = 0; index < LOCALES.length; index += 1) {
      const locale = LOCALES[index];
      const expected = locale.file === current.file ? locale.label : `[${locale.label}](${locale.file})`;
      assert.equal(segments[index], expected, `${current.file}: navigation item ${locale.label}`);
    }

    for (const token of REQUIRED_SHARED_TOKENS) {
      assert.ok(text.includes(token), `${current.file}: missing shared token ${token}`);
    }
    assert.equal(/\]\(LICENSE(?:\.[^)]+)?\)|Apache License|MIT License/iu.test(text), false,
      `${current.file}: repository license has not been decided`);
  }
});

test("all local README links resolve inside the repository", () => {
  for (const { file } of LOCALES) {
    const text = readRepositoryFile(file);
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      const target = match[1].split("#", 1)[0];
      if (target.length === 0 || /^[a-z]+:/iu.test(target)) continue;
      assert.equal(target.startsWith("dev/docs/"), false, `${file}: internal documentation must not be a public dependency`);
      const absolute = resolve(REPOSITORY_ROOT, target);
      assert.equal(relative(REPOSITORY_ROOT, absolute).startsWith(".."), false, `${file}: link escapes repository`);
      assert.ok(existsSync(absolute), `${file}: missing link target ${target}`);
    }
  }
});

test("public READMEs install released packages without internal build documentation", () => {
  for (const { file } of LOCALES) {
    const text = readRepositoryFile(file);
    assert.ok(text.includes("https://github.com/BIOcanse/Browser-Key-Automation/releases/latest"), file);
    assert.equal(text.includes("dev/docs/historical/"), false, file);
    assert.equal(/npm (?:ci|run build:)/u.test(text), false, file);
    assert.equal(text.includes("-dev.zip"), false, file);
    assert.equal(text.includes("v0.0.0.2"), false, `${file}: previous release placeholder remains`);
  }
});

test("public prose contains product facts, not private release coordination", () => {
  const publicFiles = [
    ...LOCALES.map(({ file }) => file),
    "PRIVACY.md",
    "dev/assets/chrome-web-store/README-FIRST.txt",
    "dev/packaging/dev/extension-START-HERE.md",
    "dev/packaging/dev/local-app-START-HERE.md",
    "dev/packaging/release/extension-START-HERE.md",
    "dev/packaging/release/local-app-START-HERE.md",
    "dev/registries/README.md",
    "dev/skills/browser-key-automation/SKILL.md",
    "dev/skills/browser-key-automation/references/operation-tree.md",
    "dev/skills/browser-key-automation/references/quick-shot-and-demo.md",
    "dev/skills/browser-key-automation/references/wait-and-save.md",
    "dev/skills/browser-key-automation/references/debugger-and-element-capture.md",
    "dev/skills/browser-key-automation/references/ensure-workflows.md",
    "dev/tools/package-github-release.mjs",
  ];
  for (const file of publicFiles) {
    const text = readRepositoryFile(file);
    assert.equal(/requires separate user authorization/iu.test(text), false, file);
    assert.equal(text.includes("当前私有 GitHub 仓库"), false, file);
    assert.equal(text.includes("交回项目"), false, file);
    assert.equal(text.includes("v0.0.0.2"), false, `${file}: stale release text`);
  }
});

test("README platform and runtime claims are grounded in active authoring sources", () => {
  const commandRegistry = readRepositoryJson("dev/registries/commands.registry.json");
  const capabilityRegistry = readRepositoryJson("dev/registries/capabilities.registry.json");
  const transportProfile = readRepositoryJson("dev/protocol/transport-profile.json");
  const manifest = readRepositoryJson("extension/manifest.json");
  const packageJson = readRepositoryJson("package.json");

  const realPermission = commandRegistry.permissionDeclarations.find(
    ({ permissionId }) => permissionId === "dom.click.real");
  const realCommand = commandRegistry.commandDeclarations.find(({ method }) => method === "dom.click.real");
  const nativeCapability = capabilityRegistry.capabilities.find(
    ({ capabilityId }) => capabilityId === "platform.relay.native_input");

  assert.equal(realPermission?.status, "active");
  assert.equal(realCommand?.status, "active");
  assert.deepEqual(realCommand?.permissionExpression, { allOf: ["dom.click.real"] });
  assert.equal(nativeCapability?.status, "active");
  assert.equal(transportProfile.nativeInputClickCapability, "native.input.click.v1");
  assert.equal(transportProfile.nativeInputKeyboardCapability, "native.input.keyboard.v1");
  assert.equal(manifest.minimum_chrome_version, "138");
  assert.equal(packageJson.engines?.node, ">=20");
});
