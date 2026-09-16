import type { HealthStatus } from "@/gateway/types";
import type { HealthState } from "./StatusIndicator";

/**
 * Map a gateway health payload (+ query state) onto the four visual states of
 * StatusIndicator (component-inventory §7). The wire shape is a string-valued
 * map; anything other than a literal "ok" is reported honestly as degraded
 * rather than silently green.
 */
export function deriveHealthStatus(
  health: HealthStatus | undefined,
  isLoading: boolean,
  isError: boolean,
): HealthState {
  if (isError) return "error";
  if (isLoading || !health) return "unknown";
  const status = health.status?.toLowerCase();
  if (status === "ok") return "ok";
  if (status === "degraded") return "degraded";
  // A response that names any other status is alive but not clean.
  return "degraded";
}
