// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TaskDetailPage } from "./TaskDetailPage";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";

/**
 * ME-005 header gate at the DOM level: an archived row (resolved through the
 * BE-16 fallback GET) is read-only — NO Edit/resume affordances in the
 * rendered tree, while the tab links stay. Assertions run as role+name
 * DOM queries (buttons/links in the live tree), not SSR-label strings, so
 * the gate survives markup and locale changes (ME5-3); the en labels below
 * are pinned by the provider, matching the i18n contract under test.
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** Buttons by accessible name — the icon is aria-hidden, the label is the
 * text; equivalent to `queryAllByRole("button", { name })`. */
function buttonsNamed(name: string): HTMLElement[] {
  return Array.from(document.querySelectorAll("button")).filter(
    (button) => button.textContent?.trim() === name,
  );
}

/** Mount one task detail route with the board projection + BE-16 fallback
 * GET pre-seeded (the archived id is missed by the projection on purpose). */
async function mountDetail(taskId: string, seedDetail: boolean): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const gateway = new MockAdapter({ latency: false });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await queryClient.prefetchQuery({
    queryKey: keys.tasks.board(),
    queryFn: () => gateway.board(),
  });
  if (seedDetail) {
    await queryClient.prefetchQuery({
      queryKey: keys.tasks.detail(taskId),
      queryFn: () => gateway.taskById(taskId),
    });
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <GatewayContext.Provider value={gateway}>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <UiTokenProvider>
              <I18nProvider initialLang="en">
                <MemoryRouter initialEntries={[`/tasks/${taskId}`]}>
                  <Routes>
                    <Route path="/tasks/:id" element={<TaskDetailPage />} />
                  </Routes>
                </MemoryRouter>
              </I18nProvider>
            </UiTokenProvider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
  // Let the tab queries settle so the gate is asserted on the settled
  // header, not a loading frame.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("TaskDetailPage — archived rows are read-only (ME-005)", () => {
  it("an archived row renders NO Edit/resume buttons; tabs and content stay", async () => {
    await mountDetail("RB-1", true);

    expect(buttonsNamed("Edit")).toHaveLength(0);
    expect(buttonsNamed("Resume")).toHaveLength(0);
    // The read-only contract keeps every other affordance: tab links (with
    // their ?return= inheritance) remain on the archived row.
    expect(document.querySelector('a[href="/tasks/RB-1?tab=memory"]')).not.toBeNull();
    expect(document.querySelector('a[href="/tasks/RB-1?tab=reports"]')).not.toBeNull();
    // And the archived content itself is on screen (the fallback GET path).
    expect(container!.textContent).toContain("регистрац");
  });

  it("the ACTIVE row keeps its Edit/resume affordances (gate is the flag, not capability)", async () => {
    // The mock is mutation-capable either way; this positive control proves
    // the queries above can SEE the buttons when the gate allows them.
    await mountDetail("TB-1", false);

    expect(buttonsNamed("Edit")).toHaveLength(1);
    expect(buttonsNamed("Resume")).toHaveLength(1); // TB-1 has a live final
  });
});
