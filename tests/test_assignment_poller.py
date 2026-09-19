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
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from scripts.assignment_poller import (
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
    acquire_singleton_lock,
    main,
    render_envelope,
)

ROOT = Path(__file__).resolve().parents[1]

EXIT_OK_CMD = [sys.executable, "-c", "pass"]
EXIT_1_CMD = [sys.executable, "-c",
              "import sys; print('boom', file=sys.stderr); sys.exit(1)"]
SLEEP_CMD = [sys.executable, "-c", "import time; time.sleep(30)"]


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


def make_poller(config: PollerConfig, board: FakeBoard) -> AssignmentPoller:
    return AssignmentPoller(config, board, AuditLog(config.audit_path))


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
    def test_claim_start_spawn_and_audit(self, tmp_path):
        board = FakeBoard()
        board.add_assignment(5, executor_id="exec-alpha")
        cfg = make_config(tmp_path, EXIT_OK_CMD)
        poller = make_poller(cfg, board)
        poller.poll_once()
        claim = next(c for c in board.calls if c[0] == "claim")
        assert claim[2] == "test-poller"               # claimed_by
        assert claim[3] == "exec-alpha"                # executor_id forwarded
        assert board.assignments[5]["state"] == "running"
        launched = [a for a in read_audit(cfg.audit_path)
                    if a["outcome"] == "launched"]
        assert len(launched) == 1
        assert launched[0]["assignment_id"] == 5
        assert launched[0]["spec_hash"] == board.assignments[5]["spec_hash"]
        assert launched[0]["pid"] > 0
        wait_for_reap(poller, board)

    def test_envelope_delivered_via_stdin(self, tmp_path, monkeypatch):
        out = tmp_path / "delivered.txt"
        monkeypatch.setenv("POLLER_TEST_OUT", str(out))
        cmd = [sys.executable, "-c",
               "import os, sys; open(os.environ['POLLER_TEST_OUT'], 'w')"
               ".write(sys.stdin.read())"]
        board = FakeBoard()
        board.add_assignment(2, task_id="t-stdin")
        cfg = make_config(tmp_path, cmd)
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
        # the envelope temp file is cleaned up after the run
        leftovers = list(Path(cfg.audit_path).parent.glob("assign-*"))
        assert not leftovers

    def test_scooped_claim_left_alone(self, tmp_path):
        board = FakeBoard()
        board.add_assignment(4)
        board.assignments[4]["state"] = "claimed"   # another poller raced us
        board.assignments[4]["claimed_by"] = "other-poller"
        board.calls.clear()
        cfg = make_config(tmp_path, EXIT_OK_CMD)
        make_poller(cfg, board).poll_once()   # lists 'queued' → not returned
        assert not any(c[0] == "claim" for c in board.calls)


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
        # the child is really dead and was ours
        killed = [a for a in read_audit(cfg.audit_path)
                  if a["outcome"] == "killed-409"][0]
        assert killed["pid"] == child_pid
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
