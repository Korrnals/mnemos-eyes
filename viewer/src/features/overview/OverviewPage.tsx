import { Link } from "react-router";
import { ArrowRight, Search, Files, Tag } from "lucide-react";
import { IrisLogo } from "@/components/IrisLogo/IrisLogo";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { isBoardHealthSource, isPulseSource } from "@/gateway/capabilities";
import type { BoardHealthServer } from "@/gateway/boardTypes";
import { useGateway } from "@/gateway/GatewayContext";
import { usePulse, useBoardHealth } from "@/hooks/usePulse";
import { PulseFeed } from "@/features/memory-pulse/PulseFeed";
import { useSessionControl } from "@/features/ui-token/useSessionControl";
import { useT } from "@/i18n";

/**
 * `/` — «Обзор» (redesign concept §2.4): the well hero + the honest Ф1 cut of
 * the domain summary. Anti-dashification rules apply: no counters for the
 * sake of counters, and a block with nothing to say does not render —
 * store/pulse sections appear only when the gateway speaks those views
 * (board / mock adapters) and only when they have content. The session-aware
 * mode line states the app's current contract plainly (read-only / active).
 */
export function OverviewPage() {
  const t = useT();
  const gateway = useGateway();
  const sessionControl = useSessionControl();
  const pulseCapable = isPulseSource(gateway);
  const healthCapable = isBoardHealthSource(gateway);
  // Top of the recency feed — the "what just happened" strip (limit 5).
  const pulse = usePulse({ scope: "all", limit: 5 });
  const health = useBoardHealth();

  const showStores =
    healthCapable && !(health.isSuccess && health.data.servers.length === 0);
  const showPulse = pulseCapable && !(pulse.isSuccess && pulse.data.items.length === 0);

  return (
    <section aria-labelledby="overview-title" className="mx-auto max-w-4xl space-y-8">
      <h1 id="overview-title" className="sr-only">
        {t("overview.title")}
      </h1>

      {/* The well: signature moment — one breathing iris, nothing else moves. */}
      <div className="flex flex-col items-center gap-4 pt-8 text-center">
        <IrisLogo size={120} glow breathing />
        <p className="text-xl text-foreground-secondary">{t("overview.tagline")}</p>
        <p className="text-xs text-foreground-muted">{t("overview.searchHint")}</p>
      </div>

      {/* Quick links — the three daily entrances of the memory domain. */}
      <nav aria-label={t("overview.quickLinks")} className="grid gap-4 sm:grid-cols-3">
        <QuickLink
          to="/memory/search"
          icon={<Search className="size-5" aria-hidden="true" />}
          label={t("nav.search")}
          hint={t("overview.searchHintLink")}
        />
        <QuickLink
          to="/memory"
          icon={<Files className="size-5" aria-hidden="true" />}
          label={t("nav.records")}
          hint={t("overview.recordsHintLink")}
        />
        <QuickLink
          to="/memory/tags"
          icon={<Tag className="size-5" aria-hidden="true" />}
          label={t("nav.tags")}
          hint={t("overview.tagsHintLink")}
        />
      </nav>

      {showStores ? (
        <section aria-labelledby="overview-stores" className="space-y-3">
          <h2 id="overview-stores" className="text-lg font-semibold text-foreground">
            {t("overview.storesTitle")}
          </h2>
          {health.isPending ? (
            <div role="status" aria-label={t("overview.storesLoading")}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            </div>
          ) : health.isError ? (
            <p role="status" className="text-sm text-foreground-secondary">
              {t("overview.storesError", { message: health.error.message })}
            </p>
          ) : (
            <ul className="grid gap-list-gap sm:grid-cols-2">
              {health.data.servers.map((server) => (
                <li key={server.name}>
                  <StoreCard server={server} />
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {showPulse ? (
        <section aria-labelledby="overview-pulse" className="space-y-3">
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="overview-pulse" className="text-lg font-semibold text-foreground">
              {t("overview.pulseTitle")}
            </h2>
            <Link
              to="/memory/pulse"
              className="inline-flex min-h-6 items-center gap-1 text-sm text-iris-bright hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
            >
              {t("overview.pulseAll")}{" "}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
          {pulse.isPending ? (
            <div
              role="status"
              aria-label={t("pulse.loading")}
              className="text-sm text-foreground-secondary"
            >
              {t("pulse.loading")}…
            </div>
          ) : pulse.isError ? (
            <p role="status" className="text-sm text-foreground-secondary">
              {t("overview.pulseError", { message: pulse.error.message })}
            </p>
          ) : (
            <PulseFeed
              items={pulse.data.items}
              perServer={pulse.data.per_server}
              compact
            />
          )}
        </section>
      ) : null}

      {/* Session-aware mode line (fix/login-feedback) — same derivation as
       * the sidebar footer: states the live contract instead of the static
       * L1 read-only claim that kept lying after a login. */}
      <p className="text-center text-xs text-foreground-muted">
        {t(sessionControl ? "nav.modeActive" : "nav.modeReadOnly")}
      </p>
    </section>
  );
}

function QuickLink({
  to,
  icon,
  label,
  hint,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  hint: string;
}) {
  return (
    <Link
      to={to}
      className="group flex min-h-row-airy flex-col justify-center gap-1 rounded-md border border-border-subtle bg-well p-4 shadow-well transition-colors duration-instant hover:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
    >
      <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
        {icon}
        {label}
      </span>
      <span className="text-xs text-foreground-secondary">{hint}</span>
    </Link>
  );
}

/**
 * One store health card — the ui-contract §7 dot rule: green only for a
 * healthy probe, never for "merely slow"; a failed probe shows its reason;
 * a disabled store says so in words (colour never carries the meaning
 * alone — WCAG 1.4.1).
 */
function StoreCard({ server }: { server: BoardHealthServer }) {
  const t = useT();
  const disabled = server.enabled === false;
  return (
    <Card>
      <CardHeader className="gap-1">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-mono text-sm font-semibold">{server.name}</h3>
          {disabled ? (
            <Badge variant="outline">{t("overview.storeDisabled")}</Badge>
          ) : server.ok ? (
            <Badge variant="success">{t("overview.storeOk")}</Badge>
          ) : (
            <Badge variant="error">{t("overview.storeFail")}</Badge>
          )}
        </div>
        <p className="text-xs text-foreground-secondary">
          {server.group_name} ·{" "}
          {t("overview.storeMemories", { count: server.memories_total ?? 0 })}
        </p>
      </CardHeader>
      <CardContent>
        {disabled ? (
          <p className="text-xs text-foreground-muted">
            {t("overview.storeDisabledNote")}
          </p>
        ) : server.ok ? (
          <p className="font-mono text-xs text-foreground-secondary">
            {t("overview.storeLatency", { ms: server.latency_ms ?? 0 })}
          </p>
        ) : (
          <p className="text-xs text-error">
            {server.error ?? t("overview.storeFail")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
