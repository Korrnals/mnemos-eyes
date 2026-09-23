// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AssignmentDrawer } from "./AssignmentDrawer";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import { UI_TOKEN_STORAGE_KEY } from "@/gateway/uiToken";
import { MOCK_ASSIGNMENTS } from "@/gateway/boardFixtures";
import type { TaskReports } from "@/gateway/boardTypes";

/**
 * UI-27 + owner clamp directive on the assignment drawer: the final-report
 * preview is author text — it renders through the TextEngine primitive
 * (markdown formatted, never raw syntax) with the measured clamp
 * («Show full text» only when the content overflows, replacing the old
 * hard line-clamp-4 cut). Radix portals the dialog into document.body —
 * queries go to the DOCUMENT (AssignExecutorSheet.test posture).
 */

const MARKDOWN_FINAL = [
  "## Итог",
  "",
  "Корпус снят: **142 задачи**, форма зафиксирована.",
].join("\n");

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mountDrawer(finalBody: string): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  sessionStorage.setItem(UI_TOKEN_STORAGE_KEY, "dev-token");
  const gateway = new MockAdapter({ latency: false });
  // Patch the shared reports query: the task's last final is a markdown
  // agent report (the real-world shape).
  gateway.reports = (async (): Promise<TaskReports> => ({
    ok: true,
    task_id: "TB-1",
    count: 1,
    items: [
      {
        id: 99,
        task_id: "TB-1",
        kind: "final",
        agent: "zcode",
        body: finalBody,
        superseded: false,
        created_at: "2026-09-21T10:00:00+00:00",
      },
    ],
  })) as unknown as MockAdapter["reports"];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await queryClient.prefetchQuery({
    queryKey: keys.tasks.reports.detail("TB-1"),
    queryFn: () => gateway.reports("TB-1"),
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
                <MemoryRouter>
                  <AssignmentDrawer
                    row={MOCK_ASSIGNMENTS[0]}
                    executorName={(id) => id}
                    onCancel={vi.fn()}
                    onRetry={vi.fn()}
                    onClose={vi.fn()}
                  />
                </MemoryRouter>
              </I18nProvider>
            </UiTokenProvider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
}

async function waitFor(what: string, probe: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  for (;;) {
    if (probe()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitFor(${what}) timed out; html: ${document.body.innerHTML.slice(0, 600)}`);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

async function click(target: Element | null | undefined): Promise<void> {
  expect(target, "interaction target must exist").toBeDefined();
  await act(async () => {
    (target as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(() => {
  sessionStorage.clear();
  container = null;
  root = null;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe("AssignmentDrawer report preview × TextEngine clamp", () => {
  it("final report renders markdown formatted, never raw syntax", async () => {
    await mountDrawer(MARKDOWN_FINAL);
    // Wait on the rendered heading itself — the lazy markdown chunk lands
    // after mount (plain-text fallback prints raw until then).
    await waitFor("markdown heading", () =>
      Boolean([...document.querySelectorAll("h2")].find((h) => h.textContent === "Итог")),
    );
    expect(document.querySelector("strong")?.textContent).toBe("142 задачи");
    expect(document.body.textContent).not.toContain("## Итог");
    expect(document.body.textContent).not.toContain("**142 задачи**");
  });

  it("no expand button while the preview fits", async () => {
    // No stubs: happy-dom reports zero heights, so nothing «overflows».
    await mountDrawer(MARKDOWN_FINAL);
    await waitFor("report heading", () => Boolean(document.querySelector("h2")));
    expect(document.querySelector(".max-h-48")).not.toBeNull();
    const expand = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Show full text",
    );
    expect(expand).toBeUndefined();
  });

  it("overflowing preview shows «Show full text»; expanding removes the cut", async () => {
    const proto = HTMLElement.prototype as unknown as Record<
      string,
      PropertyDescriptor | undefined
    >;
    const savedOffset = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
    const savedClient = Object.getOwnPropertyDescriptor(proto, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => 500,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 192,
    });
    try {
      await mountDrawer(MARKDOWN_FINAL);
      await waitFor("expand button", () =>
        Boolean(
          [...document.querySelectorAll("button")].find(
            (b) => b.textContent === "Show full text",
          ),
        ),
      );
      const expand = [...document.querySelectorAll("button")].find(
        (b) => b.textContent === "Show full text",
      );
      await click(expand);
      expect(document.querySelector(".max-h-48")).toBeNull();
      expect(
        [...document.querySelectorAll("button")].find(
          (b) => b.textContent === "Show full text",
        ),
      ).toBeUndefined();
      // The report body stays rendered after the expand.
      expect(
        [...document.querySelectorAll("h2")].find((h) => h.textContent === "Итог"),
      ).toBeDefined();
    } finally {
      delete (HTMLElement.prototype as { offsetHeight?: unknown }).offsetHeight;
      delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight;
      if (savedOffset) Object.defineProperty(HTMLElement.prototype, "offsetHeight", savedOffset);
      if (savedClient) Object.defineProperty(HTMLElement.prototype, "clientHeight", savedClient);
    }
  });
});
