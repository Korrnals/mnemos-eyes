---
title: First sign-in for a family member
slug: first-login
category: getting-started
order: 2
last_verified: "1.16.0"
---

# First sign-in for a family member

This page is for someone who opened the board for the first time and has
no interest in stores and tokens. Everything you need is here: how to
sign in, where things live, and why something asks for a "token". No
command line — just the browser.

## What you will need

- The board address — something like `https://board.example.com`. Ask
  whoever set the system up.
- A token — a long string you will paste once, at sign-in. The sign-in is
  verified by the server, and one session covers every tab of the
  browser. Ask the administrator for it when you want to change anything
  on the board.

## Open the board

Type the address into the browser. If you see a "connection not secure"
warning, that is expected for a home network with a self-signed
certificate. Press Advanced, then Proceed to the site.

You land on the Overview home page: the state of the memory stores,
fresh entries in the pulse feed, and quick links.

## Look around

The left panel holds the sections. Four are enough:

| Section | What is inside |
| --- | --- |
| Overview | the home page: stores, fresh entries |
| Memory | search across entries, the Pulse feed, records, tags |
| Tasks | the kanban board, the list, the inbox, the archive |
| System | status, settings, automation, sessions |

Three more things worth trying right away:

- The `/` key jumps into memory search. The `?` key shows the keyboard
  shortcuts cheat sheet.
- The top panel has the theme and interface language switches.
- The app version is written at the bottom of the left panel — mention
  it when asking for help.

## Read-only mode and signing in

Without a session the board is a showcase: looking is fine, changing is
not. That is normal and safe. When you try to drag a card or create a
task, the Sign-in window opens. The same window opens from the Sign in
button in the top panel.

1. Paste the token the administrator gave you into the Token field.
2. Press Sign in. The server checks the value right away: while it
   verifies, the button reads Verifying….
3. The "Signed in — control available" toast confirms success, and the
   action you started runs by itself.
4. If you changed your mind — Continue read-only; the window closes and
   everything stays as it was.

If the value is wrong, or it is a token of another class (a machine
token instead of a ui token, for example), you will see "The server did
not accept the token — check the value and try again", and the server
explains under the error line which token class arrived. Nothing is
stored: fix the value and try again.

One sign-in covers the whole browser: the session lives in a protected
cookie, so new tabs open already signed in, and closing a tab does not
end the session. Six hours of inactivity do — the next attempt to change
something shows "Your session expired — sign in again", and you paste
the token again.

The Sign out button in the top panel ends the session on the server —
across every tab of this browser at once. If the server is unreachable
at that moment, you stay signed in: a toast asks you to retry.

## What you can do after signing in

- Drag task cards across the kanban columns — see [Groups and the
  kanban board](groups-kanban.md).
- Create and edit tasks, tidy up the archive.
- Hand tasks to agents and watch them work — see [Agents and
  assignments](agents-assignments.md).

## If something did not work

- "The server did not accept the token — check the value and try again"
  — the value is wrong or it is a token of another class. Ask the
  administrator for a fresh ui token and paste it again.
- "Your session expired — sign in again" — six hours of idle time, or a
  token change on the server, closed the session. Sign in again: your
  data is untouched.
- Pressed Sign out by accident — just sign in again, nothing is lost.
- For everything else and its cures — [Troubleshooting](troubleshooting.md).

## Where to find hints

The app version is always in view at the bottom of the left panel;
mention it when asking for help. Answers to "how do I do X" live in the
Documentation section of the same panel: a reference for the board with
search in its header — categories from Getting started to FAQ.

Every documentation page carries an "current as of v.X.Y.Z" badge:
compare it with the board version — advice for an older version may
differ. If the interface looks different from the description, reload
the page first: the board itself offers a reload when a new deploy
ships.

![The Documentation section in the sidebar](screens/docs-section.webp)

*The Documentation section in the left panel: page categories and a
search box.*

## See also

- [Groups and the kanban board](groups-kanban.md)
- [Tokens and access](tokens.md)
- [FAQ](faq.md)
