import { createContext, useContext } from "react";

/**
 * DI context for the Ф3 ui-token gate (token class `ui`, ADR 0011 Ф3 split).
 * The provider owns the login window (one dialog for the whole app), the
 * stored-token presence flag and the queued-retry semantics:
 *
 * - `runAuthorized(run)` executes a mutation callback when a ui token is
 *   stored; without one it opens the login window with `run` queued — after
 *   a successful login the queued run executes (the board's retry pattern).
 * - A 401 mid-flight clears the stale token and re-opens the window
 *   (`rejected` reason, inline error) with the same run queued for retry.
 * - `openLogin()` opens the window directly (TopBar «Войти», no run queued).
 * - Dismissing the window (Esc / cross) drops the queued run — read-only
 *   browsing always stays available underneath.
 */
export interface UiTokenContextValue {
  /** True while a ui token sits in sessionStorage (drives the TopBar slot). */
  tokenPresent: boolean;
  /** Open the login window (TopBar «Войти»; no action queued). */
  openLogin: () => void;
  /**
   * Run a mutation callback under the token gate. The callback owns its own
   * success handling and non-401 failure handling; it MUST rethrow ApiError
   * 401 so the gate can take over (drop token → window → retry after login).
   * `onDeferred` fires when the gate QUEUES the run instead of executing it
   * (no token / rejected token) — callers driving spinners reset there.
   */
  runAuthorized: (run: () => Promise<void>, onDeferred?: () => void) => void;
  /** Drop the stored token and flip to read-only (TopBar logout, board mode). */
  logout: () => void;
}

export const UiTokenContext = createContext<UiTokenContextValue | null>(null);

/** Access the ui-token context. Throws when used outside the provider. */
export function useUiToken(): UiTokenContextValue {
  const value = useContext(UiTokenContext);
  if (!value) {
    throw new Error(
      "useUiToken: no ui-token context — wrap the tree in <UiTokenProvider> (see src/App.tsx).",
    );
  }
  return value;
}
