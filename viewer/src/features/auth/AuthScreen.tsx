import { useEffect, useRef, useState } from "react";
import { KeyRound, LogIn, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "./AuthContext";

/**
 * Full-screen sign-in overlay (T6). Shown when the user explicitly signs in
 * from the TopBar or when any gateway response comes back 401; underneath it
 * the read-only app stays mounted — on a permissive (loopback) deployment the
 * overlay can be dismissed and browsing continues without a session.
 *
 * Flow: paste the `mnk_` token → submit. If mnemos answers phase 1 with a
 * TOTP challenge, the one-time-code field appears (wire: `challenge_id` from
 * `POST /auth/login`, verified via `POST /auth/verify {challenge_id, code}`).
 *
 * A11y: `role="dialog"` + `aria-modal`, labelled by the heading, focus moved
 * to the first field on open, Tab cycled inside the surface, Escape and
 * backdrop click dismiss (overlay only — never forced).
 */
export function AuthScreen() {
  const { state, login, verify, closeOverlay } = useAuth();
  const [token, setToken] = useState("");
  const [code, setCode] = useState("");
  const [revealToken, setRevealToken] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);

  const inChallenge = state.phase === "challenge";
  const busy = state.phase === "authenticating";

  // Focus the first interactive field whenever the form (re)appears, and
  // return focus to the invoking control when the overlay closes (WCAG
  // 2.4.3 — the user resumes where they opened the dialog).
  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    surfaceRef.current
      ?.querySelector<HTMLElement>("[data-autofocus]")
      ?.focus();
    return () => previouslyFocused?.focus();
  }, [inChallenge]);

  // Minimal focus trap: cycle Tab within the overlay surface.
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeOverlay();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = surfaceRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (inChallenge) {
      if (code.trim().length > 0) void verify(code.trim());
    } else if (token.trim().length > 0) {
      void login(token.trim());
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/80 p-4"
      onClick={closeOverlay}
      data-testid="auth-overlay"
    >
      <div
        ref={surfaceRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-title"
        aria-describedby={state.error ? "auth-error" : "auth-description"}
        className="w-full max-w-md rounded-lg border border-border-subtle bg-well p-6 shadow-modal"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="mb-1 flex items-center gap-2 text-iris">
          {inChallenge ? (
            <ShieldCheck className="size-5" aria-hidden="true" />
          ) : (
            <KeyRound className="size-5" aria-hidden="true" />
          )}
          <h1 id="auth-title" className="text-lg font-semibold text-foreground">
            {inChallenge ? "Two-factor verification" : "Sign in to mnemos"}
          </h1>
        </div>
        <p
          id="auth-description"
          className="mb-4 text-sm text-foreground-secondary"
        >
          {inChallenge
            ? "Enter the 6-digit code from your authenticator app."
            : "Paste your mnk_ access token. It stays in this browser and is sent only to your mnemos instance."}
        </p>

        {state.sessionExpired && !state.error && (
          <p role="alert" className="mb-3 text-sm text-warning">
            Your session expired — sign in again to continue.
          </p>
        )}
        {state.error && (
          <p
            id="auth-error"
            role="alert"
            className="mb-3 break-words text-sm text-error"
          >
            {state.error}
          </p>
        )}

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {inChallenge ? (
            <div className="space-y-1.5">
              <label htmlFor="auth-code" className="text-sm font-medium">
                One-time code
              </label>
              <Input
                id="auth-code"
                data-autofocus
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                disabled={busy}
                className="font-mono tracking-widest"
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <label htmlFor="auth-token" className="text-sm font-medium">
                Access token
              </label>
              <div className="flex gap-2">
                <Input
                  id="auth-token"
                  data-autofocus
                  name="token"
                  type={revealToken ? "text" : "password"}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder="mnk_…"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  disabled={busy}
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0"
                  onClick={() => setRevealToken((value) => !value)}
                  aria-pressed={revealToken}
                >
                  {revealToken ? "Hide" : "Show"}
                </Button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between gap-3 pt-1">
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={closeOverlay}
              className="px-0"
            >
              Continue in read-only mode
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={
                busy ||
                (inChallenge ? code.trim().length === 0 : token.trim().length === 0)
              }
            >
              <LogIn className="size-4" aria-hidden="true" />
              {busy ? "Signing in…" : inChallenge ? "Verify" : "Sign in"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
