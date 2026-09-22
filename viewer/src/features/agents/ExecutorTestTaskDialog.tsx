import { useMemo } from "react";
import { FlaskConical } from "lucide-react";
import { Link } from "react-router";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { BoardTask, ExecutorItem } from "@/gateway/boardTypes";
import { useT } from "@/i18n";
import { useBoardTasks } from "@/features/tasks/useTasks";
import { taskAcceptsAssignments } from "./assignmentStatus";

/**
 * The link-check SECOND stage (AGW-6 A.3 — «проверить по-настоящему»):
 * the board has no ping, so the only real probe is the EXISTING dispatch
 * flow — pick a task, the deep-link opens its «Взять в работу» sheet with
 * the executor PINNED (executor_id), and the poller does the rest.
 *
 * Honesty: a routing/allowlist MISS is a valid test too — the executor's
 * refusal-report proves the link works (the note says so verbatim). The
 * picker lists only tasks that accept assignments (matrix A idle gate);
 * an empty board is an honest dead end, not a disabled button.
 */
export function ExecutorTestTaskDialog({
  executor,
  open,
  onOpenChange,
}: {
  executor: ExecutorItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const board = useBoardTasks();

  // Test candidates: tasks that can take an attempt, newest first.
  const candidates = useMemo(() => {
    const rows = board.data?.tasks ?? [];
    return rows
      .filter((task) => taskAcceptsAssignments(task))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [board.data]);

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogTitle>{t("agents.linktest.title", { name: executor.name })}</DialogTitle>
        <DialogDescription className="-mt-2 text-xs text-foreground-muted">
          {t("agents.linktest.subtitle", { name: executor.name })}
        </DialogDescription>

        <p className="flex items-start gap-1.5 rounded-md border border-border-subtle bg-elevated p-2 text-xs text-foreground-secondary">
          <FlaskConical className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {t("agents.linktest.allowlistNote")}
        </p>

        {board.isPending ? (
          <p role="status" className="text-sm text-foreground-muted">
            {t("agents.linktest.loading")}
          </p>
        ) : candidates.length === 0 ? (
          <p role="status" className="text-sm text-foreground-muted">
            {t("agents.linktest.empty")}
          </p>
        ) : (
          <ul
            aria-label={t("agents.linktest.listLabel")}
            className="max-h-64 space-y-1 overflow-y-auto"
          >
            {candidates.map((task) => (
              <TestTaskRow key={task.id} task={task} executor={executor} onPicked={() => onOpenChange(false)} />
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** One candidate: the deep-link itself — task page, execution tab, pin. */
function TestTaskRow({
  task,
  executor,
  onPicked,
}: {
  task: BoardTask;
  executor: ExecutorItem;
  onPicked: () => void;
}) {
  const t = useT();
  return (
    <li>
      <Link
        to={`/tasks/${encodeURIComponent(task.id)}?tab=execution&assign=${encodeURIComponent(executor.id)}`}
        onClick={onPicked}
        className="flex items-baseline gap-2 rounded-sm border border-border-subtle bg-well px-2 py-1.5 text-sm transition-colors duration-instant hover:border-iris-bright/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
      >
        <span className="min-w-0 flex-1 truncate">{task.title || task.id}</span>
        <span className="shrink-0 font-mono text-xs text-foreground-muted">{task.id}</span>
        <span className="sr-only">{t("agents.linktest.rowAria", { name: executor.name })}</span>
      </Link>
    </li>
  );
}
