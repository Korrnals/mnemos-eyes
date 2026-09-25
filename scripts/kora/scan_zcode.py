#!/usr/bin/env python3
"""Kora zcode scanner — host-side listing push (ADR 0019, slice 1).

The poller-family host module: reads the local zcode store STRICTLY
read-only (server/kora/zcode_reader.py — mode=ro + WAL-snapshot-fallback
on the cold start) and upserts the session listing onto the board:

  POST {board_url}/api/executors/{executor_id}/kora-scan
       body {"sessions": [...], "drop_missing": true}

Auth: Bearer $VESMARO_BOARD_TOKEN (env only, the poller discipline —
never in a config file, never in a log line) or an executor token via
$VESMARO_EXECUTOR_TOKEN (the mesh leg; the board binds the ingest to
the token identity and 403s a mismatch).

One-shot by design for slice 1: the systemd timer/unit wiring belongs to
the NEXT slice (the owner directive: no systemd installs mid-slice; this
script is a manual/profiling run now and the timer target later).

Idempotency: a replayed scan is a no-op upsert of identical values —
the registry converges to the store's listing, never duplicates.

Exit codes: 0 = pushed (even an empty listing — an honest empty scan);
1 = configuration error; 2 = store unreadable; 3 = board rejected.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))

from server.kora.zcode_reader import (  # noqa: E402  (path bootstrap above)
    ReaderError,
    scan_zcode_store,
)

log = logging.getLogger("kora.scan-zcode")

DEFAULT_BOARD_URL = "https://board.local"   # overridden by --board-url


class ScannerConfigError(RuntimeError):
    """Bad CLI/env combination — refuse to start (fail-closed)."""


class BoardPushError(RuntimeError):
    """The board rejected the scan (typed; the status code rides along)."""

    def __init__(self, status: int, detail: str):
        super().__init__(f"board {status}: {detail}")
        self.status = status


def _token() -> str:
    token = (os.environ.get("VESMARO_EXECUTOR_TOKEN")
             or os.environ.get("VESMARO_BOARD_TOKEN") or "").strip()
    if not token:
        raise ScannerConfigError(
            "no token: set VESMARO_EXECUTOR_TOKEN (preferred) or "
            "VESMARO_BOARD_TOKEN in the environment — never in a file")
    return token


def push_scan(board_url: str, executor_id: str, sessions: list[dict],
              *, drop_missing: bool = True, token: str = "",
              transport: httpx.BaseTransport | None = None,
              timeout: float = 30.0, verify: str | bool = True) -> dict:
    """Upsert the listing on the board. Returns the ingest verdict
    (scanned/upserted/listed/dropped). ``transport`` is the test seam
    (httpx.MockTransport — the poller BoardClient pattern)."""
    token = token or _token()
    url = board_url.rstrip("/") + f"/api/executors/{executor_id}/kora-scan"
    body = {"sessions": sessions, "drop_missing": drop_missing}
    try:
        with httpx.Client(transport=transport, timeout=timeout,
                          verify=verify) as client:
            resp = client.post(
                url, json=body,
                headers={"Authorization": f"Bearer {token}"})
    except httpx.HTTPError as exc:
        raise BoardPushError(0, f"transport: {exc}") from exc
    if resp.status_code >= 400:
        raise BoardPushError(resp.status_code, resp.text[:300])
    try:
        verdict = resp.json()
    except ValueError as exc:
        raise BoardPushError(resp.status_code, "response is not JSON") from exc
    if not isinstance(verdict, dict) or "upserted" not in verdict:
        raise BoardPushError(resp.status_code, "malformed ingest verdict")
    return verdict


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Kora slice-1 zcode scanner: read-only store listing "
                    "pushed to the board registry (ADR 0019).")
    parser.add_argument("--board-url", default=os.environ.get(
        "VESMARO_BOARD_URL", DEFAULT_BOARD_URL),
        help="board base URL (env VESMARO_BOARD_URL)")
    parser.add_argument("--executor-id", required=True,
        help="executor registry id (ex-…); the ingest binds to it")
    parser.add_argument("--db", default=None,
        help="zcode db.sqlite path (default: ~/.zcode/cli/db/db.sqlite)")
    parser.add_argument("--keep-missing", action="store_true",
        help="delta push: do NOT drop registry rows the scan missed")
    parser.add_argument("--dry-run", action="store_true",
        help="scan only; print the listing summary, no board push")
    parser.add_argument("--ca-bundle", default="",
        help="lab CA bundle path for self-signed board TLS (poller parity)")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    verify: str | bool = args.ca_bundle or True
    if args.ca_bundle and not os.path.isfile(args.ca_bundle):
        print(f"ca bundle not found: {args.ca_bundle}", file=sys.stderr)
        return 1

    try:
        result = scan_zcode_store(args.db) if args.db else scan_zcode_store()
    except ReaderError as exc:
        log.error("store scan failed: %s", exc)
        return 2
    states: dict[str, int] = {}
    for row in result.sessions:
        states[row["state"]] = states.get(row["state"], 0) + 1
    log.info("scanned %d zcode sessions (%s) via_fallback=%s store=%s",
             len(result.sessions), states, result.via_fallback,
             result.store_path)
    if args.dry_run:
        print(f"dry-run: {len(result.sessions)} sessions "
              f"({states}), fallback={result.via_fallback}")
        return 0
    try:
        verdict = push_scan(args.board_url, args.executor_id,
                            result.sessions,
                            drop_missing=not args.keep_missing,
                            verify=verify)
    except ScannerConfigError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except BoardPushError as exc:
        log.error("board rejected the scan: %s", exc)
        return 3
    log.info("board verdict: %s", verdict)
    print(f"pushed {verdict.get('scanned', 0)} sessions: {verdict}")
    return 0


if __name__ == "__main__":
    sys.exit(main())