// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { Markdown } from "./Markdown";
import { extractHeadings } from "./headingSlug";
import { getManifest, parseFrontmatter, stripLeadingH1 } from "./manifest";
import hostileRaw from "./__fixtures__/hostile.md?raw";

/**
 * Markdown.tsx gates (contract §9.2/§9.4, §10): gfm tables render, links
 * are classed (external → noopener/new tab, /docs → SPA Link), corpus-internal
 * references resolve through the manifest (W1c), raw HTML never becomes DOM,
 * and the HOSTILE fixture produces no script/iframe/event-handler nodes with
 * http/https/mailto/#/relative-only hrefs.
 */

function render(source: string): string {
  return renderToString(
    <MemoryRouter>
      <Markdown source={source} />
    </MemoryRouter>,
  );
}

/** Parse rendered markup into a DOM tree (DOMParser never executes scripts). */
function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("markdown rendering", () => {
  it("renders gfm tables (header row, alignment)", () => {
    const html = render("| a | b |\n| --- | :-: |\n| 1 | 2 |\n");
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain("<td");
  });

  it("classes links: external gets noopener + new tab, /docs stays a SPA Link", () => {
    const html = render(
      "[ext](https://example.com/x) [int](/docs/tokens) [anchor](#intro)\n",
    );
    const external =
      /<a[^>]*href="https:\/\/example\.com\/x"[^>]*>/.exec(html)?.[0] ?? "";
    expect(external).toContain('rel="noopener noreferrer"');
    expect(external).toContain('target="_blank"');
    const internal = /<a[^>]*href="\/docs\/tokens"[^>]*>/.exec(html)?.[0] ?? "";
    expect(internal).not.toContain('target="_blank"');
    expect(internal).not.toContain("noopener");
  });

  it("creates NO elements from raw HTML (no rehype-raw)", () => {
    const doc = parseHtml(
      render('hello <script>alert(1)</script> <img src="x" onerror="a()">\n'),
    );
    expect(doc.querySelector("script")).toBeNull();
    expect(doc.querySelector("img")).toBeNull();
    expect(doc.querySelector("body")?.getAttribute("onerror")).toBeNull();
    // No element carries an inline event handler — nothing was attached.
    const withHandlers = [...doc.querySelectorAll("*")].filter((element) =>
      [...element.attributes].some((attribute) => attribute.name.startsWith("on")),
    );
    expect(withHandlers).toEqual([]);
  });

  it("gives h2/h3 GitHub-style slug anchors with scroll margin", () => {
    const html = render("## Перед обновлением\n\n### Шаг 2: проверка!\n");
    expect(html).toContain('id="перед-обновлением"');
    expect(html).toContain('id="шаг-2-проверка"');
    expect(html).toContain("scroll-mt-24");
  });

  it("dedupes heading slugs GitHub-style", () => {
    const items = extractHeadings("## Установка\n\n### Установка\n\n## Установка\n");
    expect(items.map((item) => item.id)).toEqual([
      "установка",
      "установка-1",
      "установка-2",
    ]);
  });

  it("wraps fenced code with a copy affordance and language label", () => {
    const html = render("```bash\nhelm upgrade mnemos\n```\n");
    expect(html).toContain("<pre");
    expect(html).toContain("bash");
    expect(html).toContain("helm upgrade mnemos");
    expect(html).toContain('aria-live="polite"');
  });
});

describe("corpus link internalization (W1c)", () => {
  const warnSpy = vi.spyOn(console, "warn");

  afterEach(() => {
    warnSpy.mockClear();
  });

  function renderWithSlug(source: string, pageSlug: string): string {
    return renderToString(
      <MemoryRouter>
        <Markdown source={source} pageSlug={pageSlug} />
      </MemoryRouter>,
    );
  }

  it("resolves our relative slug.md references through the manifest", async () => {
    await getManifest(); // the resolver reads the hydrated manifest
    const html = renderWithSlug("[токены](tokens.md)\n", "pairing");
    const href = /href="([^"]*)"/.exec(html)?.[1];
    expect(href).toBe("/docs/vesmaro-eyes/tokens");
  });

  it("resolves upstream board slugs (sync form) into project-scoped URLs", async () => {
    await getManifest();
    const html = renderWithSlug(
      "[http api](mnemos/user/http-api) [mesh](mnemos-mesh/user/configuration)\n",
      "mnemos/user/getting-started",
    );
    expect(html).toContain('href="/docs/mnemos/user/http-api"');
    expect(html).toContain('href="/docs/mnemos-mesh/user/configuration"');
  });

  it("keeps #anchors on internalized links", async () => {
    await getManifest();
    const html = renderWithSlug(
      "[stats](mnemos/user/cli-reference#stats)\n",
      "mnemos/user/sync",
    );
    expect(html).toContain('href="/docs/mnemos/user/cli-reference#stats"');
  });

  it("styles unresolvable .md refs as broken and warns (no crash)", async () => {
    await getManifest();
    const html = renderWithSlug("[призрак](ghost-page.md)\n", "pairing");
    const anchor = /<a[^>]*href="ghost-page\.md"[^>]*>/.exec(html)?.[0] ?? "";
    expect(anchor).toContain("text-foreground-muted"); // broken styling
    expect(
      warnSpy.mock.calls.some((call) => String(call[0]).includes("ghost-page.md")),
    ).toBe(true);
  });

  it("leaves external .md URLs external (never corpus-broken)", async () => {
    await getManifest();
    const html = renderWithSlug(
      "[contrib](https://github.com/example/repo/blob/abcdef/CONTRIBUTING.md)\n",
      "mnemos/user/sync",
    );
    const anchor = /<a[^>]*href="https:\/\/github\.com[^"]*"[^>]*>/.exec(html)?.[0] ?? "";
    expect(anchor).toContain('rel="noopener noreferrer"');
    expect(anchor).toContain('target="_blank"');
  });
});

describe("upstream typography (W1c spec §9)", () => {
  it("renders h5 with the text-sm/medium look (order preserved, no TOC entry)", () => {
    const html = render("##### Тонкий заголовок\n");
    expect(html).toContain("<h5");
    expect(html).toContain("text-sm");
    expect(html).not.toContain('id="тонкий-заголовок"'); // TOC stays h2/h3
  });

  it("keeps wide tables scrollable inside their wrapper (72ch measure holds)", () => {
    const html = render(
      "| col1 | col2 | col3 |\n| --- | --- | --- |\n| a | b | c |\n",
    );
    const table = /<div[^>]*>[\s\S]*?<table/.exec(html)?.[0] ?? "";
    expect(table).toContain("overflow-x-auto");
  });
});

describe("hostile fixture gate (contract §9.2)", () => {
  // Same preparation as a real page: frontmatter off, leading h1 off.
  const hostileBody = stripLeadingH1(parseFrontmatter(hostileRaw)!.body);
  const doc = parseHtml(render(hostileBody));

  it("renders no script/iframe/img nodes into the tree", () => {
    expect(doc.querySelector("script")).toBeNull();
    expect(doc.querySelector("iframe")).toBeNull();
    expect(doc.querySelector("img")).toBeNull();
  });

  it("renders no event-handler attributes", () => {
    const withHandlers = [...doc.querySelectorAll("*")].filter((element) =>
      [...element.attributes].some((attribute) => attribute.name.startsWith("on")),
    );
    expect(withHandlers).toEqual([]);
  });

  it("keeps hrefs on the safe schemes only", () => {
    const hrefs = [...doc.querySelectorAll("a[href]")].map((anchor) =>
      anchor.getAttribute("href"),
    );
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href === "" || /^(https?:|mailto:|#|\/)/.test(href ?? "")).toBe(true);
    }
    // The javascript: vector is neutralized — its anchor carries no href.
    const bad = [...doc.querySelectorAll("a")].find(
      (anchor) => anchor.textContent === "bad link",
    );
    expect(bad?.getAttribute("href")).toBeNull();
  });
});
