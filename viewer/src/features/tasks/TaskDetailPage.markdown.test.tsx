// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { UI_TOKEN_STORAGE_KEY } from "@/gateway/uiToken";
import type { BoardSummary, TaskReports } from "@/gateway/boardTypes";

/**
 * UI-27 integration: the task page's author surfaces render through the
 * TextEngine primitive — the «Отчёты» tab (agent report bodies are markdown
 * almost by definition) and the «Детали» tab (summary + spec). The unit
 * contract of the engine itself lives in components/TextEngine.
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const MARKDOWN_REPORT = [
  "## Итог",
  "",
  "Корпус снят: **142 задачи**, форма ответов зафиксирована.",
  "",
  "```bash",
  "npm run test",
  "```",
].join("\n");

const MARKDOWN_SPEC = [
  "## Критерий приёмки",
  "",
  "- тесты читают корпус",
  "- [x] дифф пустой",
].join("\n");

const MARKDOWN_SUMMARY = "Свести corpus: **записано 142 задачи**, дифф пустой.";

async function mountTask(tab: "reports" | "details"): Promise<HTMLDivElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  sessionStorage.setItem(UI_TOKEN_STORAGE_KEY, "dev-token");
  const gateway = new MockAdapter({ latency: false });
  // Patch the projection: TB-1 carries markdown author text (spec/summary),
  // and the report fixture becomes a markdown agent report — the real-world
  // shape the engine must render instead of printing raw.
  const baseBoard = gateway.board.bind(gateway);
  gateway.board = (async (): Promise<BoardSummary> => {
    const board = await baseBoard(undefined);
    return {
      ...board,
      tasks: board.tasks.map((task) =>
        task.id === "TB-1"
          ? { ...task, spec: MARKDOWN_SPEC, summary: MARKDOWN_SUMMARY }
          : task,
      ),
    };
  }) as unknown as MockAdapter["board"];
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
        body: MARKDOWN_REPORT,
        superseded: false,
        created_at: "2026-09-21T10:00:00+00:00",
      },
    ],
  })) as unknown as MockAdapter["reports"];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await queryClient.prefetchQuery({
    queryKey: keys.tasks.board(),
    queryFn: () => gateway.board(undefined),
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
                <MemoryRouter initialEntries={[`/tasks/TB-1?tab=${tab}`]}>
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
  return container;
}

async function waitFor(what: string, probe: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  for (;;) {
    if (probe()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitFor(${what}) timed out; html: ${container!.innerHTML.slice(0, 1200)}`);
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

describe("TaskDetailPage × TextEngine (UI-27)", () => {
  it("reports tab: agent markdown report renders formatted, not raw", async () => {
    const el = await mountTask("reports");
    await waitFor("report heading", () => Boolean(el.querySelector("details h2")));
    expect(el.querySelector("details h2")?.textContent).toBe("Итог");
    expect(el.querySelector("details strong")?.textContent).toBe("142 задачи");
    expect(el.querySelector("details pre code")?.textContent).toContain("npm run test");
    // No raw markdown leakage.
    expect(el.querySelector("details")?.textContent).not.toContain("**");
    expect(el.querySelector("details")?.textContent).not.toContain("## Итог");
  });

  it("details tab: markdown spec renders formatted inside the well box", async () => {
    const el = await mountTask("details");
    const specSection = () =>
      [...el.querySelectorAll("section")].find((section) =>
        section.getAttribute("aria-label") === "Specification",
      );
    await waitFor("spec markdown heading", () =>
      Boolean(
        [...(specSection()?.querySelectorAll("h2") ?? [])].find(
          (heading) => heading.textContent === "Критерий приёмки",
        ),
      ),
    );
    const mdHeading = [...(specSection()?.querySelectorAll("h2") ?? [])].find(
      (heading) => heading.textContent === "Критерий приёмки",
    );
    expect(mdHeading, "markdown «## Критерий приёмки» renders as h2").toBeDefined();
    expect(specSection()?.querySelector("li")?.textContent).toContain("тесты читают корпус");
    expect(specSection()?.querySelector("input[type='checkbox']")).not.toBeNull();
    // No raw leakage of the spec markdown.
    expect(specSection()?.textContent).not.toContain("## Критерий");
  });

  it("details tab: markdown summary renders formatted", async () => {
    const el = await mountTask("details");
    const summarySection = () =>
      [...el.querySelectorAll("section")].find((section) =>
        section.getAttribute("aria-label") === "Summary",
      );
    await waitFor("summary strong", () => Boolean(summarySection()?.querySelector("strong")));
    expect(summarySection()?.querySelector("strong")?.textContent).toBe(
      "записано 142 задачи",
    );
  });

  it("details tab: plain spec stays plain prose (no invented elements)", async () => {
    // The unpatched mock board carries plain specs (e.g. TB-3) — the plain
    // path must keep them verbatim.
    const gateway = new MockAdapter({ latency: false });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await queryClient.prefetchQuery({
      queryKey: keys.tasks.board(),
      queryFn: () => gateway.board(undefined),
    });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
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
                  <MemoryRouter initialEntries={["/tasks/TB-1?tab=details"]}>
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
    await waitFor("details sections", () =>
      Boolean(
        [...container!.querySelectorAll("section")].find(
          (section) => section.getAttribute("aria-label") === "Summary",
        ),
      ),
    );
    // The section labels (Summary/Specification/Metadata) are the only h2s;
    // the plain author text invents no markdown elements. Only the labeled
    // tab sections count (the outer shell section also wraps the tab nav).
    const labeledSections = [...container!.querySelectorAll("section")].filter(
      (section) => section.getAttribute("aria-label") !== null,
    );
    const mdHeadings = labeledSections.flatMap((section) =>
      [...section.querySelectorAll("h2")].filter(
        (heading) =>
          !["Summary", "Specification", "Metadata"].includes(heading.textContent ?? ""),
      ),
    );
    expect(mdHeadings).toEqual([]);
    expect(labeledSections.some((section) => section.querySelector("strong"))).toBe(false);
    expect(labeledSections.some((section) => section.querySelector("li"))).toBe(false);
  });
});

/**
 * Owner clamp directive: every disclosure clamps long documents. The
 * report row is a native <details> — its body renders clamped with the
 * measured «Show full text» affordance (button only when the content
 * actually overflows max-h-48). Overflow is simulated the same way the
 * TextEngine unit tests do: prototype height stubs (happy-dom lays out
 * nothing).
 */
describe("TaskDetailPage reports tab — disclosure clamp", () => {
  const proto = HTMLElement.prototype as unknown as Record<string, PropertyDescriptor | undefined>;
  let savedOffset: PropertyDescriptor | undefined;
  let savedClient: PropertyDescriptor | undefined;

  function stubOverflow(contentHeight: number, boxHeight: number): void {
    savedOffset = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
    savedClient = Object.getOwnPropertyDescriptor(proto, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => contentHeight,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => boxHeight,
    });
  }

  function restoreOverflow(): void {
    delete (HTMLElement.prototype as { offsetHeight?: unknown }).offsetHeight;
    delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight;
    if (savedOffset) Object.defineProperty(HTMLElement.prototype, "offsetHeight", savedOffset);
    if (savedClient) Object.defineProperty(HTMLElement.prototype, "clientHeight", savedClient);
  }

  afterEach(() => {
    restoreOverflow();
  });

  it("overflowing report body shows «Show full text»; expanding removes the cut", async () => {
    stubOverflow(500, 192);
    const el = await mountTask("reports");
    const details = el.querySelector("details");
    expect(details, "report disclosure renders").not.toBeNull();
    expect(details!.querySelector(".max-h-48"), "clamp box inside the disclosure").not.toBeNull();
    await waitFor("expand button", () => Boolean(details!.querySelector("button")));
    const button = details!.querySelector("button");
    expect(button?.textContent).toBe("Show full text");
    await click(button!);
    expect(details!.querySelector(".max-h-48")).toBeNull();
    expect(details!.querySelector("button")).toBeNull();
    // The body itself stays rendered after the expand.
    expect(details!.querySelector("h2")?.textContent).toBe("Итог");
  });

  it("report body that fits shows no expand button (clamp box still caps)", async () => {
    // No stubs: happy-dom reports zero heights, so nothing «overflows».
    const el = await mountTask("reports");
    const details = el.querySelector("details");
    expect(details, "report disclosure renders").not.toBeNull();
    expect(details!.querySelector(".max-h-48")).not.toBeNull();
    expect(details!.querySelector("button")).toBeNull();
  });
});
