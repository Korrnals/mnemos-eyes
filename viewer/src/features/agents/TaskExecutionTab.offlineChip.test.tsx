// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TaskExecutionTab } from "./TaskExecutionTab";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import type { AssignmentItem, BoardTask } from "@/gateway/boardTypes";

/**
 * AGW-2 review P3-1, browser arm: mounted (ticker LIVE), the wait chip on
 * an offline-resolved route carries the OFFLINE AGE — the renderToString
 * arm covers the pre-tick shape without it.
 */

const TASK: BoardTask = {
  id: "TB-10",
  col: "open",
  position: 0,
  title: "T",
  summary: "",
  spec: "",
  agents: [],
  specialists: [],
  env: "unknown",
  project: "",
  memory_ids: [],
  mnemos_tags: [],
  created_at: "2026-09-18T00:00:00+00:00",
  updated_at: "2026-09-18T00:00:00+00:00",
  archived: 0,
  status: "open",
  priority: "normal",
  archived_from: "",
  validating_since: "",
};

const ROW: AssignmentItem = {
  id: 9,
  task_id: "TB-10",
  specialist: "x",
  harness: "zcode",
  state: "queued",
  created_by: "owner",
  claimed_by: null,
  note: "",
  spec_hash: "",
  executor_id: "",
  claimed_by_executor: "",
  created_at: new Date(Date.now() - 60_000).toISOString(),
  claimed_at: null,
  started_at: null,
  heartbeat_at: null,
  finished_at: null,
  topics: [],
  routing: { resolved: "exec-old-poller", reason: "global-default" },
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("offline wait chip — live ticker", () => {
  it("shows the offline age next to the resolved route", async () => {
    const gateway = new MockAdapter({ latency: false });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(keys.agents.assignments.list({ task_id: "TB-10" }), {
      ok: true,
      count: 1,
      items: [ROW],
    });
    await client.prefetchQuery({
      queryKey: keys.agents.executors.list(),
      queryFn: () => gateway.listExecutors(),
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        <GatewayContext.Provider value={gateway}>
          <QueryClientProvider client={client}>
            <ToastProvider>
              <UiTokenProvider>
                <I18nProvider initialLang="en">
                  <MemoryRouter>
                    <TaskExecutionTab task={TASK} />
                  </MemoryRouter>
                </I18nProvider>
              </UiTokenProvider>
            </ToastProvider>
          </QueryClientProvider>
        </GatewayContext.Provider>,
      );
    });
    expect(document.body.textContent).toContain("route: zcode@old-laptop");
    expect(document.body.textContent).toContain("waiting for an executor (offline");
    root.unmount();
  });
});
