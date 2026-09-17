import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthClient, clearToken, getToken } from "./auth";
import { ApiError } from "@/lib/errors";

/**
 * T6 auth flow against an in-test "mock mnemos server": a stateful fetch
 * implementation that routes /auth/* like the live wire contract
 * (openapi-snapshot.json) — phase 1 `POST /auth/login {token}` answers either
 * with `{ session, expires_at }` (TOTP-less) or `{ challenge_id }`
 * (TOTP-enrolled), phase 2 `POST /auth/verify {challenge_id, code}` issues the
 * session, `GET /auth/me` requires the *session* bearer, `POST /auth/logout`
 * invalidates it.
 */

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

interface MockMnemosOptions {
  /** When true, phase 1 answers with a TOTP challenge. */
  totpEnrolled: boolean;
  /** The only TOTP code the server accepts. */
  validCode: string;
}

function mockMnemosServer({ totpEnrolled, validCode }: MockMnemosOptions) {
  const state = {
    challenges: new Map<string, string>(), // challenge_id -> presented token
    sessions: new Set<string>(),
    calls: [] as { url: string; method: string; authorized: boolean }[],
  };

  async function serve(url: string, init?: RequestInit): Promise<Response> {
    const parsed = new URL(url, "http://mock.local");
    const path = parsed.pathname;
    const method = init?.method ?? "GET";
    const auth = init?.headers as Record<string, string> | undefined;
    const bearer = auth?.Authorization?.replace(/^Bearer\s+/i, "") ?? null;
    state.calls.push({ url: path, method, authorized: bearer !== null });
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};

    if (method === "POST" && path === "/api/auth/login") {
      const token = typeof body.token === "string" ? body.token : "";
      if (!token.startsWith("mnk_")) {
        return Response.json({ detail: "Invalid token format" }, { status: 401 });
      }
      if (!totpEnrolled) {
        state.sessions.add(token);
        return Response.json({ session: `sess-${token}`, expires_at: "2026-12-31T00:00:00Z" });
      }
      const challengeId = `ch-${state.challenges.size + 1}`;
      state.challenges.set(challengeId, token);
      return Response.json({ challenge_id: challengeId });
    }

    if (method === "POST" && path === "/api/auth/verify") {
      const challengeId = String(body.challenge_id ?? "");
      const code = String(body.code ?? "");
      const token = state.challenges.get(challengeId);
      if (!token) return Response.json({ detail: "Unknown challenge" }, { status: 404 });
      if (code !== validCode) return Response.json({ detail: "Bad code" }, { status: 401 });
      state.challenges.delete(challengeId);
      state.sessions.add(token);
      return Response.json({ session: `sess-${token}`, expires_at: "2026-12-31T00:00:00Z" });
    }

    if (method === "POST" && path === "/api/auth/logout") {
      if (bearer) state.sessions.delete(bearer);
      return Response.json({ ok: true });
    }

    if (method === "GET" && path === "/api/auth/me") {
      if (!bearer || !state.sessions.has(bearer)) {
        return Response.json({ detail: "Session not found" }, { status: 401 });
      }
      return Response.json({
        token_id: "tok-1",
        expires_at: "2026-12-31T00:00:00Z",
        totp: totpEnrolled,
        totp_required: totpEnrolled,
      });
    }

    return Response.json({ detail: "Not found" }, { status: 404 });
  }

  return { state, fetchImpl: serve as unknown as typeof fetch };
}

describe("AuthClient flow on a mock mnemos server", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    clearToken();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearToken();
  });

  it("TOTP-less deployment: login → me → logout, live `{session}` shape", async () => {
    const server = mockMnemosServer({ totpEnrolled: false, validCode: "" });
    const client = new AuthClient({ fetchImpl: server.fetchImpl });

    const result = await client.login("mnk_dev");
    expect(result).toEqual({ mode: "authenticated", token: "sess-mnk_dev" });
    expect(getToken()).toBe("sess-mnk_dev");

    // /auth/me works with the session issued by login (not the raw mnk_ token).
    const me = await client.me();
    expect(me).toMatchObject({ token_id: "tok-1", totp: false });

    // The login POST carried the mnk_ token in the JSON body.
    const loginCall = server.state.calls.find((c) => c.url === "/api/auth/login");
    expect(loginCall).toBeDefined();

    await client.logout();
    expect(getToken()).toBeNull();
    // The invalidated session no longer authenticates /auth/me.
    await expect(client.me()).rejects.toMatchObject<Partial<ApiError>>({ status: 401 });
  });

  it("TOTP-enrolled deployment: login → challenge → verify → me → logout", async () => {
    const server = mockMnemosServer({ totpEnrolled: true, validCode: "123456" });
    const client = new AuthClient({ fetchImpl: server.fetchImpl });

    const first = await client.login("mnk_totp");
    expect(first).toEqual({ mode: "challenge", challenge_id: "ch-1" });
    expect(getToken()).toBeNull(); // nothing stored before phase 2

    // A wrong code fails without storing a session.
    await expect(client.verify("ch-1", "000000")).rejects.toMatchObject({
      status: 401,
    });

    // The same challenge survives a bad attempt on this mock; complete it.
    const token = await client.verify("ch-1", "123456");
    expect(token).toBe("sess-mnk_totp");
    expect(getToken()).toBe("sess-mnk_totp");

    const me = await client.me();
    expect(me).toMatchObject({ totp: true });

    await client.logout();
    expect(getToken()).toBeNull();
    await expect(client.me()).rejects.toMatchObject<Partial<ApiError>>({ status: 401 });
  });

  it("rejects a malformed mnk_ token with the server's detail message", async () => {
    const server = mockMnemosServer({ totpEnrolled: false, validCode: "" });
    const client = new AuthClient({ fetchImpl: server.fetchImpl });

    const error = await client.login("not-a-token").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).message).toBe("Invalid token format");
    expect(getToken()).toBeNull();
  });
});
