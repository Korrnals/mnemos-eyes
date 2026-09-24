import { act } from "react";

/**
 * ME-006 suite-hygiene helpers (test-only — never import from src/ code).
 *
 * The component tests mount with raw createRoot + act, while React Query
 * settlements, SSE frames and Radix presence transitions resolve on LATER
 * tasks. Plain `vi.waitFor` polling and bare `root.unmount()` then update
 * the tree outside any act() scope — hundreds of
 * "not wrapped in act(...)" warnings per full run. These helpers keep the
 * same polling ergonomics but inside act.
 */

/** Poll `assert` inside act until it passes (the act-wrapped vi.waitFor).
 * Like vi.waitFor, resolves to the callback's return value. */
export async function actWaitUntil<T>(
  assert: () => T | Promise<T>,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = new Error("actWaitUntil: assertion never passed");
  while (Date.now() < deadline) {
    try {
      return await assert();
    } catch (error) {
      lastError = error;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw lastError;
}

/** Unmount a root inside act (Radix portals flush presence cleanup). */
export async function actUnmount(root: { unmount: () => void }): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}

/** Flush pending tasks (mutations, SSE, presence) inside act. */
export async function actFlush(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}
