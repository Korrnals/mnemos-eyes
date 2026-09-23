import { useContext, useState } from "react";
import {
  getDeviceScope,
  hasDeviceToken,
  type DeviceScope,
} from "@/gateway/deviceToken";
import { isTaskMutationSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import { UiTokenContext } from "./UiTokenContext";
import type { TranslationKey } from "@/i18n";

/**
 * "What is this app instance's live contract right now?" — the four-state
 * derivation session-aware surfaces share (fix/login-feedback, UI-22, scope
 * v1 ADR 0012 Amendment). The sidebar footer and the overview badge state
 * all of them; surfaces on the boolean {@link useSessionControl} cut
 * collapse everything but "active" — only an owner session unlocks the
 * store-ops surfaces (automation settings, enrollment, devices).
 *
 * Truth table per adapter (capability, not configuration):
 * - "active": board/mock with a ui token present — taken from the gate's
 *   REACTIVE mirror so a login/logout flips every surface without a reload.
 * - "deviceControl": board WITHOUT a ui token, with a paired device whose
 *   scope is `control` (scope v1) — «устройство подключено · полный
 *   доступ»: the device mutates the board (tasks/reports/inbox/
 *   notifications); pairing/devices/auth/automation/agent-loop stay
 *   server-closed and stay UI-hidden (they key on the boolean cut).
 * - "device": same, but the device scope is `read` (the v0 shape —
 *   explicit least-privilege pairings) — «устройство подключено»,
 *   read-only by device scope, not by absence of identity.
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
export type SessionMode = "active" | "deviceControl" | "device" | "readOnly";

export function useSessionMode(): SessionMode {
  const gateway = useGateway();
  const token = useContext(UiTokenContext);
  const [deviceBound] = useState(() => hasDeviceToken());
  if (!isTaskMutationSource(gateway)) return "readOnly";
  if (token?.tokenPresent ?? gateway.hasUiToken()) return "active";
  if (!deviceBound) return "readOnly";
  // A stored identity from before scope v1 carries no scope field — the
  // server migration made every ACTIVE session `control`, so the
  // permissive reading is the honest one (getDeviceScope normalizes).
  const scope: DeviceScope = getDeviceScope();
  return scope === "read" ? "device" : "deviceControl";
}

/**
 * "Can this app instance control anything right now?" — the boolean cut of
 * {@link useSessionMode} every mutation-affordance surface shares. Only the
 * "active" mode unlocks the store-ops surfaces; "deviceControl" controls
 * the BOARD through the server's scope table, not the app's owner panels
 * (automation settings, enrollment, devices stay hidden on the phone).
 */
export function useSessionControl(): boolean {
  return useSessionMode() === "active";
}

/**
 * The mode-line i18n key for a session mode (scope v1): one shared picker
 * so the sidebar footer and the overview badge can never drift apart.
 */
export function sessionModeI18nKey(mode: SessionMode): TranslationKey {
  switch (mode) {
    case "active":
      return "nav.modeActive";
    case "deviceControl":
      return "nav.modeDeviceControl";
    case "device":
      return "nav.modeDevice";
    default:
      return "nav.modeReadOnly";
  }
}
