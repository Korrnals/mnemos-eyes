---
title: Troubleshooting
slug: troubleshooting
category: maintenance
order: 3
last_verified: "1.16.0"
---

# Troubleshooting

The symptoms are ordered by frequency and severity: first what keeps the
board from opening, then what keeps it from working. For each — the
cause and a short path to a cure. If your symptom is not on the list,
name the version from the bottom of the left panel — that is what the
search starts with.

## A one-minute check

Three checks answer most of the "what is even going on" questions:

```bash
# 1. is the board alive, does it see the stores (ok:true + a servers block)
curl -ksS https://board.example.com/api/health | head -c 400

# 2. does the root answer (expect HTML, not 502/503)
curl -ksS -o /dev/null -w '%{http_code}\n' https://board.example.com/

# 3. does the server accept mutations without a token (expect 4xx/503, not 5xx)
curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST https://board.example.com/api/tasks \
  -H 'Content-Type: application/json' -d '{"title":"diag"}'
```

In parallel, glance at the Stores block on the Overview: "working" /
"unreachable" / "off" — that is already half the diagnosis.

## The board does not open

**The ingress answers `502`.** A network policy keeps traefik away from
the pod — usually after an upgrade of the foreign `agentsnode-policies`
chart that rolled the rule back. Re-apply the patch from
`deploy/netpol-traefik-fix.md`:

```bash
kubectl -n kube-agents get networkpolicy agentsnode-policies -o yaml \
  > /tmp/netpol-backup-$(date +%Y%m%d-%H%M).yaml
kubectl patch networkpolicy agentsnode-policies -n kube-agents \
  --type=json --patch-file deploy/k8s/netpol-traefik-fix-patch.yaml
```

**An endless "Loading…"** — the API is up but the stores are silent:
open `/api/health` and read the servers block. A red "unreachable" dot
on the Overview is the same thing in human form.

**A certificate warning** for the lab domain is the norm — Advanced →
Proceed to the site. If the warning turned into a connection error,
check the certificate's lifetime: `./scripts/gen-tls-secret.sh --check`
(renewal — [Token rotation](token-rotation.md)).

## The sign-in is refused

| Symptom | Cause and cure |
| --- | --- |
| "The server did not accept the token — check the value and try again" | the sign-in failed verification at the door: the value is stale or it is a token of another class. Under the error line the server explains which class arrived and which one is needed (say, a machine token pasted where a ui token belongs). Take a fresh value from the `vesmaro-eyes-ui-token` secret and paste it again |
| "Your session expired — sign in again" | the session closed: 6 hours of idle, or a ui token rotation on the server. Sign in again — the new session covers all the browser's tabs once more |
| Mutations answer `503` | the token class is not configured on the board — enable `uiToken.enabled` (see [Tokens and access](tokens.md)) |
| Sign-in answers `429` | the attempt limit fired: at most 10 per minute from one address. Wait a minute and try again |
| The board asks for the token again after signing in | the session lives in a cookie; check the browser is not blocking cookies for the board address |
| The action "hangs" while the sign-in window is open | by design: sign in — the action runs by itself |

## A memory store is "unreachable"

1. Open `https://board.example.com/api/health` — the failing server's
   block shows the cause.
2. Check the address is on the allow-list (`memoryHostsAllowlist` in
   the values): without the host on the list the board refuses to even
   try — see [Deployment and first launch](deploy.md).
3. Check mnemos itself and the cluster's network policy: the board is
   only allowed out to the listed addresses.
4. If the laptop store keeps going offline, the `/api/health` probes get
   slow. Fix the link or temporarily turn the server off in the registry
   (through the stores API).

## The Tasks, Agents, Automation sections are unavailable

The board works in two modes: against the board (all domains present)
and straight against mnemos (Memory only). If opening a domain shows
"Section unavailable in mnemos mode", the data source is wrong: check
`mnemos.cluster.url` in the values — it must point at a board-compatible
service.

## Tasks

- **A task vanished from the board** — look into Tasks → Archive and
  search for it. Restore to board brings it back.
- **"invalid transition: move to in-progress first"** — columns follow
  the workflow; a backlog task cannot jump straight to "resolved" (see
  [Groups and the kanban board](groups-kanban.md)).
- **The task cannot be edited (423)** — it is older than 24 hours, the
  content is guarded. The dialog offers Edit anyway (force), marked in
  the history.
- **The card snapped back after dragging** — the move did not go through
  (a conflict or a dropped link, say). Try again; if it repeats, look at
  `/api/health`.
- **An entry vanished from the Inbox** — it disappeared from the source
  (the `task:queue` tag in the store) and can no longer be adopted: the
  source is more honest than the cache. Scan again — new entries will
  appear.

## Assignments and agents

- **An assignment sits "queued"** — the poller is not picking it up. On
  the agents' machine check: the service is running (`systemctl status
  vesmaro-assignment-poller`), the token in `/etc/vesmaro/poller.env` is
  current, the config's allow-list contains the command. Dry run:
  `python3 scripts/assignment_poller.py --once`.
- **"Waiting for an executor (offline)"** — the target executor is not
  reachable; pick another one or wait.
- **"Pulse missed"** on an executor — the process is alive but silent
  for 2–10 minutes: look at the poller's `journalctl`.
- **An assignment "expired"** — no start or no pulse in time; press
  Restart (see [Agents and assignments](agents-assignments.md)).

## Automation and pairing

- **"Engine not enabled"** — the norm in this version: schedules do not
  tick on their own, Run now works (see [Automation: rules and
  schedules](automation-rules.md)).
- **A launch was "skipped"** — the cause is always in the journal, the
  Journal tab.
- **Pairing answers `503`** — no ui token on the board; `409` — all
  five device slots are taken (see [Pairing a device](pairing.md)).

## Small but frequent

- **"Data as of HH:MM"** — the note appears when the live-update stream
  dropped for a while. After the connection recovers the board refreshes
  on its own; reloading the page is the reliable way.
- **The "An app update shipped" toast** in the corner — a new deploy
  shipped, and the open tab is still on the old build. Press Refresh in
  the toast — the page reloads onto the current version. The tab never
  reloads without you: the toast checks the server when you return to
  the tab and every five minutes, and simply reminds you.
- **The version in the panel did not change after an upgrade** — Helm
  reused the old image tag; redo the upgrade with an explicit
  `--set image.tag=…` (see [Upgrading the board](upgrade.md)).
- **A rule cannot be recreated under the old name** — deletion is soft,
  the name stays taken; pick a new one.

## See also

- [Upgrading the board](upgrade.md)
- [Backup and restore](backup-restore.md)
- [Tokens and access](tokens.md)
