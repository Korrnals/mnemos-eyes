import type { HealthStatus } from "@/gateway/types";

/**
 * Ok / degraded / down dot + label.
 * TODO(T5): token-bound semantic colours, pulse on degraded, a11y live region.
 */
export interface StatusIndicatorProps {
  health?: HealthStatus;
  className?: string;
}

export function StatusIndicator({ health, className }: StatusIndicatorProps) {
  const status = health?.status ?? "unknown";
  return (
    <span className={className}>
      <span aria-hidden="true">●</span> <span className="sr-only">mnemos status: </span>
      {status}
    </span>
  );
}
