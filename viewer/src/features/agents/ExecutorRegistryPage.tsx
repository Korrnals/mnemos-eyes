import { Check, Power, ShieldOff, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { TableRowSkeleton } from "@/components/skeletons/Skeletons";
import type { ExecutorItem, ExecutorListMeta } from "@/gateway/boardTypes";
import { isAgentsSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import { useT } from "@/i18n";
import type { TranslationKey } from "@/i18n";
import { useValidationNow } from "@/features/tasks/useValidationClock";
import { AgentsUnsupported } from "./AgentsUnsupported";
import { ConnectGuide } from "./ConnectGuide";
import {
  PRESENCE_DOT,
  PRESENCE_TEXT,
  formatPulseAge,
  lastSeenAgeS,
  presenceFromLastSeen,
  presenceLabelKey,
} from "./presence";
import { orderRegistry } from "./registryOrder";
import type { RegistryBands } from "./registryOrder";
import { useExecutors } from "./useAgents";
import { useExecutorMutations } from "./useExecutorMutations";

/**
 * `/agents/harnesses` — «Подключение агентов» (AGW-4, spec §1 wave 2): the
 * executor registry with management, answering the owner's «где интерфейс
 * подключения внешних агентов?». The page renders THREE bands from
 * orderRegistry — the pending approval queue FIRST (the page's main
 * answer), then connected (enabled ahead of disabled), revoked last as
 * visibly dead-but-present rows; empty bands render nothing (§1.1 — no
 * counter furniture).
 *
 * Management goes through the gated write path (useExecutorMutations →
 * PATCH/DELETE /api/executors/{id}, ui-token; server error text lands in
 * toasts verbatim). Approve does NOT flip the routing flag — the toast
 * points at «Включить» (Amd 2 §4 honesty); revoke is the TERMINAL
 * kill-switch behind a confirm; delete is the HARD registry removal — the
 * confirm says the secret dies with the row, the name is freed and active
 * assignments keep their pins (two-clock rule).
 *
 * Identity (name/host/harness/version) is executor-claimed and
 * server-UNVERIFIED — every row wears the outline unverified chip (§2.2).
 * Presence reuses the strip's meta-TTL language (presence.ts) off the
 * shared 1 Hz ticker. Registration itself is machine-class API — the
 * ConnectGuide at the bottom is the honest «no button for that» answer.
 */
export function ExecutorRegistryPage() {
  const t = useT();
  const gateway = useGateway();
  const capable = isAgentsSource(gateway);
  const executors = useExecutors();
  const mutations = useExecutorMutations();

  if (!capable) {
    return <AgentsUnsupported />;
  }

  const items = executors.data?.items ?? [];
  const meta = executors.data?.meta;
  const bands: RegistryBands =
    executors.isPending || executors.isError
      ? { pending: [], active: [], revoked: [] }
      : orderRegistry(items);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-3">
      {/* The breadcrumb current item + TopBar already carry «Подключение» —
       * the h1 stays for the a11y outline only (no visible duplication). */}
      <h1 className="sr-only">{t("agents.registry.title")}</h1>

      {executors.isPending ? (
        <div role="status" aria-label={t("agents.registry.loading")}>
          <TableRowSkeleton rows={4} columns={3} />
        </div>
      ) : executors.isError ? (
        <EmptyState
          variant="error"
          title={t("agents.registry.failed")}
          message={executors.error.message}
          action={
            <Button variant="outline" onClick={() => void executors.refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState
          variant="empty"
          title={t("agents.strip.empty")}
          message={t("agents.registry.empty")}
        />
      ) : (
        <div className="space-y-3">
          {bands.pending.length > 0 ? (
            <Band labelKey="agents.registry.band.pending" count={bands.pending.length}>
              {bands.pending.map((executor) => (
                <ExecutorRow
                  key={executor.id}
                  executor={executor}
                  meta={meta}
                  mutations={mutations}
                />
              ))}
            </Band>
          ) : null}
          {bands.active.length > 0 ? (
            <Band labelKey="agents.registry.band.active" count={bands.active.length}>
              {bands.active.map((executor) => (
                <ExecutorRow
                  key={executor.id}
                  executor={executor}
                  meta={meta}
                  mutations={mutations}
                />
              ))}
            </Band>
          ) : null}
          {bands.revoked.length > 0 ? (
            <Band labelKey="agents.registry.band.revoked" count={bands.revoked.length}>
              {bands.revoked.map((executor) => (
                <ExecutorRow
                  key={executor.id}
                  executor={executor}
                  meta={meta}
                  mutations={mutations}
                />
              ))}
            </Band>
          ) : null}
        </div>
      )}

      {/* The connect path: five poller steps + the honest machine-class note.
       * Always available — it is the page's second answer. */}
      <ConnectGuide />
    </div>
  );
}

/** One labeled band of registry rows; zero-size bands render nothing. */
function Band({
  labelKey,
  count,
  children,
}: {
  labelKey: TranslationKey;
  count: number;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <section aria-label={t(labelKey)}>
      <p className="flex items-center gap-1.5 text-xs font-medium text-foreground-secondary">
        {t(labelKey)}
        <span className="font-mono text-foreground-muted">{count}</span>
      </p>
      <ul className="mt-1 space-y-1.5">{children}</ul>
    </section>
  );
}

/** One dense registry row: presence · identity (unverified) · declared
 * meta · capabilities as chips · the state-appropriate owner actions. */
function ExecutorRow({
  executor,
  meta,
  mutations,
}: {
  executor: ExecutorItem;
  meta: ExecutorListMeta | undefined;
  mutations: ReturnType<typeof useExecutorMutations>;
}) {
  const t = useT();
  const now = useValidationNow();
  const revoked = executor.state === "revoked";
  const pending = executor.state === "pending";
  // Presence reuses the strip's exact meta-TTL language (§2.1/§5.1) —
  // pending rows may tick, revoked ones decay to offline honestly.
  const presence = presenceFromLastSeen(executor.last_seen, meta, now);
  const ageS = lastSeenAgeS(executor.last_seen, now);
  const presenceKey = presence ?? "unknown";
  const pulseAge =
    ageS !== null && presence !== null
      ? formatPulseAge(ageS, {
          minutes: t("agents.age.unitMinutes"),
          hours: t("agents.age.unitHours"),
          days: t("agents.age.unitDays"),
        })
      : "";
  const transport =
    executor.transport === "mesh-r4"
      ? t("agents.strip.transportMesh")
      : t("agents.strip.transportLocal");

  const ghostButton =
    "h-7 px-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright";

  return (
    <li
      className={
        "rounded-md border bg-well px-2.5 py-1.5 text-sm shadow-well transition-colors duration-instant " +
        (revoked
          ? // Dead identity: muted as a whole, no hover invitation.
            "border-border-subtle text-foreground-muted"
          : "border-border-subtle hover:border-iris-bright/40")
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {/* Presence dot: colour + shape, SR label carries the verdict. */}
        <span aria-hidden="true" className="flex items-center">
          <span
            className={
              "size-2 shrink-0 rounded-full " +
              (PRESENCE_DOT[presenceKey] ?? PRESENCE_DOT.unknown)
            }
          />
          <span className="sr-only">{t(presenceLabelKey(presenceKey))}</span>
        </span>
        <span className="truncate font-medium">{executor.name}</span>
        {/* Declared identity is UNVERIFIED (§2.2): outline chip, neutral tone. */}
        <Badge
          variant="outline"
          title={t("agents.identity.tooltip")}
          className="font-normal"
        >
          {t("agents.registry.unverifiedChip")}
        </Badge>
        {pending ? (
          <Badge variant="outline" className="font-normal">
            {t("agents.executor.pendingReason")}
          </Badge>
        ) : null}
        {executor.state === "approved" && !executor.enabled ? (
          <Badge variant="outline" title={t("agents.executor.disabledReason")} className="font-normal">
            {t("agents.executor.disabledReason")}
          </Badge>
        ) : null}
        {revoked ? (
          <Badge variant="outline" title={t("agents.registry.revokedHint")} className="font-normal">
            {t("agents.executor.revokedReason")}
          </Badge>
        ) : null}

        <span className="ml-auto flex items-center gap-1.5">
          {pending ? (
            <Button
              size="sm"
              className={ghostButton}
              onClick={() => mutations.approveExecutor(executor)}
            >
              <Check className="size-3.5" aria-hidden="true" />
              {t("agents.registry.approve")}
            </Button>
          ) : null}
          {!pending && !revoked ? (
            <Button
              variant="ghost"
              size="sm"
              className={ghostButton}
              onClick={() => mutations.setExecutorEnabled(executor, !executor.enabled)}
            >
              <Power className="size-3.5" aria-hidden="true" />
              {executor.enabled
                ? t("agents.registry.disable")
                : t("agents.registry.enable")}
            </Button>
          ) : null}
          {!pending && !revoked ? (
            <Button
              variant="ghost"
              size="sm"
              className={ghostButton + " text-error"}
              onClick={() => mutations.revokeExecutor(executor)}
            >
              <ShieldOff className="size-3.5" aria-hidden="true" />
              {t("agents.registry.revoke")}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className={ghostButton}
            onClick={() => mutations.removeExecutor(executor)}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            {t("agents.registry.remove")}
          </Button>
        </span>
      </div>

      {/* Declared meta, mono (dense §1): harness · transport · version ·
       * host · last seen. On revoked rows the hint names the terminal
       * state instead of pretending a toggle exists. */}
      <p
        className={
          "mt-0.5 font-mono text-xs " +
          (PRESENCE_TEXT[presenceKey] ?? PRESENCE_TEXT.unknown)
        }
      >
        {executor.harness} · {transport}
        {executor.version ? ` · v${executor.version}` : ""}
        {executor.host ? ` · ${t("agents.registry.hostLabel")}: ${executor.host}` : ""} ·{" "}
        {t("agents.strip.lastSeen")}: {pulseAge || t("agents.executor.neverSeen")}
        {revoked ? ` · ${t("agents.registry.revokedHint")}` : ""}
      </p>

      {/* Capabilities as STRUCTURE (§4.3): one chip per allowlist mapping —
       * never a comma-joined free-text blob. */}
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <span className="text-xs text-foreground-muted">
          {t("agents.registry.capabilitiesLabel")}:
        </span>
        {executor.capabilities.length > 0 ? (
          executor.capabilities.map((capability) => (
            <span
              key={capability}
              className="rounded-sm border border-border-subtle px-1 py-0.5 font-mono text-xs text-foreground-secondary"
            >
              {capability}
            </span>
          ))
        ) : (
          <span className="text-xs text-foreground-muted">
            {t("agents.executor.noCapabilities")}
          </span>
        )}
      </div>
    </li>
  );
}
