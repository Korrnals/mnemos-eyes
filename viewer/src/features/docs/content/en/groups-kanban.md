---
title: Groups and the kanban board
slug: groups-kanban
category: board
order: 1
last_verified: "1.13.1"
---

# Groups and the kanban board

The kanban is the board's main desktop: tasks sit in columns and are
dragged with the mouse. This page explains how the board is built, how
to create a task, and how project groups and filters work — everything
for daily work in Tasks → Kanban.

![The kanban board: groups and status columns](screens/kanban.webp)

*The board in the Groups layout: seven columns — workflow stages, cards
collected into project groups inside each one.*

## How the board is built

The board has seven columns. A column is a stage of a task's life:

| Column | Meaning |
| --- | --- |
| backlog | ideas and drafts, before work |
| validating | a check before picking the task up |
| open | taken into work, waiting for an executor |
| in progress | being worked on right now |
| blocked | stuck on something external |
| resolved | done, waiting for confirmation |
| done | the finish |

Besides the column, a task carries a status (open, in progress,
blocked, resolved, done, withdrawn), a priority (critical, high, normal,
low), a project and tags. Columns and status are linked: the backlog and
validating columns read as the "open" status.

## Project groups

A layout switch sits above the board: Groups and Classic.

- Groups — inside every column, cards are collected into collapsible
  groups by project. A group you collapse stays collapsed on your next
  visit. Tasks without a project always sit in the "no project" group at
  the bottom.
- Classic — plain columns with no subgroups, maximum cards on screen.

The task list (Tasks → List) groups by project the same way — as
accordions. Inside a group, tasks are ordered by priority: critical
first.

## Create a task

1. Press the Task button above the board — the "New task" dialog opens.
2. The first line of the text becomes the title (up to 200 characters),
   the rest becomes the summary.
3. Pick a project and, if you like, comma-separated mnemos tags — handy
   for searching later.
4. Press Create task. The card appears in the open column.

## Move cards

Drag a card into a neighbouring column — the task status changes, and
every open tab updates on its own. Two honest limits:

- Without signing in, dragging is off — the hint reads "sign in to
  manage" (see [First sign-in for a family member](first-login.md)).
- Not every transition is allowed: for example, a task cannot jump from
  backlog straight to resolved — it is picked up first. On an illegal
  transition the card returns to its place with an explanation.

The mouse-free alternative is the task menu (the three dots on a card):
Edit, Move to…, Archive. In the list the same menu opens with a right
click on a row.

## Filters and search

Above the board: search by title or id, and filters — status, priority,
project, agent. Clear filters brings the full picture back. Both the
kanban and the list obey the filters.

## The task page

Clicking a card opens the task page with its tabs:

| Tab | What it shows |
| --- | --- |
| Details | summary, specification, project, environment, specialists, tags |
| Reports | agents' messages along the way, the final report |
| History | a single timeline: board events + related memory entries |
| Memory | related entries from the mnemos stores with their source |
| Execution | assignments to agents for this task — see [Agents and assignments](agents-assignments.md) |

Two handy buttons: Resume (puts a finished task back into "in
progress"; the column does not change) and Edit — for the content
fields.

The special archcom badge on a card means "owner decision required". A
task stuck in validating for over 24 hours is highlighted the same way —
the board honestly reminds you about stuck decisions.

## Editing and protection from accidents

A task older than 24 hours refuses content edits — the server guards
it. If the edit is really needed, the dialog offers Edit anyway (force):
the edit goes through and is marked as forced in the history.

## Inbox: tasks from memory

Tasks → Inbox shows `task:queue` entries from the connected memory
stores — tasks placed there by agents or scripts.

1. Press Scan stores — the board polls every store.
2. Review the found entries and press Adopt to board on the right one.
3. The entry becomes a regular task; the link to the original is kept.

## Archive

Archive in the task menu removes a task from the board, with a
confirmation. In Tasks → Archive archived tasks are found by search and
filters, and Restore to board puts a task back into play.

## See also

- [First sign-in for a family member](first-login.md)
- [Agents and assignments](agents-assignments.md)
- [FAQ](faq.md)
