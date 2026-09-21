import { describe, expect, it } from "vitest";
import {
  NAV_DOMAINS,
  activeDomain,
  crumbsFor,
  isPathActive,
  routeTitleKey,
} from "./navItems";

/**
 * Ф1 IA gates: the domain map (§2.1), breadcrumb matrix (§2.2 — last crumb
 * is never a link) and TopBar titles, pure over pathnames.
 */
describe("domain map", () => {
  it("is the concept IA: Overview root + Memory + Tasks/Agents/Stores slots + System", () => {
    expect(NAV_DOMAINS.map((d) => d.to)).toEqual([
      "/",
      "/memory",
      "/tasks",
      "/agents",
      "/stores",
      "/system",
    ]);
  });

  it("marks only the phase-4+ domains as soon-slots (AGW-3 activates Agents)", () => {
    const slots = NAV_DOMAINS.filter((d) => d.soonKey).map((d) => d.to);
    expect(slots).toEqual(["/stores"]);
  });

  it("never links a domain at a path without a route (no dead links)", () => {
    // Every domain link target must own breadcrumbs — a page that exists.
    // System has no /system index in Ф1, so its domain link targets the
    // first live section while matching on the /system prefix. The root "/"
    // is the Overview itself (it legitimately carries no trail).
    for (const domain of NAV_DOMAINS) {
      if (domain.soonKey || domain.to === "/") continue;
      const target = domain.linkTo ?? domain.to;
      expect(
        crumbsFor(target).length,
        `${domain.to} links to ${target} (no route)`,
      ).toBeGreaterThan(0);
    }
    const system = NAV_DOMAINS.find((d) => d.to === "/system");
    expect(system?.linkTo).toBe("/system/status");
  });

  it("prefix-matches domains; the root matches exactly", () => {
    expect(isPathActive("/", "/", true)).toBe(true);
    expect(isPathActive("/memory/x", "/memory")).toBe(true);
    expect(isPathActive("/memory", "/memory", true)).toBe(true);
    expect(isPathActive("/memoryx", "/memory")).toBe(false);
    expect(activeDomain("/memory/pulse")?.to).toBe("/memory");
    expect(activeDomain("/system/status")?.to).toBe("/system");
    // Ф2: the task domain is live — its pages resolve the domain.
    expect(activeDomain("/tasks")?.to).toBe("/tasks");
    expect(activeDomain("/tasks/TB-1")?.to).toBe("/tasks");
    // AGW-3: the agents domain is live — its pages resolve the domain.
    expect(activeDomain("/agents")?.to).toBe("/agents");
    expect(activeDomain("/agents/execution")?.to).toBe("/agents");
  });

  it("gives the task domain its Ф2–Ф3 sections (kanban / list / inbox / archive)", () => {
    const tasks = NAV_DOMAINS.find((d) => d.to === "/tasks");
    expect(tasks?.soonKey).toBeUndefined();
    expect(tasks?.sections?.map((s) => s.to)).toEqual([
      "/tasks",
      "/tasks/list",
      "/tasks/inbox",
      "/tasks/archive",
    ]);
    // The inbox section carries the live counter wiring.
    expect(tasks?.sections?.find((s) => s.to === "/tasks/inbox")?.counter).toBe(
      "inbox",
    );
  });

  it("gives the agents domain its AGW-3 execution section (root = alias)", () => {
    const agents = NAV_DOMAINS.find((d) => d.to === "/agents");
    expect(agents?.soonKey).toBeUndefined();
    // The domain root has no index route — the domain link goes to the
    // execution view (spec §1: /agents aliases /agents/execution).
    expect(agents?.linkTo).toBe("/agents/execution");
    expect(agents?.sections?.map((s) => s.to)).toEqual(["/agents/execution"]);
  });
});

describe("breadcrumbs (last crumb is not a link)", () => {
  it("has no trail on the root", () => {
    expect(crumbsFor("/")).toEqual([]);
  });

  it("trails every level-2 page with a non-link tail", () => {
    expect(crumbsFor("/memory")).toEqual([
      { to: "/memory", key: "nav.memory" },
      { key: "nav.records" },
    ]);
    expect(crumbsFor("/memory/search")).toEqual([
      { to: "/memory", key: "nav.memory" },
      { key: "nav.search" },
    ]);
    expect(crumbsFor("/memory/pulse")[1]).toEqual({ key: "nav.pulse" });
    expect(crumbsFor("/memory/tags")[1]).toEqual({ key: "nav.tags" });
    expect(crumbsFor("/system/status")[1]).toEqual({ key: "nav.status" });
    expect(crumbsFor("/system/traces")[1]).toEqual({ key: "nav.traces" });
  });

  it("trails detail pages one level deeper (level 3)", () => {
    expect(crumbsFor("/memory/m-42")).toEqual([
      { to: "/memory", key: "nav.memory" },
      { to: "/memory", key: "nav.records" },
      { key: "nav.record" },
    ]);
    expect(crumbsFor("/system/sessions/s-7")).toEqual([
      { to: "/system", key: "nav.system" },
      { to: "/system/sessions", key: "nav.sessions" },
      { key: "nav.session" },
    ]);
    expect(crumbsFor("/tasks/TB-1")).toEqual([
      { to: "/tasks", key: "nav.tasks" },
      { to: "/tasks", key: "nav.taskList" },
      { key: "nav.task" },
    ]);
  });

  it("trails the Ф2–Ф3 task pages (board / list / inbox / archive)", () => {
    expect(crumbsFor("/tasks")).toEqual([
      { to: "/tasks", key: "nav.tasks" },
      { key: "nav.taskBoard" },
    ]);
    expect(crumbsFor("/tasks/list")).toEqual([
      { to: "/tasks", key: "nav.tasks" },
      { key: "nav.taskList" },
    ]);
    expect(crumbsFor("/tasks/inbox")).toEqual([
      { to: "/tasks", key: "nav.tasks" },
      { key: "nav.taskInbox" },
    ]);
    expect(crumbsFor("/tasks/archive")).toEqual([
      { to: "/tasks", key: "nav.tasks" },
      { key: "nav.taskArchive" },
    ]);
  });

  it("keeps known subpaths above the :id catch-all", () => {
    // /memory/search is a page, not a record id — the trail proves it.
    expect(crumbsFor("/memory/search")[1].key).toBe("nav.search");
  });
});

describe("routeTitleKey (TopBar label = deepest crumb)", () => {
  it("returns the last crumb key, null for unknowns", () => {
    expect(routeTitleKey("/")).toBe("nav.overview");
    expect(routeTitleKey("/memory")).toBe("nav.records");
    expect(routeTitleKey("/memory/m-1")).toBe("nav.record");
    expect(routeTitleKey("/system/sessions")).toBe("nav.sessions");
    expect(routeTitleKey("/nope")).toBeNull();
  });
});
