// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { HarnessSelect } from "./HarnessSelect";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { ToastViewport } from "@/components/Toast/ToastViewport";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import { setUiToken } from "@/gateway/uiToken";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The harness combobox (wave 3C): options from the LIVE dictionary (GET
 * /api/harnesses via the mock adapter — the seed corpus is fixture data),
 * «Добавить харнес…» → inline form → POST → selected. Covered: seed
 * options, the add flow, client-side name pre-validation (no POST on
 * garbage), the SERVER-text inline error on 409, cancel-without-change,
 * and a stale value (deleted elsewhere) staying visible.
 */

async function mount(initialValue = "zcode"): Promise<{
  root: Root;
  container: HTMLElement;
  gateway: MockAdapter;
  onChange: ReturnType<typeof vi.fn>;
}> {
  const gateway = new MockAdapter({ latency: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const onChange = vi.fn();
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <GatewayContext.Provider value={gateway}>
        <QueryClientProvider client={client}>
          <ToastProvider>
            <UiTokenProvider>
              <I18nProvider initialLang="en">
                <HarnessSelect id="test-harness" value={initialValue} onChange={onChange} />
                <ToastViewport />
              </I18nProvider>
            </UiTokenProvider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
  return { root, container, gateway, onChange };
}

const select = (): HTMLSelectElement =>
  document.querySelector<HTMLSelectElement>("select#test-harness")!;

const input = (): HTMLInputElement =>
  document.querySelector<HTMLInputElement>("input#test-harness")!;

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.includes(label),
  );
  if (!found) throw new Error(`button "${label}" not found`);
  return found;
}

async function changeSelect(value: string): Promise<void> {
  // The dictionary options load a tick after mount — the sentinel choice
  // only exists once the query resolved.
  await until(() => expect(select().options.length).toBeGreaterThan(1));
  await act(async () => {
    const element = select();
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** React-controlled input path: bypass the value tracker with the native
 * setter, then fire the input event (LoginDialog.flow.test.tsx pattern). */
function typeInto(element: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(element) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

/** React-query resolves a tick after mount — poll inside act until green. */
async function until(assertion: () => void, tries = 60): Promise<void> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }
  assertion();
}

beforeEach(() => {
  localStorage.clear();
  setUiToken("ui-test-token");
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("HarnessSelect — the dictionary combobox (wave 3C)", () => {
  it("renders the seed dictionary as options plus the add option", async () => {
    await mount();
    await until(() => expect(select().options.length).toBeGreaterThan(1));
    const options = [...select().options].map((option) => option.value);
    expect(options).toContain("zcode");
    expect(options).toContain("claude-code");
    expect(options).toHaveLength(11); // 10 seeds + the add sentinel
    expect(options).toContain("__add_harness__");
  });

  it("picks a dictionary value through onChange", async () => {
    const { onChange } = await mount();
    await changeSelect("hermes");
    expect(onChange).toHaveBeenCalledWith("hermes");
  });

  it("adds a new harness through the inline form and selects it", async () => {
    const { gateway, onChange } = await mount();
    await changeSelect("__add_harness__");
    expect(input()).toBeTruthy();
    await act(async () => {
      typeInto(input(), "myagent");
    });
    await act(async () => {
      button("Add").click();
    });
    // The new value is selected and reported; the dictionary owns it now.
    await until(() => expect(select()).toBeTruthy());
    await until(() =>
      expect(
        [...select().options].map((option) => option.value),
      ).toContain("myagent"),
    );
    expect(onChange).toHaveBeenCalledWith("myagent");
    const page = await gateway.listHarnesses();
    expect(page.items.map((harness) => harness.name)).toContain("myagent");
  });

  it("client-side invalid name renders the inline hint and never POSTs", async () => {
    const { gateway } = await mount();
    const spy = vi.spyOn(gateway, "createHarness");
    await changeSelect("__add_harness__");
    await act(async () => {
      typeInto(input(), "Bad Name!");
    });
    await act(async () => {
      button("Add").click();
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Lowercase latin",
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("a duplicate surfaces the SERVER text inline", async () => {
    const { gateway } = await mount();
    await gateway.createHarness({ name: "myagent" });
    await changeSelect("__add_harness__");
    await act(async () => {
      typeInto(input(), "myagent");
    });
    await act(async () => {
      button("Add").click();
    });
    await until(() =>
      expect(
        document.querySelector('[role="alert"]')?.textContent,
      ).toContain("already registered"),
    );
    // The dialog stays in add mode — the owner can fix the name.
    expect(input()).toBeTruthy();
  });

  it("cancel returns to the select without a change or a POST", async () => {
    const { gateway, onChange } = await mount();
    const spy = vi.spyOn(gateway, "createHarness");
    await changeSelect("__add_harness__");
    await act(async () => {
      typeInto(input(), "myagent");
    });
    await act(async () => {
      button("Cancel").click();
    });
    await until(() => expect(select()).toBeTruthy());
    expect(select().value).toBe("zcode");
    expect(onChange).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it("a stale value deleted from the dictionary stays selectable (no silent substitution)", async () => {
    const { gateway } = await mount("ghost-harness");
    await gateway.createHarness({ name: "ghost-harness" });
    await gateway.deleteHarness("ghost-harness");
    await mount("ghost-harness");
    // The select still offers the current (now unknown) value — the owner
    // sees what would travel; the dictionary simply no longer lists it.
    expect([...select().options].map((option) => option.value)).toContain(
      "ghost-harness",
    );
    expect(select().value).toBe("ghost-harness");
  });
});
