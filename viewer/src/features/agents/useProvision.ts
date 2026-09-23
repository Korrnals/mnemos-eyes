import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { ProvisionCreateInput } from "@/gateway/boardTypes";
import { isAgentsMutationSource } from "@/gateway/capabilities";
import type { MemoryGateway } from "@/gateway/MemoryGateway";
import { useGateway } from "@/gateway/GatewayContext";
import { isApiError } from "@/lib/errors";
import { keys } from "@/lib/queryKeys";
import { GC_TIMES } from "@/lib/queryClient";
import { useToast } from "@/components/Toast/toastContext";
import type { ToastApi } from "@/components/Toast/toastContext";
import { useUiToken } from "@/features/ui-token/UiTokenContext";
import { useT } from "@/i18n";
import type { TranslateFn } from "@/i18n";
import { isProvisionLive } from "./provisionTypes";

/**
 * AGW-11 provision data hooks + actions (the useExecutorMutations posture):
 * every write goes through the ui-token gate (no token → LoginDialog with
 * the run queued), 401 rethrows so the gate can take over, every other
 * failure lands in an error toast carrying the SERVER's message (422
 * password-auth-off / charset / unknown harness, 409 live job per
 * host:port, 429 anti-spray, 503 provisioner disabled — text from the
 * API, never invented). The ssh secret exists in the REQUEST object only
 * — never state that outlives the submit, never a log line.
 *
 * The job feed is the invalidation-only SSE bridge (provisioning.* →
 * keys.agents.provision.*) PLUS a slow poll while the job is live: the
 * stream is at-most-once, a dropped frame must not freeze the card
 * («тихий отказ» запрещён). The ACTIVE JOB id rides sessionStorage so a
 * reload re-attaches the card to a still-running job.
 */

/** The poll cadence while a job is live (SSE is the fast path). */
const LIVE_POLL_MS = 3000;

const ACTIVE_JOB_KEY = "vesmaro.provision.active";

export interface ActiveProvisionJob {
  readonly job_id: string;
  readonly host: string;
  readonly port: number;
  /**
   * PR #99 review P3-2: the executor name the OWNER typed at submit —
   * the retry form re-seeds from here (the wire job row never echoes
   * it: the server falls back to the host when empty).
   */
  readonly name: string;
}

function readActiveJob(): ActiveProvisionJob | null {
  try {
    const raw = window.sessionStorage.getItem(ACTIVE_JOB_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as ActiveProvisionJob).job_id !== "string"
    ) {
      return null;
    }
    // Normalize defensively: an older session's payload may predate the
    // name field (a tab that survived a deploy) — missing pieces degrade
    // to the server defaults, never to a broken card.
    const candidate = parsed as Partial<ActiveProvisionJob>;
    return {
      job_id: candidate.job_id ?? "",
      host: typeof candidate.host === "string" ? candidate.host : "",
      port: typeof candidate.port === "number" ? candidate.port : 22,
      name: typeof candidate.name === "string" ? candidate.name : "",
    };
  } catch {
    return null;
  }
}

/**
 * The active job (sessionStorage-backed): re-attach after reload, clear
 * when the owner starts over. The setter keeps sessionStorage in sync;
 * the read happens once per mount (a storage event across tabs is out of
 * scope — one owner, one card).
 */
export function useActiveProvisionJob(): {
  active: ActiveProvisionJob | null;
  attach: (job: ActiveProvisionJob) => void;
  detach: () => void;
} {
  const [active, setActive] = useState<ActiveProvisionJob | null>(() =>
    readActiveJob(),
  );
  const attach = useCallback((job: ActiveProvisionJob): void => {
    try {
      window.sessionStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify(job));
    } catch {
      // Private mode — the card lives for this render tree only.
    }
    setActive(job);
  }, []);
  const detach = useCallback((): void => {
    try {
      window.sessionStorage.removeItem(ACTIVE_JOB_KEY);
    } catch {
      // See attach.
    }
    setActive(null);
  }, []);
  return { active, attach, detach };
}

/**
 * One job's status feed. Polls only while live; terminal verdicts stay
 * cached (staleTime 0 — every invalidation refetches the truth).
 */
export function useProvisionJob(jobId: string | null) {
  const gateway = useGateway();
  const capable = isAgentsMutationSource(gateway);
  return useQuery({
    queryKey: keys.agents.provision.job(jobId ?? ""),
    queryFn: ({ signal }) => {
      if (jobId === null || !isAgentsMutationSource(gateway)) {
        throw new Error("useProvisionJob: gateway has no agents mutation capability.");
      }
      return gateway.getProvisionJob(jobId, signal);
    },
    enabled: capable && jobId !== null,
    // The SSE invalidation pushes; the poll is the at-most-once hedge.
    refetchInterval: (query) =>
      query.state.data && isProvisionLive(query.state.data.job.state)
        ? LIVE_POLL_MS
        : false,
    gcTime: GC_TIMES.agentsExecutors,
  });
}

export interface ProvisionActionDeps {
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
}

export interface ProvisionSubmitResult {
  readonly job_id: string;
  readonly enrollment_id: string;
}

export function createProvisionActions(deps: ProvisionActionDeps) {
  const { runAuthorized, toast, t, queryClient } = deps;
  const mutations = () => {
    if (!isAgentsMutationSource(deps.gateway)) {
      throw new Error("provision actions: gateway has no agents mutation capability.");
    }
    return deps.gateway;
  };

  /**
   * Queue a job (`POST /api/executors/provision`). Success hands the
   * {job_id, enrollment_id} pair to the caller — the card switches to
   * the feed; the token NEVER exists client-side at all on this path.
   */
  const submitProvision = (
    payload: ProvisionCreateInput,
    callbacks?: {
      onCreated?: (result: ProvisionSubmitResult) => void;
      onSettled?: () => void;
    },
  ): void => {
    runAuthorized(async () => {
      try {
        const created = await mutations().createProvisionJob(payload);
        void queryClient.invalidateQueries({ queryKey: keys.agents.provision.all });
        void queryClient.invalidateQueries({ queryKey: keys.agents.enrollment.all });
        toast.push({
          kind: "ok",
          title: t("agents.provision.queued", { host: payload.host }),
        });
        callbacks?.onCreated?.(created);
      } catch (error) {
        // 401 escalates to the token gate (drop token → dialog → retry).
        if (isApiError(error) && error.status === 401) throw error;
        toast.push({
          kind: "error",
          title: t("agents.provision.submitFailed"),
          detail: error instanceof Error ? error.message : undefined,
        });
      } finally {
        callbacks?.onSettled?.();
      }
    });
  };

  return { submitProvision };
}

export type ProvisionActions = ReturnType<typeof createProvisionActions>;

/** React wiring: contexts → factory (stable identity across renders). */
export function useProvisionActions(): ProvisionActions {
  const gateway = useGateway();
  const queryClient = useQueryClient();
  const uiToken = useUiToken();
  const toast = useToast();
  const t = useT();
  return useMemo(
    () =>
      createProvisionActions({
        runAuthorized: uiToken.runAuthorized,
        toast,
        t,
        gateway,
        queryClient,
      }),
    [gateway, queryClient, t, toast, uiToken],
  );
}
