import { describe, expect, it, vi } from "vitest";

import { docAssetEntries } from "./docsAssets";
import { docModuleEntries } from "./markdownModules";

/**
 * Asset integrity gate (contract §9.3, wave 2): every relative image
 * reference in the corpus (`![alt](diagrams/x.svg)`, `<img src>`) must
 * resolve inside the asset bundle; every SVG asset must be two-theme
 * (contains a prefers-color-scheme branch) and carry no external resources
 * (no http(s) outside xmlns declarations — no CDN). Unused assets are a
 * console WARNING, not a failure: screens may be prepared ahead of the
 * pages that will reference them.
 */

/** `![alt](src "title")` — the src ends at whitespace or `)`. */
const MD_IMAGE = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
/** Raw-HTML image refs never render (no rehype-raw) but still count. */
const HTML_IMAGE = /<img\b[^>]*\bsrc=["']([^"']+)["']/g;

/** Srcs allowed to bypass the asset map (they render as-is by design). */
function isAbsoluteSrc(src: string): boolean {
  return /^(https?:)?\/\//.test(src) || src.startsWith("/") || src.startsWith("data:");
}

async function collectImageRefs(): Promise<ReadonlyMap<string, string[]>> {
  const refs = new Map<string, string[]>();
  const add = (ref: string, page: string) => {
    const pages = refs.get(ref) ?? [];
    if (!pages.includes(page)) pages.push(page);
    refs.set(ref, pages);
  };
  for (const [path, load] of docModuleEntries()) {
    const raw = await load();
    for (const match of raw.matchAll(MD_IMAGE)) add(match[1], path);
    for (const match of raw.matchAll(HTML_IMAGE)) add(match[1], path);
  }
  return refs;
}

describe("docs asset integrity (wave 2)", () => {
  it("resolves every relative image reference to a bundled asset", async () => {
    const assets = new Set(docAssetEntries().map(([key]) => key));
    expect(assets.size, "sanity: asset bundle is non-empty").toBeGreaterThan(0);
    const missing: string[] = [];
    const external: string[] = [];
    for (const [ref, pages] of await collectImageRefs()) {
      if (ref.startsWith("http://") || ref.startsWith("https://")) {
        // CSP img-src is 'self' data: — an external image would silently
        // fail to load in the server deployment; fail the corpus instead.
        external.push(`${ref} (referenced by ${pages.join(", ")})`);
        continue;
      }
      if (isAbsoluteSrc(ref)) continue; // data:/other absolute srcs render as-is
      if (!assets.has(ref)) missing.push(`${ref} (referenced by ${pages.join(", ")})`);
    }
    expect(external, "external http(s) images violate CSP img-src 'self' data:").toEqual([]);
    expect(missing, "refs with no asset behind them").toEqual([]);
  });

  it("keeps every OUR SVG asset two-theme and free of external resources", async () => {
    // Test-only ?raw glob: reads the SVG SOURCE (never shipped to the bundle).
    const svgSources = import.meta.glob<string>("./assets/**/*.svg", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    // The two-theme rule covers CURATED diagrams only (contract §4): vendored
    // upstream SVGs render as-is (design spec §9.6).
    const entries = Object.entries(svgSources).filter(
      ([path]) => !path.includes("/upstream/"),
    );
    expect(entries.length, "sanity: svg assets exist").toBeGreaterThan(0);
    for (const [path, source] of entries) {
      expect(
        source.includes("prefers-color-scheme"),
        `${path}: no prefers-color-scheme branch (dark theme would break)`,
      ).toBe(true);
      // xmlns declarations are identifiers, not fetched resources — strip
      // them; any remaining http(s) means a CDN/font/image fetch inside SVG.
      const withoutNamespaces = source.replace(/\sxmlns(:[\w-]+)?="[^"]*"/g, "");
      expect(
        /https?:\/\//.test(withoutNamespaces),
        `${path}: external http(s) resource inside SVG`,
      ).toBe(false);
    }
  });

  it("warns (does not fail) about assets no page references yet", async () => {
    const warnSpy = vi.spyOn(console, "warn");
    const referenced = new Set((await collectImageRefs()).keys());
    let unused = 0;
    for (const [key] of docAssetEntries()) {
      if (!referenced.has(key)) {
        unused += 1;
        console.warn(`[docs] asset ${key} is not referenced by any page yet`);
      }
    }
    // The wave-2 corpus uses every bundled asset; the warning path stays
    // exercised for future pre-staged screens (assert shape, not the count).
    expect(unused).toBeGreaterThanOrEqual(0);
    expect(warnSpy.mock.calls.filter((call) => String(call[0]).startsWith("[docs]")).length).toBe(
      unused,
    );
    warnSpy.mockRestore();
  });
});
