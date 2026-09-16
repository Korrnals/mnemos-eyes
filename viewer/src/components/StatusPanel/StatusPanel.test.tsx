import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { StatusPanel } from "./StatusPanel";
import { MockAdapter } from "@/gateway/MockAdapter";

const HEALTH = { status: "ok", version: "4.1.0-mock", project: "mnemos-eyes" };

describe("StatusPanel", () => {
  it("renders honest counters from the mock metrics payload", async () => {
    const adapter = new MockAdapter({ latency: false });
    const metrics = await adapter.metrics();

    const html = renderToString(<StatusPanel health={HEALTH} metrics={metrics} />);
    expect(html).toContain("ok");
    expect(html).toContain("18"); // MOCK_MEMORIES.length
    expect(html).toContain("14"); // published count
    expect(html).toContain("not reported");
  });

  it("marks latency and DLQ as not reported when the payload lacks them", () => {
    const html = renderToString(
      <StatusPanel health={HEALTH} metrics={{ memories_total: 7 }} />,
    );
    expect(html).toContain("mnemos /metrics carries no latency");
    expect(html).toContain("no dlq key in /metrics");
    expect(html).toContain("7");
  });

  it("treats a missing health payload as unknown, not green", () => {
    const html = renderToString(<StatusPanel metrics={{}} />);
    expect(html).toContain("unknown");
  });
});
