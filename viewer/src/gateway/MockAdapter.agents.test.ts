import { describe, expect, it } from "vitest";
import { MockAdapter } from "./MockAdapter";
import { MOCK_EXECUTORS_META } from "./boardFixtures";

/**
 * AGW-1 agents-domain behaviour of the MockAdapter: filters with server
 * parity (executor_id is NOT a list filter), honest create/cancel gates
 * (404/422/409), the settings gates, and the SCHED-1 automation semantics
 * (unique names, soft-delete retention, manual-only journal, cursor).
 */

/** Deterministic adapter: no latency, frozen clock at the corpus point. */
function adapter(): MockAdapter {
  return new MockAdapter({
    latency: false,
    now: () => Date.parse("2026-09-19T09:00:00+00:00"),
  });
}

async function rejectsApiError(
  attempt: Promise<unknown>,
  status: number,
): Promise<void> {
  await expect(attempt).rejects.toMatchObject({ status });
}

describe("MockAdapter agents — assignment queue", () => {
  it("serves the fixture corpus with all 7 lifecycle states", async () => {
    const page = await adapter().listAssignments();
    const states = new Set(page.items.map((row) => row.state));
    expect(states).toEqual(
      new Set([
        "queued",
        "claimed",
        "running",
        "done",
        "failed",
        "cancelled",
        "expired",
      ]),
    );
    // Routing annotations ride along — different outcomes covered.
    const reasons = new Set(page.items.map((row) => row.routing?.reason));
    expect(reasons).toEqual(
      new Set(["specialist", "explicit", "unmatched", "global-default", "auto"]),
    );
  });

  it("filters by state and task_id; executor_id does NOT filter (wire parity)", async () => {
    const mock = adapter();
    const queued = await mock.listAssignments({ state: "queued" });
    expect(queued.items.every((row) => row.state === "queued")).toBe(true);

    const byTask = await mock.listAssignments({ task_id: "TB-1" });
    expect(byTask.items.every((row) => row.task_id === "TB-1")).toBe(true);

    const piggyback = await mock.listAssignments({ executor_id: "exec-mesh-qa" });
    expect(piggyback.count).toBe((await mock.listAssignments()).count);
  });

  it("createAssignment queues with a computed routing annotation", async () => {
    const mock = adapter();
    const created = await mock.createAssignment({
      task_id: "TB-10",
      specialist: "@GCW: Tech Lead",
      harness: "zcode",
    });
    expect(created.assignment.state).toBe("queued");
    expect(created.assignment.created_by).toBe("owner");
    // exec-laptop-zcode carries the Tech Lead capability and is online.
    expect(created.assignment.routing).toEqual({
      resolved: "exec-laptop-zcode",
      reason: "specialist",
    });
  });

  it("createAssignment honours an explicit pin with reason explicit", async () => {
    const created = await adapter().createAssignment({
      task_id: "TB-10",
      specialist: "whoever",
      harness: "zcode",
      executor_id: "exec-mesh-qa",
    });
    expect(created.assignment.routing).toEqual({
      resolved: "exec-mesh-qa",
      reason: "explicit",
    });
  });

  it("createAssignment answers honestly: 404 unknown, 422 terminal, 409 active", async () => {
    const mock = adapter();
    await rejectsApiError(
      mock.createAssignment({ task_id: "NOPE", specialist: "x", harness: "zcode" }),
      404,
    );
    await rejectsApiError(
      mock.createAssignment({ task_id: "TB-8", specialist: "x", harness: "zcode" }),
      422,
    );
    // TB-1 already holds a queued assignment in the corpus (≤1 invariant).
    await rejectsApiError(
      mock.createAssignment({
        task_id: "TB-1",
        specialist: "x",
        harness: "zcode",
      }),
      409,
    );
  });

  it("cancelAssignment flips an active row and frees an in-progress task column", async () => {
    const mock = adapter();
    // 106 runs on TB-11 (in-progress) — cancelling must report the return.
    const result = await mock.cancelAssignment(106, "остановлено владельцем");
    expect(result.assignment.state).toBe("cancelled");
    expect(result.assignment.note).toBe("остановлено владельцем");
    expect(result.moved).toEqual(["in-progress", "open"]);
    expect(result.task?.col).toBe("open");

    const queue = await mock.listAssignments({ task_id: "TB-11" });
    expect(queue.items.find((row) => row.id === 106)?.state).toBe("cancelled");
  });

  it("cancelAssignment: terminal rows 409, unknown ids 404", async () => {
    const mock = adapter();
    await rejectsApiError(mock.cancelAssignment(107), 409); // done
    await rejectsApiError(mock.cancelAssignment(9999), 404);
  });
});

describe("MockAdapter agents — executor registry + settings", () => {
  it("lists the corpus with the presence TTL meta (server-owned constants)", async () => {
    const page = await adapter().listExecutors();
    expect(page.count).toBe(page.items.length);
    expect(page.meta).toEqual(MOCK_EXECUTORS_META);
    const presences = new Set(page.items.map((row) => row.presence));
    expect(presences).toEqual(new Set(["online", "stale", "offline"]));
    const transports = new Set(page.items.map((row) => row.transport));
    expect(transports).toEqual(new Set(["local-poll", "mesh-r4"]));
  });

  it("reads and writes the execution settings with Amd 2 §5 gates", async () => {
    const mock = adapter();
    const before = await mock.getExecutionSettings();
    expect(before.default_executor).toBe("exec-laptop-zcode");

    const after = await mock.putExecutionSettings({
      default_executor: "exec-laptop-hermes",
      fallback_executor: "exec-mesh-qa",
    });
    expect((await mock.getExecutionSettings()).default_executor).toBe(
      "exec-laptop-hermes",
    );
    expect(after.scope).toBe("");

    await rejectsApiError(
      mock.putExecutionSettings({ default_executor: "exec-unknown", fallback_executor: "" }),
      422,
    );
    // Revoked executors never route (kill-switch).
    await rejectsApiError(
      mock.putExecutionSettings({
        default_executor: "exec-copilot-revoked",
        fallback_executor: "",
      }),
      422,
    );
  });
});

describe("MockAdapter agents — SCHED-1 automation", () => {
  it("status reports the honest S1 engine=false with live rule counts", async () => {
    const status = await adapter().automationStatus();
    expect(status.engine).toBe(false);
    expect(status.rules.schedules).toEqual({ total: 2, enabled: 1 });
    expect(status.rules.hooks).toEqual({ total: 2, enabled: 1 });
  });

  it("schedule CRUD: unique names 422, patch 404, delete soft-disables", async () => {
    const mock = adapter();
    const created = await mock.createSchedule({
      name: "новое правило",
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
    });
    expect(created.enabled).toBe(false); // creation is disabled (S1 contract)

    await rejectsApiError(
      mock.createSchedule({
        name: "новое правило",
        target_kind: "task",
        task_id: "TB-10",
        specialist: "x",
        harness: "zcode",
        executor_id: "",
        trigger_kind: "daily",
        trigger_value: "10:00",
        window_from: null,
        window_to: null,
        max_runs_per_day: 1,
        cooldown_s: 3600,
      }),
      422,
    );

    const patched = await mock.patchSchedule(created.id, { enabled: true });
    expect(patched.enabled).toBe(true);
    expect(patched.next_run_at).not.toBeNull(); // recomputed from now

    await rejectsApiError(mock.patchSchedule(9999, { enabled: true }), 404);

    const removed = await mock.deleteSchedule(created.id);
    expect(removed.ok).toBe(true);
    // Retention: the row stays listed, disabled.
    const schedules = await mock.listSchedules();
    const retained = schedules.items.find((rule) => rule.id === created.id);
    expect(retained?.enabled).toBe(false);
  });

  it("runScheduleNow: launches through the create gates, journals skipped on 409", async () => {
    const mock = adapter();
    // Rule 2 targets TB-5 (corpus row 103 is queued there → 409 + skipped row).
    await rejectsApiError(mock.runScheduleNow(2), 409);
    const skipped = await mock.listLaunches({ rule_id: 2, decision: "skipped" });
    expect(skipped.items).toHaveLength(1);
    expect(skipped.items[0].trigger).toBe("manual");

    // A fresh rule on a free task launches and returns the assignment id.
    const created = await mock.createSchedule({
      name: "ран-now",
      target_kind: "task",
      task_id: "TB-4",
      specialist: "@GCW: Tech Lead",
      harness: "zcode",
      executor_id: "",
      trigger_kind: "daily",
      trigger_value: "11:00",
      window_from: null,
      window_to: null,
      max_runs_per_day: 1,
      cooldown_s: 3600,
    });
    const run = await mock.runScheduleNow(created.id);
    expect(run.decision).toBe("launched");
    expect(run.assignment_id).not.toBeNull();
    const queue = await mock.listAssignments({ task_id: "TB-4" });
    expect(queue.items.some((row) => row.id === run.assignment_id)).toBe(true);
  });

  it("launch journal: filters, DESC order and the opaque cursor contract", async () => {
    const mock = adapter();
    const page = await mock.listLaunches({ limit: 1 });
    expect(page.total).toBeGreaterThanOrEqual(2);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].id).toBe(2); // attempted_at DESC (09:05 over 09:00)
    expect(page.next_cursor).not.toBeNull();

    const next = await mock.listLaunches({ limit: 1, cursor: page.next_cursor! });
    expect(next.items[0].id).toBe(1);
    expect(next.next_cursor).toBeNull(); // page 2 of 2

    await rejectsApiError(mock.listLaunches({ cursor: "garbage!" }), 422);
    await rejectsApiError(mock.listLaunches({ kind: "bogus" }), 422);
  });

  it("hook CRUD mirrors the schedule semantics", async () => {
    const mock = adapter();
    const created = await mock.createHook({
      name: "новый хук",
      on: "assignment.expired",
      condition: [],
      source_allowlist: ["ui"],
      action: "notify",
      action_payload: {},
      cooldown_s: 300,
      budget: 4,
    });
    expect(created.enabled).toBe(false);
    const patched = await mock.patchHook(created.id, { enabled: true, budget: 9 });
    expect(patched.enabled).toBe(true);
    expect(patched.budget).toBe(9);
    await rejectsApiError(mock.patchHook(9999, { enabled: true }), 404);
    const removed = await mock.deleteHook(created.id);
    expect(removed.ok).toBe(true);
    const hooks = await mock.listHooks();
    expect(hooks.items.find((rule) => rule.id === created.id)?.enabled).toBe(false);
  });
});
