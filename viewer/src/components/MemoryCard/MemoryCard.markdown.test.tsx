// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

import { MemoryCard } from "./MemoryCard";
import { I18nProvider } from "@/i18n";
import type { Memory } from "@/gateway/types";

/**
 * UI-27 integration at the shared card primitive: MemoryCard is the list
 * representation consumed across the memory tree — its snippet renders
 * through the TextEngine primitive (markdown → compact formatted, clamped
 * to the 3-line card rhythm; plain → legacy pre-wrap output).
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function memoryFixture(overrides: Partial<Memory>): Memory {
  return {
    id: "mem-card-1",
    content: "",
    title: "Отчёт по корпусу",
    tags: [],
    source: "manual",
    memory_type: "note",
    project: "mnemos",
    agent: "zed",
    status: "published",
    quality_score: null,
    confidence: null,
    raw_content: null,
    clean_content: null,
    created_at: "2026-09-20T10:00:00Z",
    updated_at: "2026-09-20T10:00:00Z",
    marker_version: 1,
    metadata: {},
    ...overrides,
  };
}

async function mountCard(memory: Memory): Promise<HTMLDivElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider initialLang="en">
        <MemoryRouter>
          <MemoryCard memory={memory} />
        </MemoryRouter>
      </I18nProvider>,
    );
  });
  return container;
}

async function waitFor(what: string, probe: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  for (;;) {
    if (probe()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitFor(${what}) timed out; html: ${container!.innerHTML.slice(0, 400)}`);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

beforeEach(() => {
  container = null;
  root = null;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe("MemoryCard × TextEngine (UI-27)", () => {
  it("markdown snippet renders compact formatted, CSS-clamped to 3 lines", async () => {
    const el = await mountCard(
      memoryFixture({
        content: "Итог: **снято 142 задачи**.\n\n- фикстуры готовы\n- дифф пустой",
      }),
    );
    await waitFor("card strong", () => Boolean(el.querySelector("strong")));
    expect(el.querySelector("strong")?.textContent).toBe("снято 142 задачи");
    expect(el.querySelectorAll("li").length).toBe(2);
    // The card-level line clamp rides on the engine container.
    expect(el.innerHTML).toContain("line-clamp-3");
    // The card keeps ONE link action (the title) — no in-card expand button.
    expect(el.querySelector("button")).toBeNull();
  });

  it("plain snippet stays verbatim (no invented elements, no parser artifacts)", async () => {
    const el = await mountCard(
      memoryFixture({ content: "Простая запись памяти без разметки — просто текст." }),
    );
    const snippet = el.querySelector(".line-clamp-3");
    expect(snippet?.textContent).toContain("без разметки");
    // Only the card title is a heading — the snippet invents no elements.
    expect(snippet?.querySelector("strong, h1, h2, ul")).toBeNull();
  });
});
