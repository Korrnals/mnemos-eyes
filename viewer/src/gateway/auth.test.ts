import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_STORAGE_KEY,
  AuthClient,
  clearToken,
  getToken,
  notifyUnauthorized,
  onUnauthorized,
  setToken,
} from "./auth";
import { ApiError } from "@/lib/errors";

/** Minimal localStorage stand-in (vitest node env has none). */
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

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function respondingAuthFetch(data: unknown, status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    jsonResponse(data, status),
  );
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  clearToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe("token provider", () => {
  it("stores and clears the token in memory", () => {
    expect(getToken()).toBeNull();
    setToken("tok-1");
    expect(getToken()).toBe("tok-1");
    clearToken();
    expect(getToken()).toBeNull();
  });

  it("mirrors the token into localStorage under the auth key", () => {
    setToken("tok-2");
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBe(JSON.stringify({ token: "tok-2" }));

    clearToken();
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it("survives a module reload (storage restore path)", async () => {
    setToken("tok-from-storage");
    vi.resetModules();
    const restored = await import("./auth");
    expect(restored.getToken()).toBe("tok-from-storage");
  });

  it("tolerates a missing/corrupted storage payload", async () => {
    localStorage.setItem(AUTH_STORAGE_KEY, "{not json");
    vi.resetModules();
    const restored = await import("./auth");
    expect(restored.getToken()).toBeNull();
  });
});

describe("unauthorized flag", () => {
  it("fans out to subscribers until unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = onUnauthorized(listener);

    notifyUnauthorized();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    notifyUnauthorized();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("AuthClient", () => {
  it("login: stores the session token when TOTP is not enrolled", async () => {
    const fetchMock = respondingAuthFetch({ token: "sess-1" });
    const client = new AuthClient({ fetchImpl: fetchMock as unknown as typeof fetch });

    const result = await client.login("mnk_abc");

    expect(result).toEqual({ mode: "authenticated", token: "sess-1" });
    expect(getToken()).toBe("sess-1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ token: "mnk_abc" });
  });

  it("login: returns a TOTP challenge without storing a token", async () => {
    const fetchMock = respondingAuthFetch({ challenge_id: "ch-9" });
    const client = new AuthClient({ fetchImpl: fetchMock as unknown as typeof fetch });

    const result = await client.login("mnk_abc");

    expect(result).toEqual({ mode: "challenge", challenge_id: "ch-9" });
    expect(getToken()).toBeNull();
  });

  it("login: rejects with ApiError on bad credentials and raises the flag", async () => {
    const fetchMock = respondingAuthFetch({ detail: "invalid token" }, 401);
    const client = new AuthClient({ fetchImpl: fetchMock as unknown as typeof fetch });
    const unauthorized = vi.fn();
    onUnauthorized(unauthorized);

    const error = await client.login("mnk_wrong").catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it("verify: exchanges challenge + code for a stored session token", async () => {
    const fetchMock = respondingAuthFetch({ session_token: "sess-2" });
    const client = new AuthClient({ fetchImpl: fetchMock as unknown as typeof fetch });

    const token = await client.verify("ch-9", "123456");

    expect(token).toBe("sess-2");
    expect(getToken()).toBe("sess-2");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/verify");
    expect(JSON.parse(init.body as string)).toEqual({ challenge_id: "ch-9", code: "123456" });
  });

  it("verify: rejects when the response carries no token", async () => {
    const fetchMock = respondingAuthFetch({});
    const client = new AuthClient({ fetchImpl: fetchMock as unknown as typeof fetch });
    await expect(client.verify("ch-9", "000000")).rejects.toMatchObject({ status: 0 });
  });

  it("logout: clears the local token even if the endpoint fails", async () => {
    setToken("sess-3");

    const okFetch = respondingAuthFetch({ ok: true });
    await new AuthClient({ fetchImpl: okFetch as unknown as typeof fetch }).logout();
    expect(getToken()).toBeNull();
    expect((okFetch.mock.calls[0] as [string])[0]).toBe("/api/auth/logout");

    setToken("sess-4");
    const failing = vi.fn(async () => {
      throw new TypeError("network gone");
    });
    const client = new AuthClient({ fetchImpl: failing as unknown as typeof fetch });
    await expect(client.logout()).rejects.toBeInstanceOf(ApiError);
    expect(getToken()).toBeNull();
  });

  it("me: sends the bearer token and returns the payload", async () => {
    setToken("sess-5");
    const fetchMock = respondingAuthFetch({ agent: "zed", totp_enrolled: true });
    const client = new AuthClient({ fetchImpl: fetchMock as unknown as typeof fetch });

    const me = await client.me();

    expect(me).toEqual({ agent: "zed", totp_enrolled: true });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sess-5");
  });

  it("me: a 401 both throws and fires the unauthorized flag", async () => {
    setToken("stale-token");
    const fetchMock = respondingAuthFetch({ detail: "session expired" }, 401);
    const client = new AuthClient({ fetchImpl: fetchMock as unknown as typeof fetch });
    const unauthorized = vi.fn();
    onUnauthorized(unauthorized);

    const error = await client.me().catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });
});
