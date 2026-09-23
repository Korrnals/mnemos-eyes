import { useT } from "@/i18n";

const cnSummary =
  "cursor-pointer text-sm font-medium text-foreground-secondary transition-colors duration-instant hover:text-foreground " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright";

/**
 * The verdict block of a hub section (UI-23, spec §3.4): a NATIVE
 * `<details>` listing every surface that deliberately does not get a
 * setting, each with its reason. Semantic HTML without JS — the content
 * stays reachable for find-in-page and screen readers, collapsed by default
 * so the section is not buried in refusals (the honest answer to «всё
 * настраивается?» without fake toggles).
 */
export function NotCustomizable({ verdicts }: { verdicts: readonly string[] }) {
  const t = useT();
  return (
    <details className="rounded-md border border-border-subtle bg-background px-3 py-2">
      <summary className={cnSummary}>{t("settings.hub.notCustomizable")}</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-foreground-secondary">
        {verdicts.map((verdict) => (
          <li key={verdict}>{verdict}</li>
        ))}
      </ul>
    </details>
  );
}
