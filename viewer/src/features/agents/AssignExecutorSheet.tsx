import { useMemo, useState } from "react";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { BoardTask, ExecutorItem } from "@/gateway/boardTypes";
import { KNOWN_HARNESSES } from "@/gateway/harnesses";
import { resolveRoutingAnnotation } from "@/gateway/routing";
import { useI18n, useT } from "@/i18n";
import type { TranslationKey } from "@/i18n";
import { formatTaskDate } from "@/features/tasks/taskStatus";
import { useBoardTasks } from "@/features/tasks/useTasks";
import { useValidationNow } from "@/features/tasks/useValidationClock";
import { formatAge } from "./assignmentStatus";
import { useExecutors, useExecutionSettings } from "./useAgents";
import { useAssignmentMutations } from "./useAssignmentMutations";

/**
 * AssignExecutorSheet (ARCH-8, spec §2.3 — matrix A of concept §4.4 plus the
 * executor step): the ONLY place assignments are created (spec §2.4 — on the
 * task, never in the section). Two steps in one sheet — specialist + harness,
 * then executor («По умолчанию» | a concrete one) — with a LIVE route preview
 * computed client-side by the SAME resolver the server annotation uses
 * (gateway/routing.ts). Honesty rules baked in:
 * - the preview is LABELLED a preview; the fact is who claims (claimed_by);
 * - no silent substitution: the default resolves even when offline, the wait
 *   is spelled out and the submit button stays ACTIVE (spec §2.3);
 * - offline/pending/revoked/disabled executors stay VISIBLE but disabled,
 *   each with its reason; tooltips carry capabilities/transport/last-seen;
 * - executor identity is declared-unverified (spec §2.2) — every tooltip
 *   says so; the task row's chip repeats it on the fact itself.
 */

export interface AssignPrefill {
  readonly specialist: string;
  readonly harness: string;
}

/** Can this executor be an explicit target right now? (§2.3 picker rules) */
function selectableExecutor(executor: ExecutorItem): boolean {
  return executor.state === "approved" && executor.enabled && executor.presence !== "offline";
}

/**
 * AGW-6 A.3 pin rule: a PINNED approved+enabled executor stays selectable
 * even while OFFLINE — that is the link-test case («не отвечает» → send a
 * real task, the queue waits, the claim proves the link). Pending/revoked/
 * disabled stay unselectable in every case: routing can never pick them,
 * the pin would be a lie.
 */
function selectablePinnedExecutor(executor: ExecutorItem, pinned: boolean): boolean {
  if (pinned) return executor.state === "approved" && executor.enabled;
  return selectableExecutor(executor);
}

/** Short tier label (the same strings row signatures use). */
function routingReasonTextKey(reason: string): TranslationKey {
  switch (reason) {
    case "explicit":
      return "agents.routing.reason.explicit";
    case "specialist":
      return "agents.routing.reason.specialist";
    case "task-specialists":
      return "agents.routing.reason.taskSpecialists";
    case "project-default":
      return "agents.routing.reason.projectDefault";
    case "global-default":
      return "agents.routing.reason.globalDefault";
    case "auto":
      return "agents.routing.reason.auto";
    default:
      return "agents.routing.reason.unmatched";
  }
}

export function AssignExecutorSheet({
  task,
  open,
  onOpenChange,
  prefill = null,
  pinnedExecutorId = null,
}: {
  task: BoardTask;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Retry prefill (failed/expired «Перезапустить») — same parameters again. */
  prefill?: AssignPrefill | null;
  /** AGW-6 A.3 link-test pin: pre-select this executor (deep-link
   * `?assign=<id>` from the link-check second stage). */
  pinnedExecutorId?: string | null;
}) {
  // The form is a keyed inner component (EditTaskDialog pattern): opening
  // the sheet mounts it fresh — state seeds from the task/prefill through
  // useState initializers, no reset effect. The key carries the prefill
  // identity, so a retry with different parameters remounts re-seeded.
  if (!open) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <AssignExecutorForm
          key={`${prefill?.specialist ?? ""}|${prefill?.harness ?? ""}|${pinnedExecutorId ?? ""}`}
          task={task}
          prefill={prefill}
          pinnedExecutorId={pinnedExecutorId}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function AssignExecutorForm({
  task,
  prefill,
  pinnedExecutorId,
  onDone,
}: {
  task: BoardTask;
  prefill: AssignPrefill | null;
  pinnedExecutorId: string | null;
  onDone: () => void;
}) {
  const t = useT();
  const { lang } = useI18n();
  const now = useValidationNow();
  const executors = useExecutors();
  const settings = useExecutionSettings();
  const board = useBoardTasks();
  const mutations = useAssignmentMutations();
  // Fresh-open seeds; retry runs carry the failed attempt's parameters
  // verbatim (spec §3.1 CTA). The link-test pin pre-selects its executor.
  const [specialist, setSpecialist] = useState(
    prefill?.specialist ?? task.specialists[0] ?? "",
  );
  const [harness, setHarness] = useState<string>(prefill?.harness ?? "zcode");
  const [executorChoice, setExecutorChoice] = useState<string>(
    pinnedExecutorId ?? "default",
  );
  const [submitting, setSubmitting] = useState(false);

  /** Specialist candidates: the task's own first, then the board union. */
  const specialistChoices = useMemo(() => {
    const own = task.specialists.filter((name) => name.trim().length > 0);
    const union = new Set<string>(own);
    for (const row of board.data?.tasks ?? []) {
      for (const name of row.specialists ?? []) {
        if (name.trim().length > 0) union.add(name);
      }
    }
    return { own, rest: [...union].filter((name) => !own.includes(name)).sort() };
  }, [task.specialists, board.data]);

  const executorRows = executors.data?.items ?? [];
  const executorName = (id: string): string =>
    executorRows.find((row) => row.id === id)?.name ?? id;

  // --- P2: the pin is a CLAIM, never a lie ----------------------------------
  // The server stores executor_id as a plain designation (no eligibility
  // check at create; eligibility applies at claim). A deep-link pin on a
  // pending/revoked/disabled executor would queue an assignment nobody can
  // ever claim — holding the ≤1-active slot until manual cleanup. So the
  // pin may only SURVIVE when it is routable (approved+enabled; offline is
  // the ratified link-test case — the queue waits).
  const pinnedRow = pinnedExecutorId
    ? (executorRows.find((executor) => executor.id === pinnedExecutorId) ?? null)
    : null;
  const pinSelectable =
    pinnedRow !== null && pinnedRow.state === "approved" && pinnedRow.enabled;

  /**
   * The choice that would ACTUALLY travel (submit guard, second line of
   * defense behind the disabled radio):
   * - the owner moved off the pin themselves → their choice stands;
   * - no pin → the seeded/selected default;
   * - pin selectable → the pin (offline allowed);
   * - pin row GONE from the registry (deleted) → honest fallback to
   *   default — there is no executor to show, nothing to stand on;
   * - pin row exists but is NOT routable → null: submit BLOCKED, the
   *   pinned radio stays checked-but-disabled, the hint names the way out
   *   (pick «Default» or another executor). No silent substitution.
   */
  const effectiveChoice = ((): string | null => {
    if (pinnedExecutorId === null || executorChoice !== pinnedExecutorId) {
      return executorChoice;
    }
    if (pinSelectable) return pinnedExecutorId;
    if (pinnedRow === null) return "default";
    return null;
  })();
  const pinBlocked = effectiveChoice === null;

  /**
   * LIVE preview — the shared resolver over the live registry + settings.
   * The project-default tier is server-only data (no endpoint); the preview
   * label carries that honesty. The preview resolves from the EFFECTIVE
   * choice — a blocked pin never produces a lying «route: X» preview.
   */
  const preview = resolveRoutingAnnotation({
    pin: effectiveChoice !== null && effectiveChoice !== "default" ? effectiveChoice : "",
    specialist,
    taskSpecialists: task.specialists,
    executors: executorRows,
    globalDefault: settings.data?.default_executor ?? "",
  });
  const previewExecutor =
    preview.resolved === null
      ? null
      : (executorRows.find((row) => row.id === preview.resolved) ?? null);
  const previewWaits = previewExecutor !== null && previewExecutor.presence === "offline";

  const submit = (): void => {
    const value = specialist.trim();
    // P2 second line: a blocked pin NEVER reaches the wire.
    if (value.length === 0 || submitting || effectiveChoice === null) return;
    setSubmitting(true);
    mutations.createAssignment(
      task,
      {
        task_id: task.id,
        specialist: value,
        harness,
        executor_id: effectiveChoice === "default" ? "" : effectiveChoice,
      },
      {
        onQueued: onDone,
        onDeferred: () => setSubmitting(false),
        onSettled: () => setSubmitting(false),
      },
    );
  };

  return (
    <>
      <DialogTitle>{t("agents.sheet.title")}</DialogTitle>
      {/* AGW-2 review P3-3: the visible subtitle IS the DialogDescription —
       * Radix links it via aria-describedby (no console warning, richer SR);
       * one text, no sr-only duplicate. */}
      <DialogDescription className="-mt-2 text-xs text-foreground-muted">
        {t("agents.sheet.subtitle", { id: task.id })}
      </DialogDescription>

        {/* Step 1: specialist (free entry + datalist of known roles — the
         * API has no specialist directory, the board union IS the candidate
         * list) and harness (server allowlist mirror). */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="assign-specialist" className="mb-1 block text-sm font-medium">
              {t("agents.sheet.specialistLabel")}
            </label>
            <input
              id="assign-specialist"
              value={specialist}
              onChange={(event) => setSpecialist(event.target.value)}
              list="assign-specialist-choices"
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
            />
            <datalist id="assign-specialist-choices">
              {specialistChoices.own.map((name) => (
                <option key={name} value={name} />
              ))}
              {specialistChoices.rest.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>
          <div>
            <label htmlFor="assign-harness" className="mb-1 block text-sm font-medium">
              {t("agents.sheet.harnessLabel")}
            </label>
            <select
              id="assign-harness"
              value={harness}
              onChange={(event) => setHarness(event.target.value)}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
            >
              {KNOWN_HARNESSES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Step 2: executor — «По умолчанию» first, then the registry.
         * Fieldset/radio semantics — keyboard and SR paths for free. */}
        <fieldset className="rounded-md border border-border-subtle p-3">
          <legend className="px-1 text-sm font-medium">
            {t("agents.sheet.executorLabel")}
          </legend>
          <div className="max-h-56 space-y-1 overflow-y-auto">
            <label className="flex cursor-pointer items-start gap-2 rounded-sm p-1.5 hover:bg-elevated">
              <input
                type="radio"
                name="assign-executor"
                /* The EFFECTIVE default: also lit when a deleted pin fell
                 * back silently — the owner always sees what will travel. */
                checked={effectiveChoice === "default"}
                onChange={() => setExecutorChoice("default")}
                className="mt-1 accent-iris-bright"
              />
              <span className="text-sm">
                <span className="font-medium">{t("agents.sheet.defaultExecutor")}</span>
                <span className="block text-xs text-foreground-secondary">
                  {settings.data?.default_executor
                    ? t("agents.sheet.defaultExecutorName", {
                        name: executorName(settings.data.default_executor),
                      })
                    : t("agents.sheet.defaultExecutorNone")}
                </span>
              </span>
            </label>
            {executorRows.map((executor) => {
              const isPin = executor.id === pinnedExecutorId;
              const selectable = selectablePinnedExecutor(executor, isPin);
              // A BLOCKED pin keeps its radio checked-but-disabled: the
              // owner sees exactly what the deep-link named and why the
              // submit is held (no silent substitution, no dead-looking UI).
              const checked = executorChoice === executor.id || (isPin && executorChoice === pinnedExecutorId);
              return (
                <label
                  key={executor.id}
                  title={executorTooltip(executor, t, lang)}
                  className={
                    "flex items-start gap-2 rounded-sm p-1.5 " +
                    (selectable
                      ? "cursor-pointer hover:bg-elevated"
                      : "cursor-not-allowed opacity-70")
                  }
                >
                  <input
                    type="radio"
                    name="assign-executor"
                    checked={checked}
                    disabled={!selectable}
                    onChange={() => setExecutorChoice(executor.id)}
                    className="mt-1 accent-iris-bright"
                  />
                  <span className="min-w-0 text-sm">
                    <span className="font-medium">{executor.name}</span>
                    <span className="block text-xs text-foreground-secondary">
                      {selectable
                        ? executorMeta(executor, t)
                        : executorDisabledReason(executor, t, now)}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {/* Link-test pin: the honest wait spelled out at the pin itself —
           * or, when the pin is unroutable, the way out named just as
           * plainly (P2: the slot must not be held by a ghost). */}
          {pinnedExecutorId !== null ? (
            <p className="mt-1 border-t border-border-subtle pt-1 text-xs text-foreground-muted">
              {pinBlocked ? t("agents.sheet.pinnedInvalidHint") : t("agents.sheet.pinnedHint")}
            </p>
          ) : null}
        </fieldset>

        {/* LIVE route preview (aria-live: the route changes with selections). */}
        <div
          aria-live="polite"
          className="rounded-md border border-border-subtle bg-elevated p-3 text-sm"
        >
          <p className="flex items-center gap-1 text-xs font-medium text-foreground-secondary">
            <Info className="size-3.5" aria-hidden="true" />
            {t("agents.routing.previewLabel")}
          </p>
          {preview.resolved !== null ? (
            <p className="mt-1">
              {t("agents.routing.previewResolved", {
                name: executorName(preview.resolved),
                reason: t(routingReasonTextKey(preview.reason)),
              })}
              {previewWaits ? (
                <span className="mt-0.5 block text-xs text-warning">
                  {t("agents.routing.previewWaits")}
                </span>
              ) : null}
            </p>
          ) : (
            <p className="mt-1">{t("agents.routing.previewUnmatched")}</p>
          )}
          <p className="mt-1 text-xs text-foreground-muted">
            {t("agents.routing.previewNote")}
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onDone}>
            {t("agents.sheet.cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={submit}
            disabled={submitting || specialist.trim().length === 0 || pinBlocked}
          >
            {submitting ? t("agents.sheet.submitting") : t("agents.sheet.submit")}
          </Button>
        </div>
    </>
  );
}

/** Tooltip: capabilities · transport · last seen · the unverified note. */
function executorTooltip(
  executor: ExecutorItem,
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string,
  lang: "ru" | "en",
): string {
  const caps =
    executor.capabilities.length > 0
      ? executor.capabilities.join(", ")
      : t("agents.executor.noCapabilities");
  const seen = executor.last_seen
    ? formatTaskDate(executor.last_seen, lang)
    : t("agents.executor.neverSeen");
  return [
    caps,
    executor.transport,
    `${t("agents.executor.lastSeen")}: ${seen}`,
    t("agents.identity.tooltip"),
  ].join(" · ");
}

/** Selectable-row meta line: the declared capabilities (what it can take). */
function executorMeta(
  executor: ExecutorItem,
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string,
): string {
  return executor.capabilities.length > 0
    ? executor.capabilities.join(", ")
    : t("agents.executor.noCapabilities");
}

/** Why a registry row is not selectable (§2.3: visible, disabled, reasoned). */
function executorDisabledReason(
  executor: ExecutorItem,
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string,
  now: number,
): string {
  if (executor.state === "pending") return t("agents.executor.pendingReason");
  if (executor.state === "revoked") return t("agents.executor.revokedReason");
  if (!executor.enabled) return t("agents.executor.disabledReason");
  if (executor.presence === "offline") {
    const age = executor.last_seen ? formatAge(executor.last_seen, now) : null;
    return age
      ? t("agents.executor.offlineReason", {
          age: `${age.display} ${t(age.unitKey)}`,
        })
      : t("agents.executor.neverSeen");
  }
  return t("agents.executor.noCapabilities");
}
