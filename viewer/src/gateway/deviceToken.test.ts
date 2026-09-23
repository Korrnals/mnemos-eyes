import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDeviceIdentity,
  getDeviceIdentity,
  getDeviceScope,
  getDeviceToken,
  hasDeviceToken,
  saveDeviceIdentity,
  DEVICE_TOKEN_STORAGE_KEY,
  DEVICE_ID_STORAGE_KEY,
  DEVICE_NAME_STORAGE_KEY,
  DEVICE_SCOPE_STORAGE_KEY,
} from "./deviceToken";

/**
 * ADR 0012 §5 storage contract: the device identity lives in localStorage
 * (pairing survives reloads and restarts — the owner never re-types the
 * token), keys mirror the board's `vesmaro.*` convention, and EVERY access
 * is fail-soft (no storage → honest "no identity", never a throw).
 * Scope v1 (ADR 0012 Amendment): the scope rides the identity; an ABSENT
 * scope field (a phone paired on 1.22.x) reads as "control" — the server
 * migration flipped every active session.
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
    saveDeviceIdentity({ ...IDENTITY, scope: "control" });
    expect(localStorage.getItem(DEVICE_TOKEN_STORAGE_KEY)).toBe("mnd_abc");
    expect(localStorage.getItem(DEVICE_ID_STORAGE_KEY)).toBe("dev_1");
    expect(localStorage.getItem(DEVICE_NAME_STORAGE_KEY)).toBe("Браузер Android");
    expect(getDeviceToken()).toBe("mnd_abc");
    expect(hasDeviceToken()).toBe(true);
    expect(getDeviceIdentity()).toEqual({ ...IDENTITY, scope: "control" });
  });

  it("absent storage answers empty / null — no identity", () => {
    expect(getDeviceToken()).toBe("");
    expect(hasDeviceToken()).toBe(false);
    expect(getDeviceIdentity()).toBeNull();
  });

  it("clearDeviceIdentity removes every key", () => {
    saveDeviceIdentity({ ...IDENTITY, scope: "read" });
    clearDeviceIdentity();
    expect(getDeviceIdentity()).toBeNull();
    expect(localStorage.getItem(DEVICE_NAME_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(DEVICE_SCOPE_STORAGE_KEY)).toBeNull();
  });

  it("saveDeviceIdentity ignores an empty/blank token (never an empty identity)", () => {
    saveDeviceIdentity({ ...IDENTITY, token: "   " });
    expect(hasDeviceToken()).toBe(false);
  });

  it("trims the persisted values", () => {
    saveDeviceIdentity({
      token: " mnd_padded ",
      deviceId: " dev_2 ",
      deviceName: " iOS ",
      scope: "control",
    });
    expect(getDeviceIdentity()).toEqual({
      token: "mnd_padded",
      deviceId: "dev_2",
      deviceName: "iOS",
      scope: "control",
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

describe("deviceScope (ADR 0012 Amendment, scope v1)", () => {
  it("a stored read identity reads back as read", () => {
    saveDeviceIdentity({ ...IDENTITY, scope: "read" });
    expect(localStorage.getItem(DEVICE_SCOPE_STORAGE_KEY)).toBe("read");
    expect(getDeviceScope()).toBe("read");
    expect(getDeviceIdentity()?.scope).toBe("read");
  });

  it("an absent scope field (pre-v1 identity) reads as control — migration semantics", () => {
    // exactly the storage a 1.22.x phone holds: token/id/name, no scope
    localStorage.setItem(DEVICE_TOKEN_STORAGE_KEY, "mnd_legacy-phone");
    localStorage.setItem(DEVICE_ID_STORAGE_KEY, "dev_old");
    localStorage.setItem(DEVICE_NAME_STORAGE_KEY, "Pixel");
    expect(getDeviceScope()).toBe("control");
    expect(getDeviceIdentity()?.scope).toBe("control");
  });

  it("a new pairing (control) stores no scope key — the default shape", () => {
    saveDeviceIdentity({ ...IDENTITY, scope: "control" });
    expect(localStorage.getItem(DEVICE_SCOPE_STORAGE_KEY)).toBeNull();
    expect(getDeviceScope()).toBe("control");
  });

  it("garbage in the scope key falls back to control", () => {
    localStorage.setItem(DEVICE_SCOPE_STORAGE_KEY, "root");
    expect(getDeviceScope()).toBe("control");
  });
});
