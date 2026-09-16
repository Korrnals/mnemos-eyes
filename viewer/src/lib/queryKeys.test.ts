import { describe, expect, it } from "vitest";
import { keys } from "./queryKeys";

describe("queryKeys", () => {
  it("builds stable memory list keys from params", () => {
    expect(keys.memories.list({ status: "active" })).toEqual([
      "memories",
      "list",
      { status: "active" },
    ]);
    expect(keys.memories.list()).toEqual(["memories", "list", {}]);
  });

  it("separates detail keys by id and raw flag", () => {
    expect(keys.memories.detail("m1")).toEqual([
      "memories",
      "detail",
      "m1",
      { includeRaw: false },
    ]);
    expect(keys.memories.detail("m1", true)).not.toEqual(keys.memories.detail("m1"));
  });

  it("scopes search keys by full params", () => {
    const params = { query: "iris", limit: 10 } as const;
    expect(keys.search.results(params)).toEqual(["search", params]);
  });

  it("keeps session/traces/status namespaces disjoint", () => {
    const roots = [
      keys.memories.all[0],
      keys.search.results({ query: "x" })[0],
      keys.tags.all[0],
      keys.status.health()[0],
      keys.traces.all[0],
      keys.sessions.all[0],
      keys.clusters.all[0],
    ];
    expect(new Set(roots).size).toBe(roots.length);
  });
});
