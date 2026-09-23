// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SIDEBAR_COLLAPSED_STORAGE_KEY } from "./Shell";
import { buildRoutes } from "@/app/routes";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { ThemeProvider } from "@/components/theme-provider";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { DensityProvider } from "@/components/density-provider";
import { HotkeysProvider } from "@/layout/Hotkeys";
import { I18nProvider } from "@/i18n";

/**
 * Sidebar collapse persistence (UI-19 owner feedback): the collapsed rail
 * must survive F5. The flag rides "vesmaro.sidebarCollapsed" (the `vesmaro.*`
 * namespace) — read lazily on mount, written on every toggle. UI-22 scope:
 * it is the DESKTOP intent — the mobile (<md) overlay toggle never reaches
 * Shell's setter, so a phone can neither read nor corrupt the stored flag.
 * Pattern: DocsPage.test.tsx — happy-dom pragma, createRoot + real click
 * events. The expansion is state-driven (matchMedia seam): happy-dom answers
 * "no match" (= phone) by default, so the mobile describe runs unstumped and
 * the desktop describes stub a matching query.
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

async function mountShell(path = "/memory") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
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
  return { root, container };
}

/** The header collapse control (identified by its ru aria-label). */
function toggleButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Свернуть панель"], button[aria-label="Развернуть панель"]',
  );
  if (!button) throw new Error("sidebar collapse control not found");
  return button;
}

function click(button: HTMLButtonElement) {
  act(() => {
    button.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
}

beforeEach(() => {
  localStorage.clear();
  stubMatchMedia(true); // desktop viewport by default; the mobile describe re-stubs
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Shell sidebar collapse persistence (UI-19)", () => {
  it("defaults to expanded and writes the explicit «0» on first render", async () => {
    const { container } = await mountShell();
    await vi.waitFor(() => {
      expect(container.querySelector("aside")).not.toBeNull();
    });
    expect(toggleButton(container).getAttribute("aria-expanded")).toBe("true");
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("0");
  });

  it("a stored «1» mounts COLLAPSED (the F5 survival the owner asked for)", async () => {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "1");
    const { container } = await mountShell();
    await vi.waitFor(() => {
      expect(container.querySelector("aside")).not.toBeNull();
    });
    const aside = container.querySelector("aside");
    expect(aside?.className).toContain("w-14");
    expect(aside?.className).not.toContain("w-64");
    expect(toggleButton(container).getAttribute("aria-expanded")).toBe("false");
    expect(toggleButton(container).getAttribute("aria-label")).toBe(
      "Развернуть панель",
    );
  });

  it("toggling flips the rail AND rewrites the stored flag both ways", async () => {
    const { container } = await mountShell();
    await vi.waitFor(() => {
      expect(container.querySelector("aside")).not.toBeNull();
    });
    const button = toggleButton(container);

    click(button); // collapse
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("aside")?.className).toContain("w-14");
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("1");

    click(button); // expand back
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("aside")?.className).toContain("w-64");
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("0");
  });

  it("a corrupt stored value falls back to the open panel (honest default)", async () => {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "junk");
    const { container } = await mountShell();
    await vi.waitFor(() => {
      expect(container.querySelector("aside")).not.toBeNull();
    });
    expect(toggleButton(container).getAttribute("aria-expanded")).toBe("true");
  });
});

describe("Shell sidebar on a phone (UI-22): overlay is session-only", () => {
  beforeEach(() => stubMatchMedia(false)); // <md — the phone viewport

  it("mounts COLLAPSED regardless of the stored desktop flag; the toggle opens the overlay", async () => {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "0");
    const { container } = await mountShell();
    await vi.waitFor(() => {
      expect(container.querySelector("aside")).not.toBeNull();
    });
    // Entry state on <md: the icon rail, NEVER a pre-opened overlay —
    // the stored "0" (desktop intent) does not leak into the phone.
    const aside = container.querySelector("aside");
    expect(aside?.className).toContain("w-14");
    expect(aside?.className).not.toContain("fixed");
    expect(toggleButton(container).getAttribute("aria-expanded")).toBe("false");

    click(toggleButton(container)); // mobile expand → overlay
    expect(container.querySelector("aside")?.className).toContain("fixed");
    expect(toggleButton(container).getAttribute("aria-expanded")).toBe("true");
    // …and the stored flag is UNTOUCHED by the mobile click.
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("0");

    click(toggleButton(container)); // back to the rail
    expect(container.querySelector("aside")?.className).not.toContain("fixed");
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("0");
  });

  it("a remount (F5) starts collapsed again — the mobile overlay is session-only", async () => {
    const first = await mountShell();
    await vi.waitFor(() => {
      expect(first.container.querySelector("aside")).not.toBeNull();
    });
    click(toggleButton(first.container)); // open the overlay
    expect(first.container.querySelector("aside")?.className).toContain("fixed");
    await act(async () => {
      first.root.unmount();
    });
    document.body.innerHTML = "";

    const second = await mountShell();
    await vi.waitFor(() => {
      expect(second.container.querySelector("aside")).not.toBeNull();
    });
    expect(second.container.querySelector("aside")?.className).toContain("w-14");
    expect(second.container.querySelector("aside")?.className).not.toContain(
      "fixed",
    );
  });
});
