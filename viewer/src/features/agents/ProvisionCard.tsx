import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Eye, EyeOff, RotateCcw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ExecutorItem } from "@/gateway/boardTypes";
import { useT } from "@/i18n";
import { formatTaskDate } from "@/features/tasks/taskStatus";
import { useI18n } from "@/i18n";
import { HarnessSelect } from "./HarnessSelect";
import { useDefaultHarness } from "./useHarnesses";
import { rememberProvisionApprove } from "./provisionContext";
import {
  PROVISION_CONNECTIVITY_INTERIM,
  isProvisionLive,
  isTofuPin,
  parseSteps,
  provisionErrorHint,
  provisionFunnel,
} from "./provisionTypes";
import type { ProvisionJobView } from "./provisionTypes";
import {
  useActiveProvisionJob,
  useProvisionActions,
  useProvisionJob,
} from "./useProvision";
import type { ActiveProvisionJob } from "./useProvision";
import { useExecutors } from "./useAgents";
import { PasteBackApprove } from "./ProvisionApprove";

/**
 * The CONNECT CARD (AGW-11, wave 4; design §A/§D) — the registry's
 * expansion entry point: «карточка = хост/агент/SSH», the board walks the
 * machine to a pending registry row by itself (zero console, zero yaml
 * for the owner). Two modes, ONE component:
 *
 * - FORM (no active job): host/port/name + the auth leg (key default,
 *   alias, password behind an EXPLICIT choice — the board keeps password
 *   auth off by default; a 422 lands verbatim from the server), harness
 *   hint, the board address the TARGET resolves. Secrets are masked,
 *   autocomplete=off, live in React state until the single POST fires
 *   and never touch a log line.
 * - FEED (active job): the install funnel (data-driven stage table) +
 *   the step log + the typed-hint failure block + the done state with
 *   the paste-back approve. Every state is VISIBLE — no silent spinner
 *   («тихий отказ» запрещён, Архком-8 §4); the interim transport leg is
 *   honestly labeled «временно: ручной туннель» with the reserved
 *   «профиль связности» slot (§5 — Ф2mesh lands as data, not a redesign).
 *
 * The feed rides the invalidation-only SSE bridge (provisioning.* → the
 * job query) plus a slow poll while live (the stream is at-most-once).
 */
export function ProvisionCard() {
  const { active, attach, detach } = useActiveProvisionJob();
  // A retry seeds the form with the failed job's facts (fresh mint unless
  // the token is still live — the design's reuse rule).
  const [retrySeed, setRetrySeed] = useState<ProvisionFormSeed | null>(null);

  if (active !== null) {
    return (
      <ProvisionFeed
        job={active}
        onClose={detach}
        onRetry={(seed) => {
          detach();
          setRetrySeed(seed);
        }}
      />
    );
  }
  return (
    <ProvisionForm
      key={retrySeed?.key ?? "fresh"}
      seed={retrySeed}
      onStart={attach}
    />
  );
}

// ---------------------------------------------------------------------- form

/** Prefill facts carried from a failed job into the retry form. */
export interface ProvisionFormSeed {
  /** Remount key — a retry always renders a FRESH form. */
  readonly key: string;
  readonly host: string;
  readonly port: string;
  readonly name: string;
  readonly harness: string;
  readonly boardUrl: string;
  /** The failed job's enrollment id when its token is STILL live. */
  readonly reuseEnrollmentId: string | null;
}

/** Client mirrors of the server's charset gates (feedback, not enforcement). */
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const BOARD_URL_RE = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

type AuthKind = "key" | "alias" | "password";

function ProvisionForm({
  seed,
  onStart,
}: {
  seed: ProvisionFormSeed | null;
  onStart: (job: ActiveProvisionJob) => void;
}) {
  const t = useT();
  const actions = useProvisionActions();
  const defaultHarness = useDefaultHarness();
  const [host, setHost] = useState(seed?.host ?? "");
  const [port, setPort] = useState(seed?.port ?? "22");
  const [name, setName] = useState(seed?.name ?? "");
  const [authKind, setAuthKind] = useState<AuthKind>("key");
  const [secret, setSecret] = useState("");
  const [secretMasked, setSecretMasked] = useState(true);
  const [passphrase, setPassphrase] = useState("");
  const [harnessChoice, setHarnessChoice] = useState(seed?.harness ?? "");
  const harness = harnessChoice || seed?.harness || defaultHarness;
  const [boardUrl, setBoardUrl] = useState(
    seed?.boardUrl ?? window.location.origin,
  );
  const [submitting, setSubmitting] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);

  const hostClean = host.trim().toLowerCase();
  const portClean = port.trim();
  const nameClean = name.trim();
  const urlClean = boardUrl.trim().replace(/\/+$/, "");
  const portNum = Number.parseInt(portClean, 10);

  const error = (key: string): boolean => validation === key;

  const validate = (): string | null => {
    if (!HOST_RE.test(hostClean)) return "host";
    if (
      portClean !== "" &&
      (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535)
    ) {
      return "port";
    }
    if (nameClean !== "" && !NAME_RE.test(nameClean)) return "name";
    if (authKind !== "alias" && secret.trim() === "") return "secret";
    if (!BOARD_URL_RE.test(urlClean)) return "boardUrl";
    return null;
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (submitting) return;
    const failure = validate();
    setValidation(failure);
    if (failure !== null) return;
    setSubmitting(true);
    actions.submitProvision(
      {
        host: hostClean,
        ...(portClean !== "" && portClean !== "22" ? { port: portNum } : {}),
        ...(nameClean !== "" ? { name: nameClean } : {}),
        auth: {
          kind: authKind,
          ...(authKind !== "alias" ? { secret } : {}),
          ...(authKind === "key" && passphrase !== "" ? { passphrase } : {}),
        },
        harness_hint: harness,
        board_url_for_host: urlClean,
        ...(seed?.reuseEnrollmentId
          ? { reuse_enrollment_id: seed.reuseEnrollmentId }
          : {}),
      },
      {
        onCreated: (created) =>
          onStart({
            job_id: created.job_id,
            host: hostClean,
            port: portClean === "" ? 22 : portNum,
          }),
        onSettled: () => setSubmitting(false),
      },
    );
  };

  const fieldClass =
    "h-9 w-full rounded-md border border-border bg-background px-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright";

  return (
    <section
      aria-label={t("agents.provision.title")}
      className="rounded-md border border-border-subtle bg-surface p-3 flex flex-col gap-3"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">{t("agents.provision.title")}</h2>
        <p className="text-xs text-foreground-muted">
          {t("agents.provision.subtitle")}
        </p>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        {/* host + port: the one mandatory pair */}
        <div className="flex flex-wrap gap-2">
          <label
            className={`flex min-w-56 flex-1 flex-col gap-1 text-sm font-medium ${
              error("host") ? "text-error" : ""
            }`}
          >
            {t("agents.provision.host")}
            <input
              value={host}
              onChange={(event) => setHost(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="vps-1.example"
              aria-invalid={error("host")}
              aria-describedby={error("host") ? "provision-host-error" : undefined}
              className={fieldClass}
            />
          </label>
          <label className="flex w-24 flex-col gap-1 text-sm font-medium">
            {t("agents.provision.port")}
            <input
              value={port}
              onChange={(event) => setPort(event.target.value)}
              inputMode="numeric"
              autoComplete="off"
              placeholder="22"
              aria-invalid={error("port")}
              className={fieldClass}
            />
          </label>
          <label
            className={`flex min-w-44 flex-1 flex-col gap-1 text-sm font-medium ${
              error("name") ? "text-error" : ""
            }`}
          >
            {t("agents.provision.name")}
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              autoComplete="off"
              placeholder={hostClean || "vps-1"}
              aria-invalid={error("name")}
              className={fieldClass}
            />
          </label>
        </div>
        {error("host") ? (
          <p id="provision-host-error" role="alert" className="text-xs text-error">
            {t("agents.provision.hostError")}
          </p>
        ) : null}
        {error("port") ? (
          <p role="alert" className="text-xs text-error">
            {t("agents.provision.portError")}
          </p>
        ) : null}
        {error("name") ? (
          <p role="alert" className="text-xs text-error">
            {t("agents.provision.nameError")}
          </p>
        ) : null}

        {/* the auth leg: key (default) | alias | password (explicit) */}
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">
            {t("agents.provision.authLegend")}
          </legend>
          <div className="flex flex-wrap gap-3" role="radiogroup" aria-label={t("agents.provision.authLegend")}>
            {(
              [
                { kind: "key", labelKey: "agents.provision.authKey" },
                { kind: "alias", labelKey: "agents.provision.authAlias" },
                { kind: "password", labelKey: "agents.provision.authPassword" },
              ] as const
            ).map((option) => (
              <label
                key={option.kind}
                className="flex cursor-pointer items-center gap-1.5 text-sm"
              >
                <input
                  type="radio"
                  name="provision-auth"
                  value={option.kind}
                  checked={authKind === option.kind}
                  onChange={() => setAuthKind(option.kind)}
                  className="accent-iris-bright"
                />
                {t(option.labelKey)}
              </label>
            ))}
          </div>
          {authKind === "password" ? (
            <p className="text-xs text-foreground-muted">
              {t("agents.provision.authPasswordNote")}
            </p>
          ) : null}
          {authKind === "alias" ? (
            <p className="text-xs text-foreground-muted">
              {t("agents.provision.authAliasNote")}
            </p>
          ) : null}
          {authKind !== "alias" ? (
            <div className="flex flex-col gap-1">
              <label
                className={`text-sm font-medium ${error("secret") ? "text-error" : ""}`}
              >
                {authKind === "key"
                  ? t("agents.provision.keySecret")
                  : t("agents.provision.passwordSecret")}
                {authKind === "key" ? (
                  <textarea
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                    rows={4}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={error("secret")}
                    aria-describedby="provision-secret-note"
                    className={`mt-1 w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright ${
                      secretMasked ? "blur-[3px]" : ""
                    }`}
                  />
                ) : (
                  <input
                    type="password"
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                    autoComplete="off"
                    aria-invalid={error("secret")}
                    aria-describedby="provision-secret-note"
                    className={`mt-1 ${fieldClass}`}
                  />
                )}
              </label>
              {authKind === "key" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 self-start px-1.5 text-xs"
                  aria-pressed={!secretMasked}
                  onClick={() => setSecretMasked((value) => !value)}
                >
                  {secretMasked ? (
                    <Eye className="size-3" aria-hidden="true" />
                  ) : (
                    <EyeOff className="size-3" aria-hidden="true" />
                  )}
                  {secretMasked
                    ? t("agents.provision.secretShow")
                    : t("agents.provision.secretHide")}
                </Button>
              ) : null}
              <p id="provision-secret-note" className="text-xs text-foreground-muted">
                {error("secret")
                  ? t("agents.provision.secretError")
                  : t("agents.provision.secretNote")}
              </p>
              {authKind === "key" ? (
                <label className="mt-1 flex flex-col gap-1 text-sm font-medium">
                  {t("agents.provision.passphrase")}
                  <input
                    type="password"
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                    autoComplete="off"
                    className={fieldClass}
                  />
                </label>
              ) : null}
            </div>
          ) : null}
        </fieldset>

        {/* harness + the board address the TARGET resolves */}
        <div className="flex flex-wrap gap-2">
          <label className="flex min-w-44 flex-1 flex-col gap-1 text-sm font-medium">
            {t("agents.provision.harness")}
            <HarnessSelect
              id="provision-harness"
              value={harness}
              onChange={setHarnessChoice}
            />
          </label>
          <label
            className={`flex min-w-56 flex-1 flex-col gap-1 text-sm font-medium ${
              error("boardUrl") ? "text-error" : ""
            }`}
          >
            {t("agents.provision.boardUrl")}
            <input
              value={boardUrl}
              onChange={(event) => setBoardUrl(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error("boardUrl")}
              aria-describedby="provision-url-note"
              className={fieldClass}
            />
          </label>
        </div>
        <p
          id="provision-url-note"
          className={`text-xs ${error("boardUrl") ? "text-error" : "text-foreground-muted"}`}
        >
          {error("boardUrl")
            ? t("agents.provision.boardUrlError")
            : t("agents.provision.boardUrlNote")}
        </p>

        <div className="flex items-center justify-end gap-2">
          {seed?.reuseEnrollmentId ? (
            <span className="mr-auto text-xs text-foreground-muted">
              {t("agents.provision.reuseNote")}
            </span>
          ) : null}
          <Button type="submit" size="sm" disabled={submitting}>
            {submitting
              ? t("agents.provision.submitting")
              : t("agents.provision.submit")}
          </Button>
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------- feed

function ProvisionFeed({
  job,
  onClose,
  onRetry,
}: {
  job: ActiveProvisionJob;
  onClose: () => void;
  onRetry: (seed: ProvisionFormSeed) => void;
}) {
  const t = useT();
  const { lang } = useI18n();
  const feed = useProvisionJob(job.job_id);
  const executors = useExecutors();
  const publishedRef = useRef(false);

  const status = feed.data;
  const funnel = useMemo(
    () =>
      status
        ? provisionFunnel({
            state: status.job.state,
            host_key_fingerprint: status.job.host_key_fingerprint,
            steps: parseSteps(status.job.steps),
          })
        : [],
    [status],
  );
  const view: ProvisionJobView | null = status
    ? {
        state: status.job.state,
        host_key_fingerprint: status.job.host_key_fingerprint,
        steps: parseSteps(status.job.steps),
      }
    : null;
  const tofu = view !== null && isTofuPin(view);
  const executorId = status?.enrollment.executor_id ?? "";

  // Publish the paste-back context ONCE per done verdict — the registry
  // sheet reads it when the owner opens the pending row's card.
  useEffect(() => {
    if (
      !publishedRef.current &&
      status?.job.state === "done" &&
      executorId !== "" &&
      status.job.host_key_fingerprint !== ""
    ) {
      publishedRef.current = true;
      rememberProvisionApprove(executorId, {
        fingerprint: status.job.host_key_fingerprint,
        tofu,
        jobId: status.job.id,
      });
    }
  }, [status, executorId, tofu]);

  const executor: ExecutorItem | null = executorId
    ? (executors.data?.items.find((row) => row.id === executorId) ?? null)
    : null;

  const stateKey =
    status?.job.state === "failed"
      ? "agents.provision.state.failed"
      : status?.job.state === "done"
        ? "agents.provision.state.done"
        : "agents.provision.state.live";

  const hint =
    status?.job.state === "failed"
      ? provisionErrorHint(status.job.error_code)
      : null;

  const retry = (): void => {
    if (!status) {
      onRetry({ key: `${job.job_id}-retry`, host: job.host, port: String(job.port), name: "", harness: "", boardUrl: "", reuseEnrollmentId: null });
      return;
    }
    onRetry({
      key: `${job.job_id}-retry`,
      host: status.job.host,
      port: String(status.job.port),
      name: "",
      harness: status.job.harness_hint,
      boardUrl: status.job.board_url_for_host,
      // Design §A: reuse the token only while it is GENUINELY live — the
      // wire state may still read "created" between the TTL passing and
      // the sweeper frame; the server would 422 the reuse (hash-only
      // storage makes a stale token unrevealable), so the TTL gates here.
      reuseEnrollmentId:
        status.enrollment.state === "created" &&
        Date.parse(status.enrollment.expires_at) > Date.now()
          ? status.job.enrollment_id
          : null,
    });
  };

  return (
    <section
      aria-label={t("agents.provision.feedTitle", { host: job.host })}
      className="rounded-md border border-border-subtle bg-surface p-3 flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">
          {t("agents.provision.feedTitle", { host: job.host })}
        </h2>
        <span className="font-mono text-xs text-foreground-muted">
          {job.host}:{job.port}
        </span>
        <Badge variant={status?.job.state === "failed" ? "error" : "outline"}>
          {t(stateKey)}
        </Badge>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-7 px-2 text-xs"
          onClick={onClose}
          aria-label={t("agents.provision.closeAria")}
        >
          <X className="size-3.5" aria-hidden="true" />
          {t("agents.provision.close")}
        </Button>
      </div>

      {/* Every state visible: loading has its label, live has the state
       * badge + funnel, failures carry the typed hint — no silent spin. */}
      <p aria-live="polite" className="text-xs text-foreground-secondary">
        {feed.isPending
          ? t("agents.provision.feedLoading")
          : feed.isError
            ? t("agents.provision.feedError", {
                message: feed.error instanceof Error ? feed.error.message : "",
              })
            : status && isProvisionLive(status.job.state)
              ? t("agents.provision.feedLive")
              : ""}
      </p>
      {feed.isError ? (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void feed.refetch()}
          >
            {t("common.retry")}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t("agents.provision.close")}
          </Button>
        </div>
      ) : null}

      {view !== null && status ? (
        <>
          {/* The funnel: data-driven stages; reserved rows render «позже». */}
          <ol className="flex flex-col gap-1" aria-label={t("agents.provision.funnelAria")}>
            {funnel.map((stage) => (
              <li
                key={stage.def.id}
                aria-current={stage.status === "current" ? "step" : undefined}
                className="flex items-center gap-2 text-sm"
              >
                {stage.status === "done" ? (
                  <Check className="size-3.5 shrink-0 text-iris-bright" aria-hidden="true" />
                ) : (
                  <span
                    className="size-3.5 shrink-0 rounded-full border border-border-strong"
                    aria-hidden="true"
                  />
                )}
                <span
                  className={
                    stage.status === "done"
                      ? "text-foreground-secondary"
                      : stage.status === "current"
                        ? "font-medium"
                        : "text-foreground-muted"
                  }
                >
                  {t(stage.def.labelKey)}
                </span>
                {stage.status === "current" && isProvisionLive(status.job.state) ? (
                  <span
                    className="inline-block size-3 animate-pulse rounded-full bg-iris-bright"
                    aria-hidden="true"
                  />
                ) : null}
                {stage.status === "reserved" ? (
                  <Badge variant="outline" className="font-normal">
                    {t("agents.provision.stage.reserved")}
                  </Badge>
                ) : null}
              </li>
            ))}
          </ol>

          {/* Interim honesty (§5): the transport leg is a manual tunnel
           * until Ф2mesh; the connectivity-profile slot stays reserved. */}
          <div className="rounded-md border border-border-subtle bg-well px-3 py-2">
            <p className="text-xs text-foreground-secondary">
              {t("agents.provision.connectivityTitle")}
              <Badge variant="outline" className="ml-2 font-normal">
                {PROVISION_CONNECTIVITY_INTERIM.kind === "manual-tunnel"
                  ? t("agents.provision.connectivityManual")
                  : t("agents.provision.connectivityMesh")}
              </Badge>
            </p>
            <p className="mt-1 text-xs text-foreground-muted">
              {t("agents.provision.connectivityProfile")}
              <span className="ml-1">
                {PROVISION_CONNECTIVITY_INTERIM.profile === null
                  ? t("agents.provision.connectivityLater")
                  : ""}
              </span>
            </p>
          </div>

          {/* The step log (server truth; masked server-side already). */}
          {view.steps.length > 0 ? (
            <div className="rounded-md border border-border-subtle">
              <p className="px-3 pt-2 text-xs font-medium text-foreground-secondary">
                {t("agents.provision.logTitle")}
              </p>
              <ul className="flex flex-col gap-0.5 px-3 pb-2 pt-1">
                {view.steps.map((step, index) => (
                  <li
                    key={index}
                    className="break-all font-mono text-xs text-foreground-secondary"
                  >
                    {step}
                  </li>
                ))}
              </ul>
              <p className="border-t border-border-subtle px-3 py-1.5 text-xs text-foreground-muted">
                {t("agents.provision.updatedAt", {
                  time: formatTaskDate(status.job.updated_at, lang),
                })}
              </p>
            </div>
          ) : null}

          {/* Failure: the typed hint table headline + the technical tail
           * (host_key_mismatch ALSO shows the expected fingerprint — the
           * one code where the raw value IS the helpful answer). */}
          {status.job.state === "failed" && hint ? (
            <div
              role="alert"
              className="rounded-md border border-error/40 bg-elevated p-3 flex flex-col gap-2"
            >
              <p className="text-sm font-medium">
                {t(hint.titleKey)}
              </p>
              <p className="text-xs text-foreground-muted">
                {t("agents.provision.errorCode", { code: status.job.error_code })}
              </p>
              {hint.showExpectedFingerprint &&
              status.job.host_key_fingerprint !== "" ? (
                <div className="rounded-md border border-border-subtle bg-background px-2 py-1.5">
                  <p className="text-xs text-foreground-secondary">
                    {t("agents.provision.expectedFingerprint")}
                  </p>
                  <p className="break-all font-mono text-xs">
                    {status.job.host_key_fingerprint}
                  </p>
                  <p className="mt-1 text-xs text-foreground-muted">
                    {t("agents.provision.knownHostsHint")}
                  </p>
                </div>
              ) : null}
              <div>
                <Button type="button" variant="outline" size="sm" onClick={retry}>
                  <RotateCcw className="size-3.5" aria-hidden="true" />
                  {t("agents.provision.retry")}
                </Button>
              </div>
            </div>
          ) : null}

          {/* Done: the pending row + the paste-back approve (or the plain
           * approve when the pin predates this job). */}
          {status.job.state === "done" ? (
            executor !== null ? (
              executor.state === "pending" ? (
                <div className="rounded-md border border-iris-bright/40 bg-elevated p-3 flex flex-col gap-2">
                  <p className="text-sm font-medium">
                    {t("agents.provision.doneTitle", { name: executor.name })}
                  </p>
                  <PasteBackApprove
                    executor={executor}
                    fingerprint={status.job.host_key_fingerprint}
                    tofu={tofu}
                  />
                </div>
              ) : (
                <p className="text-sm text-foreground-secondary">
                  {t("agents.provision.approvedAlready", { name: executor.name })}
                </p>
              )
            ) : (
              <p className="text-xs text-foreground-muted">
                {t("agents.provision.doneLoadingRow")}
              </p>
            )
          ) : null}
        </>
      ) : null}
    </section>
  );
}
