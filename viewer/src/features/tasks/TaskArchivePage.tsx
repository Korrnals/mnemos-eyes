import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Archive, ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { TableRowSkeleton } from "@/components/skeletons/Skeletons";
import { isTaskMutationSource, isTaskSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import type { ArchivePage, BoardTask } from "@/gateway/boardTypes";
import { useI18n, useT } from "@/i18n";
import {
  TASK_COLUMNS,
  TASK_STATUSES,
  formatTaskDate,
  priorityBadgeVariant,
  priorityLabelKey,
  statusBadgeVariant,
  statusLabelKey,
} from "./taskStatus";
import { useTaskMutations } from "./useTaskMutations";
import { useTaskArchive } from "./useTasks";

/**
 * `/tasks/archive` — the archive reading surface (BE-11b). Every control is
 * URL state (`?q=&status=&col=&agent=&project=&limit=&offset=` — QA verdict
 * §3), so a filtered page deep-links and survives F5. `q` debounces 300 ms
 * before it lands in the URL (no request per keystroke). Rows expand inline
 * (native details/summary): archived tasks are NOT on the board projection,
 * so /tasks/:id cannot serve them — the expansion IS the detail view. Ф3
 * wires «Вернуть из архива» (POST unarchive → the board row returns via the
 * SSE mapping, the archive list refreshes, toast confirms).
 */

const ARCHIVE_PAGE_SIZES = [25, 50, 100] as const;
const DEFAULT_ARCHIVE_PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

interface ArchiveUrlState {
  q: string;
  status: string;
  col: string;
  agent: string;
  project: string;
  limit: number;
  offset: number;
}

function parseArchiveParams(params: URLSearchParams): ArchiveUrlState {
  const rawLimit = Number.parseInt(params.get("limit") ?? "", 10);
  const rawOffset = Number.parseInt(params.get("offset") ?? "", 10);
  return {
    q: params.get("q") ?? "",
    status: params.get("status") ?? "",
    col: params.get("col") ?? "",
    agent: params.get("agent") ?? "",
    project: params.get("project") ?? "",
    limit: ARCHIVE_PAGE_SIZES.includes(rawLimit as (typeof ARCHIVE_PAGE_SIZES)[number])
      ? rawLimit
      : DEFAULT_ARCHIVE_PAGE_SIZE,
    offset: Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0,
  };
}

export function TaskArchivePage() {
  const t = useT();
  const { lang } = useI18n();
  const gateway = useGateway();
  const capable = isTaskSource(gateway);
  const canMutate = isTaskMutationSource(gateway);
  const [searchParams, setSearchParams] = useSearchParams();
  const state = parseArchiveParams(searchParams);
  // Local input state: the URL (and thus the query) follows 300 ms later.
  const [qInput, setQInput] = useState(state.q);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Keep the field in sync when the URL changes underneath (back/forward).
  // The render-time adjust pattern (React docs) — not an effect — so a POP
  // navigation never fights the debounce mid-typing.
  const [lastUrlQ, setLastUrlQ] = useState(state.q);
  if (state.q !== lastUrlQ) {
    setLastUrlQ(state.q);
    setQInput(state.q);
  }

  useEffect(() => () => clearTimeout(debounceTimer.current), []);

  const onSearchInput = (value: string) => {
    setQInput(value);
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      patchParams({ q: value, offset: 0 });
    }, SEARCH_DEBOUNCE_MS);
  };

  const patchParams = (changes: Partial<ArchiveUrlState>) => {
    setSearchParams(
      (prev) => {
        const merged = { ...parseArchiveParams(prev), ...changes };
        const next = new URLSearchParams();
        if (merged.q) next.set("q", merged.q);
        if (merged.status) next.set("status", merged.status);
        if (merged.col) next.set("col", merged.col);
        if (merged.agent) next.set("agent", merged.agent);
        if (merged.project) next.set("project", merged.project);
        if (merged.limit !== DEFAULT_ARCHIVE_PAGE_SIZE)
          next.set("limit", String(merged.limit));
        if (merged.offset > 0) next.set("offset", String(merged.offset));
        return next;
      },
      { replace: false },
    );
  };

  const archive = useTaskArchive({
    q: state.q || undefined,
    status: state.status || undefined,
    col: state.col || undefined,
    agent: state.agent || undefined,
    project: state.project || undefined,
    limit: state.limit,
    offset: state.offset,
  });

  if (!capable) {
    return (
      <ArchiveShell>
        <EmptyState variant="empty" title={t("tasks.unavailableTitle")} message={t("tasks.unavailableMessage")} />
      </ArchiveShell>
    );
  }

  if (archive.isPending) {
    return (
      <ArchiveShell>
        <ArchiveFilters
          state={state}
          qInput={qInput}
          onSearch={onSearchInput}
          onPatch={patchParams}
          projectChoices={[]}
          agentChoices={[]}
        />
        <div role="status" aria-label={t("tasks.archiveLoading")}>
          <TableRowSkeleton rows={4} columns={3} />
        </div>
      </ArchiveShell>
    );
  }

  if (archive.isError) {
    return (
      <ArchiveShell>
        <ArchiveFilters
          state={state}
          qInput={qInput}
          onSearch={onSearchInput}
          onPatch={patchParams}
          projectChoices={[]}
          agentChoices={[]}
        />
        <EmptyState
          variant="error"
          title={t("tasks.archiveFailed")}
          message={archive.error.message}
          action={
            <Button variant="outline" onClick={() => void archive.refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
      </ArchiveShell>
    );
  }

  const data: ArchivePage | undefined = archive.data;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const rangeStart = items.length === 0 ? 0 : state.offset + 1;
  const rangeEnd = items.length === 0 ? 0 : state.offset + items.length;
  const canPrev = state.offset > 0;
  const canNext = rangeEnd < total;
  const projectChoices = Object.keys(data?.projects ?? {}).sort((a, b) =>
    a.localeCompare(b),
  );
  const agentChoices = [
    ...new Set(
      Object.values(data?.projects ?? {})
        .flat()
        .flatMap((row) => {
          const agents = (row as { agents?: unknown }).agents;
          return Array.isArray(agents) ? agents.map(String) : [];
        }),
    ),
  ].sort((a, b) => a.localeCompare(b));

  return (
    <ArchiveShell>
      <ArchiveFilters
        state={state}
        qInput={qInput}
        onSearch={onSearchInput}
        onPatch={patchParams}
        projectChoices={projectChoices}
        agentChoices={agentChoices}
      />

      {total === 0 ? (
        <EmptyState
          variant="empty"
          title={t("tasks.archiveEmpty")}
          message={t("tasks.archiveEmptyHint")}
        />
      ) : (
        <>
          {items.length === 0 ? (
            /* Past-the-end page: keep the pager so the way back stays. */
            <p role="status" className="text-sm text-foreground-secondary">
              {t("tasks.archivePageEmpty")}
            </p>
          ) : (
            <ul className="space-y-1" aria-label={t("tasks.archiveLabel")}>
              {items.map((task) => (
                <li key={task.id}>
                  <ArchiveRow task={task} lang={lang} canUnarchive={canMutate} />
                </li>
              ))}
            </ul>
          )}

          <nav
            aria-label={t("tasks.archivePagesAria")}
            className="flex items-center justify-between"
          >
            <p className="text-xs text-foreground-secondary">
              {t("tasks.archiveRange", {
                from: rangeStart,
                to: rangeEnd,
                total,
              })}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!canPrev}
                onClick={() => patchParams({ offset: Math.max(0, state.offset - state.limit) })}
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
                {t("memories.prev")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!canNext}
                onClick={() => patchParams({ offset: state.offset + state.limit })}
              >
                {t("memories.next")}
                <ChevronRight className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </nav>
        </>
      )}
    </ArchiveShell>
  );
}

/** One archive row: expandable inline detail + the Ф3 unarchive action. */
function ArchiveRow({
  task,
  lang,
  canUnarchive,
}: {
  task: BoardTask;
  lang: "ru" | "en";
  canUnarchive: boolean;
}) {
  const t = useT();
  const { unarchiveTask } = useTaskMutations();
  return (
    <details className="rounded-md border border-border-subtle bg-well px-3 py-2 text-sm shadow-well">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright">
        <span className="font-mono text-xs text-foreground-muted">{task.id}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{task.title}</span>
        <Badge variant={statusBadgeVariant(task.status)}>
          {t(statusLabelKey(task.status))}
        </Badge>
        <Badge variant={priorityBadgeVariant(task.priority)}>
          {t(priorityLabelKey(task.priority))}
        </Badge>
        <span className="whitespace-nowrap text-xs text-foreground-muted">
          {formatTaskDate(task.updated_at, lang)}
        </span>
      </summary>
      <div className="mt-2 space-y-2 border-t border-border-subtle pt-2">
        <p className="whitespace-pre-wrap text-xs text-foreground-secondary">
          {task.summary || "—"}
        </p>
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-elevated p-2 font-mono text-xs text-foreground-secondary">
          {task.spec || "—"}
        </pre>
        <p className="flex flex-wrap gap-x-4 text-xs text-foreground-muted">
          <span>
            {t("tasks.detailsProject")}: {task.project || "—"}
          </span>
          <span>
            {t("tasks.detailsEnv")}: {task.env || "—"}
          </span>
          <span>
            {t("tasks.agentLabel")}: {(task.agents ?? []).join(", ") || "—"}
          </span>
          {task.archived_from ? (
            <span>{t("tasks.archiveFrom", { col: task.archived_from })}</span>
          ) : null}
        </p>
        {/* POST /api/tasks/{id}/unarchive (Ф3): toast + board row return. */}
        {canUnarchive ? (
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => unarchiveTask(task)}
            >
              <RotateCcw className="size-4" aria-hidden="true" />
              {t("tasks.unarchiveLabel")}
            </Button>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function ArchiveShell({ children }: { children: React.ReactNode }) {
  const t = useT();
  return (
    <section aria-labelledby="archive-title" className="mx-auto max-w-3xl space-y-4">
      <h1 id="archive-title" className="flex items-center gap-2 text-xl font-semibold">
        <Archive className="size-5" aria-hidden="true" />
        {t("tasks.archiveTitle")}
      </h1>
      {children}
    </section>
  );
}

function ArchiveFilters({
  state,
  qInput,
  onSearch,
  onPatch,
  projectChoices,
  agentChoices,
}: {
  state: ArchiveUrlState;
  qInput: string;
  onSearch: (value: string) => void;
  onPatch: (changes: Partial<ArchiveUrlState>) => void;
  projectChoices: readonly string[];
  agentChoices: readonly string[];
}) {
  const t = useT();
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      aria-label={t("tasks.archiveFilterLabel")}
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="archive-q" className="text-xs text-foreground-secondary">
          {t("tasks.archiveSearchLabel")}
        </label>
        <input
          id="archive-q"
          type="search"
          value={qInput}
          onChange={(event) => onSearch(event.target.value)}
          placeholder={t("tasks.archiveSearchPlaceholder")}
          className="h-9 w-48 rounded-md border border-border bg-well px-2 text-sm text-foreground placeholder:text-foreground-muted focus-visible:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
        />
      </div>
      <FilterSelectInline
        id="archive-status"
        label={t("tasks.statusLabel")}
        value={state.status}
        allLabel={t("tasks.allStatuses")}
        options={TASK_STATUSES.map((status) => ({
          value: status,
          label: t(statusLabelKey(status)),
        }))}
        onChange={(value) => onPatch({ status: value, offset: 0 })}
      />
      <FilterSelectInline
        id="archive-col"
        label={t("tasks.colLabel")}
        value={state.col}
        allLabel={t("tasks.allColumns")}
        options={TASK_COLUMNS.map((col) => ({ value: col, label: col }))}
        onChange={(value) => onPatch({ col: value, offset: 0 })}
      />
      <FilterSelectInline
        id="archive-agent"
        label={t("tasks.agentLabel")}
        value={state.agent}
        allLabel={t("tasks.allAgents")}
        options={agentChoices.map((agent) => ({ value: agent, label: agent }))}
        onChange={(value) => onPatch({ agent: value, offset: 0 })}
      />
      <FilterSelectInline
        id="archive-project"
        label={t("tasks.projectLabel")}
        value={state.project}
        allLabel={t("tasks.allProjects")}
        options={projectChoices.map((project) => ({ value: project, label: project }))}
        onChange={(value) => onPatch({ project: value, offset: 0 })}
      />
      <div className="flex flex-col gap-1">
        <label htmlFor="archive-limit" className="text-xs text-foreground-secondary">
          {t("tasks.limitLabel")}
        </label>
        <select
          id="archive-limit"
          value={String(state.limit)}
          onChange={(event) => onPatch({ limit: Number(event.target.value), offset: 0 })}
          className="h-9 rounded-md border border-border bg-well px-2 text-sm text-foreground focus-visible:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
        >
          {ARCHIVE_PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </div>
    </form>
  );
}

/** Labeled native select (shared shape with the list page's FilterSelect). */
function FilterSelectInline({
  id,
  label,
  value,
  onChange,
  allLabel,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  allLabel: string;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-foreground-secondary">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-md border border-border bg-well px-2 text-sm text-foreground focus-visible:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
      >
        <option value="">{allLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
