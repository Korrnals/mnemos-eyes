---
title: Token rotation
slug: token-rotation
category: security
order: 2
last_verified: "1.16.0"
---

# Token rotation

Rotation is a planned replacement of a token with a new one. Do it when
a leak is suspected, after someone with access leaves, and from time to
time just because — regular rotation turns a possible leak into a
harmless one. Rotating any class takes minutes and touches no data.

## When rotation is due

- You suspect an extra pair of eyes has seen the value, or it landed in
  a log, a screenshot, a chat.
- The set of people with cluster access changed.
- A planned date arrived (say, every six months) — pick a day and walk
  the checklist below.
- After demos and debugging sessions where the token could have shown
  up.

The general scheme is always the same: mint a new value → update the
secret → roll the release → update the consumers. On the team, always
pass `-f my-values.yaml` with updates: then Helm applies your permanent
settings too, not only what came in `--set`.

## Rotating the ui token

People paste the ui token into the Sign-in window, so rotation comes
down to changing the secret.

1. Mint a new value and put it into the same secret:

   ```bash
   kubectl -n kube-agents create secret generic vesmaro-eyes-ui-token \
     --from-literal=VESMARO_UI_TOKEN='ui-token-new-value' \
     --dry-run=client -o yaml | kubectl apply -f -
   ```

2. Roll the pod so it re-reads the secret (env is refreshed only on pod
   recreation):

   ```bash
   helm upgrade vesmaro-eyes deploy/chart/vesmaro-eyes -n kube-agents \
     -f my-values.yaml --set image.tag=<current version>
   kubectl -n kube-agents rollout status deployment/vesmaro-eyes
   ```

   The explicit `image.tag` is mandatory — see [Upgrading the
   board](upgrade.md) for why.

3. Hand the new value to everyone working with the board. The old one
   stops being accepted immediately, and the open sessions go dark: the
   interface shows "Your session expired — sign in again" — paste the
   current value into the Sign-in window.

If the leak is confirmed, do not wait: the old value stops working the
moment the pod rolls — warn people in advance so it does not catch them
mid-task.

## Rotating the machine token

The machine token lives in the poller on the machine with agents.

1. Change the `vesmaro-eyes-board-token` secret to the new value — the
   same way as steps 1–2 above (same secret name, the
   `VESMARO_BOARD_TOKEN` key).
2. Update the poller's environment file (`/etc/vesmaro/poller.env` or
   the user unit's variable). Mind the permissions: the file must be
   root-only (0600).
3. Restart the poller:

   ```bash
   sudo systemctl restart vesmaro-assignment-poller
   # for a user unit on a laptop:
   systemctl --user restart vesmaro-assignment-poller-user
   ```

4. Check the log: `journalctl -u vesmaro-assignment-poller -f` — a start
   line with no auth errors, assignments being picked up.

The poller survives a short window when the board is already on the new
token and the poller is still on the old one: auth attempts repeat, and
nothing is lost.

## Rotating a mnemos store token

1. On the mnemos side, issue a new `mnk_…` token (with
   `totp_required=0`) and revoke the old one.
2. Update the `vesmaro-eyes-mnemos` secret (the `MNEMOS_TOKEN` key) and
   roll the board, as above.
3. If the laptop LAN store is connected, update its secret too
   (`vesmaro-eyes-laptop`).
4. Check: `/api/health` answers `ok:true` and sees every store.

## Device tokens

These are not rotated — they are revoked and reissued:

- Revocation: `DELETE /api/devices/{id}` — instant and irreversible;
  the device reconnects through pairing (see [Pairing a
  device](pairing.md)).
- Lifetime works without rotation too: 30 sliding days while active,
  a hard ceiling of 90.

## The TLS certificate

The ingress certificate lives for 825 days; check the remaining
lifetime with `./scripts/gen-tls-secret.sh --check`, renew by running
the script again. No release roll needed: the ingress picks up the
secret itself. After renewing, check the board opens with no new
warnings.

## The post-rotation check

- The Sign-in window accepts the new ui token, mutations go through.
- The poller starts in its log without `401`s, assignments are picked
  up.
- `/api/health` answers `ok:true` — the store tokens are alive.
- Paired devices (if any) keep reading — rotation did not touch them.

## See also

- [Tokens and access](tokens.md)
- [Upgrading the board](upgrade.md)
- [Backup and restore](backup-restore.md)
