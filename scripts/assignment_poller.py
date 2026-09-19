#!/usr/bin/env python3
"""Assignment poller — deterministic dispatcher (ADR 0009 phase 2, ARCH-5).

Variant A′ execution leg: the board nominates (ui-token create), THIS
poller decides (machine-token claim + local allowlist, amendment A3).
No LLM ever decides whether to launch — the only gate is an exact
(harness, specialist) → command allowlist from the local config.

Live server contract (phase 1, PR #13):
  GET  {board_url}/api/assignments?state=queued          (open read)
  POST {board_url}/api/assignments/{id}/claim            {claimed_by, executor_id?}
       → 200 {assignment (+spec_snapshot), claim_token}
  POST {board_url}/api/assignments/{id}/start            {claim_token}
  POST {board_url}/api/assignments/{id}/heartbeat        {claim_token, note?}
  POST {board_url}/api/assignments/{id}/complete          {claim_token, final_report?}
  POST {board_url}/api/assignments/{id}/fail              {reason, claim_token?|claimed_by?}
  POST {board_url}/api/tasks/{task_id}/reports            {kind, body, agent}
Auth for writes: Bearer $VESMARO_BOARD_TOKEN — env only, never in the
config file and never in the agent prompt (the child inherits the env;
the envelope names only the endpoint, ADR 0009 §5/§9).

board_url is a plain base URL (Amendment 2 §1): direct HTTPS today, a
local mesh endpoint later — this code does not distinguish them.

Disciplines implemented here (ADR 0009):
- A2  execute the claim-time spec_snapshot, never the live spec;
- A3  allowlist miss → fail-closed: skip + log + one refusal report,
      the assignment stays queued;
- §4  heartbeat from the poller (not the agent) every heartbeat_interval;
      409 on heartbeat = kill signal for the child (reaper/cancel raced);
      exit 0 → complete (fallback final when the agent was silent),
      exit ≠0 → fail with the stderr tail; flock singleton;
      recovery sweep on start fails own claimed|running leftovers;
- §5  the launch prompt is the assignment envelope (render_envelope).
"""

from __future__ import annotations

import argparse
import fcntl
import json
import logging
import os
import random
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from string import Formatter
from typing import Any, Callable

import httpx
import yaml

log = logging.getLogger("assignment-poller")

# ------------------------------------------------------------------ defaults
POLL_INTERVAL_DEFAULT = 10.0     # seconds between queue scans (ADR §4 ~10 s)
POLL_JITTER_DEFAULT = 2.0        # ± seconds on the poll interval
HEARTBEAT_INTERVAL_DEFAULT = 60.0  # poller-driven liveness tick (ADR §4)
KILL_GRACE_SECONDS = 10.0        # SIGTERM → SIGKILL grace for children
STDERR_TAIL_CHARS = 400          # fail-reason tail cap (server caps at 2000)
FINISH_RETRIES = 5               # complete/fail retries on transient errors
SWEEP_FAIL_REASON = "poller restart, no local process"
FALLBACK_FINAL_REPORT = "exit 0, agent report above"
ALLOWED_PLACEHOLDERS = frozenset({"specialist", "envelope_file"})
# Minimal child environment (ADR 0009 §9: autostarted specialists run in
# an unprivileged profile). The machine token IS passed deliberately —
# the envelope's REPORTS block requires the agent to post reports; it is
# the only credential a child gets. Extend this list consciously: every
# key here is handed to autostarted agent processes.
CHILD_ENV_KEYS = ("PATH", "HOME", "TMPDIR", "LANG", "VESMARO_BOARD_TOKEN")
# stdin envelope delivery relies on the OS pipe buffer; anything larger
# would block the poller on write. Deliver via {envelope_file} instead.
STDIN_ENVELOPE_CAP = 60_000

# _now() mirrors server.store._now(): ISO UTC, seconds — audit ts and the
# report-freshness comparisons rely on the shared format.
def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _state_dir() -> Path:
    base = os.environ.get("XDG_STATE_HOME") or "~/.local/state"
    return Path(base).expanduser() / "mnemos-eyes"


def _config_dir() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or "~/.config"
    return Path(base).expanduser() / "mnemos-eyes"


# --------------------------------------------------------------------- errors
class PollerError(RuntimeError):
    """Base class — every poller failure is typed, never a bare raise."""


class ConfigError(PollerError):
    """Invalid poller.yaml — refuse to start (fail-closed at load time)."""


class BoardError(PollerError):
    """Board call failed (transport or unexpected HTTP status)."""

    def __init__(self, status: int, path: str, detail: str):
        super().__init__(f"board {status} on {path}: {detail}")
        self.status = status
        self.path = path
        self.detail = detail


class BoardConflict(BoardError):
    """HTTP 409 — state race (scooped claim, expired heartbeat, …)."""


# --------------------------------------------------------------------- config
@dataclass(frozen=True)
class AllowlistEntry:
    """One (harness, specialist…) → command mapping (ADR 0005: the harness
    is the execution environment; specialists are GCW roles substituted
    into the trusted template from config — never derived from spec)."""

    harness: str
    command: tuple[str, ...]
    specialists: frozenset[str]

    def matches(self, harness: str, specialist: str) -> bool:
        return (harness == self.harness
                and (specialist in self.specialists or "*" in self.specialists))


@dataclass(frozen=True)
class PollerConfig:
    board_url: str
    executor_name: str
    allowlist: tuple[AllowlistEntry, ...]
    poll_interval: float = POLL_INTERVAL_DEFAULT
    poll_jitter: float = POLL_JITTER_DEFAULT
    heartbeat_interval: float = HEARTBEAT_INTERVAL_DEFAULT
    ca_bundle: str = ""                  # lab CA for self-signed board TLS
    # This poller's OWN executor designation (ARCH-9 derived view). NEVER
    # the assignment's executor pin: forwarding the pin would attribute
    # laptop claims to a remote executor and, once pin-enforcement lands
    # (mismatch → 409), let this poller claim-pin other executors'
    # assignments. Empty by default (phase 1 stores it verbatim only).
    executor_id: str = ""
    audit_path: Path = field(default_factory=lambda: _state_dir() / "poller-audit.jsonl")
    lock_path: Path = field(default_factory=lambda: _state_dir() / "poller.lock")

    @classmethod
    def from_file(cls, path: Path | str) -> "PollerConfig":
        path = Path(path).expanduser()
        try:
            raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise ConfigError(f"config not found: {path}") from exc
        except yaml.YAMLError as exc:
            raise ConfigError(f"config is not valid YAML: {path}: {exc}") from exc
        if not isinstance(raw, dict):
            raise ConfigError(f"config root must be a mapping: {path}")
        return cls.from_dict(raw)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "PollerConfig":
        board_url = str(raw.get("board_url") or "").strip().rstrip("/")
        if not re.fullmatch(r"https?://\S+", board_url):
            raise ConfigError(
                f"board_url must be an http(s) base URL, got: {board_url!r}")
        executor_name = str(raw.get("executor_name") or "").strip()
        if not 1 <= len(executor_name) <= 120:
            raise ConfigError("executor_name must be 1..120 chars")

        entries: list[AllowlistEntry] = []
        raw_list = raw.get("allowlist") or []
        if not isinstance(raw_list, list) or not raw_list:
            raise ConfigError("allowlist must be a non-empty list")
        for i, item in enumerate(raw_list):
            if not isinstance(item, dict):
                raise ConfigError(f"allowlist[{i}] must be a mapping")
            harness = str(item.get("harness") or "").strip()
            command = item.get("command")
            specialists = item.get("specialists")
            if not harness:
                raise ConfigError(f"allowlist[{i}].harness is required")
            if (not isinstance(command, list) or not command
                    or not all(isinstance(t, str) and t.strip() for t in command)):
                raise ConfigError(
                    f"allowlist[{i}].command must be a non-empty list of strings")
            if (not isinstance(specialists, list) or not specialists
                    or not all(isinstance(s, str) and s.strip() for s in specialists)):
                raise ConfigError(
                    f"allowlist[{i}].specialists must be a non-empty list of strings")
            for token in command:
                for lit, field_name, _, _ in Formatter().parse(token):
                    if field_name is not None and field_name not in ALLOWED_PLACEHOLDERS:
                        raise ConfigError(
                            f"allowlist[{i}].command placeholder {{{field_name}}} "
                            f"is not allowed (only "
                            f"{sorted(ALLOWED_PLACEHOLDERS)})")
            entries.append(AllowlistEntry(
                harness=harness,
                command=tuple(command),
                specialists=frozenset(s.strip() for s in specialists)))

        def _number(key: str, default: float, *, positive: bool) -> float:
            value = raw.get(key, default)
            try:
                value = float(value)
            except (TypeError, ValueError) as exc:
                raise ConfigError(f"{key} must be a number") from exc
            floor = 0.0 if positive else -1.0
            if value <= floor:
                kind = "positive" if positive else "non-negative"
                raise ConfigError(f"{key} must be {kind}")
            return value

        audit = raw.get("audit_path")
        lock = raw.get("lock_path")
        ca_bundle = str(raw.get("ca_bundle") or "").strip()
        if ca_bundle and not Path(ca_bundle).expanduser().is_file():
            raise ConfigError(f"ca_bundle not found: {ca_bundle}")
        return cls(
            board_url=board_url,
            executor_name=executor_name,
            allowlist=tuple(entries),
            poll_interval=_number("poll_interval", POLL_INTERVAL_DEFAULT,
                                  positive=True),
            poll_jitter=_number("poll_jitter", POLL_JITTER_DEFAULT,
                                positive=False),   # 0 = deterministic polls
            heartbeat_interval=_number("heartbeat_interval",
                                       HEARTBEAT_INTERVAL_DEFAULT,
                                       positive=True),
            ca_bundle=ca_bundle,
            executor_id=str(raw.get("executor_id") or "").strip()[:120],
            audit_path=Path(audit).expanduser() if audit
            else _state_dir() / "poller-audit.jsonl",
            lock_path=Path(lock).expanduser() if lock
            else _state_dir() / "poller.lock",
        )

    def resolve(self, harness: str, specialist: str) -> AllowlistEntry | None:
        """Allowlist filter (A3). None → skip + log, assignment stays queued."""
        for entry in self.allowlist:
            if entry.matches(harness, specialist):
                return entry
        return None


# ------------------------------------------------------------------- envelope
# Section detectors for the free-form task spec. Extraction is a convenience
# read; the verbatim snapshot at the bottom of the envelope is the truth.
_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s")
_GOAL_RE = re.compile(r"\b(goal|цель|задача)\b\s*:", re.IGNORECASE)
_AC_RE = re.compile(r"\b(acceptance(?:\s+criteria)?|критер\w*(?:\s+приёмк\w*)?)\b\s*:", re.IGNORECASE)
_DEPENDS_RE = re.compile(r"\b(depends(?:\s+on)?|зависимост\w*)\b\s*:", re.IGNORECASE)
_LIST_CONT_RE = re.compile(r"^\s*(?:[-*—]|\d+[.)])\s")


def _extract_section(text: str, pattern: re.Pattern[str],
                     max_lines: int = 60) -> str:
    """Heading line + following body until the section clearly ends (next
    markdown heading, or a blank line followed by non-list content)."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if pattern.search(line):
            taken = [line]
            j = i + 1
            while j < len(lines) and len(taken) < max_lines:
                if _HEADING_RE.match(lines[j]):
                    break
                if lines[j].strip() == "" and j + 1 < len(lines):
                    nxt = lines[j + 1]
                    if nxt.strip() != "" and not _LIST_CONT_RE.match(nxt) \
                            and not _HEADING_RE.match(nxt):
                        break  # blank line then a new paragraph → section end
                taken.append(lines[j])
                j += 1
            return "\n".join(taken).strip()
    return ""


def _first_sentence(text: str, cap: int = 200) -> str:
    for line in text.splitlines():
        stripped = line.strip().lstrip("#> ")
        if not stripped or _HEADING_RE.match(line):
            continue
        sentence = re.split(r"(?<=[.!?])\s", stripped, maxsplit=1)[0]
        return sentence[:cap]
    return ""


def _fence(text: str) -> str:
    """A markdown fence longer than any backtick run inside the payload —
    the snapshot is data and may itself contain fences."""
    longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
    return "`" * max(3, longest + 1)


def render_envelope(assignment: dict[str, Any], *, board_url: str,
                    executor_name: str) -> str:
    """Assignment envelope (ADR 0009 §5) — the canonical launch prompt.

    Rendered strictly from the claim response (spec_snapshot, A2): the live
    task spec is never read here. The machine token is deliberately not a
    parameter — it cannot leak into the prompt by construction; the child
    finds it in its inherited environment.
    """
    aid = assignment.get("id", "?")
    task_id = assignment.get("task_id", "?")
    memory_id = assignment.get("memory_id") or "-"
    snapshot = assignment.get("spec_snapshot") or ""
    spec_hash = assignment.get("spec_hash") or ""
    specialist = assignment.get("specialist") or "-"
    harness = assignment.get("harness") or "-"

    goal = (_extract_section(snapshot, _GOAL_RE)
            or _first_sentence(snapshot) or "(see SPEC SNAPSHOT below)")
    acceptance = (_extract_section(snapshot, _AC_RE)
                  or "(no explicit AC section — treat the SPEC SNAPSHOT "
                     "checklist as the acceptance criteria)")
    depends = _extract_section(snapshot, _DEPENDS_RE) or "—"
    fence = _fence(snapshot)
    return f"""[GCW ASSIGNMENT {aid} | task {task_id} | mnemos {memory_id}]
MODE: assignment-run
SPECIALIST: {specialist} (harness: {harness}, executor: {executor_name})

This is an assignment-launch: the MODE marker above is the only
legitimate sign of one. Work strictly from the SPEC SNAPSHOT at the
bottom — it is the immutable execution view taken at assignment
creation; do NOT re-read or re-fetch the live task spec.

GOAL: {goal}

ACCEPTANCE (verbatim from the snapshot):
{acceptance}

DEPENDS: {depends}

SCOPE: task {task_id} only, as specified in the snapshot. Anything
outside this scope is out of bounds — open a mnemos open-question
instead of doing it.

REPORTS (primary channel, ADR 0009 §7):
- intermediate report at every meaningful milestone;
- a final report is ALWAYS required before you exit 0;
- POST {board_url}/api/tasks/{task_id}/reports
  body: {{"kind": "intermediate"|"final", "body": "<report>", "agent": "{executor_name}"}};
- auth: Bearer token from the env var VESMARO_BOARD_TOKEN already set
  in your environment — never print, quote or log its value;
- budget: at most 30 reports per 60 s — batch your updates.

RIGHTS (WF-1 §4.2): work only on your own assigned tasks. Finishing
your work moves the task to resolved; acceptance (resolved → done) is
the owner's / Tech Lead's call — self-acceptance is forbidden.

ESCALATE: on a blocker you cannot resolve, exit non-zero with a short
reason as the last line of stderr — the poller reports it as the
assignment failure. Never hang waiting for input.

SPEC SNAPSHOT (verbatim; sha256 {spec_hash}):
{fence}
{snapshot}
{fence}
"""


# ---------------------------------------------------------------- board client
class BoardClient:
    """Thin HTTP face of the board's assignment/report API (machine class).

    ``transport`` is injectable for tests (httpx.MockTransport). Errors are
    typed: BoardError for transport/4xx-5xx, BoardConflict for 409 (the
    heartbeat kill-signal path depends on it).
    """

    def __init__(self, board_url: str, token: str, *,
                 transport: httpx.BaseTransport | None = None,
                 timeout: float = 10.0, verify: str | bool = True):
        if not token:
            raise ConfigError("machine token is empty")
        self._http = httpx.Client(
            base_url=board_url.rstrip("/"),
            headers={"Authorization": f"Bearer {token}"},
            transport=transport,
            timeout=httpx.Timeout(timeout),
            verify=verify,
        )

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "BoardClient":
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()

    def _request(self, method: str, path: str, *,
                 params: dict[str, str] | None = None,
                 json_body: dict[str, Any] | None = None) -> dict[str, Any]:
        try:
            resp = self._http.request(method, path, params=params, json=json_body)
        except httpx.HTTPError as exc:
            raise BoardError(0, path, f"transport: {exc}") from exc
        if resp.status_code == 409:
            raise BoardConflict(409, path, _detail(resp))
        if resp.status_code >= 400:
            raise BoardError(resp.status_code, path, _detail(resp))
        try:
            body = resp.json()
        except ValueError as exc:
            raise BoardError(resp.status_code, path,
                             "response is not JSON") from exc
        if not isinstance(body, dict):
            raise BoardError(resp.status_code, path, "response is not an object")
        return body

    @staticmethod
    def _field(body: dict[str, Any], key: str, path: str) -> Any:
        """Boundary check on board responses: a malformed 200 must surface
        as a typed BoardError, never as a KeyError crashing the loop."""
        if key not in body:
            raise BoardError(200, path, f"missing field: {key}")
        return body[key]

    # -- assignments -----------------------------------------------------
    def list_assignments(self, state: str) -> list[dict[str, Any]]:
        items = self._field(
            self._request("GET", "/api/assignments", params={"state": state}),
            "items", "/api/assignments")
        return [i for i in items if isinstance(i, dict)]

    def claim(self, assignment_id: int, claimed_by: str,
              executor_id: str = "") -> tuple[dict[str, Any], str]:
        path = f"/api/assignments/{assignment_id}/claim"
        body = self._request("POST", path,
                             json_body={"claimed_by": claimed_by,
                                        "executor_id": executor_id})
        return (self._field(body, "assignment", path),
                str(self._field(body, "claim_token", path)))

    def start(self, assignment_id: int, claim_token: str) -> dict[str, Any]:
        path = f"/api/assignments/{assignment_id}/start"
        return self._field(
            self._request("POST", path, json_body={"claim_token": claim_token}),
            "assignment", path)

    def heartbeat(self, assignment_id: int, claim_token: str,
                  note: str = "") -> None:
        self._request("POST", f"/api/assignments/{assignment_id}/heartbeat",
                      json_body={"claim_token": claim_token, "note": note})

    def complete(self, assignment_id: int, claim_token: str,
                 final_report: str = "") -> dict[str, Any]:
        path = f"/api/assignments/{assignment_id}/complete"
        return self._field(
            self._request("POST", path,
                          json_body={"claim_token": claim_token,
                                     "final_report": final_report}),
            "assignment", path)

    def fail(self, assignment_id: int, reason: str, *,
             claim_token: str = "", claimed_by: str = "") -> dict[str, Any]:
        path = f"/api/assignments/{assignment_id}/fail"
        return self._field(
            self._request("POST", path,
                          json_body={"reason": reason,
                                     "claim_token": claim_token,
                                     "claimed_by": claimed_by}),
            "assignment", path)

    # -- reports -----------------------------------------------------------
    def task_reports(self, task_id: str) -> list[dict[str, Any]]:
        return self._request("GET", f"/api/tasks/{task_id}/reports"
                              ).get("items", [])

    def post_report(self, task_id: str, kind: str, body: str,
                    agent: str) -> None:
        self._request("POST", f"/api/tasks/{task_id}/reports",
                      json_body={"kind": kind, "body": body, "agent": agent})


def _detail(resp: httpx.Response) -> str:
    try:
        text = resp.json().get("detail", resp.text)
    except ValueError:
        text = resp.text
    return str(text)[:300]


# ---------------------------------------------------------------- audit log
class AuditLog:
    """Append-only local launch log: {ts, assignment_id, specialist,
    spec_hash, pid, outcome} (ARCH-5 §4). One JSON per line."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, *, assignment_id: int, specialist: str, spec_hash: str,
               pid: int | None, outcome: str) -> None:
        record = {"ts": _now_iso(), "assignment_id": assignment_id,
                  "specialist": specialist, "spec_hash": spec_hash,
                  "pid": pid, "outcome": outcome}
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")

    def last_pid_for(self, assignment_id: int, *, scan: int = 400) -> int | None:
        """Most recent recorded pid for an assignment (orphan detection in
        the recovery sweep). Scans only the tail — the file grows forever."""
        try:
            with self.path.open("r", encoding="utf-8") as fh:
                tail = deque(fh, maxlen=scan)
        except FileNotFoundError:
            return None
        for line in reversed(tail):
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if rec.get("assignment_id") == assignment_id:
                pid = rec.get("pid")
                return int(pid) if pid else None
        return None


# ------------------------------------------------------------------ poller
@dataclass
class _Child:
    proc: subprocess.Popen
    assignment: dict[str, Any]       # claim-response shape (public fields)
    claim_token: str
    specialist: str
    spec_hash: str
    stdout_path: Path
    stderr_path: Path
    envelope_path: Path | None
    next_heartbeat: float
    finals_before: frozenset[int]
    finish_retries: int = 0
    finishing: str = ""              # "" | "complete:<rc>" | "fail:<rc>"


class AssignmentPoller:
    """The dispatcher loop. Single-threaded by design: poll → launch →
    heartbeat → reap, with an injectable board client and clock for tests."""

    def __init__(self, config: PollerConfig, board: BoardClient,
                 audit: AuditLog, *,
                 clock: Callable[[], float] = time.monotonic,
                 dry_run: bool = False):
        self.config = config
        self.board = board
        self.audit = audit
        self._clock = clock
        self.dry_run = dry_run
        self._children: dict[int, _Child] = {}
        self._refused: set[int] = set()   # allowlist-miss dedup (per process)
        self._stop = threading.Event()

    # -- lifecycle ---------------------------------------------------------
    def request_stop(self) -> None:
        self._stop.set()

    @property
    def active_assignment_ids(self) -> tuple[int, ...]:
        """Assignments currently supervised (for shutdown diagnostics)."""
        return tuple(self._children)

    def run(self, max_cycles: int | None = None) -> None:
        """Main loop; ``max_cycles=1`` bounds it to a single cycle. In
        dry-run mode nothing is mutated: the sweep is skipped and polling
        only logs launch decisions (no claims, no children — a child
        outliving the process would strand its claim token)."""
        if self.dry_run:
            log.info("dry-run: recovery sweep skipped (would fail own "
                     "claimed|running leftovers)")
        else:
            self.recovery_sweep()
        cycles = 0
        while not self._stop.is_set():
            self.step()
            cycles += 1
            if max_cycles is not None and cycles >= max_cycles:
                break
            self._sleep_poll()

    def step(self) -> None:
        self.send_heartbeats()
        self.reap()
        self.poll_once()

    def _sleep_poll(self) -> None:
        interval = self.config.poll_interval
        jitter = self.config.poll_jitter
        time.sleep(max(0.0, random.uniform(interval - jitter, interval + jitter)))

    # -- recovery sweep (ADR 0009 §4) ---------------------------------------
    def recovery_sweep(self) -> int:
        """On start: FAIL every own claimed|running record — unconditionally,
        there is no liveness check (after a restart the claim tokens are
        gone, so nothing could complete those assignments anyway; the
        at-most-once window closes here). Best-effort extra: when the
        audit log still names a pid for the assignment and it looks like
        one of OUR commands (exact argv0 basename), it gets SIGTERM
        first — a surviving orphan can never be completed and would only
        burn tokens."""
        swept = 0
        for state in ("claimed", "running"):
            try:
                items = self.board.list_assignments(state)
            except BoardError as exc:
                log.error("sweep: cannot list %s: %s", state, exc)
                return swept
            for a in items:
                if not isinstance(a.get("id"), int):
                    log.error("sweep: malformed assignment record skipped: %r",
                              sorted(a))
                    continue
                if a.get("claimed_by") != self.config.executor_name:
                    continue  # someone else's record — never touch it
                self._kill_orphan_if_ours(a)
                try:
                    self.board.fail(a["id"], SWEEP_FAIL_REASON,
                                    claimed_by=self.config.executor_name)
                except BoardConflict:
                    continue  # reaper/cancel raced us to the terminal state
                except BoardError as exc:
                    log.error("sweep: fail %s failed: %s", a["id"], exc)
                    continue
                swept += 1
                self.audit.append(assignment_id=a["id"],
                                  specialist=a.get("specialist") or "",
                                  spec_hash=a.get("spec_hash") or "",
                                  pid=None, outcome="sweep-failed")
                log.info("sweep: failed own %s assignment %s (task %s)",
                         state, a["id"], a.get("task_id"))
        if swept:
            log.info("recovery sweep: %d stale assignment(s) failed", swept)
        return swept

    def _kill_orphan_if_ours(self, assignment: dict[str, Any]) -> None:
        pid = self.audit.last_pid_for(assignment["id"])
        if not pid or pid == os.getpid():
            return
        entry = self.config.resolve(assignment.get("harness") or "",
                                    assignment.get("specialist") or "")
        expected = entry.command[0] if entry else sys.executable
        # Verify plausibility before signalling: a reused pid must never be
        # killed. argv0 = first NUL-separated /proc token; never logged.
        # EXACT basename equality — substring matching would let "zcode"
        # kill "zcode-helper".
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as fh:
                argv0 = fh.read().split(b"\0", 1)[0]
        except OSError:
            return  # gone (or not Linux) — nothing to kill
        if os.path.basename(argv0.decode(errors="replace")) != \
                os.path.basename(expected):
            return
        try:
            os.kill(pid, signal.SIGTERM)
            log.info("sweep: SIGTERM orphan pid %s (assignment %s)",
                     pid, assignment["id"])
        except ProcessLookupError:
            pass
        except PermissionError:
            log.warning("sweep: no permission to signal orphan pid %s", pid)

    # -- poll / launch (A2 + A3) -------------------------------------------
    def poll_once(self) -> None:
        try:
            queued = self.board.list_assignments("queued")
        except BoardError as exc:
            log.error("poll: %s", exc)
            return
        if self.dry_run:
            self._dry_run_decisions(queued)
            return
        for a in queued:
            if not isinstance(a.get("id"), int):
                log.error("poll: malformed assignment record skipped: %r",
                          sorted(a))
                continue
            if a["id"] in self._children:
                continue
            harness = a.get("harness") or ""
            specialist = a.get("specialist") or ""
            entry = self.config.resolve(harness, specialist)
            if entry is None:
                self._refuse(a, harness, specialist)
                continue
            try:
                assignment, claim_token = self.board.claim(
                    a["id"], claimed_by=self.config.executor_name,
                    executor_id=self.config.executor_id)
            except BoardConflict:
                log.info("poll: assignment %s scooped by another poller", a["id"])
                continue
            except BoardError as exc:
                log.error("poll: claim %s failed: %s", a["id"], exc)
                continue
            log.info("poll: claimed assignment %s (task %s, %s/%s)",
                     a["id"], assignment.get("task_id"), harness, specialist)
            self._launch(assignment, claim_token, entry)

    def _dry_run_decisions(self, queued: list[dict[str, Any]]) -> None:
        """--once smoke mode: log what WOULD happen per queued assignment.
        No claim, no launch, no report, no audit — dry-run never mutates
        board or local state (a spawned child outliving the process would
        strand the claim token with no one to complete it)."""
        for a in queued:
            if not isinstance(a.get("id"), int):
                continue
            harness = a.get("harness") or ""
            specialist = a.get("specialist") or ""
            entry = self.config.resolve(harness, specialist)
            if entry is None:
                log.info("dry-run: assignment %s (task %s) — allowlist miss "
                         "for %s/%s, would stay queued (fail-closed)",
                         a["id"], a.get("task_id"), harness, specialist)
            else:
                log.info("dry-run: assignment %s (task %s) — would claim as "
                         "%s and launch %s",
                         a["id"], a.get("task_id"),
                         self.config.executor_name, list(entry.command))

    def _refuse(self, assignment: dict[str, Any], harness: str,
                specialist: str) -> None:
        """A3 fail-closed: skip + log + ONE refusal report per process
        lifetime; the assignment stays queued for a configured executor."""
        if assignment["id"] in self._refused:
            return
        self._refused.add(assignment["id"])
        log.warning("poll: allowlist miss — harness %r specialist %r "
                    "(assignment %s stays queued, fail-closed)",
                    harness, specialist, assignment["id"])
        self.audit.append(assignment_id=assignment["id"],
                          specialist=specialist,
                          spec_hash=assignment.get("spec_hash") or "",
                          pid=None, outcome="refused")
        try:
            self.board.post_report(
                assignment["task_id"], "intermediate",
                f"poller {self.config.executor_name}: allowlist miss — "
                f"specialist '{specialist}' on harness '{harness}' is not in "
                f"the local allowlist; assignment left queued (fail-closed)",
                agent=self.config.executor_name)
        except BoardError as exc:
            log.error("poll: refusal report for %s failed: %s",
                      assignment["id"], exc)

    def _launch(self, assignment: dict[str, Any], claim_token: str,
                entry: AllowlistEntry) -> None:
        aid = assignment["id"]
        specialist = assignment.get("specialist") or ""
        # A2: the envelope is rendered from the claim response ONLY —
        # spec_snapshot, never the live spec.
        envelope = render_envelope(assignment,
                                   board_url=self.config.board_url,
                                   executor_name=self.config.executor_name)
        # Launch temp files live in the state dir (audit parent), NOT the
        # system tmp: they are launch artifacts, cleaned after the run.
        run_dir = self.config.audit_path.parent
        run_dir.mkdir(parents=True, exist_ok=True)
        envelope_path: Path | None = None
        out_fd = err_fd = -1
        out_name = err_name = ""
        try:
            subst = {"specialist": specialist, "envelope_file": ""}
            if any("{envelope_file}" in tok for tok in entry.command):
                fd, name = tempfile.mkstemp(prefix=f"assign-{aid}-",
                                            suffix=".md", dir=run_dir)
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    fh.write(envelope)
                envelope_path = Path(name)
                subst["envelope_file"] = name
            elif len(envelope.encode("utf-8")) > STDIN_ENVELOPE_CAP:
                # Would block the poller on the stdin pipe write — refuse
                # loudly instead of hanging (switch the template to
                # {envelope_file} delivery for payloads this big).
                reason = (f"launch refused: envelope "
                          f"{len(envelope.encode('utf-8'))} bytes exceeds "
                          f"stdin cap {STDIN_ENVELOPE_CAP} (use "
                          "{{envelope_file}} delivery)")
                log.error("launch %s: %s", aid, reason)
                try:
                    self.board.fail(aid, reason, claim_token=claim_token)
                except BoardConflict:
                    pass   # terminal already reached (cancel race)
                except BoardError as exc:
                    log.error("oversize-fail report for %s failed: %s",
                              aid, exc)
                self.audit.append(assignment_id=aid, specialist=specialist,
                                  spec_hash=assignment.get("spec_hash") or "",
                                  pid=None, outcome="launch-error")
                return
            # Trusted template from config + data values via str.format —
            # the snapshot NEVER passes through a shell or a template.
            argv = [tok.format(**subst) for tok in entry.command]
            out_fd, out_name = tempfile.mkstemp(prefix=f"assign-{aid}-out-",
                                                dir=run_dir)
            err_fd, err_name = tempfile.mkstemp(prefix=f"assign-{aid}-err-",
                                                dir=run_dir)
            proc = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE if envelope_path is None else subprocess.DEVNULL,
                stdout=out_fd,
                stderr=err_fd,
                env={key: os.environ[key] for key in CHILD_ENV_KEYS
                     if key in os.environ},   # minimal, unprivileged profile
                start_new_session=True,   # children survive terminal signals
            )
            os.close(out_fd)
            os.close(err_fd)
            out_fd = err_fd = -1
            if envelope_path is None:
                assert proc.stdin is not None
                try:
                    proc.stdin.write(envelope.encode("utf-8"))  # < 64K buffer
                except BrokenPipeError:
                    pass   # child died instantly; reap maps its exit code
                proc.stdin.close()
        except OSError as exc:
            for fd in (out_fd, err_fd):
                if fd >= 0:
                    os.close(fd)
            _cleanup_files(envelope_path, Path(out_name), Path(err_name))
            log.error("launch %s failed: %s", aid, exc)
            try:
                self.board.fail(aid, f"launch failed: {exc}",
                                claim_token=claim_token)
            except BoardError as exc2:
                log.error("launch-fail report for %s failed: %s", aid, exc2)
            self.audit.append(assignment_id=aid, specialist=specialist,
                              spec_hash=assignment.get("spec_hash") or "",
                              pid=None, outcome="launch-error")
            return
        try:
            self.board.start(aid, claim_token)
        except BoardError as exc:
            # The child is terminated AND the assignment must leave
            # 'claimed': the claim token lives only in this process and
            # nothing else (no reaper yet, poller scans only 'queued')
            # would ever move it — the task would lie in-progress forever.
            _terminate(proc)
            log.error("start %s failed: %s — child terminated, failing "
                      "assignment", aid, exc)
            try:
                self.board.fail(aid, f"start failed: {exc}",
                                claim_token=claim_token)
            except BoardConflict:
                pass   # already terminal server-side (cancel race)
            except BoardError as fail_exc:
                log.error("start-fail report for %s failed too: %s — the "
                          "recovery sweep will fail it on next start",
                          aid, fail_exc)
            self.audit.append(assignment_id=aid, specialist=specialist,
                              spec_hash=assignment.get("spec_hash") or "",
                              pid=proc.pid, outcome="start-failed")
            _cleanup_files(envelope_path, Path(out_name), Path(err_name))
            return
        # Snapshot the final-report ids now: a NEW final after exit means
        # the agent wrote its own (no server clock math needed).
        try:
            finals_before = _final_report_ids(
                self.board.task_reports(assignment["task_id"]),
                context=f"assignment {aid} start")
        except BoardError:
            finals_before = frozenset()   # complete falls back — safe side
        self._children[aid] = _Child(
            proc=proc, assignment=assignment, claim_token=claim_token,
            specialist=specialist,
            spec_hash=assignment.get("spec_hash") or "",
            stdout_path=Path(out_name), stderr_path=Path(err_name),
            envelope_path=envelope_path,
            next_heartbeat=self._clock() + self.config.heartbeat_interval,
            finals_before=finals_before)
        self.audit.append(assignment_id=aid, specialist=specialist,
                          spec_hash=assignment.get("spec_hash") or "",
                          pid=proc.pid, outcome="launched")
        log.info("launch: assignment %s → pid %s (%s)", aid, proc.pid, argv[0])

    # -- supervision (ADR 0009 §4) ------------------------------------------
    def send_heartbeats(self) -> None:
        """Poller-driven liveness ticks while the process is alive; a 409
        means the server moved the assignment on (expired/cancelled) —
        that IS the kill signal."""
        now = self._clock()
        for aid, child in list(self._children.items()):
            if now < child.next_heartbeat or child.finishing:
                continue
            child.next_heartbeat = now + self.config.heartbeat_interval
            try:
                self.board.heartbeat(aid, child.claim_token,
                                     note="poller alive")
            except BoardConflict as exc:
                log.warning("heartbeat %s → 409 (%s): killing child pid %s",
                            aid, exc.detail, child.proc.pid)
                _terminate(child.proc)
                self.audit.append(assignment_id=aid,
                                  specialist=child.specialist,
                                  spec_hash=child.spec_hash,
                                  pid=child.proc.pid, outcome="killed-409")
                _cleanup_files(child.envelope_path, child.stdout_path,
                               child.stderr_path)
                del self._children[aid]   # server-side state is already terminal
            except BoardError as exc:
                log.error("heartbeat %s failed (will retry): %s", aid, exc)

    def reap(self) -> None:
        """Map child exits onto the assignment lifecycle: exit 0 → complete
        (fallback final iff the agent wrote none), exit ≠0 → fail with the
        stderr tail. Transient board errors retry a bounded number of
        times — a finished run must not be silently lost."""
        for aid, child in list(self._children.items()):
            rc = child.proc.poll()
            if rc is None:
                continue
            if not child.finishing:
                child.finishing = "complete" if rc == 0 else f"fail:{rc}"
            try:
                if child.finishing == "complete":
                    self._complete(aid, child)
                else:
                    exit_code = int(child.finishing.split(":", 1)[1])
                    self._fail(aid, child, exit_code)
            except BoardConflict:
                # terminal already reached elsewhere (cancel/reaper) — done
                self._finish_child(aid, child,
                                   "complete-conflict"
                                   if child.finishing == "complete"
                                   else "fail-conflict")
            except BoardError as exc:
                child.finish_retries += 1
                if child.finish_retries >= FINISH_RETRIES:
                    log.critical("assignment %s finished but the board was "
                                 "not told after %d tries: %s",
                                 aid, child.finish_retries, exc)
                    self._finish_child(aid, child, "unreported")
                else:
                    log.error("reporting %s exit deferred (%d/%d): %s",
                              aid, child.finish_retries, FINISH_RETRIES, exc)

    def _complete(self, aid: int, child: _Child) -> None:
        try:
            finals_now = _final_report_ids(
                self.board.task_reports(child.assignment["task_id"]),
                context=f"assignment {aid} complete")
        except BoardError:
            finals_now = set(child.finals_before)  # cannot prove → fallback
        agent_wrote_final = bool(finals_now - child.finals_before)
        final_report = "" if agent_wrote_final else FALLBACK_FINAL_REPORT
        self.board.complete(aid, child.claim_token, final_report=final_report)
        self._finish_child(aid, child, "complete")

    def _fail(self, aid: int, child: _Child, exit_code: int) -> None:
        reason = f"process exit {exit_code}: {_tail(child.stderr_path)}"
        self.board.fail(aid, reason, claim_token=child.claim_token)
        self._finish_child(aid, child, "failed")

    def _finish_child(self, aid: int, child: _Child, outcome: str) -> None:
        self.audit.append(assignment_id=aid, specialist=child.specialist,
                          spec_hash=child.spec_hash, pid=child.proc.pid,
                          outcome=outcome)
        _cleanup_files(child.envelope_path, child.stdout_path,
                       child.stderr_path)
        del self._children[aid]
        log.info("supervise: assignment %s → %s", aid, outcome)


def _final_report_ids(reports: list[dict[str, Any]], *,
                      context: str) -> frozenset[int]:
    """Ids of kind='final' reports. Records without an int id are logged
    and skipped — a malformed item must surface as a warning, never as a
    KeyError crashing the supervision loop. A skipped record can only
    push the poller toward the fallback final (safe side)."""
    ids: set[int] = set()
    for record in reports:
        rid = record.get("id") if isinstance(record, dict) else None
        if isinstance(rid, int) and record.get("kind") == "final":
            ids.add(rid)
        elif not isinstance(rid, int):
            log.warning("%s: report record without int id skipped: %r",
                        context, sorted(record, key=str)[:8]
                        if isinstance(record, dict) else record)
    return frozenset(ids)


def _tail(path: Path, limit: int = STDERR_TAIL_CHARS) -> str:
    """Last ``limit`` chars of a utf-8 file, newlines flattened."""
    try:
        data = path.read_bytes()
        return data[-limit:].decode("utf-8", errors="replace").strip().replace("\n", " | ")
    except OSError:
        return ""


def _terminate(proc: subprocess.Popen) -> None:
    """SIGTERM the child's session, escalate to SIGKILL after the grace."""
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.terminate()
        except ProcessLookupError:
            return
    try:
        proc.wait(timeout=KILL_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.kill()
            except ProcessLookupError:
                pass


def _cleanup_files(*paths: Path | None) -> None:
    for path in paths:
        if path is None:
            continue
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:
            log.warning("cleanup %s failed: %s", path, exc)


def acquire_singleton_lock(lock_path: Path) -> "int | None":
    """fcntl.flock singleton (ADR 0009 §4). Returns the held fd or None."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    return fd


# ---------------------------------------------------------------------- main
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="vesmaro-eyes assignment poller (ADR 0009 phase 2)")
    parser.add_argument("--config", default=str(_config_dir() / "poller.yaml"),
                        help="path to poller.yaml (default: ~/.config/mnemos-eyes/poller.yaml)")
    parser.add_argument("--once", action="store_true",
                        help="single cycle in DRY-RUN mode: log the launch "
                             "decision per queued assignment, then exit — "
                             "no claims, no children, no board mutations")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    token = os.environ.get("VESMARO_BOARD_TOKEN", "").strip()
    if not token:
        log.error("VESMARO_BOARD_TOKEN is not set — refusing to start "
                  "(the machine token lives in the environment, never in "
                  "the config file)")
        return 2
    try:
        config = PollerConfig.from_file(args.config)
    except ConfigError as exc:
        log.error("config error: %s", exc)
        return 2

    lock_fd = acquire_singleton_lock(config.lock_path)
    if lock_fd is None:
        log.error("another poller holds %s — exiting", config.lock_path)
        return 3

    board = BoardClient(config.board_url, token,
                        verify=config.ca_bundle or True)
    audit = AuditLog(config.audit_path)
    poller = AssignmentPoller(config, board, audit, dry_run=args.once)

    def _on_signal(signum: int, _frame: Any) -> None:
        log.info("signal %s received — stopping after this cycle", signum)
        poller.request_stop()

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    log.info("poller start: board=%s executor=%s allowlist=%d entr(y/ies)",
             config.board_url, config.executor_name, len(config.allowlist))
    try:
        poller.run(max_cycles=1 if args.once else None)
    finally:
        for aid in poller.active_assignment_ids:
            log.warning("shutdown: assignment %s left running (recovery "
                        "sweep will fail it on next start)", aid)
        board.close()
        os.close(lock_fd)
    return 0


if __name__ == "__main__":
    sys.exit(main())
