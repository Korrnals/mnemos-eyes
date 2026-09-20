"""ARCH-5 (ADR 0009 phase 2): assignment poller — dispatcher, envelope,
recovery sweep, supervision.

Coverage map (AC):
- envelope render: every ADR 0009 §5 block present, AC verbatim, header
  shape, spec snapshot (A2) — never the live spec, machine token absent
  by construction (the renderer never receives it);
- allowlist (A3): known (harness, specialist) resolves, unknown → skip +
  log + ONE refusal report, assignment stays queued (fail-closed);
- recovery sweep: own claimed|running without a live local pid → fail
  (claimed_by match), foreign records untouched, orphan pid killed;
- supervision mapping: exit 0 + agent final → complete WITHOUT
  final_report; exit 0 silent → complete with the fallback final;
  exit ≠0 → fail with `process exit N: <stderr tail>`;
- heartbeat: 409 → child killed, no terminal board call (server already
  moved on); ok → tick recorded;
- BoardClient wire format against httpx.MockTransport (exact paths,
  bearer header, 409 → BoardConflict);
- singleton flock; main() fail-closed without VESMARO_BOARD_TOKEN.

The board double (FakeBoard) mirrors the live phase-1 contract from
tests/test_api_assignments.py; subprocesses are real (sys.executable).
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from scripts.assignment_poller import (
    FINISH_RETRIES,
    KILL_GRACE_SECONDS,
    MAX_CONCURRENT_DEFAULT,
    FALLBACK_FINAL_REPORT,
    SWEEP_FAIL_REASON,
    AllowlistEntry,
    AssignmentPoller,
    AuditLog,
    BoardClient,
    BoardConflict,
    BoardError,
    ConfigError,
    PollerConfig,
    _fence,
    _terminate,
    acquire_singleton_lock,
    main,
    render_envelope,
)

ROOT = Path(__file__).resolve().parents[1]

EXIT_OK_CMD = [sys.executable, "-c", "pass"]
EXIT_1_CMD = [sys.executable, "-c",
              "import sys; print('boom', file=sys.stderr); sys.exit(1)"]
SLEEP_CMD = [sys.executable, "-c", "import time; time.sleep(30)"]
# Ignores SIGTERM: only the SIGKILL escalation can stop it (AB-FU-1).
STUBBORN_CMD = [sys.executable, "-c",
                "import signal, time; "
                "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                "time.sleep(60)"]


# ----------------------------------------------------------------- fakes
class FakeBoard:
    """In-memory double of the phase-1 assignment API surface. Mirrors the
    real state machine (CAS claim, fail auth via token OR claimed_by)."""

    def __init__(self):
        self.assignments: dict[int, dict] = {}
        self.tokens: dict[int, str] = {}
        self.reports: dict[str, list[dict]] = {}
        self._next_report = 1
        self.calls: list[tuple] = []
        self.heartbeat_conflict: set[int] = set()
        self.start_errors: set[int] = set()
        # AB-FU-1 finish-retry doubles: persistent 5xx vs countdown hiccups.
        self.complete_errors: set[int] = set()
        self.complete_flaky: dict[int, int] = {}
        self.fail_errors: set[int] = set()
        self.fail_flaky: dict[int, int] = {}

    # -- helpers for test arrangement -------------------------------------
    def add_assignment(self, aid: int, *, task_id="t-1", specialist="gcw-tester",
                       harness="zcode", state="queued", claimed_by=None,
                       executor_id="", snapshot="Goal: сделать.\n\n"
                       "Acceptance criteria:\n— [ ] первый\n— [ ] второй\n\n"
                       "Depends on: ничего.\n\nКонтекст: прочее."):
        spec_hash = f"hash-{aid:064d}"[-64:]
        self.assignments[aid] = {
            "id": aid, "task_id": task_id, "specialist": specialist,
            "harness": harness, "state": state, "created_by": "owner",
            "claimed_by": claimed_by, "note": "", "spec_hash": spec_hash,
            "executor_id": executor_id, "claimed_by_executor": "",
            "created_at": "2026-09-19T00:00:00+00:00",
            "spec_snapshot": snapshot,
        }
        return self.assignments[aid]

    def _public(self, a: dict, *, snapshot=False) -> dict:
        out = {k: v for k, v in a.items() if k != "spec_snapshot"}
        if snapshot:
            out["spec_snapshot"] = a["spec_snapshot"]
        return out

    def _add_report(self, task_id: str, kind: str, body: str, agent: str):
        rep = {"id": self._next_report, "task_id": task_id, "kind": kind,
               "agent": agent, "body": body, "superseded": False,
               "created_at": "2026-09-19T00:00:01+00:00"}
        self._next_report += 1
        self.reports.setdefault(task_id, []).append(rep)
        return rep

    # -- BoardClient surface ------------------------------------------------
    def list_assignments(self, state: str):
        self.calls.append(("list", state))
        return [self._public(a) for a in self.assignments.values()
                if a["state"] == state]

    def claim(self, assignment_id: int, claimed_by: str, executor_id: str = ""):
        self.calls.append(("claim", assignment_id, claimed_by, executor_id))
        a = self.assignments[assignment_id]
        if a["state"] != "queued":
            raise BoardConflict(409, "claim", "not queued")
        a["state"], a["claimed_by"] = "claimed", claimed_by
        a["claimed_by_executor"] = executor_id
        token = f"tok-{assignment_id:08d}"
        self.tokens[assignment_id] = token
        return self._public(a, snapshot=True), token

    def start(self, assignment_id: int, claim_token: str):
        self.calls.append(("start", assignment_id, claim_token))
        a = self.assignments[assignment_id]
        if assignment_id in self.start_errors:
            raise BoardError(500, "start", "server hiccup")
        if self.tokens.get(assignment_id) != claim_token:
            raise BoardError(403, "start", "token mismatch")
        if a["state"] != "claimed":
            raise BoardConflict(409, "start", f"is {a['state']}")
        a["state"] = "running"
        return self._public(a)

    def heartbeat(self, assignment_id: int, claim_token: str, note: str = ""):
        self.calls.append(("heartbeat", assignment_id, note))
        if assignment_id in self.heartbeat_conflict:
            raise BoardConflict(409, "heartbeat", "expected running")
        a = self.assignments[assignment_id]
        if a["state"] != "running":
            raise BoardConflict(409, "heartbeat", f"is {a['state']}")

    def complete(self, assignment_id: int, claim_token: str,
                 final_report: str = ""):
        self.calls.append(("complete", assignment_id, final_report))
        a = self.assignments[assignment_id]
        if assignment_id in self.complete_errors \
                or self.complete_flaky.get(assignment_id, 0) > 0:
            if assignment_id in self.complete_flaky:
                self.complete_flaky[assignment_id] -= 1
            raise BoardError(500, "complete", "board down")
        if a["state"] != "running":
            raise BoardConflict(409, "complete", f"is {a['state']}")
        a["state"] = "done"
        if final_report:
            self._add_report(a["task_id"], "final", final_report,
                             a["claimed_by"])
        return self._public(a)

    def fail(self, assignment_id: int, reason: str, *,
             claim_token: str = "", claimed_by: str = ""):
        self.calls.append(("fail", assignment_id, reason,
                           claim_token, claimed_by))
        a = self.assignments[assignment_id]
        if assignment_id in self.fail_errors \
                or self.fail_flaky.get(assignment_id, 0) > 0:
            if assignment_id in self.fail_flaky:
                self.fail_flaky[assignment_id] -= 1
            raise BoardError(500, "fail", "board down")
        token_ok = (claim_token
                    and self.tokens.get(assignment_id) == claim_token)
        by_ok = claimed_by and a["claimed_by"] == claimed_by
        if not (token_ok or by_ok):
            raise BoardError(403, "fail", "token or claimed_by required")
        if a["state"] not in ("claimed", "running"):
            raise BoardConflict(409, "fail", f"is {a['state']}")
        a["state"] = "failed"
        return self._public(a)

    def task_reports(self, task_id: str):
        self.calls.append(("reports", task_id))
        return [dict(r) for r in self.reports.get(task_id, [])]

    def post_report(self, task_id: str, kind: str, body: str, agent: str):
        self.calls.append(("post_report", task_id, kind, body, agent))
        self._add_report(task_id, kind, body, agent)


def make_config(tmp_path: Path, command: list[str], **overrides) -> PollerConfig:
    raw = {
        "board_url": "https://board.test",
        "executor_name": "test-poller",
        "poll_interval": 0.01,
        "poll_jitter": 0.0,
        "heartbeat_interval": 0.05,
        "allowlist": [{"harness": "zcode", "command": command,
                       "specialists": ["gcw-tester"]}],
        "audit_path": str(tmp_path / "audit.jsonl"),
        "lock_path": str(tmp_path / "poller.lock"),
    }
    raw.update(overrides)
    return PollerConfig.from_dict(raw)


def make_poller(config: PollerConfig, board: FakeBoard, *,
                kill_grace: float = KILL_GRACE_SECONDS) -> AssignmentPoller:
    return AssignmentPoller(config, board, AuditLog(config.audit_path),
                            kill_grace=kill_grace)


def wait_for_reap(poller: AssignmentPoller, board: FakeBoard,
                  timeout: float = 10.0) -> None:
    """Reap in a tight loop until every child is finished (test helper —
    the real loop does this between poll cycles)."""
    deadline = time.monotonic() + timeout
    while poller.active_assignment_ids and time.monotonic() < deadline:
        poller.reap()
        time.sleep(0.02)
    assert not poller.active_assignment_ids, "children never reaped"
    assert board.assignments


def read_audit(path: Path) -> list[dict]:
    return [json.loads(line) for line
            in path.read_text(encoding="utf-8").splitlines()]


# ---------------------------------------------------------------- envelope
class TestEnvelope:
    CLAIM = {
        "id": 7, "task_id": "t-42", "specialist": "gcw-tester",
        "harness": "zcode", "claimed_by": "test-poller",
        "spec_hash": "a" * 64,
        "spec_snapshot": ("Goal: починить кнопку.\n\n"
                          "Acceptance criteria:\n— [ ] первый\n— [ ] второй\n\n"
                          "Depends on: ARCH-4.\n\nКонтекст: прочее."),
    }

    def render(self, **overrides) -> str:
        assignment = {**self.CLAIM, **overrides}
        return render_envelope(assignment, board_url="https://board.test",
                               executor_name="test-poller")

    def test_all_blocks_present(self):
        env = self.render()
        assert env.splitlines()[0] == \
            "[GCW ASSIGNMENT 7 | task t-42 | mnemos -]"
        for marker in ("MODE: assignment-run", "GOAL:", "ACCEPTANCE",
                       "DEPENDS:", "SCOPE:", "REPORTS", "RIGHTS",
                       "ESCALATE", "SPEC SNAPSHOT"):
            assert marker in env, marker
        # REPORTS names the endpoint, the agent string and the budget
        assert "POST https://board.test/api/tasks/t-42/reports" in env
        assert '"agent": "test-poller"' in env
        assert "30 reports per 60 s" in env
        # RIGHTS: WF-1 §4.2 — acceptance is not the agent's
        assert "self-acceptance is forbidden" in env
        # ESCALATE: blocker → non-zero exit (the poller's fail path)
        assert "exit non-zero" in env

    def test_goal_and_ac_verbatim(self):
        env = self.render()
        assert "GOAL: Goal: починить кнопку." in env
        assert "— [ ] первый" in env and "— [ ] второй" in env  # verbatim AC
        assert "Depends on: ARCH-4." in env

    def test_memory_id_in_header_when_present(self):
        env = self.render(memory_id="bd945a48-0888")
        assert env.splitlines()[0].endswith("| mnemos bd945a48-0888]")

    def test_machine_token_absent_by_construction(self):
        token = "sekrit-machine-token-123"
        transport = httpx.MockTransport(
            lambda req: httpx.Response(200, json={"ok": True, "items": []}))
        client = BoardClient("https://board.test", token, transport=transport)
        client.list_assignments("queued")   # the wire carries the token…
        env = self.render()
        assert token not in env                       # …the prompt never does
        assert f"Bearer {token}" not in env           # no credential string
        assert "VESMARO_BOARD_TOKEN" in env           # env var NAME only
        client.close()

    def test_snapshot_not_live_spec(self):
        # A2: the renderer sees only the claim response. The "live" spec on
        # the task (VERSION 2) must not appear; the frozen snapshot must.
        env = self.render(spec_snapshot="VERSION 1")
        assert "VERSION 1" in env
        assert "VERSION 2" not in env

    def test_hash_pinned(self):
        assert self.render().count("a" * 64) == 1

    def test_fence_grows_over_embedded_fences(self):
        snapshot = "text\n```python\nx = 1\n```\nmore"
        env = self.render(spec_snapshot=snapshot)
        assert _fence(snapshot) == "````"
        # the embedded fence survives verbatim inside the outer fence
        assert "```python\nx = 1\n```" in env

    def test_fallbacks_when_sections_missing(self):
        env = self.render(spec_snapshot="просто контекст без секций")
        assert "no explicit AC section" in env
        assert "DEPENDS: —" in env


# ---------------------------------------------------------------- allowlist
class TestAllowlist:
    def test_resolve_known_and_wildcard(self):
        cfg = PollerConfig.from_dict({
            "board_url": "https://board.test", "executor_name": "p",
            "allowlist": [
                {"harness": "zcode", "command": ["zcode", "-p"],
                 "specialists": ["gcw-a"]},
                {"harness": "pi", "command": ["pi", "run"],
                 "specialists": ["*"]},
            ]})
        assert cfg.resolve("zcode", "gcw-a").command == ("zcode", "-p")
        assert cfg.resolve("pi", "anyone") is not None
        assert cfg.resolve("zcode", "gcw-b") is None      # unknown specialist
        assert cfg.resolve("copilot", "gcw-a") is None    # unknown harness

    def test_unknown_specialist_fail_closed(self, tmp_path):
        board = FakeBoard()
        board.add_assignment(1, specialist="gcw-stranger")
        cfg = make_config(tmp_path, EXIT_OK_CMD)
        poller = make_poller(cfg, board)
        poller.poll_once()
        poller.poll_once()
        assert board.assignments[1]["state"] == "queued"    # stays queued
        assert not any(c[0] == "claim" for c in board.calls)
        # exactly ONE refusal report (deduped within the process lifetime)
        refusals = [c for c in board.calls if c[0] == "post_report"]
        assert len(refusals) == 1
        assert "allowlist miss" in refusals[0][3]
        assert "gcw-stranger" in refusals[0][3]
        audit = read_audit(cfg.audit_path)
        assert audit[-1]["outcome"] == "refused"

    def test_config_validation(self):
        with pytest.raises(ConfigError):
            PollerConfig.from_dict({"board_url": "not-a-url",
                                    "executor_name": "p", "allowlist": []})
        with pytest.raises(ConfigError):
            PollerConfig.from_dict({
                "board_url": "https://x", "executor_name": "p",
                "allowlist": [{"harness": "zcode",
                               "command": ["zcode", "{evil}"],
                               "specialists": ["s"]}]})
        with pytest.raises(ConfigError):
            PollerConfig.from_dict({"board_url": "https://x",
                                    "executor_name": "", "allowlist": []})
        with pytest.raises(ConfigError):   # missing CA file = fail-closed
            PollerConfig.from_dict({
                "board_url": "https://x", "executor_name": "p",
                "ca_bundle": "/no/such/ca.crt",
                "allowlist": [{"harness": "z", "command": ["c"],
                               "specialists": ["s"]}]})
        cfg = PollerConfig.from_dict({   # zero jitter is legal (deterministic)
            "board_url": "https://x", "executor_name": "p", "poll_jitter": 0,
            "allowlist": [{"harness": "z", "command": ["c"],
                           "specialists": ["s"]}]})
        assert cfg.poll_jitter == 0.0


# ------------------------------------------------------------ launch (A2/A3)
class TestLaunch:
    def test_claim_sends_own_executor_id_never_the_pin(self, tmp_path):
        """P2-1: the claim carries the poller's OWN executor designation
        from config. Forwarding the assignment's executor pin would
        attribute laptop claims to a remote executor in the derived
        executors view and, once pin-enforcement lands (ARCH-9), let this
        poller pass the check on other executors' pins."""
        board = FakeBoard()
        board.add_assignment(5, executor_id="exec-pinned-remote")
        cfg = make_config(tmp_path, EXIT_OK_CMD,
                          executor_id="laptop-exec-9")
        poller = make_poller(cfg, board)
        poller.poll_once()
        claim = next(c for c in board.calls if c[0] == "claim")
        assert claim[2] == "test-poller"               # claimed_by
        assert claim[3] == "laptop-exec-9"             # OWN id, not the pin
        assert "exec-pinned-remote" not in {c[3] for c in board.calls
                                            if c[0] == "claim"}
        wait_for_reap(poller, board)
        # default: no executor_id in config → empty string on the wire
        board2 = FakeBoard()
        board2.add_assignment(6, executor_id="exec-pinned-remote")
        poller2 = make_poller(make_config(tmp_path, EXIT_OK_CMD), board2)
        poller2.poll_once()
        claim2 = next(c for c in board2.calls if c[0] == "claim")
        assert claim2[3] == ""
        wait_for_reap(poller2, board2)

    def test_start_spawn_and_audit(self, tmp_path):
        board = FakeBoard()
        board.add_assignment(7)
        cfg = make_config(tmp_path, EXIT_OK_CMD)
        poller = make_poller(cfg, board)
        poller.poll_once()
        assert board.assignments[7]["state"] == "running"
        launched = [a for a in read_audit(cfg.audit_path)
                    if a["outcome"] == "launched"]
        assert len(launched) == 1
        assert launched[0]["assignment_id"] == 7
        assert launched[0]["spec_hash"] == board.assignments[7]["spec_hash"]
        assert launched[0]["pid"] > 0
        wait_for_reap(poller, board)

    def test_envelope_delivered_via_stdin(self, tmp_path):
        out = tmp_path / "delivered.txt"
        script = ("import sys; open(%r, 'w').write(sys.stdin.read())"
                  % str(out))
        board = FakeBoard()
        board.add_assignment(2, task_id="t-stdin")
        cfg = make_config(tmp_path, [sys.executable, "-c", script])
        poller = make_poller(cfg, board)
        poller.poll_once()
        wait_for_reap(poller, board)
        delivered = out.read_text(encoding="utf-8")
        assert delivered.startswith("[GCW ASSIGNMENT 2 | task t-stdin |")
        assert "MODE: assignment-run" in delivered
        assert "— [ ] первый" in delivered          # snapshot inside prompt

    def test_envelope_delivered_via_file(self, tmp_path):
        out = tmp_path / "delivered.txt"
        cmd = [sys.executable, "-c",
               f"import sys; open({str(out)!r}, 'w').write("
               "open(sys.argv[1]).read())",
               "{envelope_file}"]
        board = FakeBoard()
        board.add_assignment(3)
        cfg = make_config(tmp_path, cmd)
        poller = make_poller(cfg, board)
        poller.poll_once()
        wait_for_reap(poller, board)
        delivered = out.read_text(encoding="utf-8")
        assert "MODE: assignment-run" in delivered
        # launch artifacts live in the STATE dir — after the run, none left
        leftovers = list(Path(cfg.audit_path).parent.glob("assign-*"))
        assert not leftovers

    def test_temp_files_live_in_state_dir_while_child_runs(self, tmp_path):
        """P3-6 companion: while a child is alive its envelope/stdout/stderr
        files ARE present in the state dir (the cleanup assertion in the
        test above is not vacuously green)."""
        cmd = [sys.executable, "-c",
               "import sys, time; time.sleep(30)", "{envelope_file}"]
        board = FakeBoard()
        board.add_assignment(14)
        cfg = make_config(tmp_path, cmd)
        poller = make_poller(cfg, board)
        poller.poll_once()
        state_dir = Path(cfg.audit_path).parent
        assert list(state_dir.glob("assign-14-*")), "no live launch files"
        # teardown via the heartbeat-409 kill path (also cleans files)
        board.heartbeat_conflict.add(14)
        deadline = time.monotonic() + 5
        while poller.active_assignment_ids and time.monotonic() < deadline:
            poller.send_heartbeats()
            time.sleep(0.01)
        assert not poller.active_assignment_ids
        assert not list(state_dir.glob("assign-14-*"))

    def test_child_gets_minimal_env_only(self, tmp_path, monkeypatch):
        """P2-2: children run with the minimal env allowlist (ADR 0009 §9)
        — no user-env inheritance; the machine token IS passed (REPORTS)."""
        out = tmp_path / "env-dump.txt"
        monkeypatch.setenv("POLLER_SECRET", "must-not-leak")
        monkeypatch.setenv("SSH_AUTH_SOCK", "/run/user/secret/agent.sock")
        script = ("import os; open(%r, 'w').write("
                  "chr(10).join(sorted(os.environ)))" % str(out))
        board = FakeBoard()
        board.add_assignment(15)
        cfg = make_config(tmp_path, [sys.executable, "-c", script])
        poller = make_poller(cfg, board)
        poller.poll_once()
        wait_for_reap(poller, board)
        child_env = set(out.read_text(encoding="utf-8").splitlines())
        assert "POLLER_SECRET" not in child_env
        assert "SSH_AUTH_SOCK" not in child_env
        assert {"PATH", "HOME", "VESMARO_BOARD_TOKEN"} <= child_env

    def test_oversized_envelope_refused_before_spawn(self, tmp_path):
        """P3-1: an envelope too big for the stdin pipe buffer is refused
        with a fail carrying the reason — the poller must never block on
        the stdin write."""
        from scripts.assignment_poller import STDIN_ENVELOPE_CAP
        board = FakeBoard()
        board.add_assignment(16, snapshot="x" * (STDIN_ENVELOPE_CAP + 10_000))
        cfg = make_config(tmp_path, EXIT_OK_CMD)     # stdin delivery
        poller = make_poller(cfg, board)
        poller.poll_once()
        fail = next(c for c in board.calls if c[0] == "fail")
        assert "exceeds stdin cap" in fail[2]
        assert "{envelope_file}" in fail[2]          # the remedy is named
        assert fail[3] == board.tokens[16]
        assert board.assignments[16]["state"] == "failed"
        assert not poller.active_assignment_ids      # nothing was spawned
        audit = read_audit(cfg.audit_path)
        assert audit[-1]["outcome"] == "launch-error"
        assert audit[-1]["pid"] is None

    def test_dry_run_never_mutates(self, tmp_path, caplog):
        """P3-4: --once dry-run logs decisions only — no claim, no child,
        no refusal report (a spawned child outliving the process would
        strand the claim token)."""
        import logging
        board = FakeBoard()
        board.add_assignment(17)                              # allowlist hit
        board.add_assignment(18, specialist="gcw-stranger")   # miss
        cfg = make_config(tmp_path, SLEEP_CMD)
        poller = AssignmentPoller(cfg, board, AuditLog(cfg.audit_path),
                                  dry_run=True)
        with caplog.at_level(logging.INFO, logger="assignment-poller"):
            poller.run(max_cycles=1)
        methods = {c[0] for c in board.calls}
        assert methods == {"list"}                 # reads only
        assert not poller.active_assignment_ids
        assert not Path(cfg.audit_path).exists()   # no local artifacts
        messages = " | ".join(r.message for r in caplog.records)
        assert "would claim" in messages and "allowlist miss" in messages
        assert board.assignments[17]["state"] == "queued"
        assert board.assignments[18]["state"] == "queued"

    def test_scooped_claim_left_alone(self, tmp_path):
        board = FakeBoard()
        board.add_assignment(4)
        board.assignments[4]["state"] = "claimed"   # another poller raced us
        board.assignments[4]["claimed_by"] = "other-poller"
        board.calls.clear()
        cfg = make_config(tmp_path, EXIT_OK_CMD)
        make_poller(cfg, board).poll_once()   # lists 'queued' → not returned
        assert not any(c[0] == "claim" for c in board.calls)

    def test_start_failure_fails_assignment_and_kills_child(self, tmp_path):
        """P1: when board.start() errors the child is terminated AND the
        assignment is failed with the claim token — otherwise it would sit
        in 'claimed' forever (the token lives only here; the poller scans
        only 'queued'; no server reaper yet) and the task column would lie
        in-progress."""
        board = FakeBoard()
        board.add_assignment(8)
        board.start_errors.add(8)
        cfg = make_config(tmp_path, SLEEP_CMD)   # alive until terminated
        poller = make_poller(cfg, board)
        poller.poll_once()
        audit = read_audit(cfg.audit_path)
        pid = next(a["pid"] for a in audit if a["outcome"] == "start-failed")
        assert pid > 0
        # the child is really dead
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
                time.sleep(0.05)
            except ProcessLookupError:
                break
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)
        # ...and the assignment left 'claimed' via fail with the token
        fail = next(c for c in board.calls if c[0] == "fail")
        assert fail[1] == 8
        assert fail[3] == board.tokens[8]           # claim_token auth
        assert fail[2].startswith("start failed:")
        assert board.assignments[8]["state"] == "failed"
        assert not poller.active_assignment_ids
        # launch temp files (state dir) are cleaned up
        assert not list(Path(cfg.audit_path).parent.glob("assign-*"))

    def test_start_failure_conflict_race_swallowed(self, tmp_path):
        """BoardConflict on the start-failure fail (cancelled meanwhile) is
        tolerated — the server state is already terminal."""
        board = FakeBoard()
        board.add_assignment(9)
        board.start_errors.add(9)
        board.assignments[9]["state"] = "cancelled"  # fail → BoardConflict
        cfg = make_config(tmp_path, EXIT_OK_CMD)
        poller = make_poller(cfg, board)
        poller.poll_once()                            # must not raise
        assert board.assignments[9]["state"] == "cancelled"
        assert not poller.active_assignment_ids


# ------------------------------------------------------------- supervision
class TestSupervision:
    def test_exit0_with_agent_final_completes_silent(self, tmp_path):
        board = FakeBoard()
        board.add_assignment(10, task_id="t-a")
        cfg = make_config(tmp_path, EXIT_OK_CMD)
        poller = make_poller(cfg, board)
        poller.poll_once()
        # the agent writes its own final while "running"
        board._add_report("t-a", "final", "готово", "test-poller")
        wait_for_reap(poller, board)
        complete = next(c for c in board.calls if c[0] == "complete")
        assert complete[2] == ""                       # no fallback final
        assert board.assignments[10]["state"] == "done"
        assert read_audit(cfg.audit_path)[-1]["outcome"] == "complete"

    def test_exit0_silent_gets_fallback_final(self, tmp_path):
        board = FakeBoard()
        board.add_assignment(11, task_id="t-b")
        cfg = make_config(tmp_path, EXIT_OK_CMD)
        poller = make_poller(cfg, board)
        poller.poll_once()
        wait_for_reap(poller, board)
        complete = next(c for c in board.calls if c[0] == "complete")
        assert complete[2] == FALLBACK_FINAL_REPORT
        finals = [r for r in board.reports["t-b"] if r["kind"] == "final"]
        assert finals and finals[0]["agent"] == "test-poller"

    def test_exit_nonzero_fails_with_stderr_tail(self, tmp_path):
        board = FakeBoard()
        board.add_assignment(12)
        cfg = make_config(tmp_path, EXIT_1_CMD)
        poller = make_poller(cfg, board)
        poller.poll_once()
        wait_for_reap(poller, board)
        fail = next(c for c in board.calls if c[0] == "fail")
        assert fail[1] == 12
        assert fail[2].startswith("process exit 1:")
        assert "boom" in fail[2]
        assert fail[3] == board.tokens[12]      # claim_token auth
        assert board.assignments[12]["state"] == "failed"
        assert read_audit(cfg.audit_path)[-1]["outcome"] == "failed"

    def test_stale_final_from_before_start_not_counted(self, tmp_path):
        board = FakeBoard()
        board.add_assignment(13, task_id="t-c")
        board._add_report("t-c", "final", "СТАРЫЙ финал прошлой попытки",
                          "test-poller")   # BEFORE claim → not the agent's
        cfg = make_config(tmp_path, EXIT_OK_CMD)
        poller = make_poller(cfg, board)
        poller.poll_once()
        wait_for_reap(poller, board)
        complete = next(c for c in board.calls if c[0] == "complete")
        assert complete[2] == FALLBACK_FINAL_REPORT


# --------------------------------------------------------------- heartbeat
class TestHeartbeat:
    def test_heartbeat_ticks_while_alive(self, tmp_path):
        board = FakeBoard()
        board.add_assignment(20)
        cfg = make_config(tmp_path, SLEEP_CMD, heartbeat_interval=0.05)
        poller = make_poller(cfg, board)
        poller.poll_once()
        child_pid = read_audit(cfg.audit_path)[-1]["pid"]
        deadline = time.monotonic() + 5
        while len([c for c in board.calls if c[0] == "heartbeat"]) < 2 \
                and time.monotonic() < deadline:
            poller.send_heartbeats()
            time.sleep(0.01)
        ticks = [c for c in board.calls if c[0] == "heartbeat"]
        assert len(ticks) >= 2
        assert all(t[2] == "poller alive" for t in ticks)
        # 409 (expired on the server) IS the kill signal
        board.heartbeat_conflict.add(20)
        deadline = time.monotonic() + 5
        while read_audit(cfg.audit_path)[-1]["outcome"] != "killed-409" \
                and time.monotonic() < deadline:
            poller.send_heartbeats()
            time.sleep(0.01)
        assert read_audit(cfg.audit_path)[-1]["outcome"] == "killed-409"
        assert not poller.active_assignment_ids
        assert not any(c[0] in ("complete", "fail") for c in board.calls)
        # the child is really dead and was ours. Since AB-FU-1 the kill is
        # asynchronous (background terminator), so death is awaited, not
        # assumed the moment the audit record lands.
        killed = [a for a in read_audit(cfg.audit_path)
                  if a["outcome"] == "killed-409"][0]
        assert killed["pid"] == child_pid
        deadline = time.monotonic() + KILL_GRACE_SECONDS + 5
        while time.monotonic() < deadline:
            try:
                os.kill(child_pid, 0)
                time.sleep(0.05)
            except ProcessLookupError:
                break
        with pytest.raises(ProcessLookupError):
            os.kill(child_pid, 0)

    def test_board_hiccup_does_not_kill(self, tmp_path):
        board = FakeBoard()
        board.add_assignment(21)
        cfg = make_config(tmp_path, SLEEP_CMD, heartbeat_interval=0.05)
        poller = make_poller(cfg, board)
        poller.poll_once()

        class Flaky:
            def __getattr__(self, name):
                return getattr(board, name)

            def heartbeat(self, *a, **kw):
                raise BoardError(0, "heartbeat", "transport: down")

        poller.board = Flaky()   # type: ignore[assignment]
        poller.send_heartbeats()
        assert 21 in poller.active_assignment_ids   # retried next tick
        poller.board = board
        # teardown: kill the sleeping child via the 409 path
        board.heartbeat_conflict.add(21)
        deadline = time.monotonic() + 5
        while poller.active_assignment_ids and time.monotonic() < deadline:
            poller.send_heartbeats()
            time.sleep(0.01)
        assert not poller.active_assignment_ids


# ------------------------------------------------------------ recovery sweep
class TestRecoverySweep:
    def test_fails_own_leftovers_only(self, tmp_path):
        board = FakeBoard()
        board.add_assignment(30, state="running", claimed_by="test-poller")
        board.add_assignment(31, state="claimed", claimed_by="test-poller")
        board.add_assignment(32, state="running", claimed_by="other-poller")
        cfg = make_config(tmp_path, EXIT_OK_CMD)
        poller = make_poller(cfg, board)
        swept = poller.recovery_sweep()
        assert swept == 2
        fails = [c for c in board.calls if c[0] == "fail"]
        assert {f[1] for f in fails} == {30, 31}
        assert all(f[2] == SWEEP_FAIL_REASON for f in fails)
        assert all(f[4] == "test-poller" for f in fails)   # claimed_by match
        assert board.assignments[30]["state"] == "failed"
        assert board.assignments[31]["state"] == "failed"
        assert board.assignments[32]["state"] == "running"  # foreign: intact
        outcomes = {a["assignment_id"]: a["outcome"]
                    for a in read_audit(cfg.audit_path)}
        assert outcomes == {30: "sweep-failed", 31: "sweep-failed"}

    def test_conflict_raced_is_tolerated(self, tmp_path):
        board = FakeBoard()
        board.add_assignment(33, state="running", claimed_by="test-poller")
        board.assignments[33]["state"] = "expired"   # reaper got there first
        cfg = make_config(tmp_path, EXIT_OK_CMD)
        assert make_poller(cfg, board).recovery_sweep() == 0

    def test_orphan_pid_from_audit_is_killed(self, tmp_path):
        orphan = subprocess.Popen(SLEEP_CMD, start_new_session=True)
        try:
            board = FakeBoard()
            board.add_assignment(34, state="running",
                                 claimed_by="test-poller")
            cfg = make_config(tmp_path, SLEEP_CMD)   # argv0 matches SLEEP_CMD
            audit = AuditLog(cfg.audit_path)
            audit.append(assignment_id=34, specialist="gcw-tester",
                         spec_hash="x", pid=orphan.pid, outcome="launched")
            AssignmentPoller(cfg, board, audit).recovery_sweep()
            deadline = time.monotonic() + 10
            while orphan.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            assert orphan.poll() is not None         # SIGTERMed by the sweep
            assert board.assignments[34]["state"] == "failed"
        finally:
            if orphan.poll() is None:
                orphan.kill()
                orphan.wait()

    def test_orphan_with_foreign_argv0_is_not_signalled(self, tmp_path):
        """P3-2: the argv0 plausibility check is EXACT basename equality —
        a reused pid running something else must never be killed (and
        substring matching would let "zcode" match "zcode-helper")."""
        import shutil
        sleeper = shutil.which("sleep")
        if sleeper is None:                       # pragma: no cover
            pytest.skip("no /usr/bin/sleep on this host")
        orphan = subprocess.Popen([sleeper, "30"], start_new_session=True)
        try:
            board = FakeBoard()
            board.add_assignment(35, state="running",
                                 claimed_by="test-poller")
            cfg = make_config(tmp_path, SLEEP_CMD)  # expects python3, not sleep
            audit = AuditLog(cfg.audit_path)
            audit.append(assignment_id=35, specialist="gcw-tester",
                         spec_hash="x", pid=orphan.pid, outcome="launched")
            AssignmentPoller(cfg, board, audit).recovery_sweep()
            assert orphan.poll() is None          # alive: NOT signalled
            # the assignment is still failed unconditionally (no liveness
            # check in the sweep) — only the kill is best-effort
            assert board.assignments[35]["state"] == "failed"
        finally:
            orphan.terminate()
            orphan.wait()


# --------------------------------------------------- max_concurrent (AB-FU-1)
class TestMaxConcurrent:
    def test_config_validation(self):
        base = {"board_url": "https://x", "executor_name": "p",
                "allowlist": [{"harness": "z", "command": ["c"],
                               "specialists": ["s"]}]}
        assert PollerConfig.from_dict(base).max_concurrent \
            == MAX_CONCURRENT_DEFAULT == 2
        assert PollerConfig.from_dict({**base, "max_concurrent": 1}) \
            .max_concurrent == 1
        for bad in (0, -1, "2", 1.5, True):
            with pytest.raises(ConfigError):
                PollerConfig.from_dict({**base, "max_concurrent": bad})

    def test_capacity_skips_tick_then_picks_up_later(self, tmp_path, caplog):
        """AC1: over capacity the poll tick is skipped with a log line; the
        assignment stays queued and is claimed once a slot frees."""
        import logging
        board = FakeBoard()
        board.add_assignment(50)
        board.add_assignment(51)
        cfg = make_config(tmp_path, SLEEP_CMD, max_concurrent=1,
                          heartbeat_interval=0.05)
        poller = make_poller(cfg, board)
        with caplog.at_level(logging.INFO, logger="assignment-poller"):
            poller.poll_once()   # launches 50; 51 hits the cap mid-tick
            poller.poll_once()   # full → whole tick skipped with a log
        assert board.assignments[50]["state"] == "running"
        assert board.assignments[51]["state"] == "queued"   # NOT refused
        assert len([c for c in board.calls if c[0] == "claim"]) == 1
        assert any("at capacity" in r.message for r in caplog.records)
        # the slot frees (409 kill) → the queued assignment is picked up
        board.heartbeat_conflict.add(50)
        deadline = time.monotonic() + 5
        while 50 in poller.active_assignment_ids \
                and time.monotonic() < deadline:
            poller.send_heartbeats()
            time.sleep(0.01)
        poller.poll_once()
        assert board.assignments[51]["state"] == "running"
        # teardown: kill 51 through the same 409 path
        board.heartbeat_conflict.add(51)
        deadline = time.monotonic() + 5
        while poller.active_assignment_ids and time.monotonic() < deadline:
            poller.send_heartbeats()
            time.sleep(0.01)

    def test_dry_run_respects_capacity(self, tmp_path, caplog):
        """AC1: dry-run logs the would-launch decisions honouring the cap —
        capacity is visible in --once smoke output, not only at runtime."""
        import logging
        board = FakeBoard()
        for aid in (52, 53, 54):
            board.add_assignment(aid)
        cfg = make_config(tmp_path, EXIT_OK_CMD, max_concurrent=2)
        poller = AssignmentPoller(cfg, board, AuditLog(cfg.audit_path),
                                  dry_run=True)
        with caplog.at_level(logging.INFO, logger="assignment-poller"):
            poller.run(max_cycles=1)
        messages = [r.message for r in caplog.records]
        assert sum("would claim" in m for m in messages) == 2
        assert sum("would stay queued: max_concurrent=2" in m
                   for m in messages) == 1
        assert {c[0] for c in board.calls} == {"list"}   # reads only
        assert not poller.active_assignment_ids


# ----------------------------------------------- async termination (AB-FU-1)
class TestAsyncTermination:
    def test_kill_does_not_block_other_heartbeats(self, tmp_path):
        """AC2: a 409 kill of a SIGTERM-ignoring child must not stall the
        supervision loop — the other child keeps getting heartbeats through
        the whole grace window (the old inline _terminate froze them for
        up to KILL_GRACE_SECONDS)."""
        board = FakeBoard()
        board.add_assignment(60)   # stubborn: ignores SIGTERM
        board.add_assignment(61)   # same command; torn down by hand
        cfg = make_config(tmp_path, STUBBORN_CMD, heartbeat_interval=0.05,
                          max_concurrent=2)
        poller = make_poller(cfg, board, kill_grace=3.0)
        poller.poll_once()
        proc61 = poller._children[61].proc          # teardown handle
        time.sleep(0.5)          # let both children install SIG_IGN
        stubborn_pid = next(a["pid"] for a in read_audit(cfg.audit_path)
                            if a["assignment_id"] == 60
                            and a["outcome"] == "launched")
        board.heartbeat_conflict.add(60)
        t0 = time.monotonic()
        poller.send_heartbeats()   # hits the 409 kill — enqueue only
        elapsed = time.monotonic() - t0
        assert elapsed < 1.0, f"send_heartbeats blocked {elapsed:.2f}s"
        assert 60 not in poller.active_assignment_ids
        assert read_audit(cfg.audit_path)[-1]["outcome"] == "killed-409"
        assert not any(c[0] in ("complete", "fail") for c in board.calls)
        # heartbeats for 61 continue WHILE 60 is still inside its grace
        ticks61 = 0
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            try:
                os.kill(stubborn_pid, 0)
            except ProcessLookupError:
                break
            poller.send_heartbeats()
            ticks61 = len([c for c in board.calls
                           if c[0] == "heartbeat" and c[1] == 61])
            time.sleep(0.02)
        assert ticks61 >= 2, "sibling heartbeats stalled during the grace"
        # the stubborn child dies only via the SIGKILL escalation
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                os.kill(stubborn_pid, 0)
                time.sleep(0.05)
            except ProcessLookupError:
                break
        with pytest.raises(ProcessLookupError):
            os.kill(stubborn_pid, 0)
        # teardown 61
        os.kill(proc61.pid, signal.SIGKILL)
        proc61.wait(timeout=5)

    def test_terminate_grace_escalates_and_reaps(self):
        """AC2 unit: _terminate(grace) SIGTERMs, waits the grace, SIGKILLs
        the stubborn process and reaps it (no zombie answering signal 0)."""
        proc = subprocess.Popen(STUBBORN_CMD, start_new_session=True)
        try:
            time.sleep(0.5)               # handler installed
            _terminate(proc, grace=0.5)
            assert proc.wait(timeout=5) == -signal.SIGKILL   # reaped corpse
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                try:
                    os.kill(proc.pid, 0)
                    time.sleep(0.05)
                except ProcessLookupError:
                    break
            with pytest.raises(ProcessLookupError):
                os.kill(proc.pid, 0)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()

    def test_terminate_already_dead_is_noop(self):
        proc = subprocess.Popen(EXIT_OK_CMD, start_new_session=True)
        proc.wait(timeout=5)
        _terminate(proc, grace=0.1)   # must not raise on a dead child
        assert proc.poll() == 0


# ------------------------------------------------ audit full scan (AB-FU-1)
class TestAuditFullScan:
    def test_last_pid_survives_long_tail(self, tmp_path):
        """AC3: the pid lookup is a FULL scan — a live child whose launch
        record fell out of any fixed tail window is still found."""
        audit = AuditLog(tmp_path / "audit.jsonl")
        audit.append(assignment_id=70, specialist="s", spec_hash="h",
                     pid=4242, outcome="launched")
        for i in range(500):   # pushes the launch beyond the old tail-400
            audit.append(assignment_id=10_000 + i, specialist="s",
                         spec_hash="h", pid=60_000 + i, outcome="launched")
        assert audit.last_pid_for(70) == 4242
        assert audit.last_pid_for(10_499) == 60_499

    def test_last_record_for_assignment_wins(self, tmp_path):
        audit = AuditLog(tmp_path / "audit.jsonl")
        audit.append(assignment_id=71, specialist="s", spec_hash="h",
                     pid=1111, outcome="launched")
        audit.append(assignment_id=71, specialist="s", spec_hash="h",
                     pid=None, outcome="sweep-failed")
        assert audit.last_pid_for(71) is None
        audit.append(assignment_id=71, specialist="s", spec_hash="h",
                     pid=2222, outcome="launched")
        assert audit.last_pid_for(71) == 2222

    def test_missing_or_corrupt_lines(self, tmp_path):
        audit = AuditLog(tmp_path / "audit.jsonl")
        assert audit.last_pid_for(1) is None              # no file at all
        audit.path.write_text("not json\n", encoding="utf-8")
        assert audit.last_pid_for(1) is None              # corrupt line


# ------------------------------------------------- finish retries (AB-FU-1)
class TestFinishRetries:
    def test_complete_5xx_persistent_ends_unreported(self, tmp_path, caplog):
        """AC4: the board 5xx-ing every complete → exactly FINISH_RETRIES
        attempts, then the child is dropped with outcome 'unreported'
        (CRITICAL log); the board state stays running — sweep will own it."""
        import logging
        board = FakeBoard()
        board.add_assignment(80, task_id="t-u")
        board.complete_errors.add(80)
        cfg = make_config(tmp_path, EXIT_OK_CMD)
        poller = make_poller(cfg, board)
        poller.poll_once()
        with caplog.at_level(logging.CRITICAL, logger="assignment-poller"):
            wait_for_reap(poller, board)
        attempts = [c for c in board.calls if c[0] == "complete"]
        assert len(attempts) == FINISH_RETRIES
        assert board.assignments[80]["state"] == "running"   # never told
        assert read_audit(cfg.audit_path)[-1]["outcome"] == "unreported"
        assert any("was not told" in r.message for r in caplog.records)

    def test_complete_5xx_transient_retries_through(self, tmp_path):
        """AC4: two hiccups then success — the exit is reported on the
        third attempt, assignment reaches done (a finished run is not
        silently lost to transient board errors)."""
        board = FakeBoard()
        board.add_assignment(81, task_id="t-v")
        board.complete_flaky[81] = 2
        cfg = make_config(tmp_path, EXIT_OK_CMD)
        poller = make_poller(cfg, board)
        poller.poll_once()
        wait_for_reap(poller, board)
        attempts = [c for c in board.calls if c[0] == "complete"]
        assert len(attempts) == 3
        assert board.assignments[81]["state"] == "done"
        assert read_audit(cfg.audit_path)[-1]["outcome"] == "complete"

    def test_fail_5xx_persistent_ends_unreported(self, tmp_path):
        board = FakeBoard()
        board.add_assignment(82)
        board.fail_errors.add(82)
        cfg = make_config(tmp_path, EXIT_1_CMD)
        poller = make_poller(cfg, board)
        poller.poll_once()
        wait_for_reap(poller, board)
        attempts = [c for c in board.calls if c[0] == "fail"]
        assert len(attempts) == FINISH_RETRIES
        assert board.assignments[82]["state"] == "running"
        assert read_audit(cfg.audit_path)[-1]["outcome"] == "unreported"


# --------------------------------------------------- launch errors (AB-FU-1)
class TestLaunchErrors:
    def test_spawn_oserror_fails_assignment_with_reason(self, tmp_path):
        """AC4: Popen OSError (missing binary) → assignment FAILed with the
        reason, audit launch-error with pid=None, no child supervised."""
        board = FakeBoard()
        board.add_assignment(83)
        cfg = make_config(tmp_path, ["/nonexistent/harness-binary"])
        poller = make_poller(cfg, board)
        poller.poll_once()                       # must not raise
        fail = next(c for c in board.calls if c[0] == "fail")
        assert fail[1] == 83
        assert fail[2].startswith("launch failed:")
        assert "nonexistent" in fail[2]
        assert fail[3] == board.tokens[83]       # claim_token auth
        assert board.assignments[83]["state"] == "failed"
        assert not poller.active_assignment_ids
        audit = read_audit(cfg.audit_path)
        assert audit[-1]["outcome"] == "launch-error"
        assert audit[-1]["pid"] is None

    def test_brokenpipe_on_stdin_write_is_survived(self, tmp_path,
                                                   monkeypatch):
        """AC4: BrokenPipe while feeding the envelope to a child that died
        instantly is swallowed — the exit code mapping still completes the
        assignment (deterministic injection: stdin proxy raises)."""
        broken = {"hit": False}

        class _BrokenStdin:
            def __init__(self, real):
                self._real = real

            def write(self, data):
                broken["hit"] = True
                raise BrokenPipeError("child closed stdin before reading")

            def close(self):
                if self._real is not None:
                    self._real.close()

        class StdinBreakerPopen(subprocess.Popen):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                real = self.stdin
                self.stdin = _BrokenStdin(real)   # type: ignore[assignment]

        monkeypatch.setattr(subprocess, "Popen", StdinBreakerPopen)
        board = FakeBoard()
        board.add_assignment(84)
        cfg = make_config(tmp_path, EXIT_OK_CMD)   # stdin delivery
        poller = make_poller(cfg, board)
        poller.poll_once()                          # must not raise
        assert broken["hit"]                        # path really exercised
        wait_for_reap(poller, board)
        assert board.assignments[84]["state"] == "done"
        assert read_audit(cfg.audit_path)[-1]["outcome"] == "complete"


# ---------------------------------------------------------------- BoardClient
class TestBoardClientWire:
    @staticmethod
    def client(handler) -> BoardClient:
        transport = handler if isinstance(handler, httpx.MockTransport) \
            else httpx.MockTransport(handler)
        return BoardClient("https://board.test/", "tok-1", transport=transport)

    def test_claim_wire_format(self):
        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["auth"] = request.headers.get("Authorization")
            seen["path"] = request.url.path
            seen["body"] = json.loads(request.content)
            return httpx.Response(200, json={
                "ok": True, "claim_token": "deadbeef",
                "assignment": {"id": 9, "spec_snapshot": "SNAP",
                               "spec_hash": "h"}})

        client = self.client(handler)
        assignment, token = client.claim(9, claimed_by="p", executor_id="e1")
        client.close()
        assert seen["path"] == "/api/assignments/9/claim"
        assert seen["auth"] == "Bearer tok-1"
        assert seen["body"] == {"claimed_by": "p", "executor_id": "e1"}
        assert token == "deadbeef"
        assert assignment["spec_snapshot"] == "SNAP"

    def test_status_mapping(self):
        conf = httpx.MockTransport(
            lambda r: httpx.Response(409, json={"detail": "not queued"}))
        err5 = httpx.MockTransport(
            lambda r: httpx.Response(500, json={"detail": "boom"}))
        dead = httpx.MockTransport(
            lambda r: (_ for _ in ()).throw(httpx.ConnectError("refused")))
        with self.client(conf) as c:
            with pytest.raises(BoardConflict):
                c.claim(1, "p")
        with self.client(err5) as c:
            with pytest.raises(BoardError) as ei:
                c.list_assignments("queued")
            assert ei.value.status == 500
        with self.client(dead) as c:
            with pytest.raises(BoardError) as ei:
                c.list_assignments("queued")
            assert ei.value.status == 0

    def test_full_lifecycle_wire(self):
        """One pass over the machine-class wire: claim → start → heartbeat
        → complete, exact bodies, base-URL joining (no double slash)."""
        paths: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            paths.append(f"{request.method} {request.url.path}")
            if request.url.path.endswith("/claim"):
                return httpx.Response(200, json={
                    "ok": True, "claim_token": "ct",
                    "assignment": {"id": 1, "task_id": "t", "state": "claimed",
                                   "spec_snapshot": "", "spec_hash": ""}})
            if request.url.path.endswith("/reports"):
                return httpx.Response(200, json={"ok": True, "items": []})
            if request.url.path.endswith("/complete"):
                return httpx.Response(200, json={
                    "ok": True, "assignment": {"id": 1, "state": "done"}})
            return httpx.Response(200, json={"ok": True,
                                             "assignment": {"id": 1}})

        with self.client(handler) as c:
            _, token = c.claim(1, "p")
            c.start(1, token)
            c.heartbeat(1, token, note="poller alive")
            c.complete(1, token, final_report=FALLBACK_FINAL_REPORT)
        assert paths == [
            "POST /api/assignments/1/claim",
            "POST /api/assignments/1/start",
            "POST /api/assignments/1/heartbeat",
            "POST /api/assignments/1/complete",
        ]


# ------------------------------------------------------------ singleton/main
class TestSingletonAndMain:
    def test_flock_singleton(self, tmp_path):
        lock = tmp_path / "poller.lock"
        fd = acquire_singleton_lock(lock)
        assert fd is not None
        assert acquire_singleton_lock(lock) is None   # second instance loses
        import os
        os.close(fd)
        assert acquire_singleton_lock(lock) is not None

    def test_main_refuses_without_token(self, tmp_path, monkeypatch, caplog):
        monkeypatch.delenv("VESMARO_BOARD_TOKEN", raising=False)
        cfg = tmp_path / "poller.yaml"
        cfg.write_text("board_url: https://x\nexecutor_name: p\n"
                       "allowlist: [{harness: zcode, command: [true], "
                       "specialists: [s]}]\n", encoding="utf-8")
        import logging
        with caplog.at_level(logging.ERROR, logger="assignment-poller"):
            assert main(["--config", str(cfg)]) == 2
        assert any("VESMARO_BOARD_TOKEN" in r.message for r in caplog.records)

    def test_main_refuses_on_bad_config(self, tmp_path, monkeypatch):
        monkeypatch.setenv("VESMARO_BOARD_TOKEN", "tok")
        assert main(["--config", str(tmp_path / "nope.yaml")]) == 2

    def test_config_from_yaml_file(self, tmp_path):
        cfg_file = tmp_path / "poller.yaml"
        cfg_file.write_text(
            "board_url: https://board.test\n"
            "executor_name: yaml-poller\n"
            "allowlist:\n"
            "  - harness: zcode\n"
            "    command: [zcode, -p]\n"
            "    specialists: [gcw-tester]\n",
            encoding="utf-8")
        cfg = PollerConfig.from_file(cfg_file)
        assert cfg.executor_name == "yaml-poller"
        assert isinstance(cfg.allowlist[0], AllowlistEntry)
        assert cfg.poll_interval == 10.0     # defaults from YAML-free path


# ------------------------------------------------------------ loop (end-to-end-ish)
class TestLoop:
    def test_run_cycles_to_completion(self, tmp_path):
        """The real run() loop with real subprocesses and tiny intervals:
        sweep → poll → heartbeat → reap until every child is terminal."""
        board = FakeBoard()
        board.add_assignment(40, task_id="t-loop")
        board.add_assignment(41, task_id="t-loop2", specialist="gcw-stranger")
        cfg = make_config(tmp_path, EXIT_OK_CMD,
                          poll_interval=0.01, poll_jitter=0.0)
        poller = make_poller(cfg, board)
        deadline = time.monotonic() + 15
        while board.assignments[40]["state"] != "done" \
                and time.monotonic() < deadline:
            poller.step()
            time.sleep(0.01)
        assert board.assignments[40]["state"] == "done"
        assert board.assignments[41]["state"] == "queued"   # allowlist miss
        assert not poller.active_assignment_ids


# --------------------------------------------- e2e: poller × live uvicorn server
def _live_uvicorn(app) -> tuple[str, object]:
    """Run the real app on a live ephemeral-port uvicorn (thread); returns
    (base_url, server). The optional e2e leg of the ARCH-5 AC: same app,
    real HTTP socket, no in-process transport substitution."""
    import threading

    import uvicorn
    config = uvicorn.Config(app, host="127.0.0.1", port=0,
                            log_level="warning", lifespan="off")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.02)
    assert server.started, "uvicorn did not start"
    port = server.servers[0].sockets[0].getsockname()[1]
    return f"http://127.0.0.1:{port}", server


class TestEndToEndAgainstRealApp:
    """Full lifecycle against the REAL server (phase-1 contract) over a
    live uvicorn socket: create (ui class) → poller claim → real
    subprocess → exit 0 → complete with the fallback final report → task
    column resolved."""

    def test_full_lifecycle(self, client, auth, make_task, app_module,
                            tmp_path):
        task = make_task(
            title="e2e poller",
            spec="Goal: пройти e2e.\n\nAcceptance criteria:\n— [ ] lifecycle\n")
        created = client.post(
            "/api/assignments",
            json={"task_id": task["id"], "specialist": "gcw-tester"},
            headers=auth)
        assert created.status_code == 201, created.text
        aid = created.json()["assignment"]["id"]

        base_url, server = _live_uvicorn(app_module.app)
        try:
            with BoardClient(base_url, os.environ["VESMARO_BOARD_TOKEN"]) \
                    as board:
                cfg = make_config(tmp_path, EXIT_OK_CMD, poll_interval=0.01,
                                  poll_jitter=0.0, heartbeat_interval=5.0)
                poller = AssignmentPoller(cfg, board, AuditLog(cfg.audit_path))
                poller.recovery_sweep()          # nothing own → no-op
                state = ""
                deadline = time.monotonic() + 15
                while state != "done" and time.monotonic() < deadline:
                    poller.step()
                    time.sleep(0.01)
                    items = client.get("/api/assignments").json()["items"]
                    state = next((x["state"] for x in items
                                  if x["id"] == aid), "")
                assert state == "done"
                assert not poller.active_assignment_ids
        finally:
            server.should_exit = True

        # task column: claim moved it in-progress, complete → resolved
        board_tasks = {t["id"]: t for t in client.get("/api/board").json()["tasks"]}
        assert board_tasks[task["id"]]["col"] == "resolved"
        # launcher contract: the silent agent got the fallback final report
        reports = client.get(f"/api/tasks/{task['id']}/reports").json()
        assert reports["count"] == 1
        assert reports["items"][0]["kind"] == "final"
        assert reports["items"][0]["agent"] == "test-poller"
        assert reports["items"][0]["body"] == FALLBACK_FINAL_REPORT
        # local audit trail: launched → complete for the real assignment
        outcomes = [a["outcome"] for a in read_audit(cfg.audit_path)]
        assert outcomes == ["launched", "complete"]

    def test_recovery_sweep_fails_own_stale_record(self, client, auth,
                                                   make_task, app_module,
                                                   tmp_path):
        """Sweep against the real fail contract: claimed_by match, no
        token — exactly the post-restart situation."""
        task = make_task(title="e2e sweep")
        created = client.post(
            "/api/assignments",
            json={"task_id": task["id"], "specialist": "gcw-tester"},
            headers=auth)
        aid = created.json()["assignment"]["id"]
        claimed = client.post(f"/api/assignments/{aid}/claim",
                              json={"claimed_by": "test-poller"},
                              headers=auth)
        assert claimed.status_code == 200

        base_url, server = _live_uvicorn(app_module.app)
        try:
            with BoardClient(base_url, os.environ["VESMARO_BOARD_TOKEN"]) \
                    as board:
                cfg = make_config(tmp_path, EXIT_OK_CMD)
                poller = AssignmentPoller(cfg, board, AuditLog(cfg.audit_path))
                assert poller.recovery_sweep() == 1
        finally:
            server.should_exit = True

        item = next(x for x in client.get("/api/assignments").json()["items"]
                    if x["id"] == aid)
        assert item["state"] == "failed"
        board_tasks = {t["id"]: t for t in client.get("/api/board").json()["tasks"]}
        assert board_tasks[task["id"]]["col"] == "blocked"   # fail → blocked
