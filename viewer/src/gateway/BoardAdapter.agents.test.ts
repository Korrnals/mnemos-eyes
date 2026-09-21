import { describe, expect, it, vi } from "vitest";
import { BoardAdapter } from "./BoardAdapter";
import { ApiError } from "@/lib/errors";

/**
 * AGW-1 agents-domain wire contract of the BoardAdapter (board-openapi):
 * paths, methods, query params and bodies; `Authorization: Bearer` attached
 * ONLY on mutating calls; error statuses surface as ApiError with the
 * server's message. The projection NEVER carries claim_token/spec_snapshot
 * — only the spec_hash fingerprint.
 */

/** Recording fetch stub — resolves JSON, captures method/url/headers/body. */
function recordingFetch(status: number, body: unknown) {
  const calls: {
    method: string;
    url: string;
    authorization: string | undefined;
    body: unknown;
  }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      authorization: headers.Authorization,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { fetchImpl, calls };
}

const ASSIGNMENT_ROW = {
  id: 101,
  task_id: "TB-1",
  specialist: "@GCW: Senior Frontend Developer",
  harness: "zcode",
  state: "queued",
  created_by: "owner",
  claimed_by: null,
  note: "",
  spec_hash: "b6f4a1c2d3e4",
  executor_id: "",
  claimed_by_executor: "",
  created_at: "2026-09-19T08:30:00+00:00",
  claimed_at: null,
  started_at: null,
  heartbeat_at: null,
  finished_at: null,
  topics: ["project:mnemos-eyes"],
  routing: { resolved: "exec-laptop-zcode", reason: "specialist" },
};

describe("BoardAdapter agents wire — assignments", () => {
  it("listAssignments: GET /assignments with state/task_id/executor_id", async () => {
    const { fetchImpl, calls } = recordingFetch(200, {
      ok: true,
      count: 1,
      items: [ASSIGNMENT_ROW],
    });
    const adapter = new BoardAdapter({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const page = await adapter.listAssignments({
      state: "queued",
      task_id: "TB-1",
      executor_id: "exec-laptop-zcode",
    });

    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(
      "/api/assignments?state=queued&task_id=TB-1&executor_id=exec-laptop-zcode",
    );
    expect(calls[0].authorization).toBeUndefined(); // open read, no bearer
    expect(page.count).toBe(1);
    expect(page.items[0].routing).toEqual({
      resolved: "exec-laptop-zcode",
      reason: "specialist",
    });
  });

  it("listAssignments: empty params produce a bare GET (no dangling ?)", async () => {
    const { fetchImpl, calls } = recordingFetch(200, { ok: true, count: 0, items: [] });
    const adapter = new BoardAdapter({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await adapter.listAssignments();
    expect(calls[0].url).toBe("/api/assignments");
  });

  it("listAssignments: 422 garbage state surfaces as ApiError", async () => {
    const { fetchImpl } = recordingFetch(422, { detail: "invalid state: bogus" });
    const adapter = new BoardAdapter({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      adapter.listAssignments({ state: "bogus" as never }),
    ).rejects.toMatchObject({ status: 422, message: "invalid state: bogus" });
  });

  it("createAssignment: POST /assignments, ui bearer, pin travels as ''", async () => {
    const { fetchImpl, calls } = recordingFetch(201, {
      ok: true,
      assignment: ASSIGNMENT_ROW,
    });
    const adapter = new BoardAdapter({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getUiTokenFn: () => "ui-test-token",
    });

    const created = await adapter.createAssignment({
      task_id: "TB-1",
      specialist: "@GCW: Senior Frontend Developer",
      harness: "zcode",
    });

    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("/api/assignments");
    expect(calls[0].authorization).toBe("Bearer ui-test-token");
    // Wire shape: executor_id is a plain string with a server default.
    expect(calls[0].body).toEqual({
      task_id: "TB-1",
      specialist: "@GCW: Senior Frontend Developer",
      harness: "zcode",
      executor_id: "",
    });
    expect(created.assignment.id).toBe(101);
  });

  it("createAssignment: 409 active-holds invariant surfaces as ApiError", async () => {
    const { fetchImpl } = recordingFetch(409, {
      detail: "task 'TB-1' already holds an active assignment",
    });
    const adapter = new BoardAdapter({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const attempt = adapter.createAssignment({
      task_id: "TB-1",
      specialist: "x",
      harness: "zcode",
    });
    await expect(attempt).rejects.toBeInstanceOf(ApiError);
    await expect(attempt).rejects.toMatchObject({ status: 409 });
  });

  it("cancelAssignment: POST /assignments/{id}/cancel with the reason body", async () => {
    const { fetchImpl, calls } = recordingFetch(200, {
      ok: true,
      assignment: { ...ASSIGNMENT_ROW, state: "cancelled" },
      task: null,
      moved: [],
      report: null,
    });
    const adapter = new BoardAdapter({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getUiTokenFn: () => "ui-test-token",
    });

    const result = await adapter.cancelAssignment(101, "дубль");

    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("/api/assignments/101/cancel");
    expect(calls[0].authorization).toBe("Bearer ui-test-token");
    expect(calls[0].body).toEqual({ reason: "дубль" });
    expect(result.assignment.state).toBe("cancelled");
    expect(result.moved).toEqual([]);
  });

  it("cancelAssignment: default reason is the empty string, not undefined", async () => {
    const { fetchImpl, calls } = recordingFetch(200, {
      ok: true,
      assignment: ASSIGNMENT_ROW,
      moved: [],
    });
    const adapter = new BoardAdapter({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await adapter.cancelAssignment(101);
    expect(calls[0].body).toEqual({ reason: "" });
  });
});

describe("BoardAdapter agents wire — executors + settings", () => {
  it("listExecutors: GET /executors with the presence TTL meta intact", async () => {
    const { fetchImpl, calls } = recordingFetch(200, {
      ok: true,
      count: 1,
      items: [
        {
          id: "exec-laptop-zcode",
          name: "zcode@laptop",
          harness: "zcode",
          host: "laptop",
          transport: "local-poll",
          capabilities: [],
          version: "1.11.3",
          enabled: true,
          state: "approved",
          last_seen: "2026-09-19T08:59:30+00:00",
          presence: "online",
          registered_at: "2026-09-18T09:00:00+00:00",
          updated_at: "2026-09-19T08:00:00+00:00",
        },
      ],
      meta: {
        presence: { online_max_age_s: 120, stale_max_age_s: 600 },
        sweeper_interval_s: 60,
      },
    });
    const adapter = new BoardAdapter({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const page = await adapter.listExecutors();

    expect(calls[0].url).toBe("/api/executors");
    expect(calls[0].authorization).toBeUndefined();
    // TTL constants travel WITH the data — the UI never hardcodes them.
    expect(page.meta).toEqual({
      presence: { online_max_age_s: 120, stale_max_age_s: 600 },
      sweeper_interval_s: 60,
    });
    expect(page.items[0].presence).toBe("online");
  });

  it("getExecutionSettings: GET /settings/execution (open read)", async () => {
    const { fetchImpl, calls } = recordingFetch(200, {
      ok: true,
      default_executor: "exec-laptop-zcode",
      fallback_executor: "exec-mesh-qa",
      scope: "",
    });
    const adapter = new BoardAdapter({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const settings = await adapter.getExecutionSettings();
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("/api/settings/execution");
    expect(settings.default_executor).toBe("exec-laptop-zcode");
  });

  it("putExecutionSettings: PUT with ui bearer; scope defaults to ''", async () => {
    const { fetchImpl, calls } = recordingFetch(200, {
      ok: true,
      default_executor: "exec-laptop-zcode",
      fallback_executor: "",
      scope: "",
    });
    const adapter = new BoardAdapter({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getUiTokenFn: () => "ui-test-token",
    });

    await adapter.putExecutionSettings({
      default_executor: "exec-laptop-zcode",
      fallback_executor: "",
    });

    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toBe("/api/settings/execution");
    expect(calls[0].authorization).toBe("Bearer ui-test-token");
    expect(calls[0].body).toEqual({
      default_executor: "exec-laptop-zcode",
      fallback_executor: "",
      scope: "",
    });
  });

  it("putExecutionSettings: 422 gate violations carry the server message", async () => {
    const { fetchImpl } = recordingFetch(422, {
      detail: "executor exec-x is disabled — a default must be enabled",
    });
    const adapter = new BoardAdapter({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      adapter.putExecutionSettings({ default_executor: "exec-x", fallback_executor: "" }),
    ).rejects.toMatchObject({
      status: 422,
      message: "executor exec-x is disabled — a default must be enabled",
    });
  });
});

describe("BoardAdapter agents wire — automation surface (SCHED-1)", () => {
  const RULE = {
    id: 1,
    name: "утренний съём статуса TB-1",
    enabled: true,
    target_kind: "task",
    task_id: "TB-1",
    specialist: "@GCW: Senior Frontend Developer",
    harness: "zcode",
    executor_id: "",
    trigger_kind: "time-of-day",
    trigger_value: "09:00",
    window_from: null,
    window_to: null,
    max_runs_per_day: 1,
    cooldown_s: 3600,
    next_run_at: "2026-09-20T09:00:00+00:00",
    last_run_at: null,
    created_by: "owner",
    created_at: "2026-09-18T12:00:00+00:00",
    updated_at: "2026-09-18T12:00:00+00:00",
  };

  /** Create payload derived from the rule row (wire: no id/clocks). */
  const SCHEDULE_CREATE = {
    name: RULE.name,
    target_kind: RULE.target_kind,
    task_id: RULE.task_id,
    specialist: RULE.specialist,
    harness: RULE.harness,
    executor_id: RULE.executor_id,
    trigger_kind: RULE.trigger_kind,
    trigger_value: RULE.trigger_value,
    window_from: RULE.window_from,
    window_to: RULE.window_to,
    max_runs_per_day: RULE.max_runs_per_day,
    cooldown_s: RULE.cooldown_s,
  };

  function adapterWith(status: number, body: unknown) {
    const stub = recordingFetch(status, body);
    const adapter = new BoardAdapter({
      fetchImpl: stub.fetchImpl as unknown as typeof fetch,
      getUiTokenFn: () => "ui-test-token",
    });
    return { adapter, calls: stub.calls };
  }

  it("status/launches are open GETs on the right paths", async () => {
    const status = adapterWith(200, { ok: true, engine: false });
    await status.adapter.automationStatus();
    expect(status.calls[0].url).toBe("/api/automation/status");
    expect(status.calls[0].authorization).toBeUndefined();

    const launches = adapterWith(200, {
      ok: true,
      count: 0,
      total: 0,
      items: [],
      next_cursor: null,
      truncated: false,
    });
    await launches.adapter.listLaunches({ kind: "schedule", decision: "launched" });
    expect(launches.calls[0].url).toBe(
      "/api/automation/launches?kind=schedule&decision=launched",
    );
  });

  it("schedule CRUD + run-now hit the right methods and paths with bearer", async () => {
    const list = adapterWith(200, { ok: true, count: 1, items: [RULE] });
    await list.adapter.listSchedules();
    expect(list.calls[0].method).toBe("GET");

    const create = adapterWith(201, RULE);
    await create.adapter.createSchedule(SCHEDULE_CREATE);
    expect(create.calls[0].method).toBe("POST");
    expect(create.calls[0].url).toBe("/api/automation/schedules");
    expect(create.calls[0].authorization).toBe("Bearer ui-test-token");

    const patch = adapterWith(200, { ...RULE, enabled: false });
    await patch.adapter.patchSchedule(1, { enabled: false });
    expect(patch.calls[0].method).toBe("PATCH");
    expect(patch.calls[0].url).toBe("/api/automation/schedules/1");

    const remove = adapterWith(200, { ok: true, note: "soft-disabled" });
    await remove.adapter.deleteSchedule(1);
    expect(remove.calls[0].method).toBe("DELETE");
    expect(remove.calls[0].url).toBe("/api/automation/schedules/1");

    const run = adapterWith(200, {
      ok: true,
      decision: "launched",
      reason: "",
      assignment_id: 102,
      launch_id: 3,
      run_at: "2026-09-19T09:00:01+00:00",
    });
    await run.adapter.runScheduleNow(1);
    expect(run.calls[0].method).toBe("POST");
    expect(run.calls[0].url).toBe("/api/automation/schedules/1/run");
  });

  it("hook CRUD mirrors the schedule surface", async () => {
    const hook = {
      id: 1,
      name: "уведомить о провале исполнения",
      enabled: true,
      on: "assignment.failed",
      condition: [],
      source_allowlist: ["ui", "server"],
      action: "notify",
      action_payload: {},
      cooldown_s: 300,
      budget: 4,
      created_by: "owner",
      created_at: "2026-09-18T09:00:00+00:00",
      updated_at: "2026-09-18T09:00:00+00:00",
    };
    const list = adapterWith(200, { ok: true, count: 1, items: [hook] });
    await list.adapter.listHooks();
    expect(list.calls[0].url).toBe("/api/automation/hooks");

    const create = adapterWith(201, hook);
    await create.adapter.createHook({
      name: hook.name,
      on: hook.on,
      condition: [],
      source_allowlist: [...hook.source_allowlist],
      action: hook.action,
      action_payload: {},
      cooldown_s: hook.cooldown_s,
      budget: hook.budget,
    });
    expect(create.calls[0].method).toBe("POST");

    const patch = adapterWith(200, { ...hook, enabled: false });
    await patch.adapter.patchHook(1, { enabled: false });
    expect(patch.calls[0].method).toBe("PATCH");
    expect(patch.calls[0].url).toBe("/api/automation/hooks/1");

    const remove = adapterWith(200, { ok: true, note: "soft-disabled" });
    await remove.adapter.deleteHook(1);
    expect(remove.calls[0].method).toBe("DELETE");
    expect(remove.calls[0].url).toBe("/api/automation/hooks/1");
  });
});
