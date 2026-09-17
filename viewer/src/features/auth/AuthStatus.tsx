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
 * - Connection: mock adapter → "local (mock)"; live adapter → derived from
 *   the health query ("connected to mnemos: <endpoint>" / "offline").
 * - Session: "Sign in" (opens the AuthScreen overlay) or "Sign out"
 *   (invalidates the session server-side). The authenticated branch also
 *   reflects a token restored from localStorage so a reload renders the
 *   correct state immediately (the /auth/me confirmation follows async).
 */
export function AuthStatus() {
  const { state, adapterMode, endpoint, logout, openOverlay } = useAuth();
  const status = useStatus();

  let connection: { state: HealthState; label: string };
  if (adapterMode === "mock") {
    connection = { state: "ok", label: "local (mock)" };
  } else {
    const health = deriveHealthStatus(status.data, status.isPending, status.isError);
    const LABEL: Record<HealthState, string> = {
      ok: `connected to mnemos: ${endpoint}`,
      degraded: "mnemos degraded",
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
      {authenticated ? (
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
