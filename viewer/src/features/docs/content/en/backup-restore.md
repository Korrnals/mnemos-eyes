---
title: Backup and restore
slug: backup-restore
category: maintenance
order: 1
last_verified: "1.19.0"
---

# Backup and restore

Everything the system accumulates lives in several SQLite databases: the
board's tasks in `board.db` on the cluster PVC, the memory in `mnemos.db`
and `vectors.db` on the cluster and on the laptop. A volume failure, a
bad upgrade or an accidental deletion costs less than a backup. This
page is about how to copy, where to keep the copies, and how to put them
back.

## What to copy

| Database | Where it lives | What is inside |
| --- | --- | --- |
| `board.db` | the board's PVC in the cluster + a local copy on a work machine | tasks, history, assignments, the store registry |
| `mnemos.db` + `vectors.db` (cluster) | the mnemos PVC | the cluster's memory |
| `mnemos.db` + `vectors.db` (laptop) | `~/.mnemos/data` | the local memory |

Copy all of it at once: the ready-made script does it in one command.

## Back up in one command

The repository ships `scripts/backup-all.sh`. It takes consistent
snapshots of every database via `sqlite3 .backup`, verifies each copy
(`PRAGMA integrity_check`), computes checksums, and writes a manifest:

```bash
scripts/backup-all.sh                  # today's copy
scripts/backup-all.sh 2026-09-22       # a copy with an explicit date
```

The result is a directory like `$VESMARO_BACKUP_ROOT/2026-09-22/` with
three subdirectories (`laptop`, `cluster`, `board`), a `SHA256SUMS` file
and a `MANIFEST.txt`. The copies root comes from the
`VESMARO_BACKUP_ROOT` variable (by default, a `backups` directory next
to your projects); adjust the paths for your machine in the script's
header.

The copy happens without stopping the board: `.backup` reads the
database consistently while writers keep writing.

## Copy on a schedule

- Minimum — before every board upgrade and before any manual cluster
  intervention: see [Upgrading the board](upgrade.md).
- A good habit is a nightly run on a schedule:

  ```bash
  # crontab -e
  15 3 * * * /path/to/repo/scripts/backup-all.sh >> /tmp/backup-all.log 2>&1
  ```

- Keep copies on another disk or machine: a backup next to the original
  dies in the same failure as the original.

## Restore the board database

Every file in a copy is a plain SQLite database. Restore goes straight
into the live database through a consistent `.backup` operation — no
long downtime.

1. Verify the copy before installing it:

   ```bash
   python3 -c "import sqlite3; \
     print(sqlite3.connect('board-cluster.db') \
     .execute('PRAGMA integrity_check').fetchone())"
   ```

   The expected answer is `ok`.

2. Find the board pod and load the copy into a temporary directory:

   ```bash
   POD=$(kubectl -n kube-agents get pod \
     -l app.kubernetes.io/name=vesmaro-eyes \
     -o jsonpath='{.items[0].metadata.name}')
   kubectl -n kube-agents cp board-cluster.db "$POD":/tmp/board.db
   ```

3. Restore the contents into the live database and check the result:

   ```bash
   kubectl -n kube-agents exec "$POD" -- python -c "
   import sqlite3
   src = sqlite3.connect('/tmp/board.db')
   dst = sqlite3.connect('/data/board.db')
   src.backup(dst)
   print(dst.execute('PRAGMA integrity_check').fetchone())
   "
   ```

   The expected output is `('ok',)`.

4. Restart the board so every connection opens on the restored database,
   and verify:

   ```bash
   kubectl -n kube-agents rollout restart deployment/vesmaro-eyes
   kubectl -n kube-agents rollout status deployment/vesmaro-eyes
   curl -ksS https://board.example.com/api/health | head -c 400
   ```

5. Open the board and make sure the tasks and history are back. The
   temporary file in the pod can be deleted.

`helm rollback` reverts only the release manifests — it does not restore
data. Restoring data is always putting a file back from a copy.

## Restore the mnemos memory

The same order, different database owners:

- The cluster mnemos: copy `mnemos.db` and `vectors.db` from the backup
  onto its PVC with the mnemos pod stopped, then start it and check
  `integrity_check`. Do not touch the mnemos Helm release during this
  window.
- The laptop one: stop the local mnemos, put the files back into
  `~/.mnemos/data`, start it.

Deeper into the mnemos databases themselves — the imported upstream
runbook: [mnemos backup and
restore](/docs/mnemos/admin/runbooks/backup-restore).

## Restore drills

A backup that has never been restored is a hypothesis. Once every
couple of months, rehearse: bring a `board.db` copy up in a temporary
pod or on a test machine, make sure the board opens and the tasks are
there, and write down how long it took.

## See also

- [Upgrading the board](upgrade.md)
- [Troubleshooting](troubleshooting.md)
- [Deployment and first launch](deploy.md)
- [mnemos backup and restore — the upstream runbook](/docs/mnemos/admin/runbooks/backup-restore)
