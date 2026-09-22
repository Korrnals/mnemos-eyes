import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type {
  EnrollmentCreateInput,
  EnrollmentCreatedResult,
} from "@/gateway/boardTypes";
import { isAgentsMutationSource } from "@/gateway/capabilities";
import type { MemoryGateway } from "@/gateway/MemoryGateway";
import { useGateway } from "@/gateway/GatewayContext";
import { isApiError } from "@/lib/errors";
import { keys } from "@/lib/queryKeys";
import { GC_TIMES, STALE_TIMES } from "@/lib/queryClient";
import { useToast } from "@/components/Toast/toastContext";
import type { ToastApi } from "@/components/Toast/toastContext";
import { useUiToken } from "@/features/ui-token/UiTokenContext";
import { useT } from "@/i18n";
import { useI18n } from "@/i18n";
import { formatTaskDate } from "@/features/tasks/taskStatus";
import type { TranslationKey, TranslateFn } from "@/i18n";

/**
 * AGW-5 phase 2 — enrollment-token data hooks (useExecutorMutations
 * posture): every run goes through the ui-token gate (no token → LoginDialog
 * with the run queued), 401 rethrows so the gate can take over, every other
 * failure lands in an error toast carrying the SERVER's message (409 live
 * quota, 422 unknown harness_hint, 429 rate, 404 unknown id, 409 revoke of
 * a used/expired token — text from the API, never invented).
 *
 * The LIST query is ui-gated by the token PRESENCE (the route answers
 * _guard_ui_write — an open read it is not): without a stored token the
 * query idles and the panel shows its honest login hint instead of an
 * error. Framework-free factory + thin React hook, as everywhere.
 */

/** Enrollment tokens for the owner panel (`GET /api/executors/enrollment`). */
export function useEnrollments(options: { tokenPresent: boolean }) {
  const gateway = useGateway();
  const capable = isAgentsMutationSource(gateway);
  return useQuery({
    queryKey: keys.agents.enrollment.list(),
    queryFn: ({ signal }) => {
      if (!isAgentsMutationSource(gateway)) {
        throw new Error("useEnrollments: gateway has no agents mutation capability.");
      }
      return gateway.listEnrollments(signal);
    },
    enabled: capable && options.tokenPresent,
    staleTime: STALE_TIMES.agentsExecutors,
    gcTime: GC_TIMES.agentsExecutors,
  });
}

export interface EnrollmentActionDeps {
  /** Gate runner (UiTokenGate.runAuthorized). */
  runAuthorized: (run: () => Promise<void>, onDeferred?: () => void) => void;
  /** Toast sink. */
  toast: Pick<ToastApi, "push">;
  /** Translate function. */
  t: TranslateFn;
  /** Language (dates in toasts). */
  lang: "ru" | "en";
  /** Mutation-capable gateway (asserted, not capability-guarded). */
  gateway: MemoryGateway;
  /** Cache owner. */
  queryClient: QueryClient;
  /** Confirm sink — injected so tests avoid native dialogs. */
  confirm: (message: string) => boolean;
}

export function createEnrollmentActions(deps: EnrollmentActionDeps) {
  const { runAuthorized, toast, t, lang, queryClient, confirm } = deps;
  const mutations = () => {
    if (!isAgentsMutationSource(deps.gateway)) {
      throw new Error("enrollment actions: gateway has no agents mutation capability.");
    }
    return deps.gateway;
  };

  /** The registry feeds the strip/settings pages; the token list feeds this. */
  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: keys.agents.enrollment.all });
    void queryClient.invalidateQueries({ queryKey: keys.agents.executors.all });
  };

  const run = (errorTitleKey: TranslationKey, fn: () => Promise<void>): void => {
    runAuthorized(async () => {
      try {
        await fn();
      } catch (error) {
        // 401 escalates to the token gate (drop token → dialog → retry).
        if (isApiError(error) && error.status === 401) throw error;
        toast.push({
          kind: "error",
          title: t(errorTitleKey),
          detail: error instanceof Error ? error.message : undefined,
        });
      }
    });
  };

  /**
   * Mint a token (`POST /api/executors/enrollment`). Success hands the
   * Created result to the caller — the token screen renders from it (the
   * plaintext exists only in this answer). The list invalidates so the
   * panel shows the new live row even if the dialog never reopens.
   */
  const createEnrollment = (
    payload: EnrollmentCreateInput,
    callbacks?: {
      onCreated?: (created: EnrollmentCreatedResult) => void;
      onSettled?: () => void;
    },
  ): void => {
    run("agents.enrollment.createFailed", async () => {
      try {
        const created = await mutations().createEnrollment(payload);
        invalidate();
        const expires = Date.parse(created.enrollment.expires_at);
        toast.push({
          kind: "ok",
          title: t("agents.enrollment.created"),
          detail:
            Number.isFinite(expires) && created.enrollment.label
              ? `${created.enrollment.label} · ${t("agents.enrollment.ttl", {
                  time: formatTaskDate(created.enrollment.expires_at, lang),
                })}`
              : Number.isFinite(expires)
                ? t("agents.enrollment.ttl", {
                    time: formatTaskDate(created.enrollment.expires_at, lang),
                  })
                : undefined,
        });
        callbacks?.onCreated?.(created);
      } finally {
        callbacks?.onSettled?.();
      }
    });
  };

  /**
   * Revoke a LIVE token (`DELETE /api/executors/enrollment/{id}`).
   * Confirm first — a revoked token can never connect; the wire is
   * idempotent on already-revoked (200) and 409s used/expired with the
   * server's reason in the toast.
   */
  const revokeEnrollment = (enrollment: {
    enrollment_id: string;
    label: string;
    state: string;
  }): void => {
    if (enrollment.state !== "created") return; // dead tokens have no button
    const confirmed = confirm(
      t("agents.enrollment.revokeConfirm", {
        label: enrollment.label || enrollment.enrollment_id,
      }),
    );
    if (!confirmed) return;
    run("agents.enrollment.revokeFailed", async () => {
      const result = await mutations().revokeEnrollment(enrollment.enrollment_id);
      invalidate();
      toast.push({
        kind: "ok",
        title: t("agents.enrollment.revoked"),
        detail: result.enrollment.label || result.enrollment.enrollment_id,
      });
    });
  };

  return { createEnrollment, revokeEnrollment };
}

export type EnrollmentActions = ReturnType<typeof createEnrollmentActions>;

/**
 * Honest copy feedback (review P2-2; the Markdown.tsx CopyButton canon):
 * the «Скопировано» flash fires ONLY on a resolved write — clipboard absent
 * (non-secure context) or a rejection is a FAILURE the caller must show.
 * A lying flash on a once-only enrollment token quietly loses it.
 * `copied` carries the flash KEY (a dialog copies several values); `failed`
 * stays set until the next copy attempt, so the manual-selection hint has
 * time to be read.
 */
export function useHonestCopy(resetMs = 2000): {
  copied: string | null;
  failed: boolean;
  copy: (key: string, text: string) => void;
} {
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(
    (key: string, text: string) => {
      setFailed(false);
      let write: Promise<void> | undefined;
      try {
        write = navigator.clipboard?.writeText(text);
      } catch {
        write = undefined;
      }
      if (!write) {
        setFailed(true);
        return;
      }
      void write.then(
        () => {
          setCopied(key);
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(null), resetMs);
        },
        () => setFailed(true),
      );
    },
    [resetMs],
  );
  return { copied, failed, copy };
}

/** React wiring: contexts → factory (stable identity across renders). */
export function useEnrollmentActions(): EnrollmentActions {
  const gateway = useGateway();
  const queryClient = useQueryClient();
  const uiToken = useUiToken();
  const toast = useToast();
  const t = useT();
  const { lang } = useI18n();
  return useMemo(
    () =>
      createEnrollmentActions({
        runAuthorized: uiToken.runAuthorized,
        toast,
        t,
        lang,
        gateway,
        queryClient,
        confirm: (message) => window.confirm(message),
      }),
    [gateway, queryClient, t, toast, uiToken, lang],
  );
}
