import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type {
  DeviceSession,
  PairingCreatedResult,
} from "@/gateway/boardTypes";
import { isPairingSource } from "@/gateway/capabilities";
import { isTaskEventSource } from "@/gateway/capabilities";
import type { MemoryGateway } from "@/gateway/MemoryGateway";
import { useGateway } from "@/gateway/GatewayContext";
import { isApiError } from "@/lib/errors";
import { keys } from "@/lib/queryKeys";
import { GC_TIMES, STALE_TIMES } from "@/lib/queryClient";
import { useToast } from "@/components/Toast/toastContext";
import type { ToastApi } from "@/components/Toast/toastContext";
import { useUiToken } from "@/features/ui-token/UiTokenContext";
import { useT } from "@/i18n";
import type { TranslationKey, TranslateFn } from "@/i18n";

/**
 * CV-7 pairing/devices data hooks (ADR 0012 §10.2; useEnrollment posture):
 * every write runs through the ui-token gate (no token → LoginDialog with
 * the run queued), 401 rethrows so the gate takes over, every other failure
 * lands in an error toast carrying the SERVER's message (429 rate, 409
 * state conflict, 410 expired, 404 unknown id — text from the API, never
 * invented).
 *
 * The DEVICES list is ui-gated by token PRESENCE (GET /api/devices answers
 * _guard_ui_write): without a live session the query idles and the page
 * shows its honest login hint. Framework-free factory + thin React hook.
 */

/** Device sessions for the owner panel (`GET /api/devices`). */
export function useDevices(options: { tokenPresent: boolean }) {
  const gateway = useGateway();
  const capable = isPairingSource(gateway);
  return useQuery({
    queryKey: keys.devices.list(),
    queryFn: ({ signal }) => {
      if (!isPairingSource(gateway)) {
        throw new Error("useDevices: gateway has no pairing capability.");
      }
      return gateway.listDevices(signal);
    },
    enabled: capable && options.tokenPresent,
    staleTime: STALE_TIMES.agentsExecutors,
    gcTime: GC_TIMES.agentsExecutors,
  });
}

export interface PairingActionDeps {
  /** Gate runner (UiTokenGate.runAuthorized). */
  runAuthorized: (run: () => Promise<void>, onDeferred?: () => void) => void;
  /** Toast sink. */
  toast: Pick<ToastApi, "push">;
  /** Translate function. */
  t: TranslateFn;
  /** Mutation-capable gateway (asserted, not capability-guarded). */
  gateway: MemoryGateway;
  /** Cache owner. */
  queryClient: QueryClient;
  /** Confirm sink — injected so tests avoid native dialogs. */
  confirm: (message: string) => boolean;
}

export function createPairingActions(deps: PairingActionDeps) {
  const { runAuthorized, toast, t, queryClient, confirm } = deps;
  const mutations = () => {
    if (!isPairingSource(deps.gateway)) {
      throw new Error("pairing actions: gateway has no pairing capability.");
    }
    return deps.gateway;
  };

  /** The device list is the only server projection of this domain. */
  const invalidateDevices = (): void => {
    void queryClient.invalidateQueries({ queryKey: keys.devices.all });
  };

  const run = (errorTitleKey: TranslationKey, fn: () => Promise<void>): void => {
    runAuthorized(async () => {
      try {
        await fn();
      } catch (error) {
        // 401 escalates to the token gate (drop token → dialog → retry).
        if (isApiError(error) && error.status === 401) throw error;
        toast.push({
          kind: "error",
          title: t(errorTitleKey),
          detail: error instanceof Error ? error.message : undefined,
        });
      }
    });
  };

  /**
   * Start a pairing (`POST /api/pairing`, ui-token). The 201 (code+verify)
   * is handed to the caller VERBATIM — the dialog renders its QR screen
   * from it; the code exists EXACTLY once (§2.1). 429/503 surface as
   * toasts, the failure also fires onFailed for the dialog's honest state.
   */
  const createPairing = (callbacks?: {
    onCreated?: (created: PairingCreatedResult) => void;
    onSettled?: () => void;
    onFailed?: (message?: string) => void;
  }): void => {
    run("pairing.createFailed", async () => {
      try {
        const created = await mutations().createPairing();
        callbacks?.onCreated?.(created);
      } catch (error) {
        callbacks?.onFailed?.(error instanceof Error ? error.message : undefined);
        throw error;
      } finally {
        callbacks?.onSettled?.();
      }
    });
  };

  /**
   * Owner decision (`POST /api/pairing/{id}/confirm {allow}`). The outcome
   * word (confirmed | denied | idempotent) goes back to the caller — the
   * dialog reducer maps it; `onSettled` fires in a FINALLY (an undefined
   * outcome = the wire failed, the toast carries the server text) so the
   * dialog's deciding spinner can never stick. Devices list invalidates:
   * a confirmed pairing usually means a NEW device row lands seconds later.
   */
  const confirmPairing = (
    pairingId: string,
    allow: boolean,
    callbacks?: { onSettled?: (outcome?: string) => void },
  ): void => {
    run(allow ? "pairing.confirmFailed" : "pairing.denyFailed", async () => {
      let outcome: string | undefined;
      try {
        const result = await mutations().confirmPairing(pairingId, allow);
        invalidateDevices();
        outcome = result.outcome;
      } finally {
        // Exactly ONE settle: outcome word on success, undefined when the
        // wire failed (the toast already carries the server's text).
        callbacks?.onSettled?.(outcome);
      }
    });
  };

  /**
   * Cancel a not-yet-issued pairing (`DELETE /api/pairing/{id}`,
   * ui-token). issued → 409 (the device EXISTS — revoke it in the list).
   * `onSettled(ok)` fires in a finally: true = revoked, false = the wire
   * failed (the toast carries the server's text; the dialog stays put).
   */
  const cancelPairing = (
    pairingId: string,
    callbacks?: { onSettled?: (ok: boolean) => void },
  ): void => {
    run("pairing.cancelFailed", async () => {
      let ok = false;
      try {
        await mutations().cancelPairing(pairingId);
        ok = true;
      } finally {
        callbacks?.onSettled?.(ok);
      }
    });
  };

  /**
   * Revoke a device session (`DELETE /api/devices/{id}`, ui-token).
   * TERMINAL and irreversible — the confirm MUST say so before the wire
   * fires; only a fresh pairing ever restores access.
   */
  const revokeDevice = (
    device: Pick<DeviceSession, "id" | "name">,
    callbacks?: { onSettled?: () => void },
  ): void => {
    const confirmed = confirm(
      t("pairing.devices.revokeConfirm", {
        name: device.name || device.id,
      }),
    );
    if (!confirmed) return;
    run("pairing.devices.revokeFailed", async () => {
      await mutations().revokeDevice(device.id);
      invalidateDevices();
      toast.push({
        kind: "ok",
        title: t("pairing.devices.revoked"),
        detail: device.name || device.id,
      });
      callbacks?.onSettled?.();
    });
  };

  return { createPairing, confirmPairing, cancelPairing, revokeDevice, invalidateDevices };
}

export type PairingActions = ReturnType<typeof createPairingActions>;

/** React wiring: contexts → factory (stable identity across renders). */
export function usePairingActions(): PairingActions {
  const gateway = useGateway();
  const queryClient = useQueryClient();
  const uiToken = useUiToken();
  const toast = useToast();
  const t = useT();
  return useMemo(
    () =>
      createPairingActions({
        runAuthorized: uiToken.runAuthorized,
        toast,
        t,
        gateway,
        queryClient,
        confirm: (message) => window.confirm(message),
      }),
    [gateway, queryClient, t, toast, uiToken],
  );
}

/**
 * Fetch the trusted-side pairing status (ui-token) on demand — the
 * dialog's source of the SELF-ASSERTED name + source IP after a scan
 * (§3.3: the SSE frame deliberately carries neither the IP nor the verify
 * digits; the digits the dialog already holds from the 201).
 * Returns null when the pairing is gone (404 — already swept away).
 */
export function fetchPairingStatus(
  gateway: MemoryGateway,
  queryClient: QueryClient,
  pairingId: string,
): Promise<{
  state: string;
  device_name: string;
  source_ip: string;
} | null> {
  if (!isPairingSource(gateway)) return Promise.resolve(null);
  return queryClient
    .fetchQuery({
      queryKey: keys.pairing.status(pairingId),
      queryFn: ({ signal }) => {
        const capable = isPairingSource(gateway);
        if (!capable) throw new Error("pairing capability missing");
        return gateway.getPairing(pairingId, signal);
      },
      staleTime: 0,
      retry: false,
    })
    .catch((error: unknown) => {
      if (isApiError(error) && error.status === 404) return null;
      throw error;
    });
}

/**
 * The devices page's SSE bridge: `pairing.revoked` frames carrying a
 * device_id (the DELETE /api/devices/{id} emitter) refresh the list; ANY
 * reconnect re-fetches it too — the transport is at-most-once without
 * resumption, so the list must not trust a silent gap (ADR 0012 §5 п.9).
 * No polling: SSE + invalidation is the sync signal, per the family rule.
 */
export function useDevicesEventBridge(): void {
  const gateway = useGateway();
  const queryClient = useQueryClient();
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: keys.devices.all });
  }, [queryClient]);

  useEffect(() => {
    if (!isTaskEventSource(gateway)) return;
    const stream = gateway.events();
    const offRevoked = stream.on("pairing.revoked", (event) => {
      if (typeof event.device_id === "string") invalidate();
    });
    const offState = stream.onStateChange((state) => {
      // "open" also fires on the FIRST connect — a redundant invalidate of
      // an idle query is free; after every RECONNECT it is the honesty rule.
      if (state === "open") invalidate();
    });
    return () => {
      offRevoked();
      offState();
      stream.close();
    };
  }, [gateway, invalidate]);
}

/**
 * The dialog's SSE ears for ONE live pairing (created/requested phases):
 * `pairing.requested` on OUR id → status refresh (the scan happened);
 * `pairing.revoked`/`pairing.expired` on our id → honest terminal states.
 * Events for OTHER pairings (an older dialog, another owner tab) are
 * ignored. The stream opens lazily with the id and closes with it.
 */
export function usePairingEvents(
  pairingId: string | null,
  onRequested: () => void,
  onRevoked: () => void,
  onExpired: () => void,
): void {
  const gateway = useGateway();
  // Latest-callback refs: the subscription effect must not re-open the
  // stream (dropping SSE frames) merely because a callback identity moved.
  // The sync runs in an EFFECT (never during render — react-hooks/refs).
  const handlers = useRef({ onRequested, onRevoked, onExpired });
  useEffect(() => {
    handlers.current = { onRequested, onRevoked, onExpired };
  });

  useEffect(() => {
    if (!pairingId || !isTaskEventSource(gateway)) return;
    const stream = gateway.events();
    const offRequested = stream.on("pairing.requested", (event) => {
      if (event.pairing_id === pairingId) handlers.current.onRequested();
    });
    const offRevoked = stream.on("pairing.revoked", (event) => {
      if (event.pairing_id === pairingId) handlers.current.onRevoked();
    });
    const offExpired = stream.on("pairing.expired", (event) => {
      if (event.pairing_id === pairingId) handlers.current.onExpired();
    });
    return () => {
      offRequested();
      offRevoked();
      offExpired();
      stream.close();
    };
  }, [gateway, pairingId]);
}

/**
 * Honest copy feedback for the pairing surfaces (the useHonestCopy canon,
 * local copy — pairing must not lean on the agents feature module): the
 * «Скопировано» flash fires ONLY on a resolved write; clipboard absent
 * (non-secure context — the /pair page may open over plain LAN HTTP in a
 * pinch) or a rejection is a visible FAILURE the caller must show.
 */
export function useCopyFlash(
  resetMs = 2000,
): { copied: boolean; failed: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(
    (text: string) => {
      setCopied(false);
      setFailed(false);
      let write: Promise<void> | undefined;
      try {
        write = navigator.clipboard?.writeText(text);
      } catch {
        write = undefined;
      }
      if (!write) {
        setFailed(true);
        return;
      }
      void write.then(
        () => {
          setCopied(true);
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), resetMs);
        },
        () => setFailed(true),
      );
    },
    [resetMs],
  );
  return { copied, failed, copy };
}

// --- Device-leg copy with fallback (ADR 0012 §2.3, live owner feedback) ---------

/** The three honest outcomes of a device-side copy attempt. */
export type CopyOutcome =
  /** `navigator.clipboard.writeText` resolved. */
  | "copied"
  /** Clipboard blocked → textarea + `execCommand("copy")` succeeded. */
  | "copied-fallback"
  /** Both writers failed → the token was selected for a manual copy. */
  | "manual";

/**
 * Legacy clipboard path for mobile browsers where `navigator.clipboard` is
 * absent (plain-HTTP LAN context) or rejects (permission denied): an
 * off-screen readonly textarea, selected, copied via the deprecated-but-
 * universal `document.execCommand("copy")`. Returns whether the copy took.
 */
export function copyViaExecCommand(text: string): boolean {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const copied = document.execCommand("copy") === true;
    document.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
}

/** Select an element's contents (the manual-copy affordance: the owner gets
 * a highlighted token instead of a bare "it failed"). */
export function selectElementText(element: HTMLElement): void {
  const doc = element.ownerDocument;
  const selection = doc.defaultView?.getSelection();
  if (!selection) return;
  const range = doc.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * The device-leg copy hook: clipboard first, exec-command fallback, and —
 * when both writers refuse — the token is SELECTED in its row with the
 * honest «скопируйте вручную» verdict. `copied`/`copied-fallback` flash and
 * self-reset; `manual` PERSISTS (a failure must not quietly repaint itself
 * as success), until the next attempt.
 */
export function useCopyWithFallback(
  resetMs = 2000,
): { outcome: CopyOutcome | null; copy: (text: string, selectTarget?: HTMLElement | null) => void } {
  const [outcome, setOutcome] = useState<CopyOutcome | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const flash = useCallback(
    (value: Exclude<CopyOutcome, "manual">) => {
      setOutcome(value);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setOutcome(null), resetMs);
    },
    [resetMs],
  );

  const copy = useCallback(
    (text: string, selectTarget?: HTMLElement | null) => {
      setOutcome(null);
      let write: Promise<void> | undefined;
      try {
        write = navigator.clipboard?.writeText(text);
      } catch {
        write = undefined;
      }
      if (write) {
        void write.then(
          () => flash("copied"),
          () => {
            setOutcome(
              copyViaExecCommand(text) ? "copied-fallback" : manualOutcome(selectTarget),
            );
          },
        );
        return;
      }
      setOutcome(copyViaExecCommand(text) ? "copied-fallback" : manualOutcome(selectTarget));
    },
    [flash],
  );

  return { outcome, copy };
}

/** Total clipboard failure → select the row contents; the owner copies by hand. */
function manualOutcome(selectTarget?: HTMLElement | null): CopyOutcome {
  if (selectTarget) selectElementText(selectTarget);
  return "manual";
}
