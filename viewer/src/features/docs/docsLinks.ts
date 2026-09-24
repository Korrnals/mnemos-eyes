import { getManifestSync } from "./manifest";
import { docUrl } from "./projects";

/**
 * Corpus link resolution (W1c — internalization of markdown links): a
 * `slug.md` reference (our corpus) or a bare manifest slug (the sync
 * rewrites upstream links into board slugs — contract §4) becomes a
 * project-scoped /docs URL; `#anchors` ride along. Pure module: no JSX, so
 * Markdown.tsx keeps its react-refresh export hygiene.
 */

export type DocLinkResolution =
  | { kind: "internal"; to: string }
  | { kind: "broken" }
  | { kind: "unhandled" };

export function isExternalHref(href: string): boolean {
  return /^(https?:)?\/\//.test(href) || /^[a-z][a-z0-9+.-]*:/i.test(href);
}

/** Resolve `./x` / `../x` against the directory of the page being rendered. */
function resolveAgainstPage(base: string, pageSlug: string): string {
  if (!/^\.\.?(\/|$)/.test(base)) return base;
  const parts = pageSlug.includes("/") ? pageSlug.split("/").slice(0, -1) : [];
  for (const segment of base.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

/**
 * Classify an href from a page body. Returns `broken` for `.md`/bare-word
 * refs that resolve to nothing (rendered visibly broken, never a crash);
 * `unhandled` for everything that is not corpus-internal (rendered as
 * before: /docs* links, anchors, external URLs).
 */
export function resolveDocLink(
  href: string,
  pageSlug: string | undefined,
): DocLinkResolution {
  // External URLs first — a github .md link must never hit the corpus map.
  if (isExternalHref(href) || href.startsWith("/")) return { kind: "unhandled" };
  const hashAt = href.indexOf("#");
  const base = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const hash = hashAt >= 0 ? href.slice(hashAt) : "";
  if (base === "") return { kind: "unhandled" }; // pure anchor — plain <a>

  const candidates: string[] = [];
  const raw = base.replace(/\.md$/i, "");
  if (raw !== base || !base.includes("/")) {
    // Either an explicit .md reference (possibly ./ ../ relative) or a bare
    // word — resolve against the page and try the project-prefixed form too.
    const resolved =
      pageSlug !== undefined ? resolveAgainstPage(raw, pageSlug) : raw;
    candidates.push(resolved);
    if (pageSlug !== undefined && pageSlug.includes("/")) {
      const project = pageSlug.slice(0, pageSlug.indexOf("/"));
      candidates.push(`${project}/${resolved}`);
    }
  } else {
    // A slashful path without .md — the sync's board-slug form.
    candidates.push(raw);
  }

  const pages = getManifestSync()?.pages;
  if (pages === undefined) return { kind: "unhandled" }; // pre-hydration frame
  for (const candidate of candidates) {
    const page = pages.find((entry) => entry.slug === candidate);
    if (page) return { kind: "internal", to: `${docUrl(page.slug)}${hash}` };
  }
  if (raw !== base || !base.includes("/")) return { kind: "broken" };
  return { kind: "unhandled" };
}
