#!/usr/bin/env bash
# vesmaro-eyes — daily backups of ALL memory stores + board DBs.
#
#   scripts/backup-all.sh [DEST_DIR]
#
# Backs up (consistent SQLite snapshots, integrity-checked):
#   1. laptop mnemos store   (~/.distrobox/vscode-box/home/.mnemos/data)
#   2. cluster mnemos store  (k3s PVC agentsnode-mnemos-data, via kubectl exec)
#   3. board DBs             (cluster PVC + local ./data)
#
# Restore hint: each file is a plain SQLite DB — restore = stop the writer,
# copy back (or open and .backup into the live file), run PRAGMA integrity_check.
set -euo pipefail

TODAY="${1:-$(date +%F)}"
ROOT="${VESMARO_BACKUP_ROOT:-/var/home/abyss/LABs/Projects/Project-Mnemos/backups}"
BK="$ROOT/$TODAY"
PY=python3
MNEMOS_CLI=/var/home/abyss/.distrobox/ubuntu/home/.local/bin/mnemos
LAPTOP_DATA=/var/home/abyss/.distrobox/vscode-box/home/.mnemos/data
NS=kube-agents

mkdir -p "$BK/laptop" "$BK/cluster" "$BK/board"

echo "── 1. laptop mnemos store"
$PY - "$BK" <<'EOF'
import sqlite3, sys
bk = sys.argv[1] + "/laptop"
for db in ("mnemos.db", "vectors.db"):
    s = sqlite3.connect(f"/var/home/abyss/.distrobox/vscode-box/home/.mnemos/data/{db}")
    d = sqlite3.connect(f"{bk}/{db}")
    s.backup(d); d.close(); s.close()
    c = sqlite3.connect(f"{bk}/{db}")
    assert c.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    print("  ok:", db)
EOF

echo "── 2. cluster mnemos store"
POD=$($PY -c "import subprocess;print(subprocess.run(['kubectl','-n','$NS','get','pod','-l','app.kubernetes.io/name=mnemos','-o','jsonpath={.items[0].metadata.name}'],capture_output=True,text=True).stdout)")
kubectl exec "$POD" -n "$NS" -- python -c "
import sqlite3, os
os.makedirs('/tmp/bk', exist_ok=True)
for db in ('mnemos.db','vectors.db'):
    s=sqlite3.connect(f'/data/{db}'); d=sqlite3.connect(f'/tmp/bk/{db}')
    s.backup(d); d.close(); s.close()
"
for f in mnemos.db vectors.db; do
  kubectl cp "$NS/$POD:/tmp/bk/$f" "$BK/cluster/$f" 2>/dev/null | grep -v 'Removing leading' || true
done
kubectl exec "$POD" -n "$NS" -- rm -rf /tmp/bk
$PY - "$BK" <<'EOF'
import sqlite3, sys
for db in ("mnemos.db", "vectors.db"):
    c = sqlite3.connect(sys.argv[1] + f"/cluster/{db}")
    assert c.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    print("  ok:", db)
EOF

echo "── 3. board DBs"
EPOD=$(kubectl get pod -n "$NS" -l app.kubernetes.io/name=vesmaro-eyes -o jsonpath='{.items[0].metadata.name}')
kubectl exec "$EPOD" -n "$NS" -- python -c "
import sqlite3, os
os.makedirs('/tmp/bk', exist_ok=True)
s=sqlite3.connect('/data/board.db'); d=sqlite3.connect('/tmp/bk/board.db')
s.backup(d); d.close(); s.close()
"
kubectl cp "$NS/$EPOD:/tmp/bk/board.db" "$BK/board/board-cluster.db" 2>/dev/null | grep -v 'Removing leading' || true
kubectl exec "$EPOD" -n "$NS" -- rm -rf /tmp/bk
$PY - "$BK" <<'EOF'
import sqlite3, sys
s = sqlite3.connect("/var/home/abyss/LABs/Projects/Project-Mnemos/mnemos-eyes/data/board.db")
d = sqlite3.connect(sys.argv[1] + "/board/board-local.db")
s.backup(d); d.close(); s.close()
for tag in ("cluster", "local"):
    c = sqlite3.connect(sys.argv[1] + f"/board/board-{tag}.db")
    assert c.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    print("  ok:", tag)
EOF

echo "── 4. manifest"
(
  cd "$BK"
  find . -type f -name '*.db' -exec sha256sum {} \; | sort > SHA256SUMS
  {
    echo "# vesmaro-eyes backup manifest — $TODAY"
    echo "laptop: mnemos.db (memories) + vectors.db — sqlite .backup snapshots, integrity ok"
    echo "cluster: mnemos.db + vectors.db — via kubectl exec snapshot"
    echo "board: board-cluster.db + board-local.db"
    echo "restore: stop writer → replace file → PRAGMA integrity_check"
  } > MANIFEST.txt
  cat SHA256SUMS >> MANIFEST.txt
)
cat "$BK/MANIFEST.txt"
echo "✓ backups complete: $BK"