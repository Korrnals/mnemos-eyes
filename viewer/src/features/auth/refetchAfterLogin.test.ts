import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import { ApiError } from "@/lib/errors";
import { refetchAfterLogin } from "./refetchAfterLogin";

/**
 * Deferred-request retry after a successful sign-in (T6 wiring): a query that
 * failed with 401 sits in error state (the retry policy never re-runs 4xx);
 * `refetchAfterLogin` must invalidate the cache so the observer refetches —
 * now authenticated — and resolves with data.
 *
 * Uses a real QueryClient + QueryObserver (no DOM needed): a subscribed
 * observer is an *active* query, exactly like the page hooks mounted under the
 * auth overlay in the app.
 */
describe("refetchAfterLogin", () => {
  it("retries a 401-errored active query once a session exists", async () => {
    // fetch-mock: everything is unauthorized until the "login" happens.
    let authenticated = false;
    const queryFn = vi.fn(() => {
      if (!authenticated) {
        return Promise.reject(new ApiError(401, "Session not found"));
      }
      return Promise.resolve([{ id: "mem-1", title: "first memory" }]);
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const observer = new QueryObserver(queryClient, {
      queryKey: ["memories", "list"],
      queryFn,
    });
    const unsubscribe = observer.subscribe(() => {});

    // The initial mount fetch lands on the 401 (same as a page behind a dead
    // session).
    await vi.waitFor(() => {
      expect(observer.getCurrentResult().error).toMatchObject<Partial<ApiError>>({
        status: 401,
      });
    });
    expect(observer.getCurrentResult().data).toBeUndefined();

    // Successful sign-in → invalidate → the active observer refetches.
    authenticated = true;
    await refetchAfterLogin(queryClient);

    expect(observer.getCurrentResult().error).toBeNull();
    expect(observer.getCurrentResult().data).toEqual([
      { id: "mem-1", title: "first memory" },
    ]);
    unsubscribe();
  });

  it("resolves even when the refetch fails again (pages surface their own errors)", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const observer = new QueryObserver(queryClient, {
      queryKey: ["status"],
      queryFn: () => Promise.reject(new ApiError(0, "offline")),
    });
    const unsubscribe = observer.subscribe(() => {});

    await vi.waitFor(() => {
      expect(observer.getCurrentResult().error).not.toBeNull();
    });

    // Must not reject — a failed retry is a page-level concern, not a crash.
    await expect(refetchAfterLogin(queryClient)).resolves.toBeUndefined();
    unsubscribe();
  });
});
