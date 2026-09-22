// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ExecutorRegistryPage } from "./ExecutorRegistryPage";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";

/**
 * `/agents/harnesses` integration (AGW-4): the REAL MockAdapter registry
 * (pending + approved + revoked fixtures) through the REAL mutation path —
 * pending leads the page, approve moves the row into the connected band
 * WITHOUT flipping the routing flag, revoked rows render muted as dead
 * identities, capabilities render as per-mapping chips (structure, not a
 * comma blob), and the delete confirm carries the hard-removal honesty.
 */

async function mountPage(
  seedEmpty = false,
): Promise<{ root: Root; container: HTMLElement; gateway: MockAdapter }> {
  const gateway = new MockAdapter({ latency: false });
  if (seedEmpty) {
    // The honest empty case through the REAL query path — the adapter
    // itself answers an empty registry page.
    vi.spyOn(gateway, "listExecutors").mockResolvedValue({
      ok: true,
      count: 0,
      items: [],
      meta: { presence: { online_max_age_s: 120, stale_max_age_s: 600 }, sweeper_interval_s: 60 },
    });
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
                <MemoryRouter initialEntries={["/agents/harnesses"]}>
                  <ExecutorRegistryPage />
                </MemoryRouter>
              </I18nProvider>
            </UiTokenProvider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
  // The registry loads through the REAL query path (no seeded cache) —
  // wait for the skeleton to resolve into bands or the honest empty state.
  await vi.waitFor(() => {
    const text = container.textContent ?? "";
    expect(text.includes("Awaiting approval") || text.includes("No executors connected")).toBe(
      true,
    );
  });
  return { root, container, gateway };
}

const band = (container: HTMLElement, label: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`section[aria-label="${label}"]`);

function bandOrder(container: HTMLElement): string[] {
  const labels = ["Awaiting approval", "Connected", "Revoked"];
  const sections = Array.from(container.querySelectorAll("section[aria-label]"));
  return labels
    .filter((label) => sections.some((section) => section.getAttribute("aria-label") === label))
    .sort(
      (a, b) =>
        sections.findIndex((section) => section.getAttribute("aria-label") === a) -
        sections.findIndex((section) => section.getAttribute("aria-label") === b),
    );
}

/** happy-dom has NO native window.confirm — the page's confirm sink is
 * replaced with a recording stub (the exact-text assertions go through it). */
function stubConfirm(returnValue: boolean): ReturnType<typeof vi.fn> {
  const confirm = vi.fn(() => returnValue);
  (window as unknown as { confirm: () => boolean }).confirm = confirm;
  return confirm;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  delete (window as unknown as { confirm?: () => boolean }).confirm;
});

describe("Registry bands (layer order)", () => {
  it("pending leads, connected follows, revoked sinks last", async () => {
    const { root, container } = await mountPage();
    expect(bandOrder(container)).toEqual([
      "Awaiting approval",
      "Connected",
      "Revoked",
    ]);
    // The pending queue shows the approval CTA…
    const pending = band(container, "Awaiting approval")!;
    expect(pending.textContent).toContain("copilot@new-host");
    expect(pending.textContent).toContain("Approve");
    // …the revoked band is visible but honestly dead.
    const revoked = band(container, "Revoked")!;
    expect(revoked.textContent).toContain("copilot@old-host");
    expect(revoked.textContent).toContain("trust is not restorable");
    root.unmount();
  });

  it("every row wears the unverified identity chip; capabilities are chips", async () => {
    const { root, container } = await mountPage();
    // §2.2: declared identity is UNVERIFIED — the chip is on every row.
    const chips = container.querySelectorAll(
      'span[title="Identity declared by the executor, never verified by the server"]',
    );
    expect(chips.length).toBe(6);
    // Structure: two allowlist mappings → two separate chips (the mono
    // chip class), not one comma-joined string.
    const connected = band(container, "Connected")!;
    const capabilityChips = connected.querySelectorAll("li span.font-mono.rounded-sm");
    expect(capabilityChips.length).toBe(4);
    expect(connected.textContent).toContain("@GCW: Senior Frontend Developer");
    // The zero-capability row says so instead of an empty group.
    expect(connected.textContent).toContain("no capabilities declared");
    root.unmount();
  });
});

describe("Registry management (gated write path)", () => {
  it("approve moves pending → connected; the routing flag stays OFF", async () => {
    const { root, container, gateway } = await mountPage();
    const pending = band(container, "Awaiting approval")!;
    const approve = [...pending.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Approve"),
    )!;
    await act(async () => {
      approve.click();
    });
    await vi.waitFor(() => {
      expect(band(container, "Awaiting approval")).toBeNull();
    });
    // The row landed in the connected band, disabled (honest approve).
    const connected = band(container, "Connected")!;
    expect(connected.textContent).toContain("copilot@new-host");
    const row = (await gateway.listExecutors()).items.find((r) => r.id === "exec-copilot-pending");
    expect(row?.state).toBe("approved");
    expect(row?.enabled).toBe(false);
    root.unmount();
  });

  it("enable/disable toggles the routing flag through the same path", async () => {
    const { root, container, gateway } = await mountPage();
    const connected = band(container, "Connected")!;
    const zcodeRow = [...connected.querySelectorAll("li")].find((li) =>
      li.textContent?.includes("zcode@laptop"),
    )!;
    const disable = [...zcodeRow.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Disable"),
    )!;
    await act(async () => {
      disable.click();
    });
    await vi.waitFor(async () => {
      const page = await gateway.listExecutors();
      expect(page.items.find((r) => r.id === "exec-laptop-zcode")?.enabled).toBe(false);
    });
    root.unmount();
  });

  it("revoke confirms the terminal honesty, then the row goes dead", async () => {
    const { root, container } = await mountPage();
    const confirmSpy = stubConfirm(true);
    const connected = band(container, "Connected")!;
    const hermesRow = [...connected.querySelectorAll("li")].find((li) =>
      li.textContent?.includes("hermes@laptop"),
    )!;
    const revoke = [...hermesRow.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Revoke"),
    )!;
    await act(async () => {
      revoke.click();
    });
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringContaining("Trust is not restorable"),
    );
    await vi.waitFor(() => {
      const revoked = band(container, "Revoked")!;
      expect(revoked.textContent).toContain("hermes@laptop");
    });
    root.unmount();
  });

  it("delete confirm carries the hard-removal honesty; the row disappears", async () => {
    const { root, container, gateway } = await mountPage();
    const confirmSpy = stubConfirm(true);
    const revoked = band(container, "Revoked")!;
    const remove = [...revoked.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Delete"),
    )!;
    await act(async () => {
      remove.click();
    });
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringContaining("copilot@old-host"),
    );
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringContaining("name is freed for re-registration"),
    );
    await vi.waitFor(() => {
      expect(band(container, "Revoked")).toBeNull();
    });
    expect(
      (await gateway.listExecutors()).items.some((r) => r.id === "exec-copilot-revoked"),
    ).toBe(false);
    root.unmount();
  });

  it("a declined confirm touches nothing", async () => {
    const { root, container, gateway } = await mountPage();
    stubConfirm(false);
    const connected = band(container, "Connected")!;
    const zcodeRow = [...connected.querySelectorAll("li")].find((li) =>
      li.textContent?.includes("zcode@laptop"),
    )!;
    const remove = [...zcodeRow.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Delete"),
    )!;
    await act(async () => {
      remove.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      (await gateway.listExecutors()).items.some((r) => r.id === "exec-laptop-zcode"),
    ).toBe(true);
    root.unmount();
  });
});

describe("Empty registry and the connect guide", () => {
  it("empty registry: honest empty state + the guide below it", async () => {
    const { root, container } = await mountPage(true);
    expect(container.textContent).toContain("No executors connected");
    expect(container.textContent).toContain("connect the first one");
    // No bands render for an empty registry (no zero furniture).
    expect(band(container, "Awaiting approval")).toBeNull();
    root.unmount();
  });

  it("the connect guide is always available; it expands into 5 steps", async () => {
    const { root, container } = await mountPage();
    expect(container.textContent).not.toContain("poller.example.yaml");
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-expanded="false"]',
    )!;
    await act(async () => {
      toggle.click();
    });
    expect(container.querySelectorAll("ol li")).toHaveLength(5);
    expect(container.textContent).toContain("machine-class API");
    root.unmount();
  });
});
