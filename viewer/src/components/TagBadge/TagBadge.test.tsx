import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { TagBadge } from "./TagBadge";
import { tagVariant } from "@/components/memory/memoryBadges";

describe("TagBadge prefix → variant mapping (component-inventory §6)", () => {
  it.each([
    ["type:rule", "iris"],
    ["mnemos:decision", "iris"],
    ["confidence:high", "confidence"],
    ["status:error", "error"],
    ["project:gcw", "default"],
    ["agent:zed", "default"],
    ["topic:fts", "default"],
  ] as const)("%s → %s", (tag, expected) => {
    expect(tagVariant(tag)).toBe(expected);
  });

  it("renders a static badge without onClick and a button with it", () => {
    const plain = renderToString(<TagBadge tag="project:gcw" count={3} />);
    expect(plain).toContain("project:gcw");
    expect(plain).toContain("3");
    expect(plain).not.toContain("<button");

    const interactive = renderToString(
      <TagBadge tag="topic:fts" onClick={() => undefined} />,
    );
    expect(interactive).toContain("<button");
    expect(interactive).toContain('aria-label="Filter by tag topic:fts"');
  });
});
