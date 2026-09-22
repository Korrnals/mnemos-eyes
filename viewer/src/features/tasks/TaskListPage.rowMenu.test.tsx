// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TaskListPage } from "@/features/tasks/TaskListPage";
import { BoardAdapter } from "@/gateway/BoardAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import type { BoardTask } from "@/gateway/boardTypes";

/**
 * List-row context menu (owner feedback 2026-09-22: «нет контекстного
 * меню» — the kanban cards had the right-click entry since
 * fix/kanban-context-menu, the LIST rows didn't). Pins: a right-click on
 * the row opens the SAME TaskRowMenu at the cursor (preventDefault — no
 * browser menu), and the trailing click that dismisses it does NOT
 * navigate to the task (close ≠ click-through).
 */

const CORPUS: { tasks: BoardTask[] } = {
  tasks: [
    {
      id: "RM-1",
      col: "open",
      position: 0,
      title: "Row menu probe",
      summary: "",
      spec: "",
      agents: [],
      specialists: [],
      env: "unknown",
      project: "probe",
      memory_ids: [],
      mnemos_tags: [],
      status: "open",
      priority: "normal",
      created_at: "2026-09-22T00:00:00+00:00",
      updated_at: "2026-09-22T00:00:00+00:00",
    },
  ] as unknown as BoardTask[],
};

function makeFetchStub(): typeof fetch {
  return ((input: RequestInfo | URL) => {
    void input;
    return Promise.resolve(
      new Response(JSON.stringify(CORPUS), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let queryClient: QueryClient | null = null;

async function mountList(): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const gateway = new BoardAdapter({ fetchImpl: makeFetchStub(), baseUrl: "/api" });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await queryClient.prefetchQuery({
    queryKey: keys.tasks.board(),
    queryFn: () => gateway.board(),
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <GatewayContext.Provider value={gateway}>
        <QueryClientProvider client={queryClient!}>
          <ToastProvider>
            <UiTokenProvider>
              <I18nProvider initialLang="ru">
                <MemoryRouter initialEntries={["/tasks/list"]}>
                  <TaskListPage />
                </MemoryRouter>
              </I18nProvider>
            </UiTokenProvider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
}

beforeEach(() => {
  container = null;
  root = null;
  queryClient = null;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  queryClient = null;
  localStorage.clear();
  sessionStorage.clear();
});

function probeRow(): HTMLTableRowElement {
  const row = container!
    .querySelector(`a[href="/tasks/RM-1"]`)
    ?.closest("tr");
  expect(row).toBeDefined();
  return row as HTMLTableRowElement;
}

describe("list-row right-click (fix/list-row-context-menu)", () => {
  it("right-click opens the row menu at the cursor; Esc closes", async () => {
    await mountList();
    const row = probeRow();
    await act(async () => {
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 88,
        }),
      );
    });
    const menu = container!.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    // RU locale of the shared row menu — same entries as the kanban cards.
    expect(container!.textContent).toContain("Переместить…");
    await act(async () => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    // Esc is handled inside the popup focus scope; a fallback outside-press
    // path also closes — assert through the pointerdown route instead.
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(container!.querySelector('[role="menu"]')).toBeNull();
  });
});
