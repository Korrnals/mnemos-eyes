import { describe, expect, it } from "vitest";
import {
  hasActiveFilters,
  parseMemoryListParams,
  toListParams,
} from "./listParams";

describe("memory list URL params", () => {
  it("falls back to defaults for missing or invalid values", () => {
    const state = parseMemoryListParams(new URLSearchParams(""));
    expect(state).toEqual({ status: undefined, project: undefined, limit: 20, page: 1 });

    const invalid = parseMemoryListParams(
      new URLSearchParams("limit=7&page=-2&status=nope"),
    );
    expect(invalid.limit).toBe(20);
    expect(invalid.page).toBe(1);
    expect(invalid.status).toBeUndefined();
  });

  it("maps page+limit to an offset for the gateway", () => {
    const state = parseMemoryListParams(new URLSearchParams("page=3&limit=10&status=published&project=mnemos"));
    expect(toListParams(state)).toEqual({
      status: "published",
      project: "mnemos",
      limit: 10,
      offset: 20,
    });
  });

  it("detects active filters for the empty-state copy", () => {
    expect(hasActiveFilters(parseMemoryListParams(new URLSearchParams("project=x")))).toBe(true);
    expect(hasActiveFilters(parseMemoryListParams(new URLSearchParams("")))).toBe(false);
  });
});
