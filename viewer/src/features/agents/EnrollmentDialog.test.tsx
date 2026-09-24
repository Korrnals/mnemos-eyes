import { resetValidationClock } from "@/features/tasks/useValidationClock";
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
import { actFlush, actUnmount, actWaitUntil } from "@/test/actTools";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The enrollment dialog integration (AGW-5 phase 2 + AGW-11 masking):
 * form → token screen. Covered: the mne_ token ALWAYS masked on screen
 * (the plaintext rides the clipboard only; a copy FAILURE unmasks as the
 * last resort), the ≤3 live-token pre-flight, the --expect-fp задел,
 * copy wiring, the live TTL countdown, the bootstrap block
 * (REMOTE-EXECUTOR.md projection), and the SERVER-text paths — 409
 * live-quota and 503 fail-closed — landing verbatim in the error toast
 * while the dialog stays on the form.
 */

async function mount(
  executors: ExecutorItem[] = [],
  liveCount?: number,
): Promise<{
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
                  liveCount={liveCount}
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
    // Connect hotfix: the subtitle explains the FLOW (card → ONE command →
    // self-install → approval), not the token mechanics.
    expect(document.body.textContent).toContain("you get ONE command");
    expect(document.body.textContent).toContain("installs itself");
    await submitForm(container);
    await actWaitUntil(() => {
      expect(document.body.textContent).toContain("shown ONCE");
    });
    // AGW-11: the token is ALWAYS masked on screen — the full plaintext
    // exists only on the clipboard (no reveal button anymore).
    const code = document.querySelector("code")!;
    expect(code.textContent).toMatch(/^mne_•+$/);
    expect(button(container, "Show")).toBeUndefined();
    // The copy-note says exactly where the plaintext goes.
    expect(document.body.textContent).toContain("FULL token on the clipboard");
    // The mint went through the real gateway exactly once.
    expect(gatewayListLength(gateway)).toBe(1);
    await actUnmount(root);
  });

  it("AGW-11 quota pre-flight: the counter blocks at 3 live tokens", async () => {
    const { root } = await mount([], 3);
    // The honest full-state line renders and the submit is disabled.
    expect(document.body.textContent).toContain("Live-token limit (3) reached");
    expect(
      [...document.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Create token"),
      )!.disabled,
    ).toBe(true);
    await actUnmount(root);

    // Below the cap the count is visible and the button armed.
    const second = await mount([], 1);
    expect(document.body.textContent).toContain("Live tokens: 1 of 3");
    expect(
      [...document.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Create token"),
      )!.disabled,
    ).toBe(false);
    await actUnmount(second.root);
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
    await actWaitUntil(() => {
      expect(document.body.textContent).toContain("at most 3 live tokens");
    });
    // Still on the form — the owner can revoke and retry.
    expect(document.body.textContent).toContain("Create token");
    await actUnmount(root);
  });

  it("the 503 fail-closed path surfaces the SERVER text too", async () => {
    const { root, container, gateway } = await mount();
    vi.spyOn(gateway, "createEnrollment").mockRejectedValue(
      new ApiError(503, "ui token is not configured on the server", {
        url: "mock:/api/executors/enrollment",
      }),
    );
    await submitForm(container);
    await actWaitUntil(() => {
      expect(document.body.textContent).toContain("ui token is not configured");
    });
    await actUnmount(root);
  });
});

describe("EnrollmentDialog — token screen", () => {
  it("shows the live TTL countdown, the ONE-LINER and the manual steps", async () => {
    const { root, container } = await mount();
    await submitForm(container);
    await actWaitUntil(() => {
      expect(document.body.textContent).toContain("expires in");
    });
    expect(document.body.textContent ?? "").toMatch(/expires in \d{2}:\d{2}/);
    // Wave 3D: the one-liner leads, the manual four steps live in the
    // <details> spoiler (diagnostics / air-gapped path).
    const pres = document.querySelectorAll("pre");
    expect(pres[0].textContent).toContain("curl -kfsSL");
    expect(pres[0].textContent).toContain("/api/poller/bootstrap.sh");
    expect(pres[0].textContent).toContain("| sudo bash -s --");
    expect(pres[0].textContent).toContain("--url http://localhost:3000");
    expect(pres[0].textContent).toContain("--token mne_");
    const manual = [...document.querySelectorAll("details pre")];
    expect(manual).toHaveLength(4);
    expect(manual[0].textContent).toContain("api/executors");
    expect(manual[1].textContent).toContain("0600");
    expect(manual[3].textContent).toContain("--once");
    await actUnmount(root);
  });

  it("the one-liner masks the token ON SCREEN; copying carries the FULL token", async () => {
    const { root, container, gateway } = await mount();
    const spy = vi.spyOn(gateway, "createEnrollment");
    await submitForm(container);
    await actWaitUntil(() => {
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
    // ME-006: the shared 1 Hz validation clock re-renders TokenScreen once
    // per second — outside act in this longer test. Freeze it (the test
    // seam); the TTL visuals are not under assertion in the copy steps.
    resetValidationClock();
    await act(async () => {
      copyButton.click();
    });
    // ME-006: the «copied» flash lands on a clipboard microtask — flush
    // it inside act so TokenScreen does not update outside act.
    await actFlush();
    await actWaitUntil(() => {
      const last = (
        navigator.clipboard.writeText as ReturnType<typeof vi.fn>
      ).mock.calls.at(-1)?.[0] as string;
      expect(last).toContain(createdToken);
      expect(last).toContain("/api/poller/bootstrap.sh");
      expect(last).toContain("| sudo bash -s --");
    });
    await actUnmount(root);
  });
  it("AGW-11: the one-command grows --expect-fp when the mint carries the CA fingerprint", async () => {
    const { root, container, gateway } = await mount();
    // Canonical ssh-keygen shape (43 unpadded base64 chars) — P3-3
    // validates the form before the flag may ride the command.
    const validFp = `SHA256:${"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"}`;
    const spy = vi
      .spyOn(gateway, "createEnrollment")
      .mockImplementation(async (payload) => {
        const real = await MockAdapter.prototype.createEnrollment.call(
          gateway,
          payload,
        );
        return { ...real, ca_fingerprint: validFp };
      });
    await submitForm(container);
    await actWaitUntil(() => {
      expect(document.body.textContent).toContain("expires in");
    });
    // The masked one-liner carries the flag with the PUBLIC fingerprint.
    const onScreen = document.querySelectorAll("pre")[0].textContent ?? "";
    expect(onScreen).toContain(`--expect-fp ${validFp}`);
    // And the deliberate copy carries it too.
    const oneLinerBlock = document.querySelectorAll("pre")[0].closest("div")!;
    const copyButton = [...oneLinerBlock.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Copy"),
    )!;
    // ME-006: the shared 1 Hz validation clock re-renders TokenScreen once
    // per second — outside act in this longer test. Freeze it (the test
    // seam); the TTL visuals are not under assertion in the copy steps.
    resetValidationClock();
    await act(async () => {
      copyButton.click();
    });
    // ME-006: the «copied» flash lands on a clipboard microtask — flush
    // it inside act so TokenScreen does not update outside act.
    await actFlush();
    await actWaitUntil(() => {
      const last = (
        navigator.clipboard.writeText as ReturnType<typeof vi.fn>
      ).mock.calls.at(-1)?.[0] as string;
      expect(last).toContain(`--expect-fp ${validFp}`);
    });
    expect(spy).toHaveBeenCalled();
    await actUnmount(root);
  });

  it("PR #99 P3-3: a MALFORMED ca_fingerprint never rides the command (no flag)", async () => {
    const { root, container, gateway } = await mount();
    vi.spyOn(gateway, "createEnrollment").mockImplementation(async (payload) => {
      const real = await MockAdapter.prototype.createEnrollment.call(
        gateway,
        payload,
      );
      // Hostile shapes — the field feeds a paste-ready shell line, so
      // anything off the canonical forms is dropped, not interpolated.
      return { ...real, ca_fingerprint: 'SHA256:oops; rm -rf / #' };
    });
    await submitForm(container);
    await actWaitUntil(() => {
      expect(document.body.textContent).toContain("expires in");
    });
    const onScreen = document.querySelectorAll("pre")[0].textContent ?? "";
    expect(onScreen).not.toContain("--expect-fp");
    expect(onScreen).not.toContain("rm -rf");
    await actUnmount(root);
  });

  it("AGW-11: without the field (pre-AGW-9 board) the command stays WITHOUT the flag", async () => {
    const { root, container } = await mount();
    await submitForm(container);
    await actWaitUntil(() => {
      expect(document.body.textContent).toContain("expires in");
    });
    expect(document.querySelectorAll("pre")[0].textContent).not.toContain(
      "--expect-fp",
    );
    await actUnmount(root);
  });

  it("AGW-11: the manual steps mask the token on screen; the copy keeps it full", async () => {
    const { root, container, gateway } = await mount();
    const spy = vi.spyOn(gateway, "createEnrollment");
    await submitForm(container);
    await actWaitUntil(() => {
      expect(document.body.textContent).toContain("expires in");
    });
    const createdToken = (await spy.mock.results[0]!.value).token;
    const manual = [...document.querySelectorAll("details pre")];
    expect(manual.length).toBeGreaterThan(0);
    for (const step of manual) {
      expect(step.textContent).not.toContain(createdToken);
    }
    // Copy-all still hands the REAL script to the VPS shell.
    await act(async () => {
      button(container, "Copy all").click();
    });
    const allText = String(
      (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.lastCall?.[0] ?? "",
    );
    expect(allText).toContain(createdToken);
    await actUnmount(root);
  });

  it("copy buttons hand the token and the whole script to the clipboard", async () => {
    const { root, container } = await mount();
    await submitForm(container);
    await actWaitUntil(() => {
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
    await actUnmount(root);
  });
});

describe("EnrollmentDialog — honest copy (review P2-2)", () => {
  it("a REJECTED write shows the failure hint, never a fake «Copied» flash", async () => {
    const { root, container } = await mount();
    await submitForm(container);
    await actWaitUntil(() => {
      expect(document.body.textContent).toContain("shown ONCE");
    });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    await act(async () => {
      button(container, "Copy").click();
    });
    await actFlush(0);
    expect(document.body.textContent).toContain(
      "Copy failed — the token stays visible",
    );
    expect(document.body.textContent).not.toContain("Copied");
    // AGW-11: the failure UNMASKS the one-time token — bullets are not
    // hand-recoverable, and losing a shown-once token to a broken
    // clipboard is worse than the brief shoulder-surfing window.
    expect(document.querySelector("code")!.textContent).toMatch(/^mne_\S+$/);
    expect(document.querySelector("code")!.textContent).not.toContain("•");
    await actUnmount(root);
  });

  it("an ABSENT clipboard API shows the hint too (non-secure context)", async () => {
    const { root, container } = await mount();
    await submitForm(container);
    await actWaitUntil(() => {
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
    await actUnmount(root);
  });
});
