import { LogIn, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { useUiToken } from "./UiTokenContext";

/**
 * TopBar ui-token slot (board mode only, Ф3 fix/login-window). A real
 * sign-in pair replacing the old sign-out-only chip: an ACCENT «Войти»
 * whenever no ui token is stored (opens the login window — mutations then
 * run without prompts) and «Выйти» while one is (scrubs the shared machine
 * with one click). Both flip reactively off the gate state — no reload.
 * Mounted by AuthStatus ONLY in board mode, so the useUiToken hook never
 * runs in trees without the provider (mnemos/mock harnesses).
 */
export function UiTokenSlot() {
  const { tokenPresent, openLogin, logout } = useUiToken();
  const t = useT();
  if (tokenPresent) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={logout}
        aria-label={t("login.signOutAria")}
      >
        <LogOut className="size-4" aria-hidden="true" />
        {t("login.signOut")}
      </Button>
    );
  }
  // Accent sign-in — the entry must be findable, not a hidden affordance.
  return (
    <Button variant="default" size="sm" onClick={openLogin}>
      <LogIn className="size-4" aria-hidden="true" />
      {t("login.signIn")}
    </Button>
  );
}
