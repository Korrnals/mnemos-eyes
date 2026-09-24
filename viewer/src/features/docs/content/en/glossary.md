---
title: Glossary
slug: glossary
category: product
order: 3
last_verified: "1.19.0"
---

# Glossary

The terms exactly as the interface names them. When an unfamiliar word
shows up on the board, look it up here; complex terms carry a link to
the page with the details.

## Term → what it is

| Term | What it is |
| --- | --- |
| board | vesmaro-eyes as a whole: the working desktop with tasks, agents and automation on top of mnemos memory |
| entry | one unit of mnemos memory: text, raw source, tags, project, agent, source and processing status |
| store | one mnemos server connected to the board; there can be several — for example `cluster` and `laptop` |
| store group | several stores joined into one pulse-and-search scope |
| mnemos-mesh | the federation of stores: a transport linking store nodes to each other; the nodes are visible in the Mesh nodes section |
| pulse | the feed of fresh entries from the stores — Memory → Pulse, the "all stores" scope |
| tag | an entry label; Memory → Tags shows everything marked with it, across all stores |
| workflow status | a task's life stage: open, in progress, blocked, resolved, done, withdrawn (the backlog and validating columns read as "open") |
| kanban | the Tasks → Kanban view: columns are workflow stages from backlog to done, cards are dragged with the mouse |
| task | a card on the board: a title, a summary, a project, a priority and a workflow status; the task lives in the board's database, its memory lives in mnemos entries |
| archcom | a card badge: "owner decision required"; a task stuck in validating for over 24 hours is highlighted the same way |
| inbox | the Tasks → Inbox section: `task:queue` entries from the memory stores, not yet adopted onto the board |
| assignment | a task handed to an executor; created with Take into work on the task page |
| executor | a concrete connected agent: a poller on a machine that picks assignments from the queue and reports back |
| poller | the mediator process on the machine with agents: asks the board "any work?" every 10 seconds and launches the agents |
| harness | the agent runtime type: `zcode`, `copilot` |
| specialist | an agent's role and competency: `gcw-frontend-developer` |
| token | a password-like string the system recognizes a caller by; classes differ by prefix and by rights |
| enrollment token | a one-time `mne_…` token: lets a remote machine register as an executor once; lives for 15 minutes — see [Agents and assignments](agents-assignments.md) |
| ui token | the human token: the value of `VESMARO_UI_TOKEN`, unlocks every change in the interface — see [Tokens and access](tokens.md) |
| session | a server-verified sign-in: it lives in a browser cookie — all tabs, one sign-in; 6 hours of idle time close it — see [First sign-in for a family member](first-login.md) |
| machine token | the machines' token: the value of `VESMARO_BOARD_TOKEN`, used by the poller and the agents for reports and picking up assignments |
| device token | a paired device's `mnd_…` token: read-only, issued by QR pairing — see [Pairing a device](pairing.md) |
| pairing | connecting a device by QR code: the device scans, the owner confirms, the token is issued once |
| cron | the classic scheduler syntax; the board has none — a schedule is set as "daily at HH:MM" or "every interval" |

## Where the token prefixes come from

The server determines a token's class by its prefix and checks it before
anything else: `mnd_…` — a device, `mne_…` — enrollment, `mnk_…` — a
store token the board uses to reach mnemos. That is why ui and machine
tokens cannot start with those combinations — and why token masking in
logs works automatically.

## Project documentation terms

The Documentation section now also carries the projects' own pages —
mnemos and mnemos-mesh — imported from their repositories (every
imported page shows provenance of the form "from mnemos@…"). The upstream
calls things its own way; this table translates into board language.

| Upstream term | Board term | Comment |
| --- | --- | --- |
| memory, entry | entry | one unit of memory; the upstream says "memories"/"entries", the board says "entry" |
| vault | originals directory | in the upstream a vault is the directory of a memory's source files (`~/.mnemos/vault`); the board calls the whole mnemos server a "store", not this directory |
| store | memory store | the database inside mnemos; on the board a "store" is a connected mnemos server as a whole |
| harness | harness | the same term: an agent's runtime (`zcode`, `copilot`) |
| pipeline | processing pipeline | cleaning an entry before it reaches a model; the board shows it as the "raw → processed" statuses |
| DLQ | — (not shown) | the queue of entries that failed the pipeline; a service surface with no UI on the board |
| traces | Traces | the pipeline's work log; the board shows them under System → Traces |
| dashboard | Pulse, Overview | the upstream metrics power the Pulse feed and the Overview stats |
| federation, peer | federation, mesh node | a participant of the mnemos federation; the board observes them as Mesh nodes |
| trigger code | trigger code | a one-time peer-confirmation code in the mnemos federation; do not confuse it with the board's QR pairing |
| tag contract | tag contract | the mandatory tag schema; the task's "mnemos tags" field follows it |
| mnemos_* (MCP) | MCP tools | the layer agents use to reach the memory; the board uses the same layer |

## See also

- [What mnemos is](what-is-mnemos.md)
- [What vesmaro-eyes is](what-is-vesmaro-eyes.md)
- [Tokens and access](tokens.md)
