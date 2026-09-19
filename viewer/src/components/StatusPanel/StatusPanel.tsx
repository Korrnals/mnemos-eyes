import { useT, type TranslationKey } from "@/i18n";
import {
  StatusIndicator,
  type HealthState,
} from "@/components/StatusIndicator/StatusIndicator";
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
        {detail ? (
          <span className="ml-2 text-xs font-normal text-foreground-muted">
            {detail}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

const HEALTH_STATE_KEY: Record<HealthState, TranslationKey> = {
  ok: "status.healthOk",
  degraded: "status.healthDegraded",
  error: "status.healthError",
  unknown: "status.healthUnknown",
};

export function StatusPanel({ health, metrics }: StatusPanelProps) {
  const t = useT();
  const data = (metrics ?? {}) as Record<string, unknown>;
  const byStatus = (data.memories_by_status ?? {}) as Record<string, unknown>;
  const total = metricNumber(data, ["memories_total", "total_memories", "memories"]);
  const published = metricNumber(byStatus, ["published"]);
  const dlq = metricNumber(data, ["dlq_depth", "dead_letter_queue_depth", "dlq_size"]);
  const avgLatency = metricNumber(data, [
    "avg_latency_ms",
    "latency_ms",
    "avg_latency",
  ]);
  const version = typeof health?.version === "string" ? health.version : undefined;
  const state = healthState(health);

  return (
    <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <div className="rounded-md border border-border-subtle bg-well p-6 shadow-well">
        <dt className="text-xs text-foreground-secondary">{t("status.apiStatus")}</dt>
        <dd className="mt-2">
          <StatusIndicator status={state} label={t(HEALTH_STATE_KEY[state])} />
          {version ? (
            <span className="ml-2 text-xs text-foreground-muted">{version}</span>
          ) : null}
        </dd>
      </div>
      <Stat
        label={t("status.memoriesStat")}
        value={total === null ? t("status.notReported") : String(total)}
        detail={
          published === null
            ? undefined
            : t("status.publishedDetail", { count: published })
        }
      />
      <Stat
        label={t("status.avgLatency")}
        value={
          avgLatency === null ? t("status.notReported") : formatDuration(avgLatency)
        }
        detail={avgLatency === null ? t("status.avgLatencyNotReported") : undefined}
      />
      <Stat
        label={t("status.dlq")}
        value={dlq === null ? t("status.notReported") : String(dlq)}
        detail={dlq === null ? t("status.dlqNotReported") : undefined}
      />
      <Stat
        label={t("status.tagsStat")}
        value={
          metricNumber(data, ["tags_total", "tags"])?.toString() ??
          t("status.notReported")
        }
      />
      <Stat
        label={t("status.sessionsStat")}
        value={
          metricNumber(data, ["sessions_total", "sessions"])?.toString() ??
          t("status.notReported")
        }
      />
      <Stat
        label={t("status.tracesStat")}
        value={
          metricNumber(data, ["traces_total", "traces"])?.toString() ??
          t("status.notReported")
        }
      />
      <Stat
        label={t("status.avgQuality")}
        value={
          metricNumber(data, ["avg_quality_score"])?.toFixed(2) ??
          t("status.notReported")
        }
      />
      <Stat
        label={t("status.generated")}
        value={formatTimestamp(
          typeof data.generated_at === "string" ? data.generated_at : undefined,
        )}
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
