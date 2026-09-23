// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

import { PulseFeed } from "./PulseFeed";
import { I18nProvider } from "@/i18n";
import type { MemoryPulseItem } from "@/gateway/boardTypes";

/**
 * UI-27 integration at the pulse rows: a server-cut content fragment renders
 * through the TextEngine primitive — markdown fragments upgrade from the
 * Suspense fallback to the lazy renderer chunk, and the `clamp` cut shows
 * «показать полностью» only on real measured overflow. SSR-safe states
 * (plain passthrough, honest absence) live in PulseFeed.test.tsx.
 */

const MARKDOWN_FRAGMENT = [
  "## Приёмка",
  "",
  "- первый пункт",
  "- **второй** с акцентом",
].join("\n");

function itemFixture(overrides: Partial<MemoryPulseItem>): MemoryPulseItem {
  return {
    id: "m-md-1",
    title: "Fragmented",
    tags: [],
    status: "published",
    created_at: "2026-09-19T08:00:00Z",
    server: "store-a",
    content: MARKDOWN_FRAGMENT,
    ...overrides,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(ui: React.ReactElement): Promise<HTMLDivElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider initialLang="en">
        <MemoryRouter>{ui}</MemoryRouter>
      </I18nProvider>,
    );
  });
  return container;
}

async function waitFor(what: string, probe: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  for (;;) {
    if (probe()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitFor(${what}) timed out; html: ${container!.innerHTML.slice(0, 400)}`);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

async function click(target: Element): Promise<void> {
  await act(async () => {
    (target as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(() => {
  container = null;
  root = null;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe("PulseFeed — markdown fragments (lazy chunk)", () => {
  it("markdown fragment upgrades from fallback to rendered elements", async () => {
    const el = await mount(
      <PulseFeed items={[itemFixture({ content: MARKDOWN_FRAGMENT })]} />,
    );
    await waitFor("h2 rendered", () => Boolean(el.querySelector("h2")));
    expect(el.querySelector("h2")?.textContent).toBe("Приёмка");
    // The feed is itself a <ul> (aria-labelled) — count only the markdown list.
    expect(el.querySelectorAll("ul:not([aria-label]) > li").length).toBe(2);
    expect(el.querySelector("strong")?.textContent).toBe("второй");
  });
});

describe("PulseFeed — clamp affordance on fragments", () => {
  const proto = HTMLElement.prototype as unknown as Record<string, PropertyDescriptor | undefined>;
  let savedOffset: PropertyDescriptor | undefined;
  let savedClient: PropertyDescriptor | undefined;

  function stubOverflow(contentHeight: number, boxHeight: number): void {
    savedOffset = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
    savedClient = Object.getOwnPropertyDescriptor(proto, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => contentHeight,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => boxHeight,
    });
  }

  function restoreOverflow(): void {
    delete (HTMLElement.prototype as { offsetHeight?: unknown }).offsetHeight;
    delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight;
    if (savedOffset) Object.defineProperty(HTMLElement.prototype, "offsetHeight", savedOffset);
    if (savedClient) Object.defineProperty(HTMLElement.prototype, "clientHeight", savedClient);
  }

  afterEach(() => {
    restoreOverflow();
  });

  it("overflowing fragment shows «Show full text»; expanding removes the cut", async () => {
    stubOverflow(500, 192); // content taller than the max-h-48 clamp box
    const long = "Длинный фрагмент без переносов синтаксиса. ".repeat(30);
    const el = await mount(<PulseFeed items={[itemFixture({ content: long })]} />);
    expect(el.querySelector(".max-h-48"), "clamp box renders").not.toBeNull();
    await waitFor("expand button", () => Boolean(el.querySelector("button")));
    const button = el.querySelector("button");
    expect(button?.textContent).toBe("Show full text");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    await click(button!);
    expect(el.querySelector(".max-h-48")).toBeNull();
    expect(el.querySelector("button")).toBeNull();
  });

  it("fragment that fits shows no expand button", async () => {
    stubOverflow(100, 192);
    const el = await mount(
      <PulseFeed items={[itemFixture({ content: "Короткий фрагмент." })]} />,
    );
    expect(el.querySelector(".max-h-48")).not.toBeNull();
    expect(el.querySelector("button")).toBeNull();
  });
});
