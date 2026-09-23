// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Sidebar } from "./Sidebar";
import { BoardAdapter } from "@/gateway/BoardAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { I18nProvider } from "@/i18n";

/**
 * UI-22 owner feedback («на телефоне не могу раскрыть левую панель»): the
 * sidebar expansion is STATE-driven (matchMedia seam), the toggle is visible
 * at EVERY width, and on <md the expanded panel is an OVERLAY — fixed over
 * the content with a translucent backdrop, Esc/backdrop close with the focus
 * returned to the toggle, body scroll locked while open, dialog semantics on
 * the panel. On >=md nothing changed: the toggle flips the persisted intent
 * (Shell owns the storage), the panel stays inline sticky.
 *
 * happy-dom answers matchMedia "no match" by default — exactly the phone
 * viewport, so the mobile describes run unstumped; the desktop describe
 * stubs a matching query (same seam as LoginDialog.flow.test.tsx).
 */

function stubMatchMedia(matches: boolean): void {
  const stub = (query: string) => ({
    matches,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  (globalThis as { matchMedia: unknown }).matchMedia = stub;
  (window as { matchMedia: unknown }).matchMedia = stub;
}

const mountedRoots: Root[] = [];

function click(element: HTMLElement) {
  act(() => {
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
}

/** Mount one Sidebar under the real chrome providers (fail-soft session —
 * no gate provider here, the mode line is not under test in this file). */
async function mountSidebar(options: {
  collapsed?: boolean;
  onToggle?: () => void;
} = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      <GatewayContext.Provider value={new BoardAdapter("/api")}>
        <QueryClientProvider
          client={
            new QueryClient({
              defaultOptions: { queries: { enabled: false, retry: false } },
            })
          }
        >
          <I18nProvider initialLang="ru">
            <MemoryRouter initialEntries={["/memory"]}>
              <Sidebar
                collapsed={options.collapsed ?? false}
                onToggle={options.onToggle ?? (() => undefined)}
              />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
  return { container };
}

function toggleButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Свернуть панель"], button[aria-label="Развернуть панель"]',
  );
  if (!button) throw new Error("sidebar toggle not found");
  return button;
}

function backdrop(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>("div[aria-hidden='true']");
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
});

describe("Sidebar on a phone (<md, UI-22)", () => {
  beforeEach(() => stubMatchMedia(false));

  it("the toggle is VISIBLE on the collapsed rail (the old md-only hide is gone)", async () => {
    const { container } = await mountSidebar({ collapsed: false });
    const toggle = toggleButton(container);
    expect(toggle.className).not.toContain("hidden");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("app-sidebar");
    // The default state on a phone is the icon rail — stored desktop
    // intent must not pre-open the overlay.
    const aside = container.querySelector("aside");
    expect(aside?.className).toContain("w-14");
    expect(aside?.className).not.toContain("w-64");
  });

  it("toggle click opens the OVERLAY: fixed box, dialog semantics, scroll lock, focus into the panel", async () => {
    const { container } = await mountSidebar({ collapsed: false });
    click(toggleButton(container));
    const aside = container.querySelector("aside");
    expect(aside?.className).toContain("fixed");
    expect(aside?.className).toContain("w-64");
    expect(aside?.getAttribute("role")).toBe("dialog");
    expect(aside?.getAttribute("aria-modal")).toBe("true");
    expect(aside?.getAttribute("aria-label")).toBe("Основная навигация");
    expect(toggleButton(container).getAttribute("aria-expanded")).toBe("true");
    // The translucent backdrop exists above the content.
    expect(backdrop(container)).not.toBeNull();
    // The document cannot scroll behind the overlay…
    expect(document.body.style.overflow).toBe("hidden");
    // …and focus moved INTO the panel (keyboard/SR land inside).
    expect(document.activeElement).toBe(aside);
  });

  it("Esc closes the overlay and returns focus to the toggle", async () => {
    const { container } = await mountSidebar({ collapsed: false });
    click(toggleButton(container));
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    const aside = container.querySelector("aside");
    expect(aside?.className).not.toContain("fixed");
    expect(aside?.getAttribute("role")).toBeNull();
    expect(backdrop(container)).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(toggleButton(container));
  });

  it("a backdrop click closes the overlay (and returns focus to the toggle)", async () => {
    const { container } = await mountSidebar({ collapsed: false });
    click(toggleButton(container));
    const shade = backdrop(container);
    expect(shade).not.toBeNull();
    click(shade as HTMLElement);
    expect(container.querySelector("aside")?.className).not.toContain("fixed");
    expect(document.activeElement).toBe(toggleButton(container));
  });

  it("a nav-link click closes the overlay — the content is never left covered", async () => {
    const { container } = await mountSidebar({ collapsed: false });
    click(toggleButton(container));
    const link = container.querySelector<HTMLElement>("nav a");
    expect(link).not.toBeNull();
    click(link as HTMLElement);
    expect(container.querySelector("aside")?.className).not.toContain("fixed");
    expect(document.body.style.overflow).toBe("");
  });

  it("the mobile toggle NEVER flips the persisted desktop intent", async () => {
    const onToggle = vi.fn();
    const { container } = await mountSidebar({ collapsed: false, onToggle });
    click(toggleButton(container)); // open
    click(toggleButton(container)); // close
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe("Sidebar on desktop (>=md, unchanged contract)", () => {
  beforeEach(() => stubMatchMedia(true));

  it("the toggle flips the PERSISTED intent; the panel stays inline sticky (no overlay)", async () => {
    const onToggle = vi.fn();
    const { container } = await mountSidebar({ collapsed: false, onToggle });
    expect(container.querySelector("aside")?.className).toContain("w-64");
    expect(container.querySelector("aside")?.className).not.toContain("fixed");
    expect(container.querySelector("aside")?.getAttribute("role")).toBeNull();
    expect(backdrop(container)).toBeNull();
    expect(document.body.style.overflow).toBe("");
    click(toggleButton(container));
    expect(onToggle).toHaveBeenCalledTimes(1);
    // The rail variant keeps its geometry and the expand affordance.
    const { container: rail } = await mountSidebar({ collapsed: true });
    expect(rail.querySelector("aside")?.className).toContain("w-14");
    expect(rail.querySelector("aside")?.className).toContain("sticky");
    expect(rail.querySelector("aside")?.className).not.toContain("fixed");
    expect(toggleButton(rail).getAttribute("aria-expanded")).toBe("false");
    expect(toggleButton(rail).getAttribute("aria-label")).toBe(
      "Развернуть панель",
    );
  });
});
