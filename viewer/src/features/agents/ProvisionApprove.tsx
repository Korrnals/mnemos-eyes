import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ExecutorItem } from "@/gateway/boardTypes";
import { useT } from "@/i18n";
import { clearProvisionApprove } from "./provisionContext";
import { pasteBackMatches } from "./provisionTypes";
import { useHonestCopy } from "./useEnrollment";
import { useExecutorMutations } from "./useExecutorMutations";

/**
 * The paste-back approve (AGW-11, Архком-8 §2) — the TOFU honesty gate.
 *
 * A NEW pin (this job's TOFU) is cosmetic trust until the owner has laid
 * eyes on the TARGET: the block shows the pinned fingerprint and demands
 * the LAST 8 HEX chars of the digest typed from the machine itself
 * (ssh-keygen prints base64, so the helper shows the sha256sum pipeline
 * to run there). The approve button unlocks ONLY on an exact match — a
 * partial input never approves. A pin that PREDATES the job (strict mode
 * or an earlier TOFU) was verified in an earlier trust act: the plain
 * button, no re-verify (the brief's «re-approve без сверки»).
 *
 * Shared by the connect card's done state and the registry sheet (the
 * provisionContext.ts bridge carries the facts to the sheet). The
 * approve itself is the standard useExecutorMutations path — the same
 * PATCH, the same toasts; on success the context is consumed (one-shot).
 */
export function PasteBackApprove({
  executor,
  fingerprint,
  tofu,
}: {
  /** The pending registry row the job minted. */
  executor: ExecutorItem;
  /** The pinned host-key fingerprint (canonical SHA256:base64). */
  fingerprint: string;
  /** True = this job minted the pin (paste-back applies). */
  tofu: boolean;
}) {
  const t = useT();
  const mutations = useExecutorMutations();
  const { copied, copy } = useHonestCopy();
  const [tail, setTail] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const matches = !tofu || pasteBackMatches(fingerprint, tail);
  const approve = (): void => {
    if (!matches || submitting) return;
    setSubmitting(true);
    mutations.approveExecutor(executor, {
      // PR #99 review P3-1: consume the one-shot context ONLY after the
      // PATCH succeeded — a network failure keeps the verify armed for
      // the re-opened sheet instead of silently degrading to the plain
      // approve. onError re-arms the button (a 401 stays with the gate).
      onSuccess: () => clearProvisionApprove(executor.id),
      onError: () => setSubmitting(false),
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-foreground-secondary">
        {t("agents.provision.approveIntro")}
      </p>

      {/* The pin itself — public material, shown in full with a copy. */}
      <div className="flex items-center gap-2 rounded-md border border-border-subtle bg-background px-2 py-1.5">
        <code className="min-w-0 flex-1 break-all font-mono text-xs">
          {fingerprint}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 text-xs"
          onClick={() => copy("pin", fingerprint)}
        >
          {copied === "pin" ? (
            <Check className="size-3.5" aria-hidden="true" />
          ) : (
            <Copy className="size-3.5" aria-hidden="true" />
          )}
          {copied === "pin"
            ? t("agents.enrollment.copied")
            : t("agents.enrollment.copy")}
        </Button>
      </div>

      {tofu ? (
        <>
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("agents.provision.pasteBackLabel")}
            <input
              value={tail}
              onChange={(event) => setTail(event.target.value)}
              maxLength={8}
              autoComplete="off"
              spellCheck={false}
              placeholder="0123abcd"
              aria-invalid={tail !== "" && !matches}
              aria-describedby="provision-pasteback-hint"
              className="h-9 w-44 rounded-md border border-border bg-background px-2 font-mono text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
            />
          </label>
          <p id="provision-pasteback-hint" className="text-xs text-foreground-muted">
            {t("agents.provision.pasteBackHint")}
          </p>
        </>
      ) : (
        <p className="text-xs text-foreground-muted">
          {t("agents.provision.pasteBackSkipped")}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!matches || submitting}
          aria-disabled={!matches || submitting}
          onClick={approve}
        >
          {t("agents.registry.approve")}
        </Button>
      </div>
    </div>
  );
}
