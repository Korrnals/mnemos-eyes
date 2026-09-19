import { describe, expect, it } from "vitest";
import { LEGACY_ROUTES, redirectTarget } from "./legacyRedirects";
import { crumbsFor } from "@/layout/navItems";

/**
 * Ф1 route-freeze gate (QA verdict §3: "роуты заморожены + редиректы
 * протестированы"). The legacy map is pure data — this locks every old path
 * onto its new home, including :id pass-through, and cross-checks that every
 * redirect target is a real Phase-1 destination (it owns breadcrumbs).
 */
describe("legacy redirects (bookmark survival)", () => {
  it("maps every pre-convergence flat route to its domain home", () => {
    expect(redirectTarget("/search")).toBe("/memory/search");
    expect(redirectTarget("/memories")).toBe("/memory");
    expect(redirectTarget("/memories/m-123")).toBe("/memory/m-123");
    expect(redirectTarget("/tags")).toBe("/memory/tags");
    expect(redirectTarget("/status")).toBe("/system/status");
    expect(redirectTarget("/sessions")).toBe("/system/sessions");
    expect(redirectTarget("/sessions/s-9")).toBe("/system/sessions/s-9");
    expect(redirectTarget("/traces")).toBe("/system/traces");
  });

  it("is case-exact and shape-exact: extras and unknowns stay null", () => {
    expect(redirectTarget("/Memories")).toBeNull();
    expect(redirectTarget("/memories/")).toBeNull();
    expect(redirectTarget("/memories/m-1/extra")).toBeNull();
    expect(redirectTarget("/memory")).toBeNull(); // new paths are not legacy
    expect(redirectTarget("/")).toBeNull();
    expect(redirectTarget("")).toBeNull();
  });

  it("keeps route params across the move (deep detail links survive)", () => {
    for (const legacy of ["/memories/:id", "/sessions/:id"]) {
      expect(LEGACY_ROUTES.some((route) => route.from === legacy)).toBe(true);
    }
    expect(redirectTarget("/memories/abc%20def")).toBe("/memory/abc def");
  });

  it("targets only real Ф1 destinations (every target has a breadcrumb home)", () => {
    for (const { to } of LEGACY_ROUTES) {
      const target = to.replace(/:[^/]+/g, "probe-id");
      expect(
        crumbsFor(target).length,
        `${to} → ${target} has no crumbs`,
      ).toBeGreaterThan(0);
    }
  });
});
