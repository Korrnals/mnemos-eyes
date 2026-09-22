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
import { BOARD_STYLE_STORAGE_KEY } from "@/features/tasks/tasksViewPrefs";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
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
 * Classic board style (CV-5, owner feedback 1.10.2): «Группы | Классика»
 * switch, flat priority→position columns without accordions, and the SAME
 * DnD/mutation chain working from the classic view. The open column carries
 * three tasks with distinct priorities across two projects — the flat order
 * proof (high → normal → low) and the no-accordion proof in one corpus.
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
      id: "O-lo",
      col: "open",
      position: 0,
      title: "Low lane task",
      summary: "",
      spec: "",
      agents: [],
      specialists: [],
      env: "local",
      project: "alpha",
      memory_ids: [],
      mnemos_tags: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      archived: 0,
      status: "open",
      priority: "low",
      archived_from: "",
      validating_since: "",
    },
    {
      id: "O-hi",
      col: "open",
      position: 1,
      title: "High lane task",
      summary: "",
      spec: "",
      agents: [],
      specialists: [],
      env: "local",
      project: "beta",
      memory_ids: [],
      mnemos_tags: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      archived: 0,
      status: "open",
      priority: "high",
      archived_from: "",
      validating_since: "",
    },
    {
      id: "O-no",
      col: "open",
      position: 2,
      title: "Normal lane task",
      summary: "",
      spec: "",
      agents: [],
      specialists: [],
      env: "local",
      project: "alpha",
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
  ],
  counts: {
    backlog: 0,
    validating: 0,
    open: 3,
    "in-progress": 0,
    blocked: 1,
    resolved: 0,
    done: 0,
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Wire stub: board reads answer immediately; the move answer is a CONTROLLED
 * promise so the optimistic phase is observable before the server row lands. */
function makeFetchStub(): typeof fetch & {
  moveCalls: string[];
  resolveMove: (response: Response) => void;
} {
  let resolveMove: ((response: Response) => void) | null = null;
  const stub = ((input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/move")) {
      stub.moveCalls.push(url);
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
    <button
      type="button"
      onClick={() => mutations.moveTaskOptimistic(task, "in-progress", 0)}
    >
      move
    </button>
  );
}

async function mountTree(
  node: React.ReactNode,
  gateway: BoardAdapter,
  lang: "ru" | "en" = "ru",
): Promise<void> {
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
              <I18nProvider initialLang={lang}>
                <DensityProvider initialDensity="comfortable">
                  <MemoryRouter initialEntries={["/tasks"]}>{node}</MemoryRouter>
                </DensityProvider>
              </I18nProvider>
            </UiTokenProvider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
}

/** Card link PATHS of one column, in DOM order (the rendered card order).
 * UI-18: hrefs carry ?return=… — strip it so order assertions speak paths. */
function columnCardHrefs(columnLabel: string): string[] {
  return Array.from(
    container!.querySelectorAll(
      `section[aria-label="${columnLabel}"] ul li a[href^="/tasks/"]`,
    ),
  ).map((link) => (link.getAttribute("href") ?? "").split("?")[0]);
}

/** The style toggle's button by its visible label. */
function styleButton(label: string): HTMLButtonElement | null {
  return Array.from(
    container!.querySelectorAll<HTMLButtonElement>(
      '[role="group"][aria-label="Вид доски"] button',
    ),
  ).find((button) => button.textContent === label) ?? null;
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

describe("classic board style (CV-5 — render)", () => {
  it("renders the GROUPED board by default: accordions + aria-pressed «Группы»", async () => {
    const gateway = new BoardAdapter({ fetchImpl: makeFetchStub(), baseUrl: "/api" });
    await mountTree(<TaskBoardPage />, gateway);
    // Project accordions are expanded by default (aria-expanded=true is ONLY
    // the accordion headers — closed ⋯ menus render aria-expanded="false").
    expect(
      container!.querySelectorAll('button[aria-expanded="true"]').length,
    ).toBeGreaterThan(0);
    // The alpha group header is a BUTTON inside the open column…
    expect(
      Array.from(
        container!.querySelectorAll('section[aria-label="Колонка «открыто»"] button'),
      ).some((button) => button.textContent?.includes("alpha")),
    ).toBe(true);
    // …and the toggle marks "groups" as pressed.
    expect(styleButton("Группы")!.getAttribute("aria-pressed")).toBe("true");
    expect(styleButton("Классика")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("classic renders FLAT columns: no accordions, priority→position order", async () => {
    localStorage.setItem(BOARD_STYLE_STORAGE_KEY, "classic");
    const gateway = new BoardAdapter({ fetchImpl: makeFetchStub(), baseUrl: "/api" });
    await mountTree(<TaskBoardPage />, gateway);
    // No accordion headers anywhere (expanded group buttons are gone; only
    // the closed ⋯ menu triggers with aria-expanded="false" may remain).
    expect(container!.querySelector('button[aria-expanded="true"]')).toBeNull();
    expect(
      Array.from(
        container!.querySelectorAll('section[aria-label="Колонка «открыто»"] button'),
      ).some((button) => button.textContent?.includes("alpha")),
    ).toBe(false);
    // One flat card list per column, classic order: high → normal → low,
    // NOT the wire position order (lo=0, hi=1, no=2).
    expect(columnCardHrefs('Колонка «открыто»')).toEqual([
      "/tasks/O-hi",
      "/tasks/O-no",
      "/tasks/O-lo",
    ]);
    expect(styleButton("Классика")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("switches styles in place and persists the choice both ways", async () => {
    const gateway = new BoardAdapter({ fetchImpl: makeFetchStub(), baseUrl: "/api" });
    await mountTree(<TaskBoardPage />, gateway);
    expect(
      container!.querySelector('button[aria-expanded="true"]'),
    ).not.toBeNull();

    await act(async () => {
      styleButton("Классика")!.click();
    });
    expect(container!.querySelector('button[aria-expanded="true"]')).toBeNull();
    expect(columnCardHrefs('Колонка «открыто»')).toEqual([
      "/tasks/O-hi",
      "/tasks/O-no",
      "/tasks/O-lo",
    ]);
    expect(localStorage.getItem(BOARD_STYLE_STORAGE_KEY)).toBe("classic");

    await act(async () => {
      styleButton("Группы")!.click();
    });
    expect(
      container!.querySelector('button[aria-expanded="true"]'),
    ).not.toBeNull();
    expect(localStorage.getItem(BOARD_STYLE_STORAGE_KEY)).toBe("groups");
  });

  it("renders the style toggle labels in ru AND en (i18n parity)", async () => {
    const gateway = new BoardAdapter({ fetchImpl: makeFetchStub(), baseUrl: "/api" });
    await mountTree(<TaskBoardPage />, gateway, "ru");
    expect(container!.querySelector('[aria-label="Вид доски"]')).not.toBeNull();
    expect(container!.textContent).toContain("Группы");
    expect(container!.textContent).toContain("Классика");

    const gatewayEn = new BoardAdapter({
      fetchImpl: makeFetchStub(),
      baseUrl: "/api",
    });
    await mountTree(<TaskBoardPage />, gatewayEn, "en");
    expect(container!.querySelector('[aria-label="Board layout"]')).not.toBeNull();
    expect(container!.textContent).toContain("Groups");
    expect(container!.textContent).toContain("Classic");
  });
});

describe("classic board style (CV-5 — DnD chain)", () => {
  it("runs the optimistic move from the classic board: apply → wire → reconcile", async () => {
    localStorage.setItem(BOARD_STYLE_STORAGE_KEY, "classic");
    sessionStorage.setItem(UI_TOKEN_STORAGE_KEY, "dev-token");
    const fetchStub = makeFetchStub();
    const gateway = new BoardAdapter({ fetchImpl: fetchStub, baseUrl: "/api" });
    const blocked = CORPUS.tasks[3];
    await mountTree(
      <>
        <TaskBoardPage />
        <MoveProbe task={blocked} />
      </>,
      gateway,
    );

    const boardTask = (id: string): BoardTask | undefined =>
      queryClient!
        .getQueryData<{ tasks: BoardTask[] }>(keys.tasks.board())!
        .tasks.find((task) => task.id === id);

    // The card starts in the blocked column (classic skin, flat list).
    expect(columnCardHrefs('Колонка «блокировано»')).toContain("/tasks/RB-2");

    await act(async () => {
      Array.from(container!.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent === "move")!
        .click();
    });

    // Optimistic phase: the cache shows the move WHILE the wire is pending…
    expect(boardTask("RB-2")?.col).toBe("in-progress");
    expect(fetchStub.moveCalls.length).toBe(1);

    // …the server answer (a valid blocked → in-progress transition) folds
    // the authoritative row back in — same col, server-owned position.
    await act(async () => {
      fetchStub.resolveMove(
        jsonResponse({ ...blocked, col: "in-progress", position: 0 }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(boardTask("RB-2")?.col).toBe("in-progress");
    expect(boardTask("RB-2")?.position).toBe(0);
    // The classic board renders the moved card in its new lane.
    expect(columnCardHrefs('Колонка «в работе»')).toContain("/tasks/RB-2");
    expect(columnCardHrefs('Колонка «блокировано»')).not.toContain("/tasks/RB-2");
  });
});
