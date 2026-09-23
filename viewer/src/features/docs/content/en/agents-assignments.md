---
title: Agents and assignments
slug: agents-assignments
category: agents
order: 1
last_verified: "1.16.0"
---

# Agents and assignments

The board does not just store tasks — it hands them to automatic
executors and shows what they are doing right now. The Agents section
has two screens: Execution answers three questions — who is connected,
what is running now, and what is stuck in the queue; Connect is the
executor registry — approval, enabling, revocation, and minting tokens
for remote machines.

## Four words to speak the same language

| Word | What it is | Example |
| --- | --- | --- |
| Harness | the agent runtime type | `zcode`, `copilot` |
| Specialist | an agent's role, its competency | `gcw-frontend-developer` |
| Executor | a concrete connected agent: harness + machine | the poller on a laptop |
| Assignment | a task handed to an executor | "take T-12 into work" |

## The Execution screen

Open Agents → Execution. The executor strip sits on top: one chip per
executor. The dot on a chip is presence:

| Dot | Meaning |
| --- | --- |
| solid green, "online" | a pulse no older than 2 minutes |
| amber, "pulse missed" | silent for 2–10 minutes |
| hollow, "offline" | silent for more than 10 minutes |

Under the strip, assignments are listed in three groups: "active" (taken
and running), "queue", and "terminal today" (collapsed; when nothing has
finished today but history exists, a "Finished recently" caption with a
date appears above the group). An assignment row shows the state, the
task, the specialist, the executor, and an honest age — "taken 4 min
ago", "pulse 1 min ago".

Clicking a row opens the assignment card: a phase timeline (created →
claimed → started → pulses → finish), an identity line, and the final
report. The "reported by … · unverified" caption means the executor
claimed who it is — the server has not confirmed it yet. At the bottom
of the section sits the Execution feed: a shared stream of events across
all assignments. Empty states are actionable here: "No assignments yet"
offers an Open tasks link.

## The Connect screen

Agents → Connect is the executor registry. The Add executor button sits
on top (more on it below), with three bands under it: "Awaiting
approval", "Connected", "Revoked" — empty bands are not shown. An
executor row shows the presence dot, the name and harness, the
transport, the version, the host, and the age of the last contact;
declared Capabilities appear as chips.

Trust in a newcomer is not blind: the row carries an honest "unverified"
chip — the name, host and version were claimed by the executor itself,
and the server cannot confirm them. Rows awaiting approval also show an
origin line: "enrollment token" (came by invitation from a remote
machine) or "machine token" (registered itself with the master key).

Onboarding a newcomer is two steps, both in the registry:

1. Approve — the button sits right on the pending row: the server
   confirmed this executor is expected.
2. Enable — routing only picks enabled executors; approval by itself
   does not add anyone to the route. The hint next to the button says
   the same.

The rest of the management lives in the context menu: right-click a
registry row or an executor chip in the Execution strip (the chip also
has a ⋯ button that appears on hover). Items depend on the state:
Enable/Disable, Revoke, Copy id, Delete; Approve for a pending row; the
chip on Execution also gets Open registry.

Two actions are irreversible and both ask for confirmation:

- Revoke — trust is not restorable: the state is terminal, and the
  executor has to register again (a new record and a new secret).
- Delete — the record leaves the registry for good: the secret dies with
  it, the name is freed; references in active assignments are kept.

Disable is the soft option: routing temporarily skips the executor, the
row is marked "disabled by the owner (routing off)", and Enable puts
everything back.

## Hand a task to an agent

Assignments are created only on the task page:

1. Open the task and its Execution tab.
2. Press Take into work.
3. In the form, pick a specialist and a harness. The executor — Default
   or a concrete one: offline executors are visible but not selectable.
4. Check the Route preview: who the assignment will go to under the
   current rules. The preview is a forecast; the fact shows who actually
   took it.
5. Press Assign. The assignment joins the queue — state "queued".

If no executor is available, the button stays active anyway: the
assignment waits honestly in the queue, marked "waiting for an
executor".

## Assignment states

| State | What happens |
| --- | --- |
| queued | waiting for the poller to pick it up |
| claimed | the executor took it, has not started yet |
| running | working, a pulse every 60 seconds |
| done | the final report is ready |
| failed | the executor reported an error — the cause is in the report |
| cancelled | cancelled by the owner |
| expired | no start or no pulse in time — the server's reaper stepped in |

Owner actions: Cancel (with a warning that a stop signal will be sent to
the executor) and Restart for failed and expired ones — the form opens
pre-filled.

An executor's presence and an assignment's life are independent facts,
and the board shows both without ever collapsing them: a chip reading
"executor offline 12 min" can sit next to a row reading "running, pulse
12 min ago, expires in ~18 min". Green means a fresh fact only, amber
means a real missed pulse only.

## Who gets the assignment by default

System → Settings, the Execution block: set the default executor and the
fallback. The routing rules are visible in the preview and in the
assignment row: "targeted executor", "by specialist", "by task
specialists", "default executor". A default must be strictly online — an
executor that missed its pulse gets no default assignments.

## Connect an executor

An executor is a poller: a small process on the machine with agents that
asks the board "any work?" every 10 seconds and launches local processes
against a strict allow-list of commands. The install summary:

1. Python 3.10+ and the dependencies: `pip install --user httpx pyyaml`.
2. The config `~/.config/mnemos-eyes/poller.yaml` (permissions 0600):
   the board address, the executor name, the command allow-list, the
   lab-CA certificate.
3. The machine token — through the environment only, for example
   `/etc/vesmaro/poller.env` with a `VESMARO_BOARD_TOKEN=…` line (where
   to get the value — [Tokens and access](tokens.md)).
4. The service: a `vesmaro-assignment-poller` systemd unit (a user unit
   for a distrobox laptop). Details — `deploy/poller/README.md` in the
   repository.

A check without starting: `python3 scripts/assignment_poller.py --once`
— a dry run of a single cycle, taking no assignments.

After the first connection the executor appears on the Agents → Connect
page, in the "Awaiting approval" band, marked "awaiting owner approval".
From the interface: Approve, then Enable — routing only takes enabled
executors (the mechanics are in the Connect section above). The API
(`PATCH /api/executors/{id}` with a ui token) gives the same result —
an alternative for scripts.

### A remote machine: an enrollment token instead of the master key

The board's machine token is a master key: fine on your own machine, not
on a rented VPS. For remote executors, mint a one-time enrollment token:
it lets a machine register as an executor once and is good for nothing
else. The token is minted right in the interface: on the Agents →
Connect page, press Add executor.

1. Fill in the form: "Label (for you)" (say, "vps-1"), "Harness (hint
   for the commands)" and, optionally, "Executor name" — then Create
   token.
2. On the token screen the `mne_…` value is hidden: press Show and
   Copy. The token lives for 15 minutes — a countdown ticks next to it —
   and burns after the first use. At most three live tokens at a time.
3. Below sits the "Run on the VPS" block: four commands from registration
   to starting the poller, your token already inside. Copy all carries
   the whole block over; run the commands on the remote machine. The
   executor secret from the response is shown once — it goes into the
   poller's env file instead of the master key.
4. After registration the executor appears in the "Awaiting approval"
   band, and the token row becomes "used", with the executor's name and
   the IP it came from. Cross-check the origin against the machine you
   expect, then Approve → Enable.

The standing status screen for tokens is the Enrollment tokens panel
under the registry (captioned "live + history"): countdowns for live
tokens, the "waiting for connection", "used", "expired", "revoked"
states, and revoking an unclaimed token with the Revoke button and a
confirmation. Without a sign-in the panel honestly hints: minting and
statuses require a ui token.

The same minting stays available through the API — `POST
/api/executors/enrollment` (create), `GET`/`DELETE
/api/executors/enrollment` (list the live ones and revoke) — as an
alternative for scripts. Token classes and `mne_…` masking —
[Tokens and access](tokens.md).

Executors come with the "local" and "mesh" transports — the transport is
visible on the chip in the executor strip. Mesh executors are observable
only for now: in this version the system cannot assign work to them
(including by default).

Running tasks on a schedule or by event — [Automation: rules and
schedules](automation-rules.md).

## See also

- [Automation: rules and schedules](automation-rules.md)
- [Groups and the kanban board](groups-kanban.md)
- [Troubleshooting](troubleshooting.md)
