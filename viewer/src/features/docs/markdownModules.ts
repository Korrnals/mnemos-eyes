/**
 * The SINGLE `import.meta.glob` for docs markdown (contract §3). Every
 * content file becomes its own lazy chunk, fetched only when the docs
 * section first asks for it — `eager: true` is forbidden (bundle budget
 * §10). The glob deliberately spans BOTH corpora:
 * - our content:  `./content/ru|en/<slug>.md`        (slug = file name)
 * - imported:     `./content/upstream/<project>/<locale>/<path>.md`
 *   (slug = `<project>/<path>`, locale from its path segment — contract §4)
 * The glob KEYS are available synchronously; the file CONTENTS stay lazy.
 */

export type DocLocale = "ru" | "en";

const modules = import.meta.glob<string>("./content/**/*.md", {
  query: "?raw",
  import: "default",
});

export interface ParsedDocPath {
  slug: string;
  locale: DocLocale;
  /** Present for imported files (`content/upstream/...`), absent for ours. */
  project?: string;
}

/** Parse a glob key into slug + locale (+ project for the imported corpus). */
export function parseDocPath(path: string): ParsedDocPath | null {
  const ours = /^\.\/content\/(ru|en)\/([^/]+)\.md$/.exec(path);
  if (ours) return { locale: ours[1] as DocLocale, slug: ours[2] };
  const upstream =
    /^\.\/content\/upstream\/([a-z0-9-]+)\/(ru|en)\/(.+)\.md$/.exec(path);
  if (upstream) {
    return {
      locale: upstream[2] as DocLocale,
      slug: `${upstream[1]}/${upstream[3]}`,
      project: upstream[1],
    };
  }
  return null;
}

/** All raw modules as [path, loader] pairs (manifest + integrity tests). */
export function docModuleEntries(): ReadonlyArray<
  readonly [path: string, load: () => Promise<string>]
> {
  return Object.entries(modules) as ReadonlyArray<
    readonly [path: string, load: () => Promise<string>]
  >;
}

/**
 * All glob KEYS (synchronous — loaders never run): the legacy-redirect map
 * resolves old slugs without fetching anything (spec §8 — редирект без
 * промежуточного рендера).
 */
export function docModulePaths(): readonly string[] {
  return Object.keys(modules);
}

/**
 * Slug + locale → the glob key holding the body. A `/`-prefixed slug maps
 * into its project's upstream subtree; anything else is our flat corpus.
 */
export function docContentKey(slug: string, locale: DocLocale): string {
  const slash = slug.indexOf("/");
  if (slash > 0) {
    const upstreamKey = `./content/upstream/${slug.slice(0, slash)}/${locale}/${slug.slice(slash + 1)}.md`;
    if (modules[upstreamKey] !== undefined) return upstreamKey;
  }
  return `./content/${locale}/${slug}.md`;
}

/** Whether a body chunk exists for the slug+locale (manifest integrity). */
export function hasMarkdown(slug: string, locale: DocLocale): boolean {
  return modules[docContentKey(slug, locale)] !== undefined;
}

/** Lazy content access: slug + locale → raw markdown (undefined = absent). */
export function loadMarkdown(
  slug: string,
  locale: DocLocale,
): Promise<string | undefined> {
  const load = modules[docContentKey(slug, locale)];
  return load ? load() : Promise.resolve(undefined);
}
