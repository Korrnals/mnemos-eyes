// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SettingsHubPage } from "./SettingsHubPage";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import type { ExecutorsPage } from "@/gateway/boardTypes";

/**
 * UI-21 hub structure (spec 2026-09-23 §1, acceptance §6.1/6.9): exactly
 * ONE h1 «Настройки», three sibling sections with deep-linkable anchors,
 * «Исполнение» reused verbatim (its selects live here), «Интерфейс» is
 * cross-links only — the /tasks row is a real navigation, the chrome rows
 * point at affordances already on screen.
 */

const NOW = Date.now();
const ago = (seconds: number): string => new Date(NOW - seconds * 1000).toISOString();

async function mountHub(
  path = "/system/settings",
): Promise<{ root: Root; container: HTMLElement }> {
  const gateway = new MockAdapter({ latency: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seed the executor registry with fresh presence so the «Исполнение»
  // section renders its selects with the mock corpus rows.
  const page: ExecutorsPage = await gateway.listExecutors();
  client.setQueryData(keys.agents.executors.list(), {
    ...page,
    items: page.items.map((row) =>
      row.id === "exec-laptop-zcode"
        ? { ...row, last_seen: ago(30) }
        : row.id === "exec-old-poller"
          ? { ...row, last_seen: ago(2 * 3600) }
          : row,
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
                <MemoryRouter initialEntries={[path]}>
                  <SettingsHubPage />
                </MemoryRouter>
              </I18nProvider>
            </UiTokenProvider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
  return { root, container };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SettingsHubPage — /system/settings structure (UI-21)", () => {
  it("renders exactly ONE h1 and the three anchored sibling sections", async () => {
    const { root, container } = await mountHub();
    const h1s = container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe("Settings");

    for (const anchor of ["execution", "automation", "interface"]) {
      expect(container.querySelector(`#${anchor}`)).not.toBeNull();
    }
    const headings = [...container.querySelectorAll("h2")].map((node) =>
      node.textContent?.trim(),
    );
    expect(headings).toContain("Execution");
    expect(headings).toContain("Automation");
    expect(headings).toContain("Interface");
    root.unmount();
  });

  it("composes «Исполнение» verbatim: both selects render inside #execution", async () => {
    const { root, container } = await mountHub();
    const execution = container.querySelector("#execution")!;
    expect(execution.querySelector("#execution-default")).not.toBeNull();
    expect(execution.querySelector("#execution-fallback")).not.toBeNull();
    root.unmount();
  });

  it("«Автоматизация» shows the honest engine-off stanza in the hub", async () => {
    const { root, container } = await mountHub();
    expect(container.textContent).toContain("Engine not enabled");
    expect(container.querySelector("#automation-enabled")).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>("#automation-cap")!.value).toBe(
      "10",
    );
    root.unmount();
  });

  it("«Интерфейс» lists the four preferences; the board row navigates to /tasks", async () => {
    const { root, container } = await mountHub();
    const text = container.textContent ?? "";
    expect(text).toContain("These preferences live where you use them:");
    expect(text).toContain("language — RU|EN in the top bar");
    expect(text).toContain("density — the button in the top bar");
    expect(text).toContain("board style — the toggle on the tasks page");
    expect(text).toContain("sidebar — the button on the sidebar itself");
    // The one real navigation target; the chrome rows are on-screen
    // affordances (top bar, sidebar) and intentionally NOT links.
    const link = container.querySelector<HTMLAnchorElement>('a[href="/tasks"]');
    expect(link?.textContent).toContain("board style");
    root.unmount();
  });
});
