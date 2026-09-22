// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/i18n";
import { ConnectGuide } from "./ConnectGuide";

/**
 * AGW-4: the connect instruction — COLLAPSED by default (anti-dashification:
 * no furniture until asked), expands into the FIVE poller steps and the
 * honest machine-class note (no registration button lives in the UI).
 */

async function mount(): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider initialLang="en">
        <ConnectGuide />
      </I18nProvider>,
    );
  });
  return { root, container };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ConnectGuide (AGW-4)", () => {
  it("collapsed by default: the toggle announces itself, steps stay hidden", async () => {
    const { root, container } = await mount();
    const toggle = container.querySelector('button[aria-expanded="false"]');
    expect(toggle?.textContent).toContain("How to connect an external agent");
    expect(container.textContent).not.toContain("poller.example.yaml");
    root.unmount();
  });

  it("expanded: exactly five steps + the machine-class honest note", async () => {
    const { root, container } = await mount();
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click();
    });
    expect(container.querySelector('button[aria-expanded="true"]')).not.toBeNull();
    const steps = container.querySelectorAll("ol li");
    expect(steps).toHaveLength(5);
    expect(container.textContent).toContain("deploy/poller/README.md");
    expect(container.textContent).toContain("chmod 0600");
    expect(container.textContent).toContain("VESMARO_BOARD_TOKEN");
    expect(container.textContent).toContain("machine-class API");
    // Collapse again — the toggle is honest in both directions.
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click();
    });
    expect(container.querySelector('button[aria-expanded="false"]')).not.toBeNull();
    root.unmount();
  });
});
