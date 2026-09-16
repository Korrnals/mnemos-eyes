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

/** localStorage key fixed by docs/design-system.md §9. */
const STORAGE_KEY = "mnemos-eyes:theme";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function getStoredTheme(): Theme | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : null;
  } catch {
    // Storage can be unavailable (private mode, blocked cookies).
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
 * Dark/light theming per design-system.md §9: default = system preference,
 * explicit choice persisted in localStorage, applied via the `data-theme`
 * attribute on <html>.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    return getStoredTheme() ?? getSystemTheme();
  });

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Follow the OS while the user has not made an explicit choice.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (event: MediaQueryListEvent) => {
      if (getStoredTheme()) return;
      setThemeState(event.matches ? "light" : "dark");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Non-fatal: theme still applies for this session.
    }
    setThemeState(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "light" ? "dark" : "light");
  }, [setTheme, theme]);

  const value = useMemo(
    () => ({ theme, setTheme, toggleTheme }),
    [theme, setTheme, toggleTheme],
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
