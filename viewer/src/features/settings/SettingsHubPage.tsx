import { useEffect } from "react";
import { Link, useLocation } from "react-router";
import { useT } from "@/i18n";
import { ExecutionSettingsSection } from "@/features/agents/ExecutionSettingsPage";
import { AutomationSettingsSection } from "./AutomationSettingsSection";

/**
 * `/system/settings` — the settings hub (UI-21, spec 2026-09-23 §1): ONE
 * h1 «Настройки» + three sibling sections with deep-linkable anchors
 * (#execution / #automation / #interface). «Исполнение» is the AGW-3 block
 * REUSED verbatim; «Автоматизация» is the one new server-contract form
 * (§2); «Интерфейс» is static cross-links only — interface preferences
 * deliberately STAY where they are used (spec §0: recognition over
 * recall). Zero new colours, fonts or tokens: the section style is the
 * existing well pattern, the only accent is the engine-off warning badge.
 */
export function SettingsHubPage() {
  const t = useT();
  const location = useLocation();

  // Anchor deep-links (the /system/automation banner aims here): react-router
  // sets the hash before the async section mounts — scroll once it exists.
  useEffect(() => {
    if (!location.hash) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, [location.hash]);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 id="settings-title" className="text-xl font-semibold">
        {t("nav.systemSettings")}
      </h1>
      <ExecutionSettingsSection anchorId="execution" />
      <AutomationSettingsSection anchorId="automation" />
      <InterfaceSection anchorId="interface" />
    </div>
  );
}

/**
 * «Интерфейс»: no forms by design — each preference lives at its point of
 * use (top bar ×2, /tasks board-style toggle, the sidebar button). The
 * /tasks row is the one real navigation; the chrome rows point at
 * affordances that are already on screen around this page.
 */
function InterfaceSection({ anchorId }: { anchorId?: string }) {
  const t = useT();
  return (
    <section
      id={anchorId}
      aria-labelledby="interface-settings-heading"
      className="space-y-3 rounded-md border border-border-subtle bg-well p-4 shadow-well"
    >
      <div>
        <h2 id="interface-settings-heading" className="text-sm font-medium">
          {t("settings.hub.interfaceTitle")}
        </h2>
        <p className="mt-0.5 text-xs text-foreground-secondary">
          {t("settings.hub.interfaceHint")}
        </p>
      </div>
      <ul className="space-y-1 text-sm">
        <li className="text-foreground-secondary">{t("settings.hub.prefLang")}</li>
        <li className="text-foreground-secondary">{t("settings.hub.prefDensity")}</li>
        <li>
          <Link
            to="/tasks"
            className="text-iris-bright underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
          >
            {t("settings.hub.prefBoardStyle")}
          </Link>
        </li>
        <li className="text-foreground-secondary">{t("settings.hub.prefSidebar")}</li>
      </ul>
    </section>
  );
}
