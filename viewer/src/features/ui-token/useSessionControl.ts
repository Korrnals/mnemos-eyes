import { useContext, useState } from "react";
import { hasDeviceToken } from "@/gateway/deviceToken";
import { isTaskMutationSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import { UiTokenContext } from "./UiTokenContext";

/**
 * "What is this app instance's live contract right now?" — the three-state
 * derivation session-aware surfaces share (fix/login-feedback, UI-22 owner
 * feedback). The sidebar footer states all three; surfaces still on the
 * boolean {@link useSessionControl} cut (the overview badge) collapse
 * "device" into read-only — "device" is identity without control either way.
 *
 * Truth table per adapter (capability, not configuration):
 * - "active": board/mock with a ui token present — taken from the gate's
 *   REACTIVE mirror so a login/logout flips every surface without a reload.
 * - "device": board WITHOUT a ui token but with a paired device identity in
 *   localStorage (ADR 0012 §5, `vesmaro.deviceToken`) — the honest «устройство
 *   подключено» beat: the browser IS on the board, read-only by device scope
 *   (v0), not by absence of identity.
 * - "readOnly": everyone else — the mnemos HttpAdapter (not a
 *   TaskMutationSource → honest for L1 even behind an mnk_ session), the board
 *   with neither token, fail-soft fallbacks.
 *
 * Fail-soft outside a UiTokenProvider (SSR harnesses mount the chrome bare):
 * falls back to the adapter's own plain read — the same answer the gate
 * would be constructed with. The device flag has no reactive mirror (it is
 * written once by the /pair exchange, read on mount) — one honest read per
 * mount, storage-less environments answer "no identity" and never throw.
 */
export type SessionMode = "active" | "device" | "readOnly";

export function useSessionMode(): SessionMode {
  const gateway = useGateway();
  const token = useContext(UiTokenContext);
  const [deviceBound] = useState(() => hasDeviceToken());
  if (!isTaskMutationSource(gateway)) return "readOnly";
  if (token?.tokenPresent ?? gateway.hasUiToken()) return "active";
  return deviceBound ? "device" : "readOnly";
}

/**
 * "Can this app instance control anything right now?" — the boolean cut of
 * {@link useSessionMode} every mutation-affordance surface shares. Only the
 * "active" mode controls; "device" is identity without write scope (v0).
 */
export function useSessionControl(): boolean {
  return useSessionMode() === "active";
}
