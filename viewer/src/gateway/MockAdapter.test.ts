import { describe, expect, it } from "vitest";
import { MockAdapter, pulseContentFragment } from "./MockAdapter";
import { MOCK_MEMORIES } from "./fixtures";
import { ApiError } from "@/lib/errors";

/** Latency-disabled adapter — tests stay fast and fully synchronous-ish. */
function makeAdapter() {
  return new MockAdapter({ latency: false });
}

describe("MockAdapter.search", () => {
  it("finds memories by a title/tag substring and ranks them fts", async () => {
    const adapter = makeAdapter();
    const hits = await adapter.search({ query: "gateway" });

    // mem-0001 (title) and mem-0009 (topic:gateway tag) are surface hits;
    // mem-0015/0018 carry the term only in content → semantic, ranked lower.
    expect(hits.map((hit) => hit.id)).toEqual([
      "mem-0001",
      "mem-0009",
      "mem-0015",
      "mem-0018",
    ]);
    expect(hits[0].search_type).toBe("fts");
    expect(hits[1].search_type).toBe("fts");
    expect(hits[2].search_type).toBe("semantic");
    expect(hits[3].search_type).toBe("semantic");
    expect(hits[0].score).toBeGreaterThan(hits[2].score);
    expect(hits.every((hit) => hit.score > 0)).toBe(true);
  });

  it("marks content-only matches as semantic and ranks them lower", async () => {
    const adapter = makeAdapter();
    const hits = await adapter.search({ query: "obsidian" });

    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("mem-0011");
    expect(hits[0].search_type).toBe("semantic");
    expect(hits[0].score).toBeLessThanOrEqual(0.25);
  });

  it("marks mixed surface matches as hybrid", async () => {
    const adapter = makeAdapter();
    const hits = await adapter.search({ query: "proxy" });

    const ids = hits.map((hit) => hit.id);
    expect(ids).toContain("mem-0001"); // title + content
    expect(ids).toContain("mem-0009"); // tag + content
    expect(ids).toContain("mem-0013"); // title + content
    expect(hits.every((hit) => hit.search_type === "hybrid")).toBe(true);
    expect(hits[0].score).toBe(1); // every surface of a single term matched
  });

  it("requires every term to match (AND semantics)", async () => {
    const adapter = makeAdapter();
    // "gateway" lives in mem-0001/0009/0015/0018, "wal" only in mem-0003 —
    // the conjunction has no owner.
    const hits = await adapter.search({ query: "gateway wal" });
    expect(hits).toHaveLength(0);
  });

  it("honours tag filters (AND) and project filter", async () => {
    const adapter = makeAdapter();
    const hits = await adapter.search({
      query: "checkpoint",
      tags: ["mnemos:checkpoint"],
      project: "gcw",
    });

    expect(hits.map((hit) => hit.id)).toEqual(["mem-0005"]);
    expect(hits[0].tags).toContain("project:gcw");
  });

  it("applies the limit", async () => {
    const adapter = makeAdapter();
    const hits = await adapter.search({ query: "mnemos", limit: 3 });
    expect(hits).toHaveLength(3);
  });

  it("returns nothing for an empty/whitespace query", async () => {
    const adapter = makeAdapter();
    await expect(adapter.search({ query: "" })).resolves.toEqual([]);
    await expect(adapter.search({ query: "   " })).resolves.toEqual([]);
  });

  it("is deterministic across instances", async () => {
    const params = { query: "mnemos proxy", limit: 10 };
    const a = await makeAdapter().search(params);
    const b = await makeAdapter().search(params);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("MockAdapter.listMemories", () => {
  it("returns all memories, newest first", async () => {
    const all = await makeAdapter().listMemories();
    expect(all).toHaveLength(MOCK_MEMORIES.length);
    expect(all[0].id).toBe("mem-0015"); // 2026-09-15T21:30 — newest fixture
    for (let i = 1; i < all.length; i++) {
      const [prevDate, currentDate] = [all[i - 1].created_at ?? "", all[i].created_at ?? ""];
      expect(prevDate >= currentDate).toBe(true);
    }
  });

  it("filters by status and project", async () => {
    const adapter = makeAdapter();
    const published = await adapter.listMemories({ status: "published" });
    expect(published.length).toBeGreaterThan(0);
    expect(published.every((memory) => memory.status === "published")).toBe(true);

    const mnemos = await adapter.listMemories({ project: "mnemos" });
    expect(mnemos).toHaveLength(9);
    expect(mnemos.every((memory) => memory.project === "mnemos")).toBe(true);
  });

  it("paginates with offset/limit over the sorted list", async () => {
    const adapter = makeAdapter();
    const page1 = await adapter.listMemories({ limit: 5, offset: 0 });
    const page2 = await adapter.listMemories({ limit: 5, offset: 5 });
    const all = await adapter.listMemories();

    expect(page1).toHaveLength(5);
    expect(page2).toHaveLength(5);
    const ids1 = new Set(page1.map((memory) => memory.id));
    for (const memory of page2) {
      expect(ids1.has(memory.id)).toBe(false);
    }
    expect(page2[0].id).toBe(all[5].id);
  });
});

describe("MockAdapter.getMemory", () => {
  it("withholds raw_content by default, serves it on includeRaw", async () => {
    const adapter = makeAdapter();
    const clean = await adapter.getMemory("mem-0002");
    expect(clean.raw_content).toBeNull();

    const raw = await adapter.getMemory("mem-0002", true);
    expect(typeof raw.raw_content).toBe("string");
  });

  it("throws ApiError 404 for unknown ids", async () => {
    const error = await makeAdapter().getMemory("mem-does-not-exist").catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
  });
});

describe("MockAdapter.listTags", () => {
  it("counts tags and sorts by count desc with a stable tiebreak", async () => {
    const tags = await makeAdapter().listTags();
    expect(tags[0]).toEqual({ tag: "project:mnemos", count: 9 });

    for (let i = 1; i < tags.length; i++) {
      const [prev, current] = [tags[i - 1], tags[i]];
      expect(
        prev.count > current.count ||
          (prev.count === current.count && prev.tag < current.tag),
      ).toBe(true);
    }
  });
});

describe("MockAdapter.agentRecall", () => {
  it("filters by agent tag/field, project and query", async () => {
    const hits = await makeAdapter().agentRecall("zed", "mnemos-eyes", "gateway");
    // mem-0015 (newest, content match) then mem-0001 — recency-ranked.
    expect(hits.map((hit) => hit.id)).toEqual(["mem-0015", "mem-0001"]);
    expect(hits[0].score).toBe(1);
    expect(hits[1].score).toBe(0.5);
  });

  it("returns an empty list for an unknown agent", async () => {
    await expect(makeAdapter().agentRecall("nobody")).resolves.toEqual([]);
  });

  it("applies the limit", async () => {
    const hits = await makeAdapter().agentRecall("zed", undefined, undefined, 2);
    expect(hits).toHaveLength(2);
  });
});

describe("MockAdapter.status and traces", () => {
  it("reports deterministic health", async () => {
    expect(await makeAdapter().health()).toEqual({
      status: "ok",
      version: "4.1.0-mock",
      project: "mnemos-eyes",
    });
  });

  it("derives metrics from the fixtures", async () => {
    const metrics = await makeAdapter().metrics();
    expect(metrics.memories_total).toBe(MOCK_MEMORIES.length);
    expect(metrics.sessions_total).toBe(3);
    expect(metrics.traces_total).toBe(6);
    const byStatus = metrics.memories_by_status as Record<string, number>;
    expect(byStatus.published).toBe(
      MOCK_MEMORIES.filter((memory) => memory.status === "published").length,
    );
  });

  it("lists traces newest-first and filters by task_label", async () => {
    const adapter = makeAdapter();
    const all = await adapter.listTraces();
    expect(all.map((trace) => trace.id)).toEqual([
      "trace-0184",
      "trace-0186",
      "trace-0187",
      "trace-0185",
      "trace-0183",
      "trace-0182",
    ]);

    const scaffold = await adapter.listTraces("l1-t1-scaffold");
    expect(scaffold.map((trace) => trace.task_label)).toEqual([
      "l1-t1-scaffold",
      "l1-t1-scaffold",
    ]);

    const limited = await adapter.listTraces(undefined, 2);
    expect(limited).toHaveLength(2);
  });
});

describe("MockAdapter.sessions", () => {
  it("lists sessions newest-first and serves one by id", async () => {
    const adapter = makeAdapter();
    const sessions = await adapter.listSessions();
    expect(sessions.map((session) => session.session_id)).toEqual([
      "conv-2026-09-15-88c2f10b",
      "conv-2026-09-12-4f7a21c9",
      "conv-2026-09-08-77c3aa01",
    ]);

    const session = await adapter.getSession("conv-2026-09-12-4f7a21c9");
    expect(session.turns_count).toBe(6);
  });

  it("throws ApiError 404 for an unknown session id", async () => {
    const error = await makeAdapter()
      .getSession("conv-1970-01-01-00000000")
      .catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
  });
});

describe("MockAdapter.cancellation and latency", () => {
  it("rejects immediately with AbortError when the signal is already aborted", async () => {
    const adapter = makeAdapter();
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.listMemories({}, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("aborts an in-flight latency delay", async () => {
    const adapter = new MockAdapter({ latency: { minMs: 5_000, maxMs: 5_000 } });
    const controller = new AbortController();
    const promise = adapter.health(controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("applies a default 80–200 ms latency that can be disabled", async () => {
    const start = performance.now();
    await new MockAdapter().health(); // default options → latency enabled
    expect(performance.now() - start).toBeGreaterThanOrEqual(80);
  });
});

describe("MockAdapter.pulse content fragments (server content_fragment mirror)", () => {
  it("serves the documented overrides: mem-0004 markdown, mem-0005 honest null", async () => {
    const pulse = await makeAdapter().pulse({ scope: "all", limit: 20 });
    const byId = new Map(pulse.items.map((item) => [item.id, item.content]));
    expect(byId.get("mem-0004")).toBe(
      "# Decision log\n\n- namespaced tags only\n- `topic:` slugs reviewed weekly",
    );
    expect(byId.has("mem-0005")).toBe(true);
    expect(byId.get("mem-0005")).toBeNull();
  });

  it("keeps every corpus fragment within the 400-char wire cap", async () => {
    const pulse = await makeAdapter().pulse({ scope: "all", limit: 20 });
    for (const item of pulse.items) {
      expect(item.content == null || item.content.length <= 400).toBe(true);
    }
  });

  it("cuts at the server whitespace set: space, tab, VT, FF (not space-only)", () => {
    // Tab is a legal boundary on the wire (the old mock cut at " " only).
    const tabbed = "a".repeat(380) + "\t" + "b".repeat(30);
    expect(pulseContentFragment(tabbed)).toBe("a".repeat(380));
    // \u000B vertical tab and \f form feed — the full server _WS_CHARS set
    // (" \t\r\n\f\v"; \r and \n are stripped by the leading trim in these
    // examples, VT/FF are not — this is the drift the fix closes).
    expect(pulseContentFragment("a".repeat(380) + "\u000B" + "b".repeat(30))).toBe(
      "a".repeat(380),
    );
    expect(pulseContentFragment("a".repeat(380) + "\f" + "b".repeat(30))).toBe(
      "a".repeat(380),
    );
    // Plain space stays the common case.
    expect(pulseContentFragment("a".repeat(380) + " " + "b".repeat(30))).toBe(
      "a".repeat(380),
    );
  });

  it("matches the server window: a boundary AT the limit is legal", () => {
    // Whitespace sits exactly at index 400 → the server keeps text[:400]
    // (rfind over [0, limit+1)) instead of falling back to an earlier
    // boundary. Index 400 is whitespace, indices 0..399 are not.
    const text = "a".repeat(100) + " " + "b".repeat(299) + " " + "c".repeat(50);
    expect(text[100]).toBe(" ");
    expect(text[400]).toBe(" ");
    expect(pulseContentFragment(text)).toHaveLength(400);
  });

  it("hard-cuts when the window holds no whitespace", () => {
    expect(pulseContentFragment("x".repeat(500))).toBe("x".repeat(400));
    // A boundary beyond the window does not rescue the hard cut.
    expect(pulseContentFragment("x".repeat(420) + " " + "tail")).toBe(
      "x".repeat(400),
    );
  });

  it("maps blank or absent content to honest null", () => {
    expect(pulseContentFragment(null)).toBeNull();
    expect(pulseContentFragment(undefined)).toBeNull();
    expect(pulseContentFragment("")).toBeNull();
    expect(pulseContentFragment("   \t\n")).toBeNull();
  });

  it("passes short content through whole and trimmed", () => {
    expect(pulseContentFragment("  hello world  ")).toBe("hello world");
  });
});
