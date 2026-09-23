import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Play, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { useToast } from "@/components/Toast/toastContext";
import type { HookRule, ScheduleRule } from "@/gateway/boardTypes";
import { isAutomationMutationSource, isAutomationSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import { useI18n, useT } from "@/i18n";
import { formatTaskDate } from "@/features/tasks/taskStatus";
import { useBoardTasks } from "@/features/tasks/useTasks";
import { useSessionControl } from "@/features/ui-token/useSessionControl";
import { useAutomationEvents } from "./automationEvents";
import { parseConditionMeta } from "./conditionMeta";
import { describeClause } from "./conditionMeta";
import type { ConditionMeta } from "./conditionMeta";
import { HookFormDialog, ScheduleFormDialog } from "./AutomationForms";
import {
  useAutomationMutations,
  useAutomationStatus,
  useHookRules,
  useLaunches,
  useSchedules,
} from "./useAutomation";

/**
 * `/system/automation` (SCHED-1-UI, ADR 0013 §8): the status banner (engine
 * HONESTLY false in S1 — manual runs only), the read-only kill-switch/cap
 * line, and three tabs — Расписания | Правила | Журнал. v1 cuts live here:
 * no cron UI, no templates, no bulk, no kill-switch toggle, no audit
 * viewer, no catch-up, no timezones, no charts.
 *
 * Capability-gated on the S1 API (board/mock); WITHOUT a ui token the
 * section renders fully readable with every mutation disabled and ONE
 * honest explanation line at the top. «Запустить сейчас» reuses the
 * assignment machinery WHOLE (ADR 0013 §8): the server route runs the
 * create-assignment path and the outcome surfaces through the shared
 * assignment cache + the existing execution surfaces (the journal links
 * the assignment into /agents/execution) — no second state machine
 * exists on this page.
 */

const TABS = [
  { id: "schedules", key: "automation.tabSchedules" as const },
  { id: "hooks", key: "automation.tabHooks" as const },
  { id: "journal", key: "automation.tabJournal" as const },
] as const;

type TabId = (typeof TABS)[number]["id"];

function isTabId(value: string): value is TabId {
  return TABS.some((tab) => tab.id === value);
}

export function AutomationPage() {
  const t = useT();
  const { lang } = useI18n();
  const gateway = useGateway();
  const capable = isAutomationSource(gateway);
  const session = useSessionControl(); // token presence → mutation affordances
  // Page-owned SSE bridge (see automationEvents.ts for the mount decision).
  useAutomationEvents();

  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get("tab") ?? "schedules";
  const tab: TabId = isTabId(tabParam) ? tabParam : "schedules";
  const [scheduleFormOpen, setScheduleFormOpen] = useState(false);
  const [hookFormOpen, setHookFormOpen] = useState(false);

  const status = useAutomationStatus();
  const schedules = useSchedules();
  const hooks = useHookRules();
  const launches = useLaunches();
  const board = useBoardTasks();
  const mutations = useAutomationMutations();

  const meta = useMemo(
    () => parseConditionMeta(status.data?.condition_meta),
    [status.data?.condition_meta],
  );
  const canMutate = Boolean(session) && isAutomationMutationSource(gateway);

  const taskIds = useMemo(
    () => (board.data?.tasks ?? []).map((task) => task.id),
    [board.data],
  );
  const specialists = useMemo(() => {
    const union = new Set<string>();
    for (const task of board.data?.tasks ?? []) {
      for (const name of task.specialists ?? []) union.add(name);
    }
    return [...union].sort();
  }, [board.data]);

  if (!capable) {
    return (
      <section aria-labelledby="automation-title" className="mx-auto max-w-4xl space-y-4">
        <h1 id="automation-title" className="text-xl font-semibold">
          {t("automation.title")}
        </h1>
        <EmptyState
          variant="empty"
          title={t("automation.unavailableTitle")}
          message={t("automation.unavailableMessage")}
        />
      </section>
    );
  }

  return (
    <section aria-labelledby="automation-title" className="mx-auto max-w-4xl space-y-4">
      <h1 id="automation-title" className="text-xl font-semibold">
        {t("automation.title")}
      </h1>

      {/* Status banner — the S1 honesty: engine false, manual runs only. */}
      {status.isPending ? (
        <p role="status" className="text-sm text-foreground-secondary">
          {t("automation.statusLoading")}…
        </p>
      ) : status.isError ? (
        <EmptyState
          variant="error"
          title={t("automation.statusFailed")}
          message={status.error.message}
          action={
            <Button variant="outline" onClick={() => void status.refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : (
        <div className="space-y-1 rounded-md border border-border-subtle bg-well p-3 shadow-well">
          {/* P2-3: the «manual runs only» stanza is gated on !engine — when
           * S2 turns the loop on, the banner stops claiming it is off. */}
          {!status.data?.engine ? (
            <>
              <Badge variant="warning" className="mb-1">
                {t("automation.banner.engineOff")}
              </Badge>
              <p className="text-xs text-foreground-secondary">
                {t("automation.banner.engineOffNote")}
              </p>
            </>
          ) : null}
          {/* Read-only kill-switch + cap (v1: NO toggle) + honest counters.
           * The toggle itself lives in the settings hub (UI-21, spec §1.2
           * ADR 0013 §8 UI-frame amendment) — the banner links there. */}
          <p className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-foreground-muted">
            <span>
              {t("automation.banner.killSwitch")}:{" "}
              {status.data?.global_kill_switch ? "on" : "off"}
            </span>
            <span>
              {t("automation.banner.cap")}: {status.data?.daily_cap ?? 0}
            </span>
            <span>
              {t("automation.banner.usedToday")}: {status.data?.daily_used ?? 0}
            </span>
            <span>
              {t("automation.banner.rules")}:{" "}
              {t("automation.banner.rulesCount", {
                schedules: status.data?.rules.schedules.total ?? 0,
                hooks: status.data?.rules.hooks.total ?? 0,
              })}
            </span>
          </p>
          <p className="text-xs">
            <Link
              to="/system/settings#automation"
              className="text-iris-bright underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
            >
              {t("automation.banner.settingsLink")}
            </Link>
          </p>
        </div>
      )}

      {/* No token → readable section, disabled mutations, one honest line. */}
      {!canMutate ? (
        <p className="text-xs text-foreground-muted" role="note">
          {t("automation.mutation.disabledNote")}
        </p>
      ) : null}

      {/* Tabs as links (deep-linkable ?tab=, the TaskDetailPage posture). */}
      <nav aria-label={t("automation.tabsLabel")}>
        <ul className="flex flex-wrap gap-1 border-b border-border-subtle">
          {TABS.map((entry) => {
            const active = entry.id === tab;
            return (
              <li key={entry.id}>
                <Link
                  to={`/system/automation?tab=${entry.id}`}
                  aria-current={active ? "page" : undefined}
                  onClick={(event) => {
                    if (active) event.preventDefault();
                  }}
                  className={
                    "border-b-2 px-3 py-2 text-sm transition-colors duration-instant focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright " +
                    (active
                      ? "border-iris-bright font-medium text-iris-bright"
                      : "border-transparent text-foreground-secondary hover:text-foreground")
                  }
                >
                  {t(entry.key)}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {tab === "schedules" ? (
        <SchedulesTab
          query={schedules}
          canMutate={canMutate}
          onCreate={() => setScheduleFormOpen(true)}
          onToggle={(rule, enabled) => mutations.patchSchedule(rule.id, { enabled })}
          onDelete={(rule) => mutations.deleteSchedule(rule)}
          onRunNow={(rule) => mutations.runScheduleNow(rule)}
        />
      ) : null}
      {tab === "hooks" ? (
        <HooksTab
          query={hooks}
          canMutate={canMutate}
          onCreate={() => setHookFormOpen(true)}
          onToggle={(rule, enabled) => mutations.patchHookRule(rule.id, { enabled })}
          onDelete={(rule) => mutations.deleteHookRule(rule)}
        />
      ) : null}
      {tab === "journal" ? <JournalTab launches={launches} lang={lang} /> : null}

      <ScheduleFormDialog
        open={scheduleFormOpen}
        onOpenChange={setScheduleFormOpen}
        taskIds={taskIds}
        specialists={specialists}
        // P3-6: the form guards REAL in-flight — the factory runs gated, so
        // the promise resolves on the settled mutation (queued-behind-login
        // runs resolve on dismiss; errors resolve after their toast).
        onCreate={(payload) =>
          new Promise<void>((resolve) => {
            mutations.createSchedule(payload, { onSettled: resolve });
          })
        }
      />
      <HookFormDialog
        open={hookFormOpen}
        onOpenChange={setHookFormOpen}
        meta={meta}
        onCreate={(payload) =>
          new Promise<void>((resolve) => {
            mutations.createHookRule(payload, { onSettled: resolve });
          })
        }
      />
    </section>
  );
}

/** Schedules: trigger · task link · enabled toggle · run-now · delete. */
function SchedulesTab({
  query,
  canMutate,
  onCreate,
  onToggle,
  onDelete,
  onRunNow,
}: {
  query: ReturnType<typeof useSchedules>;
  canMutate: boolean;
  onCreate: () => void;
  onToggle: (rule: ScheduleRule, enabled: boolean) => void;
  onDelete: (rule: ScheduleRule) => void;
  onRunNow: (rule: ScheduleRule) => void;
}) {
  const t = useT();
  const rules = query.data?.items ?? [];
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground-secondary">
          {t("automation.tabSchedules")}
        </h2>
        <Button variant="outline" size="sm" disabled={!canMutate} onClick={onCreate}>
          <Plus className="size-4" aria-hidden="true" />
          {t("automation.schedule.create")}
        </Button>
      </div>
      {query.isPending ? (
        <p role="status" className="text-sm text-foreground-secondary">
          {t("automation.listLoading")}…
        </p>
      ) : query.isError ? (
        <EmptyState
          variant="error"
          title={t("automation.listFailed")}
          message={query.error.message}
        />
      ) : rules.length === 0 ? (
        <EmptyState
          variant="empty"
          title={t("automation.schedule.empty")}
          message={t("automation.schedule.emptyHint")}
          action={
            canMutate ? (
              <Button onClick={onCreate}>{t("automation.schedule.create")}</Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="space-y-1.5" aria-label={t("automation.tabSchedules")}>
          {rules.map((rule) => (
            <li
              key={rule.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border-subtle bg-well px-3 py-2 text-sm shadow-well"
            >
              <span className="font-medium">{rule.name}</span>
              <Badge variant={rule.enabled ? "iris" : "outline"}>
                {rule.enabled ? t("automation.rule.enabled") : t("automation.rule.disabled")}
              </Badge>
              <span className="font-mono text-xs text-foreground-secondary">
                {rule.trigger_kind === "time-of-day"
                  ? t("automation.rule.dailyAt", { at: rule.trigger_value })
                  : t("automation.rule.everyInterval", { interval: rule.trigger_value })}
              </span>
              <Link
                to={`/tasks/${encodeURIComponent(rule.task_id)}?tab=execution`}
                className="font-mono text-xs text-iris-bright underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
              >
                {rule.task_id}
              </Link>
              <span className="ml-auto flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={!canMutate}
                  onClick={() => onToggle(rule, !rule.enabled)}
                >
                  {rule.enabled ? t("automation.rule.disable") : t("automation.rule.enable")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={!canMutate}
                  title={t("automation.rule.runNowTitle")}
                  onClick={() => onRunNow(rule)}
                >
                  <Play className="size-3.5" aria-hidden="true" />
                  {t("automation.rule.runNow")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-error"
                  disabled={!canMutate}
                  onClick={() => onDelete(rule)}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                  {t("automation.rule.delete")}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Hooks: on-event · clauses (wire triples, human-readable) · enabled · delete. */
function HooksTab({
  query,
  canMutate,
  onCreate,
  onToggle,
  onDelete,
}: {
  query: ReturnType<typeof useHookRules>;
  canMutate: boolean;
  onCreate: () => void;
  onToggle: (rule: HookRule, enabled: boolean) => void;
  onDelete: (rule: HookRule) => void;
}) {
  const t = useT();
  const rules = query.data?.items ?? [];
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground-secondary">
          {t("automation.tabHooks")}
        </h2>
        <Button variant="outline" size="sm" disabled={!canMutate} onClick={onCreate}>
          <Plus className="size-4" aria-hidden="true" />
          {t("automation.hook.create")}
        </Button>
      </div>
      {query.isPending ? (
        <p role="status" className="text-sm text-foreground-secondary">
          {t("automation.listLoading")}…
        </p>
      ) : query.isError ? (
        <EmptyState
          variant="error"
          title={t("automation.listFailed")}
          message={query.error.message}
        />
      ) : rules.length === 0 ? (
        <EmptyState
          variant="empty"
          title={t("automation.hook.empty")}
          message={t("automation.hook.emptyHint")}
          action={
            canMutate ? (
              <Button onClick={onCreate}>{t("automation.hook.create")}</Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="space-y-1.5" aria-label={t("automation.tabHooks")}>
          {rules.map((rule) => (
            <li
              key={rule.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border-subtle bg-well px-3 py-2 text-sm shadow-well"
            >
              <span className="font-medium">{rule.name}</span>
              <Badge variant={rule.enabled ? "iris" : "outline"}>
                {rule.enabled ? t("automation.rule.enabled") : t("automation.rule.disabled")}
              </Badge>
              <span className="font-mono text-xs text-foreground-secondary">{rule.on}</span>
              <span className="text-xs text-foreground-secondary">
                {rule.condition.length > 0
                  ? rule.condition.map(describeClause).join(" ∧ ")
                  : t("automation.hook.noCondition")}
              </span>
              <span className="font-mono text-xs text-foreground-muted">{rule.action}</span>
              <span className="ml-auto flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={!canMutate}
                  onClick={() => onToggle(rule, !rule.enabled)}
                >
                  {rule.enabled ? t("automation.rule.disable") : t("automation.rule.enable")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-error"
                  disabled={!canMutate}
                  onClick={() => onDelete(rule)}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                  {t("automation.rule.delete")}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Journal: decisions with reasons, honest trigger/origin stamps (S1 rows
 * are all manual/ui — the engine-off world reads clearly), cursor «ещё».
 * The assignment link goes to /agents/execution because LaunchOut carries
 * NO task_id (P3-5) — the assignment surface that already exists (AGW-3)
 * is the honest destination, never a new one.
 */
function JournalTab({
  launches,
  lang,
}: {
  launches: ReturnType<typeof useLaunches>;
  lang: "ru" | "en";
}) {
  const t = useT();
  const toast = useToast();
  const rows = launches.data?.items ?? [];
  const nextCursor = launches.data?.next_cursor ?? null;
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium text-foreground-secondary">
        {t("automation.tabJournal")}
      </h2>
      {launches.isPending ? (
        <p role="status" className="text-sm text-foreground-secondary">
          {t("automation.listLoading")}…
        </p>
      ) : launches.isError ? (
        <EmptyState
          variant="error"
          title={t("automation.listFailed")}
          message={launches.error.message}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          variant="empty"
          title={t("automation.journal.empty")}
          message={t("automation.journal.emptyHint")}
        />
      ) : (
        <>
          <ul className="space-y-1" aria-label={t("automation.tabJournal")}>
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-sm px-1 py-1 text-sm"
              >
                <span className="font-mono text-xs text-foreground-muted">
                  {formatTaskDate(row.attempted_at, lang)}
                </span>
                <Badge
                  variant={
                    row.decision === "launched"
                      ? "success"
                      : row.decision === "skipped"
                        ? "default"
                        : "warning"
                  }
                >
                  {row.decision === "launched"
                    ? t("automation.journal.launched")
                    : row.decision === "skipped"
                      ? t("automation.journal.skipped")
                      : t("automation.journal.missed")}
                </Badge>
                <span className="text-xs text-foreground-secondary">{row.rule_name}</span>
                <span className="font-mono text-xs text-foreground-muted">
                  {row.trigger}/{row.origin}
                </span>
                {row.reason ? (
                  <span className="text-xs text-foreground-secondary">{row.reason}</span>
                ) : null}
                {row.assignment_id !== null && row.assignment_id !== undefined ? (
                  <Link
                    to="/agents/execution"
                    className="ml-auto font-mono text-xs text-iris-bright underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
                  >
                    {t("automation.journal.assignment", { id: row.assignment_id })}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
          {nextCursor ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                // loadMore throws on a cursor failure — the journal keeps
                // its loaded pages; the owner gets the server text as a
                // toast (P3-2). The in-flight guard blocks double clicks.
                void launches.loadMore(nextCursor).catch((error: unknown) => {
                  toast.push({
                    kind: "error",
                    title: t("automation.journal.moreFailed"),
                    detail: error instanceof Error ? error.message : undefined,
                  });
                });
              }}
            >
              {t("automation.journal.more")}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

// Re-exported for tests: the parsed meta view type.
export type { ConditionMeta };
