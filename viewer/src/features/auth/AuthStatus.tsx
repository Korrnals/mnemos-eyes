import { LogIn, LogOut } from "lucide-react";
import { StatusIndicator } from "@/components/StatusIndicator/StatusIndicator";
import type { HealthState } from "@/components/StatusIndicator/StatusIndicator";
import { deriveHealthStatus } from "@/components/StatusIndicator/deriveHealthStatus";
import { Button } from "@/components/ui/button";
import { useStatus } from "@/hooks/useStatus";
import { getToken } from "@/gateway/auth";
import { useAuth } from "./AuthContext";

/**
 * TopBar auth/connection slot (T6). Two pieces of state, one compact widget:
 *
 * - Connection: mock adapter → "local (mock)"; mnemos/board adapters →
 *   derived from the health query ("connected to <backend>: <endpoint>" /
 *   "offline").
 * - Session: "Sign in" (opens the AuthScreen overlay) or "Sign out"
 *   (invalidates the session server-side). The authenticated branch also
 *   reflects a token restored from localStorage so a reload renders the
 *   correct state immediately (the /auth/me confirmation follows async).
 *
 * Board adapter (Ф0): no session affordance renders at all — reads are open
 * and token-free (ADR 0011 §7), so the sign-in entry must not appear and
 * the auth screen can never be pulled in.
 */
export function AuthStatus() {
  const { state, adapterMode, endpoint, logout, openOverlay } = useAuth();
  const status = useStatus();

  const isBoard = adapterMode === "board";
  let connection: { state: HealthState; label: string };
  if (adapterMode === "mock") {
    connection = { state: "ok", label: "local (mock)" };
  } else {
    const health = deriveHealthStatus(status.data, status.isPending, status.isError);
    const backend = isBoard ? "board" : "mnemos";
    const LABEL: Record<HealthState, string> = {
      ok: `connected to ${backend}: ${endpoint}`,
      degraded: `${backend} degraded`,
      error: "offline",
      unknown: "connecting…",
    };
    connection = { state: health, label: LABEL[health] };
  }

  const authenticated = state.phase === "authenticated" || getToken() !== null;

  return (
    <div className="flex items-center gap-3">
      <StatusIndicator
        status={connection.state}
        label={connection.label}
        className="hidden text-sm text-foreground-secondary lg:inline-flex"
      />
      {isBoard ? null : authenticated ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void logout()}
          aria-label="Sign out of mnemos"
        >
          <LogOut className="size-4" aria-hidden="true" />
          Sign out
        </Button>
      ) : (
        <Button variant="outline" size="sm" onClick={openOverlay}>
          <LogIn className="size-4" aria-hidden="true" />
          Sign in
        </Button>
      )}
    </div>
  );
}
