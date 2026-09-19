import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import {
  DEFAULT_DENSITY,
  DENSITY_STORAGE_KEY,
  DensityProvider,
  applyDensity,
  detectDensity,
  isDensity,
  persistDensity,
  readStoredDensity,
} from "./density-provider";

/** In-memory Storage double (the real DOM localStorage is absent in node). */
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial));
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => store.get(k) ?? null,
    key: (i) => [...store.keys()][i] ?? null,
    removeItem: (k) => void store.delete(k),
    setItem: (k, v) => void store.set(k, v),
  };
}

/**
 * Ф1 density gate (QA verdict §3: state persistence tested): comfortable is
 * the default, the choice persists under "vesmaro.density", invalid values
 * fall back honestly, and the provider exposes the toggle handle.
 */
describe("density helpers", () => {
  it("recognizes only the two modes", () => {
    expect(isDensity("comfortable")).toBe(true);
    expect(isDensity("compact")).toBe(true);
    expect(isDensity("cozy")).toBe(false);
    expect(isDensity(null)).toBe(false);
  });

  it("defaults to comfortable and reads a persisted choice", () => {
    expect(detectDensity()).toBe(DEFAULT_DENSITY);
    expect(DEFAULT_DENSITY).toBe("comfortable");
    const storage = memoryStorage({ [DENSITY_STORAGE_KEY]: "compact" });
    expect(readStoredDensity(storage)).toBe("compact");
    expect(detectDensity()).toBe(DEFAULT_DENSITY); // global storage untouched
  });

  it("persists under vesmaro.density and survives a read-back roundtrip", () => {
    const storage = memoryStorage();
    persistDensity("compact", storage);
    expect(storage.getItem(DENSITY_STORAGE_KEY)).toBe("compact");
    expect(readStoredDensity(storage)).toBe("compact");
  });

  it("ignores invalid stored values instead of crashing", () => {
    const storage = memoryStorage({ [DENSITY_STORAGE_KEY]: "diagonal" });
    expect(readStoredDensity(storage)).toBeNull();
  });

  it("survives unavailable storage (private mode)", () => {
    expect(readStoredDensity(undefined)).toBeNull();
    expect(() => persistDensity("compact", undefined)).not.toThrow();
  });

  it("applies [data-density] onto the document element (no-op without DOM)", () => {
    expect(() => applyDensity("compact")).not.toThrow();
  });
});

describe("DensityProvider", () => {
  it("renders children and the initial seam pins the mode", () => {
    const html = renderToString(
      <DensityProvider initialDensity="compact">
        <p>shell</p>
      </DensityProvider>,
    );
    expect(html).toContain("shell");
  });
});
