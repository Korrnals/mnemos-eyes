import { useCallback, useMemo, useSyncExternalStore } from "react";
import { isTaskMutationSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
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
 */
export function UiTokenProvider({ children }: { children: React.ReactNode }) {
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
