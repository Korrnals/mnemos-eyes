import { Link } from "react-router";
import { useI18n, useT, type Lang, type TranslateFn } from "@/i18n";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { docCategoriesSorted } from "./categories";
import { useDocsManifest, type DocsManifest } from "./manifest";
import { DocsSearch } from "./DocsSearch";

/**
 * `/docs` — the section index (design spec §3): h1 + one-line lede + the
 * search field, then the 8 category cards (3→2→1 grid). Contemplative
 * surface: spacing comes straight from tokens, no density coupling, no hero.
 */

/** Count in words, ru pluralization (the i18n layer has no plural forms). */
function pagesLabel(lang: Lang, count: number, t: TranslateFn): string {
  if (lang === "ru") {
    const ones = count % 10;
    const tens = count % 100;
    const key =
      ones === 1 && tens !== 11
        ? "docs.pages.one"
        : ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)
          ? "docs.pages.few"
          : "docs.pages.many";
    return t(key, { count });
  }
  return t(count === 1 ? "docs.pages.one" : "docs.pages.many", { count });
}

const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright";

function IndexSkeleton() {
  const t = useT();
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t("docs.loading")}
      aria-hidden="true"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={index}
          className="shimmer rounded-md border border-border-subtle bg-well p-6"
        >
          <Skeleton className="size-5" />
          <Skeleton className="mt-3 h-4 w-2/3" />
          <Skeleton className="mt-2 h-3 w-full" />
          <Skeleton className="mt-4 h-3 w-1/3" />
        </div>
      ))}
    </div>
  );
}

function CategoryGrid({ manifest }: { manifest: DocsManifest }) {
  const t = useT();
  const { lang } = useI18n();
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {docCategoriesSorted().map((category) => {
        const Icon = category.icon;
        const count = manifest.pages.filter(
          (page) => page.category === category.slug,
        ).length;
        return (
          <Link
            key={category.slug}
            to={`/docs/c/${category.slug}`}
            aria-label={t(category.titleKey)}
            className={cn(
              "rounded-md border border-border-subtle bg-well p-6 shadow-well",
              "transition-[border-color,box-shadow,background-color] duration-instant",
              "hover:border-border hover:bg-elevated hover:shadow-raised active:bg-elevated",
              FOCUS_RING,
            )}
          >
            <Icon className="size-5 text-foreground-secondary" aria-hidden="true" />
            <p className="mt-3 text-base font-medium text-foreground">
              {t(category.titleKey)}
            </p>
            <p className="mt-1 line-clamp-2 text-sm text-foreground-secondary">
              {t(category.descriptionKey)}
            </p>
            <p className="mt-4 text-xs text-foreground-muted">
              {pagesLabel(lang, count, t)}
            </p>
          </Link>
        );
      })}
    </div>
  );
}

export function DocsIndexPage() {
  const t = useT();
  // Mounting the hook kicks the lazy manifest build (contract §7).
  const manifest = useDocsManifest();
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-foreground">{t("nav.docs")}</h1>
          <p className="mt-1 text-sm text-foreground-secondary">
            {t("docs.index.lede")}
          </p>
        </div>
        <DocsSearch className="w-full md:max-w-xs" />
      </div>
      {manifest ? <CategoryGrid manifest={manifest} /> : <IndexSkeleton />}
    </div>
  );
}
