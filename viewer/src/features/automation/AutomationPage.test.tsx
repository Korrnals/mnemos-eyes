// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AutomationPage } from "./AutomationPage";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { ToastViewport } from "@/components/Toast/ToastViewport";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";

/**
 * `/system/automation` (SCHED-1-UI): the honest engine-off banner, the
 * condition TRIPLE (dependent selects over the server meta — with the
 * NO-FREE-TEXT regression lock), the no-token read-only posture, the
 * cursor journal, and run-now going through the ONE shared path (the
 * gateway wire call; the outcome lands on the assignment queue).
 */

async function mountPage(
  gateway: MockAdapter,
  path = "/system/automation",
): Promise<{ root: Root; container: HTMLElement }> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await client.prefetchQuery({
    queryKey: keys.tasks.board(),
    queryFn: () => gateway.board(),
  });
  // Seed every tab's query so the assertions see loaded content, not
  // skeletons (the page reads status + the active tab).
  await client.prefetchQuery({
    queryKey: keys.automation.status(),
    queryFn: () => gateway.automationStatus(),
  });
  await client.prefetchQuery({
    queryKey: keys.automation.schedules(),
    queryFn: () => gateway.listSchedules(),
  });
  await client.prefetchQuery({
    queryKey: keys.automation.hooks(),
    queryFn: () => gateway.listHooks(),
  });
  await client.prefetchQuery({
    queryKey: keys.automation.launches({ limit: 50 }),
    queryFn: () => gateway.listLaunches({ limit: 50 }),
  });
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
                <MemoryRouter initialEntries={[path]}>
                  <AutomationPage />
                  <ToastViewport />
                </MemoryRouter>
              </I18nProvider>
            </UiTokenProvider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
  return { root, container };
}

beforeEach(() => {
  // happy-dom ships no window.confirm — stub the native dialog gate.
  vi.stubGlobal("confirm", vi.fn(() => true));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("status banner — the S1 honesty", () => {
  it("engine=false says so in words; kill-switch/cap/counters read-only", async () => {
    const { root, container } = await mountPage(new MockAdapter({ latency: false }));
    const text = container.textContent ?? "";
    expect(text).toContain("Engine not enabled");
    expect(text).toContain("Manual runs only");
    expect(text).toContain("global kill-switch: off");
    expect(text).toContain("daily cap: 50");
    expect(text).toContain("auto-launches today: 0");
    expect(text).toContain("rules: 2 schedules, 2 hook rules");
    // No toggle control exists for the kill-switch (v1 cut) — read-only
    // rendering, no button carries its label.
    const killButtons = [...container.querySelectorAll("button")].filter((button) =>
      button.textContent?.toLowerCase().includes("kill"),
    );
    expect(killButtons).toHaveLength(0);
    root.unmount();
  });
});

describe("the condition triple — dependent selects, NO free text (regression)", () => {
  it("hook form: field→op→value selects from the server meta; adding a clause works", async () => {
    const { root, container } = await mountPage(new MockAdapter({ latency: false }), "/system/automation?tab=hooks");
    const create = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("New rule"),
    )!;
    await act(async () => {
      create.click();
    });
    // The dialog lives in a portal — query the document.
    const field = document.querySelector<HTMLSelectElement>("#hook-condition-field")!;
    const op = document.querySelector<HTMLSelectElement>("#hook-condition-op")!;
    const value = document.querySelector<HTMLSelectElement>("#hook-condition-value")!;

    // Options come from the server meta dictionary (mock mirrors it).
    expect([...field.options].map((option) => option.value)).toEqual([
      "",
      "task_col",
      "task_priority",
    ]);
    // Dependent: no field → op disabled; value disabled until a field with
    // an enum is chosen.
    expect(op.disabled).toBe(true);
    expect(value.disabled).toBe(true);

    const nativeSet = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    await act(async () => {
      nativeSet?.call(field, "task_col");
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const colValues = [...value.options].map((option) => option.value);
    expect(colValues).toContain("open");
    expect(colValues).toContain("done");

    await act(async () => {
      nativeSet?.call(op, "eq");
      op.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      nativeSet?.call(value, "blocked");
      value.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const add = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.trim() === "Add",
    )!;
    await act(async () => {
      add.click();
    });
    expect(document.body.textContent).toContain("task_col eq blocked");

    // THE REGRESSION LOCK: inside the condition editor, every control is a
    // SELECT — a free-text condition input does not exist in the DOM.
    const editor = document.querySelector("#hook-condition-field")?.closest("fieldset");
    expect(editor).not.toBeNull();
    expect(editor?.querySelectorAll("input:not([type=hidden])").length).toBe(0);
    root.unmount();
  });
});

describe("no-token posture — readable section, disabled mutations", () => {
  it("hasUiToken=false: note present, every action button disabled", async () => {
    const gateway = Object.assign(new MockAdapter({ latency: false }), {
      hasUiToken: () => false,
    });
    const { root, container } = await mountPage(gateway);
    expect(container.textContent).toContain("read-only");
    const runButtons = [...container.querySelectorAll("button")].filter((button) =>
      button.textContent?.includes("Run now"),
    );
    expect(runButtons.length).toBeGreaterThan(0);
    for (const button of runButtons) {
      expect(button.disabled).toBe(true);
    }
    root.unmount();
  });
});

describe("journal — cursor pagination", () => {
  it("renders launch rows with honest trigger/origin stamps and «More»", async () => {
    const gateway = new MockAdapter({ latency: false });
    const { root, container } = await mountPage(
      gateway,
      "/system/automation?tab=journal",
    );
    const text = container.textContent ?? "";
    expect(text).toContain("launched");
    expect(text).toContain("skipped");
    expect(text).toContain("manual/ui"); // the engine-off journal reads clearly
    expect(text).toContain("assignment #"); // the run-now outcome link
    root.unmount();
  });

  it("«More» stitches the next cursor page into the list", async () => {
    const gateway = new MockAdapter({ latency: false });
    // Grow the journal past one page: each manual run journals a row
    // (launched or honestly skipped — both count).
    for (let index = 0; index < 60; index += 1) {
      await gateway.createSchedule({
        name: `r${index}`,
        target_kind: "task",
        task_id: "TB-10",
        specialist: "x",
        harness: "zcode",
        executor_id: "",
        trigger_kind: "daily",
        trigger_value: "10:00",
        window_from: null,
        window_to: null,
        max_runs_per_day: 1,
        cooldown_s: 3600,
      }).catch(() => undefined);
    }
    for (const rule of (await gateway.listSchedules()).items) {
      await gateway.runScheduleNow(rule.id).catch(() => undefined);
    }
    const { root, container } = await mountPage(
      gateway,
      "/system/automation?tab=journal",
    );
    const list = container.querySelector("ul[aria-label='Journal']");
    const firstPage = list?.querySelectorAll("li").length ?? 0;
    expect(firstPage).toBe(50); // page 1 at the wire limit

    const more = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("More"),
    );
    expect(more).toBeDefined(); // next_cursor exists
    await act(async () => {
      more!.click();
    });
    // The stitch is async (wire + setQueryData) — wait for it to land.
    await vi.waitFor(() => {
      const stitched = container.querySelector("ul[aria-label='Journal']");
      expect((stitched?.querySelectorAll("li").length ?? 0) > firstPage).toBe(true);
    });
    root.unmount();
  });
});

describe("run-now — ONE shared path, no second machine", () => {
  it("goes through the gateway wire call; the outcome lands on the assignment queue", async () => {
    const gateway = new MockAdapter({ latency: false });
    const { root, container } = await mountPage(gateway);
    await gateway.cancelAssignment(101, "setup"); // free TB-1 for rule 1
    const runButton = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Run now"),
    )!;
    await act(async () => {
      runButton.click();
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain("launched"));
    // The run-now outcome is an ORDINARY assignment on the shared queue —
    // the existing surfaces (list/cards/task tab) are the machine; this
    // page built none of its own.
    const queue = await gateway.listAssignments({ task_id: "TB-1" });
    expect(queue.items.some((row) => row.state === "queued")).toBe(true);
    root.unmount();
  });
});
