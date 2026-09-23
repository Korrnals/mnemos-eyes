---
title: Pairing a device
slug: pairing
category: devices
order: 1
last_verified: "1.19.0"
---

# Pairing a device

Pairing is the way to give a phone or tablet access to the board without
typing tokens: the device scans a QR code, and the owner confirms the
connection from a trusted computer. The device gets its own `mnd_…`
token with read-only rights.

## How it works

The scheme is direct, no cloud: the device and the board are on the same
home network, and no third party touches the traffic. The connection
takes two owner actions: create a request and confirm it. There is no
auto-accept.

The security rules baked into the protocol:

- A pairing code lives for 3 minutes and burns after the first use.
- The token is issued exactly once, and only from the IP the device
  first knocked from.
- The `mnd_…` token is read-only: tasks, memory, events, health.
  Mutations from the device are refused.
- At most five active devices; the sixth connection requires revoking an
  old one first.

## The pairing screen

The server side of pairing has worked since version 1.12.0, and the
screen in the interface since 1.17.0. The whole connection happens in
the browser — no commands, no API.

For the owner: System → Devices. The Connect a device button opens the
dialog: a QR code to scan and, when there is no camera, a Pairing code
typed in on the device by hand. A countdown ticks under the code: a code
lives for 3 minutes. When the device knocks, a Connection request
appears in the dialog — the device's name and IP, and four digits of the
Verification code. Match the digits against the device's screen and
press Confirm (or Deny — then the device gets no token). Without an
owner session, neither the device list nor connecting is available.

On the device: the `/pair` page — "Device connection". Enter the Pairing
code from the owner's screen and the device name, show the owner your
four digits, and wait. The page checks the status once by itself after a
minute; there is also a Check button. After the confirmation — "Device
connected" and the Device token: it is shown once, and the device keeps
it.

## Prerequisites

- A ui token is configured (`VESMARO_UI_TOKEN`): without it all pairing
  endpoints answer `503` — the "closed by default" guard. See [Tokens
  and access](tokens.md).
- The device list and confirmations need an owner session — see [First
  sign-in for a family member](first-login.md).
- The device reaches the board over HTTPS with a trusted certificate.
  For a lab domain with a self-signed certificate, install your own CA
  on the device — the setup ritual and the SHA-256 fingerprint check
  are described in `deploy/chart/vesmaro-eyes/RUNBOOK.md` in the
  repository.

## Through the API: the same protocol for scripts

The screen repeats the protocol step by step; the same actions are
available as API calls — handy for automation. Run the commands from a
trusted computer. Below, `ui-token-…` is the mask of your ui token and
`board.example.com` the board address.

![The QR pairing flow](diagrams/pairing-flow.svg)

*The four pairing steps: the owner creates a request, the device
presents the code, the owner matches the four digits and confirms — the
device receives the token once.*

1. Create a pairing request:

   ```bash
   curl -sk -X POST https://board.example.com/api/pairing \
     -H "Authorization: Bearer ui-token-…" \
     -H "Content-Type: application/json" \
     -d '{"device_name":"kitchen tablet"}'
   ```

   The response: a `pairing_id`, a one-time `code`, the four-digit
   `verify` for matching screens, and `expires_at` (3 minutes).

2. The device presents the code — today that is the client integration:
   POST `/api/pairing/exchange` with `{"code":"…", "device_name":"…"}`.
   Until you confirm, it sits in the "awaiting_confirmation" state with
   the same `verify`.

3. Match the four `verify` digits on both screens and confirm:

   ```bash
   curl -sk -X POST \
     https://board.example.com/api/pairing/pairing-id-…/confirm \
     -H "Authorization: Bearer ui-token-…" \
     -H "Content-Type: application/json" \
     -d '{"allow":true}'
   ```

4. The device repeats the exchange — and receives the single response
   with the `device_token` (`mnd_…`), which it keeps. A second issue is
   impossible: the code burned.

`verify` protects against mixed-up servers and typos — it is not
cryptography: the real protection is the short TTL, the one-shot issue
and the IP binding.

## Manage the devices

The list lives in the same place: System → Devices. Every record shows a
status ("active", "expired", "revoked"), the connection date, the last
IP, and two deadlines: the sliding TTL and the hard one. Revocation is
the Revoke button, with a warning: "Revocation is irreversible — the
device will need a new pairing".

The same list and revocation are available through the API:

```bash
# list the connected devices (no tokens)
curl -sk https://board.example.com/api/devices \
  -H "Authorization: Bearer ui-token-…"

# revoke a device (irreversible — only a new pairing)
curl -sk -X DELETE https://board.example.com/api/devices/device-id-… \
  -H "Authorization: Bearer ui-token-…"
```

A device token lives as long as it is used: a 30-day sliding window
with a hard ceiling of 90 days. Revocation is instant and final.

## If something went wrong

- The code expired (3 minutes) or was already used — the dialog reads
  "Pairing expired — start over"; on the API screen that is `410`.
  Create a new pairing.
- `403` on the exchange — the device is knocking from another IP than
  the first time (the network changed, say). Create a new pairing.
- `409` on the sixth device — revoke one of the old ones.
- `503` — no ui token is configured on the board.

Rotating a compromised token — [Token rotation](token-rotation.md).

## See also

- [Tokens and access](tokens.md)
- [Token rotation](token-rotation.md)
- [Troubleshooting](troubleshooting.md)
