"""zcode store reader integration tests (Kora slice 1, ADR 0019 gate 8).

The reader contract (server/kora/zcode_reader.py):
- STRICTLY read-only: mode=ro open; a write attempt through the reader
  connection FAILS (anti-write test, the ADR's «анти-write-тесты» on
  every reader family);
- WAL-snapshot-fallback: when the store directory carries no -shm (cold
  start), the read succeeds via a tmp copy — never an open-for-write;
- the listing maps the store's schema (session time_* epoch-ms → ISO,
  subagent sessions folded into parents, archived → dead);
- previews pull the newest text part.

The fixture builds a SYNTHETIC mini-store (the real schema — columns
verified read-only against the live store 2026-09-25 — in a tiny file;
no owner data is copied anywhere).
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path

import pytest

from server.kora.zcode_reader import (
    LIVE_WINDOW_SECONDS,
    _ro_uri,
    StoreNotFoundError,
    close_ro,
    scan_zcode_store,
)

# The store schema the reader depends on (live-store-verified subset).
_SCHEMA = """
CREATE TABLE session (
    id            TEXT PRIMARY KEY,
    parent_id     TEXT,
    directory     TEXT NOT NULL,
    title         TEXT NOT NULL,
    time_created  INTEGER NOT NULL,
    time_updated  INTEGER NOT NULL,
    time_archived INTEGER
);
CREATE TABLE part (
    id           TEXT PRIMARY KEY,
    message_id   TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    data         TEXT NOT NULL
);
"""

NOW_MS = int(time.time() * 1000)
HOUR_MS = 3600 * 1000


def _iso_ts(ms: int) -> str:
    # helper: the reader emits ISO; tests assert against epoch-derived ISO
    return time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(ms / 1000))


@pytest.fixture()
def store(tmp_path: Path) -> Path:
    db = tmp_path / "db.sqlite"
    con = sqlite3.connect(db)
    con.executescript(_SCHEMA)
    # parent session, live (updated minutes ago)
    con.execute(
        "INSERT INTO session VALUES (?,?,?,?,?,?,NULL)",
        ("sess_live", None, "/proj/demo", "Живая сессия",
         NOW_MS - 5 * HOUR_MS, NOW_MS - 10 * 60 * 1000))
    # parent session, idle (updated days ago)
    con.execute(
        "INSERT INTO session VALUES (?,?,?,?,?,?,NULL)",
        ("sess_idle", None, "/proj/old", "Старая сессия",
         NOW_MS - 100 * HOUR_MS, NOW_MS - 50 * HOUR_MS))
    # archived parent → dead
    con.execute(
        "INSERT INTO session VALUES (?,?,?,?,?,?,?)",
        ("sess_dead", None, "/proj/arch", "Архив",
         NOW_MS - 200 * HOUR_MS, NOW_MS - 150 * HOUR_MS,
         NOW_MS - 100 * HOUR_MS))
    # subagent child of the live session (folded — NOT listed)
    con.execute(
        "INSERT INTO session VALUES (?,?,?,?,?,?,NULL)",
        ("sess_subagent_agent_x", "sess_live", "/proj/demo", "сабагент",
         NOW_MS - HOUR_MS, NOW_MS - 30 * 60 * 1000))
    # previews: newest-first text parts on the live session
    con.execute(
        "INSERT INTO part VALUES ('p2','m1','sess_live',?,?)",
        (NOW_MS - 60 * 1000,
         json.dumps({"type": "text", "text": "новейшая строка"})))
    con.execute(
        "INSERT INTO part VALUES ('p1','m0','sess_live',?,?)",
        (NOW_MS - 2 * HOUR_MS,
         json.dumps({"type": "text", "text": "старая строка"})))
    # non-text parts must be skipped
    con.execute(
        "INSERT INTO part VALUES ('p3','m2','sess_live',?,?)",
        (NOW_MS - 30 * 1000,
         json.dumps({"type": "step-start"})))
    con.commit()
    con.close()
    # WAL sidecar so the DB has something to recover via -wal on the
    # fallback path too (the reader copies db + wal when present).
    wal_con = sqlite3.connect(db)
    wal_con.execute("PRAGMA journal_mode=WAL")
    wal_con.execute(
        "INSERT INTO part VALUES ('p4','m3','sess_live',?,?)",
        (NOW_MS - 5 * 1000,
         json.dumps({"type": "text", "text": "из wal"})))
    wal_con.commit()
    wal_con.close()
    # leave the -wal/-shm pair behind: WAL mode creates them on commit;
    # the checkpoint on close may fold the wal back — both are fine for
    # the reader (mode=ro or the snapshot fallback).
    return db


class TestScan:
    def test_listing_maps_the_store(self, store: Path):
        result = scan_zcode_store(store, now=time.time())
        by_id = {r["native_id"]: r for r in result.sessions}
        assert set(by_id) == {"sess_live", "sess_idle", "sess_dead"}
        live = by_id["sess_live"]
        assert live["harness"] == "zcode"
        assert live["project"] == "demo"
        assert live["cwd"] == "/proj/demo"
        assert live["state"] == "live"
        assert live["origin"] == "local"
        assert live["steerable"] is False
        assert live["started_at"].startswith("20")
        assert live["preview"] == "из wal"  # newest text part incl. WAL tail
        idle = by_id["sess_idle"]
        assert idle["state"] == "idle"
        dead = by_id["sess_dead"]
        assert dead["state"] == "dead"  # archived, stays in the registry

    def test_subagents_folded_into_parent(self, store: Path):
        result = scan_zcode_store(store, now=time.time())
        assert not any(r["native_id"].startswith("sess_subagent")
                       for r in result.sessions)

    def test_live_window_heuristic(self, store: Path):
        # 2h window: an update exactly inside is live, outside is idle.
        result = scan_zcode_store(store, now=time.time())
        assert result.sessions[0]["state"] in ("live", "idle", "dead")
        # deterministic re-check of the boundary with a pinned now:
        now = time.time()
        r = scan_zcode_store(store, now=now + 3 * LIVE_WINDOW_SECONDS,
                             live_window_seconds=LIVE_WINDOW_SECONDS)
        by_id = {x["native_id"]: x for x in r.sessions}
        assert by_id["sess_live"]["state"] == "idle"

    def test_missing_store_raises_typed(self, tmp_path: Path):
        with pytest.raises(StoreNotFoundError):
            scan_zcode_store(tmp_path / "nope.sqlite")

    def test_cold_start_wal_fallback_forced(self, store: Path,
                                            tmp_path: Path):
        """P3 (slice-1 review): the fallback path must be FORCED, not
        hoped for. The true cold start (ADR: SQL_READONLY_CANTINIT) =
        a -wal tail, NO -shm, and a directory the reader cannot write —
        a direct mode=ro open then fails and the snapshot copy resolves
        the listing. Asserts: tmpdir RETURNED by _connect_ro (the
        con-attribute path is dead — sqlite3.Connection has no
        __dict__), the snapshot carries db+wal, close_ro removes it."""
        import os
        import shutil as _sh
        from server.kora.zcode_reader import _connect_ro, close_ro
        # Build the cold shape in a fresh dir: db + wal, NO shm, 0555.
        cold = tmp_path / "cold"
        cold.mkdir()
        writer = sqlite3.connect(store)
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("INSERT INTO session VALUES "
                       "('sess_wal_tail', NULL, '/proj/w', 'w', 1, 1, NULL)")
        writer.commit()
        _sh.copyfile(store, cold / store.name)
        wal_src = store.parent / (store.name + "-wal")
        assert wal_src.is_file(), "open writer must keep the -wal alive"
        _sh.copyfile(wal_src, cold / wal_src.name)
        writer.close()
        cold_db = cold / store.name
        os.chmod(cold, 0o555)
        try:
            # direct ro open MUST fail here (no shm, unwritable dir)
            probe = sqlite3.connect(_ro_uri(cold_db), uri=True)
            probe.execute("SELECT 1 FROM sqlite_master LIMIT 1")
            probe.close()
            raise AssertionError("cold shape did not force CANTINIT — "
                                 "the fixture lost its forcing power")
        except sqlite3.OperationalError:
            pass  # the expected failure — now the reader's turn
        con, tmpdir = _connect_ro(cold_db)
        assert tmpdir is not None, (
            "forced snapshot path — tmpdir must be returned")
        try:
            rows = con.execute(
                "SELECT COUNT(*) FROM session").fetchone()[0]
            assert rows == 5  # fixture 4 + the wal_tail row
            snap = Path(tmpdir)
            assert (snap / store.name).is_file()
            assert (snap / wal_src.name).is_file()
        finally:
            close_ro(con, tmpdir)
        assert not Path(tmpdir).exists(), (
            "close_ro must remove the snapshot tmpdir")

    def test_direct_path_returns_none_tmpdir(self, store: Path):
        """P3 contract, direct leg: a healthy store (shm live) opens
        without the fallback — tmpdir MUST be None and close_ro with
        None is a plain close (the caller's finally always runs)."""
        from server.kora.zcode_reader import _connect_ro, close_ro
        con, tmpdir = _connect_ro(store)
        try:
            assert tmpdir is None, "healthy store must not snapshot"
        finally:
            close_ro(con, tmpdir)


class TestAntiWrite:
    def test_reader_connection_is_read_only(self, store: Path):
        """The ADR's anti-write invariant: any write through the reader
        connection must FAIL (sqlite: 'attempt to write a readonly
        database'). The reader never opens the store for write."""
        from server.kora.zcode_reader import _connect_ro
        con, _tmpdir = _connect_ro(store)
        try:
            with pytest.raises(sqlite3.OperationalError):
                con.execute(
                    "INSERT INTO session VALUES ('x',NULL,'/x','x',1,1,NULL)")
            with pytest.raises(sqlite3.OperationalError):
                con.execute("UPDATE session SET title='x'")
            with pytest.raises(sqlite3.OperationalError):
                con.execute("DELETE FROM session")
            with pytest.raises(sqlite3.OperationalError):
                con.execute(
                    "CREATE TABLE evil (id TEXT)")
        finally:
            close_ro(con, _tmpdir)

    def test_scan_does_not_mutate_store(self, store: Path):
        before = store.read_bytes()
        scan_zcode_store(store, now=time.time())
        after = store.read_bytes()
        assert before == after, "the store file must be byte-identical"