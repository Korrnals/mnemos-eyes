import { useLocation, useSearchParams } from "react-router";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { Button } from "@/components/ui/button";
import { isPulseSource } from "@/gateway/capabilities";
import { usePulse } from "@/hooks/usePulse";
import { useGateway } from "@/gateway/GatewayContext";
import { useT } from "@/i18n";
import { PulseFeed, PulseSkeleton } from "./PulseFeed";

/**
 * `/memory/pulse` — the live memory pulse (redesign concept §2.1 / §4.2:
 * the rail-pulse pattern promoted to a page). One merged recency feed with
 * per-server provenance badges; the scope lives in the `?scope=` URL param
 * (`all` | one store name — names come from the feed's own per-server
 * report). Honest matrix: loading skeleton, error + retry (404 = unknown
 * scope with the server's own words), empty feed, degraded stores note.
 */
export function PulsePage() {
  const t = useT();
  const gateway = useGateway();
  const capable = isPulseSource(gateway);
  const [searchParams, setSearchParams] = useSearchParams();
  // UI-18 pair 10: the pulse URL (?scope= included) rides as `return=` on
  // every row link so the memory detail's back control leads back here.
  const location = useLocation();
  const scope = searchParams.get("scope") ?? "all";
  const pulse = usePulse({ scope, limit: 20 });

  if (!capable) {
    return <PulseUnsupported />;
  }

  // Scope options: "all" + the store names the feed itself reports.
  const scopes = [
    "all",
    ...new Set((pulse.data?.per_server ?? []).map((p) => p.server)),
  ];
  const setScope = (next: string) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next === "all") params.delete("scope");
        else params.set("scope", next);
        return params;
      },
      { replace: false },
    );
  };

  return (
    <section aria-labelledby="pulse-title" className="mx-auto max-w-3xl space-y-4">
      <h1 id="pulse-title" className="text-xl font-semibold">
        {t("pulse.title")}
      </h1>

      {/* Scope switcher (URL state — QA verdict §3: list state lives in URL). */}
      <div
        role="group"
        aria-label={t("pulse.scopeLabel")}
        className="flex flex-wrap gap-2"
      >
        {scopes.map((name) => (
          <Button
            key={name}
            variant={name === scope ? "default" : "outline"}
            size="sm"
            aria-pressed={name === scope}
            onClick={() => setScope(name)}
          >
            {name === "all" ? t("pulse.scopeAll") : name}
          </Button>
        ))}
      </div>

      {pulse.isPending ? (
        <div role="status" aria-label={t("pulse.loading")}>
          <PulseSkeleton />
        </div>
      ) : pulse.isError ? (
        <EmptyState
          variant="error"
          title={t("pulse.loadFailed")}
          message={pulse.error.message}
          action={
            <Button variant="outline" onClick={() => void pulse.refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : (pulse.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          variant="empty"
          title={t("pulse.emptyTitle")}
          message={t("pulse.emptyMessage")}
        />
      ) : (
        <PulseFeed
          items={pulse.data.items}
          perServer={pulse.data.per_server}
          returnSource={{ pathname: location.pathname, search: location.search }}
        />
      )}
    </section>
  );
}

/** Mnemos-mode honest state: the pulse is a merge-API view, not a mnemos one. */
function PulseUnsupported() {
  const t = useT();
  return (
    <section aria-labelledby="pulse-title" className="mx-auto max-w-3xl space-y-4">
      <h1 id="pulse-title" className="text-xl font-semibold">
        {t("pulse.title")}
      </h1>
      <EmptyState
        variant="empty"
        title={t("pulse.unavailableTitle")}
        message={t("pulse.unavailableMessage")}
      />
    </section>
  );
}
