import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpAdapter } from "./HttpAdapter";
import { clearToken, getToken, onUnauthorized, setToken } from "./auth";
import { ApiError } from "@/lib/errors";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** fetch double that records calls and answers with the given body/status. */
function respondingFetch(data: unknown, status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    jsonResponse(data, status),
  );
}

/** fetch double that never answers but rejects when the request is aborted. */
function hangingFetch() {
  return vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("The operation was aborted.", "AbortError")),
        { once: true },
      );
    });
  });
}

beforeEach(() => {
  clearToken();
});

afterEach(() => {
  vi.useRealTimers();
  clearToken();
});

describe("HttpAdapter wire contract", () => {
  it("search: POST /search with the SearchQuery body, hits normalised", async () => {
    const fetchMock = respondingFetch([
      {
        id: "hit-1",
        title: "Scroll",
        content: "Body",
        tags: ["project:x"],
        score: 0.87,
        search_type: "semantic",
      },
    ]);
    const adapter = new HttpAdapter({ fetchImpl: fetchMock as unknown as typeof fetch });

    const hits = await adapter.search({
      query: "gateway",
      tags: ["project:x"],
      project: "mnemos",
      limit: 5,
      include_raw: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/search");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      query: "gateway",
      tags: ["project:x"],
      project: "mnemos",
      limit: 5,
      include_raw: true,
    });
    expect(hits).toEqual([
      {
        id: "hit-1",
        title: "Scroll",
        content: "Body",
        tags: ["project:x"],
        score: 0.87,
        search_type: "semantic",
      },
    ]);
  });

  it("search: anonymous hits get honest defaults", async () => {
    const fetchMock = respondingFetch([{}]);
    const adapter = new HttpAdapter({ fetchImpl: fetchMock as unknown as typeof fetch });
    const [hit] = await adapter.search({ query: "x" });
    expect(hit).toEqual({
      id: "hit-0",
      title: "",
      content: "",
      tags: [],
      score: 0,
      search_type: "fts",
    });
  });

  it("listMemories: GET /memories with filter query params", async () => {
    const fetchMock = respondingFetch([]);
    const adapter = new HttpAdapter({ fetchImpl: fetchMock as unknown as typeof fetch });

    await adapter.listMemories({ status: "published", project: "mnemos", limit: 10, offset: 20 });
    let [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/memories?status=published&project=mnemos&limit=10&offset=20");

    await adapter.listMemories();
    [url] = fetchMock.mock.calls[1] as [string];
    expect(url).toBe("/api/memories");
  });

  it("getMemory: GET /memories/{id} with include_raw only when requested", async () => {
    const fetchMock = respondingFetch({ id: "mem-1", content: "c" });
    const adapter = new HttpAdapter({ fetchImpl: fetchMock as unknown as typeof fetch });

    await adapter.getMemory("mem-1");
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("/api/memories/mem-1");

    await adapter.getMemory("mem-1", true);
    expect((fetchMock.mock.calls[1] as [string])[0]).toBe("/api/memories/mem-1?include_raw=true");
  });

  it("listTags / health / metrics hit their endpoints with GET", async () => {
    const fetchMock = respondingFetch([]);
    const adapter = new HttpAdapter({ fetchImpl: fetchMock as unknown as typeof fetch });

    await adapter.listTags();
    await adapter.health();
    await adapter.metrics();
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("/api/tags");
    expect((fetchMock.mock.calls[1] as [string])[0]).toBe("/api/health");
    expect((fetchMock.mock.calls[2] as [string])[0]).toBe("/api/metrics");
  });

  it("listTraces: GET /traces, synthesises ids for anonymous entries", async () => {
    const fetchMock = respondingFetch([
      { task_label: "l1", steps: [] },
      { id: "trace-9", task_label: "l2", steps: [] },
    ]);
    const adapter = new HttpAdapter({ fetchImpl: fetchMock as unknown as typeof fetch });

    const traces = await adapter.listTraces("l1", 25);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("/api/traces?task_label=l1&limit=25");
    expect(traces[0].id).toBe("trace-0");
    expect(traces[1].id).toBe("trace-9");
  });

  it("agentRecall: GET /recall/agent/{name} with query params", async () => {
    const fetchMock = respondingFetch([]);
    const adapter = new HttpAdapter({ fetchImpl: fetchMock as unknown as typeof fetch });

    await adapter.agentRecall("zed", "mnemos", "fts", 3);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      "/api/recall/agent/zed?project=mnemos&q=fts&limit=3",
    );
  });

  it("getSession: GET /v1/sessions/{id}; listSessions fails loud with 501", async () => {
    const fetchMock = respondingFetch({ session_id: "conv-1", user_id: "u" });
    const adapter = new HttpAdapter({ fetchImpl: fetchMock as unknown as typeof fetch });

    const session = await adapter.getSession("conv-1");
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("/api/v1/sessions/conv-1");
    expect(session.session_id).toBe("conv-1");

    // The mnemos snapshot has no session-list endpoint — honest failure.
    const error = await adapter.listSessions().catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(501);
  });
});

describe("HttpAdapter error mapping", () => {
  it("maps 404 + JSON detail to ApiError with the detail message", async () => {
    const fetchMock = respondingFetch({ detail: "Memory not found" }, 404);
    const adapter = new HttpAdapter({ fetchImpl: fetchMock as unknown as typeof fetch });
    const error = await adapter.getMemory("nope").catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
    expect(error.message).toBe("Memory not found");
    expect(error.body).toBe(JSON.stringify({ detail: "Memory not found" }));
    expect(error.url).toBe("/api/memories/nope");
  });

  it("maps 4xx to non-retryable ApiError and 5xx to retryable", async () => {
    const badRequest = new HttpAdapter({
      fetchImpl: respondingFetch({ detail: "bad input" }, 422) as unknown as typeof fetch,
    });
    const serverError = new HttpAdapter({
      fetchImpl: respondingFetch("kaboom", 503) as unknown as typeof fetch,
    });

    const e422 = await badRequest.listMemories().catch((e) => e);
    expect(e422.status).toBe(422);
    // Retry classification lives in lib/errors.isRetryable — verify semantics.
    const { isRetryable } = await import("@/lib/errors");
    expect(isRetryable(e422)).toBe(false);

    const e503 = await serverError.listMemories().catch((e) => e);
    expect(e503.status).toBe(503);
    expect(e503.message).toContain("kaboom");
    expect(isRetryable(e503)).toBe(true);
  });

  it("fires the unauthorized flag on 401", async () => {
    const fetchMock = respondingFetch({ detail: "expired token" }, 401);
    const adapter = new HttpAdapter({ fetchImpl: fetchMock as unknown as typeof fetch });
    const onUnauthorizedSpy = vi.fn();
    onUnauthorized(onUnauthorizedSpy);

    const error = await adapter.listMemories().catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);
    expect(onUnauthorizedSpy).toHaveBeenCalledTimes(1);
  });

  it("maps network-level failures to ApiError status 0", async () => {
    const failing = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const adapter = new HttpAdapter({ fetchImpl: failing as unknown as typeof fetch });
    const error = await adapter.health().catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error.cause).toBeInstanceOf(TypeError);
  });
});

describe("HttpAdapter auth header", () => {
  it("attaches the Bearer token when one is set", async () => {
    setToken("mnk_secret");
    const fetchMock = respondingFetch([]);
    const adapter = new HttpAdapter({ fetchImpl: fetchMock as unknown as typeof fetch });

    await adapter.listMemories();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer mnk_secret");
    expect(getToken()).toBe("mnk_secret");
  });

  it("sends no Authorization header without a token", async () => {
    clearToken();
    const fetchMock = respondingFetch([]);
    const adapter = new HttpAdapter({ fetchImpl: fetchMock as unknown as typeof fetch });

    await adapter.listTags();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe("HttpAdapter timeouts and cancellation", () => {
  it("times out after the default budget and throws ApiError(0)", async () => {
    vi.useFakeTimers();
    const adapter = new HttpAdapter({
      fetchImpl: hangingFetch() as unknown as typeof fetch,
    });

    const promise = adapter.listMemories().catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await promise;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error.message).toMatch(/timed out after 10000 ms/);
  });

  it("gives search a generous 30 s budget before timing out", async () => {
    vi.useFakeTimers();
    const adapter = new HttpAdapter({
      fetchImpl: hangingFetch() as unknown as typeof fetch,
    });

    const promise = adapter.search({ query: "slow semantics" }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(Promise.race([promise, "in-flight"])).resolves.toBe("in-flight");

    await vi.advanceTimersByTimeAsync(20_000);
    const error = await promise;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/timed out after 30000 ms/);
  });

  it("propagates caller cancellation as a raw abort, not ApiError", async () => {
    const adapter = new HttpAdapter({
      fetchImpl: hangingFetch() as unknown as typeof fetch,
      timeoutMs: 60_000,
    });
    const controller = new AbortController();

    const promise = adapter.listMemories(undefined, controller.signal).catch((e) => e);
    controller.abort();
    const error = await promise;

    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });
});
