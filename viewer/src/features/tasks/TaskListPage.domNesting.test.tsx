// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TaskListPage } from "@/features/tasks/TaskListPage";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";

/**
 * ME-008: DOM validity / a11y of the list page's links. The mobile card-row
 * used to nest the active-assignment badge `<a>` INSIDE the card `<a>` —
 * invalid HTML (browsers may reparent it), broken link semantics (a link
 * target inside a link target) and permanent validateDOMNesting console
 * noise. The card anchor and the badge anchor are siblings now; this pins:
 * React never logs validateDOMNesting while rendering the page, the mounted
 * DOM contains no `<a>` descendant of an `<a>`, and both honest targets
 * survive (card → the task; badge → its «Исполнение» tab, UI-18 pair 6).
 *
 * Client render (createRoot in happy-dom) is REQUIRED here: SSR
 * renderToString does not run React's validateDOMNesting, so only a real
 * mount can observe the warning (the console spy) and the live DOM shape.
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mountList(): Promise<{ errors: string[]; spy: ReturnType<typeof vi.spyOn> }> {
  const errors: string[] = [];
  const spy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
  // act(...) support — same harness contract as TaskListPage.rowMenu.test.tsx.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const gateway = new MockAdapter({ latency: false });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Seed the board AND the assignments list (the badge chip renders only
  // with an active attempt — TB-1 has a queued one in the corpus).
  await queryClient.prefetchQuery({
    queryKey: keys.tasks.board(),
    queryFn: () => gateway.board(),
  });
  await queryClient.prefetchQuery({
    queryKey: keys.agents.assignments.list({}),
    queryFn: () => gateway.listAssignments(),
  });
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
                <MemoryRouter initialEntries={["/tasks"]}>
                  <TaskListPage />
                </MemoryRouter>
              </I18nProvider>
            </UiTokenProvider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
  return { errors, spy };
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("TaskListPage DOM nesting (ME-008)", () => {
  it("renders no <a> inside <a> — React stays silent, DOM is flat", async () => {
    const { errors, spy } = await mountList();
    try {
      // 1. React's own validator must have nothing to say.
      expect(errors.join("\n")).not.toContain("validateDOMNesting");
      // 2. The mounted DOM itself: no anchor descendant of an anchor
      //    (querySelector walks real DOM, independent of any validator).
      expect(container!.querySelectorAll("a a").length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("card link and badge link are sibling anchors with distinct targets", async () => {
    const { spy } = await mountList();
    try {
      // EVERY badge chip (desktop row AND mobile card render both) is its
      // own anchor NOT nested in another anchor (closest from the PARENT —
      // closest on the anchor itself would match the anchor).
      const badges = container!.querySelectorAll<HTMLAnchorElement>(
        'a[href*="/tasks/TB-1?tab=execution"]',
      );
      expect(badges.length).toBeGreaterThan(0);
      badges.forEach((badge) => {
        expect(badge.parentElement?.closest("a")).toBeNull();
      });
      expect(badges[0].getAttribute("href")).toBe(
        "/tasks/TB-1?tab=execution&return=%2Ftasks",
      );
      // The card/title anchor into the task is still there beside it.
      const card = container!.querySelector<HTMLAnchorElement>(
        'a[href^="/tasks/TB-1?return="]',
      );
      expect(card).not.toBeNull();
      expect(card!.parentElement?.closest("a")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
