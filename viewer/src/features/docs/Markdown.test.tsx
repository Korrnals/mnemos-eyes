// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { Markdown } from "./Markdown";
import { extractHeadings } from "./headingSlug";
import { parseFrontmatter, stripLeadingH1 } from "./manifest";
import hostileRaw from "./__fixtures__/hostile.md?raw";

/**
 * Markdown.tsx gates (contract §9.2/§9.4, §10): gfm tables render, links
 * are classed (external → noopener/new tab, /docs → SPA Link), raw HTML
 * never becomes DOM, and the HOSTILE fixture produces no script/iframe/
 * event-handler nodes with http/https/mailto/#/relative-only hrefs.
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
