import type { QueryClient } from "@tanstack/react-query";

/**
 * Retry every deferred data query after a successful sign-in (T6 wiring).
 *
 * Queries that failed with 401 stay in error state — the retry policy
 * (lib/queryClient.ts) never re-runs 4xx failures — so without this call the
 * pages behind the overlay would keep showing their error states even after a
 * valid session exists. Invalidating the whole cache marks every query stale
 * and refetches the active ones, which now carry the fresh bearer token
 * (http.ts reads it per-request via the token provider). Inactive queries are
 * only marked stale and refetch on their next mount.
 */
export function refetchAfterLogin(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries().then(
    () => undefined,
    () => undefined, // individual refetch failures surface on the pages themselves
  );
}
