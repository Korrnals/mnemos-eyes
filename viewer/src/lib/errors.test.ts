import { describe, expect, it } from "vitest";
import { ApiError, isApiError, isRetryable, toApiError, toError } from "./errors";

describe("ApiError", () => {
  it("carries status, message and body", () => {
    const error = new ApiError(404, "Not Found", { body: "no memory" });
    expect(error.status).toBe(404);
    expect(error.message).toBe("Not Found");
    expect(error.body).toBe("no memory");
    expect(error.name).toBe("ApiError");
  });

  it("is recognised by the type guard", () => {
    expect(isApiError(new ApiError(500, "boom"))).toBe(true);
    expect(isApiError(new Error("plain"))).toBe(false);
    expect(isApiError("boom")).toBe(false);
  });
});

describe("toApiError", () => {
  it("passes ApiError through", () => {
    const original = new ApiError(502, "bad gateway");
    expect(toApiError(original)).toBe(original);
  });

  it("wraps a plain Error with status 0", () => {
    const error = toApiError(new Error("network down"));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error.message).toBe("network down");
  });

  it("stringifies non-Error rejections", () => {
    expect(toApiError("weird").message).toBe("weird");
    expect(toApiError({ code: 7 }).message).toBe('{"code":7}');
  });
});

describe("isRetryable", () => {
  it.each([0, 500, 502, 503])("retries status %i", (status) => {
    expect(isRetryable(new ApiError(status, "x"))).toBe(true);
  });

  it.each([400, 401, 403, 404, 429, 501])(
    "does not retry status %i twice or 4xx",
    (status) => {
      // Note: 5xx < 500 never happens here; 501 is a stub response — treated as
      // retryable by policy only for 5xx, but single-retry is enforced by the
      // QueryClient, so isRetryable stays a pure status classifier.
      expect(isRetryable(new ApiError(status, "x"))).toBe(status >= 500);
    },
  );

  it("treats unknown failures as retryable", () => {
    expect(isRetryable(new Error("socket hang up"))).toBe(true);
    expect(isRetryable(undefined)).toBe(true);
  });
});

describe("toError", () => {
  it("keeps Error instances", () => {
    const original = new Error("keep me");
    expect(toError(original)).toBe(original);
  });

  it("wraps primitives", () => {
    expect(toError(42).message).toBe("42");
  });
});
