import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDeviceIdentity,
  getDeviceIdentity,
  getDeviceToken,
  hasDeviceToken,
  saveDeviceIdentity,
  DEVICE_TOKEN_STORAGE_KEY,
  DEVICE_ID_STORAGE_KEY,
  DEVICE_NAME_STORAGE_KEY,
} from "./deviceToken";

/**
 * ADR 0012 §5 storage contract: the device identity lives in localStorage
 * (pairing survives reloads and restarts — the owner never re-types the
 * token), keys mirror the board's `vesmaro.*` convention, and EVERY access
 * is fail-soft (no storage → honest "no identity", never a throw).
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

const IDENTITY = {
  token: "mnd_abc",
  deviceId: "dev_1",
  deviceName: "Браузер Android",
};

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deviceToken storage (ADR 0012 §5)", () => {
  it("saves and reads the full identity under the vesmaro.device* keys", () => {
    saveDeviceIdentity(IDENTITY);
    expect(localStorage.getItem(DEVICE_TOKEN_STORAGE_KEY)).toBe("mnd_abc");
    expect(localStorage.getItem(DEVICE_ID_STORAGE_KEY)).toBe("dev_1");
    expect(localStorage.getItem(DEVICE_NAME_STORAGE_KEY)).toBe("Браузер Android");
    expect(getDeviceToken()).toBe("mnd_abc");
    expect(hasDeviceToken()).toBe(true);
    expect(getDeviceIdentity()).toEqual(IDENTITY);
  });

  it("absent storage answers empty / null — no identity", () => {
    expect(getDeviceToken()).toBe("");
    expect(hasDeviceToken()).toBe(false);
    expect(getDeviceIdentity()).toBeNull();
  });

  it("clearDeviceIdentity removes every key", () => {
    saveDeviceIdentity(IDENTITY);
    clearDeviceIdentity();
    expect(getDeviceIdentity()).toBeNull();
    expect(localStorage.getItem(DEVICE_NAME_STORAGE_KEY)).toBeNull();
  });

  it("saveDeviceIdentity ignores an empty/blank token (never an empty identity)", () => {
    saveDeviceIdentity({ ...IDENTITY, token: "   " });
    expect(hasDeviceToken()).toBe(false);
  });

  it("trims the persisted values", () => {
    saveDeviceIdentity({ token: " mnd_padded ", deviceId: " dev_2 ", deviceName: " iOS " });
    expect(getDeviceIdentity()).toEqual({
      token: "mnd_padded",
      deviceId: "dev_2",
      deviceName: "iOS",
    });
  });

  it("is fail-soft when localStorage throws (private mode / quota)", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("denied");
      },
      setItem: () => {
        throw new DOMException("quota");
      },
      removeItem: () => {
        throw new DOMException("denied");
      },
    });
    expect(() => saveDeviceIdentity(IDENTITY)).not.toThrow();
    expect(() => clearDeviceIdentity()).not.toThrow();
    expect(getDeviceToken()).toBe("");
    expect(getDeviceIdentity()).toBeNull();
  });
});
