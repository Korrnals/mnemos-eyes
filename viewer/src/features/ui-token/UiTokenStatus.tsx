import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { useUiToken } from "./UiTokenContext";

/**
 * TopBar ui-token slot (board mode only, Ф3). Renders ONLY when a ui token
 * is stored: without one the app is a plain read-only viewer and there is
 * nothing to sign out of (the token panel opens on the first mutation
 * attempt — functionality is never hidden, just not yet armed). Mounted by
 * AuthStatus; safe outside any provider tree that never enters board mode.
 */
export function UiTokenStatus() {
  const { tokenPresent, logout } = useUiToken();
  const t = useT();
  if (!tokenPresent) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={logout}
      aria-label={t("uiToken.signOutAria")}
    >
      <LogOut className="size-4" aria-hidden="true" />
      {t("uiToken.signOut")}
    </Button>
  );
}
