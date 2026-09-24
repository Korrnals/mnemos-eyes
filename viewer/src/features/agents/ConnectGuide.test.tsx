// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/i18n";
import { ConnectGuide } from "./ConnectGuide";
import { actUnmount } from "@/test/actTools";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * AGW-4 + connect hotfix (owner prod feedback): the connect instruction —
 * COLLAPSED by default (anti-dashification: no furniture until asked),
 * expands into the FIVE steps of the ONE-COMMAND enrollment flow, the
 * honest installer-note (public download, secured transport, 15-min token)
 * and the manual-path pointer (REMOTE-EXECUTOR.md «Путь 2 — руками»).
 * The old manual poller path (poller.example.yaml / VESMARO_BOARD_TOKEN /
 * systemd) must NOT come back — the dialog owns the flow now.
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

describe("ConnectGuide (AGW-4 + connect hotfix)", () => {
  it("collapsed by default: the toggle announces itself, steps stay hidden", async () => {
    const { root, container } = await mount();
    const toggle = container.querySelector('button[aria-expanded="false"]');
    expect(toggle?.textContent).toContain("How to connect an external agent");
    expect(container.textContent).not.toContain("ONE command");
    await actUnmount(root);
  });

  it("expanded: exactly five steps of the one-command flow + the honest note", async () => {
    const { root, container } = await mount();
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click();
    });
    expect(container.querySelector('button[aria-expanded="true"]')).not.toBeNull();
    const steps = container.querySelectorAll("ol li");
    expect(steps).toHaveLength(5);
    // Step 1 — open the dialog, fill name + harness (own harness allowed).
    expect(steps[0]!.textContent).toContain("Add executor");
    expect(steps[0]!.textContent).toContain("harness");
    // Step 2 — the ONE command comes from the token screen.
    expect(steps[1]!.textContent).toContain("ONE command");
    // Step 3 — the VPS installs dependencies, agent and service itself.
    expect(steps[2]!.textContent).toContain("VPS");
    expect(steps[2]!.textContent).toContain("installs");
    // Step 4 — approve + enable in the queue.
    expect(steps[3]!.textContent).toContain("Awaiting approval");
    // Step 5 — the task runs on the external machine.
    expect(steps[4]!.textContent).toContain("task card");
    // Honest note: public installer text, secured transport, 15-min token.
    expect(container.textContent).toContain("installer from the board");
    expect(container.textContent).toContain("secured channel");
    expect(container.textContent).toContain("15 minutes");
    // Collapse again — the toggle is honest in both directions.
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click();
    });
    expect(container.querySelector('button[aria-expanded="false"]')).not.toBeNull();
    await actUnmount(root);
  });

  it("points at the manual runbook path, never the retired manual steps", async () => {
    const { root, container } = await mount();
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click();
    });
    // The manual pointer names the runbook and its «Путь 2 — руками».
    expect(container.textContent).toContain("deploy/poller/REMOTE-EXECUTOR.md");
    expect(container.textContent).toContain("Путь 2 — руками");
    // The retired hand-runbook copy stays retired.
    expect(container.textContent).not.toContain("poller.example.yaml");
    expect(container.textContent).not.toContain("VESMARO_BOARD_TOKEN");
    expect(container.textContent).not.toContain("chmod 0600");
    await actUnmount(root);
  });
});
