import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { AssignmentCancelledResult, AssignmentCreateInput, AssignmentCreatedResult, BoardTask } from "@/gateway/boardTypes";
import { isAgentsMutationSource } from "@/gateway/capabilities";
import type { MemoryGateway } from "@/gateway/MemoryGateway";
import { useGateway } from "@/gateway/GatewayContext";
import { isApiError } from "@/lib/errors";
import type { ApiError } from "@/lib/errors";
import { keys } from "@/lib/queryKeys";
import { useToast } from "@/components/Toast/toastContext";
import type { ToastApi } from "@/components/Toast/toastContext";
import { useUiToken } from "@/features/ui-token/UiTokenContext";
import type { TranslationKey } from "@/i18n";
import { useT, type TranslateFn } from "@/i18n";
import type { AssignmentItem } from "@/gateway/boardTypes";

/**
 * AGW-2 assignment mutations — the gated write path of the agents domain,
 * wired like the Ф3 task mutations (useTaskMutations): every run goes
 * through the ui-token gate (no token → LoginDialog with the run queued),
 * 401 rethrows so the gate can take over, every other failure lands in an
 * error toast carrying the SERVER's message (409 ≤1-invariant, 429 rate
 * budget, 403/422 gates — text from the API, never invented).
 *
 * Framework-free factory (unit-testable with a mock adapter + real
 * QueryClient + recording toast) + a thin React hook.
 */

/** Standard error handling for one authorized mutation run. */
interface RunOptions {
  /** Toast title when the run fails. */
  errorTitleKey: TranslationKey;
  /** Custom error branch; return true when handled. */
  onError?: (error: ApiError) => boolean;
  /** Fires when the token gate defers the run (spinner owners reset here). */
  onDeferred?: () => void;
}

export interface AssignmentMutationDeps {
  /** Gate runner (UiTokenGate.runAuthorized). */
  runAuthorized: (run: () => Promise<void>, onDeferred?: () => void) => void;
  /** Toast sink. */
  toast: Pick<ToastApi, "push">;
  /** Translate function. */
  t: TranslateFn;
  /** Mutation-capable gateway (asserted, not capability-guarded). */
  gateway: MemoryGateway;
  /** Cache owner. */
  queryClient: QueryClient;
  /** Confirm sink — injected so tests avoid native dialogs (page passes
   * `window.confirm` through its own policy). */
  confirm: (message: string) => boolean;
}

export function createAssignmentMutations(deps: AssignmentMutationDeps) {
  const { runAuthorized, toast, t, queryClient, confirm } = deps;
  const mutations = () => {
    if (!isAgentsMutationSource(deps.gateway)) {
      throw new Error("assignment mutations: gateway has no agents mutation capability.");
    }
    return deps.gateway;
  };

  const run = (options: RunOptions, fn: () => Promise<void>): void => {
    runAuthorized(async () => {
      try {
        await fn();
      } catch (error) {
        // 401 escalates to the token gate (drop token → dialog → retry).
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

  const invalidate = (key: readonly unknown[]): void => {
    void queryClient.invalidateQueries({ queryKey: key });
  };

  /**
   * «Взять в работу» (`POST /api/assignments`). Success closes the sheet
   * (onQueued) and toasts the matrix-A copy; the queue refetches through
   * the invalidation, the later assignment.created SSE event is idempotent
   * on top of it. `onSettled` fires on success AND handled failure — the
   * sheet's spinner resets there.
   */
  const createAssignment = (
    task: BoardTask,
    payload: AssignmentCreateInput,
    callbacks?: {
      onQueued?: (created: AssignmentCreatedResult) => void;
      onDeferred?: () => void;
      onSettled?: () => void;
    },
  ): void => {
    run(
      {
        errorTitleKey: "agents.assign.createFailed",
        onDeferred: callbacks?.onDeferred,
      },
      async () => {
        try {
          const created = await mutations().createAssignment({
            ...payload,
            task_id: task.id,
          });
          invalidate(keys.agents.assignments.all);
          toast.push({
            kind: "ok",
            title: t("agents.assign.created", { id: task.id }),
            detail: t("agents.assign.createdDetail"),
          });
          callbacks?.onQueued?.(created);
        } finally {
          callbacks?.onSettled?.();
        }
      },
    );
  };

  /**
   * Cancel an active assignment (queued/claimed/running). The STOP-SIGNAL
   * honesty (spec §2.4): confirm first — «исполнителю будет отправлен сигнал
   * остановки»; the toast says the cancellation was SENT (asynchronous, the
   * executor decides when to observe it), never "stopped".
   */
  const cancelAssignment = (
    assignment: AssignmentItem,
    callbacks?: { onCancelled?: (result: AssignmentCancelledResult) => void },
  ): void => {
    const confirmed = confirm(t("agents.cancel.confirm"));
    if (!confirmed) return;
    run({ errorTitleKey: "agents.cancel.failed" }, async () => {
      const result = await mutations().cancelAssignment(
        assignment.id,
        t("agents.cancel.reason"),
      );
      invalidate(keys.agents.assignments.all);
      if (result.moved.length > 0) invalidate(keys.tasks.board());
      toast.push({
        kind: "ok",
        title: t("agents.cancel.sent", { id: assignment.task_id }),
        detail: t("agents.cancel.sentDetail"),
      });
      callbacks?.onCancelled?.(result);
    });
  };

  return { createAssignment, cancelAssignment };
}

export type AssignmentMutations = ReturnType<typeof createAssignmentMutations>;

/** React wiring: contexts → factory (stable identity across renders). */
export function useAssignmentMutations(): AssignmentMutations {
  const gateway = useGateway();
  const queryClient = useQueryClient();
  const uiToken = useUiToken();
  const toast = useToast();
  const t = useT();
  return useMemo(
    () =>
      createAssignmentMutations({
        runAuthorized: uiToken.runAuthorized,
        toast,
        t,
        gateway,
        queryClient,
        confirm: (message) => window.confirm(message),
      }),
    [gateway, queryClient, t, toast, uiToken],
  );
}
