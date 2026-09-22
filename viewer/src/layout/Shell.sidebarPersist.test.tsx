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
 * namespace) — read lazily on mount, written on every toggle. Pattern:
 * DocsPage.test.tsx — happy-dom pragma, createRoot + real click events.
 */

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
    expect(aside?.className).not.toContain("md:w-64");
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
    expect(container.querySelector("aside")?.className).toContain("md:w-64");
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
