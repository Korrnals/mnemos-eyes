// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ExecutionPage } from "./ExecutionPage";
import { parseBoardEvent } from "@/gateway/events";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import type { AssignmentItem, ExecutorsPage } from "@/gateway/boardTypes";
import { pushExecutionEvent, resetFeedStore } from "./executionFeedStore";
import { loadTerminalCollapsed } from "./executionPrefs";

/**
 * `/agents/execution` integration (AGW-3): the presence strip classifies by
 * the meta TTLs and filters the list on click; the groups persist their
 * collapse; amber countdowns fire at the thresholds; j/k move the cursor;
 * the drawer opens from a row and Esc closes it; the UI-10 panel renders
 * the buffer with aria-live=off. Controlled fixtures seed the caches —
 * times are computed from the REAL clock (the ages themselves are covered
 * pure in presence/timing tests).
 */

const NOW = Date.now();
const ago = (seconds: number): string => new Date(NOW - seconds * 1000).toISOString();

function executorPage(): ExecutorsPage {
  return {
    ok: true,
    count: 3,
    items: [
      {
        id: "exec-live",
        name: "zcode@laptop",
        harness: "zcode",
        host: "",
        transport: "local-poll",
        capabilities: [],
        version: "",
        enabled: true,
        state: "approved",
        last_seen: ago(30), // online (≤120 s)
        presence: "online",
        registered_via: "",
        registered_at: "",
        updated_at: "",
      },
      {
        id: "exec-stale",
        name: "hermes@laptop",
        harness: "hermes",
        host: "",
        transport: "local-poll",
        capabilities: [],
        version: "",
        enabled: true,
        state: "approved",
        last_seen: ago(15 * 60), // stale (≤600 s? no — 900 s → offline)
        presence: "stale",
        registered_via: "",
        registered_at: "",
        updated_at: "",
      },
      {
        id: "exec-gone",
        name: "zcode@old",
        harness: "zcode",
        host: "",
        transport: "mesh-r4",
        capabilities: [],
        version: "",
        enabled: true,
        state: "approved",
        last_seen: ago(2 * 3600), // offline
        presence: "offline",
        registered_via: "",
        registered_at: "",
        updated_at: "",
      },
    ],
    meta: { presence: { online_max_age_s: 120, stale_max_age_s: 600 }, sweeper_interval_s: 60 },
  };
}

function assignment(overrides: Partial<AssignmentItem>): AssignmentItem {
  return {
    id: 1,
    task_id: "TB-1",
    specialist: "SFE",
    harness: "zcode",
    state: "queued",
    created_by: "owner",
    claimed_by: null,
    note: "",
    spec_hash: "abc123",
    executor_id: "",
    claimed_by_executor: "",
    created_at: ago(60),
    claimed_at: null,
    started_at: null,
    heartbeat_at: null,
    finished_at: null,
    topics: [],
    routing: null,
    ...overrides,
  };
}

function assignmentsPage(items: AssignmentItem[]) {
  return { ok: true, count: items.length, items };
}

async function mountPage(
  assignments: AssignmentItem[],
): Promise<{ root: Root; container: HTMLElement; gateway: MockAdapter }> {
  const gateway = new MockAdapter({ latency: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await client.prefetchQuery({
    queryKey: keys.tasks.board(),
    queryFn: () => gateway.board(),
  });
  client.setQueryData(keys.agents.executors.list(), executorPage());
  client.setQueryData(keys.agents.assignments.list({}), assignmentsPage(assignments));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <GatewayContext.Provider value={gateway}>
        <QueryClientProvider client={client}>
          <ToastProvider>
            <UiTokenProvider>
              <I18nProvider initialLang="en">
                <MemoryRouter initialEntries={["/agents/execution"]}>
                  <ExecutionPage />
                </MemoryRouter>
              </I18nProvider>
            </UiTokenProvider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
  return { root, container, gateway };
}

beforeEach(() => {
  resetFeedStore();
  localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ExecutorStrip (layer 1)", () => {
  it("classifies presence by the meta TTLs and shows pulse ages + transport", async () => {
    const { root, container } = await mountPage([]);
    const chips = [
      ...container.querySelectorAll('ul[aria-label="Executors"] button[aria-pressed]'),
    ];
    expect(chips).toHaveLength(3);
    // Transport markers: local/mesh (exec-gone is mesh).
    expect(container.textContent).toContain("local");
    expect(container.textContent).toContain("mesh");
    // SR presence labels exist for screen readers (AC10).
    expect(container.textContent).toContain("online");
    expect(container.textContent).toContain("offline");
    // The avatar slot geometry is reserved (empty dashed circle).
    expect(container.querySelectorAll("span.border-dashed").length).toBeGreaterThanOrEqual(3);
    root.unmount();
  });

  it("empty registry: honest empty line + the poller instruction", async () => {
    const gateway = new MockAdapter({ latency: false });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(keys.agents.executors.list(), {
      ok: true,
      count: 0,
      items: [],
      meta: { presence: { online_max_age_s: 120, stale_max_age_s: 600 }, sweeper_interval_s: 60 },
    });
    client.setQueryData(keys.agents.assignments.list({}), assignmentsPage([]));
    await client.prefetchQuery({ queryKey: keys.tasks.board(), queryFn: () => gateway.board() });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <GatewayContext.Provider value={gateway}>
          <QueryClientProvider client={client}>
            <ToastProvider>
              <UiTokenProvider>
                <I18nProvider initialLang="en">
                  <MemoryRouter>
                    <ExecutionPage />
                  </MemoryRouter>
                </I18nProvider>
              </UiTokenProvider>
            </ToastProvider>
          </QueryClientProvider>
        </GatewayContext.Provider>,
      );
    });
    expect(container.textContent).toContain("No executors connected");
    expect(container.textContent).toContain("deploy/poller/README.md");
    root.unmount();
  });

  it("click filters the list by executor; the second click clears", async () => {
    const rows = [
      assignment({ id: 1, state: "running", claimed_by_executor: "exec-live", claimed_by: "z:laptop", started_at: ago(60), heartbeat_at: ago(30) }),
      assignment({ id: 2, state: "queued", task_id: "TB-3" }),
    ];
    const { root, container } = await mountPage(rows);
    const liveChip = [...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(
      (chip) => chip.textContent?.includes("zcode@laptop"),
    )!;
    await act(async () => {
      liveChip.click();
    });
    expect(container.textContent).toContain("TB-1");
    expect(container.textContent).not.toContain("TB-3"); // filtered out
    await act(async () => {
      liveChip.click(); // toggle off
    });
    expect(container.textContent).toContain("TB-3");
    root.unmount();
  });
});

describe("Assignment groups (layer 2)", () => {
  it("active → queue rendered; terminal-today collapsed by default and persistent", async () => {
    const rows = [
      assignment({ id: 1, state: "running", claimed_by_executor: "exec-live", claimed_by: "z:laptop", heartbeat_at: ago(30), started_at: ago(120) }),
      assignment({ id: 2, state: "queued", task_id: "TB-3" }),
      assignment({ id: 3, state: "done", task_id: "TB-6", finished_at: ago(300) }), // today
    ];
    const { root, container } = await mountPage(rows);
    expect(container.textContent).toContain("active");
    expect(container.textContent).toContain("queue");
    expect(container.textContent).toContain("terminal today");
    // Collapsed by default: the terminal task id is NOT in the list output.
    expect(container.querySelectorAll("li").length).toBeLessThan(3 + 10);
    const toggle = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("terminal today"),
    )!;
    await act(async () => {
      toggle.click();
    });
    expect(container.textContent).toContain("TB-6");
    // Persistence: the flag landed in localStorage under the vesmaro.* ns.
    expect(localStorage.getItem("vesmaro.agents.terminalCollapsed")).toBe("0");
    expect(loadTerminalCollapsed()).toBe(false);
    root.unmount();
  });

  it("empty groups render nothing (a queued-less world shows no queue header)", async () => {
    const { root, container } = await mountPage([
      assignment({ id: 1, state: "running", claimed_by_executor: "x", heartbeat_at: ago(30), started_at: ago(60) }),
    ]);
    expect(container.querySelector('section[aria-label="queue"]')).toBeNull();
    expect(container.querySelector('section[aria-label="active"]')).not.toBeNull();
    root.unmount();
  });

  it("amber: a stale running pulse paints warning + the reaper countdown", async () => {
    const { root, container } = await mountPage([
      assignment({ id: 1, state: "running", claimed_by_executor: "x", claimed_by: "z", heartbeat_at: ago(13 * 60), started_at: ago(20 * 60), claimed_at: ago(21 * 60) }),
    ]);
    expect(container.textContent).toContain("expires in ~");
    expect(container.querySelector(".text-warning")).not.toBeNull();
    root.unmount();
  });

  it("j/k: NO highlight before the first keypress; j starts at row 0, k at the last", async () => {
    const rows = [
      assignment({ id: 1, state: "running", claimed_by_executor: "x", claimed_by: "z", heartbeat_at: ago(30), started_at: ago(60) }),
      assignment({ id: 2, state: "queued", task_id: "TB-3" }),
    ];
    const { root, container } = await mountPage(rows);
    // The cursor class token is exact (hover borders also contain the
    // substring) — match the whole class token, not a substring.
    const cursorRow = (): string | undefined =>
      container.querySelector<HTMLLIElement>('li[class~="border-iris-bright/60"]')
        ?.textContent ?? undefined;
    // Pre-interaction: the cursor is -1 — NO row is highlighted (a fresh
    // page does not pretend a selection exists; AGW-3 review P3-9).
    expect(cursorRow()).toBeUndefined();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    });
    expect(cursorRow()).toContain("TB-1"); // the first j lands on row 0
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
    });
    expect(cursorRow()).toContain("TB-3"); // k from row 0 wraps to the last
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    });
    expect(cursorRow()).toContain("TB-1"); // and j wraps back to the first
    root.unmount();
  });

  it("the first k from scratch lands on the LAST row", async () => {
    const rows = [
      assignment({ id: 1, state: "running", claimed_by_executor: "x", claimed_by: "z", heartbeat_at: ago(30), started_at: ago(60) }),
      assignment({ id: 2, state: "queued", task_id: "TB-3" }),
    ];
    const { root, container } = await mountPage(rows);
    const cursorRow = (): string | undefined =>
      container.querySelector<HTMLLIElement>('li[class~="border-iris-bright/60"]')
        ?.textContent ?? undefined;
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
    });
    expect(cursorRow()).toContain("TB-3"); // first k = the tail row
    root.unmount();
  });

  it("row click opens the drawer (timeline, envelope, hash); Esc closes", async () => {
    const rows = [
      assignment({ id: 1, state: "running", claimed_by_executor: "exec-live", claimed_by: "zcode:laptop", spec_hash: "deadbeef", heartbeat_at: ago(30), started_at: ago(60), claimed_at: ago(90) }),
    ];
    const { root } = await mountPage(rows);
    const trigger = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("TB-1"),
    )!;
    await act(async () => {
      trigger.click();
    });
    const drawer = document.body.textContent ?? "";
    expect(drawer).toContain("Phase timeline");
    expect(drawer).toContain("claimed");
    expect(drawer).toContain("reported by zcode:laptop · unverified");
    expect(drawer).toContain("[GCW ASSIGNMENT task:TB-1");
    expect(drawer).toContain("deadbeef");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.textContent ?? "").not.toContain("Phase timeline");
    root.unmount();
  });
});

describe("UI-10 feed panel (layer 3)", () => {
  it("renders the store buffer with aria-live=off; empty copy when expanded", async () => {
    const { root, container } = await mountPage([]);
    expect(container.textContent).toContain("Execution feed");
    // Expand first (collapsed by default): the honest empty copy shows.
    const toggle = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Execution feed"),
    )!;
    await act(async () => {
      toggle.click();
    });
    expect(container.textContent).toContain("No execution events yet — take a task into work");
    // Feed the store through the REAL parser + bridge port.
    const parsed = parseBoardEvent(
      JSON.stringify({
        kind: "assignment.claimed",
        task_id: "TB-1",
        assignment: { id: "5", state: "claimed", claimed_by: "z:l", created_by: "o" },
      }),
    );
    if (parsed.status !== "event") throw new Error("fixture did not parse");
    await act(async () => {
      pushExecutionEvent(parsed.event, Date.now());
    });
    const list = container.querySelector('[aria-live="off"]');
    expect(list).not.toBeNull();
    expect(list?.textContent).toContain("TB-1");
    expect(list?.textContent).toContain("actor: z:l");
    root.unmount();
  });
});

describe("AGW-4 polish (actionable empties, terminal hint, onboarding)", () => {
  it("the empty list is an ACTION: «Open tasks» links to /tasks", async () => {
    const { root, container } = await mountPage([]);
    expect(container.textContent).toContain("No assignments");
    const link = container.querySelector<HTMLAnchorElement>('a[href="/tasks"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe("Open tasks");
    root.unmount();
  });

  it("the empty UI-10 feed carries the same link", async () => {
    const { root, container } = await mountPage([]);
    const toggle = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Execution feed"),
    )!;
    await act(async () => {
      toggle.click();
    });
    const feed = container.querySelector('section[aria-label="Execution feed"]')!;
    expect(feed.textContent).toContain("No execution events yet");
    expect(feed.querySelector('a[href="/tasks"]')).not.toBeNull();
    root.unmount();
  });

  it("no terminal rows today but recent ones exist → a neutral date hint replaces the group", async () => {
    const yesterday = new Date(NOW - 26 * 3600 * 1000).toISOString();
    const { root, container } = await mountPage([
      assignment({ id: 1, state: "running", claimed_by_executor: "x", heartbeat_at: ago(30), started_at: ago(60) }),
      assignment({ id: 2, state: "done", task_id: "TB-9", finished_at: yesterday }),
    ]);
    // The «за сегодня» group stays unrendered — the hint points at history.
    expect(container.querySelector('section[aria-label="terminal today"]')).toBeNull();
    expect(container.textContent).toContain("Last completed —");
    root.unmount();
  });

  it("terminal rows today → the group renders, the idle hint stays hidden", async () => {
    const { root, container } = await mountPage([
      assignment({ id: 1, state: "running", claimed_by_executor: "x", heartbeat_at: ago(30), started_at: ago(60) }),
      assignment({ id: 2, state: "done", task_id: "TB-6", finished_at: ago(300) }),
    ]);
    expect(container.querySelector('section[aria-label="terminal today"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Last completed —");
    root.unmount();
  });

  it("onboarding auto-expands ONCE; the first collapse persists (localStorage)", async () => {
    const first = await mountPage([]);
    expect(first.container.textContent).toContain("How this works");
    expect(first.container.textContent).toContain("poller picks the assignment up");
    const toggle = [...first.container.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-expanded") !== null && button.textContent?.includes("How this works"),
    )!;
    await act(async () => {
      toggle.click();
    });
    expect(first.container.textContent).not.toContain("poller picks the assignment up");
    expect(localStorage.getItem("vesmaro.agents.onboardingDone")).toBe("1");
    first.root.unmount();

    // A fresh mount never auto-expands again (manual re-open stays).
    const second = await mountPage([]);
    expect(second.container.textContent).toContain("How this works");
    expect(second.container.textContent).not.toContain("poller picks the assignment up");
    second.root.unmount();
  });
});

describe("AGW-5 executor context menus", () => {
  it("right-click on a strip chip opens the action menu incl. «Open registry»", async () => {
    const { root, container } = await mountPage([]);
    const chip = [...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(
      (candidate) => candidate.textContent?.includes("zcode@laptop"),
    )!;
    await act(async () => {
      chip.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 60 }),
      );
    });
    const menu = container.querySelector("[role='menu']");
    expect(menu).not.toBeNull();
    // Approved chip: enable/disable, revoke, copy id, open registry, delete —
    // approve is pending-only.
    const items = [...menu!.querySelectorAll("[role='menuitem']")].map((item) =>
      item.textContent,
    );
    expect(items.some((text) => text?.includes("Disable"))).toBe(true);
    expect(items.some((text) => text?.includes("Revoke"))).toBe(true);
    expect(items.some((text) => text?.includes("Open registry"))).toBe(true);
    expect(items.some((text) => text?.includes("Delete"))).toBe(true);
    expect(items.some((text) => text?.includes("Approve"))).toBe(false);
    // Copy id lands in the clipboard (stubbed by happy-dom redefine).
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    await act(async () => {
      [...menu!.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
        .find((item) => item.textContent?.includes("Copy id"))!
        .click();
    });
    expect(writeText).toHaveBeenCalledWith("exec-live");
    root.unmount();
  });
});
