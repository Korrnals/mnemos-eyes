import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { ExecutorItem, ExecutorPatchInput } from "@/gateway/boardTypes";
import { isAgentsMutationSource } from "@/gateway/capabilities";
import type { MemoryGateway } from "@/gateway/MemoryGateway";
import { useGateway } from "@/gateway/GatewayContext";
import { isApiError } from "@/lib/errors";
import { keys } from "@/lib/queryKeys";
import { useToast } from "@/components/Toast/toastContext";
import type { ToastApi } from "@/components/Toast/toastContext";
import { useUiToken } from "@/features/ui-token/UiTokenContext";
import type { TranslationKey, TranslateFn } from "@/i18n";
import { useT } from "@/i18n";

/**
 * AGW-4 executor-registry mutations — the gated write path of the
 * `/agents/harnesses` page, wired exactly like useAssignmentMutations:
 * every run goes through the ui-token gate (no token → LoginDialog with
 * the run queued), 401 rethrows so the gate can take over, every other
 * failure lands in an error toast carrying the SERVER's message (404
 * unknown id, 409 revoked-is-terminal / duplicate name, 422 bad target —
 * text from the API, never invented).
 *
 * State machine honesty (Amd 2 §4): approve moves pending→approved but
 * does NOT flip the routing flag — an approved row still needs
 * «Включить»; revoke is the TERMINAL kill-switch (confirm says so);
 * delete is a HARD registry removal — the executor's token dies with the
 * row, active assignments keep their pins (two-clock rule).
 *
 * Framework-free factory (unit-testable with a mock adapter + real
 * QueryClient + recording toast) + a thin React hook.
 */

/** Standard error handling for one authorized mutation run. */
interface RunOptions {
  /** Toast title when the run fails. */
  errorTitleKey: TranslationKey;
}

/**
 * Optional run-lifecycle callbacks (PR #99 review P3-1): onSuccess runs
 * after the write + its toast; onError runs ONLY on terminal failures —
 * a 401 goes to the token gate with the run queued for retry, so the
 * caller keeps its in-flight state through the dialog.
 */
export interface ExecutorMutationCallbacks {
  onSuccess?: () => void;
  onError?: () => void;
}

export interface ExecutorMutationDeps {
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
  /** Confirm sink — injected so tests avoid native dialogs. */
  confirm: (message: string) => boolean;
}

export function createExecutorMutations(deps: ExecutorMutationDeps) {
  const { runAuthorized, toast, t, queryClient, confirm } = deps;
  const mutations = () => {
    if (!isAgentsMutationSource(deps.gateway)) {
      throw new Error("executor mutations: gateway has no agents mutation capability.");
    }
    return deps.gateway;
  };

  /** The registry feeds the strip, the settings page and this page. */
  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: keys.agents.executors.all });
    // Routing annotations derive from approved+enabled — refetch the queue.
    void queryClient.invalidateQueries({ queryKey: keys.agents.assignments.all });
  };

  const run = (
    options: RunOptions,
    fn: () => Promise<void>,
    callbacks?: ExecutorMutationCallbacks,
  ): void => {
    runAuthorized(async () => {
      try {
        await fn();
        callbacks?.onSuccess?.();
      } catch (error) {
        // 401 escalates to the token gate (drop token → dialog → retry).
        if (isApiError(error) && error.status === 401) throw error;
        toast.push({
          kind: "error",
          title: t(options.errorTitleKey),
          detail: error instanceof Error ? error.message : undefined,
        });
        callbacks?.onError?.();
      }
    });
  };

  const patch = (executor: ExecutorItem, body: ExecutorPatchInput): Promise<void> =>
    mutations().patchExecutor(executor.id, body).then(invalidate);

  /**
   * Approve a pending registration (`PATCH {state:"approved"}`). The
   * MAIN action of the page — the whole connect flow funnels here. The
   * toast honestly points at the follow-up: routing needs «Включить».
   * Optional callbacks (PR #99 review P3-1): the paste-back verify
   * consumes its one-shot context in onSuccess — never before the write.
   */
  const approveExecutor = (
    executor: ExecutorItem,
    callbacks?: ExecutorMutationCallbacks,
  ): void => {
    run({ errorTitleKey: "agents.executors.actionFailed" }, async () => {
      await patch(executor, { state: "approved" });
      toast.push({
        kind: "ok",
        title: t("agents.executors.approved", { name: executor.name }),
        detail: t("agents.executors.approvedDetail"),
      });
    }, callbacks);
  };

  /** Flip the routing kill-switch (`PATCH {enabled:bool}`). */
  const setExecutorEnabled = (executor: ExecutorItem, enabled: boolean): void => {
    run({ errorTitleKey: "agents.executors.actionFailed" }, async () => {
      await patch(executor, { enabled });
      toast.push({
        kind: "ok",
        title: t(
          enabled ? "agents.executors.enabled" : "agents.executors.disabled",
          { name: executor.name },
        ),
      });
    });
  };

  /**
   * Revoke (TERMINAL kill-switch, `PATCH {state:"revoked"}`). Confirm
   * first with the honest text — trust is NOT restorable; the poller
   * must re-register (a new identity, a new secret).
   */
  const revokeExecutor = (executor: ExecutorItem): void => {
    if (!confirm(t("agents.executors.revokeConfirm", { name: executor.name }))) {
      return;
    }
    run({ errorTitleKey: "agents.executors.actionFailed" }, async () => {
      await patch(executor, { state: "revoked" });
      toast.push({
        kind: "ok",
        title: t("agents.executors.revoked", { name: executor.name }),
        detail: t("agents.executors.revokedDetail"),
      });
    });
  };

  /**
   * Remove the registry record (DELETE — verified HARD delete: the token
   * dies with the row, active assignments keep their pins, the name is
   * freed for re-registration). Confirm states exactly that.
   */
  const removeExecutor = (executor: ExecutorItem): void => {
    if (!confirm(t("agents.executors.deleteConfirm", { name: executor.name }))) {
      return;
    }
    run({ errorTitleKey: "agents.executors.actionFailed" }, async () => {
      await mutations().deleteExecutor(executor.id);
      invalidate();
      toast.push({
        kind: "ok",
        title: t("agents.executors.deleted", { name: executor.name }),
      });
    });
  };

  /**
   * Generic owner PATCH (AGW-6 B settings card): the caller passes a DIFF
   * body — only the genuinely changed fields (the route does
   * model_dump(exclude_none=True); capabilities:[] is a VALID deliberate
   * wipe). The same gate + server-text error toasts as every action here;
   * the success toast is optional (the card saves are quiet unless the
   * caller asks for one).
   */
  const updateExecutor = (
    executor: ExecutorItem,
    body: ExecutorPatchInput,
    okTitleKey?: TranslationKey,
  ): void => {
    run({ errorTitleKey: "agents.executors.actionFailed" }, async () => {
      await patch(executor, body);
      if (okTitleKey) {
        toast.push({ kind: "ok", title: t(okTitleKey, { name: executor.name }) });
      }
    });
  };

  return {
    approveExecutor,
    setExecutorEnabled,
    revokeExecutor,
    removeExecutor,
    updateExecutor,
  };
}

export type ExecutorMutations = ReturnType<typeof createExecutorMutations>;

/** React wiring: contexts → factory (stable identity across renders). */
export function useExecutorMutations(): ExecutorMutations {
  const gateway = useGateway();
  const queryClient = useQueryClient();
  const uiToken = useUiToken();
  const toast = useToast();
  const t = useT();
  return useMemo(
    () =>
      createExecutorMutations({
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
