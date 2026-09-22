/**
 * The SINGLE `import.meta.glob` for docs markdown (contract §3). Every
 * content file becomes its own lazy chunk, fetched only when the docs
 * section first asks for it — `eager: true` is forbidden (bundle budget
 * §10). Locale lives in the path: `content/ru|en/<slug>.md`, and the file
 * name IS the slug (contract §5).
 */

export type DocLocale = "ru" | "en";

const modules = import.meta.glob<string>("./content/**/*.md", {
  query: "?raw",
  import: "default",
});

/** Parse a glob key (`./content/ru/deploy.md`) into slug + locale. */
export function parseDocPath(path: string): { slug: string; locale: DocLocale } | null {
  const match = /^\.\/content\/(ru|en)\/([^/]+)\.md$/.exec(path);
  if (!match) return null;
  return { locale: match[1] as DocLocale, slug: match[2] };
}

/** All raw modules as [path, loader] pairs (manifest + integrity tests). */
export function docModuleEntries(): ReadonlyArray<
  readonly [path: string, load: () => Promise<string>]
> {
  return Object.entries(modules) as ReadonlyArray<
    readonly [path: string, load: () => Promise<string>]
  >;
}

/** Lazy content access: slug + locale → raw markdown (undefined = absent). */
export function loadMarkdown(
  slug: string,
  locale: DocLocale,
): Promise<string | undefined> {
  const load = modules[`./content/${locale}/${slug}.md`];
  return load ? load() : Promise.resolve(undefined);
}
