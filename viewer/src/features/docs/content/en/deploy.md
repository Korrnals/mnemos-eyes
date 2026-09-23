---
title: Deployment and first launch
slug: deploy
category: getting-started
order: 1
last_verified: "1.19.0"
---

# Deployment and first launch

This page takes the board from an empty cluster to an open workspace in
your browser. You will install the Helm chart, get the tokens, check the
board's health, and sign in for the first time. With a working cluster
the procedure takes 15–20 minutes.

The board is a single container: the API server, a SQLite database on a
volume (PVC), and the interface. The external dependency is one or
several mnemos memory servers the board talks to over HTTP with its own
`mnk_…` token. That token never leaves the board server.

## What you need before installing

- A Kubernetes/K3s cluster with Helm 3 and a working ingress controller
  (in K3s that is traefik). The examples use the `kube-agents` namespace.
- A memory server (mnemos) token with `totp_required=0` (a value shaped
  like `mnk_…`). mnemos issues it.
- The board itself is not yet running? The upstream runbook for
  installing mnemos is imported into the docs:
  [installing mnemos](/docs/mnemos/admin/runbooks/install).
- The address the board will answer on: the examples use
  `board.example.com` (replace with yours).
- A cloned repository: the chart and the scripts live in it.

## Step 1. Namespace and the mnemos token secret

The secret is created outside Helm and survives uninstalling the release:

```bash
kubectl create namespace kube-agents

kubectl -n kube-agents create secret generic vesmaro-eyes-mnemos \
  --from-literal=MNEMOS_TOKEN=mnk_…
```

## Step 2. The TLS certificate

The ready-made script creates a self-signed certificate valid for 825
days:

```bash
./scripts/gen-tls-secret.sh          # creates the vesmaro-eyes-tls secret
./scripts/gen-tls-secret.sh --check  # check the remaining lifetime any time
```

A browser warning about a self-signed certificate for the lab domain is
accepted, normal behaviour — not a bug. To renew, run the script again;
the ingress picks up the new secret on its own.

## Step 3. The values file

Save as `my-values.yaml` and adjust:

```yaml
imagePullSecrets: []            # the image is public on ghcr, no login needed

# The site root serves a single app (kanban, agents, automation).
rootApp: app                    # the chart default is board (the legacy board)

mnemos:
  cluster:
    url: http://mnemos.memory.svc:8787   # the in-cluster mnemos service address
  laptop:
    enabled: false              # the second (LAN) store: enable + secret

ingress:
  enabled: true
  className: traefik            # k3s already ships traefik; replace with yours
  host: board.example.com
  tls:
    enabled: true
    secretName: vesmaro-eyes-tls

persistence:
  storageClass: local-path      # your cluster's storage class

# SEC-1: the allow-list of hosts the board may reach for memory.
# Extend it when you connect new stores.
memoryHostsAllowlist: "mnemos.memory.svc,localhost,127.0.0.1"

# One-time seeding of the store registry on first start. Afterwards the
# registry lives in the board's database and is edited through the API.
memoryRegistry:
  configMap:
    create: true
    content:
      servers:
        - name: main
          url: http://mnemos.memory.svc:8787
          token_env: MNEMOS_TOKEN
          primary: true

# Token split: the interface gets its own token, the agents theirs.
uiToken:
  enabled: true
```

Three values are forgotten most often: `ingress.host` (the board
address), `memoryHostsAllowlist` (without the host on the list the store
will not connect) and `mnemos.cluster.url` (the address must be the
in-cluster service one).

## Step 4. Install

Do not rename the `vesmaro-eyes` release: resource names depend on it,
and the chart reuses its secrets between upgrades.

```bash
helm install vesmaro-eyes deploy/chart/vesmaro-eyes \
  -n kube-agents -f my-values.yaml

kubectl -n kube-agents rollout status deployment/vesmaro-eyes --timeout=300s
```

## Step 5. Collect the tokens

The chart generates the tokens itself (48 random characters) and reuses
them on every upgrade — including after `helm uninstall`. Fetch both and
put them into a password manager:

```bash
# the interface token (UI mutations) — pasted into the sign-in window
kubectl -n kube-agents get secret vesmaro-eyes-ui-token \
  -o jsonpath='{.data.VESMARO_UI_TOKEN}' | base64 -d

# the machine token (poller, agents) — see the "Agents and assignments" page
kubectl -n kube-agents get secret vesmaro-eyes-board-token \
  -o jsonpath='{.data.VESMARO_BOARD_TOKEN}' | base64 -d
```

The secret inventory at a glance:

| Secret | Created by | Contents |
| --- | --- | --- |
| `vesmaro-eyes-mnemos` | the operator, manually | the `mnk_…` memory store token |
| `vesmaro-eyes-board-token` | the chart, automatically | the machine token: poller, agent reports |
| `vesmaro-eyes-ui-token` | the chart when `uiToken.enabled=true` | the interface mutation token |
| `vesmaro-eyes-tls` | `scripts/gen-tls-secret.sh` | the self-signed ingress certificate |

Token class mechanics and hygiene rules — on the [Tokens and
access](tokens.md) page.

## Step 6. Verify

```bash
# health: ok:true + the list of stores
curl -ksS https://board.example.com/api/health | head -c 400

# a smoke mutation without a token: expect 4xx/503, not 5xx
curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST https://board.example.com/api/tasks \
  -H 'Content-Type: application/json' -d '{"title":"smoke"}'
```

- `200` from `/api/health` with `ok:true` — the board is alive and sees
  the stores.
- `503` on the mutation — the token did not reach the pod; `401` — the
  secret was overwritten with another value.
- `502` from the ingress — a network policy, see
  [Troubleshooting](troubleshooting.md).

## Step 7. First sign-in

Open `https://board.example.com`. Accept the certificate warning
(Advanced → Proceed to the site) if the browser shows one. The left
panel holds the domains: Overview, Memory, Tasks, Agents, System. The
app version sits at the bottom of the panel: check it matches the
installed tag.

What to do next as the person at the keyboard — [First sign-in for a
family member](first-login.md).

## No cluster? Docker Compose

For a try-out on one machine Docker is enough:

```bash
git clone https://github.com/Korrnals/mnemos-eyes.git && cd mnemos-eyes
export MNEMOS_URL=http://your-mnemos-host:8787
export MNEMOS_TOKEN=mnk_…
docker compose up -d
# → http://localhost:8090
```

The database lives in `./data/` and survives a container rebuild. The
`VESMARO_BOARD_TOKEN` value in the compose file is a development
placeholder: put your own in before going anywhere past localhost.

## Data and deletion

The board's database lives on a PVC with the
`helm.sh/resource-policy: keep` policy: `helm uninstall` removes neither
the data nor the tokens. Full deletion is manual and deliberate. Before
any risky cluster operation, take a copy — see [Backup and
restore](backup-restore.md).

## See also

- [First sign-in for a family member](first-login.md)
- [Tokens and access](tokens.md)
- [Upgrading the board](upgrade.md)
