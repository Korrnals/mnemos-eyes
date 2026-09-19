import { ApiError } from "@/lib/errors";
import { DEFAULT_TIMEOUT_MS, requestJson } from "./http";
import type { RequestConfig } from "./http";

/**
 * Auth skeleton for the mnemos wire contract (task T2 — full UI flow is T6).
 *
 * Wire endpoints (openapi-snapshot.json):
 * - `POST /auth/login`   body `{ token }` — an `mnk_` bearer token. TOTP-less
 *   deployments answer with a session token immediately; TOTP-enrolled ones
 *   answer with a `challenge_id` for the second phase.
 * - `POST /auth/verify`  body `{ challenge_id, code }` — issues the session token.
 * - `POST /auth/logout`  invalidates the session server-side.
 * - `GET  /auth/me`      metadata about the current session/token.
 *
 * Note: mnemos authenticates with a bearer token, not username/password —
 * `login()` therefore takes the token, per the wire contract.
 */

/** Storage key mirroring the in-memory token across reloads (local mode). */
export const AUTH_STORAGE_KEY = "mnemos-eyes:auth";

/**
 * Where the token mirror lives (ADR 0011 §7 audit point Ф0):
 * - "local"    localStorage — survives reloads (mnemos dev default);
 * - "session"  sessionStorage — dropped when the tab closes (opt-in hardening
 *              against `mnk_` lingering in persistent browser storage).
 * Selected via `VITE_AUTH_STORAGE=session`; memory always stays correct.
 */
export type AuthStorageMode = "local" | "session";

export const AUTH_STORAGE_MODE: AuthStorageMode = resolveStorageMode(
  import.meta.env.VITE_AUTH_STORAGE,
);

/** Pure env resolver (testable): anything but "session" means "local". */
export function resolveStorageMode(value: string | undefined): AuthStorageMode {
  return value === "session" ? "session" : "local";
}

interface StoredAuth {
  token: string;
}

function storageFor(mode: AuthStorageMode): Storage | null {
  try {
    return mode === "session" ? globalThis.sessionStorage : globalThis.localStorage;
  } catch {
    return null; // unavailable (tests, private mode) — memory only
  }
}

function readStoredToken(): string | null {
  try {
    const raw = storageFor(AUTH_STORAGE_MODE)?.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredAuth>;
    return typeof parsed.token === "string" && parsed.token.length > 0
      ? parsed.token
      : null;
  } catch {
    return null;
  }
}

function persistToken(token: string | null): void {
  try {
    const storage = storageFor(AUTH_STORAGE_MODE);
    if (!storage) return; // unavailable (tests, private mode) — memory only
    if (token) {
      storage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token } satisfies StoredAuth));
    } else {
      // Clear every mirror we may own so switching modes never leaves a
      // stale `mnk_`-shaped entry behind in the other storage.
      for (const candidate of [globalThis.localStorage, globalThis.sessionStorage]) {
        candidate?.removeItem(AUTH_STORAGE_KEY);
      }
    }
  } catch {
    // Quota/security errors must never break the app — memory stays correct.
  }
}

// --- Token provider ---------------------------------------------------------

let memoryToken: string | null = readStoredToken();

/** Current access token (memory first, restored from storage at import). */
export function getToken(): string | null {
  return memoryToken;
}

/** Store a token (memory + storage mirror per `AUTH_STORAGE_MODE`). */
export function setToken(token: string): void {
  memoryToken = token;
  persistToken(token);
}

/** Drop the token from memory and storage. */
export function clearToken(): void {
  memoryToken = null;
  persistToken(null);
}

// --- 401 flag / event fan-out ------------------------------------------------

type UnauthorizedListener = () => void;

const unauthorizedListeners = new Set<UnauthorizedListener>();

/**
 * Subscribe to session-loss notifications. The adapter (and AuthClient) fire
 * this on any 401; T6 will use it to route to the login screen. Returns an
 * unsubscribe function.
 */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

/** Raise the unauthorized flag (idempotent fan-out to all listeners). */
export function notifyUnauthorized(): void {
  for (const listener of [...unauthorizedListeners]) listener();
}

// --- Wire result types -------------------------------------------------------

export interface LoginChallenge {
  mode: "challenge";
  challenge_id: string;
}

export interface LoginSuccess {
  mode: "authenticated";
  token: string;
}

export type LoginResult = LoginChallenge | LoginSuccess;

/** `GET /auth/me` payload — free-form metadata on the wire. */
export type AuthMeInfo = Record<string, unknown>;

export interface AuthClientOptions {
  /** Same default as HttpAdapter: "/api" (Vite dev-proxy / reverse proxy). */
  baseUrl?: string;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Thin client over the mnemos auth endpoints (login/verify/logout/me). */
export class AuthClient {
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AuthClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "/api";
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Phase 1: present the `mnk_` bearer token. Either authenticates
   * immediately (token stored) or returns a TOTP challenge.
   */
  async login(token: string): Promise<LoginResult> {
    const body = await this.request<Record<string, unknown>>("/auth/login", {
      method: "POST",
      body: { token },
    });
    const challengeId = body.challenge_id;
    if (typeof challengeId === "string" && challengeId.length > 0) {
      return { mode: "challenge", challenge_id: challengeId };
    }
    const sessionToken = extractToken(body);
    if (sessionToken) {
      setToken(sessionToken);
      return { mode: "authenticated", token: sessionToken };
    }
    throw new ApiError(
      0,
      "/auth/login response carried neither challenge_id nor token",
    );
  }

  /** Phase 2: exchange challenge + TOTP code for a session token (stored). */
  async verify(challengeId: string, code: string): Promise<string> {
    const body = await this.request<Record<string, unknown>>("/auth/verify", {
      method: "POST",
      body: { challenge_id: challengeId, code },
    });
    const sessionToken = extractToken(body);
    if (!sessionToken) {
      throw new ApiError(0, "/auth/verify response did not carry a session token");
    }
    setToken(sessionToken);
    return sessionToken;
  }

  /** Invalidate the session server-side; local token always cleared. */
  async logout(): Promise<void> {
    try {
      await this.request<Record<string, unknown>>("/auth/logout", { method: "POST" });
    } finally {
      clearToken();
    }
  }

  /** Metadata about the currently authenticated session and token. */
  async me(): Promise<AuthMeInfo> {
    return this.request<AuthMeInfo>("/auth/me", { method: "GET" });
  }

  private request<T>(path: string, config: RequestConfig): Promise<T> {
    return requestJson<T>(
      {
        baseUrl: this.baseUrl,
        fetchImpl: this.fetchImpl,
        getToken,
        onUnauthorized: notifyUnauthorized,
        defaultTimeoutMs: this.timeoutMs,
      },
      path,
      config,
    );
  }
}

/**
 * Pull the session token out of an anonymous auth response object.
 * Field names observed across mnemos deployments: `session` (live 4.1.0:
 * `{ session, expires_at }`), plus the generic `token` / `access_token` /
 * `session_token` spellings.
 */
function extractToken(body: Record<string, unknown>): string | null {
  for (const key of ["session", "token", "access_token", "session_token"]) {
    const value = body[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}
