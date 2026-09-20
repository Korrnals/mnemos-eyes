import type { ExecutorItem, RoutingAnnotation } from "./boardTypes";

/**
 * Client-side mirror of the server routing-annotation chain (server/app.py
 * `_routing_annotation`, Amd 2 §5). ONE implementation serves two consumers:
 * - the MockAdapter computes item annotations with it (dev-mode parity);
 * - the AssignExecutorSheet derives its LIVE route preview from it (spec
 *   §2.3 — «превью показывает правило, факт показывает claimed_by»).
 *
 * Tier order is frozen by the server: explicit pin → assignment specialist →
 * task specialists → project default → global default → auto best-match
 * (online + local-poll) → unmatched. Nomination tiers are
 * presence-agnostic; the deterministic best pick is presence rank then id
 * (server `min()`). Defaults resolve even when their target is OFFLINE (the
 * owner chose it — silent substitution is forbidden); ineligible
 * (revoked/disabled/gone) defaults fall through to the next tier.
 *
 * Known divergence from the server, by data availability: the project-default
 * tier reads a board_meta key the UI has no endpoint for — the preview
 * accepts it as an input (`projectDefault`) but the live sheet always passes
 * nothing, so a project default may make the REAL route differ from the
 * preview. The preview is labelled as a preview for exactly this reason.
 */

/** Presence rank for the deterministic best-pick (server `_PRESENCE_RANK`). */
export const PRESENCE_RANK: Readonly<Record<string, number>> = {
  online: 2,
  stale: 1,
  offline: 0,
};

/** Everything the chain needs; every tier input is optional data-honestly. */
export interface RoutingChainInput {
  /** Explicit executor pin (the only tier enforced at claim). */
  readonly pin?: string;
  /** The assignment's own specialist role. */
  readonly specialist?: string;
  /** The task's specialist list (nomination tier 2). */
  readonly taskSpecialists?: readonly string[];
  readonly executors: readonly ExecutorItem[];
  /** Reserved per-project default (server-only data today — see docblock). */
  readonly projectDefault?: string;
  /** Global default from `GET /api/settings/execution`. */
  readonly globalDefault?: string;
}

/** Deterministic best pick: presence rank desc, then id asc (server min()). */
function bestOf(candidates: readonly ExecutorItem[]): ExecutorItem {
  return candidates.reduce((a, b) => {
    const byPresence = PRESENCE_RANK[b.presence] - PRESENCE_RANK[a.presence];
    if (byPresence !== 0) return byPresence > 0 ? b : a;
    return b.id < a.id ? b : a;
  });
}

/** Resolve the routing chain for one prospective assignment. Pure. */
export function resolveRoutingAnnotation(input: RoutingChainInput): RoutingAnnotation {
  const pin = (input.pin ?? "").trim();
  if (pin) return { resolved: pin, reason: "explicit" };
  const eligible = input.executors.filter(
    (executor) => executor.state === "approved" && executor.enabled,
  );
  const byCapability = (role: string): ExecutorItem[] =>
    eligible.filter((executor) => executor.capabilities.includes(role));

  const specialist = (input.specialist ?? "").trim();
  if (specialist) {
    const candidates = byCapability(specialist);
    if (candidates.length > 0) {
      return { resolved: bestOf(candidates).id, reason: "specialist" };
    }
  }
  for (const role of input.taskSpecialists ?? []) {
    const candidates = byCapability(role);
    if (candidates.length > 0) {
      return { resolved: bestOf(candidates).id, reason: "task-specialists" };
    }
  }
  const eligibleIds = new Set(eligible.map((executor) => executor.id));
  const projectDefault = (input.projectDefault ?? "").trim();
  if (projectDefault && eligibleIds.has(projectDefault)) {
    return { resolved: projectDefault, reason: "project-default" };
  }
  const globalDefault = (input.globalDefault ?? "").trim();
  if (globalDefault && eligibleIds.has(globalDefault)) {
    return { resolved: globalDefault, reason: "global-default" };
  }
  const auto = eligible.filter(
    (executor) => executor.transport === "local-poll" && executor.presence === "online",
  );
  if (auto.length > 0) return { resolved: bestOf(auto).id, reason: "auto" };
  return { resolved: null, reason: "unmatched" };
}
