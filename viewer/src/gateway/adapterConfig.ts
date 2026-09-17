/**
 * Single source of truth for the gateway bootstrap knobs, read from the Vite
 * environment at module load. Shared by `main.tsx` (adapter construction) and
 * the auth UI (endpoint label in the TopBar connection indicator) so both
 * always describe the same backend.
 *
 * Defaults keep production on the HTTP adapter talking to same-origin "/api";
 * `.env.development` flips development boxes to the MockAdapter out of the box.
 */
export const MNEMOS_BASE_URL = import.meta.env.VITE_MNEMOS_API_URL ?? "/api";

export const MNEMOS_ADAPTER: "mock" | "http" =
  import.meta.env.VITE_MNEMOS_ADAPTER === "mock" ? "mock" : "http";

/** Human-facing backend label for the TopBar indicator. */
export function mnemosEndpointLabel(): string {
  return MNEMOS_BASE_URL;
}
