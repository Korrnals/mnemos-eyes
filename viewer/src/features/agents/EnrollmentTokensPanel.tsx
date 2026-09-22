import { Check, KeyRound, ScrollText, Settings2 } from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import type { EnrollmentItem, ExecutorItem } from "@/gateway/boardTypes";
import { useT } from "@/i18n";
import type { TranslationKey } from "@/i18n";
import { useValidationNow } from "@/features/tasks/useValidationClock";
import { effectiveEnrollmentState, formatTtlCountdown } from "./enrollment";
import { useEnrollmentActions, useHonestCopy } from "./useEnrollment";

/**
 * The persistent token-status panel under the registry (AGW-5 phase 2):
 * live tokens countdown, terminal history stays visible for the audit
 * trail (the GET returns created + terminal). The list query is ui-gated —
 * without a stored owner token the panel shows its honest login hint, and
 * every enrollment.* SSE frame refreshes it through the bridge's
 * invalidation (the panel never polls).
 *
 * A used token links to the executor it minted: `enrollment.used` carries
 * the executor_id, the minted row shows up in the registry as pending (the
 * existing approve path — NO second confirm in this protocol).
 */
export function EnrollmentTokensPanel({
  enrollments,
  executors,
  tokenPresent,
  loading,
  error,
}: {
  enrollments: readonly EnrollmentItem[];
  executors: readonly ExecutorItem[];
  tokenPresent: boolean;
  loading: boolean;
  error: boolean;
}) {
  const t = useT();
  const actions = useEnrollmentActions();

  // Newest first — the queue the owner works top-down.
  const rows = [...enrollments].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );

  return (
    <section
      aria-label={t("agents.enrollment.listTitle")}
      className="rounded-md border border-border-subtle bg-well shadow-well"
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <KeyRound className="size-4 text-foreground-secondary" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground-secondary">
          {t("agents.enrollment.listTitle")}
        </p>
        <span className="font-mono text-xs text-foreground-muted">{rows.length}</span>
        <span className="ml-auto flex items-center gap-1 text-xs text-foreground-muted">
          <ScrollText className="size-3.5" aria-hidden="true" />
          {t("agents.enrollment.listHint")}
        </span>
      </div>

      {!tokenPresent ? (
        <p className="border-t border-border-subtle px-3 py-2 text-sm text-foreground-muted">
          {t("agents.enrollment.loginHint")}
        </p>
      ) : loading ? (
        <p role="status" className="border-t border-border-subtle px-3 py-2 text-sm text-foreground-muted">
          {t("agents.enrollment.listLoading")}
        </p>
      ) : error ? (
        <p role="alert" className="border-t border-border-subtle px-3 py-2 text-sm text-error">
          {t("agents.enrollment.listFailed")}
        </p>
      ) : rows.length === 0 ? (
        <p className="border-t border-border-subtle px-3 py-2 text-sm text-foreground-muted">
          {t("agents.enrollment.empty")}
        </p>
      ) : (
        <ul className="space-y-1 border-t border-border-subtle px-2 py-1.5">
          {rows.map((row) => (
            <EnrollmentRow
              key={row.enrollment_id}
              row={row}
              executors={executors}
              onRevoke={() => actions.revokeEnrollment(row)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One token row: label · mono id · state · TTL/executor link · revoke. */
function EnrollmentRow({
  row,
  executors,
  onRevoke,
}: {
  row: EnrollmentItem;
  executors: readonly ExecutorItem[];
  onRevoke: () => void;
}) {
  const t = useT();
  const now = useValidationNow();
  const state = effectiveEnrollmentState(row, now);
  const ttl = formatTtlCountdown(row, now);
  const stateKey: TranslationKey = `agents.enrollment.state.${state}`;
  const minted = row.executor_id
    ? executors.find((executor) => executor.id === row.executor_id) ?? null
    : null;
  // Review P2-2: the flash fires ONLY on a resolved write; a failure is
  // shown inline (the id stays visible in the row for manual selection).
  const { copied, failed, copy } = useHonestCopy(1500);

  const copyId = (): void => {
    copy("id", row.enrollment_id);
  };

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-sm px-1 py-1 text-sm">
      <span className="min-w-0 max-w-48 truncate font-medium">
        {row.label || row.name_hint || row.enrollment_id}
      </span>
      <button
        type="button"
        onClick={copyId}
        title={t("agents.menu.copyId", { id: row.enrollment_id })}
        className="min-w-0 truncate rounded-sm font-mono text-xs text-foreground-muted underline-offset-2 hover:text-foreground hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
      >
        {copied ? <Check className="inline size-3" aria-hidden="true" /> : null}
        {row.enrollment_id}
      </button>
      {failed ? (
        <span role="alert" className="text-xs text-error">
          {t("agents.enrollment.copyFailed")}
        </span>
      ) : null}

      {/* The state, in words (WCAG 1.4.1): live = neutral, used = iris-ish
       * neutral emphasis, dead = muted. No new colours — foreground only. */}
      <span
        className={
          "text-xs " +
          (state === "created"
            ? "text-foreground-secondary"
            : state === "used"
              ? "text-foreground-secondary"
              : "text-foreground-muted")
        }
        title={
          state === "used" && row.used_ip
            ? t("agents.enrollment.usedIp", { ip: row.used_ip })
            : undefined
        }
      >
        {t(stateKey)}
        {state === "created" && ttl !== null ? (
          <span className="ml-1 font-mono">{ttl}</span>
        ) : null}
      </span>

      {/* used → the minted executor (name from the registry; the row id in
       * mono keeps the link honest even while the registry refetch lags).
       * AGW-6 B: the deep-link opens the row's SETTINGS CARD (the hash the
       * registry page consumes into the drawer) — the enrollment flow's
       * «Открыть карточку»: at mint time no row exists, the card offer
       * becomes real the moment the token is USED. */}
      {state === "used" ? (
        <span className="flex min-w-0 items-center gap-1 text-xs text-foreground-secondary">
          {t("agents.enrollment.usedBy", { name: minted?.name ?? row.executor_id })}
          <Link
            to={`/agents/harnesses#executor-${encodeURIComponent(row.executor_id)}`}
            className="rounded-sm font-mono text-xs text-foreground underline-offset-2 hover:text-iris-bright hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
          >
            {row.executor_id}
          </Link>
          {minted ? (
            <Link
              to={`/agents/harnesses#executor-sheet-${encodeURIComponent(row.executor_id)}`}
              className="flex items-center gap-1 rounded-sm text-xs text-foreground underline-offset-2 hover:text-iris-bright hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
            >
              <Settings2 className="size-3" aria-hidden="true" />
              {t("agents.card.menuOpen")}
            </Link>
          ) : null}
        </span>
      ) : null}

      {state === "created" ? (
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 px-2 text-xs"
          onClick={onRevoke}
        >
          {t("agents.enrollment.revoke")}
        </Button>
      ) : null}
    </li>
  );
}
