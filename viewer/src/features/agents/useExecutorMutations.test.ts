import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { MockAdapter } from "@/gateway/MockAdapter";
import { ApiError } from "@/lib/errors";
import { keys } from "@/lib/queryKeys";
import { translate } from "@/i18n";
import type { ToastInput } from "@/components/Toast/toastContext";
import { UiTokenGate } from "@/features/ui-token/uiTokenGate";
import { setUiToken, clearUiToken } from "@/gateway/uiToken";
import type { ExecutorItem } from "@/gateway/boardTypes";
import { createExecutorMutations } from "./useExecutorMutations";

/**
 * AGW-4 executor-registry mutation flows (useAssignmentMutations.test.ts
 * posture: real QueryClient + mock adapter + recording toast + injected
 * confirm). Covered: the approve wire body ({state:"approved"} — approve
 * deliberately does NOT flip the routing flag), enable/disable, the revoke
 * confirm-gate with the not-restorable honesty and the terminal 409 when
 * the row is already revoked, the hard-delete confirm naming the freed
 * identity, the server's error text landing in toasts verbatim, and the
 * 401 path rethrowing into the ui-token gate (no toast — the gate owns it).
 */

const FIXED_NOW = Date.parse("2026-09-19T09:00:00Z");

const PENDING: ExecutorItem = {
  id: "exec-copilot-pending",
  name: "copilot@new-host",
  harness: "copilot",
  host: "new-host",
  transport: "mesh-r4",
  capabilities: [],
  version: "0.9.0",
  enabled: false,
  state: "pending",
  last_seen: "2026-09-19T08:59:00+00:00",
  presence: "online",
  registered_via: "",
  registered_at: "2026-09-19T08:40:00+00:00",
  updated_at: "2026-09-19T08:40:00+00:00",
};

/** A REAL approved+enabled fixture row (the mock registry holds it). */
const APPROVED: ExecutorItem = {
  ...PENDING,
  id: "exec-laptop-zcode",
  name: "zcode@laptop",
  harness: "zcode",
  host: "laptop",
  transport: "local-poll",
  state: "approved",
  enabled: true,
};

interface Harness {
  gateway: MockAdapter;
  queryClient: QueryClient;
  toasts: ToastInput[];
  mutations: ReturnType<typeof createExecutorMutations>;
  confirm: ReturnType<typeof vi.fn>;
}

async function makeHarness(): Promise<Harness> {
  const gateway = new MockAdapter({ latency: false, now: () => FIXED_NOW });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await queryClient.prefetchQuery({
    queryKey: keys.agents.executors.list(),
    queryFn: () => gateway.listExecutors(),
  });
  const toasts: ToastInput[] = [];
  const confirm = vi.fn(() => true);
  const mutations = createExecutorMutations({
    runAuthorized: (run) => {
      void run();
    },
    toast: { push: (input) => toasts.push(input) },
    t: (key, vars) => translate("en", key, vars),
    gateway,
    queryClient,
    confirm,
  });
  return { gateway, queryClient, toasts, mutations, confirm };
}

const registryRow = async (h: Harness, id: string): Promise<ExecutorItem | undefined> =>
  (await h.gateway.listExecutors()).items.find((row) => row.id === id);

beforeEach(() => {
  clearUiToken();
});

describe("approveExecutor (the page's main action)", () => {
  it("sends {state:'approved'} only — the routing flag stays untouched", async () => {
    const h = await makeHarness();
    const spy = vi.spyOn(h.gateway, "patchExecutor");
    h.mutations.approveExecutor(PENDING);
    await vi.waitFor(() => expect(h.toasts).toHaveLength(1));
    expect(spy).toHaveBeenCalledWith(PENDING.id, { state: "approved" });
    expect(h.toasts[0]).toMatchObject({
      kind: "ok",
      title: "copilot@new-host: approved",
      detail: "enable the executor — routing picks only enabled ones",
    });
    const row = await registryRow(h, PENDING.id);
    expect(row?.state).toBe("approved");
    expect(row?.enabled).toBe(false); // honest: approve ≠ enable
  });

  it("the SERVER's 409 text lands verbatim when the row is revoked", async () => {
    const h = await makeHarness();
    h.mutations.approveExecutor({ ...PENDING, id: "exec-copilot-revoked", name: "copilot@old-host", state: "revoked" });
    await vi.waitFor(() => expect(h.toasts).toHaveLength(1));
    expect(h.toasts[0].kind).toBe("error");
    expect(h.toasts[0].title).toBe("Failed to update the executor");
    expect(h.toasts[0].detail).toContain("terminal state");
  });
});

describe("setExecutorEnabled (routing kill-switch)", () => {
  it("disable sends {enabled:false}; enable sends {enabled:true}", async () => {
    const h = await makeHarness();
    h.mutations.setExecutorEnabled(APPROVED, false);
    await vi.waitFor(() => expect(h.toasts[0]?.title).toBe("zcode@laptop: disabled"));
    expect((await registryRow(h, APPROVED.id))?.enabled).toBe(false);
    h.mutations.setExecutorEnabled(APPROVED, true);
    await vi.waitFor(() => expect(h.toasts[1]?.title).toBe("zcode@laptop: enabled"));
    expect((await registryRow(h, APPROVED.id))?.enabled).toBe(true);
  });
});

describe("revokeExecutor (TERMINAL kill-switch)", () => {
  it("declined confirm → no wire call, no toast", async () => {
    const h = await makeHarness();
    h.confirm.mockReturnValue(false);
    h.mutations.revokeExecutor(APPROVED);
    expect(h.confirm).toHaveBeenCalledWith(
      expect.stringContaining("Trust is not restorable"),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.toasts).toHaveLength(0);
    expect((await registryRow(h, APPROVED.id))?.state).toBe("approved");
  });

  it("accepted confirm → {state:'revoked'}, the row is dead", async () => {
    const h = await makeHarness();
    h.mutations.revokeExecutor(APPROVED);
    await vi.waitFor(() => expect(h.toasts).toHaveLength(1));
    expect(h.toasts[0]).toMatchObject({
      kind: "ok",
      title: "zcode@laptop: revoked",
      detail: "terminal state — re-registration only",
    });
    expect((await registryRow(h, APPROVED.id))?.state).toBe("revoked");
  });
});

describe("removeExecutor (hard registry delete)", () => {
  it("confirm names the honesty: secret dies, name freed, pins stay", async () => {
    const h = await makeHarness();
    h.mutations.removeExecutor(APPROVED);
    await vi.waitFor(() => expect(h.toasts).toHaveLength(1));
    expect(h.confirm).toHaveBeenCalledWith(
      expect.stringContaining("name is freed for re-registration"),
    );
    expect(h.toasts[0].title).toBe("zcode@laptop: deleted");
    expect(await registryRow(h, APPROVED.id)).toBeUndefined();
  });

  it("the SERVER's 404 text lands verbatim for an unknown id", async () => {
    const h = await makeHarness();
    h.mutations.removeExecutor({ ...APPROVED, id: "exec-ghost" });
    await vi.waitFor(() => expect(h.toasts).toHaveLength(1));
    expect(h.toasts[0].kind).toBe("error");
    expect(h.toasts[0].detail).toContain("exec-ghost not found");
  });
});

describe("ui-token gate (401 / no token)", () => {
  it("rethrows 401 into the gate — the login window opens, no toast fires", async () => {
    const gateway = new MockAdapter({ latency: false, now: () => FIXED_NOW });
    const refusing = {
      patchExecutor: () =>
        Promise.reject(new ApiError(401, "unauthorized", { url: "mock" })),
    };
    const gated = Object.assign(gateway, refusing);
    const gate = new UiTokenGate({ hasToken: () => false });
    const opened: string[] = [];
    gate.subscribe((state) => {
      if (state.open) opened.push(state.reason);
    });
    const toasts: ToastInput[] = [];
    const mutations = createExecutorMutations({
      runAuthorized: (run) => void gate.runAuthorized(run),
      toast: { push: (input) => toasts.push(input) },
      t: (key, vars) => translate("en", key, vars),
      gateway: gated,
      queryClient: new QueryClient(),
      confirm: () => true,
    });

    mutations.approveExecutor(PENDING);

    await vi.waitFor(() => expect(opened).toContain("required"));
    expect(toasts).toHaveLength(0);
  });

  it("a stored token lets the same approve straight through the real gate", async () => {
    setUiToken("ui-token");
    const gateway = new MockAdapter({ latency: false, now: () => FIXED_NOW });
    const gate = new UiTokenGate({ hasToken: () => true });
    const opened: string[] = [];
    gate.subscribe((state) => {
      if (state.open) opened.push(state.reason);
    });
    const toasts: ToastInput[] = [];
    const mutations = createExecutorMutations({
      runAuthorized: (run) => void gate.runAuthorized(run),
      toast: { push: (input) => toasts.push(input) },
      t: (key, vars) => translate("en", key, vars),
      gateway,
      queryClient: new QueryClient(),
      confirm: () => true,
    });
    mutations.approveExecutor(PENDING);
    await vi.waitFor(() => expect(toasts[0]?.kind).toBe("ok"));
    expect(opened).toHaveLength(0);
    clearUiToken();
  });
});
