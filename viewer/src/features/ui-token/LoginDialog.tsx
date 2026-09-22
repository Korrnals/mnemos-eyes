import { useState } from "react";
import { Eye, EyeOff, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/i18n";
import type { UiTokenWindowReason } from "./uiTokenGate";

/**
 * The ONE login window of the app (Ф3, fix/login-window redesign). Replaces
 * the old "token panel" surface: a plain sign-in dialog the user opens from
 * the TopBar («Войти») or that opens itself when a mutation needs a ui
 * token — same window either way, the contextual line is the only
 * difference. Read-only pages stay mounted and browsable underneath.
 *
 * A11y: Radix Dialog (Esc, cross, focus trap, aria-modal free), the value is
 * masked behind type=password with an explicit reveal toggle, the submit is
 * a native form (Enter works), focus lands in the token field on open, and
 * the server-rejected case surfaces as an inline `role="alert"` line —
 * never a toast, never a page reload.
 */
export interface LoginDialogProps {
  /** Window visibility (gate state). */
  open: boolean;
  /** Why the window is up — drives the contextual line / inline error. */
  reason: UiTokenWindowReason;
  /** Server verify in flight (ADR 0014 Ф1) — submit + field disabled. */
  verifyPending?: boolean;
  /** Which refusal beat applies: "verify" = refused at the door (the
   * value/class was wrong), "session" = the mid-flight «сессия истекла»
   * (a stored token rotted or the session idled out). */
  rejectKind?: "verify" | "session";
  /** «Войти»: verify against the server; the gate retries any queued
   * action after a 200. */
  onSubmitToken: (value: string) => void;
  /** Esc / cross / «continue read-only»: drop any queued action, close. */
  onDismiss: () => void;
  /** Server-provided detail for the rejected case (optional). */
  rejectDetail?: string;
}

export function LoginDialog({
  open,
  reason,
  verifyPending = false,
  rejectKind,
  onSubmitToken,
  onDismiss,
  rejectDetail,
}: LoginDialogProps) {
  const t = useT();
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);

  // The field resets through the callbacks (submit / dismiss), never through
  // an effect: a half-typed secret never survives the window either way.
  const dismiss = () => {
    if (verifyPending) return; // a verify in flight owns the window
    onDismiss();
    setValue("");
    setReveal(false);
  };

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || verifyPending) return;
    onSubmitToken(trimmed);
    setValue("");
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <DialogContent data-testid="login-dialog">
        <DialogHeader>
          <div className="flex items-center gap-2 text-iris">
            <LogIn className="size-5" aria-hidden="true" />
            <DialogTitle>{t("login.title")}</DialogTitle>
          </div>
          <DialogDescription>{t("login.description")}</DialogDescription>
        </DialogHeader>

        {/* The mutation-driven context: the SAME window, plus this line so
         * the user knows their action will not be lost. */}
        {reason !== "manual" ? (
          <p className="rounded-md bg-elevated p-2 text-xs text-foreground-secondary">
            {t("login.continueQueued")}
          </p>
        ) : null}
        {/* Inline sign-in error — two distinct beats (ADR 0014): refused
         * AT THE DOOR (wrong value or a machine-class token) vs the
         * mid-flight «сессия истекла». Assertive, inside the window. */}
        {reason === "rejected" ? (
          <>
            <p role="alert" className="text-xs text-error">
              {t(rejectKind === "session" ? "login.sessionExpired" : "login.rejected")}
            </p>
            {rejectDetail ? (
              <p className="text-xs text-foreground-secondary">{rejectDetail}</p>
            ) : null}
          </>
        ) : null}

        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1">
            <label htmlFor="login-token-value" className="text-xs text-foreground-secondary">
              {t("login.fieldLabel")}
            </label>
            <div className="flex items-center gap-1">
              <input
                id="login-token-value"
                // Masked by default — the value is a secret; the reveal
                // toggle is the explicit, user-driven exception.
                type={reveal ? "text" : "password"}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                autoFocus
                disabled={verifyPending}
                aria-describedby="login-token-hint"
                className="h-9 min-w-0 flex-1 rounded-md border border-border bg-well px-2 font-mono text-sm text-foreground focus-visible:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright disabled:opacity-60"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={verifyPending}
                onClick={() => setReveal((current) => !current)}
                aria-label={t(reveal ? "login.hideValue" : "login.showValue")}
                aria-pressed={reveal}
              >
                {reveal ? (
                  <EyeOff className="size-4" aria-hidden="true" />
                ) : (
                  <Eye className="size-4" aria-hidden="true" />
                )}
              </Button>
            </div>
          </div>

          <p
            id="login-token-hint"
            className="whitespace-pre-line rounded-md bg-elevated p-2 text-xs text-foreground-muted"
          >
            {t("login.hint")}
          </p>

          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={dismiss} disabled={verifyPending}>
              {t("login.continueReadOnly")}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={verifyPending || value.trim().length === 0}
            >
              {verifyPending ? t("login.verifying") : t("login.submit")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
