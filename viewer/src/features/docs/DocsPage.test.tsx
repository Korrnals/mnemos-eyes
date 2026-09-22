// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";

import { DocsPage } from "./DocsPage";
import { DocsIndexPage } from "./DocsIndexPage";
import { DocsCategoryPage } from "./DocsCategoryPage";
import { ZERO_RESULTS_KEY } from "./docsSearch";
import { loadMarkdown } from "./markdownModules";
import { I18nProvider } from "@/i18n";

/**
 * /docs pages (contract §10): article render from a slug, unknown slug →
 * not-found with the «Все категории» CTA, prev/next in manifest order, and
 * the header search combobox (results + Enter navigation + zero-result log).
 * Pattern: AutomationPage.test.tsx — happy-dom pragma, createRoot +
 * MemoryRouter; gateway mocks are NOT needed (docs is backend-independent).
 */

async function mountDocs(path: string, lang: "ru" | "en" = "ru") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider initialLang={lang}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/docs" element={<DocsIndexPage />} />
            <Route path="/docs/c/:category" element={<DocsCategoryPage />} />
            <Route path="/docs/:slug" element={<DocsPage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );
  });
  return { root, container };
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressKey(element: Element, key: string) {
  act(() => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

beforeEach(() => {
  localStorage.clear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("article /docs/:slug", () => {
  it("renders the article from the manifest: chip, version badge, h1, body", async () => {
    const { root, container } = await mountDocs("/docs/upgrade");
    await vi.waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("Обновление борда");
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Обслуживание"); // the category chip link
    expect(text).toContain("актуально для v1.13.0"); // last_verified badge
    // No locale badge under a ru UI (contract §6 — the fallback is en-only).
    expect(text).not.toContain("Доступно на русском");
    await vi.waitFor(() => {
      expect(
        (container.querySelector("article")?.textContent ?? "").length,
      ).toBeGreaterThan(200);
    });
    root.unmount();
  });

  it("keeps one h1 per page (the body's own h1 is stripped)", async () => {
    const { root, container } = await mountDocs("/docs/tokens");
    await vi.waitFor(() => {
      expect(container.querySelector("article h1")).not.toBeNull();
    });
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    root.unmount();
  });

  it("unknown slug → not-found EmptyState with the CTA to /docs", async () => {
    const { root, container } = await mountDocs("/docs/nope");
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Такой страницы нет");
    });
    const cta = [...container.querySelectorAll("a")].find((link) =>
      link.textContent?.includes("Все категории"),
    );
    expect(cta?.getAttribute("href")).toBe("/docs");
    root.unmount();
  });

  it("prev/next follow the manifest order (upgrade sits between backup and troubleshooting)", async () => {
    const { root, container } = await mountDocs("/docs/upgrade");
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Бэкап и восстановление");
    });
    const nav = container.querySelector("nav[aria-label='Навигация по страницам']");
    expect(nav).not.toBeNull();
    expect(nav?.textContent).toContain("Предыдущая");
    expect(nav?.textContent).toContain("Следующая");
    const links = [...(nav?.querySelectorAll("a") ?? [])].map((link) =>
      link.getAttribute("href"),
    );
    expect(links).toContain("/docs/backup-restore");
    expect(links).toContain("/docs/troubleshooting");
    root.unmount();
  });

  it("first page has no prev slot (крайние страницы не рисуют пустой слот)", async () => {
    // Wave 2: the product category opens the reading order — its first page
    // is the new крайняя страница (deploy now sits behind glossary).
    const { root, container } = await mountDocs("/docs/what-is-mnemos");
    await vi.waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("Что такое mnemos");
    });
    const nav = container.querySelector("nav[aria-label='Навигация по страницам']");
    const links = [...(nav?.querySelectorAll("a") ?? [])].map((link) =>
      link.getAttribute("href"),
    );
    expect(links).toEqual(["/docs/what-is-vesmaro-eyes"]); // next only
    root.unmount();
  });

  it("UI=en over a ru-only page shows the neutral locale badge", async () => {
    const { root, container } = await mountDocs("/docs/upgrade", "en");
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Available in Russian only");
    });
    root.unmount();
  });
});

describe("docs search combobox (design spec §8)", () => {
  it("finds pages by a prefix («токен» → both token pages) and Enter opens the active hit", async () => {
    const { root, container } = await mountDocs("/docs");
    const input = await vi.waitFor(() => {
      const found = container.querySelector<HTMLInputElement>("input[role='combobox']");
      expect(found).not.toBeNull();
      return found!;
    });
    setInput(input, "токен");
    const listbox = await vi.waitFor(() => {
      const list = container.querySelector("ul[role='listbox']");
      expect(list).not.toBeNull();
      return list!;
    });
    // Prefix match covers «Токены…» AND «…токенов» (contract §7).
    expect(listbox.textContent).toContain("Токены и доступ");
    expect(listbox.textContent).toContain("Ротация токенов");
    const activeOption = listbox.querySelector("[role='option'][aria-selected='true']");
    expect(activeOption).not.toBeNull();
    pressKey(input, "Enter");
    await vi.waitFor(() => {
      const h1 = container.querySelector("h1")?.textContent ?? "";
      expect(["Токены и доступ", "Ротация токенов"]).toContain(h1);
    });
    root.unmount();
  });

  it("zero results → honest empty text, hint and the localStorage log", async () => {
    const { root, container } = await mountDocs("/docs");
    const input = await vi.waitFor(() => {
      const found = container.querySelector<HTMLInputElement>("input[role='combobox']");
      expect(found).not.toBeNull();
      return found!;
    });
    setInput(input, "квантомеханика");
    await vi.waitFor(() => {
      expect(container.textContent).toContain("ничего не найдено");
    });
    expect(container.textContent).toContain("Попробуйте одно слово");
    const log = JSON.parse(localStorage.getItem(ZERO_RESULTS_KEY) ?? "[]");
    expect(log).toContain("квантомеханика");
    root.unmount();
  });

  it("Esc closes the list and focus stays in the field", async () => {
    const { root, container } = await mountDocs("/docs");
    const input = await vi.waitFor(() => {
      const found = container.querySelector<HTMLInputElement>("input[role='combobox']");
      expect(found).not.toBeNull();
      return found!;
    });
    setInput(input, "токен");
    await vi.waitFor(() => {
      expect(container.querySelector("ul[role='listbox']")).not.toBeNull();
    });
    act(() => {
      input.focus();
    });
    pressKey(input, "Escape");
    expect(container.querySelector("ul[role='listbox']")).toBeNull();
    expect(document.activeElement).toBe(input);
    root.unmount();
  });
});

describe("index and category pages", () => {
  it("index lists all 9 categories with pluralized page counts", async () => {
    const { root, container } = await mountDocs("/docs");
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Начало работы");
    });
    const text = container.textContent ?? "";
    expect(text).toContain("О продукте"); // wave-2: first card
    expect(text).toContain("Что такое mnemos");
    expect(text).toContain("2 страницы"); // getting-started
    expect(text).toContain("3 страницы"); // product/maintenance
    expect(text).toContain("1 страница"); // board/agents/…
    expect(container.querySelectorAll("a[href^='/docs/c/']")).toHaveLength(9);
    root.unmount();
  });

  it("category page lists its pages with version stamps", async () => {
    const { root, container } = await mountDocs("/docs/c/security");
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Токены и доступ");
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Ротация токенов");
    // The stamp must mirror the page's own frontmatter, not a pinned number.
    const raw = (await loadMarkdown("token-rotation", "ru")) ?? "";
    const verified = raw.match(/last_verified:\s*"([^"]+)"/)?.[1];
    expect(verified, "token-rotation declares last_verified").toBeTruthy();
    expect(text).toContain(`v${verified}`);
    root.unmount();
  });
});
