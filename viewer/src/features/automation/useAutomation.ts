import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  HookCreateInput,
  HookPatchInput,
  HookRule,
  LaunchesPage,
  RuleDeletedAck,
  ScheduleCreateInput,
  SchedulePatchInput,
  ScheduleRule,
  ScheduleRunResult,
} from "@/gateway/boardTypes";
import { isAutomationMutationSource, isAutomationSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import { isApiError } from "@/lib/errors";
import { keys } from "@/lib/queryKeys";
import { GC_TIMES, STALE_TIMES } from "@/lib/queryClient";
import type { TranslationKey } from "@/i18n";
import { useT } from "@/i18n";
import { useToast } from "@/components/Toast/toastContext";
import { useUiToken } from "@/features/ui-token/UiTokenContext";
import { useMemo } from "react";

/**
 * SCHED-1-UI data hooks (ADR 0013 §8): reads capability-gated
 * (`isAutomationSource` — mnemos mode stays idle), mutations through the
 * SAME ui-token gate pattern as the agents domain (useTaskMutations /
 * useAssignmentMutations posture): runAuthorized, 401 rethrow, server error
 * text in toasts, targeted invalidation. `runScheduleNow` does NOT build a
 * second state machine: the wire call IS the server's create-assignment
 * path (created_by='owner', ADR 0013 §2), and the UI surfaces the result
 * through the EXISTING assignment surfaces — the shared
 * `agents.assignments` cache key + the task's execution tab link.
 */

/** Engine/caps/condition-meta projection (`GET /api/automation/status`). */
export function useAutomationStatus() {
  const gateway = useGateway();
  const capable = isAutomationSource(gateway);
  return useQuery({
    queryKey: keys.automation.status(),
    queryFn: ({ signal }) => {
      if (!isAutomationSource(gateway)) {
        throw new Error("useAutomationStatus: gateway has no automation capability.");
      }
      return gateway.automationStatus(signal);
    },
    enabled: capable,
    staleTime: STALE_TIMES.automationStatus,
    gcTime: GC_TIMES.automationStatus,
  });
}

/** Schedule rules incl. soft-deleted retention rows. */
export function useSchedules() {
  const gateway = useGateway();
  const capable = isAutomationSource(gateway);
  return useQuery({
    queryKey: keys.automation.schedules(),
    queryFn: ({ signal }) => {
      if (!isAutomationSource(gateway)) {
        throw new Error("useSchedules: gateway has no automation capability.");
      }
      return gateway.listSchedules(signal);
    },
    enabled: capable,
    staleTime: STALE_TIMES.automationRules,
    gcTime: GC_TIMES.automationRules,
  });
}

/** Hook rules incl. soft-deleted retention rows. */
export function useHookRules() {
  const gateway = useGateway();
  const capable = isAutomationSource(gateway);
  return useQuery({
    queryKey: keys.automation.hooks(),
    queryFn: ({ signal }) => {
      if (!isAutomationSource(gateway)) {
        throw new Error("useHookRules: gateway has no automation capability.");
      }
      return gateway.listHooks(signal);
    },
    enabled: capable,
    staleTime: STALE_TIMES.automationRules,
    gcTime: GC_TIMES.automationRules,
  });
}

/**
 * Launch journal (cursor contract, ADR 0011 §11): the query holds the
 * stitched chain; «ещё» appends the next cursor page into the same entry.
 */
export function useLaunches() {
  const gateway = useGateway();
  const capable = isAutomationSource(gateway);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: keys.automation.launches({ limit: 50 }),
    queryFn: ({ signal }) => {
      if (!isAutomationSource(gateway)) {
        throw new Error("useLaunches: gateway has no automation capability.");
      }
      return gateway.listLaunches({ limit: 50 }, signal);
    },
    enabled: capable,
    staleTime: STALE_TIMES.automationLaunches,
    gcTime: GC_TIMES.automationLaunches,
  });

  /** Load one more cursor page and stitch it into the chained list. */
  const loadMore = useCallback(
    async (cursor: string): Promise<void> => {
      if (!isAutomationSource(gateway)) return;
      const next = await gateway.listLaunches({ limit: 50, cursor });
      const base = queryClient.getQueryData<LaunchesPage>(
        keys.automation.launches({ limit: 50 }),
      );
      if (base) {
        queryClient.setQueryData(keys.automation.launches({ limit: 50 }), {
          ...base,
          items: [...base.items, ...next.items],
          next_cursor: next.next_cursor,
        });
      }
    },
    [gateway, queryClient],
  );

  return { ...query, loadMore };
}

export interface AutomationMutationDeps {
  runAuthorized: (run: () => Promise<void>, onDeferred?: () => void) => void;
  toast: { push: (input: { kind: "ok" | "error"; title: string; detail?: string }) => void };
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
  gateway: Parameters<typeof isAutomationMutationSource>[0];
  queryClient: ReturnType<typeof useQueryClient>;
  confirm: (message: string) => boolean;
}

/** The mutation surface (factory — unit-testable without React). */
export function createAutomationMutations(deps: AutomationMutationDeps) {
  const { runAuthorized, toast, t, queryClient, confirm } = deps;
  const mutations = () => {
    if (!isAutomationMutationSource(deps.gateway)) {
      throw new Error("automation mutations: gateway has no automation capability.");
    }
    return deps.gateway;
  };
  const run = (
    errorTitleKey: TranslationKey,
    fn: () => Promise<void>,
    onSettled?: () => void,
  ): void => {
    runAuthorized(async () => {
      try {
        await fn();
      } catch (error) {
        // 401 rethrows — the gate takes over (drop token → dialog → retry).
        if (isApiError(error) && error.status === 401) throw error;
        toast.push({
          kind: "error",
          title: t(errorTitleKey),
          detail: error instanceof Error ? error.message : undefined,
        });
      } finally {
        onSettled?.();
      }
    });
  };
  const invalidateRules = (): void => {
    void queryClient.invalidateQueries({ queryKey: keys.automation.schedules() });
    void queryClient.invalidateQueries({ queryKey: keys.automation.hooks() });
    void queryClient.invalidateQueries({ queryKey: keys.automation.launches({ limit: 50 }).slice(0, 2) });
  };

  const createSchedule = (
    payload: ScheduleCreateInput,
    callbacks?: { onDone?: (rule: ScheduleRule) => void; onSettled?: () => void },
  ): void => {
    run(
      "automation.mutation.createFailed",
      async () => {
        const rule = await mutations().createSchedule(payload);
        invalidateRules();
        toast.push({ kind: "ok", title: t("automation.mutation.created", { name: rule.name }) });
        callbacks?.onDone?.(rule);
      },
      callbacks?.onSettled,
    );
  };

  const patchSchedule = (
    ruleId: number,
    patch: SchedulePatchInput,
    onSettled?: () => void,
  ): void => {
    run(
      "automation.mutation.patchFailed",
      async () => {
        await mutations().patchSchedule(ruleId, patch);
        invalidateRules();
      },
      onSettled,
    );
  };

  const deleteSchedule = (rule: ScheduleRule): void => {
    if (!confirm(t("automation.mutation.deleteConfirm", { name: rule.name }))) return;
    run("automation.mutation.deleteFailed", async () => {
      await mutations().deleteSchedule(rule.id);
      invalidateRules();
      toast.push({
        kind: "ok",
        title: t("automation.mutation.deleted", { name: rule.name }),
        detail: t("automation.mutation.retainedNote"),
      });
    });
  };

  /**
   * «Запустить сейчас» (ADR 0013 §8): reuses the assignment machinery
   * WHOLE — the server route runs the SAME create-assignment code path;
   * the UI shows the outcome through the shared assignment cache + the
   * task's execution tab (no second state machine lives here).
   */
  const runScheduleNow = (
    rule: ScheduleRule,
    callbacks?: { onLaunched?: (result: ScheduleRunResult) => void; onSettled?: () => void },
  ): void => {
    run(
      "automation.mutation.runFailed",
      async () => {
        const result = await mutations().runScheduleNow(rule.id);
        invalidateRules();
        // The queue IS the assignment surface (AGW-1/2): one invalidation
        // makes the new row visible everywhere — list, cards, task tab.
        void queryClient.invalidateQueries({ queryKey: ["agents", "assignments"] });
        if (result.decision === "launched" && result.assignment_id !== null) {
          toast.push({
            kind: "ok",
            title: t("automation.mutation.launched", { name: rule.name }),
            detail: t("automation.mutation.launchedDetail", { id: rule.task_id }),
          });
        } else {
          toast.push({
            kind: "ok",
            title: t("automation.mutation.skipped", { name: rule.name }),
            detail: result.reason || t("automation.mutation.skippedDetail"),
          });
        }
        callbacks?.onLaunched?.(result);
      },
      callbacks?.onSettled,
    );
  };

  const createHookRule = (
    payload: HookCreateInput,
    callbacks?: { onDone?: (rule: HookRule) => void; onSettled?: () => void },
  ): void => {
    run(
      "automation.mutation.createFailed",
      async () => {
        const rule = await mutations().createHook(payload);
        invalidateRules();
        toast.push({ kind: "ok", title: t("automation.mutation.created", { name: rule.name }) });
        callbacks?.onDone?.(rule);
      },
      callbacks?.onSettled,
    );
  };

  const patchHookRule = (ruleId: number, patch: HookPatchInput, onSettled?: () => void): void => {
    run(
      "automation.mutation.patchFailed",
      async () => {
        await mutations().patchHook(ruleId, patch);
        invalidateRules();
      },
      onSettled,
    );
  };

  const deleteHookRule = (rule: HookRule): void => {
    if (!confirm(t("automation.mutation.deleteConfirm", { name: rule.name }))) return;
    run("automation.mutation.deleteFailed", async () => {
      const ack: RuleDeletedAck = await mutations().deleteHook(rule.id);
      void ack;
      invalidateRules();
      toast.push({
        kind: "ok",
        title: t("automation.mutation.deleted", { name: rule.name }),
        detail: t("automation.mutation.retainedNote"),
      });
    });
  };

  return {
    createSchedule,
    patchSchedule,
    deleteSchedule,
    runScheduleNow,
    createHookRule,
    patchHookRule,
    deleteHookRule,
  };
}

export type AutomationMutations = ReturnType<typeof createAutomationMutations>;

/** React wiring: contexts → factory (stable identity). */
export function useAutomationMutations(): AutomationMutations {
  const gateway = useGateway();
  const queryClient = useQueryClient();
  const uiToken = useUiToken();
  const toast = useToast();
  const t = useT();
  return useMemo(
    () =>
      createAutomationMutations({
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
