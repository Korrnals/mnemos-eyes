// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ProvisionCard } from "./ProvisionCard";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { ToastViewport } from "@/components/Toast/ToastViewport";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import { keys } from "@/lib/queryKeys";
import { fingerprintHex } from "./provisionTypes";

/**
 * The connect card integration (AGW-11): the REAL MockAdapter (its
 * provision state machine is READ-DRIVEN — one phase per status read, so
 * the tests advance it deterministically through refetches). Covered:
 *
 * - the form → 202 → the FEED appears (funnel + honest interim slots);
 * - the happy path walks to done and demands the PASTE-BACK: the approve
 *   unlocks ONLY on the exact fingerprint tail, then flips the pending row;
 * - a typed failure renders the TABLE hint (host_key_mismatch also shows
 *   the expected fingerprint) with the retry carrying the reuse rule;
 * - client-side gates: no host / no secret refuse to submit.
 */

interface Mount {
  root: Root;
  gateway: MockAdapter;
  queryClient: QueryClient;
}

async function mountCard(): Promise<Mount> {
  const gateway = new MockAdapter({ latency: false });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <GatewayContext.Provider value={gateway}>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <UiTokenProvider>
              <I18nProvider initialLang="en">
                <ProvisionCard />
                <ToastViewport />
              </I18nProvider>
            </UiTokenProvider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
  return { root, gateway, queryClient };
}

const button = (text: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  )!;

function inputByLabel(text: string): HTMLInputElement | HTMLTextAreaElement {
  const label = [...document.querySelectorAll("label")].find((element) =>
    element.textContent?.includes(text),
  );
  const field = label?.querySelector("input, textarea");
  if (field === null || field === undefined) {
    throw new Error(`no field for label ${text}`);
  }
  return field as HTMLInputElement | HTMLTextAreaElement;
}

async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  // React controlled inputs need the PROTOTYPE setter — a plain .value
  // assignment never reaches the onChange handler (ExecutorSheet pattern).
  const proto = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await act(async () => {
    nativeSetter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Drive the read-driven mock forward + sync the card's queries. */
async function advance(queryClient: QueryClient, rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: keys.agents.provision.all });
    });
  }
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: keys.agents.executors.all });
  });
}

/** Submit the default happy-path form (key auth, https board url). */
async function submitHappyForm(): Promise<void> {
  await type(inputByLabel("Machine address"), "vps-1");
  await type(inputByLabel("Private key"), "-----BEGIN OPENSSH-----");
  await type(inputByLabel("Board address"), "https://b.example");
  await act(async () => {
    button("Connect").click();
  });
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ProvisionCard — the form", () => {
  it("refuses to submit without a host or secret (client gates mirror the server)", async () => {
    const { root } = await mountCard();
    await act(async () => {
      button("Connect").click();
    });
    expect(document.body.textContent).toContain("lowercase letters/digits");
    // The POST never fired — no feed, the form is still here.
    expect(document.body.textContent).toContain("How to log in");
    root.unmount();
  });

  it("password auth is a choice the OWNER makes explicitly (default is key)", async () => {
    const { root } = await mountCard();
    const passwordOption = [
      ...document.querySelectorAll<HTMLInputElement>("input[type=radio]"),
    ].find((radio) => radio.value === "password")!;
    await act(async () => {
      passwordOption.click();
    });
    expect(document.body.textContent).toContain("provisioner.passwordAuth");
    root.unmount();
  });
});

describe("ProvisionCard — the feed", () => {
  it("happy path: 202 → funnel → done → paste-back unlocks ONLY on the tail", async () => {
    const { root, queryClient } = await mountCard();
    await submitHappyForm();

    // The feed replaced the form: funnel + interim honesty slots render.
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("SSH connection to the machine");
    });
    expect(document.body.textContent).toContain("interim: manual tunnel");
    expect(document.body.textContent).toContain("Connectivity profile:");
    expect(document.body.textContent).toContain("later");
    // The reserved mesh stage renders as «later», never as done.
    expect(document.body.textContent).toContain("Mesh tunnel");

    // The job id rode sessionStorage (the reload re-attach contract).
    expect(sessionStorage.getItem("vesmaro.provision.active")).toContain("pj-mock");

    // Walk the mock to done (queued→connecting→installing→watching→done).
    await advance(queryClient, 6);

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("awaits your approval");
    });
    // The paste-back: the pin is on screen, the approve starts disabled.
    const pinLine = [...document.querySelectorAll("code")].find((code) =>
      code.textContent?.startsWith("SHA256:"),
    )!;
    const fingerprint = pinLine.textContent ?? "";
    const approve = button("Approve");
    expect(approve.disabled).toBe(true);

    // A wrong tail never unlocks.
    await type(inputByLabel("Last 8 hex chars") as HTMLInputElement, "deadbeef");
    expect(button("Approve").disabled).toBe(true);

    // The exact tail (read off the TARGET in real life) unlocks + approves.
    const hex = fingerprintHex(fingerprint);
    expect(hex).not.toBeNull();
    await type(inputByLabel("Last 8 hex chars") as HTMLInputElement, hex!.slice(-8));
    expect(button("Approve").disabled).toBe(false);
    await act(async () => {
      button("Approve").click();
    });
    await vi.waitFor(() => {
      // The registry row left pending (the mock flipped it via the PATCH).
      expect(document.body.textContent).toContain("already approved");
    });
    // The approve context was one-shot — consumed by the click.
    const leftover = Object.keys(sessionStorage).filter((key) =>
      key.startsWith("vesmaro.provision-approve."),
    );
    expect(leftover).toEqual([]);
    root.unmount();
  });

  it("host_key_mismatch: the TABLE hint + the expected fingerprint + retry", async () => {
    const { root, gateway, queryClient } = await mountCard();
    gateway.setProvisionOutcome({ failCode: "host_key_mismatch" });
    await submitHappyForm();
    await advance(queryClient, 6);

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("did not match the expected one");
    });
    // The one code where the technical detail IS the answer.
    expect(document.body.textContent).toContain("Expected machine key fingerprint:");
    expect(document.body.textContent).toContain("Code: host_key_mismatch");
    // The failure is final for the job — the honest answer is a NEW job.
    expect(document.body.textContent).toContain("Retry");
    // The typed hint beats the raw code: the code is SECONDARY text.
    const body = document.body.textContent ?? "";
    expect(body.indexOf("did not match the expected one")).toBeLessThan(
      body.indexOf("Code: host_key_mismatch"),
    );
    root.unmount();
  });

  it("a sudo failure renders ITS hint (the table, not the raw code)", async () => {
    const { root, gateway, queryClient } = await mountCard();
    gateway.setProvisionOutcome({ failCode: "ssh.sudo_required" });
    await submitHappyForm();
    await advance(queryClient, 6);

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("passwordless sudo");
    });
    expect(document.body.textContent).not.toContain("Expected machine key fingerprint:");
    root.unmount();
  });

  it("retry returns to the form and KEEPS the executor name (PR #99 P3-2)", async () => {
    const { root, gateway, queryClient } = await mountCard();
    gateway.setProvisionOutcome({ failCode: "ssh.auth_failed" });
    await type(inputByLabel("Machine address"), "vps-1");
    await type(inputByLabel("Private key"), "-----BEGIN OPENSSH-----");
    await type(inputByLabel("Board address"), "https://b.example");
    // The owner named the machine — the retry must not lose it (the wire
    // job row never echoes the name; it rides the active-job record).
    await type(inputByLabel("Executor name"), "gpu-box");
    await act(async () => {
      button("Connect").click();
    });
    await advance(queryClient, 6);
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("key or password did not fit");
    });
    await act(async () => {
      button("Retry").click();
    });
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("How to log in");
    });
    // The active job detached — the feed is gone.
    expect(sessionStorage.getItem("vesmaro.provision.active")).toBeNull();
    // P3-2: the re-seeded form carries the submitted executor name.
    expect((inputByLabel("Executor name") as HTMLInputElement).value).toBe(
      "gpu-box",
    );
    root.unmount();
  });
});
