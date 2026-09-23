---
title: FAQ
slug: faq
category: faq
order: 1
last_verified: "1.13.0"
---

# FAQ

Short answers to what is asked most often. The link after an answer
leads to the details.

## How is the board different from mnemos?

mnemos is the storage and the search. The board is the working desktop
on top of it: tasks, agent executors and automation. The board reads
memory from one or several stores and lays it all out on one desk.

## Do I need the internet?

No. The board works inside your home network: the cluster, the memory
stores and the browsers talk to each other. The board needs external
addresses only if you connect a store from outside yourself — and only
with an explicit entry on the allowed-hosts list.

## Who can see my data?

Only those who open the board address in your network. Without a
session — read-only mode; changes open after signing in with a ui
token. Tokens are stored on the board server and in your browser, and
they never travel further.

## I lost my token. What now?

Nothing broke: ask the administrator to fetch the value from the
`vesmaro-eyes-ui-token` secret or issue a new one — see [Token
rotation](token-rotation.md). The data does not suffer.

## Can I work from a phone?

Looking — yes: open the board address. The full QR-pairing connection
(a read-only `mnd_…` device token) works at the API level in this
version; the pairing screen ships in the interface since 1.17.0 — see
[Pairing a device](pairing.md).

## Why can't the task be edited?

It is older than 24 hours: the server guards old tasks against random
edits. The edit dialog offers Edit anyway (force) — the edit goes
through and is marked in the history. More: [Groups and the kanban
board](groups-kanban.md).

## Where did the task go from the board?

Most likely it is in the archive: Tasks → Archive, search by title,
Restore to board. If it is not there either — check the board's
filters.

## Why is the agent not taking the assignment?

An assignment waits in the queue when the executor is offline, the
poller is stopped, or the command is not on its allow-list. Step-by-step
diagnostics: [Troubleshooting](troubleshooting.md).

## What does "Engine not enabled" in automation mean?

In this version schedules and rules run manually with Run now; the
automatic tick arrives together with the engine switch. It is not a
malfunction: [Automation: rules and schedules](automation-rules.md).

## The board suddenly "froze"

A "data as of HH:MM" note appears above the lists when the update
stream dropped for a moment. Reload the page — the board pulls in the
current state.

## How do I learn the board's version?

At the bottom of the left panel of the interface. Every page of this
documentation carries its own verification version — compare it with the
board's.

## What happens when the release is deleted?

`helm uninstall` touches neither the task database on the PVC nor the
generated tokens — a reinstall picks everything back up. Full deletion
is manual and deliberate: [Deployment and first launch](deploy.md).

## How often should I back up?

At minimum before every upgrade; ideally nightly on a schedule. The
ready-made script and the restore order: [Backup and
restore](backup-restore.md).

## See also

- [First sign-in for a family member](first-login.md)
- [Groups and the kanban board](groups-kanban.md)
- [Tokens and access](tokens.md)
