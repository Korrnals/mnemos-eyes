// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TaskBoardPage } from "@/features/tasks/TaskBoardPage";
import { BoardAdapter } from "@/gateway/BoardAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { ToastViewport } from "@/components/Toast/ToastViewport";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import { DensityProvider } from "@/components/density-provider";
import { UI_TOKEN_STORAGE_KEY } from "@/gateway/uiToken";
import type { BoardTask } from "@/gateway/boardTypes";
import type * as useTasksModule from "@/features/tasks/useTasks";

// Test-env seam (documented, not a product change — see LoginDialog.flow):
// useReportCounts re-renders on every cache event and cycles against
// react-query's notifyManager under happy-dom's synchronous act(); mocking
// only the badge counts keeps the board, the gate, the wire and the cache real.
vi.mock("@/features/tasks/useTasks", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof useTasksModule;
  return { ...actual, useReportCounts: () => ({}) };
});

/**
 * Kanban card context menu (fix/kanban-context-menu — owner feedback
 * «где всё контекстное меню??»): the cards carry the SAME ⋯ menu as the
 * list rows (TaskRowMenu), with two entries —
 * - the ⋯ trigger (hover/focus-revealed, tab-reachable, aria-labelled);
 * - the card right-click (onContextMenu + preventDefault → popup at the
 *   cursor, viewport-clamped);
 * plus the drag-isolation contract: a pointer gesture starting on the ⋯
 * trigger must NEVER feed the 5px PointerSensor activation (the gesture
 * from the card body still drags — the control arm of the same test).
 */

const CORPUS: {
  columns: string[];
  tasks: BoardTask[];
  counts: Record<string, number>;
} = {
  columns: [
    "backlog",
    "validating",
    "open",
    "in-progress",
    "blocked",
    "resolved",
    "done",
  ],
  tasks: [
    {
      id: "RB-2",
      col: "blocked",
      position: 0,
      title: "Blocked task",
      summary: "",
      spec: "",
      agents: ["zcode"],
      specialists: [],
      env: "local",
      project: "repro",
      memory_ids: [],
      mnemos_tags: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      archived: 0,
      status: "blocked",
      priority: "high",
      archived_from: "",
      validating_since: "",
    },
    {
      id: "O-1",
      col: "open",
      position: 0,
      title: "Open task",
      summary: "",
      spec: "",
      agents: [],
      specialists: [],
      env: "local",
      project: "repro",
      memory_ids: [],
      mnemos_tags: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      archived: 0,
      status: "open",
      priority: "normal",
      archived_from: "",
      validating_since: "",
    },
  ],
  counts: {
    backlog: 0,
    validating: 0,
    open: 1,
    "in-progress": 0,
    blocked: 1,
    resolved: 0,
    done: 0,
  },
};

const MENU_ROOT_ITEMS = ["Изменить", "Переместить…", "Архивировать"];

/** Wire stub: board reads answer; /move is counted and stays pending (the
 * card-menu suite never asserts wire outcomes — only activation and gates). */
function makeFetchStub(): typeof fetch & { moveCalls: string[] } {
  const stub = ((input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/move")) {
      stub.moveCalls.push(url);
      return new Promise<Response>(() => {});
    }
    return Promise.resolve(
      new Response(JSON.stringify(CORPUS), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch & { moveCalls: string[] };
  stub.moveCalls = [];
  return stub;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let queryClient: QueryClient | null = null;

async function mountBoard(fetchImpl: typeof fetch): Promise<BoardAdapter> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const gateway = new BoardAdapter({ fetchImpl, baseUrl: "/api" });
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
                <DensityProvider initialDensity="comfortable">
                  <MemoryRouter initialEntries={["/tasks"]}>
                    <TaskBoardPage />
                    <ToastViewport />
                  </MemoryRouter>
                </DensityProvider>
              </I18nProvider>
            </UiTokenProvider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
  return gateway;
}

/** The card <li> of a task by its title-link href. */
function cardOf(taskId: string): HTMLLIElement {
  const card = container!.querySelector(`a[href="/tasks/${taskId}"]`)?.closest("li");
  expect(card).toBeDefined();
  return card as HTMLLIElement;
}

/** The ⋯ trigger inside a card. */
function menuTriggerOf(card: HTMLLIElement): HTMLButtonElement {
  const trigger = card.querySelector<HTMLButtonElement>(
    'button[aria-haspopup="menu"]',
  );
  expect(trigger).toBeDefined();
  return trigger as HTMLButtonElement;
}

/** Every root-view menu item label rendered inside the popup. */
function menuItemLabels(menu: Element): string[] {
  return [...menu.querySelectorAll('[role="menuitem"]')].map(
    (item) => item.textContent ?? "",
  );
}

/** One pointer drag gesture: press on `target`, travel `dx` px, release. */
async function pointerGesture(target: Element, dx: number): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        isPrimary: true,
        pointerId: 1,
        clientX: 100,
        clientY: 100,
      }),
    );
    document.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        clientX: 100 + dx,
        clientY: 100,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    document.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  await queryClient?.cancelQueries();
  queryClient?.clear();
  root = null;
  container = null;
  queryClient = null;
});

describe("kanban card context menu (fix/kanban-context-menu)", () => {
  it("⋯ opens the list-grade menu; Esc closes and returns focus to the trigger", async () => {
    await mountBoard(makeFetchStub());
    const trigger = menuTriggerOf(cardOf("O-1"));
    expect(trigger.getAttribute("aria-label")).toBe("Действия с задачей O-1");

    await act(async () => {
      trigger.click();
    });

    const menu = container!.querySelector('[role="menu"]');
    expect(menu).toBeDefined();
    expect(menuItemLabels(menu!)).toEqual(MENU_ROOT_ITEMS);

    // Esc on the focused first item bubbles to the popup handler.
    await act(async () => {
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(container!.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("right-click opens the same menu at the cursor (preventDefault); outside press closes and the next ⋯ open re-anchors", async () => {
    await mountBoard(makeFetchStub());
    const card = cardOf("RB-2");

    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 320,
      clientY: 240,
    });
    await act(async () => {
      card.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);

    const menu = container!.querySelector('[role="menu"]') as HTMLElement;
    expect(menu).toBeDefined();
    expect(menuItemLabels(menu)).toEqual(MENU_ROOT_ITEMS);
    // Cursor placement: fixed + clamped inline coords (happy-dom 1024×768).
    expect(menu.className).toContain("fixed");
    expect(menu.style.left).toBe("320px");
    expect(menu.style.top).toBe("240px");

    // A press outside the popup dismisses it and refocuses the trigger.
    await act(async () => {
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(container!.querySelector('[role="menu"]')).toBeNull();

    // The next ⋯ open anchors to the button again (cursor coords cleared).
    await act(async () => {
      menuTriggerOf(card).click();
    });
    const anchored = container!.querySelector('[role="menu"]') as HTMLElement;
    expect(anchored.className).toContain("absolute");
    expect(anchored.style.left).toBe("");
  });

  it("«Переместить…» lists the 7 columns (current disabled); gateless move opens the login window, not the wire", async () => {
    const fetchStub = makeFetchStub();
    await mountBoard(fetchStub);
    const trigger = menuTriggerOf(cardOf("O-1"));
    await act(async () => {
      trigger.click();
    });

    await act(async () => {
      [...container!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((item) => item.textContent === "Переместить…")
        ?.click();
    });

    const moveItems = [
      ...container!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ];
    expect(moveItems.map((item) => item.textContent)).toEqual([
      "Назад",
      "бэклог",
      "на валидации",
      "открыто",
      "в работе",
      "блокировано",
      "решено",
      "готово",
    ]);
    // The task's own column is the disabled one.
    expect(
      moveItems.find((item) => item.textContent === "открыто")!.disabled,
    ).toBe(true);

    // Gateless pick: the menu closes, the login window opens (Radix portal
    // into document.body), and NO wire move was requested.
    await act(async () => {
      moveItems
        .find((item) => item.textContent === "в работе")!
        .click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container!.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('[data-testid="login-dialog"]')).not.toBeNull();
    expect(fetchStub.moveCalls.length).toBe(0);
  });

  it("the classic skin carries the same ⋯ and right-click entries", async () => {
    localStorage.setItem("vesmaro.boardStyle", "classic");
    await mountBoard(makeFetchStub());
    const card = cardOf("O-1");
    const trigger = menuTriggerOf(card);
    expect(trigger.getAttribute("aria-label")).toBe("Действия с задачей O-1");

    await act(async () => {
      card.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 48,
          clientY: 32,
        }),
      );
    });
    const menu = container!.querySelector('[role="menu"]');
    expect(menu).toBeDefined();
    expect(menuItemLabels(menu!)).toEqual(MENU_ROOT_ITEMS);
  });

  it("pointer gesture from ⋯ never starts a drag; the same gesture on the card body does", async () => {
    sessionStorage.setItem(UI_TOKEN_STORAGE_KEY, "dev-token");
    const fetchStub = makeFetchStub();
    await mountBoard(fetchStub);
    const card = cardOf("O-1");

    // Isolation arm: press on ⋯, travel 40px — no drag may activate.
    await pointerGesture(menuTriggerOf(card), 40);
    expect(card.className).not.toContain("opacity-30");
    expect(document.querySelector("li.rotate-2")).toBeNull();

    // Control arm: the very same gesture on the card body drags.
    await act(async () => {
      card.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          isPrimary: true,
          pointerId: 1,
          clientX: 100,
          clientY: 100,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          clientX: 140,
          clientY: 100,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(card.className).toContain("opacity-30");
    expect(document.querySelector("li.rotate-2")).not.toBeNull();

    // Drop ends the drag. The zero-rect drop slot may resolve into another
    // column (a legitimate optimistic move with the token present) — the
    // card node can remount elsewhere, so re-query before asserting.
    await act(async () => {
      document.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, cancelable: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(cardOf("O-1").className).not.toContain("opacity-30");
  });
});
