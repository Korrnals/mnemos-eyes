import { useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import type { ExecutionSettingsInput } from "@/gateway/boardTypes";
import { isAgentsSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import { useT } from "@/i18n";
import { AgentsUnsupported } from "./AgentsUnsupported";
import { useExecutors, useExecutionSettings } from "./useAgents";
import { useAssignmentMutations } from "./useAssignmentMutations";
import { formatPulseAge, lastSeenAgeS, presenceFromLastSeen } from "./presence";
import { useValidationNow } from "@/features/tasks/useValidationClock";

/**
 * `/system/settings` — minimal shell page (AGW-3): ONE live section,
 * «Исполнение» (spec §2.3: one global default + one fallback; project
 * overrides stay reserved). The selects list every registry row — offline
 * entries stay VISIBLE but disabled with their reason (§2.3); the save
 * runs through the ui-token gate, 422 gate texts come verbatim from the
 * API (the mock raises the same Amd 2 §5 gates). Further setting sections
 * join this page as sibling blocks in later waves.
 */
export function ExecutionSettingsPage() {
  const t = useT();
  const gateway = useGateway();
  const capable = isAgentsSource(gateway);
  const executors = useExecutors();
  const settings = useExecutionSettings();
  const mutations = useAssignmentMutations();
  const now = useValidationNow();
  const [defaultId, setDefaultId] = useState<string>("");
  const [fallbackId, setFallbackId] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // Derived-value adoption (no setState-in-render): before the first edit
  // the selects show the loaded pair; the first change pins the local copy.
  const loaded = settings.data;
  const defaultIdShown = dirty || defaultId !== "" ? defaultId : (loaded?.default_executor ?? "");
  const fallbackIdShown =
    dirty || fallbackId !== "" ? fallbackId : (loaded?.fallback_executor ?? "");

  if (!capable) {
    return <AgentsUnsupported />;
  }

  const items = executors.data?.items ?? [];
  const meta = executors.data?.meta;

  /**
   * Server gate mirror (§2.3; review P3-6: the `_validate_default_executor`
   * gate demands STRICTLY online — stale blocks too): a default must be
   * approved, enabled, online NOW and travel local-poll. Unknown presence
   * (no meta) reads as not-selectable — never a guess.
   */
  const selectableReason = (id: string): string | null => {
    const row = items.find((candidate) => candidate.id === id);
    if (!row) return null;
    if (row.state === "pending") return t("agents.executor.pendingReason");
    if (row.state === "revoked") return t("agents.executor.revokedReason");
    if (!row.enabled) return t("agents.executor.disabledReason");
    const presence = presenceFromLastSeen(row.last_seen, meta, now);
    if (presence !== "online") {
      const ageS = lastSeenAgeS(row.last_seen, now);
      if (presence === "stale") {
        return ageS !== null
          ? t("agents.executor.staleReason", {
              age: formatPulseAge(ageS, {
                minutes: t("agents.age.unitMinutes"),
                hours: t("agents.age.unitHours"),
                days: t("agents.age.unitDays"),
              }),
            })
          : t("agents.executor.staleShort");
      }
      return ageS !== null
        ? t("agents.executor.offlineReason", {
            age: formatPulseAge(ageS, {
              minutes: t("agents.age.unitMinutes"),
              hours: t("agents.age.unitHours"),
              days: t("agents.age.unitDays"),
            }),
          })
        : t("agents.executor.neverSeen");
    }
    if (row.transport !== "local-poll") {
      return t("agents.settings.meshIneligible");
    }
    return null; // selectable
  };

  const save = (): void => {
    setSaving(true);
    const payload: ExecutionSettingsInput = {
      default_executor: defaultIdShown,
      fallback_executor: fallbackIdShown,
      scope: "",
    };
    // Review P3-6b: `dirty` pins the local selects ONLY on a successful
    // save — a 422 (gate refusal) leaves the form on the loaded values.
    mutations.saveExecutionSettings(payload, {
      onSettled: () => setSaving(false),
    });
    setDirty(true);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 id="settings-title" className="text-xl font-semibold">
        {t("agents.settings.title")}
      </h1>

      <section
        aria-labelledby="execution-settings-heading"
        className="space-y-3 rounded-md border border-border-subtle bg-well p-4 shadow-well"
      >
        <div>
          <h2 id="execution-settings-heading" className="text-sm font-medium">
            {t("agents.settings.executionTitle")}
          </h2>
          <p className="mt-0.5 text-xs text-foreground-secondary">
            {t("agents.settings.executionHint")}
          </p>
        </div>

        {settings.isError ? (
          <EmptyState
            variant="error"
            title={t("agents.list.failed")}
            message={settings.error.message}
            action={
              <Button variant="outline" onClick={() => void settings.refetch()}>
                {t("common.retry")}
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <SettingsSelect
              id="execution-default"
              label={t("agents.settings.defaultLabel")}
              value={defaultIdShown}
              items={items}
              disabledReason={selectableReason}
              onChange={(value) => {
                setDefaultId(value);
                setDirty(true);
              }}
            />
            <SettingsSelect
              id="execution-fallback"
              label={t("agents.settings.fallbackLabel")}
              value={fallbackIdShown}
              items={items}
              disabledReason={selectableReason}
              onChange={(value) => {
                setFallbackId(value);
                setDirty(true);
              }}
            />
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button size="sm" onClick={save} disabled={saving || settings.isPending}>
            {saving ? t("agents.settings.saving") : t("agents.settings.save")}
          </Button>
        </div>
      </section>
    </div>
  );
}

/** One registry select: every row VISIBLE, ineligible ones disabled+reason. */
function SettingsSelect({
  id,
  label,
  value,
  items,
  disabledReason,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  items: readonly { id: string; name: string }[];
  disabledReason: (id: string) => string | null;
  onChange: (value: string) => void;
}) {
  const t = useT();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
      >
        <option value="">{t("agents.settings.none")}</option>
        {items.map((row) => {
          const reason = disabledReason(row.id);
          return (
            <option key={row.id} value={row.id} disabled={reason !== null}>
              {reason !== null ? `${row.name} — ${reason}` : row.name}
            </option>
          );
        })}
      </select>
    </div>
  );
}
