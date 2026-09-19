import { describe, expect, it } from "vitest";
import { MOCK_TASKS } from "@/gateway/boardFixtures";
import {
  TASK_GROUPS_STORAGE_KEY,
  groupTasksByProject,
  loadCollapsedGroups,
  saveCollapsedGroups,
  sortGroupTasks,
} from "./taskGrouping";

/**
 * Project grouping of the task list (verdict §3 + concept §2.3): groups by
 * project, priority → position inside, collapse set persisted under
 * "vesmaro.taskGroups" (guarded storage — node tests inject a stub).
 */

/** Minimal Storage double (the node environment has no localStorage). */
function storageStub(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

describe("groupTasksByProject", () => {
  it("buckets by project, sorts groups by name, no-project last", () => {
    const groups = groupTasksByProject(MOCK_TASKS);
    expect(groups.map((g) => g.project)).toEqual(["mnemos", "mnemos-eyes", "vesmaro"]);
    for (const group of groups) {
      for (const task of group.tasks) {
        expect(task.project).toBe(group.project);
      }
    }
  });

  it("puts the empty-project bucket last", () => {
    const groups = groupTasksByProject([
      { ...MOCK_TASKS[0], project: "" },
      { ...MOCK_TASKS[1], project: "a" },
    ]);
    expect(groups.map((g) => g.project)).toEqual(["a", ""]);
  });
});

describe("sortGroupTasks (priority → position → id)", () => {
  it("sorts critical first, low last; position breaks ties", () => {
    const sorted = sortGroupTasks(MOCK_TASKS);
    const priorities = sorted.map((t) => t.priority);
    // Weight order check without assuming equal counts:
    const weight = (p: string) => ({ critical: 3, high: 2, normal: 1, low: 0 })[p] ?? 1;
    const weights = priorities.map(weight);
    expect([...weights].sort((a, b) => b - a)).toEqual(weights);

    // Within one priority bucket the board position wins (open bucket):
    const open = sorted.filter((t) => t.status === "open");
    expect(open.map((t) => t.id)).toEqual(["TB-3", "TB-10", "TB-4"]);
  });
});

describe("collapsed-group persistence (vesmaro.taskGroups)", () => {
  it("round-trips the collapse set through the storage stub", () => {
    const storage = storageStub();
    const collapsed = new Set(["mnemos", "vesmaro"]);
    saveCollapsedGroups(collapsed, storage);
    expect(storage.getItem(TASK_GROUPS_STORAGE_KEY)).toBe('["mnemos","vesmaro"]');
    expect(loadCollapsedGroups(storage)).toEqual(collapsed);
  });

  it("resets silently on corrupt / non-array data", () => {
    const storage = storageStub({ [TASK_GROUPS_STORAGE_KEY]: "{not json" });
    expect(loadCollapsedGroups(storage)).toEqual(new Set());
    const storage2 = storageStub({ [TASK_GROUPS_STORAGE_KEY]: '({"a":1})' });
    expect(loadCollapsedGroups(storage2)).toEqual(new Set());
  });

  it("drops non-string entries while keeping valid ones", () => {
    const storage = storageStub({ [TASK_GROUPS_STORAGE_KEY]: '["mnemos", 42, null]' });
    expect(loadCollapsedGroups(storage)).toEqual(new Set(["mnemos"]));
  });

  it("survives a missing storage (node env / private mode)", () => {
    expect(loadCollapsedGroups(undefined)).toEqual(new Set());
    expect(() => saveCollapsedGroups(new Set(["x"]), undefined)).not.toThrow();
  });
});
