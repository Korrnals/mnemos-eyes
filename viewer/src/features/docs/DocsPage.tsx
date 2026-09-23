import { Component, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, ArrowRight, ChevronDown, GitCommitHorizontal, Languages } from "lucide-react";
import { useI18n, useT } from "@/i18n";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { docCategory } from "./categories";
import { extractHeadings, type TocItem } from "./headingSlug";
import {
  loadDocBody,
  localeForPage,
  titleFor,
  useDocsManifest,
  type DocPage,
  type DocProvenance,
} from "./manifest";
import { Markdown } from "./Markdown";
import { DocsSearch } from "./DocsSearch";
import { DocsNotFound } from "./DocsRedirects";
import { formatSyncDate } from "./sidecar";
import { docSlugForPath } from "./docsNav";
import {
  DEFAULT_PROJECT,
  docUrl,
  projectOfDocSlug,
  categoryUrl,
} from "./projects";

/**
 * `/docs/:project/*` (design spec §5/§6/§7/§9): category chip → version
 * badge → provenance badge (imported pages) → locale badge → h1 → article
 * at the 72ch reading measure, TOC rail (sticky, scroll-spy) on the right
 * from lg up, native <details> TOC above the h1 on narrow screens, prev/next
 * at the end confined to the page's OWN project (spec §9.7).
 */

const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright";

function ArticleSkeleton() {
  const t = useT();
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t("docs.loading")}
      aria-hidden="true"
    >
      <Skeleton className="h-5 w-36 rounded-sm" />
      <Skeleton className="mt-3 h-7 w-2/3" />
      <div className="mt-6 space-y-3">
        {[100, 95, 80, 100, 90, 65].map((width, index) => (
          <Skeleton key={index} className={`h-4`} style={{ width: `${width}%` }} />
        ))}
      </div>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-8">
      <div className="max-w-scroll">
        <ArticleSkeleton />
      </div>
    </div>
  );
}

/** TocList item — active state is shape + colour (WCAG 1.4.1, spec §5.3). */
function TocList({ items, activeId }: { items: TocItem[]; activeId: string | null }) {
  return (
    <ul>
      {items.map((item) => {
        const active = item.id === activeId;
        return (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              title={item.text}
              aria-current={active ? "location" : undefined}
              className={cn(
                "block truncate border-l-2 py-1.5 pl-3 pr-1 text-sm transition-colors duration-instant",
                item.depth === 3 && "pl-7",
                active
                  ? "border-iris font-medium text-iris-bright"
                  : "border-transparent text-foreground-secondary hover:text-foreground",
                FOCUS_RING,
              )}
            >
              {item.text}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Scroll-spy over the rendered h2/h3 ids (contract §8). Falls back to "no
 * active item" where IntersectionObserver is unavailable (tests, ancient
 * webviews) — the TOC stays usable as plain anchor links.
 */
function useScrollSpy(ids: string[]): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);
  const key = ids.join("|");
  useEffect(() => {
    if (key === "" || typeof IntersectionObserver === "undefined") return undefined;
    const elements = ids
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null);
    if (elements.length === 0) return undefined;

    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting)
            visible.set(entry.target.id, entry.boundingClientRect.top);
          else visible.delete(entry.target.id);
        }
        if (visible.size > 0) {
          const topmost = [...visible.entries()].sort((a, b) => a[1] - b[1])[0][0];
          setActiveId(topmost);
          return;
        }
        // Nothing visible under the sticky header line — the spy holds the
        // last heading scrolled past, so the rail never points at nothing.
        let last: string | null = null;
        for (const element of elements) {
          if (element.getBoundingClientRect().top < 120) last = element.id;
        }
        setActiveId(last);
      },
      { rootMargin: "-96px 0px -55% 0px", threshold: 0 },
    );
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ids array identity churns per render; the joined key is the real dependency
  }, [key]);
  return activeId;
}

/** TOC rail — hidden below lg (the <details> variant covers narrow widths). */
function TocRail({ items, activeId }: { items: TocItem[]; activeId: string | null }) {
  const t = useT();
  if (items.length < 2) return null; // empty TOC is noise — spec §5.3
  return (
    <aside className="hidden lg:block">
      <div className="sticky top-28 max-h-[calc(100dvh-8rem)] overflow-y-auto">
        <p className="mb-3 text-xs font-medium text-foreground-secondary">
          {t("docs.toc.title")}
        </p>
        <TocList items={items} activeId={activeId} />
      </div>
    </aside>
  );
}

/** Narrow-screen TOC: a native <details> right above the h1 (spec §11). */
function TocDetails({
  items,
  activeId,
}: {
  items: TocItem[];
  activeId: string | null;
}) {
  const t = useT();
  if (items.length < 2) return null;
  return (
    <details className="group mb-4 rounded-md border border-border-subtle bg-well lg:hidden">
      <summary
        className={cn(
          "flex cursor-pointer select-none items-center justify-between px-4 py-3 text-sm font-medium text-foreground",
          FOCUS_RING,
        )}
      >
        {t("docs.toc.title")}
        <ChevronDown
          className="size-4 text-foreground-muted transition-transform duration-instant group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="px-4 pb-3">
        <TocList items={items} activeId={activeId} />
      </div>
    </details>
  );
}

interface BoundaryState {
  error: Error | null;
}

/** Markdown render boundary: error variant + honest «Повторить» (spec §10). */
class RenderBoundary extends Component<{ children: React.ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  render() {
    if (this.state.error !== null) {
      return (
        <RenderFallback
          message={this.state.error.message}
          onRetry={() => this.setState({ error: null })}
        />
      );
    }
    return this.props.children;
  }
}

function RenderFallback({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <EmptyState
      variant="error"
      title={t("docs.error.title")}
      detail={message.slice(0, 200)}
      action={
        <Button variant="outline" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      }
    />
  );
}

/**
 * Provenance badge (design spec §6.2): «из mnemos@abc1234 · синхр. 23.09» —
 * a passport, not an alarm: outline variant, muted GitCommitHorizontal,
 * static (local clones — no upstream URL is guaranteed). The title and
 * aria-label carry the FULL form (whole SHA + dd.mm.yyyy date).
 */
function ProvenanceBadge({ provenance }: { provenance: DocProvenance }) {
  const t = useT();
  const full = t("docs.provenance.full", {
    repo: provenance.repo,
    sha: provenance.sha,
    date: formatSyncDate(provenance.syncedAt, true),
  });
  return (
    <Badge variant="outline" title={full} aria-label={full}>
      <GitCommitHorizontal className="mr-1 size-3.5 text-foreground-muted" aria-hidden="true" />
      {t("docs.provenance.badge", {
        repo: provenance.repo,
        sha: provenance.sha.slice(0, 7),
        date: formatSyncDate(provenance.syncedAt),
      })}
    </Badge>
  );
}

function PrevNext({ slug }: { slug: string }) {
  const t = useT();
  const { lang } = useI18n();
  const manifest = useDocsManifest();
  if (!manifest) return null;
  // Reading never crosses a project boundary (design spec §9.7): prev/next
  // walk THIS project's manifest slice; the last page draws no empty slot.
  const project = projectOfDocSlug(slug);
  const pages = manifest.pages.filter((page) => page.project === project);
  const slugs = pages.map((page) => page.slug);
  const index = slugs.indexOf(slug);
  if (index === -1) return null;
  const prev = index > 0 ? pages[index - 1] : null;
  const next = index < slugs.length - 1 ? pages[index + 1] : null;
  if (!prev && !next) return null;
  return (
    <nav
      aria-label={t("docs.prevNextNav")}
      className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2"
    >
      {prev ? (
        <Link
          to={docUrl(prev.slug)}
          className={cn(
            "rounded-md border border-border-subtle p-4 transition-colors duration-instant",
            "hover:border-border hover:bg-elevated",
            FOCUS_RING,
          )}
        >
          <span className="flex items-center gap-1 text-xs text-foreground-muted">
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            {t("docs.prev")}
          </span>
          <span className="mt-1 block text-sm font-medium text-foreground">
            {titleFor(prev, lang)}
          </span>
        </Link>
      ) : null}
      {next ? (
        <Link
          to={docUrl(next.slug)}
          className={cn(
            "rounded-md border border-border-subtle p-4 transition-colors duration-instant",
            "hover:border-border hover:bg-elevated",
            FOCUS_RING,
          )}
        >
          <span className="flex items-center justify-end gap-1 text-right text-xs text-foreground-muted">
            {t("docs.next")}
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </span>
          <span className="mt-1 block text-right text-sm font-medium text-foreground">
            {titleFor(next, lang)}
          </span>
        </Link>
      ) : null}
    </nav>
  );
}

export function DocsPage() {
  const { project = "", "*": splat = "" } = useParams();
  const { lang } = useI18n();
  const manifest = useDocsManifest();
  const slug = useMemo(() => docSlugForPath(project, splat), [project, splat]);
  const page = useMemo(
    () =>
      slug !== null
        ? (manifest?.pages.find((candidate) => candidate.slug === slug) ?? null)
        : null,
    [manifest, slug],
  );

  if (slug === null || page === null) {
    // A project namespace miss IS the redirect-map miss (design spec §8):
    // honest not-found with the CTA into the section root.
    return (
      <div className="mx-auto max-w-5xl">
        {manifest ? (
          <DocsNotFound />
        ) : (
          <PageSkeleton />
        )}
      </div>
    );
  }
  // The key remounts the view per slug+language: state init replaces the
  // forbidden synchronous effect-reset (react-hooks/set-state-in-effect).
  return <ArticleView key={`${slug}:${lang}`} slug={slug} page={page} />;
}

/** Language self-names for the «на языке оригинала» badge (spec §7.2). */
const LANG_NAME_KEY = {
  ru: "docs.lang.ru",
  en: "docs.lang.en",
} as const;

function ArticleView({ slug, page }: { slug: string; page: DocPage }) {
  const t = useT();
  const { lang } = useI18n();
  const [body, setBody] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let mounted = true;
    void loadDocBody(slug, lang).then((loaded) => {
      if (!mounted) return;
      if (loaded === null) setFailed(true);
      else setBody(loaded.body);
    });
    return () => {
      mounted = false;
    };
  }, [slug, lang, attempt]);

  const toc = useMemo(() => (body === null ? [] : extractHeadings(body)), [body]);
  const activeId = useScrollSpy(toc.map((item) => item.id));
  const category = docCategory(page.category);
  // Locale policy (contract §6, spec §7.1): the page renders in its
  // EFFECTIVE locale; a missing UI locale shows the original + badge —
  // in BOTH directions (ru UI on an en page, en UI on a ru page).
  const effectiveLocale = localeForPage(page, lang);
  const localeOriginal = lang !== effectiveLocale;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <article className="min-w-0 max-w-scroll">
          {/* Meta row: category chip → version badge → provenance badge →
              locale badge, search right (design spec §6.1). */}
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              {category ? (
                <Link
                  to={categoryUrl(page.project, category.slug)}
                  aria-label={t(category.titleKey)}
                  className={cn(
                    badgeVariants({ variant: "default" }),
                    "transition-colors duration-instant hover:text-foreground",
                    FOCUS_RING,
                  )}
                >
                  {t(category.titleKey)}
                </Link>
              ) : null}
              {page.project === DEFAULT_PROJECT ? (
                // The release badge is OUR versioning; imported pages carry
                // their freshness in the provenance badge instead (spec §6).
                <Badge variant="outline">
                  {t("docs.badge.verified", { version: page.lastVerified })}
                </Badge>
              ) : null}
              {page.provenance ? <ProvenanceBadge provenance={page.provenance} /> : null}
              {localeOriginal ? (
                <Badge variant="outline">
                  <Languages className="mr-1 size-3.5" aria-hidden="true" />
                  {t("docs.localeOriginal", { lang: t(LANG_NAME_KEY[effectiveLocale]) })}
                </Badge>
              ) : null}
            </div>
            <DocsSearch className="w-full sm:max-w-xs" />
          </div>

          {body === null ? (
            failed ? (
              <RenderFallback
                message=""
                onRetry={() => setAttempt((current) => current + 1)}
              />
            ) : (
              <ArticleSkeleton />
            )
          ) : (
            <>
              <TocDetails items={toc} activeId={activeId} />
              {/* h1 rides the page's effective locale — the title language
                  always matches the body language (spec §7.1). */}
              <h1 className="mt-4 text-xl font-semibold leading-tight text-foreground">
                {titleFor(page, effectiveLocale)}
              </h1>
              <RenderBoundary>
                <Markdown source={body} pageSlug={slug} />
              </RenderBoundary>
            </>
          )}

          <PrevNext slug={slug} />
        </article>
        <TocRail items={toc} activeId={activeId} />
      </div>
    </div>
  );
}
