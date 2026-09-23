// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TaskBoardPage } from "@/features/tasks/TaskBoardPage";
import { useTaskMutations } from "@/features/tasks/useTaskMutations";
import { BoardAdapter } from "@/gateway/BoardAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { UI_TOKEN_STORAGE_KEY } from "@/gateway/uiToken";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { ToastViewport } from "@/components/Toast/ToastViewport";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import { DensityProvider } from "@/components/density-provider";
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
 * Kanban DnD UI layer (CV-4 §3–§4):
 * - Without a ui token the cards do NOT drag: default cursor, the
 *   «войдите для управления» tooltip, no grab affordance (owner decision —
 *   the simpler honest variant over a drag-then-login queue).
 * - With a token, moveTaskOptimistic runs the optimistic apply → wire call
 *   → rollback chain in the REAL UI plumbing: tasks.board cache, toast
 *   viewport, token gate. The 422 (WF-1: blocked → done) rolls the card
 *   back and toasts the actionable «сначала в работу» line.
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

const MOVE_422_DETAIL =
  "недопустимый переход: blocked → done — сначала in-progress (приёмка идёт через resolved)";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Wire stub: board reads answer; the move answer is a CONTROLLED promise
 * (resolved by the test) so the optimistic phase is observable before the
 * WF-1 422 lands and rolls the card back. */
function makeFetchStub(): typeof fetch & {
  moveCalls: string[];
  resolveMove: (response: Response) => void;
} {
  let resolveMove: ((response: Response) => void) | null = null;
  const stub = ((input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/move")) {
      stub.moveCalls.push(url);
      // The deferred stays pending until the test resolves it.
      return new Promise<Response>((resolve) => {
        resolveMove = resolve;
      });
    }
    return Promise.resolve(jsonResponse(CORPUS));
  }) as typeof fetch & { moveCalls: string[]; resolveMove: (r: Response) => void };
  stub.moveCalls = [];
  stub.resolveMove = (response: Response) => resolveMove?.(response);
  return stub;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let queryClient: QueryClient | null = null;

/** Probe: the REAL mutations hook, triggered by a plain button. */
function MoveProbe({ task }: { task: BoardTask }) {
  const mutations = useTaskMutations();
  return (
    <button type="button" onClick={() => mutations.moveTaskOptimistic(task, "done", 0)}>
      move
    </button>
  );
}

async function mountTree(node: React.ReactNode, gateway: BoardAdapter): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
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
                    {node}
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
}

beforeEach(() => {
  sessionStorage.clear();
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

describe("kanban drag availability (CV-4 §3 — no token, no drag)", () => {
  it("renders cards locked: default cursor + «войдите для управления» tooltip", async () => {
    const gateway = new BoardAdapter({ fetchImpl: makeFetchStub(), baseUrl: "/api" });
    await mountTree(<TaskBoardPage />, gateway);
    const card = container!.querySelector('a[href^="/tasks/RB-2?"]')?.closest("li");
    expect(card).toBeDefined();
    expect(card!.className).toContain("cursor-default");
    expect(card!.className).not.toContain("cursor-grab");
    expect(card!.getAttribute("title")).toBe("войдите для управления");
  });
});

describe("optimistic move + WF-1 422 rollback (UI layer)", () => {
  it("applies optimistically, rolls the card back on 422 and toasts the reason", async () => {
    sessionStorage.setItem(UI_TOKEN_STORAGE_KEY, "dev-token");
    const fetchStub = makeFetchStub();
    const gateway = new BoardAdapter({ fetchImpl: fetchStub, baseUrl: "/api" });
    const blocked = CORPUS.tasks[0];
    await mountTree(<MoveProbe task={blocked} />, gateway);

    const boardTask = (id: string): BoardTask | undefined =>
      queryClient!
        .getQueryData<{ tasks: BoardTask[] }>(keys.tasks.board())!
        .tasks.find((task) => task.id === id);

    expect(boardTask("RB-2")?.col).toBe("blocked");

    await act(async () => {
      container!.querySelector<HTMLButtonElement>("button")!.click();
    });

    // Optimistic phase: the cache shows the move WHILE the wire is pending…
    expect(boardTask("RB-2")?.col).toBe("done");
    expect(fetchStub.moveCalls.length).toBe(1);

    // …then the WF-1 422 answer rolls the projection back. One macrotask
    // hop lets the whole fetch→catch→toast chain settle.
    await act(async () => {
      fetchStub.resolveMove(jsonResponse({ detail: MOVE_422_DETAIL }, 422));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(boardTask("RB-2")?.col).toBe("blocked");
    expect(boardTask("RB-2")?.position).toBe(0);

    // The toast asserts the actionable line + the server detail.
    const alert = container!.querySelector('[role="alert"]');
    expect(alert).toBeDefined();
    expect(alert!.textContent).toContain("недопустимый переход: сначала в работу");
    expect(alert!.textContent).toContain(MOVE_422_DETAIL);
    expect(alert!.textContent).toContain("карточка возвращена");
  });
});
