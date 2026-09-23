import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  EnrollmentCreatedResult,
  EnrollmentItem,
  ExecutorItem,
} from "@/gateway/boardTypes";
import { useT } from "@/i18n";
import type { TranslationKey } from "@/i18n";
import { useValidationNow } from "@/features/tasks/useValidationClock";
import {
  buildBootstrapScript,
  buildBootstrapSteps,
  effectiveEnrollmentState,
  formatTtlCountdown,
  maskEnrollmentToken,
} from "./enrollment";
import { useEnrollmentActions, useHonestCopy } from "./useEnrollment";
import { HarnessSelect } from "./HarnessSelect";
import { useDefaultHarness } from "./useHarnesses";

/**
 * «Добавить исполнителя» — the enrollment dialog (AGW-5 phase 2, design
 * §Фазы.2). Two phases in ONE dialog (the AssignExecutorSheet pattern):
 *
 * 1. FORM — label (≤64), harness_hint (the LIVE dictionary combobox with
 *    free entry — wave 3C; the server 422s unknown values with the
 *    authoritative list), name_hint (optional, ≤120).
 * 2. TOKEN SCREEN — the mne_… token MASKED on screen (AGW-11: the full
 *    plaintext exists only on the clipboard via «Копировать»), the LIVE
 *    TTL countdown (mm:ss off the shared 1 Hz ticker), the live-token
 *    ≤3 counter on the form, and the VPS bootstrap block — the commands
 *    are a copy-paste projection of deploy/poller/REMOTE-EXECUTOR.md
 *    §4б/§4в (the runbook is the source of truth; this screen never
 *    invents a second one); the one-command grows --expect-fp as soon as
 *    the board's mint answer carries the CA fingerprint (AGW-9).
 *
 * The dialog owns NO enrollment state after close: the panel below the
 * registry (fed by the invalidated list query + enrollment.* SSE) is the
 * persistent status surface. Radix owns the focus trap / Esc / restore.
 */
export function EnrollmentDialog({
  open,
  onOpenChange,
  executors,
  liveCount,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The registry — a used token links to its minted pending row. */
  executors: readonly ExecutorItem[];
  /**
   * AGW-11: live (created) token count for the ≤3 pre-flight (the server
   * 409s at the cap — the counter is UX parity, not enforcement). Absent
   * = the caller has no list yet (the counter hides, the server still
   * guards).
   */
  liveCount?: number;
}) {
  const t = useT();
  // Keyed inner component (EditTaskDialog pattern): a fresh form per open,
  // and a re-open after the token screen never shows a stale token.
  const [formKey, setFormKey] = useState(0);
  const [created, setCreated] = useState<EnrollmentCreatedResult | null>(null);

  const close = (): void => {
    onOpenChange(false);
    setCreated(null);
    setFormKey((value) => value + 1);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogTitle>{t("agents.enrollment.title")}</DialogTitle>
        {created ? (
          <TokenScreen created={created} executors={executors} onDone={close} />
        ) : (
          <EnrollmentForm
            key={formKey}
            onCreated={setCreated}
            onDone={close}
            liveCount={liveCount}
          />
        )}
        {/* The description stays stable across phases (Radix wants one). */}
        <DialogDescription className="sr-only">
          {t("agents.enrollment.description")}
        </DialogDescription>
      </DialogContent>
    </Dialog>
  );
}

/** Phase 1 — the mint form. */
function EnrollmentForm({
  onCreated,
  onDone,
  liveCount,
}: {
  onCreated: (created: EnrollmentCreatedResult) => void;
  onDone: () => void;
  liveCount?: number;
}) {
  const t = useT();
  const actions = useEnrollmentActions();
  const [label, setLabel] = useState("");
  // Wave 3C review: the default is the first entry of the LIVE dictionary.
  const defaultHarness = useDefaultHarness();
  const [harnessChoice, setHarnessChoice] = useState<string>("");
  const harness = harnessChoice || defaultHarness;
  const [nameHint, setNameHint] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // AGW-11: the ≤3 live-token pre-flight (ENROLLMENT_MAX_LIVE parity).
  const quotaReached = liveCount !== undefined && liveCount >= 3;

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    actions.createEnrollment(
      {
        ...(label.trim() ? { label: label.trim() } : {}),
        harness_hint: harness,
        ...(nameHint.trim() ? { name_hint: nameHint.trim() } : {}),
      },
      { onCreated, onSettled: () => setSubmitting(false) },
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <DialogDescription>{t("agents.enrollment.formHint")}</DialogDescription>
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t("agents.enrollment.label")}
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={64}
          placeholder={t("agents.enrollment.labelPlaceholder")}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t("agents.enrollment.harness")}
        <HarnessSelect
          id="enroll-harness"
          value={harness}
          onChange={setHarnessChoice}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t("agents.enrollment.nameHint")}
        <input
          value={nameHint}
          onChange={(event) => setNameHint(event.target.value)}
          maxLength={120}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
        />
      </label>
      <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
        {liveCount !== undefined ? (
          <span
            className={`mr-auto text-xs ${quotaReached ? "text-error" : "text-foreground-muted"}`}
            aria-live="polite"
          >
            {quotaReached
              ? t("agents.enrollment.quotaFull")
              : t("agents.enrollment.quotaCount", { count: liveCount })}
          </span>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          {t("agents.sheet.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={submitting || quotaReached}>
          {submitting ? t("agents.enrollment.creating") : t("agents.enrollment.create")}
        </Button>
      </div>
    </form>
  );
}

/** Phase 2 — the once-only token, the live TTL and the VPS bootstrap block. */
function TokenScreen({
  created,
  executors,
  onDone,
}: {
  created: EnrollmentCreatedResult;
  executors: readonly ExecutorItem[];
  onDone: () => void;
}) {
  const t = useT();
  const now = useValidationNow();
  // The bootstrap command shows the minted hint or the first LIVE
  // dictionary entry (wave 3C review — no hardcoded harness constant).
  const defaultHarness = useDefaultHarness();
  // Review P2-2: flash ONLY on a resolved write — clipboard absent or a
  // rejection is a visible failure (the token is shown once; a lying
  // «Скопировано» quietly loses it).
  const { copied, failed, copy } = useHonestCopy();
  const row: EnrollmentItem = created.enrollment;

  const ttl = formatTtlCountdown(row, now);
  const state = effectiveEnrollmentState(row, now);
  const steps = buildBootstrapSteps({
    token: created.token,
    name: row.name_hint || row.label || "executor",
    harness: row.harness_hint || defaultHarness,
  });
  // Wave 3D: the ONE-COMMAND path (design §D). The bootstrap script is
  // served by the board itself (open read, no secrets inside — the token
  // travels as a CLI ARGUMENT, never a URL: ADR 0012 §9). On screen the
  // token stays MASKED like the row above (shoulder-surfing discipline);
  // the clipboard copy is a deliberate act and carries the FULL token.
  const origin = window.location.origin;
  const bootstrapName = row.name_hint || row.label || "vps-1";
  const bootstrapHarness = row.harness_hint || defaultHarness;
  // AGW-11: the CA fingerprint from the mint answer turns the installer
  // into a strict-CA run (--expect-fp). OPTIONAL until the AGW-9 board
  // slice lands — absent field = the command without the flag (задел по
  // брифу, не тихая деградация: хвост команды просто короче).
  const expectFp = created.ca_fingerprint?.trim() ?? "";
  const expectFpArg = expectFp ? ` --expect-fp ${expectFp}` : "";
  const oneLinerArgs =
    `--url ${origin} --token ${created.token}` +
    ` --name ${bootstrapName} --harness ${bootstrapHarness}${expectFpArg}`;
  // The outer -k is honest and bounded: the installer TEXT is public and
  // secret-free, the lab TLS is self-signed (the chicken-and-egg this
  // script breaks); everything inside rides the PINNED CA + fingerprint
  // check. See REMOTE-EXECUTOR.md Путь 1.
  const oneLiner = `curl -kfsSL ${origin}/api/poller/bootstrap.sh | sudo bash -s -- ${oneLinerArgs}`;
  const oneLinerMasked =
    `curl -kfsSL ${origin}/api/poller/bootstrap.sh | sudo bash -s -- ` +
    `--url ${origin} --token ${maskEnrollmentToken(created.token)}` +
    ` --name ${bootstrapName} --harness ${bootstrapHarness}${expectFpArg}`;
  // A used token links to the row it minted (enrollment.used carries the
  // executor_id; the registry list query has it after the invalidation).
  const minted = row.executor_id
    ? (executors.find((executor) => executor.id === row.executor_id) ?? null)
    : null;

  return (
    <div className="flex flex-col gap-3">
      <DialogDescription>{t("agents.enrollment.tokenOnce")}</DialogDescription>

      {/* The token: ALWAYS masked on screen (AGW-11 — the full plaintext
       * exists only on the clipboard via «Копировать»); mono; copy beside,
       * never inline in the text (no accidental selection leaks). */}
      <div className="flex items-center gap-2 rounded-md border border-border-subtle bg-background px-2 py-1.5">
        {/* aria-label: a screen reader must not read the bullet mask as
         * glyph soup — the row is labeled, the mask is visual only. */}
        <code
          className="min-w-0 flex-1 truncate font-mono text-sm"
          aria-label={t("agents.enrollment.tokenLabel")}
        >
          {/* Copy-failure UNMASKS as the last resort: the token is
           * one-time — losing it to a broken clipboard is worse than the
           * shoulder-surfing window (the copyFailedToken text stays true). */}
          {failed ? created.token : maskEnrollmentToken(created.token)}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => copy("token", created.token)}
        >
          {copied === "token" ? (
            <Check className="size-3.5" aria-hidden="true" />
          ) : (
            <Copy className="size-3.5" aria-hidden="true" />
          )}
          {copied === "token"
            ? t("agents.enrollment.copied")
            : t("agents.enrollment.copy")}
        </Button>
      </div>

      {/* Review P2-2: the honest failure path — the token is STILL on
       * screen (the dialog stays open, the code is selectable), the owner
       * just has to select it by hand. */}
      {failed ? (
        <p role="alert" className="text-xs text-error">
          {t("agents.enrollment.copyFailedToken")}
        </p>
      ) : null}

      {/* Live TTL: mm:ss off the shared ticker; past-TTL reads «истёк» via
       * the effective state even before the sweeper frame arrives. */}
      <p className="font-mono text-xs text-foreground-secondary">
        {state === "created" && ttl !== null
          ? t("agents.enrollment.ttl", { time: ttl })
          : t(`agents.enrollment.state.${state}` as TranslationKey)}
      </p>

      {/* Wave 3D: the ONE COMMAND. --url must be the address THIS machine
       * resolves — the overlay address may differ from the browser's. */}
      <div className="rounded-md border border-border-subtle bg-well">
        <div className="flex items-center gap-2 px-3 py-1.5">
          <p className="text-sm font-medium text-foreground-secondary">
            {t("agents.enrollment.bootstrapTitle")}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-7 px-2 text-xs"
            onClick={() => copy("one-liner", oneLiner)}
          >
            {copied === "one-liner" ? (
              <Check className="size-3.5" aria-hidden="true" />
            ) : (
              <Copy className="size-3.5" aria-hidden="true" />
            )}
            {copied === "one-liner"
              ? t("agents.enrollment.copied")
              : t("agents.enrollment.copy")}
          </Button>
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all border-t border-border-subtle px-3 py-2 font-mono text-xs text-foreground-secondary">
          {oneLinerMasked}
        </pre>
        <p className="px-3 pb-2 text-xs text-foreground-muted">
          {t("agents.enrollment.oneLinerHint")}{" "}
          {t("agents.enrollment.tokenInCopyNote")}
        </p>
      </div>

      {/* The honest manual path (REMOTE-EXECUTOR.md §3-§4) — diagnostics
       * and air-gapped installs; collapsed, never deleted. */}
      <details className="rounded-md border border-border-subtle">
        <summary className="cursor-pointer px-3 py-1.5 text-sm text-foreground-secondary">
          {t("agents.enrollment.manualToggle")}
        </summary>
        <div className="border-t border-border-subtle bg-well">
          <div className="flex items-center justify-end px-3 py-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => copy("all", buildBootstrapScript(steps))}
            >
              {copied === "all" ? (
                <Check className="size-3.5" aria-hidden="true" />
              ) : (
                <Copy className="size-3.5" aria-hidden="true" />
              )}
              {copied === "all"
                ? t("agents.enrollment.copied")
                : t("agents.enrollment.copyAll")}
            </Button>
          </div>
          <ol className="space-y-2 border-t border-border-subtle px-3 py-2">
            {steps.map((step, index) => (
              <li key={index} className="flex items-start gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground-secondary">
                  {step.split(created.token).join(maskEnrollmentToken(created.token))}
                </pre>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 px-1.5 text-xs"
                  aria-label={t("agents.enrollment.copyStepAria", { step: index + 1 })}
                  onClick={() => copy(`step-${index}`, step)}
                >
                  {copied === `step-${index}` ? (
                    <Check className="size-3.5" aria-hidden="true" />
                  ) : (
                    <Copy className="size-3.5" aria-hidden="true" />
                  )}
                </Button>
              </li>
            ))}
          </ol>
        </div>
      </details>

      <p className="text-xs text-foreground-muted">
        {t("agents.enrollment.afterRegister")}
      </p>

      <div className="flex items-center justify-end gap-2">
        {minted ? (
          <span className="mr-auto flex items-center gap-1 text-xs text-foreground-secondary">
            <ExternalLink className="size-3.5" aria-hidden="true" />
            {t("agents.enrollment.usedBy", { name: minted.name })}
          </span>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          {t("agents.enrollment.done")}
        </Button>
      </div>
    </div>
  );
}
