// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Sidebar } from "./Sidebar";
import { buildRoutes } from "@/app/routes";
import { BoardAdapter } from "@/gateway/BoardAdapter";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { ThemeProvider } from "@/components/theme-provider";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { DensityProvider } from "@/components/density-provider";
import { HotkeysProvider } from "@/layout/Hotkeys";
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
  path?: string;
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
            <MemoryRouter initialEntries={[options.path ?? "/memory"]}>
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

/** The docs third-layer list (project groups): the ul that OWNS the
 * vesmaro-eyes group row (the outer DocsSidebarGroups list). */
function docsGroupsList(container: HTMLElement): HTMLUListElement {
  const link = container.querySelector<HTMLAnchorElement>(
    'a[aria-label="vesmaro-eyes"]',
  );
  if (!link) throw new Error("docs project group not found");
  const list = link.closest("ul");
  if (!list) throw new Error("docs groups ul not found");
  return list;
}

/** The active project's category rows list: the ul nested in the group's li
 * (null in the rail — the rows do not render there at all). */
function docsCategoriesList(container: HTMLElement): HTMLUListElement | null {
  const link = container.querySelector<HTMLAnchorElement>(
    'a[aria-label="Устройства и подключение"]',
  );
  return link?.closest("ul") ?? null;
}

/** Focusables inside the sidebar panel (same attribute discipline as the
 * trap: no layout checks — happy-dom has none). */
function panelFocusables(panel: HTMLElement): HTMLElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>(
      "a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])",
    ),
  ).filter((el) => el.closest("[hidden], [aria-hidden='true']") === null);
}

function pressTab(shift = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
    shiftKey: shift,
  });
  act(() => {
    document.dispatchEvent(event);
  });
  return event;
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

describe("docs categories across the sidebar states (third layer × UI-22)", () => {
  beforeEach(() => stubMatchMedia(false));

  it("the phone rail shows the three groups WITHOUT category rows, ml-4 geometry", async () => {
    const { container } = await mountSidebar({
      collapsed: false,
      path: "/docs/c/devices",
    });
    // Groups are reachable by name…
    expect(container.querySelector('a[aria-label="vesmaro-eyes"]')).not.toBeNull();
    expect(container.querySelector('a[aria-label="Mnemos"]')).not.toBeNull();
    // …categories are NOT (the rail never pulls a second icon column).
    expect(
      container.querySelector('a[aria-label="Устройства и подключение"]'),
    ).toBeNull();
    // State-driven rail geometry: shallow indent, no border, no md: classes.
    const groups = docsGroupsList(container);
    expect(groups.className).toContain("ml-4");
    expect(groups.className).not.toContain("ml-7");
    expect(groups.className).not.toContain("md:");
    expect(groups.className).not.toContain("border-l");
  });

  it("the expanded mobile OVERLAY renders the active project's category rows (ml-7 bordered rail)", async () => {
    const { container } = await mountSidebar({
      collapsed: false,
      path: "/docs/c/devices",
    });
    click(toggleButton(container));
    // The active project's categories are visible to keyboard/SR users.
    const devices = container.querySelector(
      'a[aria-label="Устройства и подключение"]',
    );
    expect(devices).not.toBeNull();
    expect(devices?.getAttribute("title")).toBe("Устройства и подключение");
    // Group rail switched to the expanded geometry — from STATE, not md:.
    const groups = docsGroupsList(container);
    expect(groups.className).toContain("ml-7");
    expect(groups.className).toContain("border-l");
    expect(groups.className).not.toContain("md:");
    // The category list itself carries no CSS display toggling either.
    const categories = docsCategoriesList(container);
    expect(categories).not.toBeNull();
    expect(categories!.className).not.toContain("hidden");
    expect(categories!.className).not.toContain("md:");
  });
});

describe("sidebar focus trap (overlay only)", () => {
  it("on mobile, Tab cycles INSIDE the overlay panel and never reaches the page behind", async () => {
    stubMatchMedia(false);
    const { container } = await mountSidebar({ collapsed: false });
    click(toggleButton(container));
    const aside = container.querySelector("aside") as HTMLElement;
    const focusables = panelFocusables(aside);
    expect(focusables.length).toBeGreaterThan(1);

    // Focus opens on the panel itself; the first Tab hands it to the first
    // focusable (the header toggle).
    expect(document.activeElement).toBe(aside);
    pressTab();
    expect(document.activeElement).toBe(focusables[0]);

    // Forward cycle: from the LAST focusable, Tab wraps to the first —
    // the outside button stays untouched.
    const outside = document.createElement("button");
    outside.id = "outside-content";
    document.body.appendChild(outside);
    focusables[focusables.length - 1].focus();
    const wrapped = pressTab();
    expect(wrapped.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusables[0]);
    expect(document.activeElement).not.toBe(outside);

    // Backward cycle: Shift+Tab from the first lands on the last.
    pressTab(true);
    expect(document.activeElement).toBe(focusables[focusables.length - 1]);
    expect(document.activeElement).not.toBe(outside);

    // Leaked focus (programmatic or browser quirk) is pulled back inside.
    outside.focus();
    pressTab();
    expect(aside.contains(document.activeElement)).toBe(true);
  });

  it("on desktop, the inline panel does NOT trap: Tab is left to the browser", async () => {
    stubMatchMedia(true);
    const { container } = await mountSidebar({ collapsed: false });
    const aside = container.querySelector("aside");
    expect(aside?.getAttribute("role")).toBeNull(); // page chrome, not dialog
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    const event = pressTab();
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(outside); // nothing moved
  });
});

/**
 * ME-002 (background inert): the trap keeps TAB inside the dialog, but the
 * covered page also has to leave the ACCESSIBILITY tree (SR / virtual
 * cursor) — `inert` on everything except the dialog subtree. That wiring
 * lives in the Shell (skip link + content column) and the chrome surfaces,
 * so these tests mount the real Shell via buildRoutes — the Sidebar-only
 * harness above has no background to inert.
 */
async function mountShell(path = "/memory") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      <GatewayContext.Provider value={new MockAdapter({ latency: false })}>
        <QueryClientProvider
          client={
            new QueryClient({
              defaultOptions: { queries: { enabled: false, retry: false } },
            })
          }
        >
          <ThemeProvider>
            <AuthProvider adapterMode="mock" endpoint="/api">
              <I18nProvider initialLang="ru">
                <DensityProvider initialDensity="comfortable">
                  <HotkeysProvider>
                    <RouterProvider
                      router={createMemoryRouter(buildRoutes(), {
                        initialEntries: [path],
                      })}
                    />
                  </HotkeysProvider>
                </DensityProvider>
              </I18nProvider>
            </AuthProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
  return { container };
}

function skipLink(container: HTMLElement): HTMLAnchorElement | null {
  return container.querySelector<HTMLAnchorElement>("a[href='#main']");
}

describe("sidebar overlay inerts the background (ME-002, full Shell)", () => {
  beforeEach(() => {
    stubMatchMedia(false); // the phone viewport
    localStorage.clear();
  });

  it("while the overlay is open the covered page is inert; closed — nothing is", async () => {
    const { container } = await mountShell();
    await vi.waitFor(() => {
      expect(container.querySelector("aside")).not.toBeNull();
    });
    const main = container.querySelector("main");
    expect(main).not.toBeNull();
    // Closed rail: page chrome is fully live — no stray inert anywhere.
    expect(main!.closest("[inert]")).toBeNull();
    expect(skipLink(container)?.hasAttribute("inert")).toBe(false);

    click(toggleButton(container));
    const aside = container.querySelector("aside");
    expect(aside?.getAttribute("role")).toBe("dialog");
    // Everything the dialog covers leaves the a11y tree (and the pointer):
    // main, the skip link, the whole content column.
    expect(main!.closest("[inert]")).not.toBeNull();
    expect(skipLink(container)?.hasAttribute("inert")).toBe(true);
    expect(main!.parentElement?.hasAttribute("inert")).toBe(true);
    // …while the DIALOG subtree — the panel and the toggle that owns the
    // focus return — stays live (programmatic focus cannot enter an inert
    // ancestor, so inerting them would break the close path).
    expect(aside?.closest("[inert]")).toBeNull();
    expect(toggleButton(container).closest("[inert]")).toBeNull();

    // Esc closes: the background comes back to the tree and focus lands on
    // the toggle that opened the overlay.
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(aside?.getAttribute("role")).toBeNull();
    expect(main!.closest("[inert]")).toBeNull();
    expect(skipLink(container)?.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(toggleButton(container));
    expect(document.body.style.overflow).toBe("");
  });
});

