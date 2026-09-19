import type { MemoryGateway } from "./MemoryGateway";
import type { BoardHealthDetail, MemoryPulse, PulseParams } from "./boardTypes";

/**
 * Board-native read capabilities (ADR 0011 Ф1). The three adapters share the
 * `MemoryGateway` surface, but only the board and mock adapters speak the
 * merge-API extras; the mnemos HttpAdapter legitimately does not. Pages probe
 * the gateway through these structural guards instead of branching on the
 * adapter-mode string — an adapter that grows the method lights the section
 * up with no page change (capability, not configuration).
 */

/** Merged recency feed (`GET /api/memories/pulse`). */
export interface PulseSource {
  pulse(params?: PulseParams, signal?: AbortSignal): Promise<MemoryPulse>;
}

/** Per-store health detail (`GET /api/health`, nested view). */
export interface BoardHealthSource {
  boardHealth(signal?: AbortSignal): Promise<BoardHealthDetail>;
}

/** Gateway type that also speaks the pulse wire. */
export type PulseGateway = MemoryGateway & PulseSource;

/** Gateway type that also serves the per-store health view. */
export type BoardHealthGateway = MemoryGateway & BoardHealthSource;

export function isPulseSource(gateway: MemoryGateway): gateway is PulseGateway {
  return typeof (gateway as Partial<PulseSource>).pulse === "function";
}

export function isBoardHealthSource(
  gateway: MemoryGateway,
): gateway is BoardHealthGateway {
  return typeof (gateway as Partial<BoardHealthSource>).boardHealth === "function";
}
