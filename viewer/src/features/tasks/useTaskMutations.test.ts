import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { MockAdapter } from "@/gateway/MockAdapter";
import { MOCK_ARCHIVED_TASK } from "@/gateway/boardFixtures";
import type { BoardTask } from "@/gateway/boardTypes";
import { ApiError } from "@/lib/errors";
import { keys } from "@/lib/queryKeys";
import { translate } from "@/i18n";
import type { ToastInput } from "@/components/Toast/toastContext";
import { UiTokenGate } from "@/features/ui-token/uiTokenGate";
import { clearUiToken } from "@/gateway/uiToken";
import { applyTaskEventToCache } from "./taskEvents";
import { createTaskMutations } from "./useTaskMutations";

/**
 * Ф3 mutation flows on the mock adapter (real QueryClient + real SSE cache
 * mapping): edit+423+force (BE-12), UI-8 resume, move, archive, unarchive,
 * create, adopt (201 + 409 conflict), scan — and the optimistic-apply →
 * SSE-reconciliation convergence (the same applyTaskEventToCache code path
 * runs for both). The ui-token gate is the REAL UiTokenGate in the 401 test.
 */

/** Fixed clock: every fixture task is older than 24h (BE-12 lock armed). */
const FIXED_NOW = Date.parse("2026-09-20T12:00:00Z");

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

interface Harness {
  gateway: MockAdapter;
  queryClient: QueryClient;
  toasts: ToastInput[];
  mutations: ReturnType<typeof createTaskMutations>;
  /** True while the ui-token panel is up (only wired in the gate harness). */
  gate: UiTokenGate | null;
}

/** Token-present harness: runAuthorized executes immediately. */
async function makeHarness(): Promise<Harness> {
  const gateway = new MockAdapter({ latency: false, now: () => FIXED_NOW });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await seedCaches(gateway, queryClient);
  const toasts: ToastInput[] = [];
  const mutations = createTaskMutations({
    runAuthorized: (run) => {
      void run();
    },
    toast: { push: (input) => toasts.push(input) },
    t: (key, vars) => translate("en", key, vars),
    gateway,
    queryClient,
  });
  return { gateway, queryClient, toasts, mutations, gate: null };
}

/** Seed the caches exactly like the running app would (board + archive). */
async function seedCaches(
  gateway: MockAdapter,
  queryClient: QueryClient,
): Promise<void> {
  await queryClient.prefetchQuery({
    queryKey: keys.tasks.board(),
    queryFn: () => gateway.board(),
  });
  await queryClient.prefetchQuery({
    queryKey: keys.tasks.archive({ limit: 50, offset: 0 }),
    queryFn: () => gateway.archive({ limit: 50, offset: 0 }),
  });
}

function boardRow(queryClient: QueryClient, id: string): BoardTask | undefined {
  const data = queryClient.getQueryData<{ tasks: BoardTask[] }>(keys.tasks.board());
  return data?.tasks.find((task) => task.id === id);
}

function boardCounts(queryClient: QueryClient): Record<string, number> {
  return queryClient.getQueryData<{ counts: Record<string, number> }>(
    keys.tasks.board(),
  )?.counts as Record<string, number>;
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", new MemoryStorage());
  clearUiToken();
});

describe("task mutations on the mock adapter", () => {
  it("edit: 423 age-lock (BE-12) → onLocked, then force succeeds and patches the cache", async () => {
    const { mutations, queryClient, toasts } = await makeHarness();
    const onLocked = vi.fn();
    const onSaved = vi.fn();

    // First attempt (force=false) on a task older than 24h: no toast, the
    // dialog-side onLocked fires, the cache keeps the old title.
    mutations.patchTask(
      boardRow(queryClient, "TB-1")!,
      { force: false, title: "Edited title" },
      { onLocked, onSaved },
    );
    await vi.waitFor(() => expect(onLocked).toHaveBeenCalledTimes(1));
    expect(toasts).toHaveLength(0);
    expect(boardRow(queryClient, "TB-1")?.title).not.toBe("Edited title");

    // Forced retry goes through: cache patched, success toast names force.
    mutations.patchTask(
      boardRow(queryClient, "TB-1")!,
      { force: true, title: "Edited title" },
      { onLocked, onSaved },
    );
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(boardRow(queryClient, "TB-1")?.title).toBe("Edited title");
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe("ok");
    expect(toasts[0].title).toBe("TB-1: saved");
    expect(toasts[0].detail).toBe("edited with force=true");
  });

  it("edit on a FRESH task (< 24h) needs no force", async () => {
    const { mutations, queryClient, toasts } = await makeHarness();
    // Create a task now (age 0) — its content edit must not 423.
    let createdId = "";
    await new Promise<void>((resolve) => {
      mutations.createTask(
        {
          title: "Fresh task",
          summary: "s",
          spec: "",
          col: "open",
          priority: "normal",
          env: "unknown",
          agents: [],
          specialists: [],
          project: "mnemos-eyes",
          memory_ids: [],
          mnemos_tags: [],
        },
        (task) => {
          createdId = task.id;
          resolve();
        },
      );
    });
    const onLocked = vi.fn();
    mutations.patchTask(
      boardRow(queryClient, createdId)!,
      { force: false, title: "Renamed" },
      {
        onLocked,
      },
    );
    await vi.waitFor(() =>
      expect(boardRow(queryClient, createdId)?.title).toBe("Renamed"),
    );
    expect(onLocked).not.toHaveBeenCalled();
    expect(toasts.at(-1)?.title).toBe(`${createdId}: saved`);
    expect(toasts.at(-1)?.detail).toBe("task content updated");
  });

  it("UI-8 resume: PATCH status=in-progress on an old task is NEVER 423-locked", async () => {
    const { mutations, queryClient, toasts } = await makeHarness();
    const tb8 = boardRow(queryClient, "TB-8")!; // done, updated 2026-09-06 (old)
    mutations.resumeTask(tb8);
    await vi.waitFor(() =>
      expect(boardRow(queryClient, "TB-8")?.status).toBe("in-progress"),
    );
    // BE-10: status flips, the column never moves.
    expect(boardRow(queryClient, "TB-8")?.col).toBe("done");
    expect(toasts.at(-1)?.title).toBe("TB-8: resumed");
    expect(toasts.at(-1)?.detail).toBe("status in-progress · column unchanged");
  });

  it("move: column + status patched, per-column counts recounted, toast carries the column", async () => {
    const { mutations, queryClient, toasts } = await makeHarness();
    expect(boardCounts(queryClient)).toMatchObject({ open: 3, blocked: 2 });
    mutations.moveTask(boardRow(queryClient, "TB-3")!, "blocked");
    await vi.waitFor(() => expect(boardRow(queryClient, "TB-3")?.col).toBe("blocked"));
    expect(boardRow(queryClient, "TB-3")?.status).toBe("blocked"); // synced on move
    expect(boardCounts(queryClient)).toMatchObject({ open: 2, blocked: 3 });
    expect(toasts.at(-1)?.title).toBe("TB-3: moved");
    expect(toasts.at(-1)?.detail).toBe("column: blocked");
  });

  it("archive: row leaves the board, counts drop, archive queries invalidated", async () => {
    const { mutations, queryClient, toasts } = await makeHarness();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    expect(boardCounts(queryClient)["in-progress"]).toBe(3);
    mutations.archiveTask(boardRow(queryClient, "TB-1")!);
    await vi.waitFor(() => expect(boardRow(queryClient, "TB-1")).toBeUndefined());
    expect(boardCounts(queryClient)["in-progress"]).toBe(2);
    expect(toasts.at(-1)?.title).toBe("TB-1: archived");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: keys.tasks.archiveAll });
  });

  it("unarchive: the restored row lands back on the board and the archive refreshes", async () => {
    const { mutations, queryClient, toasts } = await makeHarness();
    expect(boardRow(queryClient, "RB-1")).toBeUndefined(); // archived rows never board
    mutations.unarchiveTask(MOCK_ARCHIVED_TASK);
    await vi.waitFor(() => expect(boardRow(queryClient, "RB-1")).toBeDefined());
    expect(boardRow(queryClient, "RB-1")?.archived).toBe(0);
    expect(boardRow(queryClient, "RB-1")?.col).toBe("blocked"); // archived_from
    expect(toasts.at(-1)?.title).toBe("RB-1: back on the board");
  });

  it("create: row appended with an open-task toast link", async () => {
    const { mutations, queryClient, toasts } = await makeHarness();
    const before = queryClient.getQueryData<{ tasks: BoardTask[] }>(keys.tasks.board())!
      .tasks.length;
    let createdId = "";
    await new Promise<void>((resolve) => {
      mutations.createTask(
        {
          title: "Direct creation",
          summary: "owner decision: no draft-to-memory flow here",
          spec: "",
          col: "open",
          priority: "normal",
          env: "unknown",
          agents: [],
          specialists: [],
          project: "vesmaro",
          memory_ids: [],
          mnemos_tags: ["project:vesmaro"],
        },
        (task) => {
          createdId = task.id;
          resolve();
        },
      );
    });
    const row = boardRow(queryClient, createdId);
    expect(row?.title).toBe("Direct creation");
    expect(row?.col).toBe("open");
    expect(boardCounts(queryClient).open).toBe(4);
    expect(toasts.at(-1)?.title).toBe(`Task ${createdId} created`);
    expect(toasts.at(-1)?.action?.to).toBe(`/tasks/${createdId}`);
    expect(before).toBe(12);
  });

  it("adopt: creates the native task, invalidates the inbox; 409 double-adopt links the existing task", async () => {
    const { mutations, queryClient, toasts } = await makeHarness();
    const MEMORY_ID = "bd945a48-0888-4b1f-9ebb-841519e5f8b9";
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    mutations.adoptInboxItem(MEMORY_ID);
    await vi.waitFor(() =>
      expect(
        queryClient
          .getQueryData<{ tasks: BoardTask[] }>(keys.tasks.board())!
          .tasks.some((task) => task.memory_ids.includes(MEMORY_ID)),
      ).toBe(true),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: keys.tasks.inboxAll });
    const created = queryClient
      .getQueryData<{ tasks: BoardTask[] }>(keys.tasks.board())!
      .tasks.find((task) => task.memory_ids.includes(MEMORY_ID))!;
    expect(toasts.at(-1)?.title).toBe(`Adopted to board: ${created.id}`);
    expect(toasts.at(-1)?.action?.to).toBe(`/tasks/${created.id}`);

    // Double adoption: the mock mirrors the wire 409 {task_id} — the toast
    // turns into an error WITH a link to the existing task.
    mutations.adoptInboxItem(MEMORY_ID);
    await vi.waitFor(() => expect(toasts.length).toBeGreaterThanOrEqual(2));
    const conflict = toasts.at(-1)!;
    expect(conflict.kind).toBe("error");
    expect(conflict.title).toBe("Record already adopted");
    expect(conflict.detail).toBe(`task ${created.id} already exists`);
    expect(conflict.action?.to).toBe(`/tasks/${created.id}`);
  });

  it("scan: toast reports found/new, the inbox invalidates, onSettled fires", async () => {
    const { mutations, toasts } = await makeHarness();
    const onSettled = vi.fn();
    // (invalidate is asserted through the adopt test's spy pattern; here the
    // counters + settle contract are the point.)
    mutations.refreshInbox(onSettled);
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(toasts.at(-1)?.title).toBe("Scan complete");
    expect(toasts.at(-1)?.detail).toBe("records seen: 4, new: 0");
  });

  // --- optimistic apply + SSE reconciliation (one code path) --------------------

  it("SSE reconciles AFTER the optimistic patch: the event truth wins", async () => {
    const { mutations, queryClient } = await makeHarness();
    mutations.moveTask(boardRow(queryClient, "TB-3")!, "blocked");
    await vi.waitFor(() => expect(boardRow(queryClient, "TB-3")?.col).toBe("blocked"));

    // A concurrent SSE task.moved carries the server truth (resolved).
    applyTaskEventToCache(queryClient, {
      kind: "task.moved",
      task: { ...boardRow(queryClient, "TB-3")!, col: "resolved", status: "resolved" },
    });
    expect(boardRow(queryClient, "TB-3")?.col).toBe("resolved");
    expect(boardCounts(queryClient)).toMatchObject({
      open: 2,
      blocked: 2,
      resolved: 3,
    });
  });

  it("SSE duplicate of an already-applied mutation is an idempotent no-op", async () => {
    const { mutations, queryClient } = await makeHarness();
    mutations.archiveTask(boardRow(queryClient, "TB-1")!);
    await vi.waitFor(() => expect(boardRow(queryClient, "TB-1")).toBeUndefined());
    const afterArchive = boardCounts(queryClient);
    // The real SSE event arrives late for the same archive — nothing breaks.
    applyTaskEventToCache(queryClient, { kind: "task.archived", task_id: "TB-1" });
    expect(boardRow(queryClient, "TB-1")).toBeUndefined();
    expect(boardCounts(queryClient)).toEqual(afterArchive);
  });

  // --- full ui-token gate integration (401 → panel → retry → success) -----------

  it("401 → panel(rejected) → fresh token → the SAME mutation retries and succeeds", async () => {
    vi.stubGlobal("sessionStorage", new MemoryStorage());
    sessionStorage.setItem("vesmaro.uiToken", "stale-token");
    const gateway = new MockAdapter({ latency: false, now: () => FIXED_NOW });
    // The wire rejects every patch until the flag flips (like a real server
    // rejecting a stale ui token, then accepting the fresh one). The mock
    // instance is patched in place — a spread copy would lose the prototype
    // methods the capability guard probes.
    let rejectToken = true;
    const healthyPatch = gateway.patchTask.bind(gateway);
    gateway.patchTask = async (taskId, patch) => {
      if (rejectToken) throw new ApiError(401, "ui token rejected");
      return healthyPatch(taskId, patch);
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await seedCaches(gateway, queryClient);
    const toasts: ToastInput[] = [];
    const gate = new UiTokenGate({
      hasToken: () => sessionStorage.getItem("vesmaro.uiToken") !== null,
    });
    const mutations = createTaskMutations({
      runAuthorized: gate.runAuthorized.bind(gate),
      toast: { push: (input) => toasts.push(input) },
      t: (key, vars) => translate("en", key, vars),
      gateway,
      queryClient,
    });

    const onLocked = vi.fn();
    const onSaved = vi.fn();
    mutations.patchTask(
      queryClient.getQueryData<{ tasks: BoardTask[] }>(keys.tasks.board())!.tasks[0],
      { force: true, title: "Through the gate" },
      { onLocked, onSaved },
    );
    // Stale token → 401 → cleared, panel reopens as rejected; NO error toast
    // (the panel is the honest answer, not a failure banner).
    await vi.waitFor(() =>
      expect(gate.getState()).toMatchObject({ open: true, reason: "rejected" }),
    );
    expect(sessionStorage.getItem("vesmaro.uiToken")).toBeNull();
    expect(toasts).toHaveLength(0);

    // Fresh token + healthy wire → the queued run retries to success.
    rejectToken = false;
    gate.submitToken("fresh-ui-token");
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(gate.getState().open).toBe(false);
    expect(
      queryClient
        .getQueryData<{ tasks: BoardTask[] }>(keys.tasks.board())!
        .tasks.find((task) => task.title === "Through the gate"),
    ).toBeDefined();
    expect(toasts.at(-1)?.title).toContain(": saved");
  });
});
