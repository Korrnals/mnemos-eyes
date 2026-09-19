import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_STORAGE_KEY, clearToken } from "./auth";

/** Minimal Storage stand-in (vitest node env has none). */
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
  keys(): string[] {
    return [...this.store.keys()];
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("sessionStorage", new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearToken();
});

describe("resolveAdapterKind", () => {
  it("accepts every documented VITE_ADAPTER value", async () => {
    const { resolveAdapterKind } = await import("./adapterConfig");
    expect(resolveAdapterKind("mock")).toBe("mock");
    expect(resolveAdapterKind("mnemos")).toBe("mnemos");
    expect(resolveAdapterKind("board")).toBe("board");
  });

  it("defaults to mnemos and still honours the legacy mock knob", async () => {
    const { resolveAdapterKind } = await import("./adapterConfig");
    expect(resolveAdapterKind(undefined, undefined)).toBe("mnemos");
    expect(resolveAdapterKind("", "http")).toBe("mnemos");
    expect(resolveAdapterKind(undefined, "mock")).toBe("mock");
  });

  it("VITE_ADAPTER wins over the legacy knob; unknown values fail safe", async () => {
    const { resolveAdapterKind } = await import("./adapterConfig");
    expect(resolveAdapterKind("board", "mock")).toBe("board");
    expect(resolveAdapterKind("mnemos", "mock")).toBe("mnemos");
    expect(resolveAdapterKind("garbage", "mock")).toBe("mnemos");
  });
});

describe("createGateway", () => {
  // After vi.resetModules() the dynamic import re-evaluates the module graph,
  // so adapter classes must come from the same re-import as createGateway
  // for instanceof to hold.
  async function importFresh() {
    const config = await import("./adapterConfig");
    const board = await import("./BoardAdapter");
    const http = await import("./HttpAdapter");
    const mock = await import("./MockAdapter");
    return { config, board, http, mock };
  }

  it("builds the HttpAdapter by default (mnemos behaviour unchanged)", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_ADAPTER", "");
    const {
      config: { createGateway },
      http: { HttpAdapter: FreshHttpAdapter },
    } = await importFresh();
    expect(createGateway()).toBeInstanceOf(FreshHttpAdapter);
  });

  it("builds the MockAdapter via the legacy dev knob", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_ADAPTER", "");
    vi.stubEnv("VITE_MNEMOS_ADAPTER", "mock");
    const {
      config: { createGateway },
      mock: { MockAdapter: FreshMockAdapter },
    } = await importFresh();
    expect(createGateway()).toBeInstanceOf(FreshMockAdapter);
  });

  it("builds the BoardAdapter with the board base URL", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_ADAPTER", "board");
    vi.stubEnv("VITE_BOARD_API_URL", "https://board.example/api");
    const {
      config: { createGateway, BOARD_BASE_URL },
      board: { BoardAdapter: FreshBoardAdapter },
    } = await importFresh();
    expect(BOARD_BASE_URL).toBe("https://board.example/api");
    expect(createGateway()).toBeInstanceOf(FreshBoardAdapter);
  });

  it("board mode purges a legacy stored mnemos token at bootstrap", async () => {
    // Simulate a leftover mnemos-mode session carrying an mnk_ token.
    localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ token: "mnk_purged_at_bootstrap" }),
    );
    vi.resetModules();
    vi.stubEnv("VITE_ADAPTER", "board");

    const { createGateway } = await import("./adapterConfig");
    createGateway();

    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it("in board mode no mnk_-bearing key appears in browser storage", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_ADAPTER", "board");

    const { createGateway } = await import("./adapterConfig");
    createGateway();

    const allKeys = [...localStorage.keys(), ...sessionStorage.keys()];
    expect(allKeys).toEqual([]);
    const storedValues = allKeys
      .map((key) => localStorage.getItem(key) ?? sessionStorage.getItem(key) ?? "")
      .join(" ");
    expect(storedValues).not.toContain("mnk_");
  });
});

describe("routerBasename", () => {
  it("mounts the router under the Vite base and stays at root in dev", async () => {
    const { routerBasename } = await import("./adapterConfig");
    expect(routerBasename("/app/")).toBe("/app");
    expect(routerBasename("/")).toBeUndefined();
    expect(routerBasename("")).toBeUndefined();
  });
});
