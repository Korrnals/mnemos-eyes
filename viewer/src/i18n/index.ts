import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { en } from "./en";
import { ru, type TranslationKey } from "./ru";

/**
 * Hand-rolled i18n layer (ARCHCOM-3 decision — no i18next, no runtime deps):
 * typed key dictionaries (ru.ts is the key source of truth, en.ts is
 * compiler-checked for parity), one React context, {{name}} interpolation.
 *
 * Language choice persists in localStorage under "vesmaro.lang" and mirrors
 * into document.documentElement.lang; the default is "ru". All storage/DOM
 * access is guarded so the layer works in the project's DOM-free vitest
 * environment (renderToString) and in private-mode browsers.
 */
export type Lang = "ru" | "en";
export type { TranslationKey };

export const LANG_STORAGE_KEY = "vesmaro.lang";
export const DEFAULT_LANG: Lang = "ru";
/** Segmented-control options, in display order. */
export const LANGUAGES = ["ru", "en"] as const satisfies readonly Lang[];

const DICTIONARIES: Record<Lang, Readonly<Record<TranslationKey, string>>> = { ru, en };

export type InterpolationVars = Record<string, string | number>;
export type TranslateFn = (key: TranslationKey, vars?: InterpolationVars) => string;

// --- pure helpers (unit-tested directly) -----------------------------------------

export function isLang(value: unknown): value is Lang {
  return value === "ru" || value === "en";
}

/** Guarded localStorage handle — undefined outside a browser/test stub. */
function safeStorage(): Storage | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

/** Read the persisted choice; null when absent, invalid or unavailable. */
export function readStoredLang(
  storage: Storage | undefined = safeStorage(),
): Lang | null {
  if (!storage) return null;
  try {
    const stored = storage.getItem(LANG_STORAGE_KEY);
    return isLang(stored) ? stored : null;
  } catch {
    return null; // private mode / disabled storage — fall back silently
  }
}

/** Persist the choice; storage failures are non-fatal by design. */
export function persistLang(
  lang: Lang,
  storage: Storage | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    // Swallow: the in-memory UI language still switches.
  }
}

/** Mirror the language into <html lang> (screen readers pick it up). */
export function applyDocumentLang(lang: Lang): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = lang;
}

/** Initial language: the stored choice, else the ru default (no sniffing). */
export function detectLang(): Lang {
  return readStoredLang() ?? DEFAULT_LANG;
}

/** Fill {{name}} placeholders; unknown placeholders stay visible verbatim. */
export function interpolate(template: string, vars?: InterpolationVars): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match,
  );
}

/** Dictionary lookup + interpolation (pure — usable outside React). */
export function translate(
  lang: Lang,
  key: TranslationKey,
  vars?: InterpolationVars,
): string {
  return interpolate(DICTIONARIES[lang][key] ?? ru[key], vars);
}

// --- context + hook ----------------------------------------------------------------

export interface I18n {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: TranslateFn;
}

const I18nContext = createContext<I18n | null>(null);

/** Provider-free fallback (tests, embedding): pinned to ru, setLang is a no-op. */
const BARE_I18N: I18n = {
  lang: DEFAULT_LANG,
  setLang: () => undefined,
  t: (key, vars) => translate(DEFAULT_LANG, key, vars),
};

/** Full i18n handle: lang, setter, translate. */
export function useI18n(): I18n {
  return useContext(I18nContext) ?? BARE_I18N;
}

/** Translate-only hook for leaf components. */
export function useT(): TranslateFn {
  return useI18n().t;
}

export interface I18nProviderProps {
  children: React.ReactNode;
  /** Test/embedding seam — skips storage detection when provided. */
  initialLang?: Lang;
}

export function I18nProvider({ children, initialLang }: I18nProviderProps) {
  const [lang, setLangState] = useState<Lang>(() => initialLang ?? detectLang());
  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    persistLang(next);
  }, []);
  // Keep <html lang> in sync (WCAG 3.1.1 — the language of the page must be
  // programmatically determinable and match the rendered copy).
  useEffect(() => {
    applyDocumentLang(lang);
  }, [lang]);
  const t = useCallback<TranslateFn>((key, vars) => translate(lang, key, vars), [lang]);
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return createElement(I18nContext.Provider, { value }, children);
}
