import { useContext } from "react";
import { isTaskMutationSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import { UiTokenContext } from "./UiTokenContext";

/**
 * "Can this app instance control anything right now?" — the single
 * derivation every session-aware surface shares (fix/login-feedback): the
 * sidebar footer mode line and the overview badge must never disagree.
 *
 * Truth table per adapter (capability, not configuration):
 * - mnemos HttpAdapter: not a TaskMutationSource → read-only, honest for L1
 *   even behind an mnk_ session (reads only, no mutation surface exists).
 * - board: control iff a ui token is present — taken from the gate's
 *   REACTIVE mirror so a login/logout flips every surface without a reload.
 * - mock: the dev playground has no auth wall (hasUiToken() is true) →
 *   the active-session label is the honest one.
 *
 * Fail-soft outside a UiTokenProvider (SSR harnesses mount the chrome bare):
 * falls back to the adapter's own plain read — the same answer the gate
 * would be constructed with.
 */
export function useSessionControl(): boolean {
  const gateway = useGateway();
  const token = useContext(UiTokenContext);
  return isTaskMutationSource(gateway) && (token?.tokenPresent ?? gateway.hasUiToken());
}
