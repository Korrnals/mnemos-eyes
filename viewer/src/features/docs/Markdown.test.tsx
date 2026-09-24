// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { Markdown } from "./Markdown";
import { extractHeadings } from "./headingSlug";
import { getManifest, parseFrontmatter, stripLeadingH1 } from "./manifest";
import hostileRaw from "./__fixtures__/hostile.md?raw";

/**
 * Markdown.tsx gates (contract §9.2/§9.4, §10; raw-HTML pipeline per
 * АРХКОМ-8): gfm tables render, links are classed (external → noopener/new
 * tab, /docs → SPA Link), corpus-internal references resolve through the
 * manifest (W1c), leading provenance banners are cut, and raw HTML renders
 * ONLY through the raw→sanitize pipeline — the HOSTILE fixture produces no
 * dangerous nodes (script/iframe/object/embed/form/style/svg, non-checkbox
 * inputs, javascript: hrefs, style/on* attributes) while markdown-native
 * and GitHub-parity elements (p/tables/headings/lists, details/summary) and
 * `language-*` classes on code SURVIVE.
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

  it("sanitizes raw HTML through the pipeline (dangerous nodes never reach the DOM)", () => {
    const doc = parseHtml(
      render('hello <script>alert(1)</script> <img src="x" onerror="a()">\n'),
    );
    // script is dropped WHOLE (strip=[] — its source must not leak as text).
    expect(doc.querySelector("script")).toBeNull();
    expect(doc.body.textContent).not.toContain("alert(1)");
    // img IS allowed (defaultSchema-minus, GitHub parity) — but bare of
    // handlers; its relative src passes the protocol gate.
    const image = doc.querySelector("img");
    expect(image?.getAttribute("onerror")).toBeNull();
    // No element carries an inline event handler — nothing was attached.
    const withHandlers = [...doc.querySelectorAll("*")].filter((element) =>
      [...element.attributes].some((attribute) => attribute.name.startsWith("on")),
    );
    expect(withHandlers).toEqual([]);
  });

  it("renders GitHub-parity raw HTML (details/summary) after sanitization", () => {
    const doc = parseHtml(
      render(
        "<details open><summary>Что внутри</summary><p>Тело</p></details>\n",
      ),
    );
    expect(doc.querySelector("details")?.hasAttribute("open")).toBe(true);
    expect(doc.querySelector("summary")?.textContent).toBe("Что внутри");
    expect(doc.querySelector("p")?.textContent).toBe("Тело");
  });

  it("keeps markdown-native elements alive next to raw HTML (anti mini-allowlist)", () => {
    const doc = parseHtml(
      render(
        "## Заголовок\n\nАбзац текста.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- пункт\n\n<em>сырой</em>\n",
      ),
    );
    expect(doc.querySelector("h2")?.textContent).toBe("Заголовок");
    expect(doc.querySelector("p")?.textContent).toBe("Абзац текста.");
    expect(doc.querySelector("table")).not.toBeNull();
    expect(doc.querySelector("li")?.textContent).toBe("пункт");
    expect(doc.querySelector("em")?.textContent).toBe("сырой");
  });

  it("keeps the language label for raw code, drops injected class tokens", () => {
    const doc = parseHtml(
      render(
        '<pre><code class="language-python evil-token">x=1</code></pre>\n\n<span class="language-evil">inj</span>\n',
      ),
    );
    // The language survives as the CodeBlock LABEL (our own pre/code markup
    // carries no class by design); the injected token is nowhere.
    const label = doc.querySelector("div > span")?.textContent;
    expect(label).toBe("python");
    expect(doc.body.textContent).not.toContain("evil-token");
    const span = [...doc.querySelectorAll("span")].find(
      (candidate) => candidate.textContent === "inj",
    );
    expect(span?.getAttribute("class")).toBeNull();
  });

  it("cuts leading GENERATED/curated banner comments before the pipeline", () => {
    const doc = parseHtml(
      render("<!-- GENERATED by sync_docs -->\n<!-- curated note -->\n\nТело.\n"),
    );
    expect(doc.body.textContent).not.toContain("GENERATED");
    // A mid-body comment is NOT the banner case — the sanitizer drops it.
    const withMidComment = parseHtml(
      render("Абзац один.\n\n<!-- mid-body -->\n\nАбзац два.\n"),
    );
    expect(withMidComment.querySelector("p")?.textContent).toBe("Абзац один.");
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

describe("hostile fixture gate (contract §9.2, АРХКОМ-8)", () => {
  // Same preparation as a real page: frontmatter off, leading h1 off.
  // SSR (renderToString): effects never run, so mermaid fences stay in
  // their loader-fallback form — the source, never a diagram.
  const hostileBody = stripLeadingH1(parseFrontmatter(hostileRaw)!.body);
  const doc = parseHtml(render(hostileBody));

  // OUR chrome (lucide icons inside CodeBlock buttons) legitimately contains
  // svgs and style attrs — hostile asserts target CONTENT, not the app.
  const ownChrome = (element: Element): boolean =>
    element.closest('svg[class*="lucide"]') !== null ||
    ((element.tagName.toLowerCase() === "svg" &&
      (element.getAttribute("class") ?? "").includes("lucide")) as boolean);

  it("renders no script/iframe/object/embed/form/style/content-svg nodes", () => {
    for (const tag of ["script", "iframe", "object", "embed", "form", "style"]) {
      expect(doc.querySelector(tag), `<${tag}> reached the DOM`).toBeNull();
    }
    const contentSvgs = [...doc.querySelectorAll("svg")].filter(
      (svg) => !ownChrome(svg),
    );
    expect(contentSvgs, "a content <svg> reached the DOM").toEqual([]);
  });

  it("renders no hostile comment nodes and no banner text", () => {
    // React SSR emits framework markers (<!--$-->) — only hostile CONTENT
    // comments are banned here.
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
    const comments: string[] = [];
    while (walker.nextNode() !== null) {
      comments.push(walker.currentNode.nodeValue ?? "");
    }
    const hostile = comments.filter((value) =>
      /GENERATED|curated|sync_docs|mid-body/.test(value),
    );
    expect(hostile).toEqual([]);
    expect(doc.body.textContent).not.toContain("GENERATED");
    expect(doc.body.textContent).not.toContain("curated");
    expect(doc.body.textContent).not.toContain("alert(");
    expect(doc.body.textContent).not.toContain("hostile-injected-style");
  });

  it("coerces every input into a disabled checkbox (GFM task list, nothing else)", () => {
    const inputs = [...doc.querySelectorAll("input")];
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input.getAttribute("type")).toBe("checkbox");
      expect(input.hasAttribute("disabled")).toBe(true);
    }
  });

  it("renders no event-handler, style, or srcset attributes outside our chrome", () => {
    for (const element of [...doc.querySelectorAll("*")]) {
      if (ownChrome(element)) continue;
      for (const attribute of [...element.attributes]) {
        expect(
          attribute.name.startsWith("on"),
          `${attribute.name} on ${element.tagName}`,
        ).toBe(false);
        // The ONLY style attribute our own markup may carry is the mono
        // font (design spec §1) — any other value is a schema breach.
        if (attribute.name === "style") {
          expect(attribute.value).toMatch(/^font-family:\s*var\(--font-mono\)$/);
        }
        expect(attribute.name).not.toBe("srcset");
        expect(attribute.name).not.toBe("srcSet");
      }
    }
  });

  it("keeps hrefs on the safe schemes only (javascript:/data: neutralized)", () => {
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
    // So is the data:text/html one.
    const data = [...doc.querySelectorAll("a")].find(
      (anchor) => anchor.textContent === "data link",
    );
    expect(data?.getAttribute("href")).toBeNull();
  });

  it("keeps GitHub-parity tags alive and class injections out", () => {
    // details/summary survive; their ontoggle did not (covered above).
    expect(doc.querySelector("details > summary")?.textContent).toContain(
      "details survive",
    );
    expect(doc.querySelector("kbd")).not.toBeNull();
    expect(doc.querySelector("sub")).not.toBeNull();
    expect(doc.querySelector("sup")).not.toBeNull();
    // language-python on raw code survives as the label; the injected token
    // does not appear anywhere.
    expect(doc.body.textContent).toContain("python");
    expect(doc.body.textContent).not.toContain("evil-token");
    const span = [...doc.querySelectorAll("span")].find(
      (candidate) => candidate.textContent === "class injection outside code",
    );
    expect(span?.getAttribute("class")).toBeNull();
  });

  it("falls back to the source for the giant mermaid fence (no crash, no svg)", () => {
    const contentSvgs = [...doc.querySelectorAll("svg")].filter(
      (svg) => !ownChrome(svg),
    );
    expect(contentSvgs).toEqual([]);
    // The oversized fence source stays visible (maxTextSize exceeded →
    // fallback), including its last generated edge.
    expect(doc.body.textContent).toContain("N0001 --> M0001");
    expect(doc.body.textContent).toContain("N1400 --> M1400");
  });
});
