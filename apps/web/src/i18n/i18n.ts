import { LOCALES, type Locale } from "@bandroom/shared";
import i18next, { type i18n as I18n } from "i18next";
import { initReactI18next } from "react-i18next";
import csCommon from "../locales/cs/common.json";
import enCommon from "../locales/en/common.json";

export const LANGUAGE_STORAGE_KEY = "bandroom.language";
export const DEFAULT_NS = "common";

export const resources = {
  en: { common: enCommon },
  cs: { common: csCommon },
} as const;

function isLocale(value: string | null | undefined): value is Locale {
  return value !== null && value !== undefined && (LOCALES as readonly string[]).includes(value);
}

function readStoredLanguage(): string | null {
  try {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Language selection order (SPEC §12): stored choice (user setting from M1) → first supported
 * browser language → instance default.
 */
export function detectLanguage(
  defaultLocale: Locale,
  stored: string | null = readStoredLanguage(),
  browserLanguages: readonly string[] = navigator.languages,
): Locale {
  if (isLocale(stored)) return stored;
  for (const tag of browserLanguages) {
    const primary = tag.toLowerCase().split("-")[0];
    if (isLocale(primary)) return primary;
  }
  return defaultLocale;
}

export async function initI18n(language: Locale, instance: I18n = i18next): Promise<I18n> {
  await instance.use(initReactI18next).init({
    resources,
    lng: language,
    fallbackLng: "en",
    supportedLngs: [...LOCALES],
    defaultNS: DEFAULT_NS,
    ns: [DEFAULT_NS],
    interpolation: { escapeValue: false }, // React escapes
    returnNull: false,
  });
  syncDocumentLanguage(language);
  return instance;
}

export function syncDocumentLanguage(language: Locale): void {
  document.documentElement.lang = language;
}

export async function changeLanguage(language: Locale, instance: I18n = i18next): Promise<void> {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // storage unavailable (private mode): the choice lasts for this page only
  }
  await instance.changeLanguage(language);
  syncDocumentLanguage(language);
}
