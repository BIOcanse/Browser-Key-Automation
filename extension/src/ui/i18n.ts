import {
  UI_LOCALES,
  UI_MESSAGES,
  type UiLocale,
  type UiLocalePreference,
  type UiMessageKey,
} from "../generated/ui-config.js";

export type UiValues = Readonly<Record<string, string | number>>;

function normalizedLanguage(value: string): string { return value.replaceAll("_", "-").toLocaleLowerCase("en-US"); }

export function isLocalePreference(value: unknown): value is UiLocalePreference {
  return value === "auto" || typeof value === "string" && UI_LOCALES.some((locale) => locale.tag === value);
}

export function resolveBrowserLocale(languages: readonly string[]): UiLocale {
  for (const language of languages) {
    const normalized = normalizedLanguage(language);
    const matches = UI_LOCALES.flatMap((locale) => [locale.tag, ...locale.browserAliases]
      .map((alias) => ({ locale, alias: normalizedLanguage(alias) })))
      .filter(({ alias }) => normalized === alias || normalized.startsWith(`${alias}-`))
      .sort((left, right) => right.alias.length - left.alias.length);
    const bestMatch = matches[0];
    if (bestMatch !== undefined) return bestMatch.locale.tag;
    const base = normalized.split("-", 1)[0];
    const compatible = UI_LOCALES.find((locale) => normalizedLanguage(locale.tag).split("-", 1)[0] === base ||
      locale.browserAliases.some((alias) => normalizedLanguage(alias).split("-", 1)[0] === base));
    if (compatible !== undefined) return compatible.tag;
  }
  return "en";
}

export function resolveLocale(preference: UiLocalePreference, languages: readonly string[]): UiLocale {
  return preference === "auto" ? resolveBrowserLocale(languages) : preference;
}

export function translate(locale: UiLocale, key: UiMessageKey, values: UiValues = {}): string {
  let text = UI_MESSAGES[locale][key];
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}

export function localeDefinition(locale: UiLocale) {
  const definition = UI_LOCALES.find((candidate) => candidate.tag === locale);
  if (definition === undefined) throw new Error(`Unknown generated UI locale: ${locale}`);
  return definition;
}

export { UI_LOCALES, type UiLocale, type UiLocalePreference, type UiMessageKey };
