// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TaskInboxPage } from "./TaskInboxPage";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import { UI_TOKEN_STORAGE_KEY } from "@/gateway/uiToken";
import type { Memory } from "@/gateway/types";

/**
 * UI-27 integration on the owner's complaint surface: expanding an inbox
 * card fetches the source record and renders its text through the
 * TextEngine primitive — markdown («##», «**») becomes formatted elements,
 * not raw syntax. The shared ui25 interactions file covers the expand/edit
 * mechanics; this file pins only the markdown rendering contract.
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const ROW_ID = "bd945a48-0888-4b1f-9ebb-841519e5f8b9"; // active, unedited

const MARKDOWN_MEMORY: Memory = {
  id: ROW_ID,
  content: [
    "## Задача",
    "",
    "Снять corpus: **полный дамп** задач и событий.",
    "",
    "1. зафиксировать форму",
    "2. сравнить с фикстурами",
  ].join("\n"),
  title: "Снять corpus с живого борда для Ф2",
  tags: ["project:mnemos", "task:queue"],
  source: "mcp",
  memory_type: "note",
  project: "mnemos",
  agent: "zed",
  status: "raw",
  quality_score: null,
  confidence: null,
  raw_content: null,
  clean_content: null,
  created_at: "2026-09-18T07:00:00Z",
  updated_at: "2026-09-18T07:00:00Z",
  marker_version: 1,
  metadata: {},
};

async function mountInbox(): Promise<HTMLDivElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  sessionStorage.setItem(UI_TOKEN_STORAGE_KEY, "dev-token");
  const gateway = new MockAdapter({ latency: false });
  // The expanded card fetches the source record — serve a markdown body.
  gateway.getMemory = (async (): Promise<Memory> => MARKDOWN_MEMORY) as unknown as MockAdapter["getMemory"];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await queryClient.prefetchQuery({
    queryKey: keys.tasks.inbox({ include_adopted: false }),
    queryFn: () => gateway.inbox({ include_adopted: false }),
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
                <MemoryRouter initialEntries={["/tasks/inbox"]}>
                  <TaskInboxPage />
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
      throw new Error(`waitFor(${what}) timed out; html: ${container!.innerHTML.slice(0, 400)}`);
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

describe("TaskInboxPage expand × TextEngine (UI-27)", () => {
  it("expanded record text renders markdown formatted (headings, strong, list)", async () => {
    const el = await mountInbox();
    const article = [...el.querySelectorAll("article")].find((node) =>
      node.textContent?.includes("Снять corpus"),
    );
    expect(article, "inbox card exists").toBeDefined();
    const chevron = article!.querySelector("button[aria-label='Record details']");
    await click(chevron);
    // The card title is an h2 too — wait for the rendered strong instead.
    await waitFor("formatted strong", () => Boolean(article!.querySelector("strong")));
    const mdHeading = [...article!.querySelectorAll("h2")].find(
      (heading) => heading.textContent === "Задача",
    );
    expect(mdHeading, "markdown «## Задача» renders as a heading").toBeDefined();
    expect(article!.querySelector("strong")?.textContent).toBe("полный дамп");
    expect(article!.querySelectorAll("ol > li").length).toBe(2);
    // No raw markdown leakage in the expanded body.
    expect(article!.textContent).not.toContain("## Задача");
    expect(article!.textContent).not.toContain("**полный дамп**");
  });
});
