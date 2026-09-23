---
title: What vesmaro-eyes is
slug: what-is-vesmaro-eyes
category: product
order: 2
last_verified: "1.14.0"
---

# What vesmaro-eyes is

vesmaro-eyes is the board: a working desktop on top of mnemos memory.
Where mnemos is the well of entries, the board is where entries become
tasks, agents take tasks on, and schedules start work on their own.
Everything you do in the browser lives here; this page explains how the
board is built and what it can do — section by section.

## How it all fits together

Three layers inside. The browser shows the interface and stores nothing
but your sign-in session: a cookie for the whole browser plus the pasted
ui token in the current tab. The board server is the conductor: it keeps
its own task database, and only it holds the store tokens. The mnemos
stores are that memory itself — see [What mnemos is](what-is-mnemos.md).

Live updates ride an SSE event stream: when another client (a second
tab, the API, an agent) moves a card, your tab updates on its own. If
the stream drops for a moment, an honest «data as of HH:MM» note appears
above the lists.

![How vesmaro-eyes is built](diagrams/vesmaro-stack.svg)

*Board layers: the browser talks only to the board server; the board
server keeps the task database and the tokens and talks to the mnemos
stores; the stores are linked by mnemos-mesh when needed.*

## Tasks and kanban

The main desktop is Tasks → Kanban. The board columns are workflow
stages: from «backlog» through «in progress» to «done». You create a card
with the Task button, drag it between columns, and filter by status,
priority, project and agent. The Groups / Classic view switch either
collects cards into project groups or shows plain columns. The special
archcom badge marks tasks that need an owner decision.

![The kanban board](screens/kanban.webp)

*The kanban board: columns are workflow stages, cards are dragged with
the mouse; the Groups view collects cards into project groups inside
every column.*

Day-to-day board work — [Groups and the kanban
board](groups-kanban.md).

## Inbox: tasks arrive from memory

A task is not necessarily born on the board. Agents and scripts can put
entries tagged `task:queue` straight into a memory store — the board
picks them up in Tasks → Inbox.

1. Press Scan stores — the board polls every connected store.
2. Review the found entries and press Adopt to board.
3. The entry becomes a regular task; the link to the original is kept.

The inbox is honest in both directions: turn on "show adopted" to see
already-adopted entries with links to the tasks they created; if an
entry disappears from the store, the board counts it as vanished — it
cannot be adopted retroactively.

## Agents and assignments

The board does not keep tasks to itself — it hands them out for work.
Four words hold the Agents section together:

| Word | What it is |
| --- | --- |
| Harness | the agent runtime type: `zcode`, `copilot` |
| Specialist | the role and competency: `gcw-frontend-developer` |
| Executor | a concrete connected agent: the poller on your machine |
| Assignment | a task handed to an executor |

You create an assignment on the task page with Take into work, and it
joins the queue. The executor — a poller process on the machine with
agents — asks the board "any work?" every 10 seconds and raises local
processes against a strict allow-list of commands. The work in progress
is visible in Agents → Execution: who is connected, what is running now,
and what is stuck in the queue. A sibling screen, Agents → Connect,
handles the executors themselves: approving newcomers, enabling, revoking,
and minting one-time tokens for remote machines. Agent reports land on
the task card — in the Reports and History tabs.

Connection order and routing — [Agents and
assignments](agents-assignments.md).

Who an assignment goes to by default is set in System → Settings, the
Execution block: that is where the default executor and the fallback
live. At assignment time the board shows a Route preview — a forecast by
the current rules; the fact shows who actually took it.

## Automation: rules and schedules

System → Automation answers "when to run". A schedule is "daily at HH:MM"
or "every interval"; a hook rule is "event + conditions + action" (for
example: a task got blocked — create an assignment). There is no cron
syntax — only plain options from the forms. Every rule creates a regular
assignment; the usual executor routing takes it from there.

In this version only the manual Run now works; the automatic tick
arrives together with the engine switch — see [Automation: rules and
schedules](automation-rules.md).

## Devices: QR pairing

A phone or tablet connects to the board without typing tokens: the
device scans a QR code, and the owner confirms the connection from a
trusted computer. The device gets its own `mnd_…` token with read-only
rights; at most five devices are active at once, and revocation is
instant. No cloud: the device and the board talk inside your network.

The screen lives at System → Devices, with a device-side page at `/pair`;
the step-by-step connection and the security rules — [Pairing a
device](pairing.md).

## Tasks remember memory

A task on the board is linked to memory directly: the "Related memories
(ids)" field holds references to mnemos entries. The Memory tab on the
task page shows those entries from the stores with their source server;
the History tab builds a single timeline — board events interleaved with
the related memory entries. The "mnemos tags" field ties the task into
the tag cloud the memory is searched through.

The task page is the center of the world: reports, history, memory and
details live in the tabs of one card.

![Task card: the Reports, History, Memory and Details tabs](screens/task-card.webp)

*The task card: the Details tab with a specification and the "Repair"
project chip; next to it Reports, History and Memory — everything about
the task in one place.*

## Reading and changing

You can look at the board without signing in — that is the deliberate
read-only showcase mode. Changes — cards, tasks, settings, automation —
open after signing in with a ui token: the Sign-in window appears by
itself at the first attempt to change something. The server verifies the
value on the spot, and one session covers every tab of the browser; six
hours of idle time close it — see [First sign-in for a family
member](first-login.md). Device and poller tokens have their own narrow
rights — see [Tokens and access](tokens.md).

## See also

- [What mnemos is](what-is-mnemos.md)
- [Glossary](glossary.md)
- [Agents and assignments](agents-assignments.md)
- [Automation: rules and schedules](automation-rules.md)
