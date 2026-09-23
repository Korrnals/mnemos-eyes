import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { ExecutorItem } from "@/gateway/boardTypes";
import { useI18n, useT } from "@/i18n";
import type { TranslationKey } from "@/i18n";
import { formatTaskDate } from "@/features/tasks/taskStatus";
import { useHonestCopy } from "./useEnrollment";
import { ExecutorLinkCheck } from "./ExecutorLinkCheck";
import {
  EXECUTOR_CAPABILITIES_MAX,
  addCapability,
  executorPatchDiff,
} from "./executorForm";
import { PasteBackApprove } from "./ProvisionApprove";
import { PROVISION_APPROVE_PUBLISHED, peekProvisionApprove } from "./provisionContext";
import type { ProvisionApproveContext } from "./provisionContext";
import { useExecutors } from "./useAgents";
import { useExecutorMutations } from "./useExecutorMutations";

/**
 * The executor SETTINGS CARD (AGW-6 B) — a right-side drawer, NOT a route
 * (an executor is registry metadata; the drawer posture is the
 * AssignmentDrawer's). One family with the EnrollmentDialog: the mint flow
 * offers «Открыть карточку» as a `#executor-sheet-<id>` deep-link.
 *
 * Sections: identity (name EDITABLE; harness/transport/host/version
 * read-only WITH the why — harness is the machine-side allowlist matching
 * axis, changing it would silently desync the board from poller.yaml, the
 * honest path is revoke + re-enroll) · link (the ExecutorLinkCheck
 * verdict) · access (state + approve + the enabled kill-switch, dispatch =
 * approved AND enabled) · declared capabilities (structural editor, ≤64,
 * dedup; [] is a server-side WIPE → confirm) · the danger zone (revoke
 * terminal, delete hard) — the same useExecutorMutations gate everywhere.
 *
 * PATCH discipline (verified against the server PATCH route + store
 * update_executor): the card sends ONLY the computed diff
 * (executorForm.executorPatchDiff) — unchanged fields stay absent; the
 * enabled flip and approve are immediate single-field PATCHes of their
 * own. Revoked renders the WHOLE card read-only except Delete.
 * executor_secret is NEVER shown — it exists exactly once, in the register
 * response; a lost secret means revoke + re-register.
 */
export function ExecutorSheet({
  executorId,
  open,
  onOpenChange,
}: {
  executorId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const executors = useExecutors();
  const row =
    executors.data?.items.find((executor) => executor.id === executorId) ?? null;

  // The row vanished (deleted through the card or elsewhere) — the card
  // has nothing left to show; close instead of rendering a ghost.
  useEffect(() => {
    if (open && !executors.isPending && row === null) onOpenChange(false);
  }, [open, executors.isPending, row, onOpenChange]);

  // P3: a foreign row update (another surface's PATCH / SSE) must NOT
  // clobber an in-progress edit. The remount stamp FREEZES at the
  // clean→dirty transition and stays frozen while dirty; once the diff
  // empties (saved or reverted), it unfreezes and the form re-seeds from
  // the server's current truth. The freeze is state-driven (the report
  // comes from the form's dirty effect) — no refs touched during render.
  const [formDirty, setFormDirty] = useState(false);
  const [frozenStamp, setFrozenStamp] = useState<string | null>(null);
  const stamp = row === null ? "" : `${row.id}|${row.updated_at}|${row.state}|${row.enabled}`;
  const handleDirty = useCallback(
    (next: boolean) => {
      setFormDirty(next);
      // Freeze ONCE at the transition; a repeated report (any parent
      // re-render re-runs the child's effect via the callback identity)
      // must NOT chase the stamp while dirty.
      setFrozenStamp((prev) => (next ? (prev ?? stamp) : null));
    },
    [stamp],
  );

  if (row === null) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onOpenChange(false);
      }}
    >
      <DialogContent className="inset-y-0 right-0 left-auto top-auto h-full max-h-full w-full max-w-lg translate-x-0 translate-y-0 rounded-lg border-l border-border-subtle p-0">
        <div className="flex h-full flex-col gap-4 overflow-y-auto p-6 pr-10">
          <DialogTitle className="flex flex-wrap items-baseline gap-2 pr-6 text-base">
            {t("agents.card.title")}
            <span className="min-w-0 truncate font-mono text-xs font-normal text-foreground-muted">
              {row.name}
            </span>
          </DialogTitle>
          {/* The description stays stable (Radix wants one). */}
          <DialogDescription className="sr-only">
            {t("agents.card.description")}
          </DialogDescription>
          <ExecutorSheetForm
            key={formDirty && frozenStamp !== null ? frozenStamp : stamp}
            executor={row}
            onDirtyChange={handleDirty}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The card body: sections + the diff-save. Re-seeds via the parent key. */
function ExecutorSheetForm({
  executor,
  onDirtyChange,
}: {
  executor: ExecutorItem;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const t = useT();
  const { lang } = useI18n();
  const mutations = useExecutorMutations();
  const { copied, copy } = useHonestCopy();

  const revoked = executor.state === "revoked";
  const pending = executor.state === "pending";

  // AGW-11 paste-back: when THIS browser session ran the provision job
  // that minted the pending row, the card carries the pinned fingerprint
  // (provisionContext.ts) — the approve goes through the verify. Rows
  // without context (the manual mint path, another device) keep the
  // plain approve.
  //
  // PR #99 review P3-1: a verdict published while this sheet is OPEN is
  // picked up live — the card dispatches PROVISION_APPROVE_PUBLISHED (a
  // same-tab signal; the storage event never fires in the writing tab,
  // and a no-change refetch re-renders nothing under structural
  // sharing). The latch keeps the verify visible after the successful
  // approve consumed the storage row, until the registry row leaves
  // pending — no flash of the plain button mid-invalidation.
  const peeked =
    executor.state === "pending" ? peekProvisionApprove(executor.id) : null;
  const [latchedContext, setLatchedContext] =
    useState<ProvisionApproveContext | null>(peeked);
  useEffect(() => {
    if (executor.state !== "pending") return;
    const onPublished = (event: Event): void => {
      const detail = (event as CustomEvent<{ executorId: string }>).detail;
      if (detail?.executorId !== executor.id) return;
      const fresh = peekProvisionApprove(executor.id);
      if (fresh !== null) setLatchedContext(fresh);
    };
    window.addEventListener(PROVISION_APPROVE_PUBLISHED, onPublished);
    return () =>
      window.removeEventListener(PROVISION_APPROVE_PUBLISHED, onPublished);
  }, [executor.id, executor.state]);
  const approveContext = peeked ?? latchedContext;

  // Form state seeds from the loaded row; the diff (name + capabilities
  // only — enabled/approve/revoke/delete are immediate single PATCHes).
  const [name, setName] = useState(executor.name);
  const [capabilities, setCapabilities] = useState<string[]>([
    ...executor.capabilities,
  ]);
  const [capInput, setCapInput] = useState("");
  const [capHint, setCapHint] = useState<"dup" | "max" | null>(null);

  const diff = executorPatchDiff(executor, { name, capabilities });
  const diffEmpty = Object.keys(diff).length === 0;
  const dirty = !diffEmpty;

  // P3: the parent freezes the remount stamp while dirty — report the flag
  // up whenever it flips (the effect, not render: no cascading setState).
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const save = (): void => {
    if (diffEmpty) return;
    // P3: ONE wipe checkpoint, on Save — chip-by-chip removal down to []
    // hits the SAME confirm as the bulk «Clear» (the server treats [] as a
    // deliberate wipe; an accidental one must be as hard to make).
    if (
      diff.capabilities !== undefined &&
      diff.capabilities.length === 0 &&
      !window.confirm(t("agents.card.capsClearConfirm"))
    ) {
      return;
    }
    mutations.updateExecutor(executor, diff, "agents.card.saved");
  };

  const addCap = (): void => {
    const next = addCapability(capabilities, capInput);
    if (next === null) {
      setCapHint(capabilities.length >= EXECUTOR_CAPABILITIES_MAX ? "max" : "dup");
      return;
    }
    setCapabilities(next);
    setCapInput("");
    setCapHint(null);
  };

  // [] is a VALID PATCH (the server wipes the list) — hence the confirm.
  const clearCaps = (): void => {
    if (capabilities.length === 0) return;
    if (!window.confirm(t("agents.card.capsClearConfirm"))) return;
    setCapabilities([]);
    setCapHint(null);
  };

  const stateBadge = (): { key: TranslationKey; title?: string } => {
    if (pending) return { key: "agents.executor.pendingReason" };
    if (revoked) return { key: "agents.executor.revokedReason" };
    return { key: "agents.card.stateApproved" };
  };

  const registeredViaHuman = executor.registered_via.startsWith("enrollment:")
    ? t("agents.registry.viaEnrollment")
    : t("agents.registry.viaMachine");

  const facts: { label: string; value: string }[] = [
    { label: t("agents.card.harnessLabel"), value: executor.harness },
    {
      label: t("agents.card.transportLabel"),
      value:
        executor.transport === "mesh-r4"
          ? t("agents.strip.transportMesh")
          : t("agents.strip.transportLocal"),
    },
    { label: t("agents.registry.hostLabel"), value: executor.host },
    { label: t("agents.card.versionLabel"), value: executor.version || "—" },
    {
      label: t("agents.card.registeredVia"),
      value: `${registeredViaHuman} · ${executor.registered_via || "—"}`,
    },
    {
      label: t("agents.card.registeredAt"),
      value: executor.registered_at ? formatTaskDate(executor.registered_at, lang) : "—",
    },
    {
      label: t("agents.card.updatedAt"),
      value: executor.updated_at ? formatTaskDate(executor.updated_at, lang) : "—",
    },
  ];

  const fieldClass =
    "h-9 w-full rounded-md border border-border bg-background px-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <div className="flex min-h-0 flex-col gap-4">
      {/* Revoked honesty banner: the card is a tombstone except Delete. */}
      {revoked ? (
        <p
          role="alert"
          className="rounded-md border border-border-subtle bg-elevated p-2 text-xs text-foreground-muted"
        >
          {t("agents.card.revokedReadOnly")}
        </p>
      ) : null}

      {/* --- Identity ------------------------------------------------- */}
      <section aria-label={t("agents.card.sectionIdentity")} className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-foreground-secondary">
          {t("agents.card.sectionIdentity")}
        </h3>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("agents.card.nameLabel")}
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            disabled={revoked}
            className={fieldClass}
          />
        </label>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-foreground-muted">{executor.id}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs"
            onClick={() => copy("id", executor.id)}
            aria-label={t("agents.card.copyId", { id: executor.id })}
          >
            {copied === "id" ? (
              <Check className="size-3" aria-hidden="true" />
            ) : (
              <Copy className="size-3" aria-hidden="true" />
            )}
            {t("agents.enrollment.copy")}
          </Button>
        </div>
        <dl className="flex flex-col gap-1 text-sm">
          {facts.map((fact) => (
            <div key={fact.label} className="flex items-baseline justify-between gap-3">
              <dt className="shrink-0 text-foreground-muted">{fact.label}</dt>
              <dd className="min-w-0 break-all text-right font-mono text-xs text-foreground-secondary">
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
        {/* WHY harness is not editable (the honest refusal). */}
        <p className="text-xs text-foreground-muted">{t("agents.card.harnessNote")}</p>
      </section>

      {/* --- Link ----------------------------------------------------- */}
      <section aria-label={t("agents.card.sectionLink")} className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-foreground-secondary">
          {t("agents.card.sectionLink")}
        </h3>
        <ExecutorLinkCheck executor={executor} variant="card" autoCheck />
      </section>

      {/* --- Access --------------------------------------------------- */}
      <section aria-label={t("agents.card.sectionAccess")} className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-foreground-secondary">
          {t("agents.card.sectionAccess")}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-normal">
            {t(stateBadge().key)}
          </Badge>
          {pending && approveContext === null ? (
            <Button size="sm" className="h-7 px-2 text-xs" onClick={() => mutations.approveExecutor(executor)}>
              {t("agents.registry.approve")}
            </Button>
          ) : null}
        </div>
        {pending && approveContext !== null ? (
          <PasteBackApprove
            executor={executor}
            fingerprint={approveContext.fingerprint}
            tofu={approveContext.tofu}
          />
        ) : null}
        {executor.state === "approved" ? (
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={executor.enabled}
              onChange={(event) =>
                mutations.setExecutorEnabled(executor, event.target.checked)
              }
              className="mt-1 accent-iris-bright"
            />
            <span>
              {t("agents.card.enabledLabel")}
              <span className="block text-xs text-foreground-muted">
                {t("agents.card.enabledNote")}
              </span>
            </span>
          </label>
        ) : null}
        {pending ? (
          <p className="text-xs text-foreground-muted">{t("agents.card.enabledPendingHint")}</p>
        ) : null}
      </section>

      {/* --- Declared capabilities ------------------------------------- */}
      <section aria-label={t("agents.card.sectionCaps")} className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-foreground-secondary">
          {t("agents.card.sectionCaps")}
        </h3>
        <ul className="flex flex-wrap items-center gap-1">
          {capabilities.length === 0 ? (
            <li className="text-xs text-foreground-muted">
              {t("agents.executor.noCapabilities")}
            </li>
          ) : (
            capabilities.map((capability) => (
              <li
                key={capability}
                className="flex items-center gap-1 rounded-sm border border-border-subtle px-1 py-0.5 font-mono text-xs text-foreground-secondary"
              >
                {capability}
                {!revoked ? (
                  <button
                    type="button"
                    aria-label={t("agents.card.capsRemoveAria", { capability })}
                    className="rounded-sm text-foreground-muted transition-colors duration-instant hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
                    onClick={() =>
                      setCapabilities((list) => list.filter((item) => item !== capability))
                    }
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                ) : null}
              </li>
            ))
          )}
        </ul>
        {!revoked ? (
          <>
            <div className="flex items-center gap-2">
              <input
                value={capInput}
                onChange={(event) => {
                  setCapInput(event.target.value);
                  setCapHint(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addCap();
                  }
                }}
                maxLength={120}
                placeholder={t("agents.card.capsPlaceholder")}
                aria-label={t("agents.card.capsInputAria")}
                className={fieldClass}
              />
              <Button type="button" variant="outline" size="sm" onClick={addCap}>
                <Plus className="size-3.5" aria-hidden="true" />
                {t("agents.card.capsAdd")}
              </Button>
              {capabilities.length > 0 ? (
                <Button type="button" variant="ghost" size="sm" onClick={clearCaps}>
                  {t("agents.card.capsClear")}
                </Button>
              ) : null}
            </div>
            {capHint !== null ? (
              <p role="alert" className="text-xs text-error">
                {t(capHint === "dup" ? "agents.card.capsDup" : "agents.card.capsMax")}
              </p>
            ) : null}
          </>
        ) : null}
        <p className="text-xs text-foreground-muted">{t("agents.card.capsNote")}</p>
      </section>

      {/* The name+capabilities diff save — quiet when nothing changed. */}
      {!revoked ? (
        <div className="flex items-center justify-end gap-2">
          <span aria-live="polite" className="mr-auto text-xs text-foreground-muted">
            {diffEmpty ? t("agents.card.noChanges") : ""}
          </span>
          <Button type="button" size="sm" disabled={diffEmpty} onClick={save}>
            {t("agents.card.save")}
          </Button>
        </div>
      ) : null}

      {/* --- Danger zone ------------------------------------------------ */}
      <section aria-label={t("agents.card.sectionDanger")} className="flex flex-col gap-2">
        <h3 className="flex items-center gap-1 text-xs font-medium text-foreground-secondary">
          <AlertTriangle className="size-3.5" aria-hidden="true" />
          {t("agents.card.sectionDanger")}
        </h3>
        <p className="text-xs text-foreground-muted">{t("agents.card.dangerNote")}</p>
        <div className="flex items-center justify-between gap-2">
          {!revoked ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="border-error/50 text-error hover:bg-elevated"
              onClick={() => mutations.revokeExecutor(executor)}
            >
              {t("agents.registry.revoke")}
            </Button>
          ) : (
            <span />
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={
              revoked
                ? "border-error/50 text-error hover:bg-elevated"
                : "text-error hover:bg-elevated"
            }
            /* No onClose() here: the card closes itself when the row
             * actually vanishes (the delete succeeded) — a failed/deferred
             * run keeps the card open with the server's error toast. */
            onClick={() => mutations.removeExecutor(executor)}
          >
            {t("agents.registry.remove")}
          </Button>
        </div>
      </section>

      {/* The secret honesty clause — NEVER rendered, only explained. */}
      <p className="mt-auto border-t border-border-subtle pt-2 text-xs text-foreground-muted">
        {t("agents.card.secretHint")}
      </p>
    </div>
  );
}
