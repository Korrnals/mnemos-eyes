import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { DOC_CATEGORIES, docCategory } from "./categories";
import { getManifest, parseFrontmatter, stripLeadingH1, titleFor } from "./manifest";
import { docModuleEntries, loadMarkdown, parseDocPath } from "./markdownModules";
import { Markdown } from "./Markdown";

/**
 * Manifest integrity + corpus gates (contract §9.3): every content file has
 * a valid frontmatter (required fields, existing category, slug = file name,
 * unique order per category), every contract category is non-empty, and the
 * whole corpus renders through Markdown.tsx without a single console
 * error/warning.
 */

const errorSpy = vi.spyOn(console, "error");
const warnSpy = vi.spyOn(console, "warn");

afterEach(() => {
  errorSpy.mockClear();
  warnSpy.mockClear();
});

describe("frontmatter integrity", () => {
  it("parses every content file into slug + locale", () => {
    const entries = docModuleEntries();
    expect(entries.length).toBeGreaterThanOrEqual(12); // v1 corpus (contract §5)
    for (const [path] of entries) {
      expect(parseDocPath(path), path).not.toBeNull();
    }
  });

  it("gives every file the required fields with slug = file name", async () => {
    for (const [path, load] of docModuleEntries()) {
      const raw = await load();
      const parsed = parseFrontmatter(raw);
      if (parsed === null) throw new Error(`${path}: malformed frontmatter`);
      const { fields } = parsed;
      for (const key of ["title", "slug", "category", "order", "last_verified"]) {
        expect(fields[key], `${path}: ${key}`).toBeTruthy();
      }
      const parsedPath = parseDocPath(path)!;
      expect(fields.slug, path).toBe(parsedPath.slug);
      expect(fields.order, path).toMatch(/^\d+$/);
      expect(fields.last_verified, path).toMatch(/^\d+\.\d+\.\d+$/);
      expect(docCategory(fields.category), `${path}: category`).not.toBeNull();
    }
  });

  it("keeps order unique within a category and every category non-empty", async () => {
    const { pages } = await getManifest();
    for (const category of DOC_CATEGORIES) {
      const inCategory = pages.filter((page) => page.category === category.slug);
      expect(inCategory.length, `category ${category.slug} is empty`).toBeGreaterThan(
        0,
      );
      const orders = inCategory.map((page) => page.order);
      expect(new Set(orders).size, category.slug).toBe(orders.length);
    }
  });

  it("reports invalid frontmatter and EXCLUDES the page (no crash)", () => {
    expect(parseFrontmatter("no frontmatter at all")).toBeNull();
    expect(parseFrontmatter("---\nonly-key\n---\nbody")).toBeNull(); // not key: value
    expect(parseFrontmatter("---\ntitle: x\n---\nbody")).not.toBeNull();
  });

  it("strips the leading body h1 (the page renders its own from frontmatter)", () => {
    expect(stripLeadingH1("# Title\n\ntext")).toBe("text");
    expect(stripLeadingH1("text")).toBe("text");
  });

  it("falls titles back across locales (titleFor)", async () => {
    const { pages } = await getManifest();
    for (const page of pages) {
      expect(titleFor(page, "ru"), page.slug).not.toBe("");
      if (!page.locales.includes("en")) {
        // No en corpus in v1 → the ru title is the en-UI fallback.
        expect(titleFor(page, "en"), page.slug).toBe(titleFor(page, "ru"));
      }
    }
  });
});

describe("corpus render (contract §9.3)", () => {
  it("renders every page without console errors or warnings", async () => {
    const { pages } = await getManifest();
    expect(pages.length).toBe(docModuleEntries().length);
    for (const page of pages) {
      const raw = await loadMarkdown(page.slug, "ru");
      expect(raw, page.slug).toBeDefined();
      const body = stripLeadingH1(parseFrontmatter(raw!)!.body);
      const html = renderToString(
        <MemoryRouter>
          <Markdown source={body} />
        </MemoryRouter>,
      );
      expect(html.length, page.slug).toBeGreaterThan(100);
      // One h1 per page comes from frontmatter, not the body.
      expect((html.match(/<h1/g) ?? []).length, page.slug).toBe(0);
    }
    expect(unexpectedErrors(), JSON.stringify(unexpectedErrors())).toEqual([]);
    expect(unexpectedWarnings()).toEqual([]);
  });
});

/** console noise that is environment, not content: MemoryRouter's SSR note. */
const RENDER_ENV_NOISE = /useLayoutEffect does nothing on the server/;

function unexpectedErrors(): unknown[][] {
  return errorSpy.mock.calls.filter((call) => !RENDER_ENV_NOISE.test(String(call[0])));
}

function unexpectedWarnings(): unknown[][] {
  return warnSpy.mock.calls.filter((call) => !RENDER_ENV_NOISE.test(String(call[0])));
}
