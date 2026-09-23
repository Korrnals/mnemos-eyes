// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AutomationSettingsSection } from "./AutomationSettingsSection";
import { MockAdapter } from "@/gateway/MockAdapter";
import { ApiError } from "@/lib/errors";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { ToastViewport } from "@/components/Toast/ToastViewport";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";

/**
 * UI-21 «Автоматизация» section (spec 2026-09-23 §2-§3, acceptance §6):
 * loads the store defaults (mock parity: enabled=false, cap=10), sends BOTH
 * fields on save, gates garbage caps CLIENT-side (inline error, no PUT),
 * answers a 422 with the server text verbatim and reverts the form to the
 * LOADED values (P3-6b), renders the honest engine-off stanza only while
 * status.engine is false, and without a session stays readable with the
 * save disabled + one disabledNote line (ADR 0013 §8).
 */

/** The S2 world: same store, engine honestly on — the stanza must vanish. */
class EngineOnGateway extends MockAdapter {
  async automationStatus() {
    return { ...(await super.automationStatus()), engine: true };
  }
}

/** The gate refusal UI-21 §3 demands: server 422 with the verbatim text. */
class RefusingGateway extends MockAdapter {
  putAutomationSettings(): Promise<never> {
    return Promise.reject(
      new ApiError(422, "cap_global_per_day must be an int in 1..1000", {
        url: "mock:/api/automation/settings",
      }),
    );
  }
}

/** A board without a session (ADR 0014): readable, mutations disabled. */
class SessionlessGateway extends MockAdapter {
  hasUiToken(): boolean {
    return false;
  }
}

async function mountSection(
  gateway: MockAdapter,
): Promise<{ root: Root; container: HTMLElement; gateway: MockAdapter }> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await client.prefetchQuery({
    queryKey: keys.automation.settings(),
    queryFn: () => gateway.getAutomationSettings(),
  });
  await client.prefetchQuery({
    queryKey: keys.automation.status(),
    queryFn: () => gateway.automationStatus(),
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
                  <AutomationSettingsSection anchorId="automation" />
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

/** Set a controlled input's value the way a user typing would. */
async function typeValue(input: HTMLInputElement, value: string): Promise<void> {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    nativeSetter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function capInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>("#automation-cap")!;
}

function saveButton(container: HTMLElement): HTMLButtonElement {
  return [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Save",
  )!;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AutomationSettingsSection — «Автоматизация» (UI-21)", () => {
  it("loads the store defaults: switch off, cap 10, honest day counter", async () => {
    const { root, container } = await mountSection(new MockAdapter({ latency: false }));
    const text = container.textContent ?? "";
    expect(text).toContain("Automation");
    const script = container.querySelector<HTMLInputElement>("#automation-enabled")!;
    expect(script.checked).toBe(false);
    expect(capInput(container).value).toBe("10");
    // Criterion 8: the counter rides the status projection (S1: honest 0).
    expect(text).toContain("0 of 10 used today");
    root.unmount();
  });

  it("the engine-off stanza shows while engine=false and leaves when true", async () => {
    const off = await mountSection(new MockAdapter({ latency: false }));
    expect(off.container.textContent).toContain("Engine not enabled");
    expect(off.container.textContent).toContain("this preference is stored now");
    off.root.unmount();

    const on = await mountSection(new EngineOnGateway({ latency: false }));
    expect(on.container.textContent).not.toContain("Engine not enabled");
    on.root.unmount();
  });

  it("saving sends BOTH fields through the wire and lands the ok toast", async () => {
    const gateway = new MockAdapter({ latency: false });
    const putSpy = vi.spyOn(gateway, "putAutomationSettings");
    const { root, container } = await mountSection(gateway);

    const script = container.querySelector<HTMLInputElement>("#automation-enabled")!;
    await act(async () => {
      script.click();
    });
    await typeValue(capInput(container), "25");
    await act(async () => {
      saveButton(container).click();
    });

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Automation settings saved"),
    );
    expect(putSpy).toHaveBeenCalledWith({ enabled: true, cap_global_per_day: 25 });
    const stored = await gateway.getAutomationSettings();
    expect(stored.enabled).toBe(true);
    expect(stored.cap_global_per_day).toBe(25);
    root.unmount();
  });

  it("client gate: 0/1001/blank show the inline error, the PUT never fires", async () => {
    const gateway = new MockAdapter({ latency: false });
    const putSpy = vi.spyOn(gateway, "putAutomationSettings");
    const { root, container } = await mountSection(gateway);

    for (const bad of ["0", "1001", ""]) {
      await typeValue(capInput(container), bad);
      expect(container.textContent).toContain("Enter a whole number from 1 to 1000");
      expect(capInput(container).getAttribute("aria-invalid")).toBe("true");
      expect(capInput(container).getAttribute("aria-describedby")).toContain(
        "automation-cap-error",
      );
      expect(saveButton(container).disabled).toBe(true);
    }
    expect(putSpy).not.toHaveBeenCalled();
    root.unmount();
  });

  it("a 422 answers with the server text verbatim and reverts to the loaded values", async () => {
    const gateway = new RefusingGateway({ latency: false });
    const { root, container } = await mountSection(gateway);

    await typeValue(capInput(container), "500");
    expect(capInput(container).value).toBe("500");
    await act(async () => {
      saveButton(container).click();
    });

    // The verbatim gate text rides the error toast; the form is back on the
    // LOADED pair (P3-6b) — no dangling local edits.
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "cap_global_per_day must be an int in 1..1000",
      ),
    );
    await vi.waitFor(() => expect(capInput(container).value).toBe("10"));
    expect(
      container.querySelector<HTMLInputElement>("#automation-enabled")!.checked,
    ).toBe(false);
    root.unmount();
  });

  it("no session: the section reads fully, save is disabled, one honest note", async () => {
    const { root, container } = await mountSection(
      new SessionlessGateway({ latency: false }),
    );
    const text = container.textContent ?? "";
    // Readable: loaded values still render.
    expect(text).toContain("Daily auto-launch cap");
    expect(capInput(container).value).toBe("10");
    expect(container.querySelector('[role="switch"]')).not.toBeNull();
    expect(saveButton(container).disabled).toBe(true);
    // ONE disabledNote line (role="note").
    const notes = [...container.querySelectorAll('[role="note"]')].filter((node) =>
      node.textContent?.includes("read-only"),
    );
    expect(notes).toHaveLength(1);
    root.unmount();
  });
});
