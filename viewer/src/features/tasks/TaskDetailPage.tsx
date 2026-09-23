import { useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { Cog, FileText, History, Layers, PencilLine, Play, ScrollText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { MemoryCardSkeleton, TableRowSkeleton } from "@/components/skeletons/Skeletons";
import { TextEngine } from "@/components/TextEngine";
import { TaskExecutionTab } from "@/features/agents/TaskExecutionTab";
import { isTaskMutationSource, isTaskSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import type { BoardTask, TaskHistory, TaskMemories } from "@/gateway/boardTypes";
import { useI18n, useT } from "@/i18n";
import type { TranslationKey } from "@/i18n";
import { withReturn } from "@/lib/returnParams";
import {
  formatTaskDate,
  historyEventLabelKey,
  priorityBadgeVariant,
  priorityLabelKey,
  statusBadgeVariant,
  statusLabelKey,
} from "./taskStatus";
import { EditTaskDialog } from "./EditTaskDialog";
import { useTaskMutations } from "./useTaskMutations";
import {
  useArchivedTask,
  useSyncReportCount,
  useTask,
  useTaskHistory,
  useTaskMemories,
  useTaskReports,
} from "./useTasks";

/**
 * `/tasks/:id` — the task PAGE (concept §4.1: a route, not the board's modal
 * stack; tabs are URL state `?tab=reports|history|memory|details`, default
 * «Отчёты»). The row comes from the shared `tasks.board` projection (no
 * single-task GET exists — see useTasks.ts). Ф3 adds the mutation header:
 * «Изменить» (content edit, BE-12 force path inside) and UI-8 «Вернуть в
 * работу» on a live final report (PATCH status=in-progress — the column
 * never moves).
 *
 * UI-18 pair 4: when the board projection misses the id AND the task lives
 * in the archive, the page renders from the archive row (`useArchivedTask`
 * probe — the wire has no archived single GET). Tab links preserve `?return=`
 * and every other param (spec §2.2 rule 4): the first tab click must not
 * kill the back context.
 */

const TASK_TABS = [
  { id: "reports", key: "tasks.tabReports" as const, icon: ScrollText },
  { id: "history", key: "tasks.tabHistory" as const, icon: History },
  { id: "memory", key: "tasks.tabMemory" as const, icon: Layers },
  { id: "details", key: "tasks.tabDetails" as const, icon: FileText },
  // AGW-2 (spec §2.4): the execution depth of the task — assignments queue,
  // «Взять в работу», cancel/retry. Deep link target of the card badge.
  { id: "execution", key: "tasks.tabExecution" as const, icon: Cog },
] as const;

type TaskTabId = (typeof TASK_TABS)[number]["id"];

function isTaskTabId(value: string): value is TaskTabId {
  return TASK_TABS.some((tab) => tab.id === value);
}

export function TaskDetailPage() {
  const t = useT();
  const { lang } = useI18n();
  const gateway = useGateway();
  const capable = isTaskSource(gateway);
  const canMutate = isTaskMutationSource(gateway);
  const { id } = useParams<{ id: string }>();
  const task = useTask(id);
  // UI-18 pair 4: archived rows miss the board projection — probe the
  // archive ONLY after the board query settled empty (no extra wire call on
  // the happy path).
  const archived = useArchivedTask(id, task.isSuccess && task.data === undefined);
  // UI-8 needs the reports anyway (the «Отчёты» tab loads the same key —
  // one wire call, no extra request for the header decision).
  const reports = useTaskReports(id);
  const { resumeTask } = useTaskMutations();
  const [editOpen, setEditOpen] = useState(false);
  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get("tab") ?? "reports";
  const tab: TaskTabId = isTaskTabId(tabParam) ? tabParam : "reports";
  // Tabs inherit the WHOLE current query (return=, …) and swap only `tab`
  // (spec §2.2 rule 4).
  const tabHref = (tabId: TaskTabId) => {
    const params = new URLSearchParams(searchParams);
    params.set("tab", tabId);
    const qs = params.toString();
    return `/tasks/${encodeURIComponent(id ?? "")}${qs ? `?${qs}` : ""}`;
  };

  if (id === undefined) {
    return (
      <TaskDetailShell>
        <EmptyState variant="error" title={t("tasks.noId")} />
      </TaskDetailShell>
    );
  }

  if (!capable) {
    return (
      <TaskDetailShell>
        <EmptyState
          variant="empty"
          title={t("tasks.unavailableTitle")}
          message={t("tasks.unavailableMessage")}
        />
      </TaskDetailShell>
    );
  }

  if (task.isPending) {
    return (
      <TaskDetailShell>
        <div role="status" aria-label={t("tasks.loadingOne")}>
          <MemoryCardSkeleton count={3} />
        </div>
      </TaskDetailShell>
    );
  }

  if (task.isError) {
    return (
      <TaskDetailShell>
        <EmptyState
          variant="error"
          title={t("tasks.loadOneFailed")}
          message={task.error.message}
          action={
            <Button variant="outline" onClick={() => void task.refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
      </TaskDetailShell>
    );
  }

  const boardTask = task.data;
  const current = boardTask ?? archived.data ?? undefined;
  if (!current) {
    // Not on the board projection: unknown id or ARCHIVED row. The archive
    // probe may still be fetching (UI-18 pair 4) — hold the skeleton until
    // it settles so a live archived row never flashes not-found.
    if (archived.fetchStatus === "fetching") {
      return (
        <TaskDetailShell>
          <div role="status" aria-label={t("tasks.loadingOne")}>
            <MemoryCardSkeleton count={3} />
          </div>
        </TaskDetailShell>
      );
    }
    // Unknown id, or an archived row beyond the probe page: the not-found
    // state keeps its honest «Открыть архив» escape.
    return (
      <TaskDetailShell>
        <EmptyState
          variant="not-found"
          title={t("tasks.notFoundTitle")}
          message={t("tasks.notFoundMessage", { id })}
          action={
            <Button variant="outline" asChild>
              <Link to="/tasks/archive">{t("tasks.goArchive")}</Link>
            </Button>
          }
        />
      </TaskDetailShell>
    );
  }
  // UI-8: a live (non-superseded) final report marks the task as finished —
  // only then does the header offer «Вернуть в работу».
  const hasLiveFinal = (reports.data?.items ?? []).some(
    (report) => report.kind === "final" && !report.superseded,
  );

  return (
    <TaskDetailShell>
      {/* Header: id + status/priority badges + dates + env + people chips
       * + Ф3 mutation actions. */}
      <header className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="font-mono text-xs text-foreground-muted">{current.id}</p>
          {canMutate ? (
            <div className="flex flex-wrap gap-2">
              {hasLiveFinal ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => resumeTask(current)}
                  title={t("tasks.resumeTitle")}
                >
                  <Play className="size-4" aria-hidden="true" />
                  {t("tasks.resumeLabel")}
                </Button>
              ) : null}
              <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                <PencilLine className="size-4" aria-hidden="true" />
                {t("tasks.editLabel")}
              </Button>
            </div>
          ) : null}
        </div>
        <h1 id="task-title" className="text-xl font-semibold">
          {current.title}
        </h1>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={statusBadgeVariant(current.status)}>
            {t(statusLabelKey(current.status))}
          </Badge>
          <Badge variant={priorityBadgeVariant(current.priority)}>
            {t(priorityLabelKey(current.priority))}
          </Badge>
          <Badge variant="outline">{current.env || "—"}</Badge>
          {(current.agents ?? []).map((agent) => (
            <Badge key={agent} variant="default">
              {t("tasks.agentChip", { agent })}
            </Badge>
          ))}
          {(current.specialists ?? []).map((specialist) => (
            <Badge key={specialist} variant="iris">
              {specialist}
            </Badge>
          ))}
        </div>
        <p className="flex flex-wrap gap-x-4 text-xs text-foreground-muted">
          <span>
            {t("tasks.createdLabel")}: {formatTaskDate(current.created_at, lang)}
          </span>
          <span>
            {t("tasks.updatedLabel")}: {formatTaskDate(current.updated_at, lang)}
          </span>
        </p>
      </header>

      {/* Content edit (BE-12 lock + force path lives inside). */}
      {canMutate ? (
        <EditTaskDialog task={current} open={editOpen} onOpenChange={setEditOpen} />
      ) : null}

      {/* Tabs as links (deep-linkable ?tab=; nav + aria-current, not ARIA
       * tabs — each pane is a routed view, navigation semantics fit). */}
      <nav aria-label={t("tasks.tabsLabel")}>
        <ul className="flex flex-wrap gap-1 border-b border-border-subtle">
          {TASK_TABS.map((entry) => {
            const Icon = entry.icon;
            const active = entry.id === tab;
            return (
              <li key={entry.id}>
                <Link
                  to={tabHref(entry.id)}
                  aria-current={active ? "page" : undefined}
                  onClick={(event) => {
                    // Same-path navigation only swaps the query — keep it soft.
                    if (active) event.preventDefault();
                  }}
                  className={
                    "flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors duration-instant focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright " +
                    (active
                      ? "border-iris-bright font-medium text-iris-bright"
                      : "border-transparent text-foreground-secondary hover:text-foreground")
                  }
                  replace={false}
                >
                  <Icon className="size-3.5" aria-hidden="true" />
                  {t(entry.key as TranslationKey)}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="min-w-0">
        {tab === "reports" ? <ReportsTab taskId={id} lang={lang} /> : null}
        {tab === "history" ? <HistoryTab taskId={id} lang={lang} /> : null}
        {tab === "memory" ? <MemoryTab taskId={id} lang={lang} /> : null}
        {tab === "details" ? <DetailsTab task={current} lang={lang} /> : null}
        {tab === "execution" ? (
          <TaskExecutionTab
            task={current}
            /* AGW-6 A.3 link-test deep-link (?assign=<executorId>): the
             * sheet auto-opens with the executor pinned. */
            autoAssignExecutorId={searchParams.get("assign") ?? undefined}
          />
        ) : null}
      </div>
    </TaskDetailShell>
  );
}

function TaskDetailShell({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-labelledby="task-title"
      className="mx-auto flex max-w-3xl flex-col gap-4"
    >
      {children}
    </section>
  );
}

/** «Отчёты»: chronological compact cards; click expands the full body. */
function ReportsTab({ taskId, lang }: { taskId: string; lang: "ru" | "en" }) {
  const t = useT();
  const reports = useTaskReports(taskId);
  useSyncReportCount(taskId, reports.data?.count);

  if (reports.isPending) {
    return (
      <div role="status" aria-label={t("tasks.reportsLoading")}>
        <TableRowSkeleton rows={3} columns={2} />
      </div>
    );
  }
  if (reports.isError) {
    return (
      <EmptyState
        variant="error"
        title={t("tasks.reportsFailed")}
        message={reports.error.message}
        action={
          <Button variant="outline" onClick={() => void reports.refetch()}>
            {t("common.retry")}
          </Button>
        }
      />
    );
  }
  if ((reports.data?.items.length ?? 0) === 0) {
    return (
      <EmptyState
        variant="empty"
        title={t("tasks.reportsEmpty")}
        message={t("tasks.reportsEmptyHint")}
      />
    );
  }

  return (
    <ul className="space-y-2" aria-label={t("tasks.reportsLabel")}>
      {(reports.data?.items ?? []).map((report) => (
        <li key={report.id}>
          {/* Native details/summary: keyboard + SR expand for free (WCAG 2.1.1
           * / 4.1.2) — the compact card IS the summary, the full body the pane. */}
          <details
            className={
              "rounded-md border border-border-subtle bg-well px-3 py-2 text-sm shadow-well " +
              (report.superseded ? "opacity-60" : "")
            }
          >
            <summary className="flex cursor-pointer flex-wrap items-center gap-2 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright">
              <Badge variant={report.kind === "final" ? "iris" : "default"}>
                {t(report.kind === "final" ? "tasks.reportFinal" : "tasks.reportIntermediate")}
              </Badge>
              {report.superseded ? (
                <Badge variant="outline">{t("tasks.reportSuperseded")}</Badge>
              ) : null}
              <span className="text-xs text-foreground-secondary">
                {report.agent || t("tasks.reportNoAgent")}
              </span>
              <span className="ml-auto whitespace-nowrap font-mono text-xs text-foreground-muted">
                {formatTaskDate(report.created_at, lang)}
              </span>
            </summary>
            {/* UI-27: agent report bodies are markdown almost by definition —
             * they render through the TextEngine primitive (plain fallback
             * keeps legacy output for terse one-liners). The <details> row is
             * a disclosure, so the body clamps with «показать полностью» —
             * a long report opens to its height, the tab never turns into an
             * unbounded wall of report text (owner directive: clamp on every
             * disclosure). */}
            <TextEngine text={report.body} variant="full" clamp className="mt-2" />
          </details>
        </li>
      ))}
    </ul>
  );
}

/** «История»: merged event + memory timeline, newest first, expandable rows. */
function HistoryTab({ taskId, lang }: { taskId: string; lang: "ru" | "en" }) {
  const t = useT();
  const history = useTaskHistory(taskId);

  if (history.isPending) {
    return (
      <div role="status" aria-label={t("tasks.historyLoading")}>
        <TableRowSkeleton rows={4} columns={2} />
      </div>
    );
  }
  if (history.isError) {
    return (
      <EmptyState
        variant="error"
        title={t("tasks.historyFailed")}
        message={history.error.message}
        action={
          <Button variant="outline" onClick={() => void history.refetch()}>
            {t("common.retry")}
          </Button>
        }
      />
    );
  }
  const data: TaskHistory | undefined = history.data;
  if ((data?.events.length ?? 0) + (data?.memories.length ?? 0) === 0) {
    return (
      <EmptyState
        variant="empty"
        title={t("tasks.historyEmpty")}
        message={t("tasks.historyEmptyHint")}
      />
    );
  }

  type Row = { key: string; ts: string; title: string; detail?: string; memory: boolean };
  const rows: Row[] = [
    ...(data?.events ?? []).map((event, index): Row => ({
      key: `e${index}-${event.ts}`,
      ts: event.ts,
      title: t(historyEventLabelKey(event.title)),
      detail: event.detail ?? undefined,
      memory: false,
    })),
    ...(data?.memories ?? []).map((memory, index): Row => ({
      key: `m${index}-${memory.title}`,
      ts: memory.ts ?? "",
      title: memory.title,
      detail: [memory.source, memory.detail].filter(Boolean).join(" · ") || undefined,
      memory: true,
    })),
  ].sort((a, b) => b.ts.localeCompare(a.ts));

  return (
    <ol className="space-y-1" aria-label={t("tasks.historyLabel")}>
      {rows.map((row) => (
        <li key={row.key}>
          <details className="rounded-md px-2 py-1 text-sm hover:bg-elevated focus-within:bg-elevated">
            <summary className="flex cursor-pointer flex-wrap items-center gap-2 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright">
              {row.memory ? (
                <Badge variant="default">{t("tasks.historyMemory")}</Badge>
              ) : null}
              <span className="font-medium">{row.title}</span>
              <span className="ml-auto whitespace-nowrap font-mono text-xs text-foreground-muted">
                {formatTaskDate(row.ts, lang)}
              </span>
            </summary>
            {row.detail ? (
              <p className="mt-1 whitespace-pre-wrap text-xs text-foreground-secondary">
                {row.detail}
              </p>
            ) : null}
          </details>
        </li>
      ))}
    </ol>
  );
}

/** Narrow the anonymous memory-link card onto honest view fields. */
function memoryCard(value: unknown): { title: string; excerpt: string; status: string } {
  const source = (value ?? {}) as Record<string, unknown>;
  return {
    title: typeof source.title === "string" ? source.title : "",
    excerpt: typeof source.excerpt === "string" ? source.excerpt : "",
    status: typeof source.status === "string" ? source.status : "",
  };
}

/** «Память»: linked memory cards with server provenance + unresolved links. */
function MemoryTab({ taskId, lang }: { taskId: string; lang: "ru" | "en" }) {
  const t = useT();
  const links = useTaskMemories(taskId);
  // UI-18 pair 12 (detail→detail): the memory links carry THIS task URL —
  // tab=memory plus whatever `return=` the task itself arrived with — as
  // their own `return=` (§2.2 rule 3: each link stores only its immediate
  // predecessor, the chain resolves recursively: memory → task → list).
  const location = useLocation();

  if (links.isPending) {
    return (
      <div role="status" aria-label={t("tasks.memoryLoading")}>
        <MemoryCardSkeleton count={2} />
      </div>
    );
  }
  if (links.isError) {
    return (
      <EmptyState
        variant="error"
        title={t("tasks.memoryFailed")}
        message={links.error.message}
        action={
          <Button variant="outline" onClick={() => void links.refetch()}>
            {t("common.retry")}
          </Button>
        }
      />
    );
  }

  const data: TaskMemories | undefined = links.data;
  const entries = Object.entries(data?.items ?? {});
  if (entries.length === 0 && (data?.unresolved.length ?? 0) === 0) {
    return (
      <EmptyState
        variant="empty"
        title={t("tasks.memoryEmpty")}
        message={t("tasks.memoryEmptyHint")}
      />
    );
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-2" aria-label={t("tasks.memoryLabel")}>
        {entries.map(([memoryId, card]) => {
          const view = memoryCard(card);
          const server = data?.sources[memoryId];
          return (
            <li key={memoryId}>
              <Link
                to={withReturn(
                  `/memory/${encodeURIComponent(memoryId)}`,
                  location.pathname,
                  location.search,
                )}
                className="block rounded-md border border-border-subtle bg-well px-3 py-2 text-sm shadow-well transition-colors duration-instant hover:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{view.title || memoryId}</span>
                  {server ? (
                    <Badge variant="outline">
                      {t("tasks.memorySource", { server })}
                    </Badge>
                  ) : null}
                  {view.status ? <Badge variant="default">{view.status}</Badge> : null}
                </span>
                {view.excerpt ? (
                  <span className="mt-1 block line-clamp-2 text-xs text-foreground-secondary">
                    {view.excerpt}
                  </span>
                ) : null}
                <span className="sr-only">
                  {t("tasks.memoryOpenPrompt", { date: formatTaskDate("", lang) })}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {(data?.unresolved.length ?? 0) > 0 ? (
        <div>
          <p className="text-xs text-foreground-muted">{t("tasks.memoryUnresolved")}</p>
          <ul className="mt-1 space-y-1">
            {(data?.unresolved ?? []).map((row, index) => {
              const source = (row ?? {}) as Record<string, unknown>;
              const id = typeof source.id === "string" ? source.id : `unresolved-${index}`;
              const status =
                typeof source.status === "string" ? source.status : "unknown";
              const server =
                typeof source.server === "string" ? source.server : "?";
              return (
                <li
                  key={id}
                  className="rounded-md border border-dashed border-border-subtle px-3 py-1.5 font-mono text-xs text-foreground-muted"
                >
                  {id} · {status} · {server}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** «Детали»: summary readable, spec pre-wrap, honest metadata table. The row
 * arrives as a prop so ARCHIVED tasks (UI-18 pair 4 — no board row) render
 * too; the old inner useTask() re-query silently hid their details tab. */
function DetailsTab({ task, lang }: { task: BoardTask; lang: "ru" | "en" }) {
  const t = useT();
  const current = task;
  if (!current) return null;

  return (
    <div className="space-y-4">
      <section aria-label={t("tasks.detailsSummaryLabel")}>
        <h2 className="text-sm font-medium text-foreground-secondary">
          {t("tasks.detailsSummaryLabel")}
        </h2>
        {current.summary ? (
          /* UI-27: summary is author text — through the TextEngine primitive. */
          <TextEngine
            text={current.summary}
            variant="compact"
            className="mt-1 text-sm"
          />
        ) : (
          <p className="mt-1 text-sm">—</p>
        )}
      </section>
      <section aria-label={t("tasks.detailsSpecLabel")}>
        <h2 className="text-sm font-medium text-foreground-secondary">
          {t("tasks.detailsSpecLabel")}
        </h2>
        {current.spec ? (
          /* UI-27: the spec is the task's markdown document (headings,
           * checklists, code) — formatted in the well box; plain specs keep
           * the legacy pre-wrap look inside the same box. */
          <div className="mt-1 rounded-md border border-border-subtle bg-well p-3">
            <TextEngine text={current.spec} variant="full" className="text-sm" />
          </div>
        ) : (
          <p className="mt-1 text-sm">—</p>
        )}
      </section>
      <section aria-label={t("tasks.detailsMetaLabel")}>
        <h2 className="text-sm font-medium text-foreground-secondary">
          {t("tasks.detailsMetaLabel")}
        </h2>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-foreground-muted">{t("tasks.detailsEnv")}</dt>
          <dd>{current.env || "—"}</dd>
          <dt className="text-foreground-muted">{t("tasks.detailsProject")}</dt>
          <dd>{current.project || "—"}</dd>
          <dt className="text-foreground-muted">{t("tasks.createdLabel")}</dt>
          <dd>{formatTaskDate(current.created_at, lang)}</dd>
          <dt className="text-foreground-muted">{t("tasks.updatedLabel")}</dt>
          <dd>{formatTaskDate(current.updated_at, lang)}</dd>
          <dt className="text-foreground-muted">{t("tasks.detailsSpecialists")}</dt>
          <dd>{(current.specialists ?? []).join(", ") || "—"}</dd>
          <dt className="text-foreground-muted">{t("tasks.detailsTags")}</dt>
          <dd>{(current.mnemos_tags ?? []).join(", ") || "—"}</dd>
          <dt className="text-foreground-muted">{t("tasks.detailsMemoryIds")}</dt>
          <dd className="break-all font-mono text-xs">
            {(current.memory_ids ?? []).join(", ") || "—"}
          </dd>
        </dl>
      </section>
    </div>
  );
}
