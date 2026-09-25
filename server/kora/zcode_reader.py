"""zcode store reader — STRICTLY read-only (ADR 0019 §6 gate 8).

The one module that opens the harness store. Disciplines:

- ``mode=ro`` URI open, ALWAYS. A write through this reader is a bug:
  sqlite itself refuses (``attempt to write a readonly database``).
- WAL-snapshot-fallback on the cold start: when the store directory has no
  ``-shm`` (no live harness process has initialized the shared-memory
  index), a read-only open of a WAL database fails with
  ``SQL_READONLY_CANTINIT`` (cannot build the shm without write access).
  The fallback copies ``db.sqlite`` + ``db.sqlite-wal`` into a tmpdir and
  reads the COPY — reading through a snapshot, never opening the store
  for write (the copy is a read of the store files, not a write to it).
- No rollout/model-io: the listing reads the ``session`` table only.
  Previews read the newest ``text`` part of the session (``part`` table,
  JSON), capped and redacted upstream.

Schema facts (verified read-only against the live store 2026-09-25,
docs/cortex-workspace-facts §2):
- session(id TEXT PK, parent_id, directory, title, task_type,
  time_created/time_updated INTEGER epoch-ms)
- part(id, message_id, session_id, time_created, sequence, data JSON;
  data.type='text' carries data.text)

Session liveness (heuristic, honest): ``time_updated`` within the
presence window (default 2h, the ADR's presence discipline) → ``live``;
else ``idle``; archived sessions (time_archived NOT NULL) → ``dead`` —
dead rows STAY in the registry (recovery semantics, contract note).
Subagent sessions (id LIKE 'sess_subagent%') are folded into their
parent: a subagent row is not an independent workspace session for the
owner's list — the parent's time_updated already accounts for the work.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import sqlite3
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

log = logging.getLogger("kora.zcode-reader")

DEFAULT_DB_PATH = "~/.zcode/cli/db/db.sqlite"
# Presence window (seconds) — the ADR's two-hour presence discipline,
# applied to SESSION liveness (presence ≠ liveness: executor presence is
# a separate registry clock).
LIVE_WINDOW_SECONDS = 2 * 60 * 60


class ReaderError(RuntimeError):
    """Base — every reader failure is typed, never a bare raise."""


class StoreNotFoundError(ReaderError):
    """The zcode store file does not exist at the expected path."""


class StoreUnreadableError(ReaderError):
    """The store exists but could not be opened read-only even via the
    WAL snapshot fallback."""


def _ro_uri(path: Path) -> str:
    return f"file:{path}?mode=ro"


def _epoch_ms_to_iso(value: int | None) -> str:
    """epoch-ms (zcode time_*) → RFC 3339 seconds, UTC (contract format).
    Empty string when None/0 (the contract's nullable timestamps)."""
    if not value:
        return ""
    try:
        return datetime.fromtimestamp(
            value / 1000.0, tz=timezone.utc).isoformat(timespec="seconds")
    except (ValueError, OverflowError, OSError):
        return ""


@dataclass(frozen=True)
class ZcodeScanResult:
    """One listing scan: rows for the registry + scan diagnostics."""
    sessions: list[dict[str, Any]]
    scanned_at: str
    store_path: str
    via_fallback: bool


def _connect_ro(db_path: Path) -> tuple[sqlite3.Connection, bool]:
    """Open the store read-only; on the cold-start WAL failure fall back
    to a tmp snapshot copy. Returns (connection, via_fallback). The
    caller closes the connection; a fallback copy is removed on close."""
    if not db_path.is_file():
        raise StoreNotFoundError(f"zcode store not found: {db_path}")
    try:
        con = sqlite3.connect(_ro_uri(db_path), uri=True, timeout=5.0)
        con.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
        return con, False
    except sqlite3.Error as exc:
        # Cold start (no -shm) or any other ro-open failure → snapshot.
        log.info("ro open failed (%s); falling back to WAL snapshot "
                 "copy", exc)
    tmpdir = tempfile.mkdtemp(prefix="kora-zcode-ro-")
    copy = Path(tmpdir) / db_path.name
    try:
        shutil.copyfile(db_path, copy)
        wal = db_path.parent / (db_path.name + "-wal")
        if wal.is_file():
            shutil.copyfile(wal, Path(tmpdir) / wal.name)
            # A -shm of the ORIGINAL must never ride along: the snapshot
            # builds its own shared memory from db+wal.
    except OSError as exc:
        raise StoreUnreadableError(
            f"cannot snapshot the zcode store: {exc}") from exc
    try:
        con = sqlite3.connect(_ro_uri(copy), uri=True, timeout=5.0)
        con.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
    except sqlite3.Error as exc:
        con.close() if "con" in dir() else None
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise StoreUnreadableError(
            f"zcode store unreadable even via snapshot: {exc}") from exc
    # The connection owns its tmpdir now: remove on close. sqlite3 has no
    # close hook, so the caller MUST call close_snapshot(con, tmpdir).
    con._kora_tmpdir = tmpdir  # type: ignore[attr-defined]
    return con, True


def close_ro(con: sqlite3.Connection) -> None:
    """Close a reader connection; removes the fallback tmpdir if any."""
    tmpdir = getattr(con, "_kora_tmpdir", None)
    con.close()
    if tmpdir:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _last_text_preview(con: sqlite3.Connection, session_id: str) -> str:
    """Newest text part of the session (raw; the caller redacts). Cap at
    400 chars here — the registry column bound is 2000, the serving path
    clamps to 160 anyway, and 400 keeps the ingest payload lean."""
    rows = con.execute(
        "SELECT data FROM part WHERE session_id=? "
        "ORDER BY time_created DESC LIMIT 40",
        (session_id,)).fetchall()
    for raw in rows:
        try:
            data = json.loads(raw[0])
        except (ValueError, TypeError):
            continue
        if isinstance(data, dict) and data.get("type") == "text":
            text = data.get("text")
            if isinstance(text, str) and text.strip():
                return text.strip()[:400]
    return ""


def scan_zcode_store(db_path: str | Path = DEFAULT_DB_PATH,
                     *, now: float | None = None,
                     live_window_seconds: int = LIVE_WINDOW_SECONDS,
                     include_subagents: bool = False) -> ZcodeScanResult:
    """One read-only listing scan of a zcode store.

    Returns registry-ready rows: native_id, harness='zcode',
    project/cwd (from directory), state (live/idle/dead heuristic),
    origin='local' (slice-1 scanner sees local sessions only), started_at
    / last_activity_at ISO, preview (RAW — redaction is the board's
    serving choke-point; the ingest transport is authenticated TLS of the
    poller family and the column bound caps the payload).

    Archived sessions are ALWAYS listed as ``dead`` — the contract's
    recovery semantics (``dead`` keeps the session in the registry and
    visible); the ADR's «владелец видит, что происходило» forbids hiding
    archived history from the slice-1 list.
    """
    path = Path(os.path.expanduser(str(db_path)))
    con, via_fallback = _connect_ro(path)
    try:
        now = now if now is not None else datetime.now(timezone.utc).timestamp()
        rows: list[dict[str, Any]] = []
        cur = con.execute(
            "SELECT id, parent_id, directory, title, time_created, "
            "time_updated, time_archived FROM session "
            "WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 2000")
        for sid, _parent, directory, title, tc, tu, tarch in cur.fetchall():
            if sid.startswith("sess_subagent") and not include_subagents:
                continue  # folded into the parent session
            if tarch is not None:
                state = "dead"
            elif (tu or 0) / 1000.0 >= now - live_window_seconds:
                state = "live"
            else:
                state = "idle"
            preview = _last_text_preview(con, sid)
            rows.append({
                "native_id": sid,
                "harness": "zcode",
                "project": (directory or "").rstrip("/").rsplit("/", 1)[-1],
                "cwd": directory or "",
                "state": state,
                "origin": "local",
                "steerable": False,  # local sessions: adoption is slice 3
                "started_at": _epoch_ms_to_iso(tc),
                "last_activity_at": _epoch_ms_to_iso(tu),
                "preview": preview,
            })
        return ZcodeScanResult(
            sessions=rows,
            scanned_at=datetime.now(timezone.utc).isoformat(
                timespec="seconds"),
            store_path=str(path),
            via_fallback=via_fallback)
    finally:
        close_ro(con)