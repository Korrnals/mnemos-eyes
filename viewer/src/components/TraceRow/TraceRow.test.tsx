import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { TraceRow } from "./TraceRow";
import { MOCK_TRACES } from "@/gateway/fixtures";

describe("TraceRow (mock fixtures)", () => {
  it("renders label, status and human duration for a finished trace", () => {
    const html = renderToString(<TraceRow trace={MOCK_TRACES[0]} />);
    expect(html).toContain("trace-0187");
    expect(html).toContain("l1-t1-scaffold");
    expect(html).toContain("ok");
    expect(html).toContain("4m 12s");
  });

  it("keeps a running trace honest — no fabricated duration", () => {
    const html = renderToString(<TraceRow trace={MOCK_TRACES[3]} />);
    expect(html).toContain("running");
    expect(html).toContain("—");
  });

  it("exposes raw JSON through a native details element", () => {
    const html = renderToString(<TraceRow trace={MOCK_TRACES[0]} />);
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    // The inlined JSON carries the raw pipeline steps.
    expect(html).toContain("&quot;stage&quot;");
  });
});
