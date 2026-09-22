// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/errors";
import { MockAdapter } from "@/gateway/MockAdapter";

/**
 * Mock harness-dictionary state machine (wave 3C): the server mirrors —
 * seed corpus, 422 name rule + 422 cap, 409 duplicate, 404 unknown,
 * 409 in-use (executor / non-terminal assignment / schedule / hook
 * condition), terminal history NOT blocking, and the mock's OWN
 * nomination gates (enrollment hint, assignment create, automation
 * values_hint) reading the live state like the server reads the table.
 */

function fresh(): MockAdapter {
  return new MockAdapter({ latency: false });
}

/** The in-use blocks, asserted via the rejects matcher. */
const expectApiError = async (
  promise: Promise<unknown>,
  status: number,
  fragment: string,
): Promise<void> => {
  await expect(promise).rejects.toSatisfy((error: unknown) => {
    return (
      error instanceof ApiError &&
      error.status === status &&
      error.message.includes(fragment)
    );
  });
};

beforeEach(() => {
  localStorage.clear();
});

describe("MockAdapter harness dictionary (wave 3C)", () => {
  it("boots with the 10-seed corpus and meta.seed_min_count = 10", async () => {
    const gateway = fresh();
    const page = await gateway.listHarnesses();
    expect(page.count).toBe(10);
    expect(page.meta.seed_min_count).toBe(10);
    expect(page.items.map((harness) => harness.name)).toContain("zcode");
    expect(page.items.every((harness) => harness.added_via === "seed")).toBe(true);
  });

  it("adds owner rows, sorts alphabetically, refuses duplicates 409", async () => {
    const gateway = fresh();
    await gateway.createHarness({ name: "myagent", note: "vps" });
    const page = await gateway.listHarnesses();
    expect(page.items[0].name).toBe("aider"); // still sorted
    expect(page.count).toBe(11);
    const added = page.items.find((harness) => harness.name === "myagent");
    expect(added).toMatchObject({ added_via: "owner", note: "vps" });
    await expectApiError(
      gateway.createHarness({ name: "myagent" }),
      409,
      "already registered",
    );
  });

  it("enforces the name rule (422) — uppercase, spaces, leading dot, over-long", async () => {
    const gateway = fresh();
    for (const bad of ["Bad", "has space", ".dot", "-dash", "x".repeat(61)]) {
      await expectApiError(gateway.createHarness({ name: bad }), 422, "invalid harness name");
    }
  });

  it("refuses the 65th entry with the cap 422 (seeds + owners counted)", async () => {
    const gateway = fresh();
    for (let i = 0; i < 54; i += 1) {
      await gateway.createHarness({ name: `h-${String(i).padStart(2, "0")}` });
    }
    await expectApiError(
      gateway.createHarness({ name: "overflow" }),
      422,
      "capped at 64",
    );
  });

  it("deletes a free row; a second delete is 404 (no idempotence promise)", async () => {
    const gateway = fresh();
    await gateway.createHarness({ name: "myagent" });
    await expect(gateway.deleteHarness("myagent")).resolves.toBeUndefined();
    await expectApiError(gateway.deleteHarness("myagent"), 404, "not registered");
  });

  it("deletes a SEED row and it stays gone (seed fills an empty table only)", async () => {
    const gateway = fresh();
    await gateway.deleteHarness("windsurf");
    const page = await gateway.listHarnesses();
    expect(page.items.map((harness) => harness.name)).not.toContain("windsurf");
  });

  it("refuses to delete a harness used by a registered executor (409)", async () => {
    const gateway = fresh();
    await expectApiError(
      gateway.deleteHarness("zcode"),
      409,
      "registered executor",
    );
  });

  it("refuses to delete a harness with a queued assignment (409)", async () => {
    const gateway = fresh();
    await gateway.createHarness({ name: "myagent" });
    const task = await gateway.createTask({
      title: "harness pin",
      summary: "",
      spec: "",
      col: "open",
      priority: "normal",
      env: "unknown",
      agents: [],
      specialists: [],
      project: "",
      memory_ids: [],
      mnemos_tags: [],
    });
    await gateway.createAssignment({
      task_id: task.id,
      specialist: "s",
      harness: "myagent",
    });
    await expectApiError(
      gateway.deleteHarness("myagent"),
      409,
      "active assignments",
    );
  });

  it("schedules block only while ENABLED (creation is disabled; soft-deleted rows stay dormant)", async () => {
    const gateway = fresh();
    await gateway.createHarness({ name: "myagent" });
    const task = await gateway.createTask({
      title: "harness rule",
      summary: "",
      spec: "",
      col: "open",
      priority: "normal",
      env: "unknown",
      agents: [],
      specialists: [],
      project: "",
      memory_ids: [],
      mnemos_tags: [],
    });
    const schedule = await gateway.createSchedule({
      name: "sched-mock",
      target_kind: "task",
      task_id: task.id,
      specialist: "s",
      harness: "myagent",
      executor_id: "",
      trigger_kind: "interval",
      trigger_value: "PT1H",
      max_runs_per_day: 4,
      cooldown_s: 300,
    });
    // creation is DISABLED (S1) → dormant → the delete passes
    await expect(gateway.deleteHarness("myagent")).resolves.toBeUndefined();
    // same harness again, this time against an ENABLED schedule → 409
    await gateway.createHarness({ name: "myagent" });
    await gateway.patchSchedule(schedule.id, { enabled: true });
    await expectApiError(gateway.deleteHarness("myagent"), 409, "schedule");
    // soft-delete (retention keeps the row, disabled) → dormant again
    await gateway.deleteSchedule(schedule.id);
    await expect(gateway.deleteHarness("myagent")).resolves.toBeUndefined();
  });

  it("an ENABLED hook condition blocks; a disabled one does not (409)", async () => {
    const gateway = fresh();
    await gateway.createHarness({ name: "myagent" });
    const hook = await gateway.createHook({
      name: "hook-mock",
      on: "task.moved",
      condition: [{ field: "harness", op: "eq", value: "myagent" }],
      action: "notify",
      cooldown_s: 300,
      budget: 4,
    });
    // created DISABLED → dormant → the delete passes
    await expect(gateway.deleteHarness("myagent")).resolves.toBeUndefined();
    await gateway.createHarness({ name: "myagent" });
    await gateway.patchHook(hook.id, { enabled: true, cooldown_s: 300, budget: 4 });
    await expectApiError(gateway.deleteHarness("myagent"), 409, "hook");
    // soft-delete (retention keeps the row, disabled) → dormant again
    await gateway.deleteHook(hook.id);
    await expect(gateway.deleteHarness("myagent")).resolves.toBeUndefined();
  });

  it("the mock's OWN nomination gates read the live state (server parity)", async () => {
    const gateway = fresh();
    // assignment create with an unknown harness → 422
    const task = await gateway.createTask({
      title: "custom harness run",
      summary: "",
      spec: "",
      col: "open",
      priority: "normal",
      env: "unknown",
      agents: [],
      specialists: [],
      project: "",
      memory_ids: [],
      mnemos_tags: [],
    });
    await expectApiError(
      gateway.createAssignment({
        task_id: task.id,
        specialist: "s",
        harness: "myagent",
      }),
      422,
      "unknown harness",
    );
    // enrollment hint with an unknown harness → 422
    await expectApiError(
      gateway.createEnrollment({ harness_hint: "myagent" }),
      422,
      "unknown harness_hint",
    );
    // after the add, both gates pass and the automation meta lists it
    await gateway.createHarness({ name: "myagent" });
    await expect(
      gateway.createAssignment({
        task_id: task.id,
        specialist: "s",
        harness: "myagent",
      }),
    ).resolves.toBeTruthy();
    await expect(
      gateway.createEnrollment({ harness_hint: "myagent" }),
    ).resolves.toBeTruthy();
    const status = await gateway.automationStatus();
    expect(status.condition_meta.values_hint).toMatchObject({
      harness: expect.arrayContaining(["myagent"]),
    });
  });
});
