import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isTaskMutationSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import { useT } from "@/i18n";
import { UiTokenContext } from "./UiTokenContext";
import { UiTokenGate } from "./uiTokenGate";

/**
 * React wrapper around the UiTokenGate state machine (see uiTokenGate.ts —
 * the whole flow is unit-tested there, provider-free). Renders the ONE token
 * panel of the app: Radix dialog (Esc + focus cycling free), the value
 * masked behind type=password with an explicit reveal toggle, and the
 * where-to-get-it hint as TEXT (kubectl secret name — never value examples).
 * Read-only pages stay mounted and browsable underneath the whole time.
 */
export function UiTokenProvider({ children }: { children: React.ReactNode }) {
  const t = useT();
  const gateway = useGateway();
  // Adapter-owned token policy: BoardAdapter reads sessionStorage, the mock
  // answers true (no auth wall in the dev playground).
  const gate = useMemo(
    () =>
      new UiTokenGate({
        hasToken: () => (isTaskMutationSource(gateway) ? gateway.hasUiToken() : false),
      }),
    [gateway],
  );
  const state = useSyncExternalStore(
    gate.subscribe.bind(gate),
    gate.getState.bind(gate),
    // SSR snapshot: the same pure read (renderToString harnesses need it).
    gate.getState.bind(gate),
  );
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);

  const runAuthorized = useCallback(
    (run: () => Promise<void>, onDeferred?: () => void) => {
      gate.runAuthorized(run, onDeferred);
    },
    [gate],
  );
  const logout = useCallback(() => gate.logout(), [gate]);
  const closePanel = useCallback(() => {
    gate.dismiss();
    setValue("");
  }, [gate]);
  const submit = useCallback(() => {
    gate.submitToken(value);
    setValue("");
  }, [gate, value]);

  return (
    <UiTokenContext.Provider
      value={{ tokenPresent: state.tokenPresent, runAuthorized, logout }}
    >
      {children}
      <Dialog
        open={state.open}
        onOpenChange={(next) => {
          if (!next) closePanel();
        }}
      >
        <DialogContent data-testid="ui-token-panel">
          <DialogHeader>
            <div className="flex items-center gap-2 text-iris">
              <KeyRound className="size-5" aria-hidden="true" />
              <DialogTitle>{t("uiToken.title")}</DialogTitle>
            </div>
            <DialogDescription>
              {state.reason === "rejected"
                ? t("uiToken.rejectedDescription")
                : t("uiToken.description")}
            </DialogDescription>
          </DialogHeader>

          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="flex flex-col gap-1">
              <label
                htmlFor="ui-token-value"
                className="text-xs text-foreground-secondary"
              >
                {t("uiToken.fieldLabel")}
              </label>
              <div className="flex items-center gap-1">
                <input
                  id="ui-token-value"
                  // Masked by default — the value is a secret; the reveal
                  // toggle is the explicit, user-driven exception.
                  type={reveal ? "text" : "password"}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby="ui-token-hint"
                  className="h-9 min-w-0 flex-1 rounded-md border border-border bg-well px-2 font-mono text-sm text-foreground focus-visible:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setReveal((current) => !current)}
                  aria-label={t(reveal ? "uiToken.hideValue" : "uiToken.showValue")}
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
              id="ui-token-hint"
              className="whitespace-pre-line rounded-md bg-elevated p-2 text-xs text-foreground-muted"
            >
              {t("uiToken.hint")}
            </p>

            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={closePanel}>
                {t("uiToken.continueReadOnly")}
              </Button>
              <Button type="submit" size="sm" disabled={value.trim().length === 0}>
                {t("uiToken.submit")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </UiTokenContext.Provider>
  );
}
