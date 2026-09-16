/**
 * Normalised API error type for the whole viewer.
 *
 * `HttpAdapter` throws `ApiError` for any non-2xx response (architecture.md
 * §7); TanStack Query's retry policy (lib/queryClient.ts) branches on it.
 */
export class ApiError extends Error {
  /** HTTP status code (0 when the request never got a response). */
  readonly status: number;
  /** Raw response body, when one was received. */
  readonly body?: string;
  /** Request URL, when known. */
  readonly url?: string;

  constructor(
    status: number,
    message: string,
    options?: {
      body?: string;
      url?: string;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "ApiError";
    this.status = status;
    this.body = options?.body;
    this.url = options?.url;
  }
}

/** Type guard for `ApiError`. */
export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/**
 * Coerce any thrown value into an `Error`. Non-`Error` rejections (strings,
 * objects from fetch polyfills, abort reasons, ...) are wrapped so UI error
 * boundaries always receive a real `Error` with a message.
 */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (isAbortError(value)) return value;
  return new Error(typeof value === "string" ? value : JSON.stringify(value));
}

/**
 * Normalise any thrown value into an `ApiError`:
 * - `ApiError` passes through unchanged;
 * - `Error` with no status becomes status 0 (network/unknown failure);
 * - non-`Error` values are wrapped with a stringified message.
 */
export function toApiError(value: unknown): ApiError {
  if (isApiError(value)) return value;
  if (value instanceof Error) {
    return new ApiError(0, value.message, { cause: value });
  }
  const message = typeof value === "string" ? value : safeStringify(value);
  return new ApiError(0, message);
}

/** True when the error is worth retrying (network-level or 5xx). */
export function isRetryable(value: unknown): boolean {
  const error = toApiError(value);
  // Status 0 = request never completed (network drop, abort by cause).
  return error.status === 0 || error.status >= 500;
}

function isAbortError(value: unknown): value is DOMException {
  return (
    value instanceof DOMException &&
    (value.name === "AbortError" || value.name === "TimeoutError")
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
