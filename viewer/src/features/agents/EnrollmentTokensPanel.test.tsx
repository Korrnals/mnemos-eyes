// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { EnrollmentTokensPanel } from "./EnrollmentTokensPanel";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";

/**
 * The enrollment panel's used-token row (AGW-6 B): once a token is USED the
 * minted executor EXISTS — the row then offers «Открыть карточку», the
 * #executor-sheet-<id> deep-link the registry page consumes into the
 * drawer. (At mint time no row exists, so the offer lives here, on the
 * persistent enrollment surface, not in the one-shot dialog.)
 */

import type { EnrollmentItem, ExecutorItem } from "@/gateway/boardTypes";
import { actUnmount } from "@/test/actTools";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const USED: EnrollmentItem = {
  enrollment_id: "enr-used-1",
  label: "vps-1",
  harness_hint: "zcode",
  name_hint: "",
  state: "used",
  created_at: "2026-09-19T08:00:00+00:00",
  expires_at: "2026-09-19T08:15:00+00:00",
  used_at: "2026-09-19T08:05:00+00:00",
  used_ip: "203.0.113.7",
  executor_id: "exec-minted-1",
};

const MINTED: ExecutorItem = {
  id: "exec-minted-1",
  name: "zcode@vps-1",
  harness: "zcode",
  host: "vps-1",
  transport: "local-poll",
  capabilities: [],
  version: "1.15.0",
  enabled: false,
  state: "pending",
  last_seen: "",
  presence: "offline",
  registered_via: "enrollment:enr-used-1",
  registered_at: "2026-09-19T08:05:00+00:00",
  updated_at: "2026-09-19T08:05:00+00:00",
};

async function mountPanel(
  enrollments: readonly EnrollmentItem[],
  executors: readonly ExecutorItem[],
): Promise<{ root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <GatewayContext.Provider value={new MockAdapter({ latency: false })}>
        <ToastProvider>
          <I18nProvider initialLang="en">
            <MemoryRouter>
              <UiTokenProvider>
                <QueryClientProvider client={new QueryClient()}>
                  <EnrollmentTokensPanel
                    enrollments={enrollments}
                    executors={executors}
                    tokenPresent
                    loading={false}
                    error={false}
                  />
                </QueryClientProvider>
              </UiTokenProvider>
            </MemoryRouter>
          </I18nProvider>
        </ToastProvider>
      </GatewayContext.Provider>,
    );
  });
  return { root };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("EnrollmentTokensPanel — the «Открыть карточку» deep-link (AGW-6 B)", () => {
  it("a used token whose executor EXISTS offers the settings-card deep-link", async () => {
    const { root } = await mountPanel([USED], [MINTED]);
    const link = document.body.querySelector<HTMLAnchorElement>(
      'a[href="/agents/harnesses#executor-sheet-exec-minted-1"]',
    );
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain("Settings card");
    // The existing registry-scroll link stays (rows may outlive the card).
    expect(
      document.body.querySelector('a[href="/agents/harnesses#executor-exec-minted-1"]'),
    ).not.toBeNull();
    await actUnmount(root);
  });

  it("no minted row in the registry yet → no card link (the id link suffices)", async () => {
    const { root } = await mountPanel([USED], []);
    expect(
      document.body.querySelector('a[href="/agents/harnesses#executor-sheet-exec-minted-1"]'),
    ).toBeNull();
    expect(document.body.textContent).toContain("exec-minted-1");
    await actUnmount(root);
  });

  it("live tokens offer nothing (no executor exists to inspect)", async () => {
    const live: EnrollmentItem = {
      ...USED,
      enrollment_id: "enr-live-1",
      state: "created",
      used_at: "",
      used_ip: "",
      executor_id: "",
    };
    const { root } = await mountPanel([live], []);
    expect(document.body.textContent).not.toContain("Settings card");
    await actUnmount(root);
  });
});
