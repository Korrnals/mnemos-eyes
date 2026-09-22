import { useState } from "react";
import { Smartphone, UserPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { TableRowSkeleton } from "@/components/skeletons/Skeletons";
import type { DeviceSession } from "@/gateway/boardTypes";
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
 * Consequences): the paired-device list (name, state, created, last IP,
 * sliding/hard expiry) with the TERMINAL revoke behind an explicit
 * irreversible warning, and the «Подключить устройство» entry point that
 * opens the QR-pairing dialog (PairingDialog).
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
 * revoke (terminal — the confirm says so, the usePairingActions layer). */
function DeviceRow({
  device,
  lang,
  onRevoke,
}: {
  device: DeviceSession;
  lang: "ru" | "en";
  onRevoke: () => void;
}) {
  const t = useT();
  const revoked = device.state === "revoked";
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
        <Smartphone
          className="size-4 shrink-0 text-foreground-secondary"
          aria-hidden="true"
        />
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
    </li>
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
