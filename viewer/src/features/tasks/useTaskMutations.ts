import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { BoardTask, TaskCreateInput, TaskPatchInput } from "@/gateway/boardTypes";
import { isTaskMutationSource } from "@/gateway/capabilities";
import type { TaskMutationSource } from "@/gateway/capabilities";
import type { MemoryGateway } from "@/gateway/MemoryGateway";
import { useGateway } from "@/gateway/GatewayContext";
import { isApiError } from "@/lib/errors";
import type { ApiError } from "@/lib/errors";
import { keys } from "@/lib/queryKeys";
import { useToast } from "@/components/Toast/toastContext";
import type { ToastApi } from "@/components/Toast/toastContext";
import { useUiToken } from "@/features/ui-token/UiTokenContext";
import { columnLabelKey } from "./taskStatus";
import { applyTaskEventToCache } from "./taskEvents";
import type { TranslationKey } from "@/i18n";
import { useT, type TranslateFn } from "@/i18n";

/**
 * Ф3 task mutations: every write goes through the ui-token gate, then the
 * SERVER ANSWER is folded into the cache through the very same
 * `applyTaskEventToCache` mapping the SSE bridge uses (a synthesized
 * `task.updated` for a PATCH answer, `task.created` for a POST answer, …).
 * The later real SSE event for the same mutation re-applies the identical
 * patch — idempotent — so "optimistic apply + SSE reconciliation" is one
 * code path, not two.
 *
 * The action set is a framework-free factory (`createTaskMutations`) wired
 * to React by the `useTaskMutations` hook below — the factory is what unit
 * tests drive (mock adapter + real QueryClient + recording toast).
 */

/** Standard error handling for one authorized mutation run. */
interface RunOptions {
  /** Toast title when the run fails (non-401, non-handled). */
  errorTitleKey: TranslationKey;
  /** Custom error branch (e.g. 409 adopt). Return true when handled. */
  onError?: (error: ApiError) => boolean;
  /** Fires when the token gate defers the run (spinner owners reset here). */
  onDeferred?: () => void;
}

export interface TaskMutationDeps {
  /** Gate runner (UiTokenGate.runAuthorized — direct in tests). */
  runAuthorized: (run: () => Promise<void>, onDeferred?: () => void) => void;
  /** Toast sink (success/error feedback is part of the contract). */
  toast: Pick<ToastApi, "push">;
  /** Translate function (i18n ru/en keys live in ru.ts/en.ts). */
  t: TranslateFn;
  /** Mutation-capable gateway (asserted, not capability-guarded). */
  gateway: MemoryGateway;
  /** Cache owner — server answers are folded in here. */
  queryClient: QueryClient;
}

export function createTaskMutations(deps: TaskMutationDeps) {
  const { runAuthorized, toast, t, queryClient } = deps;
  const mutations = (): TaskMutationSource => {
    if (!isTaskMutationSource(deps.gateway)) {
      throw new Error("task mutations: gateway has no mutation capability.");
    }
    return deps.gateway;
  };

  /** Gate + toast wrapper shared by every action below (and the dialogs). */
  const run = (options: RunOptions, fn: () => Promise<void>): void => {
    runAuthorized(async () => {
      try {
        await fn();
      } catch (error) {
        // 401 escalates to the token gate (drop token → panel → retry).
        if (isApiError(error) && error.status === 401) throw error;
        if (isApiError(error) && options.onError?.(error)) return;
        toast.push({
          kind: "error",
          title: t(options.errorTitleKey),
          detail: error instanceof Error ? error.message : undefined,
        });
      }
    }, options.onDeferred);
  };

  /** Fold one successful server answer into the cache (SSE mapping reuse). */
  const apply = (event: Parameters<typeof applyTaskEventToCache>[1]): void => {
    applyTaskEventToCache(queryClient, event);
  };

  const invalidate = (key: readonly unknown[]): void => {
    void queryClient.invalidateQueries({ queryKey: key });
  };

  /** Content edit (`PATCH /api/tasks/{id}`); 423 switches the dialog to force mode. */
  const patchTask = (
    task: BoardTask,
    patch: TaskPatchInput,
    callbacks?: { onLocked?: () => void; onSaved?: (updated: BoardTask) => void },
  ): void => {
    run(
      {
        errorTitleKey: "tasks.mutation.editFailed",
        onError: (error) => {
          if (error.status === 423) {
            callbacks?.onLocked?.();
            return true;
          }
          return false;
        },
      },
      async () => {
        const updated = await mutations().patchTask(task.id, patch);
        apply({ kind: "task.updated", task: updated });
        toast.push({
          kind: "ok",
          title: t("tasks.mutation.saved", { id: updated.id }),
          detail: patch.force
            ? t("tasks.mutation.savedForced")
            : t("tasks.mutation.savedDetail"),
        });
        callbacks?.onSaved?.(updated);
      },
    );
  };

  /** Workflow resume of a live final report (UI-8; status is never 423-locked). */
  const resumeTask = (task: BoardTask): void => {
    run({ errorTitleKey: "tasks.mutation.resumeFailed" }, async () => {
      const updated = await mutations().patchTask(task.id, {
        force: false,
        status: "in-progress",
      });
      apply({ kind: "task.updated", task: updated });
      toast.push({
        kind: "ok",
        title: t("tasks.mutation.resumed", { id: updated.id }),
        detail: t("tasks.mutation.resumedDetail"),
      });
    });
  };

  /** Column move via the row action (the keyboard path — WF-1 precondition). */
  const moveTask = (task: BoardTask, col: string): void => {
    run({ errorTitleKey: "tasks.mutation.moveFailed" }, async () => {
      const updated = await mutations().moveTask(task.id, col);
      apply({ kind: "task.moved", task: updated });
      toast.push({
        kind: "ok",
        title: t("tasks.mutation.moved", { id: updated.id }),
        detail: t("tasks.mutation.movedDetail", { col: t(columnLabelKey(col)) }),
      });
    });
  };

  /**
   * Kanban DnD move (Ф3): optimistic first, reconciled after. The drop is
   * applied to the cache IMMEDIATELY through the same SSE mapping
   * (`task.moved` with the projected row), the wire call follows; the server
   * answer re-applies the authoritative row and the later real SSE event is
   * idempotent on top. Any failure — 422 invalid transition (WF-1 mirror:
   * blocked → done/resolved), network, 409 — rolls the card back to its
   * original row BEFORE the toast: the board never lies about state it could
   * not change. 422 gets its own actionable copy («сначала в работу»); other
   * errors keep the standard move-failed toast.
   */
  const moveTaskOptimistic = (task: BoardTask, col: string, position: number): void => {
    run(
      {
        errorTitleKey: "tasks.mutation.moveFailed",
        onError: (error) => {
          if (error.status === 422) {
            toast.push({
              kind: "error",
              title: t("tasks.mutation.moveInvalidTitle"),
              detail: error.message
                ? `${error.message} · ${t("tasks.mutation.moveRevertedDetail")}`
                : t("tasks.mutation.moveRevertedDetail"),
            });
            return true;
          }
          return false;
        },
      },
      async () => {
        apply({ kind: "task.moved", task: { ...task, col, position } });
        try {
          const updated = await mutations().moveTask(task.id, col, position);
          apply({ kind: "task.moved", task: updated });
          toast.push({
            kind: "ok",
            title: t("tasks.mutation.moved", { id: updated.id }),
            detail: t("tasks.mutation.movedDetail", { col: t(columnLabelKey(col)) }),
          });
        } catch (error) {
          // Roll the projection back to the pre-drag row, then let the
          // wrapper classify (422 branch above / standard toast).
          apply({ kind: "task.moved", task });
          throw error;
        }
      },
    );
  };

  /** Archive (confirm is the page's business — native confirm there). */
  const archiveTask = (task: BoardTask): void => {
    run({ errorTitleKey: "tasks.mutation.archiveFailed" }, async () => {
      await mutations().archiveTask(task.id);
      apply({ kind: "task.archived", task_id: task.id });
      toast.push({
        kind: "ok",
        title: t("tasks.mutation.archived", { id: task.id }),
      });
    });
  };

  /** Restore from the archive (BE-11b: archived_from column fallback open). */
  const unarchiveTask = (task: BoardTask): void => {
    run({ errorTitleKey: "tasks.mutation.unarchiveFailed" }, async () => {
      const result = await mutations().unarchiveTask(task.id);
      if (result.task) apply({ kind: "task.created", task: result.task });
      else invalidate(keys.tasks.board());
      invalidate(keys.tasks.archiveAll);
      toast.push({
        kind: "ok",
        title: t("tasks.mutation.unarchived", { id: task.id }),
      });
    });
  };

  /**
   * Direct task creation (owner decision Ф3: this app creates tasks via
   * `POST /api/tasks` directly — the board's draft-to-memory flow UI-6 is a
   * board-only affordance and is deliberately NOT duplicated here).
   */
  const createTask = (
    payload: TaskCreateInput,
    onCreated?: (created: BoardTask) => void,
  ): void => {
    run({ errorTitleKey: "tasks.mutation.createFailed" }, async () => {
      const created = await mutations().createTask(payload);
      apply({ kind: "task.created", task: created });
      toast.push({
        kind: "ok",
        title: t("tasks.mutation.created", { id: created.id }),
        detail: created.title,
        action: {
          label: t("tasks.mutation.openTask"),
          to: `/tasks/${encodeURIComponent(created.id)}`,
        },
      });
      onCreated?.(created);
    });
  };

  /** Adopt one inbox mirror row (AGG-1; 409 → existing-task link toast). */
  const adoptInboxItem = (memoryId: string): void => {
    run(
      {
        errorTitleKey: "tasks.mutation.adoptFailed",
        onError: (error) => {
          if (error.status === 409) {
            const existing = parseTaskIdFromBody(error.body);
            toast.push({
              kind: "error",
              title: t("tasks.mutation.adoptConflictTitle"),
              detail: existing
                ? t("tasks.mutation.adoptConflictDetail", { id: existing })
                : error.message,
              action: existing
                ? {
                    label: t("tasks.mutation.openTask"),
                    to: `/tasks/${encodeURIComponent(existing)}`,
                  }
                : undefined,
            });
            return true;
          }
          return false;
        },
      },
      async () => {
        const created = await mutations().adoptInboxItem(memoryId);
        apply({ kind: "task.created", task: created });
        invalidate(keys.tasks.inboxAll);
        toast.push({
          kind: "ok",
          title: t("tasks.mutation.adopted", { id: created.id }),
          detail: created.title,
          action: {
            label: t("tasks.mutation.openTask"),
            to: `/tasks/${encodeURIComponent(created.id)}`,
          },
        });
      },
    );
  };

  /**
   * Explicit inbox scan (`POST /api/tasks/inbox/refresh`). `onSettled` fires
   * when the scan finishes OR when the token gate defers it (panel up) —
   * callers drive their spinner from click to that point.
   */
  const refreshInbox = (onSettled: () => void): void => {
    run(
      { errorTitleKey: "tasks.mutation.scanFailed", onDeferred: onSettled },
      async () => {
        try {
          const result = await mutations().refreshInbox();
          invalidate(keys.tasks.inboxAll);
          toast.push({
            kind: "ok",
            title: t("tasks.mutation.scanDone"),
            detail: t("tasks.mutation.scanDetail", {
              found: result.found,
              new: result.new,
            }),
          });
        } finally {
          onSettled();
        }
      },
    );
  };

  return {
    run,
    patchTask,
    resumeTask,
    moveTask,
    moveTaskOptimistic,
    archiveTask,
    unarchiveTask,
    createTask,
    adoptInboxItem,
    refreshInbox,
  };
}

export type TaskMutations = ReturnType<typeof createTaskMutations>;

/** React wiring: contexts → factory (stable identity across renders). */
export function useTaskMutations(): TaskMutations {
  const gateway = useGateway();
  const queryClient = useQueryClient();
  const uiToken = useUiToken();
  const toast = useToast();
  const t = useT();
  return useMemo(
    () =>
      createTaskMutations({
        runAuthorized: uiToken.runAuthorized,
        toast,
        t,
        gateway,
        queryClient,
      }),
    [gateway, queryClient, t, toast, uiToken],
  );
}

/** Extract `task_id` from a 409 adopt body (wire: `{"task_id": "…"}`). */
export function parseTaskIdFromBody(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "task_id" in parsed) {
      const value = (parsed as { task_id: unknown }).task_id;
      if (typeof value === "string" && value.length > 0) return value;
    }
  } catch {
    // Body was not JSON — fall through to the plain message.
  }
  return null;
}
