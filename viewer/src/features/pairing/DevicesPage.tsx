import { useState } from "react";
import { ChevronDown, ChevronRight, Smartphone, UserPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { TableRowSkeleton } from "@/components/skeletons/Skeletons";
import {
  DEVICE_GRANULES,
  type DeviceGranule,
  type DeviceSession,
} from "@/gateway/boardTypes";
import { isPairingSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import { useT } from "@/i18n";
import type { TranslationKey } from "@/i18n";
import { useI18n } from "@/i18n";
import { useUiToken } from "@/features/ui-token/UiTokenContext";
import { formatTaskDate } from "@/features/tasks/taskStatus";
import { PairingDialog } from "./PairingDialog";
import { useDevices, useDevicesEventBridge, usePairingActions } from "./usePairing";

/**
 * `/system/devices` — the owner's device panel (CV-7, ADR 0012
 * Consequences + Amendment §A.7): the paired-device list (name, state,
 * created, last IP, sliding/hard expiry) with the TERMINAL revoke behind
 * an explicit irreversible warning, and the «Подключить устройство» entry
 * point that opens the QR-pairing dialog (PairingDialog).
 *
 * §A.7 per-device grants: an ACTIVE row expands into the granule
 * switches — the owner decides «кому сколько и куда» per component
 * (tasks/reports/inbox/notifications; global reads are always open and
 * have no switch). Every flip PUTs the full set and applies to the LIVE
 * device on its very next request (no re-pairing). The server is the
 * source of truth: the PUT's 200 row replaces the cached one and a
 * failure reverts the flip via the list refetch.
 *
 * The list read is ui-token gated server-side (`_guard_ui_write`), so
 * without a live session the page shows its honest login hint instead of
 * an error. `pairing.revoked` frames carrying a device_id and every SSE
 * reconnect refresh the list (ADR §5 п.9 — at-most-once transport ⇒ the
 * list never trusts a silent gap).
 */
export function DevicesPage() {
  const t = useT();
  const { lang } = useI18n();
  const gateway = useGateway();
  const capable = isPairingSource(gateway);
  const uiToken = useUiToken();
  const devices = useDevices({ tokenPresent: uiToken.tokenPresent });
  const actions = usePairingActions();
  useDevicesEventBridge();

  const [dialogOpen, setDialogOpen] = useState(false);

  if (!capable) {
    return <PairingUnsupported />;
  }

  // Newest first — the same queue-the-owner-works-top-down order as the
  // enrollment panel.
  const items = [...(devices.data?.items ?? [])].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-3">
      <header className="flex items-center justify-end gap-2">
        <h1 className="sr-only">{t("pairing.devices.title")}</h1>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <UserPlus className="size-4" aria-hidden="true" />
          {t("pairing.title")}
        </Button>
      </header>

      {devices.isPending ? (
        uiToken.tokenPresent ? (
          <div role="status" aria-label={t("pairing.devices.loading")}>
            <TableRowSkeleton rows={3} columns={3} />
          </div>
        ) : (
          <LoginHint />
        )
      ) : devices.isError ? (
        <EmptyState
          variant="error"
          title={t("pairing.devices.failed")}
          message={devices.error.message}
          action={
            <Button variant="outline" onClick={() => void devices.refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : !uiToken.tokenPresent ? (
        <LoginHint />
      ) : items.length === 0 ? (
        <EmptyState
          variant="empty"
          title={t("pairing.devices.empty")}
          message={t("pairing.devices.emptyHint")}
        />
      ) : (
        <ul className="space-y-1.5" aria-label={t("pairing.devices.listLabel")}>
          {items.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              lang={lang}
              onRevoke={() => actions.revokeDevice(device)}
              onGrants={(grants) => actions.setDeviceGrants(device, grants)}
            />
          ))}
        </ul>
      )}

      <PairingDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}

/** The honest «this list lives behind the owner session» state. */
function LoginHint() {
  const t = useT();
  return (
    <p
      role="status"
      className="rounded-md border border-border-subtle bg-well px-3 py-2 text-sm text-foreground-muted"
    >
      {t("pairing.devices.loginHint")}
    </p>
  );
}

/** One dense device row: state badge · name · created · last IP · TTLs ·
 * revoke (terminal — the confirm says so, the usePairingActions layer).
 * ACTIVE rows expand into the per-granule switches (§A.7). */
function DeviceRow({
  device,
  lang,
  onRevoke,
  onGrants,
}: {
  device: DeviceSession;
  lang: "ru" | "en";
  onRevoke: () => void;
  onGrants: (grants: readonly string[]) => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const revoked = device.state === "revoked";
  const active = device.state === "active";
  const stateKey = (
    {
      active: "pairing.devices.state.active",
      expired: "pairing.devices.state.expired",
      revoked: "pairing.devices.state.revoked",
    } as Record<string, TranslationKey>
  )[device.state];
  const stateVariant =
    device.state === "active"
      ? "success"
      : device.state === "expired"
        ? "warning"
        : "error";

  return (
    <li
      className={
        "rounded-md border bg-well px-2.5 py-1.5 text-sm shadow-well transition-colors duration-instant " +
        (revoked
          ? "border-border-subtle text-foreground-muted"
          : "border-border-subtle hover:border-iris-bright/40")
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {active ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={
              expanded
                ? t("pairing.devices.grantsCollapse")
                : t("pairing.devices.grantsExpand")
            }
            className="rounded p-0.5 text-foreground-secondary hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? (
              <ChevronDown className="size-4" aria-hidden="true" />
            ) : (
              <ChevronRight className="size-4" aria-hidden="true" />
            )}
          </button>
        ) : (
          <Smartphone
            className="size-4 shrink-0 text-foreground-secondary"
            aria-hidden="true"
          />
        )}
        <span className="truncate font-medium">{device.name || device.id}</span>
        {stateKey ? (
          <Badge variant={stateVariant} className="font-normal">
            {t(stateKey)}
          </Badge>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          {!revoked ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
              onClick={onRevoke}
            >
              {t("pairing.devices.revoke")}
            </Button>
          ) : null}
        </span>
      </div>

      {/* Mono meta line: created · last seen IP · sliding + hard expiry.
       * Dates ride formatTaskDate (the two-clock rule: the wire owns the
       * values, the row renders them verbatim). */}
      <p className="mt-0.5 font-mono text-xs text-foreground-secondary">
        {t("pairing.devices.created")}: {formatTaskDate(device.created_at, lang)}
        {" · "}
        {t("pairing.devices.lastIp")}: {device.ip || "—"}
        {" · "}
        {t("pairing.devices.expires")}: {formatTaskDate(device.expires_at, lang)}
        {" · "}
        {t("pairing.devices.hardExpires")}:{" "}
        {formatTaskDate(device.hard_expires_at, lang)}
      </p>

      {active && expanded ? (
        <GrantsEditor device={device} onGrants={onGrants} />
      ) : null}
    </li>
  );
}

/**
 * The per-device granule switches (§A.7): one switch per granule in the
 * server's dictionary order; global reads have NO switch — they are open
 * to every valid device by design («глобальные read всегда»). Each flip
 * PUTs the FULL set (server-side replacement semantics), so the switches
 * are stateless bindings over `device.grants` — the 200 row refreshes the
 * list and the server stays the single source of truth.
 */
function GrantsEditor({
  device,
  onGrants,
}: {
  device: DeviceSession;
  onGrants: (grants: readonly string[]) => void;
}) {
  const t = useT();
  const granted = new Set(device.grants ?? []);
  return (
    <fieldset className="mt-1.5 rounded border border-border-subtle bg-elevated px-2.5 py-2">
      <legend className="px-1 text-xs font-medium text-foreground-secondary">
        {t("pairing.devices.grantsTitle")}
      </legend>
      <p className="mb-1.5 text-xs text-foreground-muted">
        {t("pairing.devices.grantsHint")}
      </p>
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {DEVICE_GRANULES.map((granule: DeviceGranule) => {
          const checked = granted.has(granule);
          const next = DEVICE_GRANULES.filter(
            (candidate) =>
              candidate === granule ? !checked : granted.has(candidate),
          );
          const inputId = `device-grants-${device.id}-${granule}`;
          return (
            <li key={granule} className="flex items-center gap-2">
              <input
                id={inputId}
                type="checkbox"
                role="switch"
                checked={checked}
                onChange={() => onGrants(next)}
                className="size-5 accent-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
              />
              <label htmlFor={inputId} className="text-sm">
                {t(`pairing.devices.granule.${granule}` as TranslationKey)}
              </label>
              {/* State in TEXT, not colour alone (WCAG 1.4.1). */}
              <span className="ml-auto text-xs text-foreground-secondary">
                {t(
                  checked
                    ? "pairing.devices.grantOn"
                    : "pairing.devices.grantOff",
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

/** Honest mnemos-mode state: the pairing domain is board-native (ADR 0012). */
function PairingUnsupported() {
  const t = useT();
  return (
    <section aria-labelledby="devices-title" className="mx-auto max-w-5xl space-y-4">
      <h1 id="devices-title" className="text-xl font-semibold">
        {t("pairing.devices.title")}
      </h1>
      <EmptyState
        variant="empty"
        title={t("pairing.unsupportedTitle")}
        message={t("pairing.unsupportedMessage")}
      />
    </section>
  );
}
