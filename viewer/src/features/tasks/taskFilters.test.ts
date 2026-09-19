import { describe, expect, it } from "vitest";
import { MOCK_TASKS } from "@/gateway/boardFixtures";
import {
  agentOptions,
  filterTasks,
  hasActiveTaskFilters,
  parseTaskListParams,
  projectOptions,
  serializeTaskListParams,
} from "./taskFilters";

/**
 * URL contract for `/tasks` (QA verdict §3: "list state in URL"): parse
 * drops unknown dictionary values, serialize omits empties (clean URLs),
 * filter runs client-side over the one cached board projection.
 */
describe("parseTaskListParams", () => {
  it("reads all five filters from the URL", () => {
    const state = parseTaskListParams(
      new URLSearchParams("status=blocked&priority=critical&project=mnemos&agent=zcode&q=fts"),
    );
    expect(state).toEqual({
      status: "blocked",
      priority: "critical",
      project: "mnemos",
      agent: "zcode",
      q: "fts",
    });
  });

  it("drops unknown dictionary values but keeps free-form ones", () => {
    const state = parseTaskListParams(
      new URLSearchParams("status=urgent&priority=mega&project=&agent=claude"),
    );
    expect(state.status).toBeUndefined();
    expect(state.priority).toBeUndefined();
    expect(state.project).toBeUndefined();
    expect(state.agent).toBe("claude");
  });
});

describe("serializeTaskListParams (round-trip, clean URLs)", () => {
  it("omits empty values", () => {
    const params = serializeTaskListParams({ status: undefined, q: undefined });
    expect(params.toString()).toBe("");
  });

  it("round-trips a full state", () => {
    const state = {
      status: "in-progress",
      priority: "high",
      project: "mnemos-eyes",
      agent: "zcode",
      q: "viewer",
    };
    const again = parseTaskListParams(serializeTaskListParams(state));
    expect(again).toEqual(state);
  });
});

describe("filterTasks (client-side over the board projection)", () => {
  it("filters by status, priority, project, agent and q (title/summary/id)", () => {
    expect(filterTasks(MOCK_TASKS, { status: "blocked" }).map((t) => t.id)).toEqual([
      "RB-2",
      "TB-5",
    ]);
    expect(filterTasks(MOCK_TASKS, { priority: "critical" }).map((t) => t.id)).toEqual([
      "TB-1",
      "TB-5",
    ]);
    expect(filterTasks(MOCK_TASKS, { project: "vesmaro" }).every((t) => t.project === "vesmaro")).toBe(true);
    expect(filterTasks(MOCK_TASKS, { agent: "claude" }).map((t) => t.id)).toEqual(["T6"]);
    expect(filterTasks(MOCK_TASKS, { q: "httadapter-never" })).toEqual([]);
    // q is a substring match over id/title/summary — "tb-1" legitimately
    // also hits TB-10/TB-11, but an exact-ish unique token stays unique.
    expect(filterTasks(MOCK_TASKS, { q: "rb-2" }).map((t) => t.id)).toEqual(["RB-2"]);
    // … and title (case-insensitive).
    expect(filterTasks(MOCK_TASKS, { q: "DENSITÉ" }).map((t) => t.id)).toEqual(["TB-11"]);
  });

  it("combines filters with AND semantics", () => {
    const rows = filterTasks(MOCK_TASKS, { project: "mnemos-eyes", priority: "critical" });
    expect(rows.map((t) => t.id)).toEqual(["TB-1", "TB-5"]);
  });

  it("empty state returns everything", () => {
    expect(filterTasks(MOCK_TASKS, {}).length).toBe(MOCK_TASKS.length);
  });
});

describe("hasActiveTaskFilters / option derivation", () => {
  it("flags any narrowing filter", () => {
    expect(hasActiveTaskFilters({})).toBe(false);
    expect(hasActiveTaskFilters({ q: "x" })).toBe(true);
    expect(hasActiveTaskFilters({ status: "open" })).toBe(true);
  });

  it("derives sorted, distinct project and agent options from the rows", () => {
    expect(projectOptions(MOCK_TASKS)).toEqual(["mnemos", "mnemos-eyes", "vesmaro"]);
    expect(agentOptions(MOCK_TASKS)).toEqual(["claude", "zcode"]);
  });
});
