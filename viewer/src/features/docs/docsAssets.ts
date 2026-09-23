/**
 * The SINGLE `import.meta.glob` for docs static assets (contract §3 pattern
 * — one glob per concern). Resolves in-body image references like
 * `![alt](diagrams/vesmaro-stack.svg)` — and, since the upstream import
 * (contract §4), vendored refs like `upstream/<project>/<path>.png` — to
 * bundled URLs. `eager: true` is allowed HERE only: the map holds URLs, not
 * file content (budget §10 — the markdown chunks stay lazy; the URLs ride
 * the bundle that already imports Markdown.tsx). The upstream subtree starts
 * empty (the v1 corpus carries no images); the mask covers the formats the
 * sync may vendor (svg/webp/png/jpg).
 */

const assets = import.meta.glob<string>(
  "./assets/**/*.{svg,webp,png,jpg,jpeg}",
  {
    query: "?url",
    import: "default",
    eager: true,
  },
) as Record<string, string>;

/** Glob key (`./assets/diagrams/x.svg`) → key relative to the assets root. */
function toAssetKey(path: string): string {
  return path.replace(/^\.\/assets\//, "");
}

/** Keys are corpus-side paths: `diagrams/x.svg`, `upstream/mnemos/y.png`. */
const ASSET_URLS: ReadonlyMap<string, string> = new Map(
  Object.entries(assets).map(([key, url]) => [toAssetKey(key), url]),
);

/** Absolute (http(s), protocol-relative, app-root, data) — outside the map. */
function isExternalSrc(src: string): boolean {
  return (
    /^(https?:)?\/\//.test(src) || src.startsWith("/") || src.startsWith("data:")
  );
}

/**
 * Image src resolver for Markdown.tsx: a relative path present in the asset
 * map becomes the bundled URL; absolute http(s) sources and relative paths
 * NOT found in the assets render as-is (the integrity test catches refs
 * that resolve to nothing — contract §9.3).
 */
export function resolveDocImageUrl(src: string | undefined): string | undefined {
  if (src === undefined || isExternalSrc(src)) return src;
  return ASSET_URLS.get(src) ?? src;
}

/** All asset mappings as [relative key, bundled URL] pairs (integrity test). */
export function docAssetEntries(): ReadonlyArray<readonly [string, string]> {
  return [...ASSET_URLS.entries()];
}
