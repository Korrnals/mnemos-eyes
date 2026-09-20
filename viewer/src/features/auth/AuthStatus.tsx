import { LogIn, LogOut } from "lucide-react";
import { StatusIndicator } from "@/components/StatusIndicator/StatusIndicator";
import type { HealthState } from "@/components/StatusIndicator/StatusIndicator";
import { deriveHealthStatus } from "@/components/StatusIndicator/deriveHealthStatus";
import { Button } from "@/components/ui/button";
import { useStatus } from "@/hooks/useStatus";
import { getToken } from "@/gateway/auth";
import { useT, type TranslationKey } from "@/i18n";
import { useAuth } from "./AuthContext";
import { UiTokenStatus } from "@/features/ui-token/UiTokenStatus";

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
 * Board adapter (Ф0): reads are open and token-free (ADR 0011 §7) — the
 * mnemos sign-in entry must not appear. Ф3 adds exactly one affordance:
 * the ui-token sign-out (UiTokenStatus), rendered while a ui token is
 * stored so a shared machine can be scrubbed with one click.
 */
export function AuthStatus() {
  const { state, adapterMode, endpoint, logout, openOverlay } = useAuth();
  const t = useT();
  const status = useStatus();

  const isBoard = adapterMode === "board";
  let connection: { state: HealthState; label: string };
  if (adapterMode === "mock") {
    connection = { state: "ok", label: t("auth.localMock") };
  } else {
    const health = deriveHealthStatus(status.data, status.isPending, status.isError);
    const backend = isBoard ? "board" : "mnemos";
    const LABEL: Record<HealthState, TranslationKey> = {
      ok: "auth.connected",
      degraded: "auth.degraded",
      error: "auth.offline",
      unknown: "auth.connecting",
    };
    connection = { state: health, label: t(LABEL[health], { backend, endpoint }) };
  }

  const authenticated = state.phase === "authenticated" || getToken() !== null;

  return (
    <div className="flex items-center gap-3">
      <StatusIndicator
        status={connection.state}
        label={connection.label}
        className="hidden text-sm text-foreground-secondary lg:inline-flex"
      />
      {isBoard ? (
        <UiTokenStatus />
      ) : authenticated ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void logout()}
          aria-label={t("auth.signOutAria")}
        >
          <LogOut className="size-4" aria-hidden="true" />
          {t("auth.signOut")}
        </Button>
      ) : (
        <Button variant="outline" size="sm" onClick={openOverlay}>
          <LogIn className="size-4" aria-hidden="true" />
          {t("auth.signIn")}
        </Button>
      )}
    </div>
  );
}
