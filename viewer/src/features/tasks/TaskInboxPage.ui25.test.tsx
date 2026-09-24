// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TaskInboxPage } from "./TaskInboxPage";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import { UI_TOKEN_STORAGE_KEY } from "@/gateway/uiToken";
import { actFlush } from "@/test/actTools";

/**
 * UI-25 owner feedback on /tasks/inbox: cards EXPAND to the full source
 * memory (fetched on demand), every editable row carries «Править» → the
 * PATCH overlay form, and the mock gateway's adopt consumes the EDITED
 * fields. The SSR chip/format contract lives in TaskInboxPage.test.tsx.
 */

const ROW_ID = "bd945a48-0888-4b1f-9ebb-841519e5f8b9"; // active, unedited
const EDITED_ROW_ID = "c2a111f3-5a44-4bb7-9d0e-6f7a2b3c4d5e"; // edits fixture
const ADOPTED_ROW_ID = "e52c33d5-7c66-4dd9-9f2a-8b9c4d5e6f70"; // TB-3

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mountInbox(): Promise<MockAdapter> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  sessionStorage.setItem(UI_TOKEN_STORAGE_KEY, "dev-token");
  const gateway = new MockAdapter({ latency: false });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await queryClient.prefetchQuery({
    queryKey: keys.tasks.inbox({ include_adopted: false }),
    queryFn: () => gateway.inbox({ include_adopted: false }),
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
                  <MemoryRouter initialEntries={["/tasks/inbox"]}>
                    <TaskInboxPage />
                  </MemoryRouter>
                </I18nProvider>
              </UiTokenProvider>
            </ToastProvider>
          </QueryClientProvider>
        </GatewayContext.Provider>,
    );
  });
  return gateway;
}

async function waitFor(what: string, probe: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  for (;;) {
    if (probe()) return;
    if (Date.now() > deadline) {
      throw new Error(
        `waitFor(${what}) timed out; page text: ${container!.textContent?.slice(0, 300)}`,
      );
    }
    await act(async () => {
      await actFlush(25);
    });
  }
}

async function click(target: Element | null | undefined): Promise<void> {
  expect(target, "interaction target must exist").toBeDefined();
  await act(async () => {
    (target as HTMLButtonElement).click();
    await actFlush(20);
  });
}

/** Controlled-input seam: React reads values through the prototype setter.
 * ME-006: the dispatches run inside act — the controlled update must not
 * land outside it (EditInboxForm "not wrapped in act" warnings). */
function typeInto(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function cardOf(titleFragment: string): HTMLElement {
  const article = [...container!.querySelectorAll("article")].find((a) =>
    a.textContent?.includes(titleFragment),
  );
  expect(article, `card ${titleFragment} must exist`).toBeDefined();
  return article!;
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe("UI-25 inbox expand + edit interactions", () => {
  it("expands a card to the full source memory + key:value details", async () => {
    await mountInbox();
    const chevron = cardOf("Снять corpus с живого борда").querySelector(
      "button[aria-label='Record details']",
    );
    await click(chevron);
    // unique to the FULL memory content (the mirror excerpt is shorter)
    await waitFor("full text", () =>
      Boolean(container!.textContent?.includes("Критерий приёмки")));
    const details = cardOf("Снять corpus с живого борда");
    // key:value detail rows (не только чипы); textContent joins dt/dd без пробела
    expect(details.textContent).toContain("Record details");
    expect(details.textContent).toContain("specialist:");
    expect(details.textContent).toContain("@GCW: Senior System Engineer");
    expect(details.textContent).toContain("memory:bd945a48");
    // mirror tags travel as colored chips
    expect(details.textContent).toContain("task:queue");
    expect(details.textContent).toContain("project:mnemos");
  });

  it("«Править» opens the form; saving stores the overlay and updates the card", async () => {
    const gateway = await mountInbox();
    const editButton = [...cardOf("Снять corpus с живого борда").querySelectorAll("button")]
      .find((b) => b.textContent?.includes("Edit"));
    await click(editButton);
    await waitFor("edit form", () =>
      Boolean(container!.querySelector("form[aria-label*='before adopting']")));
    const form = container!.querySelector("form")!;
    const titleInput = form.querySelector<HTMLInputElement>("input[id^='inbox-edit-title']")!;
    expect(titleInput.value).toBe("Снять corpus с живого борда для Ф2");
    const summaryInput = form.querySelector<HTMLTextAreaElement>("textarea")!;
    typeInto(summaryInput, "owner-edited spec text");
    const submit = [...form.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Save edits"));
    await click(submit);
    await waitFor("card reflects the edit", () =>
      Boolean(container!.textContent?.includes("owner-edited spec text")));
    const saved = (await gateway.inbox()).items.find((i) => i.memory_id === ROW_ID);
    expect(saved?.edits).toMatchObject({ summary: "owner-edited spec text" });
  });

  it("mock adopt consumes the EDITED fields (title/summary/priority)", async () => {
    const gateway = new MockAdapter({ latency: false });
    await gateway.patchInboxItem(EDITED_ROW_ID, {
      title: "PWA v2 — с офлайн-режимом",
      summary: "owner spec",
      priority: "critical",
    });
    const created = await gateway.adoptInboxItem(EDITED_ROW_ID);
    expect(created.title).toBe("PWA v2 — с офлайн-режимом");
    expect(created.summary).toBe("owner spec");
    expect(created.priority).toBe("critical");
    // SEC-4: link, never copy
    expect(created.memory_ids).toContain(EDITED_ROW_ID);
  });

  it("mock patchInboxItem: 409 on an adopted row, 404 on unknown", async () => {
    const gateway = new MockAdapter({ latency: false });
    await expect(
      gateway.patchInboxItem(ADOPTED_ROW_ID, { title: "late" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      gateway.patchInboxItem("no-such-row", { title: "x" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
