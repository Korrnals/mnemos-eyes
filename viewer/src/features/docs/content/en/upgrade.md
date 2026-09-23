---
title: Upgrading the board
slug: upgrade
category: maintenance
order: 2
last_verified: "1.13.0"
---

# Upgrading the board

An upgrade brings fixes and new sections. The data is untouched: the
database lives on a PVC, and switching versions means swapping the
container image. The order on this page closes two real traps that have
already cost downtime once: a silently retained old image tag, and a
foreign chart rolling back a network rule.

## Where a new version comes from

Board versions ship as repository releases: every release tag builds and
publishes an image. The version number has one source: `server/app.py`,
spread into the chart and the values by `scripts/sync-version.sh`. As
the operator, all you need is the release number from the release notes.

| Where | What | Who changes it |
| --- | --- | --- |
| `server/app.py` | the source of truth for the version | the release PR |
| `deploy/chart/vesmaro-eyes/Chart.yaml` | the chart and app version | the release PR |
| `deploy/chart/vesmaro-eyes/values.yaml` | the default image tag | the release PR |
| the bottom of the interface's left panel | the live version on the board | comes from `/api/health` |

## Before upgrading

1. Take a copy — see [Backup and restore](backup-restore.md). It is the
   only step that saves your day when things go wrong.
2. Check that the repository version and the image tag match:

   ```bash
   ./scripts/sync-version.sh --check
   ```

3. Look up the board's current version: it is written at the bottom of
   the interface's left panel, or:

   ```bash
   kubectl -n kube-agents get deploy vesmaro-eyes \
     -o jsonpath='{.spec.template.spec.containers[0].image}'
   ```

4. Warn the household: the pod is recreated and the board is down for
   about a minute. Plan a window; do not upgrade in the middle of
   someone's work.

## Run the upgrade

The main rule: every deploy names its image tag explicitly. Helm
remembers the values of past commands and silently keeps the old tag if
a new one is not given: the pod restarts but stays on the old version —
an upgrade without an upgrade.

```bash
helm upgrade --install vesmaro-eyes deploy/chart/vesmaro-eyes \
  -n kube-agents --atomic --timeout 5m \
  -f my-values.yaml \
  --set image.tag=<new version>

kubectl -n kube-agents rollout status deployment/vesmaro-eyes --timeout=300s
```

Then — the mandatory check of the pod's actual image (it must match the
tag from the command):

```bash
kubectl -n kube-agents get deploy vesmaro-eyes \
  -o jsonpath='{.spec.template.spec.containers[0].image}'
```

The `--atomic` flag rolls the release back on its own on failure;
without it the rollback is manual (below).

## Check after the upgrade

- The bottom of the interface's left panel shows the new version.
- `/api/health` answers `ok:true` and sees every store.
- A live run-through: open the board, drag a card, look into Agents →
  Execution and System → Automation.
- The poller on the agents' machine needs no update on a regular
  release — it is enough that it keeps answering.

## Rollback

A rollback returns the release to its previous version — the data stays
as it is:

```bash
helm history vesmaro-eyes -n kube-agents      # find the previous revision
helm rollback vesmaro-eyes <revision> -n kube-agents
kubectl -n kube-agents rollout status deployment/vesmaro-eyes
```

After a rollback — the same pod image check: the revision must show the
past tag. The legacy `/board` interface stays as a fallback entrance for
cross-checking during doubts — if it is enabled in your install.

## Special cases

- **A foreign network-policy chart was upgraded** (`agentsnode-policies`)
  — its upgrade quietly rolls back the traefik rule and the board
  answers `502`. Re-apply the patch: `deploy/netpol-traefik-fix.md` in
  the repository.
- **k3s/traefik was upgraded** — check that the traefik service kept
  `externalTrafficPolicy: Local` (otherwise pairing sees a service IP
  instead of the device's real address).
- **A new memory server with a different address** — add it to the
  chart's egress list (`networkPolicy.egress` in the values) and run a
  `helm upgrade`, or the store will not work: the deliberate isolation
  trade-off.
- **Changing the root app** (`rootApp`) — the same image, env only:
  updating the value recreates the pod with the same one-minute outage
  window.

## See also

- [Backup and restore](backup-restore.md)
- [Troubleshooting](troubleshooting.md)
- [Deployment and first launch](deploy.md)
