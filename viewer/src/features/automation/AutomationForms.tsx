import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { ConditionItem, HookCreateInput, ScheduleCreateInput } from "@/gateway/boardTypes";
import { INTERVAL_PRESETS, KNOWN_HARNESSES } from "@/gateway/harnesses";
import { useT } from "@/i18n";
import { ConditionEditor } from "./ConditionEditor";
import type { ConditionMeta } from "./conditionMeta";

/**
 * Rule creation dialogs (SCHED-1 v1, ADR 0013 §8): NO cron UI (the daily
 * trigger is a time input, the interval a curated preset select), NO
 * templates. CONTRACT NOTE: `ScheduleCreate` carries NO condition field —
 * conditions are the HOOK contract (ConditionItem lives in hooks); a
 * schedule's "условие" in the UI is its TRIGGER (daily/interval + value).
 * The condition triple therefore lives in the HOOK form only, over the
 * server meta dictionary. `on`/`action` selects are the server whitelists.
 */

const FIELD_CLASS =
  "h-8 w-full rounded-md border border-border bg-background px-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright";

export function ScheduleFormDialog({
  open,
  onOpenChange,
  taskIds,
  specialists,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Task-id candidates from the board projection (datalist). */
  taskIds: readonly string[];
  /** Specialist candidates (datalist, same union as the assign sheet). */
  specialists: readonly string[];
  onCreate: (payload: ScheduleCreateInput) => void;
}) {
  // Keyed mount posture (EditTaskDialog): the dialog gates on `open`, the
  // inner form seeds once — no reset effects.
  if (!open) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <ScheduleForm
          taskIds={taskIds}
          specialists={specialists}
          onDone={() => onOpenChange(false)}
          onCreate={onCreate}
        />
      </DialogContent>
    </Dialog>
  );
}

function ScheduleForm({
  taskIds,
  specialists,
  onDone,
  onCreate,
}: {
  taskIds: readonly string[];
  specialists: readonly string[];
  onDone: () => void;
  onCreate: (payload: ScheduleCreateInput) => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [taskId, setTaskId] = useState("");
  const [specialist, setSpecialist] = useState("");
  const [harness, setHarness] = useState<string>("zcode");
  const [triggerKind, setTriggerKind] = useState<"daily" | "interval">("daily");
  const [dailyAt, setDailyAt] = useState("09:00");
  const [interval, setInterval] = useState<string>("PT12H");
  const [submitting, setSubmitting] = useState(false);

  const submit = (): void => {
    if (name.trim().length === 0 || taskId.trim().length === 0 || submitting) return;
    setSubmitting(true);
    onCreate({
      name: name.trim(),
      target_kind: "task",
      task_id: taskId.trim(),
      specialist: specialist.trim(),
      harness,
      executor_id: "",
      trigger_kind: triggerKind,
      trigger_value: triggerKind === "daily" ? dailyAt : interval,
      window_from: null,
      window_to: null,
      // Owner-rare knobs the server owns: sane v1 defaults.
      max_runs_per_day: 1,
      cooldown_s: 3600,
    });
    setSubmitting(false);
    onDone();
  };

  return (
    <>
      <DialogTitle>{t("automation.schedule.title")}</DialogTitle>
      <DialogDescription className="-mt-2 text-xs text-foreground-muted">
        {t("automation.schedule.subtitle")}
      </DialogDescription>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
          {t("automation.form.nameLabel")}
          <input
            id="schedule-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={FIELD_CLASS}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
          {t("automation.form.taskLabel")}
          <input
            id="schedule-task"
            value={taskId}
            list="schedule-task-choices"
            onChange={(event) => setTaskId(event.target.value)}
            className={FIELD_CLASS}
          />
          <datalist id="schedule-task-choices">
            {taskIds.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
          {t("automation.form.specialistLabel")}
          <input
            id="schedule-specialist"
            value={specialist}
            list="schedule-specialist-choices"
            onChange={(event) => setSpecialist(event.target.value)}
            className={FIELD_CLASS}
          />
          <datalist id="schedule-specialist-choices">
            {specialists.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
          {t("automation.form.harnessLabel")}
          <select
            id="schedule-harness"
            value={harness}
            onChange={(event) => setHarness(event.target.value)}
            className={FIELD_CLASS}
          >
            {KNOWN_HARNESSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
          {t("automation.form.triggerKindLabel")}
          <select
            id="schedule-trigger-kind"
            value={triggerKind}
            onChange={(event) => setTriggerKind(event.target.value as "daily" | "interval")}
            className={FIELD_CLASS}
          >
            <option value="daily">{t("automation.form.triggerDaily")}</option>
            <option value="interval">{t("automation.form.triggerInterval")}</option>
          </select>
        </label>
        {triggerKind === "daily" ? (
          <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
            {t("automation.form.triggerAtLabel")}
            <input
              id="schedule-daily-at"
              type="time"
              value={dailyAt}
              onChange={(event) => setDailyAt(event.target.value)}
              className={FIELD_CLASS}
            />
          </label>
        ) : (
          <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
            {t("automation.form.triggerEveryLabel")}
            <select
              id="schedule-interval"
              value={interval}
              onChange={(event) => setInterval(event.target.value)}
              className={FIELD_CLASS}
            >
              {INTERVAL_PRESETS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p className="text-xs text-foreground-muted">
        {t("automation.form.scheduleTriggerNote")}
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          {t("agents.sheet.cancel")}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={submit}
          disabled={submitting || name.trim().length === 0 || taskId.trim().length === 0}
        >
          {t("automation.form.create")}
        </Button>
      </div>
    </>
  );
}

export function HookFormDialog({
  open,
  onOpenChange,
  meta,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meta: ConditionMeta | null;
  onCreate: (payload: HookCreateInput) => void;
}) {
  if (!open) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <HookForm onDone={() => onOpenChange(false)} meta={meta} onCreate={onCreate} />
      </DialogContent>
    </Dialog>
  );
}

function HookForm({
  meta,
  onDone,
  onCreate,
}: {
  meta: ConditionMeta | null;
  onDone: () => void;
  onCreate: (payload: HookCreateInput) => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [on, setOn] = useState(meta?.events[0] ?? "");
  const [action, setAction] = useState(meta?.actions[0] ?? "notify");
  const [clauses, setClauses] = useState<readonly ConditionItem[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const submit = (): void => {
    if (name.trim().length === 0 || on.length === 0 || submitting) return;
    setSubmitting(true);
    onCreate({
      name: name.trim(),
      on,
      condition: [...clauses],
      // v1: the default allowlist per action comes from the server when the
      // field is omitted server-side; the wire contract accepts undefined.
      action,
      cooldown_s: 300,
      budget: 4,
    } as HookCreateInput);
    setSubmitting(false);
    onDone();
  };

  return (
    <>
      <DialogTitle>{t("automation.hook.title")}</DialogTitle>
      <DialogDescription className="-mt-2 text-xs text-foreground-muted">
        {t("automation.hook.subtitle")}
      </DialogDescription>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
          {t("automation.form.nameLabel")}
          <input
            id="hook-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={FIELD_CLASS}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
          {t("automation.form.onLabel")}
          <select
            id="hook-on"
            value={on}
            onChange={(event) => setOn(event.target.value)}
            className={FIELD_CLASS}
          >
            {(meta?.events ?? []).map((event) => (
              <option key={event} value={event}>
                {event}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
          {t("automation.form.actionLabel")}
          <select
            id="hook-action"
            value={action}
            onChange={(event) => setAction(event.target.value)}
            className={FIELD_CLASS}
          >
            {(meta?.actions ?? []).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className="rounded-md border border-border-subtle p-3">
        <legend className="px-1 text-sm font-medium">
          {t("automation.form.conditionLabel")}
        </legend>
        <ConditionEditor meta={meta} clauses={clauses} onChange={setClauses} idPrefix="hook" />
        <p className="mt-1 text-xs text-foreground-muted">
          {t("automation.form.conditionNote")}
        </p>
      </fieldset>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          {t("agents.sheet.cancel")}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={submit}
          disabled={submitting || name.trim().length === 0 || on.length === 0}
        >
          {t("automation.form.create")}
        </Button>
      </div>
    </>
  );
}
