import { describe, expect, it } from "vitest";
import type { ExecutorItem } from "./boardTypes";
import { resolveRoutingAnnotation } from "./routing";

/**
 * The client routing mirror (AGW-2 preview + mock annotations) against the
 * frozen tier chain of server `_routing_annotation` (Amd 2 §5). These are
 * the SAME cases the AssignExecutorSheet preview shows — the sheet renders
 * whatever this resolver answers, so the preview can be tested pure.
 */

function executor(overrides: Partial<ExecutorItem>): ExecutorItem {
  return {
    id: "exec-x",
    name: "x",
    harness: "zcode",
    host: "",
    transport: "local-poll",
    capabilities: [],
    version: "",
    enabled: true,
    state: "approved",
    last_seen: "",
    presence: "online",
    registered_via: "",
    registered_at: "",
    updated_at: "",
    ...overrides,
  };
}

const FRONTEND = executor({
  id: "exec-frontend",
  capabilities: ["@GCW: Senior Frontend Developer"],
});

const QA = executor({
  id: "exec-qa",
  capabilities: ["@GCW: Senior QA Engineer"],
  transport: "mesh-r4",
});

const IDLE_LAPTOP = executor({ id: "exec-idle", capabilities: [] });

const OFFLINE_WORKER = executor({
  id: "exec-offline",
  presence: "offline",
});

describe("resolveRoutingAnnotation — tier chain (server mirror)", () => {
  it("explicit pin wins outright — the only tier enforced at claim", () => {
    const routing = resolveRoutingAnnotation({
      pin: "exec-qa",
      specialist: "@GCW: Senior Frontend Developer",
      taskSpecialists: ["@GCW: Senior QA Engineer"],
      executors: [FRONTEND, QA, IDLE_LAPTOP],
      globalDefault: "exec-idle",
    });
    expect(routing).toEqual({ resolved: "exec-qa", reason: "explicit" });
  });

  it("assignment specialist nominates before task specialists", () => {
    const routing = resolveRoutingAnnotation({
      specialist: "@GCW: Senior Frontend Developer",
      taskSpecialists: ["@GCW: Senior QA Engineer"],
      executors: [FRONTEND, QA],
    });
    expect(routing).toEqual({ resolved: "exec-frontend", reason: "specialist" });
  });

  it("task specialists are the fallback nomination tier", () => {
    const routing = resolveRoutingAnnotation({
      specialist: "no-such-role",
      taskSpecialists: ["@GCW: Senior QA Engineer"],
      executors: [FRONTEND, QA],
    });
    expect(routing).toEqual({ resolved: "exec-qa", reason: "task-specialists" });
  });

  it("global default resolves EVEN OFFLINE — no silent substitution", () => {
    const routing = resolveRoutingAnnotation({
      specialist: "no-such-role",
      executors: [OFFLINE_WORKER, IDLE_LAPTOP],
      globalDefault: "exec-offline",
    });
    expect(routing).toEqual({ resolved: "exec-offline", reason: "global-default" });
  });

  it("an ineligible default (revoked) falls through, never substitutes silently", () => {
    const revoked = executor({ id: "exec-revoked", state: "revoked" });
    const routing = resolveRoutingAnnotation({
      executors: [revoked, IDLE_LAPTOP],
      globalDefault: "exec-revoked",
    });
    expect(routing).toEqual({ resolved: "exec-idle", reason: "auto" });
  });

  it("auto tier picks the live local worker deterministically", () => {
    const staleWorker = executor({ id: "exec-stale", presence: "stale" });
    const routing = resolveRoutingAnnotation({
      executors: [staleWorker, OFFLINE_WORKER, IDLE_LAPTOP, QA],
    });
    // QA is online but mesh-r4 (dispatch-ineligible until R4); the stale
    // worker outranks offline but loses to the online local one.
    expect(routing).toEqual({ resolved: "exec-idle", reason: "auto" });
  });

  it("id is the deterministic tiebreak among equal presence", () => {
    const a = executor({ id: "exec-b" });
    const b = executor({ id: "exec-a" });
    const routing = resolveRoutingAnnotation({
      executors: [a, b],
      globalDefault: "exec-zzz",
    });
    expect(routing).toEqual({ resolved: "exec-a", reason: "auto" });
  });

  it("unmatched when nothing is eligible — the honest queue wait", () => {
    const routing = resolveRoutingAnnotation({
      specialist: "anyone",
      executors: [OFFLINE_WORKER, executor({ id: "e", enabled: false })],
      globalDefault: "",
    });
    expect(routing).toEqual({ resolved: null, reason: "unmatched" });
  });

  it("project default sits between task specialists and global default", () => {
    const routing = resolveRoutingAnnotation({
      executors: [IDLE_LAPTOP],
      projectDefault: "exec-idle",
      globalDefault: "exec-irrelevant",
    });
    expect(routing).toEqual({ resolved: "exec-idle", reason: "project-default" });
  });
});
