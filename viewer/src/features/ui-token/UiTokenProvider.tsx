import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  isTaskMutationSource,
  isUiTokenSessionSource,
} from "@/gateway/capabilities";
import { hasDeviceToken } from "@/gateway/deviceToken";
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
 * ADR 0014 owner session: when the gateway speaks the session wire
 * (BoardAdapter), the gate verifies at the door (`verifyUiToken`), the
 * provider boot-probes the live `vesmaro_ui` cookie once per mount
 * (hydrating `hasUiToken()` — a fresh tab must not re-prompt) and logout
 * tears the session down SERVER-side first (DELETE — an HttpOnly cookie
 * cannot be cleared from JS; a failed DELETE leaves the owner signed in
 * and says so instead of silently flipping to read-only).
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

  // Adapter-owned token policy: BoardAdapter reads sessionStorage + the
  // live-cookie flag (ADR 0014 Ф2), the mock answers true (no auth wall in
  // the dev playground). The session wire (verify/probe) is injected only
  // when the adapter grows it — otherwise the gate keeps the legacy
  // paste-and-store path.
  const gate = useMemo(
    () =>
      new UiTokenGate({
        hasToken: () => (isTaskMutationSource(gateway) ? gateway.hasUiToken() : false),
        // UI-22: only a mutation-capable gateway has the device beat — the
        // device identity (ADR 0012 §5) lives in localStorage and the fail-soft
        // read answers "no identity" outside a browser. The mock has no auth
        // wall (hasToken → true), so the branch stays unreachable there.
        ...(isTaskMutationSource(gateway)
          ? { hasDeviceIdentity: () => hasDeviceToken() }
          : {}),
        ...(isUiTokenSessionSource(gateway)
          ? {
              verifyToken: (value: string) => gateway.verifyUiToken(value),
              probe: () => gateway.probeUiSession(),
            }
          : {}),
      }),
    [gateway],
  );

  // Boot hydration (ADR 0014 Ф2): one probe per gateway — 204 flips
  // tokenPresent without any user action, so a second tab (or a reload
  // past the 6h sliding window's refresh) opens signed-in or stays
  // read-only, never stuck with a dead prompt.
  useEffect(() => {
    if (!isUiTokenSessionSource(gateway)) return;
    let cancelled = false;
    void gateway.probeUiSession().then(() => {
      if (!cancelled) gate.refreshPresence();
    });
    return () => {
      cancelled = true;
    };
  }, [gateway, gate]);

  // Login feedback toasts: success is confirmed once the value actually
  // lands in the tab (with an honest note in legacy mode — the board token
  // logged the owner in); a server-side 401 is announced beside the
  // window's inline line. Events only fire from user actions, always
  // post-mount, so the effect subscription is attached before the first
  // one can fire.
  useEffect(() => {
    return gate.listen((event) => {
      if (event.type === "loginStored") {
        toast.push({
          kind: "ok",
          title: t("login.toastSignedIn"),
          ...(event.tokenClass === "legacy"
            ? { detail: t("login.toastLegacy") }
            : {}),
        });
        return;
      }
      if (event.type === "deviceForbidden") {
        // UI-22: the honest device refusal — the login window never opens
        // for a paired device (the server's 403 verdict, ADR 0012 §5).
        toast.push({
          kind: "error",
          title: t("login.deviceForbidden"),
          detail: t("login.deviceForbiddenDetail"),
        });
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
  const dismiss = useCallback(() => gate.dismiss(), [gate]);
  const submitToken = useCallback(
    (value: string) => gate.submitToken(value),
    [gate],
  );

  // Logout (ADR 0014 Ф2): the provider owns the wire — DELETE first, THEN
  // the local scrub. A failed DELETE means the cookie (the actual session)
  // is still live: abort the logout and say so — a silent "signed out"
  // that isn't would be the same lie ADR 0014 removes everywhere else.
  const logout = useCallback(() => {
    if (!isUiTokenSessionSource(gateway)) {
      gate.logout();
      return;
    }
    void gateway
      .logoutUiToken()
      .then(() => gate.logout())
      .catch(() => {
        toast.push({
          kind: "error",
          title: t("login.logoutFailed"),
        });
      });
  }, [gateway, gate, toast, t]);

  return (
    <UiTokenContext.Provider
      value={{ tokenPresent: state.tokenPresent, openLogin, runAuthorized, logout }}
    >
      {children}
      <LoginDialog
        open={state.open}
        reason={state.reason}
        verifyPending={state.verifyPending === true}
        rejectKind={state.rejectKind}
        rejectDetail={state.rejectDetail}
        onSubmitToken={submitToken}
        onDismiss={dismiss}
      />
    </UiTokenContext.Provider>
  );
}
