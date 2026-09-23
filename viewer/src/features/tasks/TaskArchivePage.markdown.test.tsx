// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TaskArchivePage } from "./TaskArchivePage";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import { UI_TOKEN_STORAGE_KEY } from "@/gateway/uiToken";
import type { ArchiveParams } from "@/gateway/boardTypes";

/**
 * Owner clamp directive + UI-27 on the archive surface: the expanded
 * archive row is a disclosure — summary and spec are author text and must
 * render through the TextEngine primitive (markdown formatted, not raw),
 * clamped behind «Show full text» when the content overflows. Overflow is
 * simulated with prototype height stubs (happy-dom lays out nothing) — the
 * same approach as the TextEngine unit tests.
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const MARKDOWN_SUMMARY = "Имя подтверждено: **vesmaro** свободен, org создан.";

const MARKDOWN_SPEC = [
  "## Acceptance",
  "",
  "- [x] corpus reads the board",
  "- [ ] diff is empty",
].join("\n");

async function mountArchive(): Promise<HTMLDivElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  sessionStorage.setItem(UI_TOKEN_STORAGE_KEY, "dev-token");
  const gateway = new MockAdapter({ latency: false });
  // Patch the page fixture: RB-1 carries markdown author text (the real
  // shape the engine must render instead of printing raw).
  const baseArchive = gateway.archive.bind(gateway);
  gateway.archive = (async (params: ArchiveParams = {}): Promise<
    Awaited<ReturnType<typeof baseArchive>>
  > => {
    const page = await baseArchive(params);
    return {
      ...page,
      items: page.items.map((task) =>
        task.id === "RB-1"
          ? { ...task, summary: MARKDOWN_SUMMARY, spec: MARKDOWN_SPEC }
          : task,
      ),
    };
  }) as unknown as MockAdapter["archive"];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await queryClient.prefetchQuery({
    queryKey: keys.tasks.archive({ limit: 50, offset: 0 }),
    queryFn: () => gateway.archive({ limit: 50, offset: 0 }),
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <GatewayContext.Provider value={gateway}>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <UiTokenProvider>
              <I18nProvider initialLang="en">
                <MemoryRouter initialEntries={["/tasks/archive"]}>
                  <TaskArchivePage />
                </MemoryRouter>
              </I18nProvider>
            </UiTokenProvider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
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

async function click(target: Element | null | undefined): Promise<void> {
  expect(target, "interaction target must exist").toBeDefined();
  await act(async () => {
    (target as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(() => {
  sessionStorage.clear();
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

describe("TaskArchivePage expanded row × TextEngine clamp", () => {
  it("summary and spec render markdown formatted inside the disclosure", async () => {
    const el = await mountArchive();
    const details = el.querySelector("details");
    expect(details, "archive row disclosure renders").not.toBeNull();
    await waitFor("spec heading", () => Boolean(details!.querySelector("h2")));
    expect(details!.querySelector("h2")?.textContent).toBe("Acceptance");
    expect(details!.querySelector("strong")?.textContent).toBe("vesmaro");
    expect(details!.querySelectorAll("li").length).toBe(2);
    // No raw markdown leakage in the expanded row.
    expect(details!.textContent).not.toContain("## Acceptance");
    expect(details!.textContent).not.toContain("**vesmaro**");
  });

  it("no expand button while the content fits", async () => {
    // No stubs: happy-dom reports zero heights, so nothing «overflows».
    // (The row's «Restore to board» button exists regardless — only the
    // clamp affordance is asserted on.)
    const el = await mountArchive();
    const details = el.querySelector("details");
    expect(details!.querySelector(".max-h-48")).not.toBeNull();
    const expand = [...details!.querySelectorAll("button")].find(
      (button) => button.textContent === "Show full text",
    );
    expect(expand).toBeUndefined();
  });

  it("overflowing row shows «Show full text»; expanding removes the cut", async () => {
    const proto = HTMLElement.prototype as unknown as Record<
      string,
      PropertyDescriptor | undefined
    >;
    const savedOffset = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
    const savedClient = Object.getOwnPropertyDescriptor(proto, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => 500,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 192,
    });
    try {
      const el = await mountArchive();
      const details = el.querySelector("details");
      // Both boxes (summary + spec) clamp; target the spec box precisely.
      const specHeading = () =>
        [...details!.querySelectorAll("h2")].find((h) => h.textContent === "Acceptance");
      await waitFor("spec heading", () => Boolean(specHeading()));
      const specBox = specHeading()!.closest(".max-h-48");
      expect(specBox, "clamp box around the spec renders").not.toBeNull();
      const specButton = specBox!.parentElement!.querySelector("button");
      expect(specButton?.textContent).toBe("Show full text");
      await click(specButton);
      expect(specHeading()!.closest(".max-h-48")).toBeNull();
      // The author text stays rendered after the expand.
      expect(specHeading()).not.toBeNull();
    } finally {
      delete (HTMLElement.prototype as { offsetHeight?: unknown }).offsetHeight;
      delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight;
      if (savedOffset) Object.defineProperty(HTMLElement.prototype, "offsetHeight", savedOffset);
      if (savedClient) Object.defineProperty(HTMLElement.prototype, "clientHeight", savedClient);
    }
  });
});
