// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ExecutorLinkCheck } from "./ExecutorLinkCheck";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import type { ExecutorItem, ExecutorsPage } from "@/gateway/boardTypes";

/**
 * The link-check verdict component (AGW-6 A): the trigger is a CACHE
 * INVALIDATION (listExecutors refetches — there is NO ping to fake), the
 * verdict speaks from last_seen + the server meta, the outbound-only
 * disclaimer rides under EVERY verdict, and the second stage («Check for
 * real») leads to the real dispatch flow. Card mode shows the verdict on
 * mount; menu mode shows it only after the explicit trigger.
 */

const FRESH: ExecutorItem = {
  id: "exec-x",
  name: "x@host",
  harness: "zcode",
  host: "host",
  transport: "local-poll",
  capabilities: [],
  version: "",
  enabled: true,
  state: "approved",
  last_seen: new Date(Date.now() - 5_000).toISOString(), // 5 s → online
  presence: "online",
  registered_via: "",
  registered_at: new Date(Date.now() - 86_400_000).toISOString(),
  updated_at: new Date(Date.now() - 3_600_000).toISOString(),
};

const REVOKED: ExecutorItem = { ...FRESH, state: "revoked", presence: "offline" };

interface Mount {
  root: Root;
  gateway: MockAdapter;
  text: () => string;
  query: <T extends Element>(selector: string) => T[];
}

async function mountCheck(
  executor: ExecutorItem,
  variant: "card" | "menu-item",
  autoCheck = false,
): Promise<Mount> {
  const gateway = new MockAdapter({ latency: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page: ExecutorsPage = await gateway.listExecutors();
  queryClient.setQueryData(keys.agents.executors.list(), page);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <GatewayContext.Provider value={gateway}>
        <QueryClientProvider client={queryClient}>
          <I18nProvider initialLang="en">
            <MemoryRouter>
              <ExecutorLinkCheck executor={executor} variant={variant} autoCheck={autoCheck} />
            </MemoryRouter>
          </I18nProvider>
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

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ExecutorLinkCheck — the honest check", () => {
  it("card mode shows the verdict ON MOUNT (the card IS the check surface)", async () => {
    const mount = await mountCheck(FRESH, "card", true);
    const html = mount.text();
    expect(html).toContain("online — answered a poll 5 s ago");
    expect(html).toContain("The board never pings agents (outbound-only)");
    expect(html).toContain("Check for real");
    mount.root.unmount();
  });

  it("menu mode: no verdict before the trigger; the trigger REFETCHES the registry", async () => {
    const mount = await mountCheck(FRESH, "menu-item");
    expect(mount.text()).not.toContain("The board never pings agents");
    const spy = vi.spyOn(mount.gateway, "listExecutors");
    const callsBefore = spy.mock.calls.length;
    const trigger = mount
      .query<HTMLButtonElement>("[role='menuitem']")
      .find((button) => button.textContent?.includes("Check connection"));
    expect(trigger).toBeDefined();
    await act(async () => {
      trigger!.click();
    });
    expect(mount.text()).toContain("online — answered a poll 5 s ago");
    // The invalidation refetched the registry query — the honest check.
    await vi.waitFor(() => {
      expect(spy.mock.calls.length).toBeGreaterThan(callsBefore);
    });
    mount.root.unmount();
  });

  it("a revoked row shows the goned-presence verdict with NO trigger at all", async () => {
    const mount = await mountCheck(REVOKED, "card", true);
    const html = mount.text();
    expect(html).toContain("revoked — presence is gone");
    expect(html).toContain("The board never pings agents (outbound-only)");
    expect(html).not.toContain("Check connection");
    expect(html).not.toContain("Check for real");
    mount.root.unmount();
  });

  it("P2: a PENDING row offers the check but NOT the second stage (no presence yet)", async () => {
    const pending: ExecutorItem = { ...FRESH, state: "pending", last_seen: "" };
    const mount = await mountCheck(pending, "card", true);
    const html = mount.text();
    // The verdict is honest without any check: «has never answered a poll».
    expect(html).toContain("has never answered a poll");
    expect(html).toContain("Check connection");
    // The real probe needs a routable pin — pending cannot take one.
    expect(html).not.toContain("Check for real");
    mount.root.unmount();
  });
});
