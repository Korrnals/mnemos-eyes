import { describe, expect, it } from "vitest";
import { PREFERS_REDUCED_MOTION_QUERY, useReducedMotion } from "./useReducedMotion";

/**
 * Export-contract test: the vitest environment is node (no `window`, no DOM),
 * so the media-query behaviour itself is covered by the T5 browser suite.
 * Here we lock the public surface and the query string the CSS contract
 * (design-system.md §7) depends on.
 */
describe("useReducedMotion", () => {
  it("is defined and is a hook function", () => {
    expect(useReducedMotion).toBeDefined();
    expect(typeof useReducedMotion).toBe("function");
  });

  it("targets the standard reduced-motion media feature", () => {
    expect(PREFERS_REDUCED_MOTION_QUERY).toBe("(prefers-reduced-motion: reduce)");
  });
});
