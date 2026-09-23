import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PROVISION_CONNECTIVITY_INTERIM,
  fingerprintHex,
  isProvisionLive,
  isTofuPin,
  parseSteps,
  pasteBackMatches,
  provisionErrorHint,
  provisionFunnel,
} from "./provisionTypes";

/**
 * The connect-card view-helpers (AGW-11): the typed-hint table, the
 * data-driven funnel, the fingerprint paste-back math. Pure node tests —
 * the happy-dom integration lives in ProvisionCard.test.tsx.
 */

/** A canonical ssh-keygen fingerprint of a known digest (43 chars b64). */
function canonicalFp(data: string): string {
  return `SHA256:${createHash("sha256").update(data).digest("base64").replace(/=+$/, "")}`;
}

function hex64(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("provisionErrorHint — the typed-code table", () => {
  it("maps every Архком-8 code to its human hint", () => {
    expect(provisionErrorHint("ssh.unreachable").titleKey).toBe(
      "agents.provision.hint.sshUnreachable",
    );
    // The brief's legacy spelling maps to the same text (one table).
    expect(provisionErrorHint("ssh.timeout").titleKey).toBe(
      "agents.provision.hint.sshUnreachable",
    );
    expect(provisionErrorHint("ssh.auth_failed").titleKey).toBe(
      "agents.provision.hint.sshAuthFailed",
    );
    expect(provisionErrorHint("ssh.sudo_required").titleKey).toBe(
      "agents.provision.hint.sshSudoRequired",
    );
    expect(provisionErrorHint("ca.unavailable").titleKey).toBe(
      "agents.provision.hint.caUnavailable",
    );
    expect(provisionErrorHint("register.timeout").titleKey).toBe(
      "agents.provision.hint.registerTimeout",
    );
    expect(provisionErrorHint("provisioner.restarted").titleKey).toBe(
      "agents.provision.hint.restarted",
    );
    expect(provisionErrorHint("pin.invalidated").titleKey).toBe(
      "agents.provision.hint.pinInvalidated",
    );
  });

  it("host_key_mismatch is the ONE code that shows the expected fingerprint", () => {
    const hint = provisionErrorHint("host_key_mismatch");
    expect(hint.titleKey).toBe("agents.provision.hint.hostKeyMismatch");
    expect(hint.showExpectedFingerprint).toBe(true);
    // No other known code carries the technical block.
    expect(provisionErrorHint("ssh.auth_failed").showExpectedFingerprint).toBeUndefined();
  });

  it("wg.* placeholder codes are wired (future transport legs)", () => {
    expect(provisionErrorHint("wg.key_delivery_failed").titleKey).toBe(
      "agents.provision.hint.wgKeyDelivery",
    );
    expect(provisionErrorHint("wg.handshake_timeout").titleKey).toBe(
      "agents.provision.hint.wgHandshake",
    );
  });

  it("bootstrap.exit.N folds into one branch; unknown codes stay generic", () => {
    expect(provisionErrorHint("bootstrap.exit.2").titleKey).toBe(
      "agents.provision.hint.bootstrapExit",
    );
    expect(provisionErrorHint("something.new").titleKey).toBe(
      "agents.provision.hint.generic",
    );
  });
});

describe("provisionFunnel — the data-driven install funnel", () => {
  it("a queued job: the first stage is current, the mesh stage reserved", () => {
    const stages = provisionFunnel({
      state: "queued",
      host_key_fingerprint: "",
      steps: [],
    });
    expect(stages.map((stage) => stage.status)).toEqual([
      "current",
      "pending",
      "pending",
      "pending",
      "reserved",
    ]);
    expect(stages[4].def.id).toBe("wg_handshake_ok");
  });

  it("connecting reaches bootstrap_started; TOFU pin reaches ca_pinned", () => {
    const connecting = provisionFunnel({
      state: "connecting",
      host_key_fingerprint: "",
      steps: ["ssh connect vps-1:22"],
    });
    expect(connecting[0].status).toBe("done");
    expect(connecting[1].status).toBe("current");

    const pinned = provisionFunnel({
      state: "installing",
      host_key_fingerprint: canonicalFp("key"),
      steps: ["ssh connect vps-1:22", "host key pinned (TOFU): SHA256:x"],
    });
    expect(pinned[1].status).toBe("done");
    expect(pinned[2].status).toBe("current");
  });

  it("done reaches first_heartbeat (the registration IS the first beat)", () => {
    const stages = provisionFunnel({
      state: "done",
      host_key_fingerprint: canonicalFp("key"),
      steps: ["..."],
    });
    expect(stages.slice(0, 4).every((stage) => stage.status === "done")).toBe(true);
    expect(stages[4].status).toBe("reserved");
  });

  it("a failed job keeps the stages it reached — the current one is where it died", () => {
    const stages = provisionFunnel({
      state: "failed",
      host_key_fingerprint: canonicalFp("key"),
      steps: ["ssh connect vps-1:22", "host key pinned (TOFU): SHA256:x"],
    });
    expect(stages[0].status).toBe("done");
    expect(stages[1].status).toBe("done");
    expect(stages[2].status).toBe("current");
  });
});

describe("fingerprint helpers — the paste-back math", () => {
  const fp = canonicalFp("host-key-blob");
  const hex = hex64("host-key-blob");

  it("decodes the canonical base64 pin to its hex digest", () => {
    expect(fingerprintHex(fp)).toBe(hex);
  });

  it("accepts a hex64 pin as-is (lowercased)", () => {
    expect(fingerprintHex(hex.toUpperCase())).toBe(hex);
  });

  it("rejects malformed pins", () => {
    expect(fingerprintHex("SHA256:!!!")).toBeNull();
    expect(fingerprintHex("")).toBeNull();
    expect(fingerprintHex("md5:deadbeef")).toBeNull();
  });

  it("the verify unlocks ONLY on the exact last-8-hex tail", () => {
    const tail = hex.slice(-8);
    expect(pasteBackMatches(fp, tail)).toBe(true);
    // Case-insensitive + padded input is honest input.
    expect(pasteBackMatches(fp, tail.toUpperCase())).toBe(true);
    expect(pasteBackMatches(fp, `  ${tail}  `)).toBe(true);
    // Anything else never approves.
    expect(pasteBackMatches(fp, tail.slice(0, 7))).toBe(false);
    expect(pasteBackMatches(fp, "zzzzzzzz")).toBe(false);
    expect(pasteBackMatches(fp, "")).toBe(false);
    expect(pasteBackMatches(fp, hex.slice(0, 8))).toBe(false);
  });

  it("isTofuPin: the pin is NEW only when this job's TOFU wrote the trace", () => {
    expect(
      isTofuPin({
        state: "done",
        host_key_fingerprint: fp,
        steps: ["host key pinned (TOFU): " + fp],
      }),
    ).toBe(true);
    // Pre-pinned (strict mode / an earlier TOFU): no trace in THIS job.
    expect(
      isTofuPin({ state: "done", host_key_fingerprint: fp, steps: ["ssh connect"] }),
    ).toBe(false);
    expect(isTofuPin({ state: "done", host_key_fingerprint: "", steps: [] })).toBe(false);
  });
});

describe("steps + state helpers", () => {
  it("parseSteps flattens the JSON column defensively", () => {
    expect(parseSteps('["a","b"]')).toEqual(["a", "b"]);
    expect(parseSteps("")).toEqual([]);
    expect(parseSteps("{not json")).toEqual([]);
    expect(parseSteps('{"a":1}')).toEqual([]);
  });

  it("isProvisionLive: terminal verdicts stop the poll", () => {
    expect(isProvisionLive("queued")).toBe(true);
    expect(isProvisionLive("watching")).toBe(true);
    expect(isProvisionLive("done")).toBe(false);
    expect(isProvisionLive("failed")).toBe(false);
  });
});

describe("the interim connectivity slot (§5 honesty)", () => {
  it("the slot is manual-tunnel with a reserved profile until Ф2mesh", () => {
    expect(PROVISION_CONNECTIVITY_INTERIM.kind).toBe("manual-tunnel");
    expect(PROVISION_CONNECTIVITY_INTERIM.profile).toBeNull();
  });
});
