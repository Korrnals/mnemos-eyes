// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

import { ExecutorStrip } from "./ExecutorStrip";
import { I18nProvider } from "@/i18n";
import type { AssignmentItem, ExecutorItem, ExecutorListMeta } from "@/gateway/boardTypes";

/**
 * ExecutorStrip review fixes (AGW-3 P3): loading/error show their own
 * honest states (never the poller empty hint); unknown presence (no meta)
 * renders NEUTRAL — «присутствие неизвестно», never a guessed offline;
 * the tooltip carries the declared CAPABILITIES (§3.2), transport, pulse
 * age and the unverified note.
 */

const META: ExecutorListMeta = {
  presence: { online_max_age_s: 120, stale_max_age_s: 600 },
  sweeper_interval_s: 60,
};

const NOW = Date.now();
const ago = (seconds: number): string => new Date(NOW - seconds * 1000).toISOString();

function executor(overrides: Partial<ExecutorItem>): ExecutorItem {
  return {
    id: "exec-x",
    name: "zcode@laptop",
    harness: "zcode",
    host: "",
    transport: "local-poll",
    capabilities: ["@GCW: Senior Frontend Developer"],
    version: "",
    enabled: true,
    state: "approved",
    last_seen: ago(30),
    presence: "online",
    registered_at: "",
    updated_at: "",
    ...overrides,
  };
}

const ROWS: AssignmentItem[] = [];

async function mountStrip(props: {
  executors: readonly ExecutorItem[];
  meta?: ExecutorListMeta;
  loading?: boolean;
  error?: boolean;
}): Promise<Root> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider initialLang="en">
        <MemoryRouter>
          <ExecutorStrip
            executors={props.executors}
            meta={props.meta}
            assignments={ROWS}
            selectedId={null}
            onSelect={() => undefined}
            loading={props.loading}
            error={props.error}
          />
        </MemoryRouter>
      </I18nProvider>,
    );
  });
  return root;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ExecutorStrip — loading/error are NOT the empty state (P3-4)", () => {
  it("loading renders a status skeleton, no poller hint", async () => {
    const root = await mountStrip({ executors: [], loading: true });
    expect(document.body.textContent).not.toContain("No executors connected");
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    root.unmount();
  });

  it("error renders an alert line, no poller hint", async () => {
    const root = await mountStrip({ executors: [], error: true });
    expect(document.body.textContent).toContain("Failed to load the executor registry");
    expect(document.body.textContent).not.toContain("No executors connected");
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    root.unmount();
  });
});

describe("ExecutorStrip — unknown presence is NOT offline (P3-1)", () => {
  it("no meta → neutral chip with the unknown SR label, no age guess", async () => {
    const root = await mountStrip({ executors: [executor({})], meta: undefined });
    expect(document.body.textContent).toContain("presence unknown");
    // The mono age line stays empty — presence.ts promised null without meta.
    expect(document.body.textContent).not.toContain("offline");
    root.unmount();
  });

  it("with meta the same executor classifies online (the contract works)", async () => {
    const root = await mountStrip({ executors: [executor({})], meta: META });
    expect(document.body.textContent).toContain("online");
    root.unmount();
  });
});

describe("ExecutorStrip — tooltip carries capabilities (P3-2, §3.2)", () => {
  it("the chip title lists capabilities · transport · last seen · unverified", async () => {
    const root = await mountStrip({ executors: [executor({})], meta: META });
    const chip = document.querySelector<HTMLButtonElement>("button[title]");
    expect(chip).not.toBeNull();
    const title = chip?.getAttribute("title") ?? "";
    expect(title).toContain("@GCW: Senior Frontend Developer"); // capabilities (§3.2)
    expect(title).toContain("local"); // the transport marker (localized)
    expect(title).toContain("last seen");
    expect(title).toContain("never verified by the server");
    root.unmount();
  });

  it("an executor with no capabilities says so honestly", async () => {
    const root = await mountStrip({
      executors: [executor({ capabilities: [], id: "exec-bare", name: "zcode@old" })],
      meta: META,
    });
    const chip = document.querySelector<HTMLButtonElement>("button[title]");
    expect(chip?.getAttribute("title")).toContain("no capabilities declared");
    root.unmount();
  });
});