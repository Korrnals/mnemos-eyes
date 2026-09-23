// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Navigate, Route, Routes } from "react-router";

import { DocsPage } from "./DocsPage";
import { DocsHubPage } from "./DocsHubPage";
import { DocsCategoryPage } from "./DocsCategoryPage";
import { DocsCategoryLegacyRedirect } from "./DocsRedirects";
import { ZERO_RESULTS_KEY } from "./docsSearch";
import { loadMarkdown } from "./markdownModules";
import { I18nProvider } from "@/i18n";

/**
 * /docs pages under the three-hub IA (ADR 0016, design spec §4–§8, W1c):
 * articles render from project-scoped URLs, legacy /docs/<slug> redirects
 * into the default hub (replace, invisible), imported pages carry the
 * provenance badge, the locale badge works in BOTH directions, prev/next
 * stays inside the project, hubs are title-page covers with honest status
 * lines, and unknown URLs land on not-found with the CTA into the hub.
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
            <Route path="/docs" element={<Navigate to="/docs/vesmaro-eyes" replace />} />
            <Route path="/docs/c/:category" element={<DocsCategoryLegacyRedirect />} />
            <Route path="/docs/:project" element={<DocsHubPage />} />
            <Route
              path="/docs/:project/c/:category"
              element={<DocsCategoryPage />}
            />
            <Route path="/docs/:project/*" element={<DocsPage />} />
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

describe("our article (/docs/vesmaro-eyes/<slug>)", () => {
  it("renders chip, version badge, h1, body — no locale/provenance badges in ru", async () => {
    const { root, container } = await mountDocs("/docs/vesmaro-eyes/upgrade");
    await vi.waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("Обновление борда");
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Обслуживание"); // the category chip link
    expect(text).toContain("актуально для v1.13.0"); // last_verified badge
    expect(text).not.toContain("На языке оригинала");
    expect(text).not.toContain("из mnemos@"); // our pages carry no provenance
    await vi.waitFor(() => {
      expect(
        (container.querySelector("article")?.textContent ?? "").length,
      ).toBeGreaterThan(200);
    });
    root.unmount();
  });

  it("keeps one h1 per page (the body's own h1 is stripped)", async () => {
    const { root, container } = await mountDocs("/docs/vesmaro-eyes/tokens");
    await vi.waitFor(() => {
      expect(container.querySelector("article h1")).not.toBeNull();
    });
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    root.unmount();
  });

  it("UI=en over a bilingual own page renders the EN mirror — no «оригинал» badge (post-W3)", async () => {
    const { root, container } = await mountDocs("/docs/vesmaro-eyes/upgrade", "en");
    await vi.waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("Upgrading the board");
    });
    expect(container.textContent).not.toContain("In the original language");
    root.unmount();
  });
});

describe("imported article (/docs/mnemos/**, spec §6)", () => {
  it("renders the provenance badge after the version slot + category chip", async () => {
    const { root, container } = await mountDocs(
      "/docs/mnemos/user/getting-started",
    );
    await vi.waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("Начало работы");
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Пользователю"); // imported category chip
    expect(text).not.toContain("актуально для"); // no release badge upstream
    expect(text).toContain("из mnemos@23f0fce · синхр. 23.09");
    // Full form rides title/aria-label (whole SHA + dd.mm.yyyy).
    const badge = [...container.querySelectorAll("[title]")].find((element) =>
      element.getAttribute("title")?.startsWith("Импортировано из репозитория mnemos"),
    );
    expect(badge?.getAttribute("title")).toContain("23f0fce42ea87c329d4049397292b3dca948773c");
    expect(badge?.getAttribute("title")).toContain("23.09.2026");
    expect(badge?.getAttribute("aria-label")).toBe(badge?.getAttribute("title"));
    root.unmount();
  });

  it("ru UI over a mesh page: the curated ru translation renders, NOT badged as original (post-W3)", async () => {
    const { root, container } = await mountDocs(
      "/docs/mnemos-mesh/user/getting-started",
    );
    await vi.waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe(
        "Первый запуск mnemos-mesh",
      );
    });
    expect(container.textContent).not.toContain("На языке оригинала");
    root.unmount();
  });

  it("prev/next stays inside the project (no cross-project reading, spec §9.7)", async () => {
    const { root, container } = await mountDocs(
      "/docs/mnemos/user/getting-started",
    );
    await vi.waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("Начало работы");
    });
    const nav = container.querySelector("nav[aria-label='Навигация по страницам']");
    expect(nav).not.toBeNull();
    expect(nav?.textContent).not.toContain("Предыдущая"); // first in project
    expect(nav?.textContent).toContain("Следующая");
    const links = [...(nav?.querySelectorAll("a") ?? [])].map((link) =>
      link.getAttribute("href"),
    );
    expect(links).toEqual(["/docs/mnemos/user/integration-guide"]);
    root.unmount();
  });

  it("the LAST page of a project draws no next slot", async () => {
    const { root, container } = await mountDocs(
      "/docs/mnemos/architecture/overview",
    );
    await vi.waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toContain("Архитектура");
    });
    const nav = container.querySelector("nav[aria-label='Навигация по страницам']");
    expect(nav?.textContent).toContain("Предыдущая");
    expect(nav?.textContent).not.toContain("Следующая");
    root.unmount();
  });
});

describe("legacy redirects and misses (spec §8)", () => {
  it("old /docs/<slug> replaces into the default hub and renders the page", async () => {
    const { root, container } = await mountDocs("/docs/upgrade");
    await vi.waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("Обновление борда");
    });
    root.unmount();
  });

  it("old /docs/c/<category> replaces into the project-scoped category", async () => {
    const { root, container } = await mountDocs("/docs/c/security");
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Токены и доступ");
    });
    root.unmount();
  });

  it("unknown slug → not-found EmptyState with the CTA into the hub", async () => {
    const { root, container } = await mountDocs("/docs/vesmaro-eyes/nope");
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Такой страницы нет");
    });
    const cta = [...container.querySelectorAll("a")].find((link) =>
      link.textContent?.includes("Открыть документацию"),
    );
    expect(cta?.getAttribute("href")).toBe("/docs/vesmaro-eyes");
    root.unmount();
  });

  it("unknown project namespace → the same not-found (redirect-map miss)", async () => {
    const { root, container } = await mountDocs("/docs/ghost-project/page");
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Такой страницы нет");
    });
    root.unmount();
  });
});

describe("docs search combobox (design spec §8 + §7.3)", () => {
  it("finds pages by a prefix and Enter opens the active hit at its hub URL", async () => {
    const { root, container } = await mountDocs("/docs/vesmaro-eyes");
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

  it("zero results → honest empty text, hints and the localStorage log", async () => {
    const { root, container } = await mountDocs("/docs/vesmaro-eyes");
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
    // Post-W3 the corpus is fully bilingual → the locale-gap hint stays
    // silent (it names single-language pages, and none remain).
    expect(container.textContent).not.toContain("только на одном языке");
    const log = JSON.parse(localStorage.getItem(ZERO_RESULTS_KEY) ?? "[]");
    expect(log).toContain("квантомеханика");
    root.unmount();
  });
});

describe("hub covers (design spec §4)", () => {
  it("vesmaro-eyes hub: 9 category rows with counts, NO provenance badge", async () => {
    const { root, container } = await mountDocs("/docs/vesmaro-eyes");
    await vi.waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("vesmaro-eyes");
    });
    const text = container.textContent ?? "";
    expect(text).toContain("С чего начать");
    expect(text).toContain("Первый вход");
    expect(text).toContain("Категории");
    expect(container.querySelectorAll("a[href^='/docs/vesmaro-eyes/c/']")).toHaveLength(
      9,
    );
    expect(text).toContain("2 страницы"); // getting-started
    expect(text).not.toContain("из mnemos@"); // our docs carry no provenance
    root.unmount();
  });

  it("mnemos hub: bilingual coverage badge + provenance badge + 3 categories", async () => {
    const { root, container } = await mountDocs("/docs/mnemos");
    await vi.waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("Mnemos");
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Доступно на русском и английском");
    expect(text).toContain("из mnemos@23f0fce · синхр. 23.09");
    expect(container.querySelectorAll("a[href^='/docs/mnemos/c/']")).toHaveLength(3);
    // «С чего начать» links into the imported corpus.
    expect(
      container.querySelectorAll("a[href='/docs/mnemos/user/getting-started']").length,
    ).toBeGreaterThan(0);
    root.unmount();
  });

  it("mnemos-mesh hub: bilingual coverage after W3 curated translations", async () => {
    const { root, container } = await mountDocs("/docs/mnemos-mesh");
    await vi.waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("mnemos-mesh");
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Доступно на русском и английском");
    expect(text).toContain("из mnemos-mesh@331ef3a · синхр. 22.09");
    expect(container.querySelectorAll("a[href^='/docs/mnemos-mesh/c/']")).toHaveLength(
      2,
    );
    root.unmount();
  });
});

describe("category pages (project-scoped)", () => {
  it("lists pages with version stamps and hub-scoped links", async () => {
    const { root, container } = await mountDocs("/docs/vesmaro-eyes/c/security");
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Токены и доступ");
    });
    const links = [...container.querySelectorAll("a[href]")].map((link) =>
      link.getAttribute("href"),
    );
    expect(links).toContain("/docs/vesmaro-eyes/tokens");
    const raw = (await loadMarkdown("token-rotation", "ru")) ?? "";
    const verified = raw.match(/last_verified:\s*"([^"]+)"/)?.[1];
    expect(verified, "token-rotation declares last_verified").toBeTruthy();
    expect(container.textContent).toContain(`v${verified}`);
    root.unmount();
  });

  it("a cross-project category URL is a miss → not-found", async () => {
    const { root, container } = await mountDocs("/docs/mnemos/c/security");
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Такой страницы нет");
    });
    root.unmount();
  });

  it("an imported category lists its upstream pages", async () => {
    const { root, container } = await mountDocs("/docs/mnemos/c/mnemos-admin");
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Администратору");
      expect(
        container.querySelectorAll("a[href^='/docs/mnemos/admin/']").length,
      ).toBeGreaterThanOrEqual(3);
    });
    root.unmount();
  });
});
