import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { isTaskMutationSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import { useToast } from "@/components/Toast/toastContext";
import { useT } from "@/i18n";
import { UiTokenContext } from "./UiTokenContext";
import { LoginDialog } from "./LoginDialog";
import { UiTokenGate } from "./uiTokenGate";

/**
 * React wrapper around the UiTokenGate state machine (see uiTokenGate.ts —
 * the whole flow is unit-tested there, provider-free). Owns the ONE login
 * window of the app (LoginDialog — the TopBar «Войти» and every
 * mutation-driven prompt share it) and exposes the gate through context:
 * tokenPresent (reactive TopBar), openLogin, runAuthorized, logout. No page
 * reloads anywhere — the store transition re-renders the consumers.
 *
 * fix/login-feedback: the gate's session events surface as toasts — the
 * owner asked the app to CONFIRM a successful login (or shout about a 401)
 * instead of closing the window silently. The subscription lives in an
 * effect (closed over the current t/push) so the gate object itself is
 * built exactly once per gateway: a rebuild on language switch would reset
 * the machine mid-login, losing the queued action.
 */
export function UiTokenProvider({ children }: { children: React.ReactNode }) {
  const gateway = useGateway();
  const toast = useToast();
  const t = useT();

  // Adapter-owned token policy: BoardAdapter reads sessionStorage, the mock
  // answers true (no auth wall in the dev playground).
  const gate = useMemo(
    () =>
      new UiTokenGate({
        hasToken: () => (isTaskMutationSource(gateway) ? gateway.hasUiToken() : false),
      }),
    [gateway],
  );

  // Login feedback toasts: success is confirmed once the value actually
  // lands in the tab; a server-side 401 is announced beside the window's
  // inline line. Events only fire from user actions, always post-mount, so
  // the effect subscription is attached before the first one can fire.
  useEffect(() => {
    return gate.listen((event) => {
      if (event.type === "loginStored") {
        toast.push({ kind: "ok", title: t("login.toastSignedIn") });
        return;
      }
      toast.push({
        kind: "error",
        title: t("login.toastRejected"),
        detail: t("login.toastRejectedDetail"),
      });
    });
  }, [gate, toast, t]);

  const state = useSyncExternalStore(
    gate.subscribe.bind(gate),
    gate.getState.bind(gate),
    // SSR snapshot: the same pure read (renderToString harnesses need it).
    gate.getState.bind(gate),
  );

  const runAuthorized = useCallback(
    (run: () => Promise<void>, onDeferred?: () => void) => {
      gate.runAuthorized(run, onDeferred);
    },
    [gate],
  );
  const openLogin = useCallback(() => gate.openLogin(), [gate]);
  const logout = useCallback(() => gate.logout(), [gate]);
  const dismiss = useCallback(() => gate.dismiss(), [gate]);
  const submitToken = useCallback(
    (value: string) => gate.submitToken(value),
    [gate],
  );

  return (
    <UiTokenContext.Provider
      value={{ tokenPresent: state.tokenPresent, openLogin, runAuthorized, logout }}
    >
      {children}
      <LoginDialog
        open={state.open}
        reason={state.reason}
        onSubmitToken={submitToken}
        onDismiss={dismiss}
      />
    </UiTokenContext.Provider>
  );
}
