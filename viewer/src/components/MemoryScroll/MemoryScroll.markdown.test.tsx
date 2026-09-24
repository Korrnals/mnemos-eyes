// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MemoryScroll } from "./MemoryScroll";
import { I18nProvider } from "@/i18n";
import type { Memory } from "@/gateway/types";

/**
 * UI-27 integration: the /memory/:id scroll renders its effective content
 * through the TextEngine primitive — markdown formats, plain stays plain —
 * and the RAW toggle keeps showing the source verbatim (pre-wrap, no
 * markdown elements): the raw view is the owner's explicit «как лежит».
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mountScroll(memory: Memory): Promise<HTMLDivElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider initialLang="en">
        <MemoryScroll memory={memory} showRaw={false} onToggleRaw={() => {}} />
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

function memoryFixture(overrides: Partial<Memory>): Memory {
  return {
    id: "mem-md-1",
    content: "",
    title: "Правило сборки",
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

const MARKDOWN_BODY = "# Правило\n\nСборка **зелёная** перед пушем.\n\n- фикстуры\n- дифф";

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

describe("MemoryScroll × TextEngine (UI-27)", () => {
  it("markdown content renders formatted elements in the scroll", async () => {
    const el = await mountScroll(memoryFixture({ content: MARKDOWN_BODY }));
    await waitFor("h1 from markdown", () => Boolean(el.querySelector("h1 + div h1, [class*='text-md'] h1")));
    expect(el.querySelector("strong")?.textContent).toBe("зелёная");
    expect(el.querySelectorAll("li").length).toBe(2);
  });

  it("plain content keeps the legacy pre-wrap output", async () => {
    const el = await mountScroll(
      memoryFixture({ content: "Простая запись.\nВторая строка — обычный текст." }),
    );
    // No markdown detected → the plain path, verbatim output.
    expect(el.textContent).toContain("Вторая строка — обычный текст.");
    expect(el.querySelector("strong")).toBeNull();
    expect(el.innerHTML).toContain("whitespace-pre-wrap");
  });

  it("raw variant renders verbatim (no markdown elements), effective renders formatted", async () => {
    const rawBody = "## Сырой источник\n\nс **двойными** звёздами";
    const cleanBody = "## Чистая версия\n\nmarkdown **отформатирован**";
    const memory = memoryFixture({
      content: cleanBody,
      clean_content: cleanBody,
      raw_content: rawBody,
    });
    // Effective (showRaw=false) → formatted.
    const el = await mountScroll(memory);
    await waitFor("formatted strong", () => Boolean(el.querySelector("strong")));
    expect(el.querySelector("strong")?.textContent).toBe("отформатирован");
    // Raw → the toggle re-render must show the SOURCE as plain text.
    await act(async () => {
      root!.render(
        <I18nProvider initialLang="en">
          <MemoryScroll memory={memory} showRaw onToggleRaw={() => {}} />
        </I18nProvider>,
      );
    });
    expect(el.textContent).toContain("## Сырой источник");
    expect(el.textContent).toContain("**двойными**");
    expect(el.querySelector("strong")).toBeNull();
  });
});
