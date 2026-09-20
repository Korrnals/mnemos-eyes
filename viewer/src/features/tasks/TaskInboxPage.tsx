import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Inbox, ScanSearch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { MemoryCardSkeleton } from "@/components/skeletons/Skeletons";
import { isTaskMutationSource, isTaskSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import type { TaskInboxEntry } from "@/gateway/boardTypes";
import { useI18n, useT } from "@/i18n";
import { formatTaskDate, priorityBadgeVariant, priorityLabelKey } from "./taskStatus";
import { useTaskMutations } from "./useTaskMutations";
import { useTaskInbox } from "./useTasks";

/**
 * `/tasks/inbox` — the AGG-1 mirror of `task:queue` records (ADR 0010):
 * read-only projections with provenance (server / project), NOT native
 * tasks. Ф3 wires the two mutations in: «Принять в борд» (POST adopt →
 * toast with an «открыть задачу» link; a 409 toast links the existing
 * task) and «Сканировать хранилища» (POST refresh, spinner, found/new
 * toast). Stale rows (the source stopped returning the record) are dimmed
 * and cannot be adopted; adopted rows return behind `?adopted=1`.
 */
export function TaskInboxPage() {
  const t = useT();
  const { lang } = useI18n();
  const gateway = useGateway();
  const capable = isTaskSource(gateway);
  const canMutate = isTaskMutationSource(gateway);
  const [searchParams, setSearchParams] = useSearchParams();
  const includeAdopted = searchParams.get("adopted") === "1";
  const inbox = useTaskInbox({ include_adopted: includeAdopted });
  const [scanning, setScanning] = useState(false);

  if (!capable) {
    return (
      <InboxShell>
        <EmptyState
          variant="empty"
          title={t("tasks.unavailableTitle")}
          message={t("tasks.unavailableMessage")}
        />
      </InboxShell>
    );
  }

  if (inbox.isPending) {
    return (
      <InboxShell>
        {canMutate ? <ScanButton scanning={scanning} onSetScanning={setScanning} /> : null}
        <div role="status" aria-label={t("tasks.inboxLoading")}>
          <MemoryCardSkeleton count={3} />
        </div>
      </InboxShell>
    );
  }

  if (inbox.isError) {
    return (
      <InboxShell>
        {canMutate ? <ScanButton scanning={scanning} onSetScanning={setScanning} /> : null}
        <EmptyState
          variant="error"
          title={t("tasks.inboxFailed")}
          message={inbox.error.message}
          action={
            <Button variant="outline" onClick={() => void inbox.refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
      </InboxShell>
    );
  }

  const items = inbox.data?.items ?? [];
  const active = items.filter((item) => !item.stale);
  const stale = items.filter((item) => item.stale);

  return (
    <InboxShell>
      {canMutate ? <ScanButton scanning={scanning} onSetScanning={setScanning} /> : null}

      {/* Adopted toggle — URL state (?adopted=1), honest checkbox semantics. */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-foreground-secondary">
          {t("tasks.inboxCount", { count: inbox.data?.count ?? 0 })}
          {inbox.data?.refreshed_at ? (
            <span className="ml-2 text-xs text-foreground-muted">
              {t("tasks.inboxRefreshed", {
                time: formatTaskDate(inbox.data.refreshed_at, lang),
              })}
            </span>
          ) : null}
        </p>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground-secondary">
          <input
            type="checkbox"
            checked={includeAdopted}
            onChange={(event) =>
              setSearchParams(
                (prev) => {
                  const next = new URLSearchParams(prev);
                  if (event.target.checked) next.set("adopted", "1");
                  else next.delete("adopted");
                  return next;
                },
                { replace: false },
              )
            }
            className="size-4 accent-[var(--color-iris-bright)]"
          />
          {t("tasks.inboxShowAdopted")}
        </label>
      </div>

      {items.length === 0 ? (
        <EmptyState
          variant="empty"
          title={t("tasks.inboxEmpty")}
          message={t("tasks.inboxEmptyHint")}
        />
      ) : (
        <>
          <ul className="space-y-2" aria-label={t("tasks.inboxLabel")}>
            {active.map((item) => (
              <li key={item.memory_id}>
                <InboxCard item={item} lang={lang} canAdopt={canMutate} />
              </li>
            ))}
          </ul>
          {stale.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs text-foreground-muted">{t("tasks.inboxStaleNote")}</p>
              <ul className="space-y-2 opacity-60" aria-label={t("tasks.inboxStaleLabel")}>
                {stale.map((item) => (
                  <li key={item.memory_id}>
                    <InboxCard item={item} lang={lang} canAdopt={false} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </InboxShell>
  );
}

function InboxShell({ children }: { children: React.ReactNode }) {
  const t = useT();
  return (
    <section aria-labelledby="inbox-title" className="mx-auto max-w-3xl space-y-4">
      <h1 id="inbox-title" className="flex items-center gap-2 text-xl font-semibold">
        <Inbox className="size-5" aria-hidden="true" />
        {t("tasks.inboxTitle")}
      </h1>
      {children}
    </section>
  );
}

/**
 * «Сканировать хранилища» — POST /api/tasks/inbox/refresh (Ф3). The spinner
 * spans click → toast, or click → token panel when the gate defers the run
 * (`onSettled` fires either way — refreshInbox's contract); `aria-busy`
 * carries the state to screen readers.
 */
function ScanButton({
  scanning,
  onSetScanning,
}: {
  scanning: boolean;
  onSetScanning: (scanning: boolean) => void;
}) {
  const t = useT();
  const { refreshInbox } = useTaskMutations();
  return (
    <div className="flex flex-wrap items-center gap-2" aria-busy={scanning}>
      <Button
        variant="outline"
        size="sm"
        disabled={scanning}
        onClick={() => {
          onSetScanning(true);
          refreshInbox(() => onSetScanning(false));
        }}
      >
        <ScanSearch className={"size-4" + (scanning ? " animate-spin" : "")} aria-hidden="true" />
        {scanning ? t("tasks.scanBusy") : t("tasks.scanLabel")}
      </Button>
    </div>
  );
}

function InboxCard({
  item,
  lang,
  canAdopt,
}: {
  item: TaskInboxEntry;
  lang: "ru" | "en";
  canAdopt: boolean;
}) {
  const t = useT();
  const { adoptInboxItem } = useTaskMutations();
  const adoptable = canAdopt && !item.stale && !item.adopted;
  return (
    <article className="min-h-row rounded-md border border-border-subtle bg-well px-3 py-2 text-sm shadow-well">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={priorityBadgeVariant(item.priority)}>
          {t(priorityLabelKey(item.priority))}
        </Badge>
        <Badge variant="outline">{t("tasks.inboxSource", { server: item.server })}</Badge>
        {item.project ? <Badge variant="default">{item.project}</Badge> : null}
        {item.adopted && item.adopted_task_id ? (
          <Link
            to={`/tasks/${encodeURIComponent(item.adopted_task_id)}`}
            className="text-xs text-iris-bright underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
          >
            {t("tasks.inboxAdoptedLink", { id: item.adopted_task_id })}
          </Link>
        ) : null}
        <span className="ml-auto whitespace-nowrap text-xs text-foreground-muted">
          {formatTaskDate(item.created_at, lang)}
        </span>
      </div>
      <h2 className="mt-1 font-medium">{item.title}</h2>
      {item.excerpt ? (
        <p className="mt-0.5 line-clamp-2 text-xs text-foreground-secondary">{item.excerpt}</p>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-foreground-muted">
          {item.specialist || t("tasks.inboxNoSpecialist")}
        </p>
        {adoptable ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => adoptInboxItem(item.memory_id)}
          >
            <Inbox className="size-4" aria-hidden="true" />
            {t("tasks.adoptLabel")}
          </Button>
        ) : null}
      </div>
    </article>
  );
}
