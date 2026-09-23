// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SettingsHubPage } from "./SettingsHubPage";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ThemeProvider, THEME_STORAGE_KEY, LEGACY_THEME_STORAGE_KEY } from "@/components/theme-provider";
import { DensityProvider, DENSITY_STORAGE_KEY } from "@/components/density-provider";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import { MOTION_STORAGE_KEY, setMotion } from "@/lib/motionStore";
import {
  setSidebarCollapsed,
  toggleSidebarCollapsed,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
} from "@/lib/sidebarState";
import { BOARD_STYLE_STORAGE_KEY } from "@/features/tasks/tasksViewPrefs";
import { setBoardStyle } from "@/lib/boardStyleStore";
import type { ExecutorsPage } from "@/gateway/boardTypes";

/**
 * UI-23 hub v2 (spec §3, acceptance §8): one h1 + six anchored sibling
 * sections under a sticky anchor menu; every local control drives the SAME
 * provider/store as the context controls (one state, two controls); verdicts
 * render as native <details>; the onboarding replay resets the AGW-4 flag.
 */

const NOW = Date.now();
const ago = (seconds: number): string => new Date(NOW - seconds * 1000).toISOString();

async function mountHub(
  path = "/system/settings",
): Promise<{ root: Root; container: HTMLElement }> {
  const gateway = new MockAdapter({ latency: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page: ExecutorsPage = await gateway.listExecutors();
  client.setQueryData(keys.agents.executors.list(), {
    ...page,
    items: page.items.map((row) =>
      row.id === "exec-laptop-zcode" ? { ...row, last_seen: ago(30) } : row,
    ),
  });
  await client.prefetchQuery({
    queryKey: keys.automation.settings(),
    queryFn: () => gateway.getAutomationSettings(),
  });
  await client.prefetchQuery({
    queryKey: keys.automation.status(),
    queryFn: () => gateway.automationStatus(),
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <GatewayContext.Provider value={gateway}>
        <QueryClientProvider client={client}>
          <ToastProvider>
            <UiTokenProvider>
              <I18nProvider initialLang="en">
                {/* happy-dom matchMedia is not deterministic → theme stub. */}
                <ThemeProvider>
                  <DensityProvider initialDensity="comfortable">
                    <MemoryRouter initialEntries={[path]}>
                      <SettingsHubPage />
                    </MemoryRouter>
                  </DensityProvider>
                </ThemeProvider>
              </I18nProvider>
            </UiTokenProvider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
  return { root, container };
}

function sectionButton(
  container: HTMLElement,
  sectionId: string,
  label: string,
): HTMLButtonElement {
  const scope = container.querySelector(`#${sectionId}`);
  if (!scope) throw new Error(`section #${sectionId} not found`);
  const button = [...scope.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`button "${label}" not found in #${sectionId}`);
  return button;
}

function press(container: HTMLElement, sectionId: string, label: string): void {
  act(() => {
    sectionButton(container, sectionId, label).click();
  });
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.density;
  delete document.documentElement.dataset.motion;
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("SettingsHubPage v2 — structure (spec §3.1, acceptance §8.1)", () => {
  it("renders ONE h1, the sticky anchor menu and all seven anchored sections", async () => {
    const { root, container } = await mountHub();
    const h1s = container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe("Settings");

    const menu = container.querySelector('nav[aria-label="Page sections"]');
    expect(menu).not.toBeNull();
    expect(menu?.className).toContain("sticky");
    const links = [...menu!.querySelectorAll("a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(links).toEqual([
      "#appearance",
      "#behavior",
      "#board",
      "#navigation",
      "#execution",
      "#automation",
      // §A.7 pointer: device access management lives on /system/devices.
      "#devices",
    ]);

    for (const anchor of [
      "appearance",
      "behavior",
      "board",
      "navigation",
      "execution",
      "automation",
      "devices",
    ]) {
      const section = container.querySelector(`#${anchor}`);
      expect(section, `#${anchor}`).not.toBeNull();
    }
    const headings = [...container.querySelectorAll("h2")].map((node) =>
      node.textContent?.trim(),
    );
    expect(headings).toEqual(
      expect.arrayContaining([
        "Appearance",
        "Behavior",
        "Board",
        "Navigation",
        "Execution",
        "Automation",
        "Devices",
      ]),
    );
    root.unmount();
  });

  it("composes «Исполнение» verbatim: both selects live inside #execution", async () => {
    const { root, container } = await mountHub();
    const execution = container.querySelector("#execution")!;
    expect(execution.querySelector("#execution-default")).not.toBeNull();
    expect(execution.querySelector("#execution-fallback")).not.toBeNull();
    root.unmount();
  });
});

describe("Appearance — theme is three-state and live (§8.2)", () => {
  it("System is pressed by default; picking Dark/Light applies <html> immediately", async () => {
    const { root, container } = await mountHub();
    expect(
      sectionButton(container, "appearance", "System").getAttribute("aria-pressed"),
    ).toBe("true");

    press(container, "appearance", "Dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBeUndefined(); // dark = no attr

    press(container, "appearance", "Light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    root.unmount();
  });

  it("«System» removes the new AND the legacy record (fallback must not resurrect)", async () => {
    localStorage.setItem(LEGACY_THEME_STORAGE_KEY, "light");
    const { root, container } = await mountHub();
    press(container, "appearance", "Light"); // explicit write first
    press(container, "appearance", "System");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBeNull();
    expect(
      sectionButton(container, "appearance", "System").getAttribute("aria-pressed"),
    ).toBe("true");
    root.unmount();
  });
});

describe("Appearance — language and density are one state with the top bar", () => {
  it("language switching persists and mirrors <html lang>", async () => {
    const { root, container } = await mountHub();
    press(container, "appearance", "RU"); // EN is the mounted initial
    expect(document.documentElement.lang).toBe("ru");
    expect(localStorage.getItem("vesmaro.lang")).toBe("ru");
    expect(
      sectionButton(container, "appearance", "RU").getAttribute("aria-pressed"),
    ).toBe("true");
    root.unmount();
  });

  it("density flips <html data-density> on the same page (§8.4)", async () => {
    const { root, container } = await mountHub();
    press(container, "appearance", "Compact");
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe("compact");
    expect(
      sectionButton(container, "appearance", "Compact").getAttribute("aria-pressed"),
    ).toBe("true");
    root.unmount();
  });
});

describe("Board + Navigation + Behavior — one state, two controls (§4.3)", () => {
  it("board style: hub click writes the store; a board-side write flips the hub", async () => {
    const { root, container } = await mountHub();
    press(container, "board", "Classic");
    expect(localStorage.getItem(BOARD_STYLE_STORAGE_KEY)).toBe("classic");
    expect(
      sectionButton(container, "board", "Classic").getAttribute("aria-pressed"),
    ).toBe("true");

    // The kanban toggle's write path — the hub control follows instantly.
    act(() => setBoardStyle("groups"));
    expect(
      sectionButton(container, "board", "Groups").getAttribute("aria-pressed"),
    ).toBe("true");
    root.unmount();
  });

  it("sidebar: hub control and the sidebar button drive one store (§8.6)", async () => {
    const { root, container } = await mountHub();
    act(() => setSidebarCollapsed(false)); // deterministic start
    press(container, "navigation", "Collapsed");
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("1");
    expect(
      sectionButton(container, "navigation", "Collapsed").getAttribute("aria-pressed"),
    ).toBe("true");

    // The sidebar button's write path — the hub control follows instantly.
    act(() => toggleSidebarCollapsed());
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("0");
    expect(
      sectionButton(container, "navigation", "Expanded").getAttribute("aria-pressed"),
    ).toBe("true");
    root.unmount();
  });

  it("motion: «Minimal» persists and forces [data-motion=reduced]; «System» clears", async () => {
    const { root, container } = await mountHub();
    press(container, "behavior", "Minimal");
    expect(localStorage.getItem(MOTION_STORAGE_KEY)).toBe("reduced");
    expect(document.documentElement.dataset.motion).toBe("reduced");

    act(() => setMotion("system")); // the store's own write path
    expect(localStorage.getItem(MOTION_STORAGE_KEY)).toBe("system");
    expect(document.documentElement.dataset.motion).toBeUndefined();
    root.unmount();
  });

  it("onboarding replay resets the AGW-4 flag and confirms (§8.8)", async () => {
    localStorage.setItem("vesmaro.agents.onboardingDone", "1");
    const { root, container } = await mountHub();
    const replay = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("How it works"),
    );
    expect(replay).toBeDefined();
    act(() => replay!.click());
    expect(localStorage.getItem("vesmaro.agents.onboardingDone")).toBe("0");
    expect(
      container.querySelector('p[role="status"]')?.textContent,
    ).toContain("expand again on the Execution page");
    root.unmount();
  });
});

describe("Verdict blocks (spec §3.4, acceptance §8.10)", () => {
  it("four native <details> carry all 14 reasoned refusals", async () => {
    const { root, container } = await mountHub();
    const details = container.querySelectorAll("details");
    expect(details).toHaveLength(4);
    for (const block of details) {
      expect(block.querySelector("summary")?.textContent).toBe("Not customizable");
    }

    // 2 + 7 + 3 + 2 = 14 verdict lines across the sections.
    const verdicts = [...container.querySelectorAll("details li")].map((li) =>
      li.textContent,
    );
    expect(verdicts).toHaveLength(14);
    expect(verdicts.some((text) => text?.includes("never reloads on its own"))).toBe(
      true,
    );
    expect(verdicts.some((text) => text?.includes("drag-and-drop"))).toBe(true);
    expect(verdicts.some((text) => text?.includes("routes, not a preference"))).toBe(
      true,
    );
    root.unmount();
  });

  it("a collapsed details still exposes its content to find-in-page/DOM", async () => {
    const { root, container } = await mountHub();
    const fonts = [...container.querySelectorAll("details li")].find((li) =>
      li.textContent?.includes("Typography"),
    );
    expect(fonts).toBeDefined(); // present in the DOM while collapsed
    root.unmount();
  });
});
