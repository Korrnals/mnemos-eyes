/**
 * UI-class token storage (Ф3 token split, class `ui` — ADR 0011 Ф3).
 *
 * The board's legacy SPA keeps its board token in localStorage; this app
 * deliberately does NOT: the machine is shared, so the ui token lives in
 * sessionStorage — closing the tab drops it and no other tab inherits the
 * session. The key name mirrors the board's `vesmaro.boardToken` convention.
 *
 * Reads are fail-soft: environments without sessionStorage (SSR render
 * passes, hardened browsers) answer "no token", never throw.
 */
export const UI_TOKEN_STORAGE_KEY = "vesmaro.uiToken";

/**
 * Server verdict of the verify-at-the-door call (ADR 0014 Ф1,
 * `POST /api/auth/ui-token`). `tokenClass` is honest about legacy mode:
 * with no dedicated ui token the board token logs the owner in and the
 * server says `legacy` (the UI surfaces that as a note, not an error).
 */
export type UiTokenVerifyResult = {
  ok: boolean;
  tokenClass: "ui" | "legacy";
};

/** The stored ui token, or "" when absent/unavailable. */
export function getUiToken(): string {
  try {
    return sessionStorage.getItem(UI_TOKEN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

/** True when a non-empty ui token is stored. */
export function hasUiToken(): boolean {
  return getUiToken().length > 0;
}

/** Persist the token (trimmed; empty values clear it). */
export function setUiToken(value: string): void {
  const trimmed = value.trim();
  try {
    if (trimmed) sessionStorage.setItem(UI_TOKEN_STORAGE_KEY, trimmed);
    else sessionStorage.removeItem(UI_TOKEN_STORAGE_KEY);
  } catch {
    // Storage unavailable — the app stays read-only; mutations will surface
    // the token panel again on the next attempt.
  }
}

/** Drop the stored token (logout / server-side 401). */
export function clearUiToken(): void {
  try {
    sessionStorage.removeItem(UI_TOKEN_STORAGE_KEY);
  } catch {
    // Same fail-soft contract as getUiToken.
  }
}
