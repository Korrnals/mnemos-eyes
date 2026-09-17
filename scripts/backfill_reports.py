#!/usr/bin/env python3
"""backfill_reports — one-shot backfill of agent reports for closed tasks.

For every done/resolved task (live or archived) that has no reports yet,
Store.backfill_reports() inserts exactly one kind="final" report
(agent="history-backfill") summarizing the task's audit events, dated with
the task's last event (never "now").

Idempotent, two layers:
- the "reports_backfill" board_meta flag: a completed run arms it, and any
  further run is a no-op;
- tasks that already carry reports are never touched, even if the flag was
  cleared.

Run once in the deploy window against the production volume:

    VESMARO_DATA=/data python3 scripts/backfill_reports.py

The same backfill can alternatively be triggered on app startup with
VESMARO_BACKFILL_REPORTS=1 (lifespan hook in server/app.py) — pick one
invocation path, not both.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# allow running from any cwd: python3 scripts/backfill_reports.py
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.store import Store  # noqa: E402


def main() -> int:
    data_dir = Path(os.environ.get("VESMARO_DATA", "/data"))
    db_path = data_dir / "board.db"
    if not db_path.exists():
        print(f"error: board DB not found at {db_path} (set VESMARO_DATA)",
              file=sys.stderr)
        return 1
    store = Store(db_path)
    if store.get_meta(Store.BACKFILL_META_KEY) == "1":
        print("backfill: already ran (reports_backfill=1) — nothing to do")
        return 0
    created = store.backfill_reports()
    print(f"backfill: created {created} final report(s); "
          f"flag {Store.BACKFILL_META_KEY}=1 armed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
