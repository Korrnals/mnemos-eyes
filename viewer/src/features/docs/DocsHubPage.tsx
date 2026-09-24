import { Link, Navigate, useParams } from "react-router";
import { Languages } from "lucide-react";
import { useI18n, useT } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { docCategoriesForProject } from "./categories";
import { pagesLabel } from "./docsFormat";
import {
  localeForPage,
  titleFor,
  useDocsManifest,
  type DocPage,
  type DocsManifest,
} from "./manifest";
import {
  docProject,
  docUrl,
  categoryUrl,
  type DocProject,
} from "./projects";
import { formatSyncDate } from "./sidecar";
import { legacyDocsTarget } from "./legacyDocs";
import { DocsNotFound } from "./DocsRedirects";
import { DocsSearch } from "./DocsSearch";

/**
 * `/docs/:project` — the hub cover (design spec §4): a book title page, not
 * a landing. One form for all three projects: project icon + h1, ONE intro
 * paragraph (chrome i18n — L3 layer), an honest status line (locale coverage
 * + provenance for imported projects), «с чего начать» text links, then the
 * categories as ROWS (never a card grid — анти-слоп §14.10).
 */

const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright";

/** Honest locale-coverage wording, derived from the manifest (spec §4.1.3). */
function coverageKey(pages: readonly DocPage[]): "both" | "ru" | "en" | "mixed" {
  const hasRu = pages.some((page) => page.locales.includes("ru"));
  const hasEn = pages.some((page) => page.locales.includes("en"));
  if (hasRu && hasEn) {
    return pages.every(
      (page) => page.locales.includes("ru") && page.locales.includes("en"),
    )
      ? "both"
      : "mixed";
  }
  return hasRu ? "ru" : "en";
}

/** Provenance summary for the hub status line: first repo@sha, latest date. */
function hubProvenance(pages: readonly DocPage[]) {
  let repo: string | null = null;
  let sha: string | null = null;
  let latest = "";
  for (const page of pages) {
    if (!page.provenance) continue;
    repo ??= page.provenance.repo;
    sha ??= page.provenance.sha;
    if (page.provenance.syncedAt > latest) latest = page.provenance.syncedAt;
  }
  if (repo === null || sha === null || latest === "") return null;
  return { repo, sha, syncedAt: latest };
}

function HubSkeleton() {
  const t = useT();
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t("docs.loading")}
      aria-hidden="true"
    >
      <Skeleton className="h-7 w-56" />
      <Skeleton className="mt-3 h-4 w-full max-w-xl" />
      <Skeleton className="mt-2 h-4 w-2/3 max-w-md" />
      <div className="mt-8">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="shimmer border-b border-border-subtle px-4 py-4 last:border-b-0"
          >
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="mt-2 h-3 w-2/3" />
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusBadges({ project, pages }: { project: DocProject; pages: readonly DocPage[] }) {
  const t = useT();
  const provenance = project.upstream ? hubProvenance(pages) : null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="outline">
        <Languages className="mr-1 size-3.5" aria-hidden="true" />
        {t(`docs.hub.coverage.${coverageKey(pages)}`)}
      </Badge>
      {provenance ? (
        <Badge
          variant="outline"
          title={t("docs.provenance.full", {
            repo: provenance.repo,
            sha: provenance.sha,
            date: formatSyncDate(provenance.syncedAt, true),
          })}
          aria-label={t("docs.provenance.full", {
            repo: provenance.repo,
            sha: provenance.sha,
            date: formatSyncDate(provenance.syncedAt, true),
          })}
        >
          {t("docs.provenance.badge", {
            repo: provenance.repo,
            sha: provenance.sha.slice(0, 7),
            date: formatSyncDate(provenance.syncedAt),
          })}
        </Badge>
      ) : null}
    </div>
  );
}

function StartHere({ project, manifest }: { project: DocProject; manifest: DocsManifest }) {
  const t = useT();
  const { lang } = useI18n();
  const pages = project.startSlugs
    .map((slug) => manifest.pages.find((page) => page.slug === slug))
    .filter((page): page is DocPage => page !== undefined);
  if (pages.length === 0) return null; // L3 not written yet — honest absence
  return (
    <div>
      <p className="text-xs font-medium text-foreground-secondary">
        {t("docs.hub.start")}
      </p>
      {/* One wrapping line of text links, « · » as punctuation (spec §4.1.4). */}
      <p className="mt-1 text-sm leading-relaxed">
        {pages.map((page, index) => (
          <span key={page.slug}>
            {index > 0 ? <span className="text-foreground-muted">{" · "}</span> : null}
            <Link
              to={docUrl(page.slug)}
              className={cn(
                "text-iris-bright underline underline-offset-2 transition-colors duration-instant hover:decoration-2",
                FOCUS_RING,
              )}
            >
              {titleFor(page, localeForPage(page, lang))}
            </Link>
          </span>
        ))}
      </p>
    </div>
  );
}

function CategoryRows({ project, manifest }: { project: DocProject; manifest: DocsManifest }) {
  const t = useT();
  const { lang } = useI18n();
  return (
    <div>
      {docCategoriesForProject(project.slug).map((category) => {
        const Icon = category.icon;
        const count = manifest.pages.filter(
          (page) => page.category === category.slug,
        ).length;
        return (
          <Link
            key={category.slug}
            to={categoryUrl(project.slug, category.slug)}
            aria-label={t(category.titleKey)}
            className={cn(
              "group flex min-h-14 items-center justify-between gap-4 border-b border-border-subtle px-4 py-4",
              "transition-colors duration-instant last:border-b-0 hover:bg-elevated",
              FOCUS_RING,
            )}
          >
            <span className="flex min-w-0 items-start gap-3">
              <Icon
                className="mt-1 size-5 shrink-0 text-foreground-secondary"
                aria-hidden="true"
              />
              <span className="min-w-0">
                <span className="block text-base font-medium text-foreground transition-colors duration-instant group-hover:text-iris-bright">
                  {t(category.titleKey)}
                </span>
                <span className="mt-0.5 block truncate text-sm text-foreground-secondary">
                  {t(category.descriptionKey)}
                </span>
              </span>
            </span>
            <span className="shrink-0 text-xs text-foreground-muted">
              {pagesLabel(lang, count, t)}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

function HubCover({ project }: { project: DocProject }) {
  const t = useT();
  const Icon = project.icon;
  // Mounting the hook kicks the lazy manifest build (contract §7).
  const manifest = useDocsManifest();
  const pages = manifest?.pages.filter((page) => page.project === project.slug);
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Icon
            className="mt-1 size-6 shrink-0 text-foreground-secondary"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-foreground">{project.name}</h1>
            <p className="mt-1 max-w-[60ch] text-sm text-foreground-secondary">
              {t(project.ledeKey)}
            </p>
          </div>
        </div>
        <DocsSearch className="w-full md:max-w-xs" />
      </div>
      {manifest && pages ? (
        <>
          <div className="mb-6">
            <StatusBadges project={project} pages={pages} />
          </div>
          <div className="mb-6">
            <StartHere project={project} manifest={manifest} />
          </div>
          <p className="border-b border-border-subtle pb-2 text-xs font-medium text-foreground-secondary">
            {t("docs.hub.categories")}
          </p>
          <CategoryRows project={project} manifest={manifest} />
        </>
      ) : (
        <HubSkeleton />
      )}
    </div>
  );
}

export function DocsHubPage() {
  const { project = "" } = useParams();
  const meta = docProject(project);
  if (meta) return <HubCover project={meta} />;
  // Not a project segment — a legacy single-segment URL (/docs/<old slug>).
  // The map resolves synchronously from glob keys: no skeleton, no flicker
  // (design spec §8); a miss is the honest not-found.
  const target = legacyDocsTarget(`/docs/${project}`);
  if (target !== null) return <Navigate to={target} replace />;
  return (
    <div className="mx-auto max-w-5xl">
      <DocsNotFound />
    </div>
  );
}
