---
title: Tokens and access
slug: tokens
category: security
order: 1
last_verified: "1.16.0"
---

# Tokens and access

A token is a long password-like string the system recognizes a caller
by. The board has several token classes with different rights: this page
explains which is for what, where they live, and how not to turn
convenience into a hole.

## The token classes

| Class | What it looks like | Who uses it | Rights |
| --- | --- | --- | --- |
| Store token | `mnk_…` | the board reaching into mnemos | memory read/write; `totp_required=0` |
| ui | the value of `VESMARO_UI_TOKEN` | a person in the interface | every board mutation: tasks, archive, inbox, settings, automation |
| machine | the value of `VESMARO_BOARD_TOKEN` | the poller and the agents | reports, claiming and pulsing assignments |
| device | `mnd_…` | paired devices | read-only; issued by pairing |
| enrollment | `mne_…` | a remote executor registering | one executor registration; lives 15 minutes and burns ([Agents and assignments](agents-assignments.md)) |

Store tokens (`mnk_…`) stay with the board and are never handed to the
browser — the interface sees only the server names and their state.

## Which token goes where

| You want to | You need | Where it goes |
| --- | --- | --- |
| change tasks from the browser | ui | the Sign-in window in the interface |
| run the agent poller | machine | `/etc/vesmaro/poller.env` (environment only, never the config) |
| connect a memory store to the board | store token | the `vesmaro-eyes-mnemos` secret at install time |
| give a tablet read access | device | pairing — see [Pairing a device](pairing.md) |
| connect a remote executor without the master key | enrollment | minted on the board, spent at poller registration |

## How the board protects the tokens

- Secrets live on the server only: the store registry accepts
  `env:VARIABLE_NAME` references or `file:/path` links into a
  pre-agreed secrets directory. The `plain:` scheme (a token right in
  the registry) is forbidden through the API.
- In logs, every token-shaped string is masked automatically:
  `mnk_<redacted>`, `mnd_<redacted>`, `Bearer <redacted>`.
- The token class is determined by prefix and checked before any
  action: an unconfigured class makes the operations answer `503`
  (closed by default); a wrong value — `401`.
- A device token is stored in the database as a hash only: the original
  value cannot be seen, only revoked.
- The sign-in session lives in an HttpOnly cookie: JavaScript can
  neither read it nor delete it — signing out happens only through the
  server.

## The codes you will meet at the door

| Code | Meaning | What to do |
| --- | --- | --- |
| 401 | the value did not fit — or the session expired (6 hours of idle, token rotation) | paste a fresh token (rotation is possible) or sign in again |
| 403 | the token is valid but has no rights | a device token on a mutation — by design; changes need a ui token |
| 429 | too frequent | wait: pairing and service operations have rate limits |
| 503 | the token class is not configured on the board | enable the class in the values and roll the release |

## What happens on every request

The server checks a token in one chain: it determines the class by
prefix, matches it against the routes allowed for that class, and only
then lets the request through — to the mutation guard. The check is
constant-time and sits ahead of any data work, so "swapping the class"
by editing the token text is impossible.

An honest word about reads: reads on the board are open behind the
ingress — the token matters for changes and for identity in the audit,
not as a reading barrier. That is a deliberate choice for a trusted home
network; use a VPN for access from outside.

## Signing in to the interface

After the token split is installed, work in the interface happens with a
ui token. The Sign-in window opens at the first attempt to change
something (or from the Sign in button in the top panel). The server
checks the pasted value on the spot (`POST /api/auth/ui-token`): success
opens a session — an HttpOnly `vesmaro_ui` cookie valid for the whole
browser, all tabs; nothing else needs pasting. The token also stays in
the current tab (sessionStorage) — that is the leg pre-session tabs work
on.

The session slides: every successful authorized request extends it, and
6 hours of silence let the browser kill the cookie on its own — the next
mutation gets a `401` reading "session expired". The Sign out button in
the top panel ends the session on the server (`DELETE
/api/auth/ui-token`) — across all tabs at once; if the server is
unreachable, you stay signed in and the interface says so.

Sign-in attempts are rate-limited: at most 10 per minute from one
address and 60 per minute board-wide; the extras answer `429`. Without a
session the board is fully readable — that is the deliberate showcase
mode, not a bug.

While the sign-in window is open, the action you pressed waits: once you
sign in, it runs automatically — nothing to press again.

## Where the tokens come from

All static tokens are cluster secrets. You can list the names and
owners:

```bash
kubectl -n kube-agents get secrets | grep vesmaro-eyes
```

| Secret | Key | Class |
| --- | --- | --- |
| `vesmaro-eyes-ui-token` | `VESMARO_UI_TOKEN` | ui |
| `vesmaro-eyes-board-token` | `VESMARO_BOARD_TOKEN` | machine |
| `vesmaro-eyes-mnemos` | `MNEMOS_TOKEN` | store token `mnk_…` |
| `vesmaro-eyes-laptop` | `MNEMOS_LAPTOP_TOKEN` | the second store, `mnk_…` |

The chart generates two of its own secrets at first install and keeps
them even across `helm uninstall`. How to fetch a value —
[Deployment and first launch](deploy.md); how to change one —
[Token rotation](token-rotation.md).

## Hygiene rules

- A token never goes into logs, issues, screenshots or chats. In
  examples use masks: `mnk_…`, `ui-token-…`.
- ui and machine tokens must not start with the reserved prefixes
  `mnd_`, `mne_`, `mnu_`, `mnm_` — the server derives the class from
  the prefix.
- One device — one `mnd_…` token; do not share it between devices.
- The poller takes its token from the environment — never from the
  config, never from agent prompts.
- A suspected leak is the moment to rotate, immediately: the procedure
  takes minutes — see [Token rotation](token-rotation.md).

## See also

- [Token rotation](token-rotation.md)
- [Pairing a device](pairing.md)
- [First sign-in for a family member](first-login.md)
