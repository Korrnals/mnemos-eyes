import { describe, expect, it } from "vitest";
import { KoraMockAdapter, KoraMockError } from "./KoraMockAdapter";

/**
 * Mock-adapter behaviour = the frozen contract semantics (ADR 0019 rev.2):
 * seq-cursor paging, store-tail growth after a send, the step-up gate and
 * the honest 404 for foreign sessions. These are the interactions the UI
 * mocks exercise, so the mock must model them faithfully.
 */

const RELAY = "exec-zcode-main:sess_7f3a91";
const LOCAL = "exec-vscode-lab:a83f1c22";

function adapter(stepUp = false) {
  return new KoraMockAdapter({ latency: false, stepUpActive: stepUp });
}

describe("KoraMockAdapter — list & coverage (slice 1)", () => {
  it("lists fixture sessions with the coverage block", async () => {
    const list = await adapter().listSessions();
    expect(list.ok).toBe(true);
    expect(list.count).toBe(list.items.length);
    expect(list.items.every((s) => s.executor_id && s.native_id)).toBe(true);
    // The coverage screen data rides the listing (rev.2 #7).
    expect(list.coverage.harnesses.length).toBeGreaterThan(0);
    expect(list.coverage.gaps.length).toBeGreaterThan(0);
  });

  it("exposes the registry PK pair on every row", async () => {
    const list = await adapter().listSessions();
    for (const s of list.items) {
      expect(s.id).toContain(s.executor_id);
      expect(s.id).toContain(s.native_id);
    }
  });
});

describe("KoraMockAdapter — transcript cursor (slice 2)", () => {
  it("pages by seq cursor: after_seq excludes seen entries", async () => {
    const a = adapter();
    const page1 = await a.getTranscript(RELAY, { after_seq: 0, limit: 2 });
    expect(page1.items.map((i) => i.seq)).toEqual([1, 2]);
    expect(page1.has_more).toBe(true);
    expect(page1.next_after_seq).toBe(2);
    const page2 = await a.getTranscript(RELAY, {
      after_seq: page1.next_after_seq,
      limit: 2,
    });
    expect(page2.items.every((i) => i.seq > 2)).toBe(true);
  });

  it("keeps the cursor stable on an exhausted tail", async () => {
    const a = adapter();
    const full = await a.getTranscript(RELAY, { after_seq: 0, limit: 200 });
    const tail = await a.getTranscript(RELAY, {
      after_seq: full.next_after_seq,
    });
    expect(tail.items).toEqual([]);
    expect(tail.has_more).toBe(false);
    expect(tail.next_after_seq).toBe(full.next_after_seq);
  });

  it("throws the 404-shaped error for an unknown session", async () => {
    await expect(adapter().getTranscript("nope:unknown")).rejects.toMatchObject({
      name: "KoraMockError",
      code: "session_not_found",
    });
  });
});

describe("KoraMockAdapter — chat v1 store-tail (slice 3)", () => {
  it("step-up gate: sends are refused while steering is locked", async () => {
    const a = adapter(false);
    await expect(a.sendMessage(RELAY, "привет")).rejects.toMatchObject({
      code: "step_up_required",
    });
  });

  it("enableStepUp opens the window (PIN), revoke closes it", async () => {
    const a = adapter(false);
    await expect(a.enableStepUp("0000")).rejects.toMatchObject({
      code: "step_up_denied",
    });
    const granted = await a.enableStepUp("4321");
    expect(granted.active).toBe(true);
    expect(granted.ttl_remaining_seconds).toBeLessThanOrEqual(900);
    await a.revokeStepUp();
    expect((await a.stepUpStatus()).active).toBe(false);
  });

  it("send appends to the STORE and the tail re-read sees it", async () => {
    const a = adapter(true);
    const before = await a.getTranscript(RELAY, { after_seq: 0 });
    const accepted = await a.sendMessage(RELAY, "добавь anti-write кейс");
    expect(accepted.ok).toBe(true);
    expect(accepted.confirm_required).toBe(true); // confirm-mode default
    const after = await a.getTranscript(RELAY, { after_seq: 0 });
    // Store-tail semantics: the SAME cursor GET observes the new entries.
    expect(after.items.length).toBeGreaterThan(before.items.length);
    const fresh = await a.getTranscript(RELAY, {
      after_seq: before.next_after_seq,
    });
    expect(fresh.items[0]?.content).toBe("добавь anti-write кейс");
  });

  it("new relay session is relay-origin + steerable from birth", async () => {
    const a = adapter(true);
    const created = await a.createSession({
      executor_id: "exec-zcode-main",
      project: "kora-demo",
      prompt: "стартуем",
    });
    expect(created.session.origin).toBe("relay");
    expect(created.session.steerable).toBe(true);
    const tail = await a.getTranscript(created.session.id);
    expect(tail.items).toHaveLength(1);
    expect(tail.items[0]?.role).toBe("user");
  });

  it("foreign/unsteerable sessions resolve as 404 on the send path", async () => {
    const a = adapter(true);
    await expect(a.sendMessage(LOCAL, "рулить")).rejects.toMatchObject({
      code: "session_not_found",
    });
    await expect(a.sendMessage("nope:x", "рулить")).rejects.toBeInstanceOf(
      KoraMockError,
    );
  });
});
