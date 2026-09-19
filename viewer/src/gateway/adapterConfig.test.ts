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

  it("falls back to the environment-aware default and honours the legacy mock knob", async () => {
    const { resolveAdapterKind } = await import("./adapterConfig");
    expect(resolveAdapterKind(undefined, undefined, "board")).toBe("board");
    expect(resolveAdapterKind(undefined, undefined, "mock")).toBe("mock");
    expect(resolveAdapterKind("", "http", "board")).toBe("board");
    expect(resolveAdapterKind(undefined, "mock", "board")).toBe("mock");
  });

  it("VITE_ADAPTER wins over the legacy knob; unknown values fail safe to the fallback", async () => {
    const { resolveAdapterKind } = await import("./adapterConfig");
    expect(resolveAdapterKind("board", "mock")).toBe("board");
    expect(resolveAdapterKind("mnemos", "mock")).toBe("mnemos");
    expect(resolveAdapterKind("garbage", "mock", "board")).toBe("board");
    expect(resolveAdapterKind("garbage", undefined, "mock")).toBe("mock");
  });
});

describe("adapter default (owner feedback 1.4.0)", () => {
  // After vi.resetModules() the dynamic import re-evaluates the module graph,
  // so adapter classes must come from the same re-import for instanceof.
  async function importFresh() {
    const config = await import("./adapterConfig");
    const board = await import("./BoardAdapter");
    const http = await import("./HttpAdapter");
    const mock = await import("./MockAdapter");
    return { config, board, http, mock };
  }

  it("a production build with no knobs boots the BoardAdapter", async () => {
    vi.resetModules();
    vi.stubEnv("PROD", true);
    vi.stubEnv("VITE_ADAPTER", "");
    vi.stubEnv("VITE_MNEMOS_ADAPTER", "");
    const {
      config: { ADAPTER, createGateway },
      board: { BoardAdapter: FreshBoardAdapter },
    } = await importFresh();
    expect(ADAPTER).toBe("board");
    expect(createGateway()).toBeInstanceOf(FreshBoardAdapter);
  });

  it("dev/test with no knobs boots the MockAdapter (fixtures, no backend)", async () => {
    vi.resetModules();
    vi.stubEnv("PROD", false);
    vi.stubEnv("VITE_ADAPTER", "");
    vi.stubEnv("VITE_MNEMOS_ADAPTER", "");
    const {
      config: { ADAPTER, createGateway },
      mock: { MockAdapter: FreshMockAdapter },
    } = await importFresh();
    expect(ADAPTER).toBe("mock");
    expect(createGateway()).toBeInstanceOf(FreshMockAdapter);
  });

  it("VITE_ADAPTER=mnemos still opts a production build into the mnemos mode", async () => {
    vi.resetModules();
    vi.stubEnv("PROD", true);
    vi.stubEnv("VITE_ADAPTER", "mnemos");
    const {
      config: { ADAPTER, createGateway },
      http: { HttpAdapter: FreshHttpAdapter },
    } = await importFresh();
    expect(ADAPTER).toBe("mnemos");
    expect(createGateway()).toBeInstanceOf(FreshHttpAdapter);
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

  it("builds the HttpAdapter when VITE_ADAPTER=mnemos is set explicitly", async () => {
    vi.resetModules();
    vi.stubEnv("PROD", true); // explicit knob beats the prod board default
    vi.stubEnv("VITE_ADAPTER", "mnemos");
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
