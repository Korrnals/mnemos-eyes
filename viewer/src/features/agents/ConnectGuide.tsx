import { useState } from "react";
import { useT } from "@/i18n";

/**
 * «Как подключить внешнего агента» (AGW-4, spec §1 — the /agents/harnesses
 * answer to the owner's «где интерфейс подключения внешних агентов?»;
 * hotfix 1.22.x — owner feedback from the prod screenshots): the FIVE steps
 * of the ONE-COMMAND enrollment flow (the dialog is the source of truth —
 * the copy here stays a summary, never drifts into a second runbook)
 * collapsed by default, expanded on demand.
 *
 * Honest-note (§4 anti-dashification): the one-liner downloads the installer
 * from the board (public, secret-free text); everything after rides the
 * secured channel with certificate verification — and the token is one-time
 * with a 15-minute TTL. The manual path (deploy/poller/REMOTE-EXECUTOR.md
 * «Путь 2 — руками») stays referenced for diagnostics and isolated networks.
 */
export function ConnectGuide() {
  const t = useT();
  const [expanded, setExpanded] = useState(false);

  return (
    <section
      aria-label={t("agents.connect.label")}
      className="rounded-md border border-border-subtle bg-well shadow-well"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-1.5 rounded-md px-3 py-1.5 text-left text-sm font-medium text-foreground-secondary transition-colors duration-instant hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
      >
        <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        {t("agents.connect.label")}
      </button>
      {expanded ? (
        <div className="border-t border-border-subtle px-3 py-2">
          <ol className="list-inside list-decimal space-y-1.5 text-sm text-foreground-secondary">
            <li>{t("agents.connect.step1")}</li>
            <li>{t("agents.connect.step2")}</li>
            <li>{t("agents.connect.step3")}</li>
            <li>{t("agents.connect.step4")}</li>
            <li>{t("agents.connect.step5")}</li>
          </ol>
          {/* Honest note: the installer download is public, the transport is
           * not — the pinned-CA channel carries everything after it. */}
          <p className="mt-2 border-t border-border-subtle pt-2 text-xs text-foreground-muted">
            {t("agents.connect.note")}
          </p>
          {/* The manual path pointer (REMOTE-EXECUTOR.md «Путь 2») —
           * diagnostics / isolated networks; text, not a link: the runbook
           * lives in the repo, this screen never mirrors it. */}
          <p className="text-xs text-foreground-muted">
            {t("agents.connect.manual")}
          </p>
        </div>
      ) : null}
    </section>
  );
}
