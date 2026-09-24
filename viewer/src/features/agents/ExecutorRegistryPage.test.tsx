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
import { actFlush, actUnmount, actWaitUntil } from "@/test/actTools";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  path = "/agents/harnesses",
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
                <MemoryRouter initialEntries={[path]}>
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
  await actWaitUntil(() => {
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

/** AGW-5: actions live in the row's context menu — open it (the ⋯ trigger)
 * and click the item by its visible text. */
async function menuAction(
  container: HTMLElement,
  executorName: string,
  itemText: string,
): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>(
    `button[aria-label="Actions for executor ${executorName}"]`,
  )!;
  await act(async () => {
    trigger.click();
  });
  const item = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")].find(
    (button) => button.textContent?.includes(itemText),
  )!;
  await act(async () => {
    item.click();
  });
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
    await actUnmount(root);
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
    await actUnmount(root);
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
    await actWaitUntil(() => {
      expect(band(container, "Awaiting approval")).toBeNull();
    });
    // The row landed in the connected band, disabled (honest approve).
    const connected = band(container, "Connected")!;
    expect(connected.textContent).toContain("copilot@new-host");
    const row = (await gateway.listExecutors()).items.find((r) => r.id === "exec-copilot-pending");
    expect(row?.state).toBe("approved");
    expect(row?.enabled).toBe(false);
    await actUnmount(root);
  });

  it("enable/disable toggles the routing flag through the same path", async () => {
    const { root, container, gateway } = await mountPage();
    await menuAction(container, "zcode@laptop", "Disable");
    await actWaitUntil(async () => {
      const page = await gateway.listExecutors();
      expect(page.items.find((r) => r.id === "exec-laptop-zcode")?.enabled).toBe(false);
    });
    await actUnmount(root);
  });

  it("revoke confirms the terminal honesty, then the row goes dead", async () => {
    const { root, container } = await mountPage();
    const confirmSpy = stubConfirm(true);
    await menuAction(container, "hermes@laptop", "Revoke");
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringContaining("Trust is not restorable"),
    );
    await actWaitUntil(() => {
      const revoked = band(container, "Revoked")!;
      expect(revoked.textContent).toContain("hermes@laptop");
    });
    await actUnmount(root);
  });

  it("delete confirm carries the hard-removal honesty; the row disappears", async () => {
    const { root, container, gateway } = await mountPage();
    const confirmSpy = stubConfirm(true);
    await menuAction(container, "copilot@old-host", "Delete");
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringContaining("copilot@old-host"),
    );
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringContaining("name is freed for re-registration"),
    );
    await actWaitUntil(() => {
      expect(band(container, "Revoked")).toBeNull();
    });
    expect(
      (await gateway.listExecutors()).items.some((r) => r.id === "exec-copilot-revoked"),
    ).toBe(false);
    await actUnmount(root);
  });

  it("a declined confirm touches nothing", async () => {
    const { root, container, gateway } = await mountPage();
    stubConfirm(false);
    await menuAction(container, "zcode@laptop", "Delete");
    await actFlush();
    expect(
      (await gateway.listExecutors()).items.some((r) => r.id === "exec-laptop-zcode"),
    ).toBe(true);
    await actUnmount(root);
  });
});

describe("Empty registry and the connect guide", () => {
  it("empty registry: honest empty state + the guide below it", async () => {
    const { root, container } = await mountPage(true);
    expect(container.textContent).toContain("No executors connected");
    expect(container.textContent).toContain("connect the first one");
    // No bands render for an empty registry (no zero furniture).
    expect(band(container, "Awaiting approval")).toBeNull();
    await actUnmount(root);
  });

  it("the connect guide is always available; it expands into 5 steps", async () => {
    const { root, container } = await mountPage();
    expect(container.textContent).not.toContain("poller.example.yaml");
    const toggle = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("How to connect an external agent"),
    )!;
    await act(async () => {
      toggle.click();
    });
    expect(container.querySelectorAll("ol li")).toHaveLength(5);
    // Connect hotfix: the guide teaches the ONE-command flow, not the old
    // manual runbook.
    expect(container.textContent).toContain("ONE command");
    expect(container.textContent).toContain("deploy/poller/REMOTE-EXECUTOR.md");
    await actUnmount(root);
  });
});

describe("AGW-6 link check + settings card", () => {
  it("«Check connection» in the row menu invalidates the registry and shows the verdict + disclaimer", async () => {
    const { root, container, gateway } = await mountPage();
    const spy = vi.spyOn(gateway, "listExecutors");
    const callsBefore = spy.mock.calls.length;
    const row = [...band(container, "Connected")!.querySelectorAll("li")].find((li) =>
      li.textContent?.includes("zcode@laptop"),
    )!;
    await act(async () => {
      row.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 30, clientY: 50 }),
      );
    });
    const item = [...row.querySelectorAll<HTMLButtonElement>("[role='menuitem']")].find(
      (button) => button.textContent?.includes("Check connection"),
    );
    expect(item).toBeDefined();
    await act(async () => {
      item!.click();
    });
    // The verdict renders INSIDE the open popup, the disclaimer rides under
    // it, and the "check" actually refetched the registry (no fake ping).
    expect(row.textContent).toContain("The board never pings agents (outbound-only)");
    expect(row.querySelector("[data-testid='link-verdict-exec-laptop-zcode']")).not.toBeNull();
    await actWaitUntil(() => {
      expect(spy.mock.calls.length).toBeGreaterThan(callsBefore);
    });
    await actUnmount(root);
  });

  it("a revoked row has NO check item; its menu opens the read-only settings card", async () => {
    const { root, container } = await mountPage();
    const revoked = band(container, "Revoked")!;
    const row = [...revoked.querySelectorAll("li")].find((li) =>
      li.textContent?.includes("copilot@old-host"),
    )!;
    await act(async () => {
      row.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 30, clientY: 50 }),
      );
    });
    const items = [...row.querySelectorAll<HTMLButtonElement>("[role='menuitem']")];
    expect(items.some((button) => button.textContent?.includes("Check connection"))).toBe(false);
    const card = items.find((button) => button.textContent?.includes("Settings card"));
    expect(card).toBeDefined();
    await act(async () => {
      card!.click();
    });
    // Radix portals the drawer into the body.
    await actWaitUntil(() => {
      expect(document.body.textContent).toContain("Executor card");
    });
    expect(document.body.textContent).toContain("read-only except Delete");
    expect(document.body.textContent).toContain("revoked — presence is gone");
    await actUnmount(root);
  });

  it("the #executor-sheet-<id> hash deep-link opens the card (the enrollment «Open card» target)", async () => {
    const { root, container } = await mountPage(
      false,
      "/agents/harnesses#executor-sheet-exec-laptop-zcode",
    );
    await actWaitUntil(() => {
      expect(document.body.textContent).toContain("Executor card");
    });
    expect(document.body.textContent).toContain("silently desync the board from poller.yaml");
    // The scroll-into-view hash (#executor-<id>) must NOT open the card.
    expect(container.textContent).not.toContain("read-only except Delete");
    await actUnmount(root);
  });

  it("P3: %-garbage in either hash form never takes the page down", async () => {
    // Both decode sites (scroll + card deep-link) must swallow the URIError.
    const { root, container } = await mountPage(false, "/agents/harnesses#executor-sheet-%zz");
    await actWaitUntil(() => {
      expect(container.textContent).toContain("Awaiting approval");
    });
    expect(document.body.textContent).not.toContain("Executor card");
    const scroll = await mountPage(false, "/agents/harnesses#executor-%zz");
    expect(scroll.container.textContent).toContain("Awaiting approval");
    await actUnmount(scroll.root);
    await actUnmount(root);
  });
});

describe("AGW-5 registry row context menu", () => {
  it("a revoked row offers NO state-changing items — copy id and delete only", async () => {
    const { root, container } = await mountPage();
    const revoked = band(container, "Revoked")!;
    // The contextmenu handler lives on the ROW (li) — dispatch there.
    const row = [...revoked.querySelectorAll("li")].find((li) =>
      li.textContent?.includes("copilot@old-host"),
    )!;
    await act(async () => {
      row.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 30, clientY: 50 }),
      );
    });
    const menu = row.querySelector("[role='menu']");
    expect(menu).not.toBeNull();
    const items = [...menu!.querySelectorAll("[role='menuitem']")].map((item) =>
      item.textContent,
    );
    expect(items.some((text) => text?.includes("Approve"))).toBe(false);
    expect(items.some((text) => text?.includes("Enable"))).toBe(false);
    expect(items.some((text) => text?.includes("Revoke"))).toBe(false);
    expect(items.some((text) => text?.includes("Copy id"))).toBe(true);
    expect(items.some((text) => text?.includes("Delete"))).toBe(true);
    // The registry rows never carry the strip's «Open registry» escape.
    expect(items.some((text) => text?.includes("Open registry"))).toBe(false);
    await actUnmount(root);
  });
});
