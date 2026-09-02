import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validatePermissionGroups } from "../tools/lib/ui-permission-groups.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(workspaceRoot, "out", "extension");
const { UI_LOCALES, UI_MESSAGES, UI_MESSAGE_KEYS, UI_PERMISSION_GROUPS } = await import("../out/extension/generated/ui-config.js");
const { isLocalePreference, localeDefinition, resolveBrowserLocale, resolveLocale, translate } =
  await import("../out/extension/ui/i18n.js");

test("UI catalog has 20 complete choices including separate Simplified and Traditional Chinese", () => {
  assert.equal(UI_LOCALES.length, 20);
  assert.equal(new Set(UI_LOCALES.map(({ tag }) => tag)).size, 20);
  assert.equal(Object.keys(UI_MESSAGES).length, 20);
  assert.ok(UI_LOCALES.some(({ tag }) => tag === "zh-CN"));
  assert.ok(UI_LOCALES.some(({ tag }) => tag === "zh-TW"));
  assert.notEqual(UI_MESSAGES["zh-CN"].manageKeys, UI_MESSAGES["zh-TW"].manageKeys);
  for (const { tag, nativeName } of UI_LOCALES) {
    assert.ok(nativeName.length > 0, tag);
    assert.deepEqual(Object.keys(UI_MESSAGES[tag]).sort(), [...UI_MESSAGE_KEYS].sort(), tag);
  }
});

test("browser locale selection prefers the most specific compatible alias", () => {
  assert.equal(resolveBrowserLocale(["zh-Hant-HK"]), "zh-TW");
  assert.equal(resolveBrowserLocale(["zh-Hans-SG"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh-HK"]), "zh-TW");
  assert.equal(resolveBrowserLocale(["pt-PT"]), "pt-BR");
  assert.equal(resolveBrowserLocale(["fr-CA", "de"]), "fr");
  assert.equal(resolveBrowserLocale(["xx"]), "en");
  assert.equal(resolveLocale("uk", ["en"]), "uk");
  assert.equal(resolveLocale("auto", ["ja-JP"]), "ja");
});

test("UI locale contracts keep preference, placeholders and RTL deterministic", () => {
  assert.equal(isLocalePreference("auto"), true);
  assert.equal(isLocalePreference("zh-TW"), true);
  assert.equal(isLocalePreference("xx"), false);
  assert.equal(localeDefinition("ar").direction, "rtl");
  assert.equal(UI_LOCALES.filter(({ direction }) => direction === "rtl").length, 1);
  assert.match(translate("en", "copied", { name: "API Key" }), /API Key/u);
});

test("packaged manifest and Chrome catalogs are complete", async () => {
  const manifest = JSON.parse(await readFile(path.join(outputRoot, "manifest.json"), "utf8"));
  assert.equal(manifest.default_locale, "en");
  assert.equal(manifest.description, "__MSG_extensionDescription__");
  assert.equal(manifest.action.default_title, "__MSG_actionTitle__");
  const localeDirectories = (await readdir(path.join(outputRoot, "_locales"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(localeDirectories, UI_LOCALES.map(({ tag }) => tag.replaceAll("-", "_")).sort());
  for (const directory of localeDirectories) {
    const messages = JSON.parse(await readFile(path.join(outputRoot, "_locales", directory, "messages.json"), "utf8"));
    assert.equal(typeof messages.extensionDescription.message, "string");
    assert.equal(typeof messages.actionTitle.message, "string");
  }
});

test("permission groups are an explicit complete projection of active atoms with all 20 labels", async () => {
  const ui = JSON.parse(await readFile(path.join(workspaceRoot, "registries/ui.registry.json"), "utf8"));
  const commands = JSON.parse(await readFile(path.join(workspaceRoot, "registries/commands.registry.json"), "utf8"));
  const active = commands.permissionDeclarations.filter(({ status }) => status === "active").map(({ permissionId }) => permissionId);
  assert.deepEqual(UI_PERMISSION_GROUPS, ui.permissionGroups);
  validatePermissionGroups(UI_PERMISSION_GROUPS, active, UI_MESSAGE_KEYS);
  assert.deepEqual(UI_PERMISSION_GROUPS.flatMap(({ permissionIds }) => permissionIds).sort(), active.sort());
  for (const group of UI_PERMISSION_GROUPS) {
    for (const { tag } of UI_LOCALES) assert.ok(UI_MESSAGES[tag][group.labelKey].trim(), `${tag}.${group.labelKey}`);
  }
  const groupOf = (permission) => UI_PERMISSION_GROUPS.find(({ permissionIds }) => permissionIds.includes(permission)).groupId;
  assert.notEqual(groupOf("dom.click"), groupOf("dom.click.real"));
  assert.notEqual(groupOf("dom.click"), groupOf("js.execute"));
  assert.notEqual(groupOf("dom.click.real"), groupOf("js.execute"));
});

test("permission group authoring rejects omissions, duplication, inactive atoms and missing labels", () => {
  const active = ["a", "b"];
  const labels = ["groupLabel"];
  const valid = [{ groupId: "one", labelKey: "groupLabel", permissionIds: ["a", "b"] }];
  assert.doesNotThrow(() => validatePermissionGroups(valid, active, labels));
  assert.throws(() => validatePermissionGroups([], active, labels), /empty/u);
  assert.throws(() => validatePermissionGroups([...valid, ...valid], active, labels), /duplicate.*group/u);
  assert.throws(() => validatePermissionGroups([{ ...valid[0], permissionIds: [] }], active, labels), /members/u);
  assert.throws(() => validatePermissionGroups([{ ...valid[0], labelKey: "missing" }], active, labels), /label/u);
  assert.throws(() => validatePermissionGroups([{ ...valid[0], permissionIds: ["a"] }], active, labels), /Ungrouped/u);
  assert.throws(() => validatePermissionGroups([{ ...valid[0], permissionIds: ["a", "a", "b"] }], active, labels), /Duplicate.*assignment/u);
  assert.throws(() => validatePermissionGroups([{ ...valid[0], permissionIds: ["a", "retired"] }], active, labels), /inactive/u);
  assert.throws(() => validatePermissionGroups([
    { ...valid[0], permissionIds: ["a"] }, { ...valid[0], groupId: "two", permissionIds: ["a", "b"] },
  ], active, labels), /Duplicate.*assignment/u);
});
