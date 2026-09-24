// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { buildRoutes } from "@/app/routes";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { I18nProvider } from "@/i18n";
import { HotkeysProvider } from "@/layout/Hotkeys";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import { DensityProvider } from "@/components/density-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { AuthProvider } from "@/features/auth/AuthProvider";

/**
 * BE-13 viewer gate: the drill's «Записи» section must render the HONEST
 * LISTING for the tag — same rows, same recency order, same coverage as
 * `listMemories({ tags })` (the wire `GET /memories?tags=`) — with no
 * search-ranker subset note (the BE-13 caveat is closed, not hidden).
 */

const TAG = "project:mnemos-eyes";

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let router: ReturnType<typeof createMemoryRouter> | null = null;

async function mount(path: string): Promise<MockAdapter> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const gateway = new MockAdapter({ latency: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  router = createMemoryRouter(buildRoutes(), { initialEntries: [path] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <GatewayContext.Provider value={gateway}>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <AuthProvider adapterMode="mock" endpoint="/api">
              <I18nProvider initialLang="en">
                <DensityProvider initialDensity="comfortable">
                  <HotkeysProvider>
                    <ToastProvider>
                      <UiTokenProvider>
                        <RouterProvider router={router!} />
                      </UiTokenProvider>
                    </ToastProvider>
                  </HotkeysProvider>
                </DensityProvider>
              </I18nProvider>
            </AuthProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
  return gateway;
}

async function waitFor(what: string, probe: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (probe()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitFor(${what}) timed out; page text: ${container!.textContent?.slice(0, 300)}`);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

/** Card title links in the «Записи» section only, in DOM (render) order. */
function memoryLinks(): HTMLAnchorElement[] {
  // The id lives on the section's h2 — resolve to the enclosing section.
  const section = container!.querySelector("#tag-drill-memories")?.closest("section");
  if (!section) return [];
  // One path segment after /memory/ — the card detail links, not any nested
  // tag links a card body could carry.
  return [...section.querySelectorAll<HTMLAnchorElement>("a")].filter((anchor) =>
    /^\/memory\/[^/?]+/.test(anchor.getAttribute("href") ?? ""),
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  router = null;
});

describe("BE-13: the drill memories are the honest tag listing", () => {
  it("renders exactly listMemories({tags}) — same ids, same recency order", async () => {
    const gateway = await mount(`/memory/tags?tag=${encodeURIComponent(TAG)}`);
    await waitFor("drill memories", () => memoryLinks().length > 0);

    // The expected listing comes from the SAME adapter method the «Записи»
    // list uses — the rows the drill shows are literally the listing rows.
    const listed = await gateway.listMemories({ tags: TAG, limit: 12 });
    expect(listed.length).toBeGreaterThan(3); // the corpus must make the point

    const rendered = memoryLinks().map((anchor) =>
      decodeURIComponent((anchor.getAttribute("href") ?? "").split("?")[0]!),
    );
    expect(rendered).toEqual(listed.map((memory) => `/memory/${memory.id}`));
  });

  it("keeps the listing escape and drops the closed BE-13 subset note", async () => {
    await mount(`/memory/tags?tag=${encodeURIComponent(TAG)}`);
    await waitFor("drill memories", () => memoryLinks().length > 0);

    // The caveat said the drill «rides the search ranker and may be
    // incomplete» — that is no longer true, and a stale honesty note is a
    // dishonesty of its own. It must be GONE, not hidden.
    const text = container!.textContent ?? "";
    expect(text.toLowerCase()).not.toContain("subset");

    // The full listing (pagination included) stays one click away.
    const escape = [...container!.querySelectorAll<HTMLAnchorElement>("a")].find((a) =>
      (a.getAttribute("href") ?? "").startsWith(`/memory?tag=`),
    );
    expect(escape).toBeDefined();
    expect(escape!.getAttribute("href")).toBe(`/memory?tag=${encodeURIComponent(TAG)}`);
  });
});
