import { ApiError, toApiError } from "@/lib/errors";

/**
 * Shared fetch plumbing for the HTTP side of the gateway (HttpAdapter and
 * AuthClient). Centralised so every request gets the same treatment:
 * base-URL + query-string building, Bearer auth, timeout + external-abort
 * composition, and non-2xx → `ApiError` normalisation.
 */

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** Values allowed in a query-string map; null/undefined entries are dropped. */
export type QueryValue = string | number | boolean | null | undefined;

export interface RequestConfig {
  method?: HttpMethod;
  /** Query parameters — appended to the URL, null/undefined skipped. */
  query?: Record<string, QueryValue>;
  /** JSON request body — serialized automatically. */
  body?: unknown;
  /** External cancellation signal (e.g. TanStack Query hands one per query). */
  signal?: AbortSignal;
  /** Per-request timeout override. */
  timeoutMs?: number;
}

/**
 * Endpoint-level dependencies. Injected (rather than imported from auth.ts)
 * so this module stays dependency-free and tests can stub everything.
 */
export interface HttpEndpointOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** Current bearer token, when the caller wants authenticated requests. */
  getToken?: () => string | null;
  /** Invoked on any 401 so the app can raise its "unauthorized" flag. */
  onUnauthorized?: () => void;
  defaultTimeoutMs?: number;
}

/** Default per-request timeout. p95-conscious: FTS and reads are fast. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * Search timeout. Semantic search on mnemos runs 4–7 s at p95 — the budget
 * gets generous headroom instead of cutting off slow (but healthy) queries.
 */
export const SEARCH_TIMEOUT_MS = 30_000;

/** Join base URL, path and query map into a request URL. */
export function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, QueryValue>,
): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  let url = `${base}${path}`;
  if (query) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined) continue;
      search.set(key, String(value));
    }
    const qs = search.toString();
    if (qs.length > 0) url = `${url}?${qs}`;
  }
  return url;
}

/**
 * Perform one JSON request and normalise every failure into `ApiError`
 * (or rethrow the original abort when the *caller* cancelled).
 */
export async function requestJson<T>(
  endpoint: HttpEndpointOptions,
  path: string,
  config: RequestConfig = {},
): Promise<T> {
  const fetchImpl = endpoint.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? endpoint.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const url = buildUrl(endpoint.baseUrl, path, config.query);
  const headers: Record<string, string> = {};
  const token = endpoint.getToken?.();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (config.body !== undefined) headers["Content-Type"] = "application/json";

  // Compose two abort sources onto one controller: the timeout and the
  // caller's external signal. Whichever fires first wins.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  config.signal?.addEventListener("abort", onExternalAbort);

  try {
    const response = await fetchImpl(url, {
      method: config.method ?? "GET",
      headers,
      body: config.body === undefined ? undefined : JSON.stringify(config.body),
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 401) endpoint.onUnauthorized?.();
      const body = await response.text().catch(() => "");
      throw new ApiError(response.status, extractErrorMessage(response, body), {
        body: body || undefined,
        url,
      });
    }

    return (await response.json()) as T;
  } catch (error) {
    // Caller-initiated cancellation propagates untouched: TanStack Query
    // recognises the abort and silently drops the cancelled query.
    if (config.signal?.aborted) throw error;
    if (timedOut) {
      throw new ApiError(0, `Request to ${path} timed out after ${timeoutMs} ms`, {
        url,
        cause: error,
      });
    }
    throw toApiError(error);
  } finally {
    clearTimeout(timer);
    config.signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** Derive a human-readable message from an error response body. */
function extractErrorMessage(response: Response, body: string): string {
  const fallback = `${response.status} ${response.statusText || "Request failed"}`.trim();
  if (!body) return fallback;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "detail" in parsed) {
      const detail = (parsed as { detail: unknown }).detail;
      if (typeof detail === "string" && detail.length > 0) return detail;
      if (Array.isArray(detail)) {
        // FastAPI validation errors: [{loc, msg, type}, ...]
        const messages = detail
          .map((item) =>
            item && typeof item === "object" && "msg" in item
              ? String((item as { msg: unknown }).msg)
              : undefined,
          )
          .filter((msg): msg is string => Boolean(msg));
        if (messages.length > 0) return messages.join("; ");
      }
    }
  } catch {
    // Body was not JSON — fall through to truncation.
  }
  return body.length > 200 ? `${body.slice(0, 200)}…` : body;
}
