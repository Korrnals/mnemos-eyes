import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { PulseFeed, PulseSkeleton } from "./PulseFeed";
import { I18nProvider } from "@/i18n";
import type { MemoryPulseItem } from "@/gateway/boardTypes";

/**
 * Ф1 state-matrix gate (QA verdict §3): the pulse feed covers the honest
 * states — recency feed with server provenance badges, degraded-store note,
 * the loading skeleton, and the token-bound airy row rhythm (§3.3).
 */
function renderFeed(ui: React.ReactElement): string {
  return renderToString(
    <I18nProvider initialLang="en">
      <MemoryRouter>{ui}</MemoryRouter>
    </I18nProvider>,
  );
}

const ITEMS: MemoryPulseItem[] = [
  {
    id: "m-1",
    title: "Shell plan",
    tags: ["topic:convergence"],
    status: "published",
    created_at: "2026-09-19T10:00:00Z",
    server: "store-a",
  },
  {
    id: "m-2",
    title: "",
    tags: [],
    status: "processed",
    created_at: "2026-09-19T09:00:00Z",
    server: "store-b",
  },
];

describe("PulseFeed", () => {
  it("renders every item with its provenance badge, status and detail link", () => {
    const html = renderFeed(<PulseFeed items={ITEMS} />);
    expect(html).toContain("store-a");
    expect(html).toContain("store-b");
    expect(html).toContain("Shell plan");
    expect(html).toContain('href="/memory/m-1"');
    // Untitled rows say so honestly; status words are localized per badge.
    expect(html).toContain("untitled");
    expect(html).toContain("published");
    expect(html).toContain("processed");
  });

  it("shows the degraded-stores note only when a store failed", () => {
    const healthy = renderFeed(
      <PulseFeed
        items={ITEMS}
        perServer={[{ server: "store-a", ok: true, items: 2, detail: null }]}
      />,
    );
    expect(healthy).not.toContain("did not answer");
    const degraded = renderFeed(
      <PulseFeed
        items={ITEMS}
        perServer={[
          { server: "store-a", ok: true, items: 2, detail: null },
          { server: "store-b", ok: false, items: 0, detail: "boom" },
        ]}
      />,
    );
    expect(degraded).toContain("Some stores did not answer");
    expect(degraded).toContain("store-b");
  });

  it("compact cut drops the tag row (Overview strip)", () => {
    const full = renderFeed(<PulseFeed items={ITEMS} />);
    const compact = renderFeed(<PulseFeed items={ITEMS} compact />);
    expect(full).toContain("topic:convergence");
    expect(compact).not.toContain("topic:convergence");
  });

  it("consumes the airy row token — rows never follow the density toggle", () => {
    const html = renderFeed(<PulseFeed items={ITEMS} />);
    expect(html).toContain("min-h-row-airy");
    // The density-driven operational token (exact class token) must NOT be
    // present: pulse is a contemplative surface (concept §3.3).
    expect(html).not.toMatch(/min-h-row(?!-)/);
    expect(html).toContain("space-y-list-gap");
  });
});

describe("PulseSkeleton", () => {
  it("mirrors the row rhythm and stays decorative", () => {
    const html = renderFeed(<PulseSkeleton rows={3} />);
    expect(html).toContain('aria-hidden="true"');
    expect(html.match(/min-h-row-airy/g)?.length).toBe(3);
  });
});
