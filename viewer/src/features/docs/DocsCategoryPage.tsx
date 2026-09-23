import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { useI18n, useT } from "@/i18n";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { docCategory, docCategoriesForProject } from "./categories";
import {
  firstParagraph,
  getManifest,
  localeForPage,
  parseFrontmatter,
  titleFor,
} from "./manifest";
import { loadMarkdown } from "./markdownModules";
import { DEFAULT_PROJECT, docProject, docUrl } from "./projects";
import { DocsNotFound } from "./DocsRedirects";
import { DocsSearch } from "./DocsSearch";

/**
 * `/docs/:project/c/:category` (design spec §4): the category header, then a
 * LIST of page rows (never a second card grid — анти-слоп §14.5). The
 * category must belong to the URL's project — a cross-project URL is a miss.
 */

const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright";

interface RowInfo {
  slug: string;
  title: string;
  description: string;
  lastVerified: string;
  project: string;
}

/** Rows of one category: manifest order + descriptions from the bodies. */
async function rowInfos(categorySlug: string, lang: "ru" | "en"): Promise<RowInfo[]> {
  const manifest = await getManifest();
  return Promise.all(
    manifest.pages
      .filter((page) => page.category === categorySlug)
      .map(async (page) => {
        const raw = await loadMarkdown(page.slug, localeForPage(page, lang));
        const parsed = raw ? parseFrontmatter(raw) : null;
        return {
          slug: page.slug,
          title: titleFor(page, lang),
          description: parsed ? firstParagraph(parsed.body) : "",
          lastVerified: page.lastVerified,
          project: page.project,
        };
      }),
  );
}

function RowsSkeleton() {
  const t = useT();
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t("docs.loading")}
      aria-hidden="true"
    >
      {Array.from({ length: 3 }, (_, index) => (
        <div
          key={index}
          className="shimmer border-b border-border-subtle px-4 py-4 last:border-b-0"
        >
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="mt-2 h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}

function CategoryRows({ categorySlug }: { categorySlug: string }) {
  const { lang } = useI18n();
  const [rows, setRows] = useState<RowInfo[] | null>(null);
  useEffect(() => {
    let mounted = true;
    void rowInfos(categorySlug, lang).then((infos) => {
      if (mounted) setRows(infos);
    });
    return () => {
      mounted = false;
    };
  }, [categorySlug, lang]);

  if (rows === null) return <RowsSkeleton />;
  return (
    <div>
      {rows.map((row) => (
        <Link
          key={row.slug}
          to={docUrl(row.slug)}
          className={cn(
            "group flex min-h-14 items-start justify-between gap-4 border-b border-border-subtle px-4 py-4",
            "transition-colors duration-instant last:border-b-0 hover:bg-elevated",
            FOCUS_RING,
          )}
        >
          <span className="min-w-0">
            <span className="block text-base font-medium text-foreground transition-colors duration-instant group-hover:text-iris-bright">
              {row.title}
            </span>
            {row.description !== "" ? (
              <span className="mt-0.5 line-clamp-2 block text-sm text-foreground-secondary">
                {row.description}
              </span>
            ) : null}
          </span>
          <span className="shrink-0 pt-0.5 text-xs text-foreground-muted">
            {row.project === DEFAULT_PROJECT ? `v${row.lastVerified}` : row.lastVerified}
          </span>
        </Link>
      ))}
    </div>
  );
}

export function DocsCategoryPage() {
  const { project = "", category: categorySlug } = useParams();
  const t = useT();
  const projectMeta = docProject(project);
  const category = docCategory(categorySlug);
  // The category must live in THIS project's hub — cross-project URLs miss.
  const owned =
    projectMeta !== null &&
    category !== null &&
    docCategoriesForProject(projectMeta.slug).some((entry) => entry.slug === category.slug);
  if (!owned || !category) {
    return (
      <div className="mx-auto max-w-5xl">
        <DocsNotFound />
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <category.icon
            className="mt-1 size-5 shrink-0 text-foreground-secondary"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-foreground">
              {t(category.titleKey)}
            </h1>
            <p className="mt-1 text-sm text-foreground-secondary">
              {t(category.descriptionKey)}
            </p>
          </div>
        </div>
        <DocsSearch className="w-full md:max-w-xs" />
      </div>
      <CategoryRows categorySlug={category.slug} />
    </div>
  );
}
