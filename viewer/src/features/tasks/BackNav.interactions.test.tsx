// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { buildRoutes } from "@/app/routes";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import { DensityProvider } from "@/components/density-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { HotkeysProvider } from "@/layout/Hotkeys";
import { AuthProvider } from "@/features/auth/AuthProvider";

/**
 * UI-18 interaction gates (spec §4 criteria 2/3/6/10 + the W2 pair batch,
 * §4.11–12) over the REAL route table in a real DOM:
 *   1. the owner scenario — tag drill → task → «‹ Tags» lands back on
 *      /memory/tags?tag=… with the drill restored from the URL;
 *   2. a task TAB click preserves ?return= (spec §2.2 rule 4);
 *   3. the archive pair — an archive row leads to /tasks/:id (the archived
 *      row renders through the archive-probe fallback) and «‹ Archive»
 *      restores the filter URL;
 *   4. (W2 pair 6 / §4.12) agents execution → task (?tab=execution) →
 *      «‹ Execution» restores the feed page;
 *   5. (W2 pair 7) automation → task → «‹ Automation» restores the rules;
 *   6. (W2 pair 10) pulse with ?scope= → memory → «‹ Pulse» restores the
 *      scope;
 *   7. (W2 pair 13) sessions list → session detail (the old in-page
 *      «← All sessions» BackLink is gone) → «‹ Sessions» restores the list;
 *   8. (W2 pair 12) task memory tab → memory → task → list: the nested
 *      detail→detail chain (spec §2.2 rule 3) resolves level by level;
 *   9. (W2 pair 3) inbox adopted row → task → «‹ Inbox» restores ?adopted=1;
 *  10. (W2 pair 8) memories list with a filter → memory → «‹ Records»
 *      restores the filtered URL;
 *  11. (§4.11 pair 9) search ?q= → memory → «‹ Search» restores the query
 *      in the input.
 * Browser back is NOT exercised here — it is the router's own contract
 * (POP + ScrollRestoration), untouched by this wave.
 */

const DRILL_TAG = "project:mnemos-eyes";
const DRILL_RETURN = `%2Fmemory%2Ftags%3Ftag%3D${encodeURIComponent(DRILL_TAG)}`;
const ARCHIVE_Q = "регистрац";
const ARCHIVE_RETURN = `/tasks/RB-1?return=%2Ftasks%2Farchive%3Fq%3D${encodeURIComponent(ARCHIVE_Q)}`;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let router: ReturnType<typeof createMemoryRouter> | null = null;

async function mount(
  path: string,
  seed: (client: QueryClient, gateway: MockAdapter) => Promise<void> = async () => {},
): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const gateway = new MockAdapter({ latency: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await seed(queryClient, gateway);
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
}

/** Poll inside act() until the predicate holds (lazy route + query settle). */
async function waitFor(
  what: string,
  probe: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
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

async function click(target: Element | null | undefined): Promise<void> {
  expect(target, "interaction target must exist").toBeDefined();
  await act(async () => {
    (target as HTMLAnchorElement).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** Same as click() but for buttons/toggles (type-checked looser on purpose). */
async function activate(target: Element | null | undefined): Promise<void> {
  expect(target, "interaction target must exist").toBeDefined();
  await act(async () => {
    (target as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function anchorByHref(fragment: string): HTMLAnchorElement | undefined {
  return [...container!.querySelectorAll<HTMLAnchorElement>("a")].find((a) =>
    (a.getAttribute("href") ?? "").includes(fragment),
  );
}

function buttonByAriaLabel(prefix: string): HTMLButtonElement | undefined {
  return [...container!.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    (b.getAttribute("aria-label") ?? "").startsWith(prefix),
  );
}

function backControl(): HTMLAnchorElement | null {
  return container!.querySelector<HTMLAnchorElement>("a[aria-label^='Back:']");
}

function location(): string {
  return router!.state.location.pathname + router!.state.location.search;
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

describe("UI-18 back-nav interactions", () => {
  it("owner scenario: tag drill → task → «‹ Tags» restores the drill URL", async () => {
    // Raw colon in the query — browsers keep `:` unencoded in search strings.
    await mount(`/memory/tags?tag=${DRILL_TAG}`, async (client, gateway) => {
      await client.prefetchQuery({ queryKey: keys.tags.merged(), queryFn: () => gateway.mergedTags() });
    });
    await waitFor("drill task link", () => Boolean(anchorByHref("/tasks/TB-1?return=")));

    // The drill's task links carry the drill URL as their return context.
    const taskLink = anchorByHref("/tasks/TB-1?return=");
    expect(taskLink!.getAttribute("href")).toBe(`/tasks/TB-1?return=${DRILL_RETURN}`);

    // Fall into the task; the back control points back at the drill.
    await click(taskLink);
    await waitFor("task page", () => backControl() !== null);
    expect(location()).toBe(`/tasks/TB-1?return=${DRILL_RETURN}`);
    const control = backControl()!;
    expect(control.getAttribute("href")).toBe(`/memory/tags?tag=${DRILL_TAG}`);
    expect(control.getAttribute("aria-label")).toBe("Back: Tags");

    // The context link lands EXACTLY on the source URL (spec criterion 3):
    // the drill restores itself from ?tag= (UI-17 URL-first contract).
    await click(control);
    await waitFor("drill restored", () => container!.querySelector("#tag-drill-title") !== null);
    expect(location()).toBe(`/memory/tags?tag=${DRILL_TAG}`);
  });

  it("a tab click preserves ?return= (spec §2.2 rule 4)", async () => {
    const boardReturn = "%2Ftasks%3Fstatus%3Dopen";
    await mount(`/tasks/TB-1?return=${boardReturn}`, async (client, gateway) => {
      await client.prefetchQuery({ queryKey: keys.tasks.board(), queryFn: () => gateway.board() });
    });
    await waitFor("tab links", () => Boolean(anchorByHref("tab=history")));

    const historyTab = anchorByHref("tab=history")!;
    expect(historyTab.getAttribute("href")).toBe(
      `/tasks/TB-1?return=${boardReturn}&tab=history`,
    );

    await click(historyTab);
    await waitFor("history tab active", () => location().includes("tab=history"));
    expect(location()).toBe(`/tasks/TB-1?return=${boardReturn}&tab=history`);
    // The context survived the tab switch.
    expect(backControl()!.getAttribute("href")).toBe("/tasks?status=open");
  });

  it("archive pair: row → /tasks/:id (archived fallback) → «‹ Archive» restores filters", async () => {
    await mount("/tasks/archive?q=регистрац", async (client, gateway) => {
      const params = { q: ARCHIVE_Q, limit: 50, offset: 0 };
      await client.prefetchQuery({
        queryKey: keys.tasks.archive(params),
        queryFn: () => gateway.archive(params),
      });
    });
    await waitFor("archive row link", () => Boolean(anchorByHref("/tasks/RB-1?return=")));

    // Pair 4 source: the row title leads to the detail WITH the archive URL.
    const rowLink = anchorByHref("/tasks/RB-1?return=")!;
    expect(rowLink.getAttribute("href")).toBe(ARCHIVE_RETURN);

    // The archived row renders on the detail page (board misses it; the
    // archive probe supplies the row).
    await click(rowLink);
    await waitFor("archived task rendered", () => {
      const text = container!.textContent ?? "";
      return text.includes("RB-1") && !text.includes("No such task");
    });
    expect(location()).toBe(ARCHIVE_RETURN);

    // «‹ Archive» restores the filtered archive URL.
    const control = backControl();
    expect(control!.getAttribute("aria-label")).toBe("Back: Archive");
    await click(control);
    await waitFor("archive restored", () => location().startsWith("/tasks/archive"));
    expect(location()).toBe("/tasks/archive?q=регистрац");
  });

  it("agents execution → task → «‹ Execution» restores the feed page (§4.12)", async () => {
    await mount("/agents/execution");
    await waitFor("assignment rows", () => buttonByAriaLabel("Actions for assignment") !== null);

    // The row's ⋯ menu holds the open-task link; it must carry the
    // execution URL as its return context (pair 6). Open with retries —
    // lazy-chunk swaps can briefly unmount the row between probes.
    let openLink: HTMLAnchorElement | undefined;
    const deadline = Date.now() + 3000;
    while (!openLink && Date.now() < deadline) {
      const menuButton = buttonByAriaLabel("Actions for assignment");
      if (!menuButton) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
        });
        continue;
      }
      await activate(menuButton);
      openLink = [...container!.querySelectorAll<HTMLAnchorElement>('a[role="menuitem"]')].find(
        (a) =>
          (a.getAttribute("href") ?? "").includes(
            "tab=execution&return=%2Fagents%2Fexecution",
          ),
      );
    }
    expect(openLink, "open-task menu link with return context never appeared").toBeDefined();
    expect(openLink!.getAttribute("href")).toMatch(
      /^\/tasks\/[^/]+\?tab=execution&return=%2Fagents%2Fexecution$/,
    );

    // Land on the task; «‹ Execution» leads back into the feed.
    await click(openLink!);
    await waitFor("task page", () => backControl() !== null);
    expect(backControl()!.getAttribute("aria-label")).toBe("Back: Execution");
    expect(backControl()!.getAttribute("href")).toBe("/agents/execution");
    await click(backControl());
    await waitFor("execution restored", () => location() === "/agents/execution");
    // The feed itself is on place (the panel survives the round trip).
    await waitFor("feed panel", () =>
      Boolean(container!.querySelector('[aria-label="Execution feed"]')),
    );
  });

  it("automation → task → «‹ Automation» restores the rules (pair 7)", async () => {
    await mount("/system/automation");
    await waitFor("rule task link", () =>
      Boolean(anchorByHref("tab=execution&return=%2Fsystem%2Fautomation")),
    );

    const ruleLink = anchorByHref("tab=execution&return=%2Fsystem%2Fautomation")!;
    await click(ruleLink);
    await waitFor("task page", () => backControl() !== null);
    expect(backControl()!.getAttribute("aria-label")).toBe("Back: Automation");
    expect(backControl()!.getAttribute("href")).toBe("/system/automation");
    await click(backControl());
    await waitFor("automation restored", () => location() === "/system/automation");
  });

  it("pulse ?scope= → memory → «‹ Pulse» restores the scope (pair 10)", async () => {
    await mount("/memory/pulse?scope=mock-store");
    await waitFor("pulse row links", () =>
      Boolean(anchorByHref("return=%2Fmemory%2Fpulse%3Fscope%3Dmock-store")),
    );

    const rowLink = anchorByHref("return=%2Fmemory%2Fpulse%3Fscope%3Dmock-store")!;
    expect(rowLink.getAttribute("href")).toMatch(
      /^\/memory\/[^/]+\?return=%2Fmemory%2Fpulse%3Fscope%3Dmock-store$/,
    );
    await click(rowLink);
    await waitFor("memory page", () => backControl() !== null);
    expect(backControl()!.getAttribute("aria-label")).toBe("Back: Pulse");
    expect(backControl()!.getAttribute("href")).toBe("/memory/pulse?scope=mock-store");
    await click(backControl());
    await waitFor("pulse restored with scope", () => location() === "/memory/pulse?scope=mock-store");
  });

  it("sessions list → session detail with NO in-page back link; «‹ Sessions» restores (pair 13)", async () => {
    await mount("/system/sessions");
    await waitFor("session item link", () =>
      Boolean(anchorByHref("/system/sessions/conv-2026-09-15-88c2f10b?return=")),
    );

    const itemLink = anchorByHref("/system/sessions/conv-2026-09-15-88c2f10b?return=")!;
    expect(itemLink.getAttribute("href")).toBe(
      `/system/sessions/conv-2026-09-15-88c2f10b?return=%2Fsystem%2Fsessions`,
    );

    await click(itemLink);
    await waitFor("session detail", () => backControl() !== null);
    // The old in-page «← All sessions» BackLink is gone — one pattern.
    expect(container!.textContent).not.toContain("All sessions");
    expect(backControl()!.getAttribute("aria-label")).toBe("Back: Sessions");
    expect(backControl()!.getAttribute("href")).toBe("/system/sessions");
    await click(backControl());
    await waitFor("sessions restored", () => location() === "/system/sessions");
  });

  it("task memory tab → memory → task → list: the nested chain resolves (pair 12, §2.2 rule 3)", async () => {
    const listReturn = encodeURIComponent("/tasks?status=open");
    await mount(`/tasks/TB-1?tab=memory&return=${listReturn}`);
    await waitFor("memory tab links", () => Boolean(anchorByHref("/memory/25cdc0e9")));

    // The memory link carries the WHOLE task URL — tab + the task's own
    // return — as its immediate predecessor (encoded as one opaque value).
    const memoryLink = anchorByHref("/memory/25cdc0e9")!;
    expect(memoryLink.getAttribute("href")).toBe(
      `/memory/25cdc0e9-1912-4217-aaf0-0e7c48912df1?return=${encodeURIComponent(
        `/tasks/TB-1?tab=memory&return=${listReturn}`,
      )}`,
    );

    // Hop 1: memory → back to the task (with its tab and return intact).
    await click(memoryLink);
    await waitFor("memory detail", () => backControl() !== null);
    expect(backControl()!.getAttribute("href")).toBe(`/tasks/TB-1?tab=memory&return=${listReturn}`);

    // Hop 2: task → back to the list the chain started from.
    await click(backControl());
    await waitFor("task page again", () => location() === `/tasks/TB-1?tab=memory&return=${listReturn}`);
    expect(backControl()!.getAttribute("aria-label")).toBe("Back: Kanban");
    expect(backControl()!.getAttribute("href")).toBe("/tasks?status=open");
  });

  it("inbox adopted row → task → «‹ Inbox» restores ?adopted=1 (pair 3)", async () => {
    await mount("/tasks/inbox?adopted=1");
    await waitFor("adopted task link", () =>
      Boolean(anchorByHref("/tasks/TB-3?return=%2Ftasks%2Finbox%3Fadopted%3D1")),
    );

    const adoptedLink = anchorByHref("/tasks/TB-3?return=%2Ftasks%2Finbox%3Fadopted%3D1")!;
    await click(adoptedLink);
    await waitFor("task page", () => backControl() !== null);
    expect(backControl()!.getAttribute("aria-label")).toBe("Back: Inbox");
    expect(backControl()!.getAttribute("href")).toBe("/tasks/inbox?adopted=1");
    await click(backControl());
    await waitFor("inbox restored", () => location() === "/tasks/inbox?adopted=1");
  });

  it("memories list with a filter → memory → «‹ Records» restores the filter (pair 8)", async () => {
    await mount("/memory?status=processed");
    await waitFor("memory card links", () =>
      Boolean(anchorByHref("return=%2Fmemory%3Fstatus%3Dprocessed")),
    );

    const cardLink = anchorByHref("return=%2Fmemory%3Fstatus%3Dprocessed")!;
    expect(cardLink.getAttribute("href")).toMatch(
      /^\/memory\/[^/]+\?return=%2Fmemory%3Fstatus%3Dprocessed$/,
    );
    await click(cardLink);
    await waitFor("memory page", () => backControl() !== null);
    expect(backControl()!.getAttribute("aria-label")).toBe("Back: Records");
    expect(backControl()!.getAttribute("href")).toBe("/memory?status=processed");
    await click(backControl());
    await waitFor("list restored", () => location() === "/memory?status=processed");
    // The whole list state rides the URL: the status select is back on the
    // filtered value (spec criterion 3).
    const statusSelect = container!.querySelector<HTMLSelectElement>("#memories-status");
    expect(statusSelect?.value).toBe("processed");
  });

  it("search ?q= → memory → «‹ Search» restores the query in the input (§4.11)", async () => {
    await mount("/memory/search?q=fts");
    await waitFor("result links", () =>
      Boolean(anchorByHref("return=%2Fmemory%2Fsearch%3Fq%3Dfts")),
    );

    const resultLink = anchorByHref("return=%2Fmemory%2Fsearch%3Fq%3Dfts")!;
    await click(resultLink);
    await waitFor("memory page", () => backControl() !== null);
    expect(backControl()!.getAttribute("aria-label")).toBe("Back: Search");
    expect(backControl()!.getAttribute("href")).toBe("/memory/search?q=fts");
    await click(backControl());
    await waitFor("search restored", () => location() === "/memory/search?q=fts");
    // The query is in the input and the results are on the page again
    // (name-scoped: the TopBar carries its own type=search input).
    const input = container!.querySelector<HTMLInputElement>("input[name='query']");
    expect(input?.value).toBe("fts");
    await waitFor("results re-rendered", () =>
      Boolean(anchorByHref("return=%2Fmemory%2Fsearch%3Fq%3Dfts")),
    );
  });
});
