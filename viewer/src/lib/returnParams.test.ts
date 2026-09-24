import { describe, expect, it } from "vitest";

import {
  encodeReturn,
  resolveReturnTarget,
  withReturn,
} from "./returnParams";

/**
 * UI-18 spec §4 criteria 1+5 as unit gates: the round trip must survive the
 * double encoding (encodeURIComponent at build + URLSearchParams.get at read
 * — `project:gcw` is the spec's own probe), and every anti-open-redirect /
 * self-return shape must be silently rejected to the fallback (null).
 */

function read(returnValue: string): string | null {
  return resolveReturnTarget({
    searchParams: new URLSearchParams(`return=${returnValue}`),
    currentPathname: "/tasks/TB-1",
    currentSearch: "",
  });
}

function readFrom(source: string): string | null {
  // The full wire shape: encode the source, put it on a detail URL, read it
  // back through URLSearchParams — exactly what Link → useSearchParams does.
  const href = withReturn("/tasks/TB-1", source);
  const search = href.slice(href.indexOf("?"));
  return resolveReturnTarget({
    searchParams: new URLSearchParams(search),
    currentPathname: "/tasks/TB-1",
    currentSearch: "",
  });
}

describe("encodeReturn / withReturn (build, spec §2.2 rule 1)", () => {
  it("encodes the whole pathname+search as one opaque value", () => {
    expect(encodeReturn("/tasks", "?status=open&q=x")).toBe(
      "%2Ftasks%3Fstatus%3Dopen%26q%3Dx",
    );
  });

  it("carries project:gcw through the double encoding (spec criterion 1)", () => {
    const href = withReturn("/tasks/TB-1", "/memory/tags", "?tag=project:gcw");
    expect(href).toBe(
      "/tasks/TB-1?return=%2Fmemory%2Ftags%3Ftag%3Dproject%3Agcw",
    );
    // URLSearchParams.get decodes the transport layer exactly once:
    expect(new URLSearchParams(href.slice(href.indexOf("?"))).get("return")).toBe(
      "/memory/tags?tag=project:gcw",
    );
  });

  it("appends with & when the detail target already has a query", () => {
    expect(withReturn("/tasks/TB-1?tab=execution", "/agents/execution")).toBe(
      "/tasks/TB-1?tab=execution&return=%2Fagents%2Fexecution",
    );
  });

  it("keeps the archive offset inside the encoded source", () => {
    const href = withReturn("/tasks/RB-1", "/tasks/archive", "?q=&offset=50");
    expect(href).toContain("return=%2Ftasks%2Farchive%3Fq%3D%26offset%3D50");
  });
});

describe("resolveReturnTarget (read + validate, spec §2.2 rule 2)", () => {
  it("accepts a valid in-app source with its filters", () => {
    expect(readFrom("/tasks?status=open&priority=high")).toBe(
      "/tasks?status=open&priority=high",
    );
  });

  it("accepts a cross-domain source (tag drill → task)", () => {
    expect(readFrom("/memory/tags?tag=project:gcw")).toBe(
      "/memory/tags?tag=project:gcw",
    );
  });

  it("round-trips an encoded value built by encodeReturn directly", () => {
    expect(read(encodeReturn("/memory/search", "?q=mnemos&type=fts"))).toBe(
      "/memory/search?q=mnemos&type=fts",
    );
  });

  it("rejects an absent param (direct open → fallback)", () => {
    expect(
      resolveReturnTarget({
        searchParams: new URLSearchParams(""),
        currentPathname: "/tasks/TB-1",
        currentSearch: "",
      }),
    ).toBeNull();
  });

  it("rejects foreign schemas and protocol-relative hosts (anti-open-redirect)", () => {
    expect(read("https%3A%2F%2Fevil.example%2Fphish")).toBeNull();
    expect(read("%2F%2Fevil.example%2Fphish")).toBeNull();
    expect(read("evil.example%2Fphish")).toBeNull();
  });

  it("rejects backslash tricks", () => {
    expect(read("%2F%5Cevil")).toBeNull();
  });

  it("rejects paths outside the app routes (unknown prefix)", () => {
    expect(read("%2Fpair")).toBeNull();
    expect(read("%2Funknown%3Fx%3D1")).toBeNull();
  });

  it("rejects the self-return (current pathname+search, spec §2.3)", () => {
    expect(
      resolveReturnTarget({
        searchParams: new URLSearchParams(`return=${encodeReturn("/tasks/TB-1")}`),
        currentPathname: "/tasks/TB-1",
        currentSearch: "",
      }),
    ).toBeNull();
  });

  it("rejects the self-return including the current search", () => {
    const self = "/tasks/TB-1?tab=reports";
    expect(
      resolveReturnTarget({
        searchParams: new URLSearchParams(
          `tab=reports&return=${encodeReturn(self)}`,
        ),
        currentPathname: "/tasks/TB-1",
        currentSearch: "?tab=reports",
      }),
    ).toBeNull();
  });

  it("accepts the domain root as a target (fallback roots are valid)", () => {
    expect(read(encodeReturn("/memory"))).toBe("/memory");
    expect(read(encodeReturn("/"))).toBe("/");
  });
});
