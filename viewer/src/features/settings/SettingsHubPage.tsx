import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { Button } from "@/components/ui/button";
import { useTheme, THEME_PREFERENCES } from "@/components/theme-provider";
import { useDensity, DENSITIES } from "@/components/density-provider";
import { LANGUAGES, useI18n, useT } from "@/i18n";
import { setSidebarCollapsed, useSidebarCollapsed } from "@/lib/sidebarState";
import { setBoardStyle, useBoardStyle } from "@/lib/boardStyleStore";
import { setMotion, useMotion, MOTIONS, type Motion } from "@/lib/motionStore";
import { ExecutionSettingsSection } from "@/features/agents/ExecutionSettingsPage";
import { AutomationSettingsSection } from "./AutomationSettingsSection";
import { NotCustomizable } from "./NotCustomizable";
import { SegmentedControl } from "./SegmentedControl";

/**
 * `/system/settings` — the settings hub v2 (UI-23, spec 2026-09-23): ONE h1
 * + six sibling sections in the owner's order (Внешний вид / Поведение /
 * Доска / Навигация / Исполнение / Автоматизация) under a sticky anchor
 * menu. Principle «одно состояние, два управления» (§0/§4.3): every local
 * control here calls the SAME provider/store the context controls call —
 * theme/density/lang via the app providers, board style and the sidebar via
 * lib stores, motion via lib/motionStore. «Исполнение» and «Автоматизация»
 * are the server sections reused verbatim from v1 (UI-21). Each local
 * section ends with a native `<details>` of reasoned verdicts (§3.4) — the
 * surfaces that deliberately have no setting. Live preview IS the hub (§3.3):
 * theme/density/lang apply immediately through the providers; the board
 * style carries the honest deferred hint.
 */

/** Anchor map of the local sections (deep-linkable, spec §3.1). */
const HUB_SECTIONS = [
  { id: "appearance", titleKey: "settings.hub.appearanceTitle" },
  { id: "behavior", titleKey: "settings.hub.behaviorTitle" },
  { id: "board", titleKey: "settings.hub.boardTitle" },
  { id: "navigation", titleKey: "settings.hub.navigationTitle" },
  { id: "execution", titleKey: "settings.hub.executionTitle" },
  { id: "automation", titleKey: "settings.hub.automationTitle" },
] as const;

/** Owner: features/agents/executionPrefs.ts (the key stays private there). */
const ONBOARDING_DONE_KEY = "vesmaro.agents.onboardingDone";

/** Reset the AGW-4 hint so it auto-expands again on the Execution page. */
function resetOnboardingHint(): void {
  try {
    localStorage.setItem(ONBOARDING_DONE_KEY, "0");
  } catch {
    // Non-fatal: storage unavailable — the flag just stays as it was.
  }
}

export function SettingsHubPage() {
  const t = useT();
  const location = useLocation();

  // Anchor deep-links: react-router sets the hash before the async sections
  // mount — scroll once the target exists (v1 behaviour kept).
  useEffect(() => {
    if (!location.hash) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, [location.hash]);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 id="settings-title" className="text-xl font-semibold">
        {t("nav.systemSettings")}
      </h1>

      {/* Sticky anchor menu: sits BELOW the sticky breadcrumb bar (top-14 +
       * its 40px) so the two never overlap; horizontal scroll on narrow
       * screens; plain links — no JS active-section tracking (spec self-review). */}
      <nav
        aria-label={t("settings.hub.navLabel")}
        className="sticky top-24 z-10 overflow-x-auto rounded-md border border-border-subtle bg-background/95 backdrop-blur-sm"
      >
        <ul className="flex w-max gap-1 p-1">
          {HUB_SECTIONS.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className="block whitespace-nowrap rounded px-2.5 py-1.5 text-sm text-foreground-secondary transition-colors duration-instant hover:bg-elevated hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
              >
                {t(section.titleKey)}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <AppearanceSection />
      <BehaviorSection />
      <BoardSection />
      <NavigationSection />
      {/* Server sections (v1, reused verbatim): the anchor + scroll margin
       * live on the wrapper so the reused blocks stay untouched. */}
      <div id="execution" className="scroll-mt-36">
        <ExecutionSettingsSection />
      </div>
      <div id="automation" className="scroll-mt-36">
        <AutomationSettingsSection />
      </div>
    </div>
  );
}

/** The shared section well: h2 + scroll margin clear of the sticky bars. */
function HubSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-settings-heading`}
      className="scroll-mt-36 space-y-3 rounded-md border border-border-subtle bg-well p-4 shadow-well"
    >
      <h2 id={`${id}-settings-heading`} className="text-sm font-medium">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** «Внешний вид»: theme (3-state), language, density — all live-preview. */
function AppearanceSection() {
  const t = useT();
  const { themePreference, setTheme } = useTheme();
  const { lang, setLang } = useI18n();
  const { density, setDensity } = useDensity();

  return (
    <HubSection id="appearance" title={t("settings.hub.appearanceTitle")}>
      <SegmentedControl
        label={t("settings.hub.themeLabel")}
        labelId="settings-theme-label"
        hint={t("settings.hub.themeHint")}
        hintId="settings-theme-hint"
        value={themePreference}
        onChange={setTheme}
        options={THEME_PREFERENCES.map((value) => ({
          value,
          label: t(
            value === "system"
              ? "settings.hub.themeSystem"
              : value === "dark"
                ? "settings.hub.themeDark"
                : "settings.hub.themeLight",
          ),
        }))}
      />
      <SegmentedControl
        label={t("settings.hub.langLabel")}
        labelId="settings-lang-label"
        value={lang}
        onChange={setLang}
        options={LANGUAGES.map((value) => ({
          value,
          label: value.toUpperCase(),
        }))}
      />
      <SegmentedControl
        label={t("settings.hub.densityLabel")}
        labelId="settings-density-label"
        hint={`${t("settings.hub.densityHint")} ${t("settings.hub.appliesEverywhere")}`}
        hintId="settings-density-hint"
        value={density}
        onChange={setDensity}
        options={DENSITIES.map((value) => ({
          value,
          label: t(
            value === "comfortable"
              ? "settings.hub.densityComfortable"
              : "settings.hub.densityCompact",
          ),
        }))}
      />
      <NotCustomizable
        verdicts={[
          t("settings.hub.verdict.fonts"),
          t("settings.hub.verdict.contemplative"),
        ]}
      />
    </HubSection>
  );
}

/** «Поведение»: the new `vesmaro.motion` regime + the onboarding replay. */
function BehaviorSection() {
  const t = useT();
  const motion = useMotion();
  const [replayed, setReplayed] = useState(false);

  return (
    <HubSection id="behavior" title={t("settings.hub.behaviorTitle")}>
      <SegmentedControl<Motion>
        label={t("settings.hub.motionLabel")}
        labelId="settings-motion-label"
        hint={t("settings.hub.motionHint")}
        hintId="settings-motion-hint"
        value={motion}
        onChange={setMotion}
        options={MOTIONS.map((value) => ({
          value,
          label: t(
            value === "system"
              ? "settings.hub.motionSystem"
              : "settings.hub.motionReduced",
          ),
        }))}
      />
      <div className="space-y-1">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            resetOnboardingHint();
            setReplayed(true);
          }}
        >
          {t("settings.hub.onboardingReplay")}
        </Button>
        {replayed ? (
          <p role="status" className="text-xs text-foreground-secondary">
            {t("settings.hub.onboardingReplayed")}
          </p>
        ) : null}
      </div>
      <NotCustomizable
        verdicts={[
          t("settings.hub.verdict.confirms"),
          t("settings.hub.verdict.scrolls"),
          t("settings.hub.verdict.updateBanner"),
          t("settings.hub.verdict.hotkeys"),
          t("settings.hub.verdict.panels"),
          t("settings.hub.verdict.search"),
          t("settings.hub.verdict.crumbs"),
        ]}
      />
    </HubSection>
  );
}

/** «Доска»: the shared board-style state with the honest deferred hint. */
function BoardSection() {
  const t = useT();
  const [boardStyle] = useBoardStyle();

  return (
    <HubSection id="board" title={t("settings.hub.boardTitle")}>
      <SegmentedControl
        label={t("settings.hub.boardStyleLabel")}
        labelId="settings-board-style-label"
        hint={t("settings.hub.boardStyleHint")}
        hintId="settings-board-style-hint"
        value={boardStyle}
        onChange={setBoardStyle}
        options={[
          { value: "groups", label: t("tasks.board.styleGroups") },
          { value: "classic", label: t("tasks.board.styleClassic") },
        ]}
      />
      <NotCustomizable
        verdicts={[
          t("settings.hub.verdict.groups"),
          t("settings.hub.verdict.dnd"),
          t("settings.hub.verdict.filters"),
        ]}
      />
    </HubSection>
  );
}

/** «Навигация»: the sidebar rail state (one state with the sidebar button). */
function NavigationSection() {
  const t = useT();
  const collapsed = useSidebarCollapsed();

  return (
    <HubSection id="navigation" title={t("settings.hub.navigationTitle")}>
      <SegmentedControl
        label={t("settings.hub.sidebarLabel")}
        labelId="settings-sidebar-label"
        hint={t("settings.hub.sidebarHint")}
        hintId="settings-sidebar-hint"
        value={collapsed ? "collapsed" : "expanded"}
        onChange={(value) => setSidebarCollapsed(value === "collapsed")}
        options={[
          { value: "expanded", label: t("settings.hub.sidebarExpanded") },
          { value: "collapsed", label: t("settings.hub.sidebarCollapsed") },
        ]}
      />
      <NotCustomizable
        verdicts={[
          t("settings.hub.verdict.viewRoute"),
          t("settings.hub.verdict.domains"),
        ]}
      />
    </HubSection>
  );
}
