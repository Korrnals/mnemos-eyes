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
  /** «Войти»: store the token; the gate retries any queued action. */
  onSubmitToken: (value: string) => void;
  /** Esc / cross / «continue read-only»: drop any queued action, close. */
  onDismiss: () => void;
}

export function LoginDialog({
  open,
  reason,
  onSubmitToken,
  onDismiss,
}: LoginDialogProps) {
  const t = useT();
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);

  // The field resets through the callbacks (submit / dismiss), never through
  // an effect: a half-typed secret never survives the window either way.
  const dismiss = () => {
    onDismiss();
    setValue("");
    setReveal(false);
  };

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
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
        {/* Inline sign-in error: the server rejected the previous value
         * (401 on the retried action) — assertive, inside the window. */}
        {reason === "rejected" ? (
          <p role="alert" className="text-xs text-error">
            {t("login.rejected")}
          </p>
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
                aria-describedby="login-token-hint"
                className="h-9 min-w-0 flex-1 rounded-md border border-border bg-well px-2 font-mono text-sm text-foreground focus-visible:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
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
            <Button type="button" variant="outline" size="sm" onClick={dismiss}>
              {t("login.continueReadOnly")}
            </Button>
            <Button type="submit" size="sm" disabled={value.trim().length === 0}>
              {t("login.submit")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
