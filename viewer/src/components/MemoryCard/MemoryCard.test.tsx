import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { MemoryCard } from "./MemoryCard";
import { MOCK_MEMORIES } from "@/gateway/fixtures";
import { I18nProvider } from "@/i18n";

/** renderToString keeps these tests DOM-free (node vitest env, no new deps).
 * English copy via initialLang — these tests pin copy, not the ru default. */
function render(memory: (typeof MOCK_MEMORIES)[number]): string {
  return renderToString(
    <MemoryRouter>
      <I18nProvider initialLang="en">
        <MemoryCard memory={memory} />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("MemoryCard", () => {
  it("renders title, stored status, tags and a deep link for a fixture memory", () => {
    const html = render(MOCK_MEMORIES[0]);
    expect(html).toContain("ADR: gateway via same-origin /api proxy");
    expect(html).toContain("published");
    expect(html).toContain("topic:gateway");
    expect(html).toContain('href="/memory/mem-0001"');
  });

  it("truncates the snippet to ~120 chars of effective content", () => {
    const html = render(MOCK_MEMORIES[0]);
    expect(html).toContain(
      "Viewer talks to mnemos through the same-origin /api prefix",
    );
  });

  it("falls back to a content-derived title when the memory has none", () => {
    const memory = {
      ...MOCK_MEMORIES[14],
      title: null,
    } as (typeof MOCK_MEMORIES)[number];
    const html = render(memory);
    // mem-0015 content head becomes the title; the id still links.
    expect(html).toContain("Checkpoint: L1 wave");
    expect(html).toContain('href="/memory/mem-0015"');
  });
});
