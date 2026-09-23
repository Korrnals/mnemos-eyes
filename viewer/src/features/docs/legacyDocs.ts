import { DEFAULT_PROJECT, hubUrl, categoryUrl } from "./projects";
import {
  docModulePaths,
  parseDocPath,
  type ParsedDocPath,
} from "./markdownModules";

/**
 * Legacy /docs URL map (contract §4, design spec §8): pre-hub bookmarks and
 * board-internal links answer with a replace-redirect into the default hub.
 * The map resolves SYNCHRONOUSLY — the glob keys carry our slugs without
 * loading any chunk — so a legacy URL never renders an intermediate frame
 * (spec §8: редирект невидим). A map MISS is the not-found case (spec §8:
 * CTA «Открыть документация» → the hub).
 */

/**
 * Our own slugs, harvested from the glob keys (synchronous, no fetches).
 * Only unprefixed (vesmaro-eyes) files map from legacy URLs — imported slugs
 * already carry their project segment and never lived at `/docs/<slug>`.
 */
const OUR_SLUGS: ReadonlySet<string> = new Set(
  docModulePaths()
    .map((path) => parseDocPath(path))
    .filter(
      (parsed): parsed is ParsedDocPath =>
        parsed !== null && parsed.project === undefined,
    )
    .map((parsed) => parsed.slug),
);

/**
 * Redirect target for a legacy docs URL, null on a map miss:
 * - `/docs` → `/docs/vesmaro-eyes`
 * - `/docs/c/<cat>` → `/docs/vesmaro-eyes/c/<cat>` (any cat — the page then
 *   answers unknown slugs with the honest not-found, as before)
 * - `/docs/<slug>` → `/docs/vesmaro-eyes/<slug>` when `<slug>` is one of our
 *   pages; unknown slugs return null (not-found, NOT a blind redirect).
 */
export function legacyDocsTarget(pathname: string): string | null {
  if (pathname === "/docs") return hubUrl(DEFAULT_PROJECT);
  const categoryMatch = /^\/docs\/c\/([^/]+)$/.exec(pathname);
  if (categoryMatch) return categoryUrl(DEFAULT_PROJECT, categoryMatch[1]);
  const articleMatch = /^\/docs\/([^/]+)$/.exec(pathname);
  if (articleMatch && !articleMatch[1].startsWith("c/")) {
    const slug = articleMatch[1];
    // A project segment is NOT legacy — the hub route owns it.
    return OUR_SLUGS.has(slug) ? `/docs/${DEFAULT_PROJECT}/${slug}` : null;
  }
  return null;
}

/** Whether any legacy URL redirects (test + miss-handling support). */
export function isLegacyDocsSlug(slug: string): boolean {
  return OUR_SLUGS.has(slug);
}
