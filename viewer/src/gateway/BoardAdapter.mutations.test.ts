import { describe, expect, it, vi } from "vitest";
import { BoardAdapter } from "./BoardAdapter";
import { ApiError } from "@/lib/errors";
import type { BoardTask } from "./boardTypes";

/**
 * Ф3 mutation wire contract of the BoardAdapter (board-openapi-snapshot):
 * paths, methods, bodies; `Authorization: Bearer` attached ONLY on mutating
 * calls and ONLY when a ui token is stored; 401 surfaces as ApiError so the
 * UiTokenGate can take over. Reads never carry the header (ADR 0011 §7).
 */

const TASK: BoardTask = {
  id: "TB-1",
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

const TOKEN = "ui-test-token";

function adapterWithToken(fetchImpl: typeof fetch, token: string | null) {
  return new BoardAdapter({
    baseUrl: "/api",
    fetchImpl,
    getUiTokenFn: () => token ?? "",
  });
}

describe("BoardAdapter mutations (ui-token gate on the wire)", () => {
  it("mutations carry Authorization: Bearer when a ui token is stored", async () => {
    const { fetchImpl, calls } = recordingFetch(200, TASK);
    const adapter = adapterWithToken(fetchImpl, TOKEN);
    await adapter.patchTask("TB-1", { force: false, title: "New" });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe("/api/tasks/TB-1");
    expect(calls[0].authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].body).toEqual({ force: false, title: "New" });
  });

  it("mutations ship WITHOUT Authorization when no token is stored (fail-closed server answers 401)", async () => {
    const { fetchImpl, calls } = recordingFetch(200, TASK);
    const adapter = adapterWithToken(fetchImpl, null);
    await adapter.createTask({
      title: "New task",
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
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("/api/tasks");
    expect(calls[0].authorization).toBeUndefined();
    expect((calls[0].body as { title: string }).title).toBe("New task");
  });

  it("reads never carry Authorization (reads stay open through Ф0–Ф2)", async () => {
    const { fetchImpl, calls } = recordingFetch(200, {
      columns: [],
      tasks: [],
      counts: {},
    });
    const adapter = adapterWithToken(fetchImpl, TOKEN);
    await adapter.board();
    expect(calls[0].method).toBe("GET");
    expect(calls[0].authorization).toBeUndefined();
  });

  it("401 on a mutation rejects with ApiError(401) — the gate takes over upstream", async () => {
    const { fetchImpl } = recordingFetch(401, { detail: "ui token required" });
    const adapter = adapterWithToken(fetchImpl, "stale-token");
    await expect(adapter.archiveTask("TB-1")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
    });
  });

  it("hasUiToken mirrors the injected token source", () => {
    const { fetchImpl } = recordingFetch(200, TASK);
    expect(adapterWithToken(fetchImpl, TOKEN).hasUiToken()).toBe(true);
    expect(adapterWithToken(fetchImpl, null).hasUiToken()).toBe(false);
    expect(adapterWithToken(fetchImpl, "").hasUiToken()).toBe(false);
  });

  it("moveTask posts {col, position} to /tasks/{id}/move", async () => {
    const { fetchImpl, calls } = recordingFetch(200, TASK);
    const adapter = adapterWithToken(fetchImpl, TOKEN);
    await adapter.moveTask("TB-1", "blocked");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("/api/tasks/TB-1/move");
    expect(calls[0].body).toEqual({ col: "blocked", position: null });
    expect(calls[0].authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("archive/unarchive/adopt/refresh hit their wire paths", async () => {
    const { fetchImpl, calls } = recordingFetch(200, { ok: true });
    const adapter = adapterWithToken(fetchImpl, TOKEN);
    await adapter.archiveTask("TB-1");
    await adapter.unarchiveTask("TB-1");
    await adapter.adoptInboxItem("mem-1");
    await adapter.refreshInbox();
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["POST", "/api/tasks/TB-1/archive"],
      ["POST", "/api/tasks/TB-1/unarchive"],
      ["POST", "/api/tasks/inbox/mem-1/adopt"],
      ["POST", "/api/tasks/inbox/refresh"],
    ]);
    expect(calls.every((call) => call.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("ApiError carries the response body (409 adopt conflict parsing upstream)", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ task_id: "TB-3" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const adapter = adapterWithToken(fetchImpl, TOKEN);
    const error = await adapter.adoptInboxItem("mem-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect(JSON.parse((error as ApiError).body ?? "{}")).toEqual({ task_id: "TB-3" });
  });
});
