import { cn } from "@/lib/utils";

/**
 * Reusable semantic dot + label (component-inventory §7). Token-bound colours;
 * the dot is decorative (the visible label carries the meaning) and the whole
 * indicator is a polite live region so status flips are announced.
 */
export type HealthState = "ok" | "degraded" | "error" | "unknown";

export interface StatusIndicatorProps {
  status: HealthState;
  /** Visible label; defaults to the status word. */
  label?: string;
  className?: string;
}

const DOT_CLASS: Record<HealthState, string> = {
  ok: "bg-success",
  degraded: "bg-warning",
  error: "bg-error",
  unknown: "bg-foreground-muted",
};

export function StatusIndicator({ status, label, className }: StatusIndicatorProps) {
  return (
    <span role="status" className={cn("inline-flex items-center gap-2", className)}>
      <span
        aria-hidden="true"
        className={cn("inline-block size-2 rounded-full", DOT_CLASS[status])}
      />
      <span className="sr-only">mnemos status: </span>
      {label ?? status}
    </span>
  );
}
