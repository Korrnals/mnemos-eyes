import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearUiToken,
  getUiToken,
  hasUiToken,
  setUiToken,
  UI_TOKEN_STORAGE_KEY,
} from "./uiToken";

/**
 * Ф3 ui-token storage (class `ui`, token split): sessionStorage — NEVER
 * localStorage (the machine is shared; the tab close must drop the token).
 * Fail-soft contract: without sessionStorage every helper answers "no
 * token" instead of throwing.
 */

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", new MemoryStorage());
  vi.stubGlobal("localStorage", new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uiToken storage", () => {
  it("empty by default: getUiToken '' / hasUiToken false", () => {
    expect(getUiToken()).toBe("");
    expect(hasUiToken()).toBe(false);
  });

  it("setUiToken persists trimmed under vesmaro.uiToken in sessionStorage only", () => {
    setUiToken("  ui-secret-value  ");
    expect(sessionStorage.getItem(UI_TOKEN_STORAGE_KEY)).toBe("ui-secret-value");
    expect(localStorage.getItem(UI_TOKEN_STORAGE_KEY)).toBeNull();
    expect(getUiToken()).toBe("ui-secret-value");
    expect(hasUiToken()).toBe(true);
  });

  it("clearUiToken drops the stored value", () => {
    setUiToken("ui-secret-value");
    clearUiToken();
    expect(getUiToken()).toBe("");
    expect(hasUiToken()).toBe(false);
  });

  it("an empty value clears instead of storing an empty secret", () => {
    setUiToken("ui-secret-value");
    setUiToken("   ");
    expect(hasUiToken()).toBe(false);
  });

  it("fail-soft without sessionStorage: reads answer '', writes no-op", () => {
    // Simulate hardened environments / non-browser runs.
    vi.stubGlobal("sessionStorage", undefined);
    expect(getUiToken()).toBe("");
    expect(hasUiToken()).toBe(false);
    expect(() => {
      setUiToken("x");
      clearUiToken();
    }).not.toThrow();
    expect(hasUiToken()).toBe(false);
  });
});
