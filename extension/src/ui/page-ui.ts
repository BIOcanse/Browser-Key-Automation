import { UI_DEFAULT_LOCALE } from "../generated/ui-config.js";
import {
  UI_LOCALES,
  isLocalePreference,
  localeDefinition,
  resolveLocale,
  translate,
  type UiLocale,
  type UiLocalePreference,
  type UiMessageKey,
  type UiValues,
} from "./i18n.js";
export type { UiMessageKey } from "./i18n.js";

type ThemeChoice = "dark" | "light" | "system";
const LOCALE_STORAGE_KEY = "browser-key-automation.ui-locale.v1";
const THEME_STORAGE_KEY = "browser-key-automation.admin-theme.v1";
const listeners = new Set<() => void>();
let preference: UiLocalePreference = readLocalePreference();
let locale: UiLocale = resolveLocale(preference, navigator.languages);

function readLocalePreference(): UiLocalePreference {
  try {
    const value = localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocalePreference(value) ? value : UI_DEFAULT_LOCALE;
  } catch { return UI_DEFAULT_LOCALE; }
}

export function t(key: UiMessageKey, values: UiValues = {}): string { return translate(locale, key, values); }
export function uiLocale(): UiLocale { return locale; }

export function formatDate(value: number): string {
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(value);
}

export function formatNumber(value: number): string { return new Intl.NumberFormat(locale).format(value); }
export function formatRelativeDays(value: number): string {
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(value, "day");
}

export function applyTranslations(root: ParentNode = document): void {
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = node.dataset.i18n as UiMessageKey;
    node.textContent = t(key);
  }
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    node.title = t(node.dataset.i18nTitle as UiMessageKey);
  }
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n-aria]")) {
    node.setAttribute("aria-label", t(node.dataset.i18nAria as UiMessageKey));
  }
  for (const node of root.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]")) {
    node.placeholder = t(node.dataset.i18nPlaceholder as UiMessageKey);
  }
}

export function onLocaleChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function renderPreferenceWarning(failed: boolean): void {
  const warning = document.querySelector<HTMLElement>("[data-preference-warning]");
  if (warning === null) return;
  warning.hidden = !failed;
  warning.textContent = failed ? t("preferenceNotSaved") : "";
}

function applyLocale(): void {
  locale = resolveLocale(preference, navigator.languages);
  const definition = localeDefinition(locale);
  document.documentElement.lang = locale;
  document.documentElement.dir = definition.direction;
  applyTranslations();
  const select = document.querySelector<HTMLSelectElement>("[data-locale]");
  if (select !== null) {
    select.value = preference;
    const auto = select.querySelector<HTMLOptionElement>('option[value="auto"]');
    if (auto !== null) auto.textContent = t("followBrowser", { language: definition.nativeName });
  }
  for (const listener of listeners) listener();
}

function selectLocale(value: unknown, persist: boolean): void {
  if (!isLocalePreference(value)) return;
  let failed = false;
  if (persist) {
    try { localStorage.setItem(LOCALE_STORAGE_KEY, value); }
    catch { failed = true; }
  }
  preference = value;
  applyLocale();
  renderPreferenceWarning(failed);
}

function readTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "dark" || value === "light" ? value : "system";
  } catch { return "system"; }
}

function applyTheme(theme: ThemeChoice, persist: boolean): void {
  const select = document.querySelector<HTMLSelectElement>("[data-theme]");
  if (select !== null) select.value = theme;
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  if (!persist) return;
  try { localStorage.setItem(THEME_STORAGE_KEY, theme); renderPreferenceWarning(false); }
  catch { renderPreferenceWarning(true); }
}

const localeSelect = document.querySelector<HTMLSelectElement>("[data-locale]");
if (localeSelect !== null) {
  for (const definition of UI_LOCALES) {
    const option = document.createElement("option");
    option.value = definition.tag;
    option.lang = definition.tag;
    option.dir = definition.direction;
    option.textContent = definition.nativeName;
    localeSelect.append(option);
  }
  localeSelect.addEventListener("change", () => selectLocale(localeSelect.value, true));
}
const themeSelect = document.querySelector<HTMLSelectElement>("[data-theme]");
themeSelect?.addEventListener("change", () => applyTheme(
  themeSelect.value === "dark" || themeSelect.value === "light" ? themeSelect.value : "system", true,
));
window.addEventListener("storage", (event) => {
  if (event.storageArea !== localStorage) return;
  if (event.key === LOCALE_STORAGE_KEY) selectLocale(event.newValue ?? UI_DEFAULT_LOCALE, false);
  if (event.key === THEME_STORAGE_KEY) applyTheme(readTheme(), false);
});
applyTheme(readTheme(), false);
applyLocale();
