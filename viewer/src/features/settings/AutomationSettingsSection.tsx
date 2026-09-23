import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { isAutomationMutationSource, isAutomationSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import { useT } from "@/i18n";
import { useSessionControl } from "@/features/ui-token/useSessionControl";
import {
  useAutomationMutations,
  useAutomationSettings,
  useAutomationStatus,
} from "@/features/automation/useAutomation";

/**
 * «Автоматизация» section of the settings hub (UI-21, spec 2026-09-23 §2):
 * the kill-switch + daily-cap form over `GET/PUT /api/automation/settings`
 * — the server PUT is partial, the form sends BOTH fields (audited only on
 * effective change, store.py ADR 0013 §6). Honesty S1: the «движок не
 * включён» stanza renders while `status.engine === false` (P2-3 pattern) —
 * the switch stores the owner's INTENT, it does not arm an engine that
 * does not exist yet. Without a session the section stays fully readable,
 * «Сохранить» disabled, one honest disabledNote line (ADR 0013 §8/0014);
 * a 422 answers with the server text verbatim and the form returns to the
 * LOADED values (P3-6b).
 */
export function AutomationSettingsSection({ anchorId }: { anchorId?: string }) {
  const t = useT();
  const gateway = useGateway();
  const capable = isAutomationSource(gateway);
  const session = useSessionControl();
  const canMutate = Boolean(session) && isAutomationMutationSource(gateway);
  const settings = useAutomationSettings();
  const status = useAutomationStatus();
  const mutations = useAutomationMutations();
  // Derived-value adoption (no setState-in-render): `null` = untouched —
  // before the first edit the form shows the LOADED values; the first
  // change pins the local copy. A null SENTINEL (not a dirty flag) is the
  // point: clearing the cap field («abc»/blank reads as "" on a number
  // input) must stay an EDITED invalid state, never silently fall back.
  const [localEnabled, setLocalEnabled] = useState<boolean | null>(null);
  const [localCap, setLocalCap] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // No automation capability → the SECTION degenerates to a note (UI-21 §3);
  // «Интерфейс» stays — the chrome exists in every mode.
  if (!capable) {
    return (
      <p role="note" className="text-xs text-foreground-muted">
        {t("automation.unavailableTitle")}
      </p>
    );
  }

  const loaded = settings.data;
  const enabledShown =
    localEnabled !== null ? localEnabled : (loaded?.enabled ?? false);
  const capShown =
    localCap !== null
      ? localCap
      : loaded !== undefined
        ? String(loaded.cap_global_per_day)
        : "";
  // Client gate (§2): an integer in 1..1000 — same bounds as the server
  // Field(ge=1, le=1000); anything else shows the inline error and the
  // PUT never leaves the page.
  const capParsed = /^\d+$/.test(capShown) ? Number(capShown) : Number.NaN;
  const capValid = Number.isInteger(capParsed) && capParsed >= 1 && capParsed <= 1000;
  // The day counter is the status projection (criterion 8; S1: honest 0).
  // While the status query is in flight the loaded settings cap stands in —
  // server-side both answers come from the same store pair.
  const usedToday = status.data?.daily_used ?? 0;
  const capForHint = status.data?.daily_cap ?? loaded?.cap_global_per_day ?? 0;

  const save = (): void => {
    if (!capValid || saving || settings.isPending) return;
    setSaving(true);
    mutations.saveSettings(
      { enabled: enabledShown, cap_global_per_day: capParsed },
      {
        // Failure (422 verbatim toast): the form returns to the LOADED
        // values (P3-6b) — the local edits are dropped, not kept dangling.
        onFailed: () => {
          setLocalEnabled(null);
          setLocalCap(null);
        },
        onSettled: () => setSaving(false),
      },
    );
  };

  return (
    <section
      id={anchorId}
      aria-labelledby="automation-settings-heading"
      className="space-y-3 rounded-md border border-border-subtle bg-well p-4 shadow-well"
    >
      <div>
        <h2 id="automation-settings-heading" className="text-sm font-medium">
          {t("automation.settings.title")}
        </h2>
      </div>

      {/* S1 honesty: only when the status is KNOWN to be off (P2-3) — when
       * S2 ships the loop, the stanza disappears without a UI change. */}
      {status.data && !status.data.engine ? (
        <div className="space-y-1">
          <Badge variant="warning">{t("automation.banner.engineOff")}</Badge>
          <p className="text-xs text-foreground-secondary">
            {t("automation.settings.engineOffNote")}
          </p>
        </div>
      ) : null}

      {settings.isPending ? (
        <p role="status" className="text-sm text-foreground-secondary">
          {t("automation.listLoading")}…
        </p>
      ) : settings.isError ? (
        <EmptyState
          variant="error"
          title={t("automation.statusFailed")}
          message={settings.error.message}
          action={
            <Button variant="outline" onClick={() => void settings.refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <input
              id="automation-enabled"
              type="checkbox"
              role="switch"
              checked={enabledShown}
              onChange={(event) => {
                setLocalEnabled(event.target.checked);
              }}
              className="size-6 accent-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
            />
            <label htmlFor="automation-enabled" className="text-sm font-medium">
              {t("automation.settings.enabledLabel")}
            </label>
            {/* State in TEXT, not colour alone (WCAG 1.4.1). */}
            <span className="text-xs text-foreground-secondary">
              {enabledShown
                ? t("automation.rule.enabled")
                : t("automation.rule.disabled")}
            </span>
          </div>

          <div>
            <label htmlFor="automation-cap" className="mb-1 block text-sm font-medium">
              {t("automation.settings.capLabel")}
            </label>
            <input
              id="automation-cap"
              type="number"
              min={1}
              max={1000}
              step={1}
              value={capShown}
              onChange={(event) => {
                setLocalCap(event.target.value);
              }}
              aria-invalid={!capValid}
              aria-describedby={
                capValid
                  ? "automation-cap-hint"
                  : "automation-cap-hint automation-cap-error"
              }
              className="h-9 w-28 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
            />
            {/* Hint always; error joins describedby when present (§5). */}
            <p id="automation-cap-hint" className="mt-0.5 text-xs text-foreground-secondary">
              {t("automation.settings.capHint", { used: usedToday, cap: capForHint })}
            </p>
            {!capValid ? (
              <p id="automation-cap-error" className="mt-0.5 text-xs text-error">
                {t("automation.settings.capError")}
              </p>
            ) : null}
          </div>
        </div>
      )}

      {/* No session → readable section, disabled save, one honest line. */}
      {!canMutate ? (
        <p className="text-xs text-foreground-muted" role="note">
          {t("automation.mutation.disabledNote")}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          onClick={save}
          disabled={saving || settings.isPending || !canMutate || !capValid}
        >
          {saving ? t("automation.settings.saving") : t("automation.settings.save")}
        </Button>
      </div>
    </section>
  );
}
