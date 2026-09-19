import { useI18n, LANGUAGES } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * Compact "RU | EN" segmented control for the TopBar (owner feedback 1.4.0:
 * language switching must be visible, not buried). Toggle-group semantics:
 * `aria-pressed` marks the active segment; both segments stay in the tab
 * order (WCAG 2.1.1) with a token-bound focus ring.
 */
export function LanguageToggle() {
  const { lang, setLang, t } = useI18n();
  return (
    <div
      role="group"
      aria-label={t("topbar.langLabel")}
      className="inline-flex overflow-hidden rounded-md border border-border-subtle"
    >
      {LANGUAGES.map((code) => {
        const active = lang === code;
        return (
          <button
            key={code}
            type="button"
            lang={code}
            onClick={() => setLang(code)}
            aria-pressed={active}
            className={cn(
              "min-h-6 px-2.5 py-1 text-xs font-semibold uppercase transition-colors duration-instant",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright",
              active
                ? "bg-iris/15 text-iris-bright" // AA in both themes
                : "text-foreground-secondary hover:bg-elevated hover:text-foreground",
            )}
          >
            {code}
          </button>
        );
      })}
    </div>
  );
}
