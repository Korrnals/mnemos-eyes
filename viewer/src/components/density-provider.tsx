import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Density modes (redesign concept §3.3 / ARCHCOM-3 verdict §2): a user-facing
 * compact/comfortable toggle that drives ONLY the operational reading regime
 * via the `--row-h`/`--list-gap` tokens. Contemplative surfaces (search,
 * pulse, memory lists) stay airy regardless — the contrast between regimes is
 * the design decision.
 *
 * The choice persists under "vesmaro.density" (same `vesmaro.*` namespace as
 * the language key) and applies as `[data-density]` on <html>. All storage
 * and DOM access is guarded so the provider behaves in the DOM-free vitest
 * environment and in private-mode browsers.
 */
export type Density = "comfortable" | "compact";

export const DENSITY_STORAGE_KEY = "vesmaro.density";
export const DEFAULT_DENSITY: Density = "comfortable";

/** Segmented/toggle options in display order. */
export const DENSITIES = [
  "comfortable",
  "compact",
] as const satisfies readonly Density[];

interface DensityContextValue {
  density: Density;
  setDensity: (density: Density) => void;
  toggleDensity: () => void;
}

const DensityContext = createContext<DensityContextValue | null>(null);

export function isDensity(value: unknown): value is Density {
  return value === "comfortable" || value === "compact";
}

/** Guarded localStorage handle — undefined outside a browser/test stub. */
function safeStorage(): Storage | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

/** Read the persisted choice; null when absent, invalid or unavailable. */
export function readStoredDensity(
  storage: Storage | undefined = safeStorage(),
): Density | null {
  if (!storage) return null;
  try {
    const stored = storage.getItem(DENSITY_STORAGE_KEY);
    return isDensity(stored) ? stored : null;
  } catch {
    return null; // private mode / disabled storage — silent fallback
  }
}

/** Persist the choice; storage failures are non-fatal by design. */
export function persistDensity(
  density: Density,
  storage: Storage | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(DENSITY_STORAGE_KEY, density);
  } catch {
    // Swallow: the in-memory UI density still switches.
  }
}

/** Mirror the density onto <html data-density> (tokens switch on it). */
export function applyDensity(density: Density): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.density = density;
}

/** Initial density: the stored choice, else the comfortable default. */
export function detectDensity(): Density {
  return readStoredDensity() ?? DEFAULT_DENSITY;
}

export function DensityProvider({
  children,
  initialDensity,
}: {
  children: ReactNode;
  /** Test/embedding seam — skips storage detection when provided. */
  initialDensity?: Density;
}) {
  const [density, setDensityState] = useState<Density>(
    () => initialDensity ?? detectDensity(),
  );

  useEffect(() => {
    applyDensity(density);
  }, [density]);

  const setDensity = useCallback((next: Density) => {
    setDensityState(next);
    persistDensity(next);
  }, []);

  const toggleDensity = useCallback(() => {
    setDensityState((current) => {
      const next = current === "compact" ? "comfortable" : "compact";
      persistDensity(next);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ density, setDensity, toggleDensity }),
    [density, setDensity, toggleDensity],
  );

  return <DensityContext.Provider value={value}>{children}</DensityContext.Provider>;
}

/** Access the density handle. Throws outside <DensityProvider>. */
export function useDensity(): DensityContextValue {
  const ctx = useContext(DensityContext);
  if (!ctx) {
    throw new Error(
      "useDensity: missing <DensityProvider> in the component tree (see src/main.tsx).",
    );
  }
  return ctx;
}
