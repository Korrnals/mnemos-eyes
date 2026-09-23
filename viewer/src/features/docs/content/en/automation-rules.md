---
title: Automation: rules and schedules
slug: automation-rules
category: automation
order: 1
last_verified: "1.13.0"
---

# Automation: rules and schedules

System → Automation answers "when, and in response to what, to launch
tasks": by time (schedules) or by an event on the board (hook rules).
Every rule creates a regular assignment — the usual executor routing
takes it from there, the same one as a manual Take into work.

## What this version can do

Only the manual launch works in this version: any rule can be run with
the Run now button. The automatic tick (schedules firing on their own)
arrives together with the engine switch — in this version the engine
cannot be turned on yet, and the banner at the top of the section
honestly reads Engine not enabled. That is normal: create rules, break
them in with manual runs, and when the engine arrives they will fire on
their own.

The banner also shows counters: the daily cap on auto-launches, how many
were used today, the global kill-switch, and the totals for schedules
and rules. The "auto-launches today" line is mirrored in the Agents
block on the Overview page.

## Create a schedule

A schedule launches a task by the clock.

1. The Schedules tab → New schedule.
2. Set the name and the task to launch; optionally a specialist and a
   harness.
3. Pick the trigger: "daily" with a time (HH:MM), or "every interval"
   with a one-minute minimum step. There is no cron syntax — only these
   two options.
4. Press Create. The schedule is created disabled.
5. Press Enable on its card — enabling is a separate step, so nothing
   starts working by surprise.

The name must be unique: it is the rule's address in the launch journal,
and it stays taken even after deletion. Give the time some slack — the
board has to be alive: a missed tick is not caught up later.

While the engine is off, "enabled" means "ready for manual runs and for
the tick once the engine arrives". If the board was down at the moment
of firing, the launch is not caught up retroactively — the journal shows
"skipped (window)", and a manual run is the compensation.

## Create a hook rule

A rule reacts to a board event: event + conditions + action.

1. The Rules tab → New rule.
2. Pick the event (the "Event (on)" field) from the server's dictionary.
3. Build conditions from a closed dictionary: a field (the task's
   column, priority, project, status), an operator (equals, not equals,
   one of) and a value. No free text — only what the board knows for
   sure; a field without a closed set of values has no conditions.
4. Set the action — create an assignment for the task.
5. Press Create, then Enable.

The honesty limit: card moves are made with the machine token class, so
in this version a move event does not trigger rules.

## Examples to start from

| Rule | Settings |
| --- | --- |
| A morning report run | schedule: the report task, "daily at 09:00" |
| Check the queue hourly | schedule: the watchdog task, "every interval", every 60 minutes |
| A task got blocked — signal a specialist | rule: the task-changed event, condition "status = blocked", action — an assignment |

Start with a schedule on your own test task and run it manually — the
shortest way to feel the mechanics.

## Run it manually

The Run now button on a rule's card executes it immediately, past the
engine and the daily caps. The result is an assignment in the task's
queue; a toast arrives with a link into the Execution section. A failed
launch is also an event: the cause is always in the journal.

The limits (the daily cap, auto-launches today) belong to the engine's
future automatic launches; a manual run does not spend them. A disabled
rule is not executed by a manual run either — Run now is only available
on enabled rules.

## The launch journal

The Journal tab is the history of every launch: "launched", "skipped"
(with a cause), "skipped (window)". Each row keeps a snapshot of the
rule, so the journal stays readable even after the rule is deleted; the
link in a row leads to the assignment it created.

## Enable, disable, delete

| Action | What happens |
| --- | --- |
| Enable / Disable | the rule's personal switch |
| Run now | an immediate manual launch |
| Delete | a soft delete: the rule goes dark, the name stays taken |

A deleted rule cannot be recreated under the same name — protection
against a quiet swap: the old row survives, disabled. Without a session
the section is read-only and changes are unavailable.

## What this version does not have

An automatic tick (the engine), cron syntax, catch-up launches after
downtime, rule chains, and external webhooks. These are the deliberate
v1 boundaries — each will come back as its own decision when its turn
comes.

## See also

- [Agents and assignments](agents-assignments.md)
- [Groups and the kanban board](groups-kanban.md)
- [FAQ](faq.md)
