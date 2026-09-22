// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TaskDetailPage } from "@/features/tasks/TaskDetailPage";
import { TaskExecutionTab } from "./TaskExecutionTab";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import type { BoardTask } from "@/gateway/boardTypes";

/**
 * The link-test pin deep-link (AGW-6 A.3) — portal content, so this lives
 * in happy-dom (renderToString never mounts Radix portals): `?assign=<id>`
 * on /tasks/:id (or the autoAssignExecutorId prop) auto-opens the
 * AssignExecutorSheet with the executor pinned; a terminal task honestly
 * skips the auto-open.
 */

async function makeClient(): Promise<QueryClient> {
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
  return client;
}

interface Mount {
  root: Root;
  text: () => string;
}

async function mountTree(node: React.ReactNode): Promise<Mount> {
  const gateway = new MockAdapter({ latency: false });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <GatewayContext.Provider value={gateway}>
        <QueryClientProvider client={await makeClient()}>
          <ToastProvider>
            <UiTokenProvider>
              <I18nProvider initialLang="en">
                <MemoryRouter>
                  {node}
                </MemoryRouter>
              </I18nProvider>
            </UiTokenProvider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
  return { root, text: () => document.body.textContent ?? "" };
}

async function taskOf(id: string): Promise<BoardTask> {
  return new MockAdapter({ latency: false }).taskById(id);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("TaskExecutionTab — the link-test pin (AGW-6 A.3)", () => {
  it("autoAssignExecutorId auto-opens the sheet with the pinned hint", async () => {
    const task = await taskOf("TB-10");
    const mount = await mountTree(
      <TaskExecutionTab task={task} autoAssignExecutorId="exec-old-poller" />,
    );
    // The pinned hint renders ONLY in the sheet; the pin also pre-selects
    // the offline executor's radio (the link-test case).
    expect(mount.text()).toContain("Executor pinned");
    const checked = document.querySelector<HTMLInputElement>(
      "input[type=radio]:checked",
    );
    expect(checked).not.toBeNull();
    expect(checked?.disabled).toBe(false); // offline does not disable a pin
    mount.root.unmount();
  });

  it("without the prop no pin hint renders", async () => {
    const task = await taskOf("TB-10");
    const mount = await mountTree(<TaskExecutionTab task={task} />);
    expect(mount.text()).not.toContain("Executor pinned");
    mount.root.unmount();
  });

  it("a terminal task honestly skips the auto-open", async () => {
    const done = await taskOf("TB-8"); // col: done — no new attempts
    const mount = await mountTree(
      <TaskExecutionTab task={done} autoAssignExecutorId="exec-old-poller" />,
    );
    expect(mount.text()).not.toContain("Executor pinned");
    mount.root.unmount();
  });
});

describe("TaskDetailPage — ?assign deep-link through the route", () => {
  it("?tab=execution&assign=<id> lands on the sheet with the pin", async () => {
    const gateway = new MockAdapter({ latency: false });
    const client = await makeClient();
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
                  <MemoryRouter
                    initialEntries={[
                      "/tasks/TB-10?tab=execution&assign=exec-old-poller",
                    ]}
                  >
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.body.textContent).toContain("Executor pinned");
    root.unmount();
  });
});
