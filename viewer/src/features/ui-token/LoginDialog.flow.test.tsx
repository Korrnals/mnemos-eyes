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
import { Sidebar } from "@/layout/Sidebar";
import { I18nProvider } from "@/i18n";
import { keys } from "@/lib/queryKeys";
import { clearUiToken, hasUiToken } from "@/gateway/uiToken";
import {
  DEVICE_SCOPE_STORAGE_KEY,
  DEVICE_TOKEN_STORAGE_KEY,
} from "@/gateway/deviceToken";
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

/**
 * Viewport stub (UI-22 test-env seam): the sidebar expansion is state-driven
 * through matchMedia, and happy-dom answers "no match" by default — which
 * renders the mobile icon rail and HIDES the footer mode line these flow
 * tests assert on. These tests run on a desktop viewport.
 */
function stubMatchMedia(matches: boolean): void {
  const stub = (query: string) => ({
    matches,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  (globalThis as { matchMedia: unknown }).matchMedia = stub;
  (window as { matchMedia: unknown }).matchMedia = stub;
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", new MemoryStorage());
  stubMatchMedia(true);
  localStorage.clear();
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
      // ADR 0014 Ф1: the login verifies at the door before anything is stored.
      if (url.endsWith("/api/auth/ui-token") && (init?.method ?? "GET") === "POST") {
        return jsonResponse({ ok: true, token_class: "ui" });
      }
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
    // …the login itself is CONFIRMED (fix/login-feedback): the success toast
    // lands beside the create toast — the window no longer closes silently.
    expect(container.textContent).toContain("Signed in — control available");
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

    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        // ADR 0014 Ф1: the manual sign-in verifies against the server too.
        if (url.endsWith("/api/auth/ui-token") && (init?.method ?? "GET") === "POST") {
          return jsonResponse({ ok: true, token_class: "ui" });
        }
        return jsonResponse(boardPayload);
      },
    );
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
    const root: Root = createRoot(container);
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
                    {/* The session-aware footer (fix/login-feedback): the
                     * reactive flip is asserted below, no reload involved. */}
                    <Sidebar collapsed={false} onToggle={() => undefined} />
                    {/* The TopBar sign-in entry (board mode). */}
                    <UiTokenSlot />
                    {/* The visible toast region (same placement as Shell). */}
                    <ToastViewport />
                  </MemoryRouter>
                </UiTokenProvider>
              </ToastProvider>
            </QueryClientProvider>
          </GatewayContext.Provider>
        </I18nProvider>,
      );
    });

    // No token yet: no window, the accent «Sign in» is in the bar, and the
    // footer states the read-only contract.
    expect(document.getElementById("login-token-value")).toBeNull();
    const signIn = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.trim() === "Sign in",
    );
    expect(signIn).toBeDefined();
    expect(container.textContent).toContain("read-only");

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
    // reactively — no reload. ADR 0014 Ф1: the value went through the
    // server verify first; only a 200 stores it.
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
    // fix/login-feedback: the login is CONFIRMED by a toast, and the footer
    // flips to the active-session line in the SAME render — no reload.
    expect(container.textContent).toContain("Signed in — control available");
    expect(container.textContent).toContain("session active");
    expect(container.textContent).not.toContain("read-only");
    // Reads may fly (board/inbox queries) and the verify POST is the login
    // itself; a manual login must fire NO MUTATION POST.
    const mutationPosts = fetchImpl.mock.calls.filter(
      ([input, init]) =>
        (init?.method ?? "GET") === "POST" &&
        !String(input).endsWith("/api/auth/ui-token"),
    );
    expect(mutationPosts).toHaveLength(0);
  });

  it("a server-rejected token (401 on the retried action) reopens the window AND pushes the error toast", { timeout: 20000 }, async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    // Every POST to /api/tasks answers 401 — even with the freshly pasted
    // bearer, so the queued create's retry is REJECTED and the gate
    // reopens the window. The verify POST (ADR 0014 Ф1) succeeds — the
    // refusal is genuinely mid-flight.
    const mutationCalls: { auth: string | null }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/auth/ui-token") && (init?.method ?? "GET") === "POST") {
        return jsonResponse({ ok: true, token_class: "ui" });
      }
      if (url.endsWith("/api/tasks") && (init?.method ?? "GET") === "POST") {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const auth = headers.Authorization ?? null;
        mutationCalls.push({ auth });
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      return jsonResponse(boardPayload);
    });
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
    const root: Root = createRoot(container);
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
                    <ToastViewport />
                  </MemoryRouter>
                </UiTokenProvider>
              </ToastProvider>
            </QueryClientProvider>
          </GatewayContext.Provider>
        </I18nProvider>,
      );
    });

    // Create without a token → the login window (required).
    const createButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Task",
    );
    await act(async () => {
      createButton?.click();
    });
    const textarea = document.querySelector("textarea");
    await act(async () => {
      setInputValue(textarea as HTMLTextAreaElement, "Doomed task");
    });
    await act(async () => {
      buttonByText(document.body, "Create task")?.click();
    });
    let tokenInput = document.getElementById("login-token-value") as HTMLInputElement | null;
    expect(tokenInput).not.toBeNull();

    // Paste a token the server will refuse: the retry 401s → the window
    // REOPENS with the inline rejection line…
    await act(async () => {
      setInputValue(tokenInput as HTMLInputElement, "ui-bad-token");
      (tokenInput?.closest("form") as HTMLFormElement | null)?.requestSubmit();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(mutationCalls).toEqual([{ auth: "Bearer ui-bad-token" }]);
    tokenInput = document.getElementById("login-token-value") as HTMLInputElement | null;
    expect(tokenInput).not.toBeNull();
    expect(document.querySelector('[data-testid="login-dialog"]')).not.toBeNull();
    // Scoped to the dialog: the error toast card also carries role="alert"
    // and lives in an earlier document node than the Radix portal.
    // ADR 0014: a mid-flight refusal is the SESSION beat — «сессия
    // истекла» — not the at-the-door "check the value" text.
    const alert = document.querySelector('[data-testid="login-dialog"] [role="alert"]');
    expect(alert?.textContent).toContain("Your session expired — sign in again.");
    // …AND the rejection is announced as an error toast (fix/login-feedback),
    // beside the inline message — not instead of it.
    expect(container.textContent).toContain("Token rejected");
    expect(container.textContent).toContain("The server answered 401");
    // The stored toast fired too (the value did land in the tab); the error
    // toast + reopened window carry the server verdict.
    expect(container.textContent).toContain("Signed in — control available");
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
    // Default rejectKind is the at-the-door beat (ADR 0014 Ф1).
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      "The server did not accept the token — check the value and try again.",
    );
    expect(document.body.textContent).toContain(
      "Sign in to continue — your action will run automatically",
    );
    expect(document.body.textContent).toContain(
      "kubectl -n kube-agents get secret vesmaro-eyes-ui-token",
    );
    // Regression (prod hotfix login-hint): the hint must teach the WORKING
    // value-extraction command (jsonpath + decode), never the `-o yaml`
    // form that hands the user a base64 blob → "invalid ui token".
    expect(document.body.textContent).toContain("-o jsonpath='{.data.VESMARO_UI_TOKEN}'");
    expect(document.body.textContent).toContain("| base64 -d");
    expect(document.body.textContent).not.toContain("-o yaml");
    expect(document.body.textContent).not.toContain("mnk_"); // no value examples
  });
});

/**
 * UI-22 device beat, scope v1 (ADR 0012 Amendment): a PAIRED device with
 * the `read` scope (localStorage `vesmaro.deviceToken` +
 * `vesmaro.deviceScope`) cannot mutate — every mutation is a server 403
 * verdict — so the attempt surfaces the HONEST refusal toast, never the
 * login window (the 401 affordance) and never a mutation POST.
 */
describe("paired device (UI-22, read scope): mutation attempt → honest toast, no login window", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it("create on a read-scope device: deviceForbidden toast, window stays closed, zero mutation POSTs", { timeout: 20000 }, async () => {
    localStorage.setItem(DEVICE_TOKEN_STORAGE_KEY, "mnd_paired-device");
    localStorage.setItem(DEVICE_SCOPE_STORAGE_KEY, "read");
    // No owner session: the boot probe (GET /api/auth/ui-token) refuses.
    // The mutation POST route would 403 — if it is EVER called the test
    // fails on the POST assertion below, which is the point.
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/auth/ui-token")) {
        return new Response(null, { status: (init?.method ?? "GET") === "GET" ? 401 : 204 });
      }
      if (url.endsWith("/api/tasks") && (init?.method ?? "GET") === "POST") {
        return jsonResponse({ error: "device scope is read-only" }, 403);
      }
      return jsonResponse(boardPayload);
    });
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
    const root: Root = createRoot(container);
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
                    <ToastViewport />
                  </MemoryRouter>
                </UiTokenProvider>
              </ToastProvider>
            </QueryClientProvider>
          </GatewayContext.Provider>
        </I18nProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Create without a ui token on a paired READ-scope device…
    const createButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Task",
    );
    await act(async () => {
      createButton?.click();
    });
    const textarea = document.querySelector("textarea");
    await act(async () => {
      setInputValue(textarea as HTMLTextAreaElement, "Device task");
    });
    await act(async () => {
      buttonByText(document.body, "Create task")?.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    // …the LOGIN WINDOW never opens (the 403 is not a 401)…
    expect(document.getElementById("login-token-value")).toBeNull();
    expect(document.querySelector('[data-testid="login-dialog"]')).toBeNull();
    // …the honest refusal toast lands instead…
    expect(container.textContent).toContain("Actions from this device are closed");
    expect(container.textContent).toContain("This device's scope is read-only");
    // …and the request never left the browser: the 403 is announced up
    // front, not fetched.
    const mutationPosts = fetchImpl.mock.calls.filter(
      ([input, init]) =>
        String(input).endsWith("/api/tasks") && (init?.method ?? "GET") === "POST",
    );
    expect(mutationPosts).toHaveLength(0);
  });
});

/**
 * Scope v1 (ADR 0012 Amendment): a `control` device (the DEFAULT since the
 * archcom ruling) mutates the board with NO owner session — the POST flies,
 * the board folds the answer in, and no refusal toast appears. (Closed
 * routes still answer 403 — the server's own honest per-action detail.)
 */
describe("paired device (scope v1, control): mutation runs without an owner session", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it("create on a control-scope device: POST flies, no toast, no window", { timeout: 20000 }, async () => {
    localStorage.setItem(DEVICE_TOKEN_STORAGE_KEY, "mnd_paired-device");
    // no scope key — the pre-scope-v1 storage shape; reads as control
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/auth/ui-token")) {
        return new Response(null, { status: (init?.method ?? "GET") === "GET" ? 401 : 204 });
      }
      if (url.endsWith("/api/tasks") && (init?.method ?? "GET") === "POST") {
        return jsonResponse(
          {
            id: "t-device-1", col: "open", title: "Device task",
            summary: "", spec: "", status: "open", priority: "normal",
            env: "unknown", agents: [], specialists: [], project: "",
            memory_ids: [], mnemos_tags: [], archived: false,
            position: 1, created_at: "2026-09-23T00:00:00+00:00",
            updated_at: "2026-09-23T00:00:00+00:00", validating_since: "",
            archived_from: "",
          },
          201,
        );
      }
      return jsonResponse(boardPayload);
    });
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
    const root: Root = createRoot(container);
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
                    <ToastViewport />
                  </MemoryRouter>
                </UiTokenProvider>
              </ToastProvider>
            </QueryClientProvider>
          </GatewayContext.Provider>
        </I18nProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const createButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Task",
    );
    await act(async () => {
      createButton?.click();
    });
    const textarea = document.querySelector("textarea");
    await act(async () => {
      setInputValue(textarea as HTMLTextAreaElement, "Device task");
    });
    await act(async () => {
      buttonByText(document.body, "Create task")?.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    // the mutation LEFT the browser and succeeded…
    const mutationPosts = fetchImpl.mock.calls.filter(
      ([input, init]) =>
        String(input).endsWith("/api/tasks") && (init?.method ?? "GET") === "POST",
    );
    expect(mutationPosts).toHaveLength(1);
    const [, postInit] = mutationPosts[0] as [RequestInfo | URL, RequestInit];
    expect(new Headers(postInit?.headers).get("Authorization")).toBe(
      "Bearer mnd_paired-device",
    );
    // …no refusal toast, no login window
    expect(container.textContent).not.toContain("Actions from this device are closed");
    expect(document.querySelector('[data-testid="login-dialog"]')).toBeNull();
  });
});

/**
 * ADR 0014 owner session (Ф2): one login per BROWSER. The board server
 * keeps the session in the HttpOnly `vesmaro_ui` cookie; a fresh tab holds
 * no sessionStorage token but rides the cookie — the boot probe (GET
 * /api/auth/ui-token → 204) must hydrate hasUiToken() so no window opens,
 * and the logout must tear the session down SERVER-side (DELETE), because
 * an HttpOnly cookie cannot be cleared from JS.
 */
describe("owner session (ADR 0014): boot hydration + server-side logout", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  function probeAwareFetch(options: {
    probeStatus: number;
    mutationAuth?: (headers: Record<string, string>) => Response;
  }) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/auth/ui-token")) {
        if (method === "GET") {
          return new Response(null, { status: options.probeStatus });
        }
        if (method === "POST") return jsonResponse({ ok: true, token_class: "ui" });
        return new Response(null, { status: 204 }); // DELETE logout
      }
      if (url.endsWith("/api/tasks") && method === "POST") {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        return (
          options.mutationAuth?.(headers) ?? jsonResponse({ error: "unauthorized" }, 401)
        );
      }
      return jsonResponse(boardPayload);
    });
  }

  it("boot probe 204: a fresh tab (no stored token) is signed in — the window never opens and the create rides the cookie", { timeout: 20000 }, async () => {
    const fetchImpl = probeAwareFetch({
      probeStatus: 204,
      mutationAuth: () => jsonResponse(createdTask, 201), // the server accepts the COOKIE leg
    });
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
    const root: Root = createRoot(container);
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
                    <UiTokenSlot />
                    <ToastViewport />
                  </MemoryRouter>
                </UiTokenProvider>
              </ToastProvider>
            </QueryClientProvider>
          </GatewayContext.Provider>
        </I18nProvider>,
      );
    });

    // Hydrated: the slot shows «Sign out» although NOTHING is stored.
    expect(hasUiToken()).toBe(false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Sign out",
      ),
    ).toBe(true);

    // A mutation just RUNS — no login window, and the request ships
    // headerless (the server reads the cookie).
    const createButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Task",
    );
    await act(async () => {
      createButton?.click();
    });
    const textarea = document.querySelector("textarea");
    await act(async () => {
      setInputValue(textarea as HTMLTextAreaElement, "Cookie task");
    });
    await act(async () => {
      buttonByText(document.body, "Create task")?.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(document.getElementById("login-token-value")).toBeNull();
    // The task landed (the server's createdTask echoes back) and the
    // success toast fired — the whole create ran with NO login window.
    expect(container.textContent).toContain("Task TB-42 created");
    expect(container.textContent).toContain("Repro task");
    const createCall = fetchImpl.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith("/api/tasks") && (init?.method ?? "GET") === "POST",
    );
    const headers = (createCall?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization ?? null).toBeNull(); // cookie leg: no Authorization header
  });

  it("boot probe 401: nothing stored → the tab stays read-only (accent Sign in)", { timeout: 20000 }, async () => {
    const fetchImpl = probeAwareFetch({ probeStatus: 401 });
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
    const root: Root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => {
      root.render(
        <I18nProvider initialLang="en">
          <GatewayContext.Provider value={gateway}>
            <QueryClientProvider client={queryClient}>
              <ToastProvider>
                <UiTokenProvider>
                  <MemoryRouter initialEntries={["/tasks"]}>
                    <UiTokenSlot />
                    <ToastViewport />
                  </MemoryRouter>
                </UiTokenProvider>
              </ToastProvider>
            </QueryClientProvider>
          </GatewayContext.Provider>
        </I18nProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Sign in",
      ),
    ).toBe(true);
  });

  it("logout fires DELETE /api/auth/ui-token and flips to signed-out only after it", { timeout: 20000 }, async () => {
    const fetchImpl = probeAwareFetch({ probeStatus: 401 });
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
    const root: Root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => {
      root.render(
        <I18nProvider initialLang="en">
          <GatewayContext.Provider value={gateway}>
            <QueryClientProvider client={queryClient}>
              <ToastProvider>
                <UiTokenProvider>
                  <MemoryRouter initialEntries={["/tasks"]}>
                    <UiTokenSlot />
                    <ToastViewport />
                  </MemoryRouter>
                </UiTokenProvider>
              </ToastProvider>
            </QueryClientProvider>
          </GatewayContext.Provider>
        </I18nProvider>,
      );
    });

    // Sign in through the real verify flow.
    const signIn = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Sign in",
    );
    await act(async () => {
      signIn?.click();
    });
    const tokenInput = document.getElementById("login-token-value") as HTMLInputElement;
    await act(async () => {
      setInputValue(tokenInput, "ui-logout-flow");
      (tokenInput.closest("form") as HTMLFormElement | null)?.requestSubmit();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const signOut = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Sign out",
    );
    expect(signOut).toBeDefined();

    // Sign out: the DELETE rides first (the cookie is HttpOnly — JS cannot
    // clear it), then the local scrub flips the slot back to «Sign in».
    await act(async () => {
      signOut?.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const deleteCall = fetchImpl.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith("/api/auth/ui-token") &&
        (init?.method ?? "GET") === "DELETE",
    );
    expect(deleteCall).toBeDefined();
    expect(hasUiToken()).toBe(false);
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Sign in",
      ),
    ).toBe(true);
  });
});
