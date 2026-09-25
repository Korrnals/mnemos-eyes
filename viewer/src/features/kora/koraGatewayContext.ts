/**
 * Kora gateway context (ADR 0019 rev.2 — slice 1).
 *
 * The Kora twin of gateway/GatewayContext.ts (same discipline: the context
 * lives in a `.ts` module, the provider JSX is mounted at the route seam —
 * react-refresh keeps working, components never construct adapters).
 *
 * Slice 1 wiring: the DEFAULT gateway is the HTTP adapter against the
 * board's GET /api/kora/sessions (frozen contract, week-0 swap plan: one
 * line in one place). The mock survives for tests and deterministic
 * renders (makeMockKoraGateway); the week-0 export name is kept as an
 * alias so demo entry points keep compiling.
 */
import { createContext, useContext } from "react";
import { KoraHttpAdapter } from "./KoraHttpAdapter";
import { KoraMockAdapter } from "./KoraMockAdapter";
import type { KoraGateway } from "./koraGateway";

export const KoraGatewayContext = createContext<KoraGateway | null>(null);

/** Slice-1 default: the HTTP adapter over the frozen board contract. */
export function makeKoraGateway(): KoraGateway {
  return new KoraHttpAdapter();
}

/** Week-0 mock adapter (tests, snapshot fixtures, demo seam). */
export function makeMockKoraGateway(latency = false): KoraGateway {
  return new KoraMockAdapter({ latency });
}

/** Backwards-compatible week-0 name (kept for the demo entry points). */
export const makeWeek0KoraGateway = makeMockKoraGateway;

/** The single accessor — components never construct adapters themselves. */
export function useKoraGateway(): KoraGateway {
  const adapter = useContext(KoraGatewayContext);
  if (adapter === null) {
    throw new Error(
      "useKoraGateway: no KoraGateway in context — wrap the tree in KoraGatewayContext.Provider (routes.tsx).",
    );
  }
  return adapter;
}