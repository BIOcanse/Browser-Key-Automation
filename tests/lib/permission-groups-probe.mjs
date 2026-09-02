import assert from "node:assert/strict";
import { pageEvaluate } from "./cdp-client.mjs";

export async function probePermissionGroups(pageClient) {
  const samples = await pageEvaluate(pageClient, () => {
    const picker = document.querySelector("[data-create-permissions]");
    const all = picker.querySelector("[data-permissions-all]");
    const selected = () => [...picker.querySelectorAll("[data-permission-id]:checked")].map((input) => input.dataset.permissionId).sort();
    const toggle = (id) => picker.querySelector(`[data-permission-group-toggle="${id}"]`);
    const expand = (id) => picker.querySelector(`[data-permission-group-expand="${id}"]`);
    const atom = (id) => picker.querySelector(`[data-permission-id="${id}"]`);
    const state = (id) => ({ checked: toggle(id).checked, mixed: toggle(id).indeterminate });
    const samples = { initial: { count: selected().length, groups: picker.querySelectorAll("[data-permission-group]").length,
      collapsed: [...picker.querySelectorAll(".permission-group-members")].every((panel) => panel.hidden) } };
    all.click();
    samples.cleared = selected();
    document.querySelector("[data-cancel-create]").click();
    document.querySelector("[data-open-create]").click();
    samples.resetCount = selected().length;
    all.click();
    toggle("dom").click();
    samples.domOnly = selected();
    expand("dom").click();
    atom("dom.scroll").click();
    samples.partial = { selected: selected(), dom: state("dom"), allMixed: all.indeterminate };
    toggle("native-input").click();
    samples.nativeIndependent = { native: atom("dom.click.real").checked, javascript: atom("js.execute").checked, dom: state("dom") };
    toggle("javascript").click();
    toggle("dom").click();
    samples.filled = state("dom");
    toggle("dom").click();
    samples.domCleared = selected();

    const kind = document.querySelector("[data-create-kind]");
    kind.value = "root";
    kind.dispatchEvent(new Event("change", { bubbles: true }));
    samples.root = { hidden: picker.hidden, note: !document.querySelector("[data-root-permission-note]").hidden,
      disabled: [...picker.querySelectorAll("input, button")].every((input) => input.disabled) };
    kind.value = "regular";
    kind.dispatchEvent(new Event("change", { bubbles: true }));
    samples.backToRegular = { selected: selected(), enabled: [...picker.querySelectorAll("input, button")].every((input) => !input.disabled) };

    const locale = document.querySelector("[data-locale]");
    const previousLocale = locale.value;
    samples.locales = [];
    for (const tag of ["ar", "zh-TW", "zh-CN"]) {
      locale.value = tag;
      locale.dispatchEvent(new Event("change", { bubbles: true }));
      samples.locales.push({ lang: document.documentElement.lang, selected: selected(),
        expanded: expand("dom").getAttribute("aria-expanded"),
        label: toggle("page-read").parentElement.querySelector("span").textContent,
        overflow: picker.scrollWidth > picker.clientWidth });
    }
    locale.value = previousLocale;
    locale.dispatchEvent(new Event("change", { bubbles: true }));
    expand("dom").click();
    samples.afterCollapse = selected();
    expand("dom").click();

    // Prepare a real scoped Key for the caller's existing create/save workflow.
    if (!all.checked || all.indeterminate) all.click();
    all.click();
    toggle("page-read").click();
    atom("dom.click").click();
    samples.finalSelection = selected();
    return samples;
  });
  assert.equal(samples.initial.count, 40);
  assert.equal(samples.initial.groups, 9);
  assert.equal(samples.initial.collapsed, true);
  assert.deepEqual(samples.cleared, []);
  assert.equal(samples.resetCount, 40);
  assert.deepEqual(samples.domOnly, ["dom.click", "dom.focus", "dom.scroll", "dom.select", "dom.setValue"]);
  assert.deepEqual(samples.partial, { selected: ["dom.click", "dom.focus", "dom.select", "dom.setValue"], dom: { checked: false, mixed: true }, allMixed: true });
  assert.deepEqual(samples.nativeIndependent, { native: true, javascript: false, dom: { checked: false, mixed: true } });
  assert.deepEqual(samples.filled, { checked: true, mixed: false });
  assert.deepEqual(samples.domCleared, ["dom.click.real", "js.execute"]);
  assert.deepEqual(samples.root, { hidden: true, note: true, disabled: true });
  assert.deepEqual(samples.backToRegular, { selected: samples.domCleared, enabled: true });
  for (const locale of samples.locales) {
    assert.deepEqual(locale.selected, samples.domCleared);
    assert.equal(locale.expanded, "true");
    assert.equal(locale.overflow, false);
  }
  assert.equal(samples.locales[1].label, "頁面讀取");
  assert.equal(samples.locales[2].label, "页面读取");
  assert.deepEqual(samples.afterCollapse, samples.domCleared);
  assert.ok(samples.finalSelection.includes("system.read"));
  assert.ok(samples.finalSelection.includes("dom.click"));
  assert.equal(samples.finalSelection.includes("dom.click.real"), false);
  assert.equal(samples.finalSelection.includes("js.execute"), false);

  const viewport = await pageEvaluate(pageClient, () => ({ width: innerWidth, height: innerHeight, locale: document.querySelector("[data-locale]").value }));
  await pageClient.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  try {
    samples.narrowLayouts = await pageEvaluate(pageClient, () => {
      const locale = document.querySelector("[data-locale]");
      const picker = document.querySelector("[data-create-permissions]");
      const layouts = [];
      for (const tag of ["ar", "de"]) {
        locale.value = tag;
        locale.dispatchEvent(new Event("change", { bubbles: true }));
        layouts.push({ lang: document.documentElement.lang, width: innerWidth,
          overflow: document.documentElement.scrollWidth > innerWidth || picker.scrollWidth > picker.clientWidth,
          selected: [...picker.querySelectorAll("[data-permission-id]:checked")].map((input) => input.dataset.permissionId).sort(),
          countDirection: getComputedStyle(picker.querySelector(".permission-selection-count")).direction,
          atomDirection: getComputedStyle(picker.querySelector(".permission-copy strong")).direction });
      }
      return layouts;
    });
    for (const layout of samples.narrowLayouts) {
      assert.equal(layout.width, 390);
      assert.equal(layout.overflow, false);
      assert.deepEqual(layout.selected, samples.finalSelection);
      assert.equal(layout.countDirection, "ltr");
      assert.equal(layout.atomDirection, "ltr");
    }
  } finally {
    await pageClient.send("Emulation.clearDeviceMetricsOverride");
    await pageEvaluate(pageClient, ({ locale: value }) => {
      const locale = document.querySelector("[data-locale]");
      locale.value = value;
      locale.dispatchEvent(new Event("change", { bubbles: true }));
    }, viewport);
  }
  return samples;
}
