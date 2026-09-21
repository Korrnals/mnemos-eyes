import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { MockAdapter } from "@/gateway/MockAdapter";
import { ApiError } from "@/lib/errors";
import { keys } from "@/lib/queryKeys";
import { translate } from "@/i18n";
import type { ToastInput } from "@/components/Toast/toastContext";
import { UiTokenGate } from "@/features/ui-token/uiTokenGate";
import { setUiToken, clearUiToken } from "@/gateway/uiToken";
import { createAutomationMutations } from "./useAutomation";

/**
 * Automation mutation flows (useTaskMutations posture): the factory runs
 * through the real mock wire, the ui-token gate is the REAL UiTokenGate in
 * the token tests. `runScheduleNow` REUSES the assignment machinery — the
 * mock route creates the assignment through the SAME createAssignmentRow
 * path as POST /api/assignments; the factory only invalidates the shared
 * queue key, it never builds a second assignment state machine.
 */

const FIXED_NOW = Date.parse("2026-09-19T09:00:00Z");

interface Harness {
  gateway: MockAdapter;
  queryClient: QueryClient;
  toasts: ToastInput[];
  mutations: ReturnType<typeof createAutomationMutations>;
  confirm: ReturnType<typeof vi.fn>;
}

async function makeHarness(): Promise<Harness> {
  const gateway = new MockAdapter({ latency: false, now: () => FIXED_NOW });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await queryClient.prefetchQuery({
    queryKey: keys.automation.schedules(),
    queryFn: () => gateway.listSchedules(),
  });
  // Seed the shared assignment queue key — run-now invalidates it; the
  // assertion needs the entry to exist in the cache.
  await queryClient.prefetchQuery({
    queryKey: ["agents", "assignments"],
    queryFn: () => gateway.listAssignments(),
  } as never);
  const toasts: ToastInput[] = [];
  const confirm = vi.fn(() => true);
  const mutations = createAutomationMutations({
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

describe("runScheduleNow — reuse, not a second machine", () => {
  it("goes through the gateway wire call and lands the launched toast + queue invalidation", async () => {
    const h = await makeHarness();
    await h.gateway.cancelAssignment(101, "test setup"); // free TB-1 for rule 1
    const launched = vi.fn();
    const schedule = (await h.gateway.listSchedules()).items[0];
    // Instance-level spy: the factory must go through the ADAPTER wire
    // method (one call), never reimplement the launch itself.
    const instanceSpy = vi.spyOn(h.gateway, "runScheduleNow");
    h.mutations.runScheduleNow(schedule, { onLaunched: launched });
    await vi.waitFor(() => expect(launched).toHaveBeenCalledTimes(1));
    expect(instanceSpy).toHaveBeenCalledTimes(1);
    expect(instanceSpy).toHaveBeenCalledWith(schedule.id);
    expect(h.toasts[0]).toMatchObject({
      kind: "ok",
      title: expect.stringContaining("launched"),
    });
    // The shared queue key is invalidated — the run-now outcome lands on
    // the EXISTING assignment surfaces (list/cards/task tab).
    const queueKey = h.queryClient
      .getQueryCache()
      .getAll()
      .find(
        (query) =>
          JSON.stringify(query.queryKey) === JSON.stringify(["agents", "assignments"]),
      );
    expect(queueKey?.state.isInvalidated).toBe(true);
  });

  it("a 409 (active assignment holds the task) surfaces the SERVER text verbatim", async () => {
    const h = await makeHarness();
    const schedule = (await h.gateway.listSchedules()).items[0]; // TB-1 held by row 101
    h.mutations.runScheduleNow(schedule);
    await vi.waitFor(() => expect(h.toasts).toHaveLength(1));
    expect(h.toasts[0].kind).toBe("error");
    expect(h.toasts[0].detail).toContain("active assignment");
    // The refused attempt still journaled a skipped row (wire honesty).
    const journal = await h.gateway.listLaunches({ decision: "skipped" });
    expect(journal.items.length).toBeGreaterThan(0);
  });
});

describe("rule CRUD through the gate", () => {
  it("delete: declined confirm → nothing; accepted → soft-delete + retained toast", async () => {
    const h = await makeHarness();
    const rule = (await h.gateway.listSchedules()).items[0];
    h.confirm.mockReturnValue(false);
    h.mutations.deleteSchedule(rule);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.toasts).toHaveLength(0);

    h.confirm.mockReturnValue(true);
    h.mutations.deleteSchedule(rule);
    await vi.waitFor(() => expect(h.toasts).toHaveLength(1));
    expect(h.toasts[0]).toMatchObject({ kind: "ok" });
    expect(h.toasts[0].detail).toContain("retained");
    const after = (await h.gateway.listSchedules()).items.find((row) => row.id === rule.id);
    expect(after?.enabled).toBe(false); // retention, not destruction
  });

  it("create lands the created-disabled toast and a real rule", async () => {
    const h = await makeHarness();
    const done = vi.fn();
    h.mutations.createSchedule(
      {
        name: "тест-правило",
        target_kind: "task",
        task_id: "TB-10",
        specialist: "@GCW: Tech Lead",
        harness: "zcode",
        executor_id: "",
        trigger_kind: "daily",
        trigger_value: "10:00",
        window_from: null,
        window_to: null,
        max_runs_per_day: 1,
        cooldown_s: 3600,
      },
      { onDone: done },
    );
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(h.toasts[0].title).toContain("created");
    const created = (await h.gateway.listSchedules()).items.find((r) => r.name === "тест-правило");
    expect(created?.enabled).toBe(false); // creation is disabled (S1)
  });
});

describe("ui-token gate", () => {
  it("no token → the run queues behind the login window, no wire call", async () => {
    const gateway = new MockAdapter({ latency: false, now: () => FIXED_NOW });
    const gate = new UiTokenGate({ hasToken: () => false });
    const opened: string[] = [];
    gate.subscribe((state) => {
      if (state.open) opened.push(state.reason);
    });
    const queryClient = new QueryClient();
    const toasts: ToastInput[] = [];
    const mutations = createAutomationMutations({
      runAuthorized: (run) => void gate.runAuthorized(run),
      toast: { push: (input) => toasts.push(input) },
      t: (key, vars) => translate("en", key, vars),
      gateway,
      queryClient,
      confirm: () => true,
    });
    const schedule = (await gateway.listSchedules()).items[0];
    await gateway.cancelAssignment(101, "setup");
    mutations.runScheduleNow(schedule);
    await vi.waitFor(() => expect(opened).toContain("required"));
    expect(toasts).toHaveLength(0);
  });

  it("stored token → the same run goes straight through", async () => {
    setUiToken("ui-token");
    const gateway = new MockAdapter({ latency: false, now: () => FIXED_NOW });
    const gate = new UiTokenGate({ hasToken: () => true });
    const queryClient = new QueryClient();
    const toasts: ToastInput[] = [];
    const mutations = createAutomationMutations({
      runAuthorized: (run) => void gate.runAuthorized(run),
      toast: { push: (input) => toasts.push(input) },
      t: (key, vars) => translate("en", key, vars),
      gateway,
      queryClient,
      confirm: () => true,
    });
    await gateway.cancelAssignment(101, "setup");
    const schedule = (await gateway.listSchedules()).items[0];
    mutations.runScheduleNow(schedule);
    await vi.waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0].kind).toBe("ok");
    clearUiToken();
  });

  it("401 rethrows so the gate can take over mid-flight", async () => {
    const gateway = new MockAdapter({ latency: false, now: () => FIXED_NOW });
    const refusing = {
      runScheduleNow: () => Promise.reject(new ApiError(401, "unauthorized", { url: "m" })),
    };
    const gated = Object.assign(gateway, refusing);
    const gate = new UiTokenGate({ hasToken: () => true });
    const rejected: string[] = [];
    gate.subscribe((state) => {
      if (state.open) rejected.push(state.reason);
    });
    const mutations = createAutomationMutations({
      runAuthorized: (run) => void gate.runAuthorized(run),
      toast: { push: (input) => void input },
      t: (key, vars) => translate("en", key, vars),
      gateway: gated,
      queryClient: new QueryClient(),
      confirm: () => true,
    });
    mutations.runScheduleNow((await gateway.listSchedules()).items[0]);
    await vi.waitFor(() => expect(rejected).toContain("rejected"));
  });
});
