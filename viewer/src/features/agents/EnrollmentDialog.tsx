import { useState } from "react";
import { Check, Copy, Eye, EyeOff, ExternalLink } from "lucide-react";
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
} from "./enrollment";
import { useEnrollmentActions, useHonestCopy } from "./useEnrollment";
import { HarnessSelect } from "./HarnessSelect";

/**
 * «Добавить исполнителя» — the enrollment dialog (AGW-5 phase 2, design
 * §Фазы.2). Two phases in ONE dialog (the AssignExecutorSheet pattern):
 *
 * 1. FORM — label (≤64), harness_hint (the LIVE dictionary combobox with
 *    free entry — wave 3C; the server 422s unknown values with the
 *    authoritative list), name_hint (optional, ≤120).
 * 2. TOKEN SCREEN — the mne_… plaintext hidden until «Показать» (shoulder
 *    surfacing beats a ninja reveal), copy buttons, the LIVE TTL countdown
 *    (mm:ss off the shared 1 Hz ticker), and the VPS bootstrap block — the
 *    commands are a copy-paste projection of deploy/poller/
 *    REMOTE-EXECUTOR.md §4б/§4в (the runbook is the source of truth; this
 *    screen never invents a second one).
 *
 * The dialog owns NO enrollment state after close: the panel below the
 * registry (fed by the invalidated list query + enrollment.* SSE) is the
 * persistent status surface. Radix owns the focus trap / Esc / restore.
 */
export function EnrollmentDialog({
  open,
  onOpenChange,
  executors,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The registry — a used token links to its minted pending row. */
  executors: readonly ExecutorItem[];
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
          <EnrollmentForm key={formKey} onCreated={setCreated} onDone={close} />
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
}: {
  onCreated: (created: EnrollmentCreatedResult) => void;
  onDone: () => void;
}) {
  const t = useT();
  const actions = useEnrollmentActions();
  const [label, setLabel] = useState("");
  const [harness, setHarness] = useState<string>("zcode");
  const [nameHint, setNameHint] = useState("");
  const [submitting, setSubmitting] = useState(false);

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
        <HarnessSelect id="enroll-harness" value={harness} onChange={setHarness} />
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
      <div className="mt-1 flex items-center justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          {t("agents.sheet.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={submitting}>
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
  const [revealed, setRevealed] = useState(false);
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
    harness: row.harness_hint || "zcode",
  });
  // A used token links to the row it minted (enrollment.used carries the
  // executor_id; the registry list query has it after the invalidation).
  const minted = row.executor_id
    ? (executors.find((executor) => executor.id === row.executor_id) ?? null)
    : null;

  return (
    <div className="flex flex-col gap-3">
      <DialogDescription>{t("agents.enrollment.tokenOnce")}</DialogDescription>

      {/* The token: masked until «Показать»; mono; copy beside, never inline
       * in the text (no accidental selection leaks). */}
      <div className="flex items-center gap-2 rounded-md border border-border-subtle bg-background px-2 py-1.5">
        <code className="min-w-0 flex-1 truncate font-mono text-sm">
          {revealed ? created.token : `${created.token.slice(0, 4)}${"•".repeat(12)}`}
        </code>
        <span className="sr-only">{t("agents.enrollment.tokenLabel")}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => setRevealed((value) => !value)}
          aria-pressed={revealed}
        >
          {revealed ? (
            <EyeOff className="size-3.5" aria-hidden="true" />
          ) : (
            <Eye className="size-3.5" aria-hidden="true" />
          )}
          {revealed ? t("agents.enrollment.hide") : t("agents.enrollment.show")}
        </Button>
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

      {/* The VPS bootstrap block — REMOTE-EXECUTOR.md §4б/§4в as copyable
       * steps; board_url stays a placeholder (the owner's VPN fact). */}
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
                {step}
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
