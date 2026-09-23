// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { EnrollmentDialog } from "./EnrollmentDialog";
import { MockAdapter } from "@/gateway/MockAdapter";
import { ApiError } from "@/lib/errors";
import { GatewayContext } from "@/gateway/GatewayContext";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { ToastViewport } from "@/components/Toast/ToastViewport";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import type { ExecutorItem } from "@/gateway/boardTypes";

/**
 * The enrollment dialog integration (AGW-5 phase 2): form → token screen.
 * Covered: the mne_ plaintext MASKED until «Показать», copy wiring, the
 * live TTL countdown, the bootstrap block (REMOTE-EXECUTOR.md projection),
 * and the SERVER-text paths — 409 live-quota and 503 fail-closed — landing
 * verbatim in the error toast while the dialog stays on the form.
 */

async function mount(executors: ExecutorItem[] = []): Promise<{
  root: Root;
  container: HTMLElement;
  gateway: MockAdapter;
  onOpenChange: ReturnType<typeof vi.fn>;
}> {
  const gateway = new MockAdapter({ latency: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const onOpenChange = vi.fn();
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <GatewayContext.Provider value={gateway}>
        <QueryClientProvider client={client}>
          <ToastProvider>
            <UiTokenProvider>
              <I18nProvider initialLang="en">
                <EnrollmentDialog
                  open
                  onOpenChange={onOpenChange}
                  executors={executors}
                />
                <ToastViewport />
              </I18nProvider>
            </UiTokenProvider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
  return { root, container, gateway, onOpenChange };
}

/** Peek the mock's runtime-minted rows (private field; tests only). */
const gatewayListLength = (gateway: MockAdapter): number =>
  (
    gateway as unknown as {
      enrollments: { enrollment_id: string }[];
    }
  ).enrollments.length;

const button = (_container: HTMLElement, text: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  )!;

async function submitForm(container: HTMLElement): Promise<void> {
  await act(async () => {
    button(container, "Create token").click();
  });
}

beforeEach(() => {
  localStorage.clear();
  // happy-dom's navigator.clipboard is getter-only — redefine outright.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("EnrollmentDialog — form phase", () => {
  it("creates a token and lands on the masked token screen", async () => {
    const { root, container, gateway } = await mount();
    await submitForm(container);
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("shown ONCE");
    });
    // Masked: the visible prefix + bullets, never the material.
    const code = document.querySelector("code")!;
    expect(code.textContent).toMatch(/^mne_•+$/);
    // Reveal only on demand.
    await act(async () => {
      button(container, "Show").click();
    });
    const revealed = document.querySelector("code")!.textContent ?? "";
    expect(revealed.startsWith("mne_")).toBe(true);
    expect(revealed).not.toContain("•");
    // Hiding works too.
    await act(async () => {
      button(container, "Hide").click();
    });
    expect(document.querySelector("code")!.textContent).toMatch(/•/);
    // The mint went through the real gateway exactly once.
    expect(gatewayListLength(gateway)).toBe(1);
    root.unmount();
  });

  it("the 409 live-quota lands VERBATIM in an error toast; the form stays", async () => {
    const { root, container, gateway } = await mount();
    vi.spyOn(gateway, "createEnrollment").mockRejectedValue(
      new ApiError(
        409,
        "enrollment quota exceeded: at most 3 live tokens (revoke one to mint a new)",
        { url: "mock:/api/executors/enrollment" },
      ),
    );
    await submitForm(container);
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("at most 3 live tokens");
    });
    // Still on the form — the owner can revoke and retry.
    expect(document.body.textContent).toContain("Create token");
    root.unmount();
  });

  it("the 503 fail-closed path surfaces the SERVER text too", async () => {
    const { root, container, gateway } = await mount();
    vi.spyOn(gateway, "createEnrollment").mockRejectedValue(
      new ApiError(503, "ui token is not configured on the server", {
        url: "mock:/api/executors/enrollment",
      }),
    );
    await submitForm(container);
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("ui token is not configured");
    });
    root.unmount();
  });
});

describe("EnrollmentDialog — token screen", () => {
  it("shows the live TTL countdown, the ONE-LINER and the manual steps", async () => {
    const { root, container } = await mount();
    await submitForm(container);
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("expires in");
    });
    expect(document.body.textContent ?? "").toMatch(/expires in \d{2}:\d{2}/);
    // Wave 3D: the one-liner leads, the manual four steps live in the
    // <details> spoiler (diagnostics / air-gapped path).
    const pres = document.querySelectorAll("pre");
    expect(pres[0].textContent).toContain("/api/poller/bootstrap.sh");
    expect(pres[0].textContent).toContain("| sudo bash -s --");
    expect(pres[0].textContent).toContain("--url http://localhost:3000");
    expect(pres[0].textContent).toContain("--token mne_");
    const manual = [...document.querySelectorAll("details pre")];
    expect(manual).toHaveLength(4);
    expect(manual[0].textContent).toContain("api/executors");
    expect(manual[1].textContent).toContain("0600");
    expect(manual[3].textContent).toContain("--once");
    root.unmount();
  });

  it("the one-liner masks the token ON SCREEN; copying carries the FULL token", async () => {
    const { root, container, gateway } = await mount();
    const spy = vi.spyOn(gateway, "createEnrollment");
    await submitForm(container);
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("expires in");
    });
    const createdToken = (await spy.mock.results[0]!.value).token;
    const onScreen = document.querySelectorAll("pre")[0].textContent ?? "";
    // Masked on screen (shoulder-surfing discipline, same as the token row).
    expect(onScreen).toContain("mne_\u2022\u2022\u2022\u2022");
    expect(onScreen).not.toContain(createdToken);
    // The deliberate copy act carries the real token for the VPS shell.
    const oneLinerBlock = document.querySelectorAll("pre")[0].closest("div")!;
    const copyButton = [...oneLinerBlock.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Copy"),
    )!;
    await copyButton.click();
    await vi.waitFor(() => {
      const last = (
        navigator.clipboard.writeText as ReturnType<typeof vi.fn>
      ).mock.calls.at(-1)?.[0] as string;
      expect(last).toContain(createdToken);
      expect(last).toContain("/api/poller/bootstrap.sh");
      expect(last).toContain("| sudo bash -s --");
    });
    root.unmount();
  });
  it("copy buttons hand the token and the whole script to the clipboard", async () => {
    const { root, container } = await mount();
    await submitForm(container);
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("shown ONCE");
    });
    await act(async () => {
      button(container, "Copy").click();
    });
    const writeText = navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
    expect(writeText).toHaveBeenCalled();
    expect(String(writeText.mock.calls[0][0])).toMatch(/^mne_/);
    // Copy-all: every step joins into one paste.
    await act(async () => {
      button(container, "Copy all").click();
    });
    const allText = String(writeText.mock.lastCall?.[0] ?? "");
    expect(allText).toContain("api/executors");
    expect(allText).toContain("0600");
    expect(allText).toContain("--once");
    root.unmount();
  });
});

describe("EnrollmentDialog — honest copy (review P2-2)", () => {
  it("a REJECTED write shows the failure hint, never a fake «Copied» flash", async () => {
    const { root, container } = await mount();
    await submitForm(container);
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("shown ONCE");
    });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    await act(async () => {
      button(container, "Copy").click();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.body.textContent).toContain(
      "Copy failed — the token stays visible",
    );
    expect(document.body.textContent).not.toContain("Copied");
    // The token is still on screen (masked) — recoverable by hand.
    expect(document.querySelector("code")!.textContent).toMatch(/^mne_•+$/);
    root.unmount();
  });

  it("an ABSENT clipboard API shows the hint too (non-secure context)", async () => {
    const { root, container } = await mount();
    await submitForm(container);
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("shown ONCE");
    });
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    await act(async () => {
      button(container, "Copy").click();
    });
    expect(document.body.textContent).toContain(
      "Copy failed — the token stays visible",
    );
    root.unmount();
  });
});
