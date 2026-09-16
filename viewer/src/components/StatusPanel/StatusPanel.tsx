import { StatusIndicator, type HealthState } from "@/components/StatusIndicator/StatusIndicator";
import {
  formatDuration,
  formatTimestamp,
  metricNumber,
} from "@/components/memory/memoryDisplay";
import type { HealthStatus, Metrics } from "@/gateway/types";

/**
 * Health indicators, counts and pipeline metrics in a scannable grid
 * (component-inventory §7). Honesty rules: anything the mnemos 4.1 payload
 * does not carry (latency, DLQ depth) is shown as "not reported", never as a
 * fabricated zero.
 */
export interface StatusPanelProps {
  health?: HealthStatus;
  metrics?: Metrics;
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-md border border-border-subtle bg-well p-6 shadow-well">
      <dt className="text-xs text-foreground-secondary">{label}</dt>
      <dd className="mt-2 text-lg font-semibold text-foreground">
        {value}
        {detail ? <span className="ml-2 text-xs font-normal text-foreground-muted">{detail}</span> : null}
      </dd>
    </div>
  );
}

const NOT_REPORTED = "not reported";

export function StatusPanel({ health, metrics }: StatusPanelProps) {
  const data = (metrics ?? {}) as Record<string, unknown>;
  const byStatus = (data.memories_by_status ?? {}) as Record<string, unknown>;
  const total = metricNumber(data, ["memories_total", "total_memories", "memories"]);
  const published = metricNumber(byStatus, ["published"]);
  const dlq = metricNumber(data, ["dlq_depth", "dead_letter_queue_depth", "dlq_size"]);
  const avgLatency = metricNumber(data, ["avg_latency_ms", "latency_ms", "avg_latency"]);
  const version = typeof health?.version === "string" ? health.version : undefined;

  return (
    <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <div className="rounded-md border border-border-subtle bg-well p-6 shadow-well">
        <dt className="text-xs text-foreground-secondary">API status</dt>
        <dd className="mt-2">
          <StatusIndicator status={healthState(health)} label={healthState(health)} />
          {version ? <span className="ml-2 text-xs text-foreground-muted">{version}</span> : null}
        </dd>
      </div>
      <Stat
        label="Memories"
        value={total === null ? NOT_REPORTED : String(total)}
        detail={published === null ? undefined : `${published} published`}
      />
      <Stat
        label="Avg search latency"
        value={avgLatency === null ? NOT_REPORTED : formatDuration(avgLatency)}
        detail={avgLatency === null ? "mnemos /metrics carries no latency" : undefined}
      />
      <Stat
        label="DLQ depth"
        value={dlq === null ? NOT_REPORTED : String(dlq)}
        detail={dlq === null ? "no dlq key in /metrics" : undefined}
      />
      <Stat
        label="Tags"
        value={metricNumber(data, ["tags_total", "tags"])?.toString() ?? NOT_REPORTED}
      />
      <Stat
        label="A2A sessions"
        value={metricNumber(data, ["sessions_total", "sessions"])?.toString() ?? NOT_REPORTED}
      />
      <Stat
        label="Pipeline traces"
        value={metricNumber(data, ["traces_total", "traces"])?.toString() ?? NOT_REPORTED}
      />
      <Stat
        label="Avg quality score"
        value={
          metricNumber(data, ["avg_quality_score"])?.toFixed(2) ?? NOT_REPORTED
        }
      />
      <Stat
        label="Metrics generated"
        value={formatTimestamp(typeof data.generated_at === "string" ? data.generated_at : undefined)}
      />
    </dl>
  );
}

function healthState(health: HealthStatus | undefined): HealthState {
  const status = health?.status?.toLowerCase();
  if (status === "ok") return "ok";
  if (!status) return "unknown";
  return "degraded";
}
