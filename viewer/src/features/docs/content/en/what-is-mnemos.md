---
title: What mnemos is
slug: what-is-mnemos
category: product
order: 1
last_verified: "1.14.0"
---

# What mnemos is

mnemos is a long-term memory engine: it stores entries, knows how to
search them, and serves them to people and agents. This page is the plain
concept of the memory: what an entry is made of, how it lives, and how
several stores relate. The vesmaro-eyes board is a separate layer on top
of mnemos — it has its own page, [What vesmaro-eyes
is](what-is-vesmaro-eyes.md).

## A well, not a folder of files

In the interface mnemos is called the well, and the metaphor is exact:
entries pile up in a common depth — written by agents through the API and
MCP, by scripts, by you. Every entry carries tags, a project and a source,
so the memory never turns into a dump: you can search it, cross-check it
by tags, and watch what arrived recently in the Pulse feed.

mnemos itself is a server with no kanban and no buttons: storage, search,
an API for agents, and pipeline traces. Everything else is the board's
job.

## An entry and its parts

The unit of memory is an entry. Open Memory → Records and pick any entry
— inside you will always find the same anatomy:

| Part | What it is |
| --- | --- |
| Text | the cleaned content — what the memory considers the essence |
| Raw source | the original text before cleaning; toggle it on the entry page |
| Tags | the labels an entry is found by, together with its neighbours |
| Project | a meaningful group — the board's task projects live in the same system |
| Agent | who wrote the entry |
| Source | where the entry came from |
| Confidence | how much the engine trusts the content |
| Status and dates | where the entry sits on the processing pipeline and when it changed |

## Entry processing status

A fresh entry does not become full-fledged memory immediately — it walks
a pipeline. The processing status is visible in lists and in the Status
filter:

| Status | Meaning |
| --- | --- |
| raw | the entry has just landed in the well |
| processing | the pipeline is working on it |
| processed | cleaned and spread across the fields |
| published | full-fledged memory — it shows up in search |
| archived | out of circulation, but not deleted |

## Workflow: a task's life cycle

Tasks live among the entries — entries with a working life cycle
(workflow). The statuses follow a strict order:

| Stage | Meaning |
| --- | --- |
| backlog | an idea or a draft, before work |
| validating | a check before picking it up |
| open | the task is accepted, waiting for an executor |
| in progress | being worked on right now |
| blocked | stuck on something external |
| resolved | done, waiting for confirmation |
| done | the finish |

Not every transition is allowed: for example, a task cannot jump from
«backlog» straight to «resolved» — it is picked up first. The board shows
this life cycle as kanban columns and enforces the order of transitions —
see [Groups and the kanban board](groups-kanban.md).

A task can also live in the store itself: entries tagged `task:queue` are
put there by agents and scripts, and the board picks them up in the Inbox
— see [What vesmaro-eyes is](what-is-vesmaro-eyes.md).

## Tags

A tag is an entry label, the main way to navigate the well. The
Memory → Tags section is an inspector: click a tag to see everything it
marks, across all connected stores. Tags also tie the two halves of the
system together: a board task has a «mnemos tags» field, so a card finds
its memory through shared labels.

## Hybrid search

Memory search works in three modes — the search-type switch under
Memory → Search:

| Mode | How it searches |
| --- | --- |
| FTS | full-text: by exact words and their prefixes |
| Semantic | by meaning: finds entries with no shared words |
| Auto | hybrid: the server merges both kinds of hits and ranks them together |

A practical rule of thumb comes from the interface itself: the well is
deep but literal — if a search returns nothing, try fewer or different
words. The `/` key jumps into search from any page.

## Stores: several memory servers

Memory does not have to live on one machine. The board connects several
mnemos servers — for example, `cluster` (the main store) and `laptop` (a
second one over the home network). The board keeps the store registry:
the Stores section on the left rail, the «+» button adds a server. Store
tokens stay with the board — the browser never sees them.

Stores are browsable one by one or together: the «all stores» scope of
the Pulse feed and of search, and store groups for when you need only
part of the system. Every entry and every search hit is marked with its
source server, and when one store is unreachable the interface honestly
says so and keeps working with the rest.

## mnemos-mesh: a federation of stores

When there are several stores on different machines, mnemos-mesh ties
them together — the federation transport: store nodes know about each
other, exchange data, and report peer availability. The board sees mesh
nodes as observable entities: the Mesh nodes section on the rail shows
each node's state, version, peer availability and uptime. Node management
goes through the API: in this version the interface only observes.

![The federation of mnemos stores](diagrams/mnemos-federation.svg)

*Federation: the cluster and laptop stores are linked by the mnemos-mesh
transport; vesmaro-eyes reads both and marks every entry with its source
server.*

## Where mnemos ends

mnemos knows nothing of kanban, assignments or interface tokens — it is
pure memory: entries, search, federation. The desktop layer on top of it,
where entries become tasks and agents take them on, is the board:
[What vesmaro-eyes is](what-is-vesmaro-eyes.md).

## See also

- [What vesmaro-eyes is](what-is-vesmaro-eyes.md)
- [Glossary](glossary.md)
- [Groups and the kanban board](groups-kanban.md)
- [Tokens and access](tokens.md)
