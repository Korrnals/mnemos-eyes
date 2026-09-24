// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ExecutionFeedPanel } from "./ExecutionFeedPanel";
import { parseBoardEvent } from "@/gateway/events";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { I18nProvider } from "@/i18n";
import { FEED_CAP, pushExecutionEvent, resetFeedStore } from "./executionFeedStore";
import { actUnmount } from "@/test/actTools";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * AGW-3 review P2-2 — the saturation regression: once the ring buffer
 * holds FEED_CAP rows, its LENGTH stops growing, so length-based novelty
 * detection would silently kill the flash-fade and the aloud terminal
 * announcements FOREVER. The panel detects new rows by the numeric seq —
 * after saturation a fresh terminal row must still flash AND speak.
 */

const RECEIVED = Date.parse("2026-09-19T09:00:00+00:00");

function pushWire(payload: unknown, at: number): void {
  const parsed = parseBoardEvent(JSON.stringify(payload));
  if (parsed.status !== "event") throw new Error("bad fixture");
  pushExecutionEvent(parsed.event, at);
}

async function mountPanel(): Promise<Root> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <GatewayContext.Provider value={new MockAdapter({ latency: false })}>
        <QueryClientProvider client={new QueryClient()}>
          <I18nProvider initialLang="en">
            <MemoryRouter>
              <ExecutionFeedPanel />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
  return root;
}

function openPanel(): void {
  const toggle = [...document.querySelectorAll("button")].find((button) =>
    (button.textContent ?? "").includes("Execution feed"),
  );
  act(() => {
    toggle?.click();
  });
}

afterEach(() => {
  resetFeedStore();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("feed panel — novelty by SEQ, not length (P2-2 saturation regression)", () => {
  it("a fresh terminal row still flashes AND goes aloud after the buffer saturates", async () => {
    vi.useFakeTimers();
    const root = await mountPanel();

    // Saturate the ring: FEED_CAP + a few, one per second — INSIDE act so
    // the panel's store-subscription effect flushes on every emit.
    await act(async () => {
      for (let index = 0; index < FEED_CAP + 5; index += 1) {
        pushWire(
          {
            kind: "assignment.created",
            task_id: `TB-${index}`,
            assignment: { id: String(index), state: "queued", created_by: "owner" },
          },
          RECEIVED + index * 1000,
        );
      }
    });
    openPanel();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500); // past FRESH_MS
    });

    const rowsBefore = document.querySelectorAll("li").length;
    expect(rowsBefore).toBe(FEED_CAP); // saturated — the length is frozen

    // The NEW row: a terminal transition AFTER saturation. ME-006: the push
    // notifies store subscribers synchronously — wrap it in act.
    await act(async () => {
      pushWire(
        {
          kind: "assignment.done",
          task_id: "TB-NEW",
          assignment: { id: "999", state: "done", claimed_by: "z:l", created_by: "o" },
        },
        RECEIVED + (FEED_CAP + 6) * 1000,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Length is STILL FEED_CAP (the oldest was evicted) — yet the new row
    // must carry the fresh-flash class and the aloud region must speak it.
    expect(document.querySelectorAll("li").length).toBe(FEED_CAP);
    const fresh = document.querySelector("li.bg-iris\\/10");
    expect(fresh).not.toBeNull(); // the flash lives past saturation
    expect(fresh?.textContent).toContain("TB-NEW");
    const aloud = document.querySelector("p[aria-live='polite']");
    expect(aloud?.textContent).toContain("TB-NEW"); // the announcement too

    // And the flash clears after FRESH_MS (colour-only fade, rows stay).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(document.querySelector("li.bg-iris\\/10")).toBeNull();

    await actUnmount(root);
  });
});