import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TaskDetailPage } from "@/features/tasks/TaskDetailPage";
import { TaskExecutionTab } from "@/features/agents/TaskExecutionTab";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import type { AssignmentItem, BoardTask } from "@/gateway/boardTypes";

/**
 * «Исполнение» tab (AGW-2): the deep-linked 5th tab of /tasks/:id renders
 * the task's assignment queue — the 7-state matrix (text badges + shape
 * markers), the UNVERIFIED declared-identity chip (spec §2.2 — the
 * regression test), routing signatures, cancel/retry affordances and the
 * empty state with the «Взять в работу» CTA. renderToString (node env),
 * same posture as TaskDetailPage.test.tsx.
 */

function assignment(overrides: Partial<AssignmentItem>): AssignmentItem {
  return {
    id: 1,
    task_id: "TB-10",
    specialist: "@GCW: Senior Frontend Developer",
    harness: "zcode",
    state: "queued",
    created_by: "owner",
    claimed_by: null,
    note: "",
    spec_hash: "deadbeef",
    executor_id: "",
    claimed_by_executor: "",
    created_at: "2026-09-19T08:50:00+00:00",
    claimed_at: null,
    started_at: null,
    heartbeat_at: null,
    finished_at: null,
    topics: [],
    routing: null,
    ...overrides,
  };
}

/** All 7 states on ONE task — the state-matrix fixture. */
function allStates(): AssignmentItem[] {
  return [
    assignment({ id: 1, state: "queued", routing: { resolved: "exec-laptop-zcode", reason: "global-default" } }),
    assignment({
      id: 2,
      state: "claimed",
      claimed_by: "zcode:laptop",
      claimed_by_executor: "exec-laptop-zcode",
      claimed_at: "2026-09-19T08:44:00+00:00",
      routing: { resolved: "exec-laptop-zcode", reason: "specialist" },
    }),
    assignment({
      id: 3,
      state: "running",
      claimed_by: "zcode:laptop",
      claimed_by_executor: "exec-laptop-zcode",
      started_at: "2026-09-19T08:40:00+00:00",
      heartbeat_at: "2026-09-19T08:58:30+00:00",
      routing: { resolved: "exec-laptop-zcode", reason: "auto" },
    }),
    assignment({
      id: 4,
      state: "done",
      finished_at: "2026-09-19T07:00:00+00:00",
      note: "final ok",
      routing: { resolved: "exec-mesh-qa", reason: "specialist" },
    }),
    assignment({
      id: 5,
      state: "failed",
      finished_at: "2026-09-19T06:00:00+00:00",
      note: "boom",
      routing: { resolved: "exec-copilot-revoked", reason: "explicit" },
    }),
    assignment({
      id: 6,
      state: "cancelled",
      finished_at: "2026-09-19T05:00:00+00:00",
      routing: { resolved: "exec-laptop-zcode", reason: "global-default" },
    }),
    assignment({
      id: 7,
      state: "expired",
      finished_at: "2026-09-19T04:00:00+00:00",
      routing: { resolved: "exec-old-poller", reason: "auto" },
    }),
  ];
}

async function makeClient(items: AssignmentItem[]): Promise<QueryClient> {
  const gateway = new MockAdapter({ latency: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await client.prefetchQuery({
    queryKey: keys.tasks.board(),
    queryFn: () => gateway.board(),
  });
  await client.prefetchQuery({
    queryKey: keys.agents.executors.list(),
    queryFn: () => gateway.listExecutors(),
  });
  client.setQueryData(keys.agents.assignments.list({ task_id: "TB-10" }), {
    ok: true,
    count: items.filter((row) => row.task_id === "TB-10").length,
    items: items.filter((row) => row.task_id === "TB-10"),
  });
  return client;
}

function Providers({ client, children }: { client: QueryClient; children: React.ReactNode }) {
  const gateway = new MockAdapter({ latency: false });
  return (
    <GatewayContext.Provider value={gateway}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <UiTokenProvider>
            <I18nProvider initialLang="en">
              <MemoryRouter>
                {children}
              </MemoryRouter>
            </I18nProvider>
          </UiTokenProvider>
        </ToastProvider>
      </QueryClientProvider>
    </GatewayContext.Provider>
  );
}

/** The task row the tab renders (TB-10: open, no corpus assignments). */
function tb10(gateway: MockAdapter): Promise<BoardTask> {
  return gateway.taskById("TB-10");
}

describe("TaskExecutionTab — state matrix + identity + routing (renderToString)", () => {
  it("renders ALL 7 lifecycle states as text badges (never colour alone)", async () => {
    const client = await makeClient(allStates());
    const task = await tb10(new MockAdapter({ latency: false }));
    const html = renderToString(
      <Providers client={client}>
        <TaskExecutionTab task={task} />
      </Providers>,
    );
    for (const label of [
      "queued",
      "claimed",
      "running",
      "done",
      "failed",
      "cancelled",
      "expired",
    ]) {
      expect(html).toContain(`>${label}<`);
    }
    // Mono meta line carries the specialist/harness identity of the attempt.
    expect(html).toContain("@GCW: Senior Frontend Developer");
    expect(html).toContain("zcode");
  });

  it("the declared identity renders with the UNVERIFIED signature (spec §2.2 regression)", async () => {
    const client = await makeClient(allStates());
    const task = await tb10(new MockAdapter({ latency: false }));
    const html = renderToString(
      <Providers client={client}>
        <TaskExecutionTab task={task} />
      </Providers>,
    );
    expect(html).toContain("reported by zcode:laptop · unverified");
    expect(html).toContain("Identity declared by the executor");
  });

  it("routing signatures: resolved rows name the executor, unmatched waits honestly", async () => {
    const client = await makeClient([
      ...allStates(),
      // An unmatched ACTIVE row on this task — the honest wait signature.
      assignment({ id: 8, state: "queued", routing: { resolved: null, reason: "unmatched" } }),
    ]);
    const task = await tb10(new MockAdapter({ latency: false }));
    const html = renderToString(
      <Providers client={client}>
        <TaskExecutionTab task={task} />
      </Providers>,
    );
    // Resolved — executor NAME (registry lookup), not the raw id.
    expect(html).toContain("route: zcode@laptop");
    expect(html).toContain("by specialist");
    expect(html).toContain("default executor");
    // Unmatched renders exactly once (the queued row; terminal null-routing
    // rows would also fall back — this fixture gives them real routes).
    expect(html.match(/waiting for an executor/g)).toHaveLength(1);
  });

  it("actions: cancel only on active rows, retry only on failed/expired", async () => {
    const client = await makeClient(allStates());
    const task = await tb10(new MockAdapter({ latency: false }));
    const html = renderToString(
      <Providers client={client}>
        <TaskExecutionTab task={task} />
      </Providers>,
    );
    const cancelButtons = (html.match(/>Cancel</g) ?? []).length;
    const retryButtons = (html.match(/>Restart</g) ?? []).length;
    expect(cancelButtons).toBe(3); // queued + claimed + running
    expect(retryButtons).toBe(2); // failed + expired
    // No «Взять в работу» while an attempt is active (≤1 invariant).
    expect(html).not.toContain(">Take into work<");
  });

  it("empty state: honest message + the «Взять в работу» CTA", async () => {
    const client = await makeClient([]);
    const task = await tb10(new MockAdapter({ latency: false }));
    const html = renderToString(
      <Providers client={client}>
        <TaskExecutionTab task={task} />
      </Providers>,
    );
    expect(html).toContain("No assignments yet");
    expect(html).toContain(">Take into work<");
  });
});

describe("TaskDetailPage integration — the 5th tab is a deep link", () => {
  it("?tab=execution renders the tab nav entry and the queue", async () => {
    const gateway = new MockAdapter({ latency: false });
    const client = await makeClient(allStates());
    const html = renderToString(
      <GatewayContext.Provider value={gateway}>
        <QueryClientProvider client={client}>
          <ToastProvider>
            <UiTokenProvider>
              <I18nProvider initialLang="en">
                <MemoryRouter initialEntries={["/tasks/TB-10?tab=execution"]}>
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
    expect(html).toContain("Execution"); // nav entry
    expect(html).toContain("?tab=execution"); // deep-link href
    expect(html).toContain("Task assignments"); // the tab content header
  });
});
