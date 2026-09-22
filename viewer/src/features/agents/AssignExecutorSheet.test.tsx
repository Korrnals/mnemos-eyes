// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AssignExecutorSheet } from "./AssignExecutorSheet";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import type { AssignmentsPage, BoardTask, ExecutorsPage } from "@/gateway/boardTypes";

/**
 * AssignExecutorSheet live-route preview (spec §2.3): the SAME resolver the
 * server annotation uses, rendered — explicit pin / global default / no
 * route at all, each honestly labelled; offline executors stay visible but
 * disabled WITH a reason. happy-dom + createRoot (LoginDialog.flow posture).
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

interface Mount {
  root: Root;
  gateway: MockAdapter;
  /** Radix portals the dialog into document.body — queries go to the DOCUMENT. */
  text: () => string;
  query: <T extends Element>(selector: string) => T[];
}

async function mountSheet(
  executorsPage: ExecutorsPage,
  defaultExecutor: string,
  pinnedExecutorId: string | null = null,
): Promise<Mount> {
  const gateway = new MockAdapter({ latency: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await queryClient.prefetchQuery({
    queryKey: keys.tasks.board(),
    queryFn: () => gateway.board(),
  });
  queryClient.setQueryData(keys.agents.executors.list(), executorsPage);
  queryClient.setQueryData(keys.agents.settings.execution(), {
    ok: true,
    default_executor: defaultExecutor,
    fallback_executor: "",
    scope: "",
  });
  const queue: AssignmentsPage = { ok: true, count: 0, items: [] };
  queryClient.setQueryData(keys.agents.assignments.list({}), queue);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <GatewayContext.Provider value={gateway}>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <UiTokenProvider>
              <I18nProvider initialLang="en">
                <MemoryRouter>
                  <AssignExecutorSheet
                    task={TASK}
                    open
                    onOpenChange={() => undefined}
                    pinnedExecutorId={pinnedExecutorId}
                  />
                </MemoryRouter>
              </I18nProvider>
            </UiTokenProvider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
  return {
    root,
    gateway,
    text: () => document.body.textContent ?? "",
    query: <T extends Element>(selector: string) => [
      ...document.querySelectorAll<T>(selector),
    ],
  };
}

afterEach(() => {
  // Radix portal content unmounts with the root; sweep leftovers anyway.
  document.body.innerHTML = "";
});

/** The corpus registry page with a per-test default override removed/kept. */
async function registry(ids: string[]): Promise<ExecutorsPage> {
  const gateway = new MockAdapter({ latency: false });
  const page = await gateway.listExecutors();
  return { ...page, items: page.items.filter((row) => ids.includes(row.id)) };
}

describe("AssignExecutorSheet — live route preview (§2.3)", () => {
  it("default choice previews the global default WITH its name", async () => {
    const { root, text } = await mountSheet(
      await registry(["exec-laptop-zcode", "exec-old-poller"]),
      "exec-laptop-zcode",
    );
    const html = text();
    // Default option carries the setting's executor NAME.
    expect(html).toContain("setting: zcode@laptop");
    // Preview resolves through the default tier.
    expect(html).toContain("zcode@laptop · default executor");
    // The preview is LABELLED a preview (never a promise).
    expect(html).toContain("Route preview");
    expect(html).toContain("who actually claims it is a fact");
    root.unmount();
  });

  it("an explicit executor choice flips the preview to the targeted tier", async () => {
    const { root, text, query } = await mountSheet(
      await registry(["exec-laptop-zcode", "exec-laptop-hermes"]),
      "exec-laptop-zcode",
    );
    // Radios carry no wire value — select through the executor's LABEL.
    const hermesLabel = query("label").find((label) =>
      label.textContent?.includes("hermes@laptop"),
    );
    expect(hermesLabel).toBeDefined();
    await act(async () => {
      hermesLabel!.querySelector<HTMLInputElement>("input[type=radio]")?.click();
    });
    expect(text()).toContain("hermes@laptop · targeted executor");
    root.unmount();
  });

  it("no eligible route → the honest wait copy, submit stays ACTIVE", async () => {
    // Only the offline worker + the pending copilot: nothing eligible.
    const { root, text, query } = await mountSheet(
      await registry(["exec-old-poller", "exec-copilot-pending"]),
      "",
    );
    const html = text();
    expect(html).toContain("No executor available — the assignment will wait in the queue");
    // A specialist is still required (the wire demands it) — fill it via the
    // NATIVE value setter (React's tracker ignores plain assignment), then
    // the UNMATCHED ROUTE alone must not disable the submit.
    const input = query<HTMLInputElement>("#assign-specialist")[0];
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      nativeSetter?.call(input, "@GCW: Tech Lead");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const assign = query<HTMLButtonElement>("button").find((button) =>
      button.textContent?.includes("Assign"),
    );
    expect(assign?.disabled).toBe(false); // honest wait, the button works
    root.unmount();
  });
});

describe("AssignExecutorSheet — executor picker honesty (§2.3)", () => {
  it("offline executors stay visible but disabled, with the offline reason", async () => {
    const { root, query } = await mountSheet(
      await registry(["exec-laptop-zcode", "exec-old-poller"]),
      "exec-laptop-zcode",
    );
    const labels = query("label");
    const offline = labels.find((label) => label.textContent?.includes("zcode@old-laptop"));
    expect(offline).toBeDefined(); // VISIBLE
    expect(offline?.textContent).toContain("offline — last seen"); // REASON
    const offlineRadio = offline?.querySelector<HTMLInputElement>("input[type=radio]");
    expect(offlineRadio?.disabled).toBe(true); // DISABLED
    root.unmount();
  });

  it("pending/revoked rows carry their ladder reasons and stay disabled", async () => {
    const { root, text, query } = await mountSheet(
      await registry(["exec-copilot-pending", "exec-copilot-revoked"]),
      "",
    );
    const html = text();
    expect(html).toContain("awaiting owner approval");
    expect(html).toContain("access revoked");
    const disabled = query<HTMLInputElement>("input[type=radio]:disabled");
    expect(disabled.length).toBeGreaterThanOrEqual(2);
    root.unmount();
  });

  it("tooltips carry capabilities, transport, last seen AND the unverified note", async () => {
    const { root, query } = await mountSheet(
      await registry(["exec-laptop-zcode"]),
      "exec-laptop-zcode",
    );
    // The executor ROW's meta line names its capabilities — unique marker
    // (the «default» option's label also contains the executor name).
    const label = query("label").find((l) =>
      l.textContent?.includes("@GCW: Senior Frontend Developer"),
    );
    const title = label?.getAttribute("title") ?? "";
    expect(title).toContain("@GCW: Senior Frontend Developer");
    expect(title).toContain("local-poll");
    expect(title).toContain("last seen");
    expect(title).toContain("never verified by the server");
    root.unmount();
  });
});

describe("AssignExecutorSheet — the link-test pin (AGW-6 A.3)", () => {
  it("a PINNED approved+enabled executor stays selectable while OFFLINE", async () => {
    // exec-old-poller: approved + enabled + offline — the link-test case.
    const { root, text, query } = await mountSheet(
      await registry(["exec-old-poller"]),
      "",
      "exec-old-poller",
    );
    const label = query("label").find((l) => l.textContent?.includes("zcode@old-laptop"));
    const radio = label?.querySelector<HTMLInputElement>("input[type=radio]");
    expect(radio?.checked).toBe(true); // the pin PRE-SELECTS it
    expect(radio?.disabled).toBe(false); // offline does NOT disable a pin
    expect(text()).toContain("Executor pinned");
    root.unmount();
  });

  it("the pin travels: submit carries executor_id without touching the picker", async () => {
    const { root, gateway, query } = await mountSheet(
      await registry(["exec-old-poller"]),
      "",
      "exec-old-poller",
    );
    const spy = vi.spyOn(gateway, "createAssignment");
    const input = query<HTMLInputElement>("#assign-specialist")[0];
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      nativeSetter?.call(input, "@GCW: Tech Lead");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const assign = query<HTMLButtonElement>("button").find((button) =>
      button.textContent?.includes("Assign"),
    )!;
    await act(async () => {
      assign.click();
    });
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toMatchObject({
      task_id: "TB-10",
      executor_id: "exec-old-poller",
    });
    root.unmount();
  });

  it("pinned REVOKED: the radio stays checked-but-dead and submit is BLOCKED (P2)", async () => {
    const { root, gateway, query, text } = await mountSheet(
      await registry(["exec-copilot-revoked"]),
      "",
      "exec-copilot-revoked",
    );
    const spy = vi.spyOn(gateway, "createAssignment");
    const input = query<HTMLInputElement>("#assign-specialist")[0];
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      nativeSetter?.call(input, "@GCW: Tech Lead");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The pin REMAINS visible (checked) — the owner sees what the link
    // named — but the radio is dead and the submit is held with the way out.
    const label = query("label").find((l) => l.textContent?.includes("copilot@old-host"));
    const radio = label?.querySelector<HTMLInputElement>("input[type=radio]");
    expect(radio?.checked).toBe(true);
    expect(radio?.disabled).toBe(true);
    expect(text()).toContain("The pinned executor cannot take tasks right now");
    const assign = query<HTMLButtonElement>("button").find((button) =>
      button.textContent?.includes("Assign"),
    )!;
    expect(assign.disabled).toBe(true);
    await act(async () => {
      assign.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spy).not.toHaveBeenCalled(); // the ≤1 slot is never held by a ghost
    root.unmount();
  });

  it("pinned PENDING: same treatment — checked, disabled radio, submit blocked (P2)", async () => {
    const { root, gateway, query, text } = await mountSheet(
      await registry(["exec-copilot-pending"]),
      "",
      "exec-copilot-pending",
    );
    const spy = vi.spyOn(gateway, "createAssignment");
    const input = query<HTMLInputElement>("#assign-specialist")[0];
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      nativeSetter?.call(input, "@GCW: Tech Lead");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const label = query("label").find((l) => l.textContent?.includes("copilot@new-host"));
    const radio = label?.querySelector<HTMLInputElement>("input[type=radio]");
    expect(radio?.checked).toBe(true);
    expect(radio?.disabled).toBe(true);
    expect(text()).toContain("The pinned executor cannot take tasks right now");
    const assign = query<HTMLButtonElement>("button").find((button) =>
      button.textContent?.includes("Assign"),
    )!;
    expect(assign.disabled).toBe(true);
    await act(async () => {
      assign.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spy).not.toHaveBeenCalled();
    root.unmount();
  });

  it("a deep-link pin on a DELETED executor falls back to default and sends NO pin", async () => {
    const { root, gateway, query } = await mountSheet(
      await registry(["exec-laptop-zcode"]),
      "",
      "exec-vanished",
    );
    const spy = vi.spyOn(gateway, "createAssignment");
    const input = query<HTMLInputElement>("#assign-specialist")[0];
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      nativeSetter?.call(input, "@GCW: Tech Lead");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Nothing to show for the pin — the effective choice silently reads
    // default (the lit radio), submit stays usable, NO executor_id travels.
    const defaultRadio = query<HTMLInputElement>("input[type=radio]")[0];
    expect(defaultRadio?.checked).toBe(true);
    const assign = query<HTMLButtonElement>("button").find((button) =>
      button.textContent?.includes("Assign"),
    )!;
    expect(assign.disabled).toBe(false);
    await act(async () => {
      assign.click();
    });
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toMatchObject({ task_id: "TB-10", executor_id: "" });
    root.unmount();
  });

  it("picking «Default» releases a blocked pin — the honest way out still works", async () => {
    const { root, gateway, query } = await mountSheet(
      await registry(["exec-copilot-revoked"]),
      "",
      "exec-copilot-revoked",
    );
    const spy = vi.spyOn(gateway, "createAssignment");
    const input = query<HTMLInputElement>("#assign-specialist")[0];
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      nativeSetter?.call(input, "@GCW: Tech Lead");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const defaultLabel = query("label").find((l) =>
      l.textContent?.includes("Default"),
    )!;
    await act(async () => {
      defaultLabel.querySelector<HTMLInputElement>("input[type=radio]")?.click();
    });
    const assign = query<HTMLButtonElement>("button").find((button) =>
      button.textContent?.includes("Assign"),
    )!;
    expect(assign.disabled).toBe(false); // the owner consciously un-pinned
    await act(async () => {
      assign.click();
    });
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toMatchObject({ executor_id: "" });
    root.unmount();
  });
});
