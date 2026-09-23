import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Theme = "dark" | "light";
/**
 * The user-facing choice (UI-23, spec §2.1/§4.2): `system` follows the OS
 * (and is the default = no stored record), `light`/`dark` are explicit.
 * The top-bar toggle stays two-position and writes explicit light/dark;
 * «Системная» is selectable only in the settings hub.
 */
export type ThemePreference = "system" | "light" | "dark";

/**
 * localStorage keys (spec §4.2 migration): the registry key is `vesmaro.theme`;
 * the legacy `mnemos-eyes:theme` (namespace violation, design-system.md §9)
 * is still READ as a fallback so an updated browser keeps its old choice —
 * but never written (an old-version tab in another window must not lose its
 * pick; the legacy key dies out naturally).
 */
export const THEME_STORAGE_KEY = "vesmaro.theme";
export const LEGACY_THEME_STORAGE_KEY = "mnemos-eyes:theme";

export const DEFAULT_THEME_PREFERENCE: ThemePreference = "system";
/** Segmented-control options, in display order (hub wireframe §3.1). */
export const THEME_PREFERENCES = [
  "system",
  "dark",
  "light",
] as const satisfies readonly ThemePreference[];

interface ThemeContextValue {
  /** RESOLVED theme (what is applied to <html>) — dark even under `system`. */
  theme: Theme;
  /** The stored choice: system | light | dark (hub's three positions). */
  themePreference: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isStoredTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

function getSystemTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/**
 * Read the persisted preference: new key → legacy key → null (= system).
 * Guarded try/catch — private mode falls back to the system default silently
 * (spec §4.1 storage conventions).
 */
export function readStoredThemePreference(): ThemePreference | null {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "system" || isStoredTheme(stored)) return stored;
  } catch {
    return null; // storage unavailable — system default
  }
  try {
    const legacy = window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
    return isStoredTheme(legacy) ? legacy : null;
  } catch {
    return null;
  }
}

function applyTheme(theme: Theme): void {
  // design-system.md §9: light sets [data-theme="light"]; dark = attribute
  // removed (dark tokens live on :root).
  if (theme === "light") {
    document.documentElement.dataset.theme = "light";
  } else {
    delete document.documentElement.dataset.theme;
  }
}

/**
 * Theming per design-system.md §9 + UI-23 migration: default = system
 * preference (followed LIVE while no explicit choice exists), explicit choice
 * persisted under `vesmaro.theme`, applied via `data-theme` on <html>.
 * «Системная» removes BOTH records — otherwise the legacy fallback would
 * resurrect the pre-migration choice and the hub's «Системная» would not
 * survive a reload (spec acceptance §8.2).
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themePreference, setPreferenceState] = useState<ThemePreference>(() => {
    return readStoredThemePreference() ?? DEFAULT_THEME_PREFERENCE;
  });
  const [systemTheme, setSystemTheme] = useState<Theme>(getSystemTheme);

  // The resolved theme the rest of the app consumes.
  const theme: Theme = themePreference === "system" ? systemTheme : themePreference;

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Follow the OS while the user has not made an explicit choice — the
  // preference state is the single authority (no storage re-reads here).
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (event: MediaQueryListEvent) => {
      setSystemTheme(event.matches ? "light" : "dark");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const setTheme = useCallback((next: ThemePreference) => {
    try {
      if (next === "system") {
        window.localStorage.removeItem(THEME_STORAGE_KEY);
        window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
      } else {
        // Writes go ONLY to the new registry key (spec §4.2).
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
      }
    } catch {
      // Non-fatal: theme still applies for this session.
    }
    setPreferenceState(next);
  }, []);

  // Two-position top-bar toggle over the SAME state: from `system` it writes
  // the explicit opposite of the resolved theme (dark↔light cycle, spec §2.1).
  const toggleTheme = useCallback(() => {
    setTheme(theme === "light" ? "dark" : "light");
  }, [setTheme, theme]);

  const value = useMemo(
    () => ({ theme, themePreference, setTheme, toggleTheme }),
    [theme, themePreference, setTheme, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Access the current theme. Throws outside <ThemeProvider>. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme: missing <ThemeProvider> in the component tree.");
  }
  return ctx;
}
