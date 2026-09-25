/**
 * Kora gateway context (ADR 0019 rev.2 — week 0).
 *
 * The Kora twin of gateway/GatewayContext.ts (same discipline: the context
 * lives in a `.ts` module, the provider JSX is mounted at the route seam —
 * react-refresh keeps working, components never construct adapters).
 * Week 0 wires the MOCK adapter unconditionally — no backend exists by
 * contract; when slice 1 lands, the provider takes an explicit adapter prop
 * and the mock moves to tests only (one-line swap in one place).
 */
import { createContext, useContext } from "react";
import { KoraMockAdapter } from "./KoraMockAdapter";
import type { KoraGateway } from "./koraGateway";

export const KoraGatewayContext = createContext<KoraGateway | null>(null);

/** Week-0 default adapter: the mock, latency off (deterministic renders). */
export function makeWeek0KoraGateway(): KoraGateway {
  return new KoraMockAdapter({ latency: false });
}

/** The single accessor — components never construct adapters themselves. */
export function useKoraGateway(): KoraGateway {
  const adapter = useContext(KoraGatewayContext);
  if (adapter === null) {
    throw new Error(
      "useKoraGateway: no KoraGateway in context — wrap the tree in KoraGatewayContext.Provider (routes.tsx week-0 mock or the future HTTP adapter).",
    );
  }
  return adapter;
}
