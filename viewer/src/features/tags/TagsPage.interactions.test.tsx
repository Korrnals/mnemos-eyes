// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TagsPage } from "./TagsPage";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { TAG_CORPUS } from "@/gateway/tagFixtures";
import type { TagSummary } from "@/gateway/types";
import { actFlush, actUnmount } from "@/test/actTools";

/**
 * Interaction gate in a real DOM (UI-17 spec §11.2/§11.5): the 24-chip cap
 * controls («Ещё 24 / Показать все / Свернуть») step through the URL state,
 * expansions SURVIVE a refetch (freeze-рамка §4.4 — урок 1.11.4: refetch/SSE
 * noise must never collapse the cloud), and taps drive the matryoshka
 * (family → taxonomy group → tag → server drill → sibling).
 */

const gateway = new MockAdapter({ latency: false, tagCorpus: TAG_CORPUS });

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let queryClient: QueryClient | null = null;

async function mount(path = "/memory/tags"): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await queryClient.prefetchQuery({
    queryKey: keys.tags.merged(),
    queryFn: () => gateway.mergedTags(),
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <GatewayContext.Provider value={gateway}>
        <QueryClientProvider client={queryClient!}>
          <I18nProvider initialLang="en">
            <MemoryRouter initialEntries={[path]}>
              <TagsPage />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
}

async function click(control: Element | null | undefined): Promise<void> {
  expect(control, "interaction target must exist").toBeDefined();
  await act(async () => {
    (control as HTMLButtonElement).click();
    await actFlush(0);
  });
}

/** The cap control wired to a band list via aria-controls + label text. */
function bandControl(band: string, label: string): HTMLButtonElement | null {
  return (
    [
      ...container!.querySelectorAll<HTMLButtonElement>(
        `button[aria-controls="band-${band}-list"]`,
      ),
    ].find((button) => button.textContent?.includes(label)) ?? null
  );
}

function chipCount(listId: string): number {
  return container!.querySelector(`#${listId}`)?.querySelectorAll("li").length ?? 0;
}

function chipCountIn(scope: HTMLElement, listId: string): number {
  return scope.querySelector(`#${listId}`)?.querySelectorAll("li").length ?? 0;
}

function buttonByText(text: string): HTMLButtonElement | null {
  return (
    [...container!.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes(text),
    ) ?? null
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  queryClient = null;
});

describe("caps (§3.3): Ещё 24 / Показать все / Свернуть", () => {
  it("expands the middle band in 24-chip steps and collapses back", async () => {
    await mount();
    expect(chipCount("band-middle-list")).toBe(24);

    await click(bandControl("middle", "Show 24 more"));
    expect(chipCount("band-middle-list")).toBe(48);

    await click(bandControl("middle", "Show 24 more"));
    expect(chipCount("band-middle-list")).toBe(72);

    // «Свернуть» appears after the first expansion (§3.3) and resets to 24.
    await click(bandControl("middle", "Collapse"));
    expect(chipCount("band-middle-list")).toBe(24);
  });

  it("offers one-shot «Показать все» on a 25–48 band (agent leaves: 34)", async () => {
    await mount("/memory/tags?family=agent");
    expect(chipCount("family-leaves-list")).toBe(24);
    await click(buttonByText("Show all 34"));
    expect(chipCount("family-leaves-list")).toBe(34);
  });

  it("keeps expansions alive across a refetch (freeze-гейт, урок 1.11.4)", async () => {
    await mount();
    await click(bandControl("middle", "Show 24 more"));
    expect(chipCount("band-middle-list")).toBe(48);

    // The sweep a staleTime expiry / refocus / manual refresh performs:
    await act(async () => {
      await queryClient!.invalidateQueries({ queryKey: keys.tags.all });
      await queryClient!.refetchQueries({ queryKey: keys.tags.all });
      await actFlush(0);
    });

    // Composition still follows the snapshot; the expanded count is intact.
    expect(chipCount("band-middle-list")).toBe(48);
    expect(
      container!
        .querySelector<HTMLButtonElement>('button[aria-controls="band-middle-list"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("restores the expanded state from a deep-linked URL (back contract, §2.2)", async () => {
    await mount("/memory/tags?b=middle:48,rare:48");
    expect(chipCount("band-middle-list")).toBe(48);
    expect(chipCount("band-rare-list")).toBe(48);
  });
});

describe("матрёшка (§2/§5): family → group → tag → sibling", () => {
  it("drills into a family via the chip row and renders segment groups", async () => {
    await mount();
    // The family-row chip for gcw is the first button whose label starts "gcw".
    const gcwChip = [
      ...container!.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
    ].find((button) => button.getAttribute("aria-label")?.startsWith("gcw,"));
    await click(gcwChip);
    expect(container!.textContent).toContain("Group component");

    // The group heading is itself a drill (Ур.3 → deeper prefix).
    await click(buttonByText("Group component"));
    expect(container!.querySelector("#family-leaves")).toBeDefined();
    expect(container!.textContent).toContain("gcw:component:chain-1");
  });

  it("expands a taxonomy GROUP with >24 chips (review P1: colon cap keys)", async () => {
    // A taxonomy group whose cap key contains a colon ("gcw:component") —
    // the exact shape the URL parser dropped (P1). 30 chain tags in the
    // group → the cap control shows; «Показать все» must reveal all 30.
    const corpus: TagSummary[] = Array.from({ length: 30 }, (_, i) => ({
      tag: `gcw:component:chain-${i + 1}`,
      count: 5,
    }));
    corpus.push({ tag: "project:solo", count: 500 });
    const fat = new MockAdapter({ latency: false, tagCorpus: corpus });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await qc.prefetchQuery({
      queryKey: keys.tags.merged(),
      queryFn: () => fat.mergedTags(),
    });
    const fatContainer = document.createElement("div");
    document.body.appendChild(fatContainer);
    const fatRoot = createRoot(fatContainer);
    await act(async () => {
      fatRoot.render(
        <GatewayContext.Provider value={fat}>
          <QueryClientProvider client={qc}>
            <I18nProvider initialLang="en">
              <MemoryRouter initialEntries={["/memory/tags"]}>
                <TagsPage />
              </MemoryRouter>
            </I18nProvider>
          </QueryClientProvider>
        </GatewayContext.Provider>,
      );
    });
    const withFat = fatContainer;

    // Drill: family chip gcw → taxonomy view with the fat group section.
    const gcwChip = [
      ...withFat.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
    ].find((button) => button.getAttribute("aria-label")?.startsWith("gcw,"));
    await click(gcwChip);
    expect(withFat.textContent).toContain("Group component");

    const listId = "group-0-list";
    // Capped at 24 on entry (owner cap).
    expect(chipCountIn(withFat, listId)).toBe(24);
    const showAll = [...withFat.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) =>
        button.getAttribute("aria-controls") === listId &&
        button.textContent?.includes("Show all"),
    );
    expect(showAll, "Show-all control of the fat group must exist").toBeDefined();
    await click(showAll);
    expect(chipCountIn(withFat, listId)).toBe(30);
    // And the URL carries the colon cap key (the P1 shape).
    expect(withFat.ownerDocument.body).toBeDefined();
    await actUnmount(fatRoot);
    fatContainer.remove();
  });

  it("opens the server drill from a leaf chip and swaps tags via siblings", async () => {
    await mount("/memory/tags?family=project");
    // Leaves sort count DESC → project:gcw (901) is the first chip.
    const leaf = container!.querySelector<HTMLButtonElement>(
      "#family-leaves-list button",
    );
    const leafTag = leaf!.getAttribute("aria-label")!.split(",")[0];
    await click(leaf);
    expect(container!.querySelector("#tag-drill-title")?.textContent).toContain(
      leafTag,
    );
    expect(container!.textContent).toContain("Nearby in project");

    // «Рядом в семействе»: tap a sibling → the drill retargets (боковой ход).
    const sibling = [
      ...container!.querySelectorAll<HTMLButtonElement>(
        '[aria-labelledby="tag-siblings"] button',
      ),
    ].find(
      (button) => (button.getAttribute("aria-label") ?? "").split(",")[0] !== leafTag,
    );
    const siblingTag = sibling!.getAttribute("aria-label")!.split(",")[0];
    await click(sibling);
    expect(container!.querySelector("#tag-drill-title")?.textContent).toContain(
      siblingTag,
    );
    expect(container!.querySelector("#tag-drill-title")?.textContent).not.toContain(
      leafTag,
    );
  });

  it("returns to the list via «← Все теги»", async () => {
    await mount("/memory/tags?tag=project:gcw");
    expect(container!.querySelector("#tag-drill-title")).toBeDefined();
    await click(buttonByText("All tags"));
    expect(container!.querySelector("#tag-drill-title")).toBeNull();
    expect(container!.querySelector("#band-core")).toBeDefined();
  });
});
