import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { MockAdapter } from "@/gateway/MockAdapter";
import { ApiError } from "@/lib/errors";
import { keys } from "@/lib/queryKeys";
import { translate } from "@/i18n";
import type { ToastInput } from "@/components/Toast/toastContext";
import { UiTokenGate } from "@/features/ui-token/uiTokenGate";
import { setUiToken, clearUiToken } from "@/gateway/uiToken";
import type { AssignmentItem, BoardTask } from "@/gateway/boardTypes";
import { createAssignmentMutations } from "./useAssignmentMutations";

/**
 * AGW-2 assignment mutation flows (useTaskMutations.test.ts posture: real
 * QueryClient + mock adapter + recording toast): create success (sheet
 * closes on the 201), cancel confirm-declined / confirm-accepted (stop-signal
 * honesty), API error text lands in the toast verbatim (409/429/403), and
 * the ui-token gate defers a token-less run into the LoginDialog queue.
 */

const FIXED_NOW = Date.parse("2026-09-19T09:00:00Z");

const TASK: BoardTask = {
  id: "TB-10",
  col: "open",
  position: 0,
  title: "T",
  summary: "",
  spec: "",
  agents: [],
  specialists: [],
  env: "unknown",
  project: "",
  memory_ids: [],
  mnemos_tags: [],
  created_at: "2026-09-18T00:00:00+00:00",
  updated_at: "2026-09-18T00:00:00+00:00",
  archived: 0,
  status: "open",
  priority: "normal",
  archived_from: "",
  validating_since: "",
};

const RUNNING: AssignmentItem = {
  id: 106,
  task_id: "TB-11",
  specialist: "x",
  harness: "zcode",
  state: "running",
  created_by: "owner",
  claimed_by: "zcode:laptop",
  note: "",
  spec_hash: "",
  executor_id: "",
  claimed_by_executor: "exec-laptop-zcode",
  created_at: "2026-09-19T08:10:00+00:00",
  claimed_at: "2026-09-19T08:35:00+00:00",
  started_at: "2026-09-19T08:40:00+00:00",
  heartbeat_at: "2026-09-19T08:58:30+00:00",
  finished_at: null,
  topics: [],
  routing: null,
};

interface Harness {
  gateway: MockAdapter;
  queryClient: QueryClient;
  toasts: ToastInput[];
  mutations: ReturnType<typeof createAssignmentMutations>;
  confirm: ReturnType<typeof vi.fn>;
}

async function makeHarness(): Promise<Harness> {
  const gateway = new MockAdapter({ latency: false, now: () => FIXED_NOW });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await queryClient.prefetchQuery({
    queryKey: keys.agents.assignments.list({}),
    queryFn: () => gateway.listAssignments(),
  });
  const toasts: ToastInput[] = [];
  const confirm = vi.fn(() => true);
  const mutations = createAssignmentMutations({
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

beforeEach(() => {
  clearUiToken();
});

describe("createAssignment (the sheet's submit path)", () => {
  it("queues the attempt, toasts the matrix-A copy and reports settle", async () => {
    const h = await makeHarness();
    const queued = vi.fn();
    const settled = vi.fn();
    h.mutations.createAssignment(
      TASK,
      { task_id: TASK.id, specialist: "@GCW: Tech Lead", harness: "zcode" },
      { onQueued: queued, onSettled: settled },
    );
    await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(1));
    expect(settled).toHaveBeenCalledTimes(1);
    expect(h.toasts[0]).toMatchObject({
      kind: "ok",
      title: "TB-10: assigned",
      detail: "assignment queued, waiting for the poller",
    });
    const queue = await h.gateway.listAssignments({ task_id: "TB-10" });
    expect(queue.items[0].state).toBe("queued");
  });

  it("surfaces the SERVER's 409 text verbatim in the error toast", async () => {
    const h = await makeHarness();
    // Corpus row 101 already holds TB-1 → the mock answers 409.
    h.mutations.createAssignment(
      { ...TASK, id: "TB-1" },
      { task_id: "TB-1", specialist: "x", harness: "zcode" },
    );
    await vi.waitFor(() => expect(h.toasts).toHaveLength(1));
    expect(h.toasts[0].kind).toBe("error");
    expect(h.toasts[0].title).toBe("Failed to assign");
    expect(h.toasts[0].detail).toContain("active assignment");
  });
});

describe("cancelAssignment (stop-signal honesty)", () => {
  it("declined confirm → nothing happens, no toast, no wire call", async () => {
    const h = await makeHarness();
    h.confirm.mockReturnValue(false);
    h.mutations.cancelAssignment(RUNNING);
    expect(h.confirm).toHaveBeenCalledWith(
      "A stop signal will be sent to the executor. Cancel the assignment?",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.toasts).toHaveLength(0);
    const row = (await h.gateway.listAssignments({ task_id: "TB-11" })).items.find(
      (a) => a.id === RUNNING.id,
    );
    expect(row?.state).toBe("running");
  });

  it("accepted confirm → cancelled, «cancellation sent» toast (async honesty)", async () => {
    const h = await makeHarness();
    const cancelled = vi.fn();
    h.mutations.cancelAssignment(RUNNING, { onCancelled: cancelled });
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
    expect(h.toasts[0]).toMatchObject({
      kind: "ok",
      title: "TB-11: cancellation sent",
      detail: "the executor will receive the stop signal",
    });
    const row = (await h.gateway.listAssignments({ task_id: "TB-11" })).items.find(
      (a) => a.id === RUNNING.id,
    );
    expect(row?.state).toBe("cancelled");
  });

  it("a 409 on a terminal row lands in the toast with the server text", async () => {
    const h = await makeHarness();
    h.mutations.cancelAssignment({ ...RUNNING, id: 107, state: "done" });
    await vi.waitFor(() => expect(h.toasts).toHaveLength(1));
    expect(h.toasts[0].kind).toBe("error");
    expect(h.toasts[0].detail).toContain("only queued/claimed/running");
  });
});

describe("ui-token gate (401 / no token)", () => {
  it("rethrows 401 so the gate can open the login window with the run queued", async () => {
    const gateway = new MockAdapter({ latency: false, now: () => FIXED_NOW });
    const refusing = {
      createAssignment: () =>
        Promise.reject(new ApiError(401, "unauthorized", { url: "mock" })),
    };
    const gated = Object.assign(gateway, refusing);
    const gate = new UiTokenGate({ hasToken: () => false });
    const opened: string[] = [];
    gate.subscribe((state) => {
      if (state.open) opened.push(state.reason);
    });
    const queryClient = new QueryClient();
    const toasts: ToastInput[] = [];
    const mutations = createAssignmentMutations({
      runAuthorized: (run) => void gate.runAuthorized(run),
      toast: { push: (input) => toasts.push(input) },
      t: (key, vars) => translate("en", key, vars),
      gateway: gated,
      queryClient,
      confirm: () => true,
    });

    mutations.createAssignment(TASK, {
      task_id: TASK.id,
      specialist: "x",
      harness: "zcode",
    });

    // No token: the gate queued the run and opened the window (reason
    // "required") BEFORE any wire call; the run stays pending.
    await vi.waitFor(() => expect(opened).toContain("required"));
    expect(toasts).toHaveLength(0);
  });

  it("a stored token lets the same run straight through the real gate", async () => {
    setUiToken("ui-token");
    const gateway = new MockAdapter({ latency: false, now: () => FIXED_NOW });
    const gate = new UiTokenGate({ hasToken: () => true });
    const opened: string[] = [];
    gate.subscribe((state) => {
      if (state.open) opened.push(state.reason);
    });
    const queryClient = new QueryClient();
    const toasts: ToastInput[] = [];
    const queued = vi.fn();
    const mutations = createAssignmentMutations({
      runAuthorized: (run) => void gate.runAuthorized(run),
      toast: { push: (input) => toasts.push(input) },
      t: (key, vars) => translate("en", key, vars),
      gateway,
      queryClient,
      confirm: () => true,
    });
    mutations.createAssignment(
      TASK,
      { task_id: TASK.id, specialist: "@GCW: Tech Lead", harness: "zcode" },
      { onQueued: queued },
    );
    await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(1));
    expect(opened).toHaveLength(0); // the window never came up
    expect(toasts[0]?.kind).toBe("ok");
    clearUiToken();
  });
});
