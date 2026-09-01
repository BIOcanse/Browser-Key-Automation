import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

const REQUIRED_SHARED_TOKENS = Object.freeze([
  "Browser Key Automation",
  "138",
  "browser-key-automation-extension-dev.zip",
  "browser-key-automation-local-app-windows-x86_64-dev.zip",
  "browser-key-automation-local-app-linux-x86_64-dev.zip",
  "browser-key-automation-extension-v0.0.0.1.zip",
  "browser-key-automation-local-app-v0.0.0.1.zip",
  "build:github-release",
  "windows-x86_64",
  "linux-x86_64",
  "manifest.json",
  "Allow User Scripts",
  "BKA_API_KEY",
  "browser-key-cli.mjs instances",
  "system.describe",
  "page.tree.open",
  "page.tree.expand.v2",
  "page.tree.view.get",
  "page.wait",
  "page-save",
  "page-shot",
  "demo-open",
  "dom.click.real",
  "native.input.click.v1",
  "input_sent",
  "Root",
  "Regular",
  "docs/README.md",
  "docs/decisions.md",
  "docs/PROGRESS.md",
  "docs/implementation/github-release-delivery.md",
  "skills/browser-key-automation/SKILL.md",
]);

const API_KEY_PATTERN = /bk1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/u;
const SEMANTIC_SENTINELS = Object.freeze({
  "README.md": [
    "asks Chromium to activate the target tab and focus its browser window",
    "Linux App currently does not advertise",
    "callers separately authorized for `keys.create` or `keys.reveal`",
    "not a Chrome Web Store release",
  ],
  "README.zh-CN.md": [
    "请求 Chromium 激活目标标签页并聚焦对应浏览器窗口",
    "Linux App 当前不声明",
    "被单独授予 `keys.create` 或 `keys.reveal`",
    "不是 Chrome 应用商店发布版",
  ],
  "README.zh-TW.md": [
    "要求啟用目標分頁並聚焦其瀏覽器視窗",
    "Linux App 目前不宣告",
    "另外獲授權 `keys.create` 或 `keys.reveal`",
    "目前不是 Chrome 線上應用程式商店版本",
  ],
  "README.ja.md": [
    "対象タブのアクティブ化とブラウザーウィンドウのフォーカスを Chromium に要求",
    "Linux App は現在 `native.input.click.v1` を公開しない",
    "`keys.create` または `keys.reveal` を個別に許可",
    "Chrome ウェブストア版ではありません",
  ],
  "README.ko.md": [
    "Chromium에 대상 탭 활성화와 브라우저 창 포커스를 요청",
    "Linux App은 현재 `native.input.click.v1`을 광고하지 않",
    "`keys.create` 또는 `keys.reveal` 권한을 별도로",
    "Chrome 웹 스토어 릴리스가 아닙니다",
  ],
  "README.de.md": [
    "fordert es Chromium auf, den Ziel-Tab zu aktivieren und sein Browserfenster zu fokussieren",
    "Linux-App kündigt `native.input.click.v1` derzeit nicht an",
    "gesonderter Berechtigung für `keys.create` oder `keys.reveal`",
    "keine Veröffentlichung im Chrome Web Store",
  ],
  "README.fr.md": [
    "demande à Chromium d'activer l'onglet cible et de focaliser sa fenêtre",
    "L'App Linux n'annonce actuellement pas `native.input.click.v1`",
    "autorisés séparément pour `keys.create` ou `keys.reveal`",
    "Ce n'est pas une publication du Chrome Web Store",
  ],
  "README.es.md": [
    "solicita a Chromium activar la pestaña de destino y enfocar su ventana",
    "La App de Linux no anuncia actualmente `native.input.click.v1`",
    "autorizados por separado para `keys.create` o `keys.reveal`",
    "No es una publicación de Chrome Web Store",
  ],
  "README.pt-BR.md": [
    "solicita ao Chromium que ative a aba de destino e dê foco à janela",
    "O App Linux atualmente não anuncia `native.input.click.v1`",
    "autorizados separadamente para `keys.create` ou `keys.reveal`",
    "não é uma publicação da Chrome Web Store",
  ],
  "README.ru.md": [
    "просит Chromium активировать целевую вкладку и сфокусировать окно браузера",
    "Linux App сейчас не объявляет `native.input.click.v1`",
    "с отдельным разрешением `keys.create` или `keys.reveal`",
    "Это не публикация в Chrome Web Store",
  ],
});

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
  assert.equal(expectedH2, 8);
  assert.equal(expectedH3, 6);

  for (const current of LOCALES) {
    const text = readRepositoryFile(current.file);
    assert.match(text, /^# Browser Key Automation\r?$/mu, current.file);
    assert.equal(headingCount(text, 2), expectedH2, `${current.file}: H2 topology drifted`);
    assert.equal(headingCount(text, 3), expectedH3, `${current.file}: H3 topology drifted`);
    assert.equal(text.includes("\\`"), false, `${current.file}: escaped Markdown backtick remains`);
    assert.equal(API_KEY_PATTERN.test(text), false, `${current.file}: a complete API Key must not appear`);

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
    for (const sentinel of SEMANTIC_SENTINELS[current.file]) {
      assert.ok(text.includes(sentinel), `${current.file}: semantic contract drifted: ${sentinel}`);
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
      const absolute = resolve(REPOSITORY_ROOT, target);
      assert.equal(relative(REPOSITORY_ROOT, absolute).startsWith(".."), false, `${file}: link escapes repository`);
      assert.ok(existsSync(absolute), `${file}: missing link target ${target}`);
    }
  }
});

test("the documentation index links only to existing repository files", () => {
  const file = "docs/README.md";
  const text = readRepositoryFile(file);
  assert.equal(text.includes("\\\`"), false, `${file}: escaped Markdown backtick remains`);
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
    const target = match[1].split("#", 1)[0];
    if (target.length === 0 || /^[a-z]+:/iu.test(target)) continue;
    const absolute = resolve(REPOSITORY_ROOT, "docs", target);
    assert.equal(relative(REPOSITORY_ROOT, absolute).startsWith(".."), false, `${file}: link escapes repository`);
    assert.ok(existsSync(absolute), `${file}: missing link target ${target}`);
  }
});

test("README platform and runtime claims are grounded in active authoring sources", () => {
  const commandRegistry = readRepositoryJson("registries/commands.registry.json");
  const capabilityRegistry = readRepositoryJson("registries/capabilities.registry.json");
  const transportProfile = readRepositoryJson("protocol/transport-profile.json");
  const manifest = readRepositoryJson("apps/extension/manifest.json");
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
  assert.equal(manifest.minimum_chrome_version, "138");
  assert.equal(packageJson.engines?.node, ">=20");
});
