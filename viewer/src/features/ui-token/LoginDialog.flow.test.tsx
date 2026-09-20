// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TaskListPage } from "@/features/tasks/TaskListPage";
import { BoardAdapter } from "@/gateway/BoardAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { ToastViewport } from "@/components/Toast/ToastViewport";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import { UiTokenSlot } from "@/features/ui-token/UiTokenSlot";
import { LoginDialog } from "@/features/ui-token/LoginDialog";
import { I18nProvider } from "@/i18n";
import { keys } from "@/lib/queryKeys";
import { clearUiToken } from "@/gateway/uiToken";
import type * as useTasksModule from "@/features/tasks/useTasks";

// Test-env seam (documented, not a product change): useReportCounts subscribes
// to EVERY query-cache event and re-renders via setTick; under happy-dom's
// fully synchronous act() flush this feedback cycles forever against
// react-query's notifyManager (the browser resolves it asynchronously — the
// production page re-renders fine on SSE patches). Mocking only the badge
// counts keeps every other piece real: gate, LoginDialog, queue resume,
// wire POST, cache fold-in, toast viewport, the create button.
vi.mock("@/features/tasks/useTasks", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof useTasksModule;
  return { ...actual, useReportCounts: () => ({}) };
});

/**
 * Login-flow regression (fix/login-window) — the owner's exact walk, in a
 * real DOM (happy-dom): create-task submit without a token → the LOGIN
 * WINDOW opens with the contextual line → paste the key, press Enter → the
 * queued create runs with the fresh bearer → the task lands on the board,
 * the success toast renders (with its in-app link — the old crash, see
 * ToastViewport), and the «+ Задача» button is STILL in the list header.
 *
 * The board cache is prefetched BEFORE mount: a cold fetch + the report-count
 * cache subscription loop forever under happy-dom's timer scheduling inside
 * act() (test-env artifact; the browser resolves it) — warm cache keeps the
 * flow test about the login surface.
 */

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

const boardPayload = {
  tasks: [
    {
      id: "TB-1",
      title: "Existing task",
      summary: "",
      col: "open",
      priority: "normal",
      project: "repro",
      agents: [],
      updated_at: "2026-01-01T00:00:00Z",
      created_at: "2026-01-01T00:00:00Z",
    },
  ],
  counts: { open: 1, doing: 0, blocked: 0, review: 0, done: 0 },
  columns: ["open", "doing", "blocked", "review", "done"],
};

const createdTask = {
  id: "TB-42",
  title: "Repro task",
  summary: "",
  col: "open",
  priority: "normal",
  project: "repro",
  agents: [],
  updated_at: "2026-01-02T00:00:00Z",
  created_at: "2026-01-02T00:00:00Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** setValue helper: the React-controlled input path (native value setter
 * from the INSTANCE's own prototype — realm-safe under happy-dom, where the
 * global constructor instanceof check misfires — then a bubbling input
 * event so React's value tracker fires onChange). */
function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = Object.getPrototypeOf(input) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement | undefined {
  return (
    Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes(text),
    ) ?? undefined
  );
}

/** The «+ Задача» header button (label t("tasks.create.label") = "Task"). */
function createTaskButton(scope: ParentNode): HTMLButtonElement | undefined {
  return (
    Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Task",
    ) ?? undefined
  );
}

/** Roots created by the current test — unmounted in afterEach so Radix
 * portals (document.body) never leak into the next test. */
const mountedRoots: Root[] = [];

beforeEach(() => {
  vi.stubGlobal("sessionStorage", new MemoryStorage());
  clearUiToken();
});

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
});

describe("login flow regression (owner repro)", () => {
  it("create → login window → Enter → queued create runs; button never disappears", { timeout: 20000 }, async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const mutationCalls: { auth: string | null }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/tasks") && (init?.method ?? "GET") === "POST") {
        // requestJson passes a plain header record (see gateway/http.ts).
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const auth = headers.Authorization ?? null;
        mutationCalls.push({ auth });
        if (!auth) return jsonResponse({ error: "unauthorized" }, 401);
        return jsonResponse(createdTask, 201);
      }
      return jsonResponse(boardPayload);
    });

    const gateway = new BoardAdapter({ baseUrl: "/api", fetchImpl: fetchImpl as never });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Warm the board cache before mount (see the file docblock).
    await queryClient.prefetchQuery({
      queryKey: keys.tasks.board(),
      queryFn: () => gateway.board(),
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    mountedRoots.push(root);
    // Mirrors main.tsx/App.tsx order: i18n outermost (the login window
    // renders from UiTokenProvider — above the router).
    const renderApp = () =>
      act(async () => {
        root.render(
          <I18nProvider initialLang="en">
            <GatewayContext.Provider value={gateway}>
              <QueryClientProvider client={queryClient}>
                <ToastProvider>
                  <UiTokenProvider>
                    <MemoryRouter initialEntries={["/tasks"]}>
                      <TaskListPage />
                      {/* Inside the router — same placement as the Shell. */}
                      <ToastViewport />
                    </MemoryRouter>
                  </UiTokenProvider>
                </ToastProvider>
              </QueryClientProvider>
            </GatewayContext.Provider>
          </I18nProvider>,
        );
      });

    await renderApp();

    // 1. The list is up and «+ Задача» is in the header (regression target).
    expect(container.textContent).toContain("Existing task");
    const createButton = createTaskButton(container);
    expect(createButton).toBeDefined();

    // 2. Open the create dialog and submit a task WITHOUT a token.
    await act(async () => {
      createButton?.click();
    });
    // Radix portals dialog content to document.body — query the document.
    const textarea = document.querySelector("textarea");
    expect(textarea).not.toBeNull();
    await act(async () => {
      setInputValue(textarea as HTMLTextAreaElement, "Repro task");
    });
    await act(async () => {
      buttonByText(document.body, "Create task")?.click();
    });

    // 3. The LOGIN WINDOW opens (not the old token panel) with the queued
    //    contextual line, and the create button is still mounted.
    const tokenInput = document.getElementById(
      "login-token-value",
    ) as HTMLInputElement | null;
    expect(tokenInput).toBeDefined();
    expect(document.querySelector('[data-testid="login-dialog"]')).toBeDefined();
    expect(document.body.textContent).toContain(
      "Sign in to continue — your action will run automatically",
    );
    expect(createTaskButton(container)).toBeDefined();

    // 4. Paste the key and press Enter. Enter in a text field triggers
    //    implicit form submission; requestSubmit() is the same standard path
    //    (happy-dom does not synthesize the implicit submit itself).
    await act(async () => {
      setInputValue(tokenInput as HTMLInputElement, "  ui-secret-1  ");
      (tokenInput?.closest("form") as HTMLFormElement | null)?.requestSubmit();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    // 5. The queued create re-ran WITH the fresh bearer token…
    expect(mutationCalls).toHaveLength(1);
    expect(mutationCalls[0]?.auth).toBe("Bearer ui-secret-1");
    // …the task is on the board, the dialogs are closed…
    expect(container.textContent).toContain("Repro task");
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.getElementById("login-token-value")).toBeNull();
    // …the «+ Задача» button is STILL in the header (the reported bug)…
    expect(createTaskButton(container)).toBeDefined();
    // …and the success toast (with its in-app link) renders without killing
    // the tree — the old Link-outside-Router crash.
    expect(container.textContent).toContain("Repro task");
    const toastLink = container.querySelector('a[href="/tasks/TB-42"]');
    expect(toastLink).toBeDefined();
    expect(container.textContent).toContain("Existing task");
  });

  it("manual «Sign in» opens the same window with NO contextual line; login stores the token, no mutation fires", { timeout: 20000 }, async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const fetchImpl = vi.fn(async () => jsonResponse(boardPayload));
    const gateway = new BoardAdapter({ baseUrl: "/api", fetchImpl: fetchImpl as never });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await queryClient.prefetchQuery({
      queryKey: keys.tasks.board(),
      queryFn: () => gateway.board(),
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => {
      root.render(
        <I18nProvider initialLang="en">
          <GatewayContext.Provider value={gateway}>
            <QueryClientProvider client={queryClient}>
              <ToastProvider>
                <UiTokenProvider>
                  <MemoryRouter initialEntries={["/tasks"]}>
                    <TaskListPage />
                    {/* The TopBar sign-in entry (board mode). */}
                    <UiTokenSlot />
                  </MemoryRouter>
                </UiTokenProvider>
              </ToastProvider>
            </QueryClientProvider>
          </GatewayContext.Provider>
        </I18nProvider>,
      );
    });

    // No token yet: no window, the accent «Sign in» is in the bar.
    expect(document.getElementById("login-token-value")).toBeNull();
    const signIn = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.trim() === "Sign in",
    );
    expect(signIn).toBeDefined();

    // Click «Sign in»: the window opens WITHOUT the queued-action line.
    await act(async () => {
      signIn?.click();
    });
    const tokenInput = document.getElementById(
      "login-token-value",
    ) as HTMLInputElement | null;
    expect(tokenInput).toBeDefined();
    expect(document.body.textContent).not.toContain(
      "Sign in to continue — your action will run automatically",
    );

    // Submit a token: window closes, the slot flips to «Sign out»
    // reactively — no reload, no wire call (manual login is not validated
    // against the server until a mutation actually runs).
    await act(async () => {
      setInputValue(tokenInput as HTMLInputElement, "ui-manual");
      (tokenInput?.closest("form") as HTMLFormElement | null)?.requestSubmit();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(document.getElementById("login-token-value")).toBeNull();
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Sign out",
      ),
    ).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // only the prefetch
  });

  it("the rejected (401) window shows the inline error and the queued line, and the token field is masked", { timeout: 20000 }, async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => {
      root.render(
        <I18nProvider initialLang="en">
          <LoginDialog
            open
            reason="rejected"
            onSubmitToken={() => undefined}
            onDismiss={() => undefined}
          />
        </I18nProvider>,
      );
    });
    const input = document.getElementById("login-token-value") as HTMLInputElement | null;
    expect(input).not.toBeNull();
    // Masked by default; the eye toggle is the explicit reveal.
    expect(input?.type).toBe("password");
    // Inline sign-in error (assertive) + the queued-action line + the hint.
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("The server rejected the token (401)");
    expect(document.body.textContent).toContain(
      "Sign in to continue — your action will run automatically",
    );
    expect(document.body.textContent).toContain(
      "kubectl get secret vesmaro-eyes-ui-token",
    );
    expect(document.body.textContent).not.toContain("mnk_"); // no value examples
  });
});
