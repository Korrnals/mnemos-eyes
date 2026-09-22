import { useCallback, useEffect, useReducer } from "react";
import { BadgeCheck, Check, Copy, ScanLine, ShieldX } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useGateway } from "@/gateway/GatewayContext";
import { useT } from "@/i18n";
import type { PairingCreatedResult } from "@/gateway/boardTypes";
import { useValidationNow } from "@/features/tasks/useValidationClock";
import {
  effectivePairingState,
  formatPairingCountdown,
  initialPairingDialogState,
  mountPrefixFromPathname,
  pairingDialogReducer,
  pairingTtlFraction,
  pairingUrl,
  verifyDigits,
} from "./pairingModel";
import type { PairingDialogState } from "./pairingModel";
import { PairingQr } from "./PairingQr";
import {
  fetchPairingStatus,
  useCopyFlash,
  usePairingActions,
  usePairingEvents,
} from "./usePairing";

/**
 * «Подключить устройство» — the owner-side pairing dialog (CV-7, ADR 0012
 * §2/Consequences). A reducer-driven state machine (pairingModel.ts — the
 * transitions are unit-tested there), one phase at a time:
 *
 *   creating → created (QR + manual code + TTL arc, waiting for the scan)
 *            → requested (decision panel: self-asserted name + source IP +
 *                        VERIFY digits big — «сверь четыре цифры» —
 *                        Подтвердить / Отклонить)
 *            → confirmed (the device picks its token up at the next
 *                        exchange; the devices list refetches)
 *   any live phase → expired / revoked (SSE pairing.expired/revoked on OUR
 *                    id, the 10 s status poll as the fallback, or the local
 *                    TTL clock hitting expires_at — the honest «начните
 *                    заново» state, never a silently dead QR)
 *
 * Invariant (ADR §3.5): the CODE and the VERIFY digits never render in the
 * same phase — created shows the code (it must travel to the device),
 * requested shows the digits (anti-error, not a secret).
 *
 * Liveness is doubly-wired by design: SSE is the signal, but the LAN stream
 * is unauthenticated at-most-once — a 10 s GET /api/pairing/{id} poll (the
 * owner leg has NO exchange-style rate limit) and the local TTL clock close
 * the gap. The QR chunk (qrcode.react) loads lazily on the created phase.
 */
export function PairingDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [state, dispatch] = useReducer(
    pairingDialogReducer,
    initialPairingDialogState,
  );
  const t = useT();

  // Close = a fresh machine next time (the EnrollmentDialog keyed-inner
  // rule, expressed as a restart — a re-open never shows a spent code).
  const close = useCallback(() => {
    onOpenChange(false);
    dispatch({ type: "restart" });
  }, [onOpenChange]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogTitle>{t("pairing.title")}</DialogTitle>
        <PairingDialogBody
          state={state}
          dispatch={dispatch}
          open={open}
          onClose={close}
        />
        {/* The description stays stable across phases (Radix wants one). */}
        <DialogDescription className="sr-only">
          {t("pairing.description")}
        </DialogDescription>
      </DialogContent>
    </Dialog>
  );
}

type Dispatch = (event: Parameters<typeof pairingDialogReducer>[1]) => void;

function PairingDialogBody({
  state,
  dispatch,
  open,
  onClose,
}: {
  state: PairingDialogState;
  dispatch: Dispatch;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const gateway = useGateway();
  const queryClient = useQueryClient();
  const actions = usePairingActions();
  const now = useValidationNow();

  const pairingId = state.created?.pairing_id ?? null;
  const live = state.phase === "created" || state.phase === "requested";

  // The create POST, once per "creating" episode (initial mount after open
  // and every «Начать заново»; the restart lands back on creating).
  useEffect(() => {
    if (!open || state.phase !== "creating") return;
    let cancelled = false;
    actions.createPairing({
      onCreated: (created) => {
        if (!cancelled) {
          dispatch({ type: "created", result: created, nowMs: Date.now() });
        }
      },
      onFailed: (message) => {
        if (!cancelled) dispatch({ type: "failed", message });
      },
    });
    return () => {
      cancelled = true;
    };
  }, [open, state.phase, actions, dispatch]);

  // Trusted-side status fetch: the SSE pairing.requested handler AND the
  // poll fallback both land here. A 404 (swept before its frame arrived)
  // reads honestly as expired.
  const refreshStatus = useCallback(() => {
    if (!pairingId) return;
    void fetchPairingStatus(gateway, queryClient, pairingId).then(
      (status) => {
        if (!status) {
          dispatch({ type: "expired" });
          return;
        }
        if (status.state === "scanned") {
          dispatch({
            type: "scanned",
            deviceName: status.device_name,
            sourceIp: status.source_ip,
          });
        } else if (status.state === "expired") {
          dispatch({ type: "expired" });
        } else if (status.state === "revoked") {
          dispatch({ type: "revoked" });
        }
      },
      () => {
        /* network hiccup — the next tick / SSE frame retries */
      },
    );
  }, [gateway, queryClient, pairingId, dispatch]);

  usePairingEvents(
    live ? pairingId : null,
    refreshStatus,
    () => dispatch({ type: "revoked" }),
    () => dispatch({ type: "expired" }),
  );

  // Poll fallback (10 s): SSE is at-most-once; the owner GET has no
  // exchange-style rate budget to burn.
  useEffect(() => {
    if (!live || !pairingId) return;
    const timer = window.setInterval(refreshStatus, 10_000);
    return () => window.clearInterval(timer);
  }, [live, pairingId, refreshStatus]);

  // Local TTL honesty: the moment the client clock passes expires_at the
  // dialog reads expired even with no SSE frame in sight (ADR §6: «истёк —
  // начните заново» — явно).
  const expiresAt = state.created?.expires_at;
  useEffect(() => {
    if (!live || !expiresAt || now === 0) return;
    if (now >= Date.parse(expiresAt)) dispatch({ type: "expired" });
  }, [live, expiresAt, now, dispatch]);

  const decide = useCallback(
    (allow: boolean) => {
      if (!pairingId) return;
      dispatch({ type: "deciding", deciding: true });
      actions.confirmPairing(pairingId, allow, {
        onSettled: (outcome) => {
          dispatch({ type: "deciding", deciding: false });
          if (outcome !== undefined) {
            dispatch({ type: "confirmSettled", outcome });
          }
        },
      });
    },
    [actions, pairingId, dispatch],
  );

  const onCancel = useCallback(() => {
    if (!pairingId) return;
    dispatch({ type: "deciding", deciding: true });
    actions.cancelPairing(pairingId, {
      onSettled: (ok) => {
        dispatch({ type: "deciding", deciding: false });
        if (ok) dispatch({ type: "cancelSettled" });
      },
    });
  }, [actions, pairingId, dispatch]);

  const restart = useCallback(() => dispatch({ type: "restart" }), [dispatch]);

  switch (state.phase) {
    case "creating":
      return (
        <p role="status" className="text-sm text-foreground-secondary">
          {t("pairing.creating")}
        </p>
      );
    case "created":
      return state.created ? (
        <CreatedPhase
          created={state.created}
          startedAtMs={state.startedAtMs ?? 0}
          now={now}
          deciding={state.deciding === true}
          onCancel={onCancel}
        />
      ) : null;
    case "requested":
      return (
        <RequestedPhase
          deviceName={state.scannedDeviceName ?? ""}
          sourceIp={state.scannedSourceIp ?? ""}
          verify={state.created?.verify ?? ""}
          created={state.created}
          startedAtMs={state.startedAtMs ?? 0}
          now={now}
          deciding={state.deciding === true}
          onApprove={() => decide(true)}
          onDeny={() => decide(false)}
        />
      );
    case "confirmed":
      return (
        <TerminalPhase
          icon={<BadgeCheck className="size-8 text-success" aria-hidden="true" />}
          title={t("pairing.confirmedTitle")}
          message={t("pairing.confirmedMessage")}
          onClose={onClose}
        />
      );
    case "denied":
      return (
        <TerminalPhase
          icon={<ShieldX className="size-8 text-error" aria-hidden="true" />}
          title={t("pairing.deniedTitle")}
          message={t("pairing.deniedMessage")}
          onClose={onClose}
        />
      );
    case "cancelled":
    case "expired":
      return (
        <TerminalPhase
          title={t(
            state.phase === "cancelled"
              ? "pairing.cancelledTitle"
              : "pairing.expiredTitle",
          )}
          message={
            state.phase === "cancelled" ? undefined : t("pairing.expiredMessage")
          }
          onClose={onClose}
          onRestart={restart}
        />
      );
    case "revoked":
      return (
        <TerminalPhase
          title={t("pairing.revokedTitle")}
          onClose={onClose}
          onRestart={restart}
        />
      );
    case "failed":
      return (
        <TerminalPhase
          variant="error"
          title={t("pairing.failedTitle")}
          message={state.errorMessage}
          onClose={onClose}
          onRestart={restart}
        />
      );
  }
}

/** Phase: live QR + the manual code + TTL arc — «ждём сканирования». */
function CreatedPhase({
  created,
  startedAtMs,
  now,
  deciding,
  onCancel,
}: {
  created: PairingCreatedResult;
  startedAtMs: number;
  now: number;
  deciding: boolean;
  onCancel: () => void;
}) {
  const t = useT();
  const { copied, failed, copy } = useCopyFlash();
  const expired = effectivePairingState(created, now) === "expired";
  const url = pairingUrl(
    windowLocationOrigin(),
    created.code,
    mountPrefixFromPathname(windowLocationPathname()),
  );

  return (
    <div className="flex flex-col items-center gap-3">
      <DialogDescription>{t("pairing.qrTitle")}</DialogDescription>
      <PairingQr value={url} />

      {/* Manual path (ADR §2: the flow must not require a scanner) — the
       * code itself, selectable and copyable. NO verify digits here (§3.5:
       * they meet the owner only at the decision panel). */}
      <div className="w-full rounded-md border border-border-subtle bg-background px-2 py-1.5">
        <div className="flex items-center gap-2">
          <span className="sr-only">{t("pairing.codeLabel")}</span>
          <code className="min-w-0 flex-1 truncate text-center font-mono text-base tracking-widest">
            {created.code}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs"
            onClick={() => copy(created.code)}
          >
            {copied ? (
              <Check className="size-3.5" aria-hidden="true" />
            ) : (
              <Copy className="size-3.5" aria-hidden="true" />
            )}
            {copied ? t("pairing.copied") : t("pairing.copy")}
          </Button>
        </div>
        <p className="mt-1 text-xs text-foreground-muted">
          {t("pairing.codeHint")}
        </p>
        {failed ? (
          <p role="alert" className="mt-1 text-xs text-error">
            {t("pairing.copyFailed")}
          </p>
        ) : null}
      </div>

      {/* Live TTL: the arc + mm:ss off the shared 1 Hz ticker; honest the
       * moment the clock passes expires_at (local rule mirrors §6). */}
      <p className="flex items-center gap-2 font-mono text-xs text-foreground-secondary">
        <TtlArc
          fraction={pairingTtlFraction(startedAtMs, created.expires_at, now)}
        />
        {expired
          ? t("pairing.expiredShort")
          : t("pairing.ttl", {
              time: formatPairingCountdown(created.expires_at, now) ?? "00:00",
            })}
      </p>
      <p className="flex items-center gap-1.5 text-sm text-foreground-secondary">
        <ScanLine className="size-4 animate-pulse text-iris" aria-hidden="true" />
        {t("pairing.waitingScan")}
      </p>

      <div className="flex w-full items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={deciding}
          onClick={onCancel}
        >
          {t("pairing.cancel")}
        </Button>
      </div>
    </div>
  );
}

/** Phase: the decision panel — self-asserted identity + IP + verify digits. */
function RequestedPhase({
  deviceName,
  sourceIp,
  verify,
  created,
  startedAtMs,
  now,
  deciding,
  onApprove,
  onDeny,
}: {
  deviceName: string;
  sourceIp: string;
  verify: string;
  created?: PairingCreatedResult;
  startedAtMs: number;
  now: number;
  deciding: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const t = useT();
  const digits = verifyDigits(verify);
  return (
    <div className="flex flex-col gap-3">
      <DialogDescription>{t("pairing.requestHint")}</DialogDescription>

      {/* Identity: SELF-ASSERTED (§3.6) — the unverified chip is the honest
       * label; rendered as text, never as markup. */}
      <div className="rounded-md border border-border-subtle bg-background px-3 py-2">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {deviceName || t("pairing.noDeviceName")}
          <Badge variant="outline" className="font-normal">
            {t("pairing.unverified")}
          </Badge>
        </p>
        {sourceIp ? (
          <p className="mt-0.5 font-mono text-xs text-foreground-secondary">
            {t("pairing.sourceIp")}: {sourceIp}
          </p>
        ) : null}
        {created ? (
          <p className="mt-0.5 font-mono text-xs text-foreground-secondary">
            <TtlArc
              fraction={pairingTtlFraction(
                startedAtMs,
                created.expires_at,
                now,
              )}
            />{" "}
            {t("pairing.ttl", {
              time: formatPairingCountdown(created.expires_at, now) ?? "00:00",
            })}
          </p>
        ) : null}
      </div>

      {/* The four verify digits, big — «сверь четыре цифры». The pairing
       * CODE is deliberately absent from this phase (§3.5 anti-error
       * separation). */}
      <div className="flex flex-col items-center gap-1.5">
        <p
          className="flex items-center gap-2"
          role="img"
          aria-label={`${t("pairing.verifyLabel")}: ${digits.join(" ")}`}
        >
          {digits.map((digit, index) => (
            <span
              key={`${digit}-${index}`}
              aria-hidden="true"
              className="flex size-12 items-center justify-center rounded-md border border-border bg-background font-mono text-2xl font-semibold"
            >
              {digit}
            </span>
          ))}
        </p>
        <p className="text-xs text-foreground-muted">{t("pairing.verifyHint")}</p>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={deciding}
          onClick={onDeny}
        >
          {t("pairing.deny")}
        </Button>
        <Button type="button" size="sm" disabled={deciding} onClick={onApprove}>
          {t("pairing.approve")}
        </Button>
      </div>
    </div>
  );
}

/** Shared terminal frames (confirmed / denied / cancelled / expired /
 * revoked / failed): the honest verdict + «начните заново» / «Готово». */
function TerminalPhase({
  icon,
  title,
  message,
  variant,
  onClose,
  onRestart,
}: {
  icon?: React.ReactNode;
  title: string;
  message?: string;
  variant?: "error";
  onClose: () => void;
  /** Present ⇒ a live restart makes sense (not on confirmed/denied). */
  onRestart?: () => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center">
      {icon}
      <p
        role={variant === "error" ? "alert" : "status"}
        className={
          "text-base font-semibold " + (variant === "error" ? "text-error" : "")
        }
      >
        {title}
      </p>
      {message ? (
        <p className="max-w-prose text-sm text-foreground-secondary">{message}</p>
      ) : null}
      <div className="flex items-center justify-end gap-2 self-stretch">
        {onRestart ? (
          <Button type="button" variant="outline" size="sm" onClick={onRestart}>
            {t("pairing.restart")}
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          {t("pairing.done")}
        </Button>
      </div>
    </div>
  );
}

/** Countdown arc — decorative (the mm:ss text beside it carries the info). */
function TtlArc({ fraction }: { fraction: number }) {
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg
      viewBox="0 0 24 24"
      className="inline-block size-4 shrink-0 -rotate-90"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r={radius}
        fill="none"
        stroke="var(--color-border-subtle)"
        strokeWidth="3"
      />
      <circle
        cx="12"
        cy="12"
        r={radius}
        fill="none"
        stroke="var(--color-iris)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - fraction)}
      />
    </svg>
  );
}

/** Client-only location accessors — SSR/test-safe indirection. */
function windowLocationOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}
function windowLocationPathname(): string {
  return typeof window === "undefined" ? "/" : window.location.pathname;
}
