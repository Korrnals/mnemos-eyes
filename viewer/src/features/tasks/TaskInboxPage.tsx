import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  ChevronDown,
  ChevronUp,
  Inbox,
  PencilLine,
  ScanSearch,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { MemoryCardSkeleton } from "@/components/skeletons/Skeletons";
import { TagBadge } from "@/components/TagBadge/TagBadge";
import { TextEngine } from "@/components/TextEngine";
import { isTaskMutationSource, isTaskSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import type { InboxEditInput, TaskInboxEntry } from "@/gateway/boardTypes";
import { useI18n, useT } from "@/i18n";
import {
  formatTaskDate,
  priorityBadgeVariant,
  priorityLabelKey,
  TASK_PRIORITIES,
} from "./taskStatus";
import { useTaskMutations } from "./useTaskMutations";
import { useInboxMemory, useTaskInbox } from "./useTasks";

/**
 * `/tasks/inbox` — the AGG-1 mirror of `task:queue` records (ADR 0010):
 * projections with provenance, NOT native tasks. Ф3 wires the mutations in:
 * «Принять в борд» (POST adopt → toast with an «открыть задачу» link; a 409
 * toast links the existing task) and «Сканировать хранилища» (POST refresh,
 * spinner, found/new toast). Stale rows (the source stopped returning the
 * record) are dimmed and cannot be adopted; adopted rows return behind
 * `?adopted=1`.
 *
 * UI-25 (owner feedback): every card header is a row of colored key:value
 * chips («приоритет: обычный», «проект: hysteria», «сервер: laptop»), the
 * card EXPANDS to the full source memory (fetched on demand — the mirror
 * keeps an excerpt only, SEC-4), and an editable overlay (title / summary /
 * priority / project) is stored via PATCH before adoption — «Принять в
 * борд» then adopts the edited version and the server syncs the edit back
 * to mnemos as a superseding revision record.
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
  // Expanded cards (local accordion state — a transient view concern, not
  // a filter like ?adopted=1).
  const [expandedIds, setExpandedIds] = useState<readonly string[]>([]);
  const toggleExpanded = (memoryId: string) =>
    setExpandedIds((prev) =>
      prev.includes(memoryId)
        ? prev.filter((id) => id !== memoryId)
        : [...prev, memoryId],
    );

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
                <InboxCard
                  item={item}
                  lang={lang}
                  canAdopt={canMutate}
                  canEdit={canMutate}
                  expanded={expandedIds.includes(item.memory_id)}
                  onToggleExpanded={() => toggleExpanded(item.memory_id)}
                />
              </li>
            ))}
          </ul>
          {stale.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs text-foreground-muted">{t("tasks.inboxStaleNote")}</p>
              <ul className="space-y-2 opacity-60" aria-label={t("tasks.inboxStaleLabel")}>
                {stale.map((item) => (
                  <li key={item.memory_id}>
                    <InboxCard
                      item={item}
                      lang={lang}
                      canAdopt={false}
                      canEdit={false}
                      expanded={expandedIds.includes(item.memory_id)}
                      onToggleExpanded={() => toggleExpanded(item.memory_id)}
                    />
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
  canEdit,
  expanded,
  onToggleExpanded,
}: {
  item: TaskInboxEntry;
  lang: "ru" | "en";
  canAdopt: boolean;
  canEdit: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const t = useT();
  const { adoptInboxItem } = useTaskMutations();
  const adoptable = canAdopt && !item.stale && !item.adopted;
  const editable = canEdit && !item.stale && !item.adopted;
  const [editing, setEditing] = useState(false);
  const openEditor = () => {
    if (!expanded) onToggleExpanded();
    setEditing(true);
  };
  const closeEditor = () => setEditing(false);
  return (
    <article className="min-h-row rounded-md border border-border-subtle bg-well px-3 py-2 text-sm shadow-well">
      {/* UI-25 header: colored key:value chips (owner feedback — «как у
          сервера, ключ: значение, и цветами подсвечивать»). */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={priorityBadgeVariant(item.priority)}>
          {t("tasks.inboxPriorityChip", {
            value: t(priorityLabelKey(item.priority)),
          })}
        </Badge>
        {item.project ? (
          <Badge variant="iris">
            {t("tasks.inboxProjectChip", { value: item.project })}
          </Badge>
        ) : null}
        <Badge variant="outline">{t("tasks.inboxSource", { server: item.server })}</Badge>
        {item.edits ? (
          <Badge variant="warning">{t("tasks.inboxEditedBadge")}</Badge>
        ) : null}
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
        <div className="flex items-center gap-1.5">
          {editable ? (
            <Button variant="outline" size="sm" onClick={openEditor}>
              <PencilLine className="size-4" aria-hidden="true" />
              {t("tasks.inboxEditLabel")}
            </Button>
          ) : null}
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
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleExpanded}
            aria-expanded={expanded}
            aria-label={expanded ? t("tasks.inboxCollapseLabel") : t("tasks.inboxExpandLabel")}
          >
            {expanded ? (
              <ChevronUp className="size-4" aria-hidden="true" />
            ) : (
              <ChevronDown className="size-4" aria-hidden="true" />
            )}
          </Button>
        </div>
      </div>
      {expanded ? (
        editing ? (
          <EditInboxForm item={item} onDone={closeEditor} />
        ) : (
          <InboxExpandedDetails item={item} />
        )
      ) : null}
    </article>
  );
}

/** Expanded record body: full source text + key:value details + tags. */
function InboxExpandedDetails({ item }: { item: TaskInboxEntry }) {
  const t = useT();
  const { lang } = useI18n();
  const memory = useInboxMemory(item.memory_id, true);
  return (
    <div className="mt-2 space-y-2 rounded-md border border-border-subtle bg-elevated p-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
        {t("tasks.inboxDetailsLabel")}
      </h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-foreground-muted">{t("tasks.inboxSource", { server: "" }).trim()}</dt>
        <dd className="text-foreground">{item.server}</dd>
        {item.project ? (
          <>
            <dt className="text-foreground-muted">{t("tasks.inboxProjectChip", { value: "" }).trim()}</dt>
            <dd className="text-foreground">{item.project}</dd>
          </>
        ) : null}
        <dt className="text-foreground-muted">{t("tasks.inboxPriorityChip", { value: "" }).trim()}</dt>
        <dd className="text-foreground">{t(priorityLabelKey(item.priority))}</dd>
        <dt className="text-foreground-muted">{t("tasks.inboxDetailsSpecialist", { value: "" }).trim()}</dt>
        <dd className="text-foreground">{item.specialist || t("tasks.inboxNoSpecialist")}</dd>
        <dt className="text-foreground-muted">{t("tasks.inboxDetailsCreated", { value: "" }).trim()}</dt>
        <dd className="text-foreground">{formatTaskDate(item.created_at, lang)}</dd>
        <dt className="text-foreground-muted">{t("tasks.inboxDetailsMemoryId", { value: "" }).trim()}</dt>
        <dd className="font-mono text-foreground">{item.memory_id}</dd>
      </dl>
      {item.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1" aria-label={t("tasks.detailsTags")}>
          {item.tags.map((tag) => (
            <TagBadge key={tag} tag={tag} />
          ))}
        </div>
      ) : null}
      <div>
        <h4 className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
          {t("tasks.inboxFullTextLabel")}
        </h4>
        {memory.isPending ? (
          <MemoryCardSkeleton count={1} />
        ) : memory.isError ? (
          <p role="alert" className="text-xs text-error">
            {t("tasks.inboxFullTextFailed")}
          </p>
        ) : (
          /* UI-27: the source record text renders through the TextEngine
           * primitive — the owner's raw `##`/`**` complaint surface. Plain
           * records keep the legacy pre-wrap output; markdown records
           * render formatted (full, clamped with «показать полностью»). */
          <TextEngine
            text={memory.data?.content}
            variant="full"
            clamp
            className="mt-1"
          />
        )}
      </div>
    </div>
  );
}

/** UI-25 edit form: title / summary / priority / project → PATCH overlay. */
const INBOX_TITLE_MAX = 200;

function EditInboxForm({ item, onDone }: { item: TaskInboxEntry; onDone: () => void }) {
  const t = useT();
  const { editInboxItem } = useTaskMutations();
  const [title, setTitle] = useState(item.title);
  const [summary, setSummary] = useState(item.excerpt);
  const [priority, setPriority] = useState(item.priority);
  const [project, setProject] = useState(item.project);
  const [titleError, setTitleError] = useState(false);

  const submit = () => {
    const trimmed = title.trim();
    if (trimmed.length === 0 || trimmed.length > INBOX_TITLE_MAX) {
      setTitleError(true);
      return;
    }
    setTitleError(false);
    // Only changed fields travel (the wire PATCH is a partial overlay).
    const patch: InboxEditInput = {
      ...(trimmed !== item.title ? { title: trimmed } : {}),
      ...(summary !== item.excerpt ? { summary } : {}),
      ...(priority !== item.priority ? { priority } : {}),
      ...(project !== item.project ? { project } : {}),
    };
    editInboxItem(item.memory_id, patch);
    onDone();
  };

  return (
    <form
      className="mt-2 space-y-3 rounded-md border border-border-subtle bg-elevated p-3"
      aria-label={t("tasks.inboxEditTitle")}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      noValidate
    >
      <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
        {t("tasks.inboxEditTitle")}
      </p>
      <p className="text-xs text-foreground-secondary">{t("tasks.inboxEditHint")}</p>
      <InboxField label={t("tasks.inboxEdit.titleLabel")} htmlFor={`inbox-edit-title-${item.memory_id}`}>
        <input
          id={`inbox-edit-title-${item.memory_id}`}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={INBOX_TITLE_MAX}
          aria-invalid={titleError}
          className={INBOX_FIELD_CLASS + (titleError ? " border-error" : "")}
        />
      </InboxField>
      <InboxField label={t("tasks.inboxEdit.summaryLabel")} htmlFor={`inbox-edit-summary-${item.memory_id}`}>
        <textarea
          id={`inbox-edit-summary-${item.memory_id}`}
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          rows={4}
          className={INBOX_AREA_CLASS}
        />
      </InboxField>
      <div className="grid gap-3 sm:grid-cols-2">
        <InboxField label={t("tasks.inboxEdit.priorityLabel")} htmlFor={`inbox-edit-priority-${item.memory_id}`}>
          <select
            id={`inbox-edit-priority-${item.memory_id}`}
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
            className={INBOX_FIELD_CLASS}
          >
            {TASK_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {t(priorityLabelKey(value))}
              </option>
            ))}
          </select>
        </InboxField>
        <InboxField label={t("tasks.inboxEdit.projectLabel")} htmlFor={`inbox-edit-project-${item.memory_id}`}>
          <input
            id={`inbox-edit-project-${item.memory_id}`}
            value={project}
            onChange={(event) => setProject(event.target.value)}
            className={INBOX_FIELD_CLASS}
          />
        </InboxField>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          {t("tasks.inboxEdit.cancel")}
        </Button>
        <Button type="submit" size="sm">
          {t("tasks.inboxEdit.save")}
        </Button>
      </div>
    </form>
  );
}

const INBOX_FIELD_CLASS =
  "h-9 w-full rounded-md border border-border bg-well px-2 text-sm text-foreground placeholder:text-foreground-muted focus-visible:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright";
const INBOX_AREA_CLASS =
  "w-full rounded-md border border-border bg-well px-2 py-1.5 text-sm text-foreground placeholder:text-foreground-muted focus-visible:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright";

function InboxField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-xs text-foreground-secondary">
        {label}
      </label>
      {children}
    </div>
  );
}
