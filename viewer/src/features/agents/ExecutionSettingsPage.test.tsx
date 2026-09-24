// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ExecutionSettingsPage } from "./ExecutionSettingsPage";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { ToastViewport } from "@/components/Toast/ToastViewport";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import type { ExecutorsPage } from "@/gateway/boardTypes";
import { actUnmount, actWaitUntil } from "@/test/actTools";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `/system/settings` → «Исполнение» (AGW-3): the pair selects list the full
 * registry, ineligible rows stay VISIBLE but disabled with their reason
 * (offline/pending/revoked/mesh), and saving a valid pair goes through the
 * real mutation factory (gate → wire → ok toast). The Amd 2 §5 422 texts
 * are covered at the factory/mock layer (useAssignmentMutations /
 * MockAdapter.agents tests); the UI prevents the invalid choices upstream.
 */

const NOW = Date.now();
const ago = (seconds: number): string => new Date(NOW - seconds * 1000).toISOString();

/**
 * Registry seed: the MOCK's own registry (so the PUT gate knows every id),
 * with re-stamped presence — the corpus last_seen is a 2026-09-19 snapshot,
 * the UI classifies against the REAL clock.
 */
async function registryPage(gateway: MockAdapter): Promise<ExecutorsPage> {
  const page = await gateway.listExecutors();
  return {
    ...page,
    items: page.items.map((row) =>
      row.id === "exec-laptop-zcode"
        ? { ...row, last_seen: ago(30), presence: "online" } // selectable
        : row.id === "exec-old-poller"
          ? { ...row, last_seen: ago(2 * 3600), presence: "offline" } // reason: offline
          : row,
    ),
  };
}

async function mountSettings(): Promise<{ root: Root; container: HTMLElement; gateway: MockAdapter }> {
  const gateway = new MockAdapter({ latency: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(keys.agents.executors.list(), await registryPage(gateway));
  await client.prefetchQuery({
    queryKey: keys.agents.settings.execution(),
    queryFn: () => gateway.getExecutionSettings(),
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
                <MemoryRouter>
                  <ExecutionSettingsPage />
                  <ToastViewport />
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

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ExecutionSettingsPage — «Исполнение» section", () => {
  it("renders the shell page with one live section and both selects", async () => {
    const { root, container } = await mountSettings();
    expect(container.textContent).toContain("Settings");
    expect(container.textContent).toContain("Execution");
    expect(container.querySelector("#execution-default")).not.toBeNull();
    expect(container.querySelector("#execution-fallback")).not.toBeNull();
    await actUnmount(root);
  });

  it("offline/revoked rows stay visible but disabled, each with its reason", async () => {
    const { root, container } = await mountSettings();
    const select = container.querySelector<HTMLSelectElement>("#execution-default")!;
    const options = [...select.options];
    const gone = options.find((option) => option.value === "exec-old-poller");
    const revoked = options.find((option) => option.value === "exec-copilot-revoked");
    const live = options.find((option) => option.value === "exec-laptop-zcode");
    expect(gone?.disabled).toBe(true);
    expect(gone?.textContent).toContain("offline — last seen");
    expect(revoked?.disabled).toBe(true);
    expect(revoked?.textContent).toContain("access revoked");
    expect(live?.disabled).toBe(false); // online + local-poll → selectable
    await actUnmount(root);
  });

  it("saving a valid pair goes through the wire and lands the ok toast", async () => {
    const { root, container, gateway } = await mountSettings();
    const select = container.querySelector<HTMLSelectElement>("#execution-default")!;
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      nativeSetter?.call(select, "exec-laptop-zcode");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const save = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Save"),
    )!;
    await act(async () => {
      save.click();
    });
    await actWaitUntil(() =>
      expect(document.body.textContent).toContain("Execution settings saved"),
    );
    const settings = await gateway.getExecutionSettings();
    expect(settings.default_executor).toBe("exec-laptop-zcode");
    await actUnmount(root);
  });
});
