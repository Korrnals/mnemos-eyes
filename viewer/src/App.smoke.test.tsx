import { describe, expect, it } from "vitest";
import App from "./App";

/**
 * T1 scaffold smoke test: the module graph of the app root resolves and the
 * default export is a React component function. Rendering/interaction tests
 * arrive with T5 (Testing Library) — see docs/sessions/SESSION-01-l1-viewer.md.
 */
describe("App (smoke)", () => {
  it("is defined and is a function component", () => {
    expect(App).toBeDefined();
    expect(typeof App).toBe("function");
  });
});
