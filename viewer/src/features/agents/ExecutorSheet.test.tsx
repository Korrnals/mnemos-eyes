// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ExecutorSheet } from "./ExecutorSheet";
import { ToastViewport } from "@/components/Toast/ToastViewport";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import type { ExecutorsPage } from "@/gateway/boardTypes";

/**
 * The executor settings card (AGW-6 B): the REAL MockAdapter registry
 * through the REAL gated mutations. Covered: the sections + the harness
 * WHY-note, the PATCH diff discipline (rename sends ONLY {name}; clearing
 * capabilities behind a confirm sends []; empty diff sends NOTHING), the
 * enabled kill-switch as its own single-field PATCH, the server's 409 text
 * landing verbatim, and the revoked tombstone (read-only except Delete,
 * verdict «revoked», the secret never rendered — only explained).
 */

interface Mount {
  root: Root;
  gateway: MockAdapter;
  queryClient: QueryClient;
  text: () => string;
  query: <T extends Element>(selector: string) => T[];
}

async function mountCard(
  executorId: string,
  transform: (page: ExecutorsPage) => ExecutorsPage = (page) => page,
): Promise<Mount> {
  const gateway = new MockAdapter({ latency: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = transform(await gateway.listExecutors());
  queryClient.setQueryData(keys.agents.executors.list(), page);
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
                <MemoryRouter>
                  <ExecutorSheet
                    executorId={executorId}
                    open
                    onOpenChange={() => undefined}
                  />
                  {/* The Shell mounts this in the app — without it toasts
                   * live in the provider only and never reach the DOM. */}
                  <ToastViewport />
                </MemoryRouter>
              </I18nProvider>
            </UiTokenProvider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
  return {
    root,
    gateway,
    queryClient,
    text: () => document.body.textContent ?? "",
    query: <T extends Element>(selector: string) => [
      ...document.querySelectorAll<T>(selector),
    ],
  };
}

/** The Radix dialog lives in a portal — interact via accessible text. */
async function clickButton(mount: Mount, label: string): Promise<void> {
  const button = mount
    .query<HTMLButtonElement>("button")
    .find((candidate) => candidate.textContent?.includes(label) && !candidate.disabled);
  expect(button, `button «${label}» not found`).toBeDefined();
  await act(async () => {
    button!.click();
  });
}

async function setName(mount: Mount, value: string): Promise<void> {
  const input = mount.query<HTMLInputElement>("input[maxlength='120']")[0];
  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    nativeSetter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function stubConfirm(returnValue: boolean): ReturnType<typeof vi.fn> {
  const confirm = vi.fn(() => returnValue);
  (window as unknown as { confirm: () => boolean }).confirm = confirm;
  return confirm;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  delete (window as unknown as { confirm?: () => boolean }).confirm;
});

describe("ExecutorSheet — identity + the diff PATCH discipline", () => {
  it("renders the sections and the harness WHY-note (never a bare refusal)", async () => {
    const mount = await mountCard("exec-laptop-zcode");
    const html = mount.text();
    for (const section of ["Identity", "Link", "Access", "Capabilities", "Danger zone"]) {
      expect(html).toContain(section);
    }
    expect(html).toContain("silently desync the board from poller.yaml");
    expect(html).toContain("dispatch = approved AND enabled");
    expect(html).toContain("the real gate is the poller's local allowlist");
    mount.root.unmount();
  });

  it("a rename sends ONLY {name} — capabilities stay absent from the body", async () => {
    const mount = await mountCard("exec-laptop-zcode");
    const spy = vi.spyOn(mount.gateway, "patchExecutor");
    await setName(mount, "zcode@laptop-renamed");
    await clickButton(mount, "Save");
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith("exec-laptop-zcode", {
      name: "zcode@laptop-renamed",
    });
    mount.root.unmount();
  });

  it("an empty diff disables Save — NO request travels", async () => {
    const mount = await mountCard("exec-laptop-zcode");
    const spy = vi.spyOn(mount.gateway, "patchExecutor");
    const save = mount
      .query<HTMLButtonElement>("button")
      .find((candidate) => candidate.textContent?.includes("Save"));
    expect(save?.disabled).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    mount.root.unmount();
  });

  it("clearing capabilities behind a confirm sends the deliberate [] wipe", async () => {
    const mount = await mountCard("exec-laptop-zcode");
    const confirm = stubConfirm(true);
    const spy = vi.spyOn(mount.gateway, "patchExecutor");
    await clickButton(mount, "Clear");
    expect(confirm).toHaveBeenCalled();
    await clickButton(mount, "Save");
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith("exec-laptop-zcode", { capabilities: [] });
    mount.root.unmount();
  });

  it("a cancelled wipe changes nothing (no [] without the confirm)", async () => {
    const mount = await mountCard("exec-laptop-zcode");
    const confirm = stubConfirm(false);
    await clickButton(mount, "Clear");
    expect(confirm).toHaveBeenCalled();
    // The diff stays empty → Save remains disabled.
    const save = mount
      .query<HTMLButtonElement>("button")
      .find((candidate) => candidate.textContent?.includes("Save"));
    expect(save?.disabled).toBe(true);
    mount.root.unmount();
  });

  it("P3: chip-by-chip removal down to [] hits the SAME wipe confirm on Save", async () => {
    const mount = await mountCard("exec-laptop-zcode"); // 2 declared caps
    const confirm = stubConfirm(false); // DECLINE first — the bypass probe
    const spy = vi.spyOn(mount.gateway, "patchExecutor");
    const removeButtons = () =>
      mount.query<HTMLButtonElement>("button[aria-label^='Remove capability']");
    expect(removeButtons()).toHaveLength(2);
    await act(async () => {
      removeButtons()[0].click();
    });
    await act(async () => {
      removeButtons()[0].click();
    });
    // The bulk «Clear» was never touched, yet the diff is [] — Save must
    // still confirm, and a decline must send NOTHING.
    expect(confirm).not.toHaveBeenCalled();
    await clickButton(mount, "Save");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
    // Accepting lets the deliberate wipe travel.
    stubConfirm(true);
    await clickButton(mount, "Save");
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith("exec-laptop-zcode", { capabilities: [] });
    mount.root.unmount();
  });

  it("P3: a foreign row update does NOT clobber an in-progress edit", async () => {
    const mount = await mountCard("exec-laptop-zcode");
    await setName(mount, "work-in-progress");
    // A foreign PATCH lands underneath (SSE → invalidated registry row).
    const page = await mount.gateway.listExecutors();
    const bumped: ExecutorsPage = {
      ...page,
      items: page.items.map((row) =>
        row.id === "exec-laptop-zcode"
          ? { ...row, updated_at: "2026-12-01T00:00:00+00:00", version: "9.9.9" }
          : row,
      ),
    };
    await act(async () => {
      mount.queryClient.setQueryData(keys.agents.executors.list(), bumped);
    });
    // The form was NOT remounted: the in-progress name survives the update.
    const input = mount.query<HTMLInputElement>("input[maxlength='120']")[0];
    expect(input?.value).toBe("work-in-progress");
    mount.root.unmount();
  });

  it("the enabled kill-switch is its own single-field PATCH", async () => {
    const mount = await mountCard("exec-laptop-zcode");
    const spy = vi.spyOn(mount.gateway, "patchExecutor");
    const toggle = mount.query<HTMLInputElement>("input[type='checkbox']")[0];
    expect(toggle?.checked).toBe(true);
    await act(async () => {
      toggle!.click();
    });
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith("exec-laptop-zcode", { enabled: false });
    mount.root.unmount();
  });

  it("the SERVER's 409 duplicate-name text lands verbatim in the toast", async () => {
    const mount = await mountCard("exec-laptop-zcode");
    await setName(mount, "hermes@laptop");
    await clickButton(mount, "Save");
    await vi.waitFor(() => {
      expect(mount.text()).toContain("duplicate executor name: hermes@laptop");
    });
    mount.root.unmount();
  });
});

describe("ExecutorSheet — the revoked tombstone", () => {
  it("read-only everywhere except Delete; verdict says presence is gone", async () => {
    const mount = await mountCard("exec-copilot-revoked");
    const html = mount.text();
    // The honesty banner + the revoked verdict (auto-checked in the card).
    expect(html).toContain("read-only except Delete");
    expect(html).toContain("revoked — presence is gone");
    // Name input disabled, NO capability editor, NO save, NO revoke.
    const nameInput = mount.query<HTMLInputElement>("input[maxlength='120']")[0];
    expect(nameInput?.disabled).toBe(true);
    expect(html).not.toContain("New capability");
    expect(
      mount.query<HTMLButtonElement>("button").some((b) => b.textContent?.includes("Revoke")),
    ).toBe(false);
    expect(
      mount.query<HTMLButtonElement>("button").some((b) => b.textContent?.includes("Delete")),
    ).toBe(true);
    // The secret is NEVER rendered — only the honest hint about it.
    expect(html).toContain("The secret is never shown");
    expect(html).not.toMatch(/mne_[A-Za-z0-9]/);
    mount.root.unmount();
  });
});

describe("ExecutorSheet — AGW-11 paste-back approve (TOFU honesty)", () => {
  const hexPin =
    "3f2a9c1d5b7e40a68d93c1f0b2e4d6a8c0e2f4b6d8a0c2e4f60482a6c8e0d2f4";
  const tail = hexPin.slice(-8);

  it("a pending row WITH provision context demands the fingerprint tail", async () => {
    sessionStorage.setItem(
      "vesmaro.provision-approve.exec-copilot-pending",
      JSON.stringify({ fingerprint: hexPin, tofu: true, jobId: "pj-1" }),
    );
    const mount = await mountCard("exec-copilot-pending");
    // The pin is on screen (public material) + the verify input.
    expect(mount.text()).toContain(hexPin);
    expect(mount.text()).toContain("Last 8 hex chars");
    // The approve starts DISABLED — a partial/absent tail never approves.
    const approve = mount
      .query<HTMLButtonElement>("button")
      .find((candidate) => candidate.textContent?.includes("Approve"))!;
    expect(approve.disabled).toBe(true);
    mount.root.unmount();
  });

  it("the exact tail unlocks the approve; the click consumes the context", async () => {
    sessionStorage.setItem(
      "vesmaro.provision-approve.exec-copilot-pending",
      JSON.stringify({ fingerprint: hexPin, tofu: true, jobId: "pj-1" }),
    );
    const mount = await mountCard("exec-copilot-pending");
    const spy = vi.spyOn(mount.gateway, "patchExecutor");
    const input = mount.query<HTMLInputElement>("input[maxlength='8']")[0];
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      nativeSetter?.call(input, "deadbeef");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // A wrong tail keeps the gate shut.
    expect(
      mount
        .query<HTMLButtonElement>("button")
        .find((candidate) => candidate.textContent?.includes("Approve"))!.disabled,
    ).toBe(true);
    await act(async () => {
      nativeSetter?.call(input, tail);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickButton(mount, "Approve");
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith("exec-copilot-pending", { state: "approved" });
    });
    // The context is one-shot: consumed by the successful verify.
    expect(sessionStorage.getItem("vesmaro.provision-approve.exec-copilot-pending")).toBeNull();
    mount.root.unmount();
  });

  it("a pre-pinned fingerprint (tofu=false) is the plain approve — no re-verify", async () => {
    sessionStorage.setItem(
      "vesmaro.provision-approve.exec-copilot-pending",
      JSON.stringify({ fingerprint: hexPin, tofu: false, jobId: "pj-1" }),
    );
    const mount = await mountCard("exec-copilot-pending");
    expect(mount.text()).toContain(hexPin);
    expect(mount.text()).toContain("pinned and verified earlier");
    // No tail input on this path.
    expect(mount.query<HTMLInputElement>("input[maxlength='8']")).toHaveLength(0);
    const approve = mount
      .query<HTMLButtonElement>("button")
      .find((candidate) => candidate.textContent?.includes("Approve"))!;
    expect(approve.disabled).toBe(false);
    mount.root.unmount();
  });

  it("WITHOUT context (the manual mint path) the pending row keeps the plain approve", async () => {
    const mount = await mountCard("exec-copilot-pending");
    expect(mount.text()).not.toContain("Last 8 hex chars");
    const approve = mount
      .query<HTMLButtonElement>("button")
      .find((candidate) => candidate.textContent?.includes("Approve"))!;
    expect(approve.disabled).toBe(false);
    mount.root.unmount();
  });
});
