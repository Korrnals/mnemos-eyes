import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardAdapter } from "./BoardAdapter";
import { clearUiToken } from "./uiToken";

/**
 * ADR 0014 owner-session wire of the BoardAdapter: verify at the door
 * (POST /api/auth/ui-token), the boot/401 probe of the `vesmaro_ui`
 * cookie (GET → 204 is the ONLY live answer) and the server-side logout
 * (DELETE). hasUiToken() = stored token OR live cookie — one login per
 * browser, no per-tab re-prompt.
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Adapter with a fetch stub keyed on (path-suffix, method). */
function adapterWith(
  respond: (path: string, method: string) => Response | Promise<Response>,
): { adapter: BoardAdapter; calls: { path: string; method: string; body?: unknown }[] } {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+\/api/, "").replace(/^\/api/, "");
    const method = init?.method ?? "GET";
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ path, method, body });
    return respond(path, method);
  });
  return { adapter: new BoardAdapter({ baseUrl: "/api", fetchImpl: fetchImpl as never }), calls };
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", new MemoryStorage());
  clearUiToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BoardAdapter owner session (ADR 0014)", () => {
  it("verifyUiToken POSTs the token and normalizes the ui verdict", async () => {
    const { adapter, calls } = adapterWith((path, method) => {
      expect(path).toBe("/auth/ui-token");
      expect(method).toBe("POST");
      return jsonResponse({ ok: true, token_class: "ui" });
    });
    const result = await adapter.verifyUiToken("pasted-value");
    expect(result).toEqual({ ok: true, tokenClass: "ui" });
    expect(calls[0]?.body).toEqual({ token: "pasted-value" });
  });

  it("verifyUiToken surfaces the legacy verdict verbatim", async () => {
    const { adapter } = adapterWith(() => jsonResponse({ ok: true, token_class: "legacy" }));
    const result = await adapter.verifyUiToken("the-board-token");
    expect(result).toEqual({ ok: true, tokenClass: "legacy" });
  });

  it("verifyUiToken throws ApiError with the class-aware detail on 401", async () => {
    const { adapter } = adapterWith(() =>
      jsonResponse(
        { detail: "the pasted token is a machine-class token (VESMARO_BOARD_TOKEN) — this login requires VESMARO_UI_TOKEN" },
        401,
      ),
    );
    await expect(adapter.verifyUiToken("board-token")).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining("machine-class token"),
    });
  });

  it("probeUiSession: 204 is the ONLY live answer; 401/200-JSON/network error are not", async () => {
    const live = adapterWith(() => new Response(null, { status: 204 }));
    expect(await live.adapter.probeUiSession()).toBe(true);
    expect(live.calls[0]).toEqual({ path: "/auth/ui-token", method: "GET" });

    const rejected = adapterWith(() => jsonResponse({ detail: "no session" }, 401));
    expect(await rejected.adapter.probeUiSession()).toBe(false);

    // A proxied 200-with-JSON must NOT read as a session (strict status).
    const fakeOk = adapterWith(() => jsonResponse({ detail: "not a probe" }));
    expect(await fakeOk.adapter.probeUiSession()).toBe(false);

    const down = adapterWith(() => {
      throw new TypeError("network down");
    });
    expect(await down.adapter.probeUiSession()).toBe(false);
  });

  it("hasUiToken answers true on a live cookie with NOTHING stored (one login per browser)", async () => {
    const { adapter } = adapterWith(() => new Response(null, { status: 204 }));
    expect(adapter.hasUiToken()).toBe(false);
    await adapter.probeUiSession();
    expect(adapter.hasUiToken()).toBe(true);
  });

  it("logoutUiToken DELETEs, resolves on 204 and clears the live-cookie flag", async () => {
    const { adapter, calls } = adapterWith(() => new Response(null, { status: 204 }));
    await adapter.probeUiSession();
    expect(adapter.hasUiToken()).toBe(true);
    await adapter.logoutUiToken();
    expect(calls.some((c) => c.path === "/auth/ui-token" && c.method === "DELETE")).toBe(true);
    expect(adapter.hasUiToken()).toBe(false);
  });

  it("logoutUiToken propagates failures (the provider aborts the local scrub)", async () => {
    const { adapter } = adapterWith((_path, method) => {
      if (method === "DELETE") throw new TypeError("network down");
      return new Response(null, { status: 204 });
    });
    await expect(adapter.logoutUiToken()).rejects.toBeTruthy();
  });
});
