import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AssignmentItem, ExecutorItem } from "@/gateway/boardTypes";
import { MOCK_ASSIGNMENTS, MOCK_EXECUTORS } from "@/gateway/boardFixtures";

/**
 * The secret/snapshot exclusion contract (spec §6: «claim_token/spec_snapshot
 * исключены из REST-представления UI — тест на сгенерированной схеме»).
 * Three layers:
 * 1. the GENERATED schema file — the `AssignmentOut` wire row must not even
 *    declare the fields (codegen drift fails here first);
 * 2. the UI wire types — a compile-time assertion (this file typechecks in
 *    `npm run typecheck`; a reintroduced field breaks the build);
 * 3. the fixtures/mock corpus — no mock row may smuggle them into renders.
 */

const SCHEMA_PATH = fileURLToPath(
  new URL("../../types/board-openapi.d.ts", import.meta.url),
);

/** Slice one schema block out of the generated file (name → body). */
function schemaBlock(name: string): string {
  const text = readFileSync(SCHEMA_PATH, "utf-8");
  const start = text.indexOf(`readonly ${name}: {`);
  expect(start, `schema ${name} exists in the generated file`).toBeGreaterThan(-1);
  // Schema names sit at one fixed indent; inner fields sit deeper — the next
  // same-indent `readonly Name: {` marks the boundary.
  const tail = text.slice(start + 1);
  const boundary = tail.search(/\n {8}readonly [A-Z]\w*: \{/);
  return boundary === -1 ? tail : tail.slice(0, boundary);
}

describe("secret/snapshot exclusion — generated schema (spec §6)", () => {
  it("AssignmentOut declares neither claim_token nor spec_snapshot", () => {
    const block = schemaBlock("AssignmentOut");
    expect(block).not.toContain("claim_token");
    expect(block).not.toContain("spec_snapshot");
    // The fingerprint DOES travel — exclusion is precise, not blanket.
    expect(block).toContain("spec_hash");
  });

  it("ExecutorOut declares neither secret_hash nor executor_secret", () => {
    const block = schemaBlock("ExecutorOut");
    expect(block).not.toContain("secret_hash");
    expect(block).not.toContain("executor_secret");
  });
});

describe("secret/snapshot exclusion — UI types and fixtures", () => {
  it("the UI wire types cannot even express the excluded fields (typecheck gate)", () => {
    // Compile-time: Extract yields never while the keys stay absent — if
    // someone reintroduces them in boardTypes, these lines stop compiling.
    type AbsentFromAssignment = Extract<keyof AssignmentItem, "claim_token" | "spec_snapshot">;
    type AbsentFromExecutor = Extract<keyof ExecutorItem, "secret_hash" | "executor_secret">;
    const assignmentCheck: AbsentFromAssignment[] = [];
    const executorCheck: AbsentFromExecutor[] = [];
    expect(assignmentCheck).toHaveLength(0);
    expect(executorCheck).toHaveLength(0);
  });

  it("no fixture row smuggles the excluded fields into a render", () => {
    const assignmentJson = JSON.stringify(MOCK_ASSIGNMENTS);
    expect(assignmentJson).not.toContain("claim_token");
    expect(assignmentJson).not.toContain("spec_snapshot");
    const executorJson = JSON.stringify(MOCK_EXECUTORS);
    expect(executorJson).not.toContain("secret_hash");
    expect(executorJson).not.toContain("executor_secret");
  });
});
