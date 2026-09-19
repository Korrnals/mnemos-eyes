import type { MemoryGateway } from "./MemoryGateway";
import { BoardAdapter } from "./BoardAdapter";
import { HttpAdapter } from "./HttpAdapter";
import { MockAdapter } from "./MockAdapter";
import { clearToken } from "./auth";

/**
 * Single source of truth for the gateway bootstrap knobs, read from the Vite
 * environment at module load. Shared by `main.tsx` (adapter construction)
 * and the auth UI (endpoint label in the TopBar connection indicator) so both
 * always describe the same backend.
 *
 * Adapter selection (ADR 0011 Ф0): `VITE_ADAPTER=mock|mnemos|board`, default
 * `mnemos` — the pre-convergence behaviour. The legacy `VITE_MNEMOS_ADAPTER`
 * knob keeps working (mock boxes stay mock) but is superseded by
 * `VITE_ADAPTER` when both are set.
 */
export type AdapterKind = "mock" | "mnemos" | "board";

export const MNEMOS_BASE_URL = import.meta.env.VITE_MNEMOS_API_URL ?? "/api";

/** Board merge-API base — same-origin "/api"; `VITE_BOARD_API_URL` overrides. */
export const BOARD_BASE_URL = import.meta.env.VITE_BOARD_API_URL ?? "/api";

/** Resolve the adapter kind from the new + legacy env knobs (pure, testable). */
export function resolveAdapterKind(
  adapter: string | undefined,
  legacy?: string | undefined,
): AdapterKind {
  if (adapter === "mock" || adapter === "mnemos" || adapter === "board") return adapter;
  if (adapter === undefined || adapter === "") {
    // Legacy knob honoured only in its mock flavour; legacy "http" (and any
    // unknown value) maps to the mnemos default.
    return legacy === "mock" ? "mock" : "mnemos";
  }
  return "mnemos";
}

export const ADAPTER: AdapterKind = resolveAdapterKind(
  import.meta.env.VITE_ADAPTER,
  import.meta.env.VITE_MNEMOS_ADAPTER,
);

/** Build the gateway for the selected adapter (pure selection + board purge). */
export function createGateway(): MemoryGateway {
  switch (ADAPTER) {
    case "mock":
      return new MockAdapter();
    case "board":
      // Security audit point Ф0 (ADR 0011 §7, security verdict §5.3): the
      // board mode must not carry mnemos credentials — purge any legacy
      // stored token once at bootstrap. BoardAdapter itself is token-free.
      clearToken();
      return new BoardAdapter(BOARD_BASE_URL);
    default:
      return new HttpAdapter(MNEMOS_BASE_URL);
  }
}

/** Human-facing backend label for the TopBar indicator. */
export function adapterEndpointLabel(): string {
  return ADAPTER === "board" ? BOARD_BASE_URL : MNEMOS_BASE_URL;
}

/**
 * Router mount path for the SPA (ADR 0011: the app lives at `/app`). Derived
 * from the Vite base so dev ("/") and production ("/app/") stay in sync with
 * a single knob; `undefined` lets React Router use its default root mount.
 */
export function routerBasename(baseUrl: string): string | undefined {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed === "" ? undefined : trimmed;
}
