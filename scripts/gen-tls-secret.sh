#!/usr/bin/env bash
# Generate a self-signed TLS certificate for vesmaro.abyss.lab and store it
# as the k8s TLS secret `vesmaro-eyes-tls` (namespace kube-agents).
#
# Lab domain: the certificate is self-signed, browser warning is an accepted
# trade-off (documented in deploy/chart/vesmaro-eyes/RUNBOOK.md).
# Validity 825 days (max iOS/macOS-trust window; long enough for the lab,
# short enough to force periodic rotation — re-run this script to renew).
#
# Usage:
#   scripts/gen-tls-secret.sh                 # create/update the secret
#   scripts/gen-tls-secret.sh --print-only    # render cert+key to stdout, no kubectl
#   scripts/gen-tls-secret.sh --check         # show current secret expiry
#
# Read-only friendly: this script MUTATES the cluster (kubectl apply of the
# secret) — run it in the deploy window, not from a laptop session.
set -euo pipefail

NS=kube-agents
SECRET=vesmaro-eyes-tls
HOST=vesmaro.abyss.lab
DAYS=825
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

MODE="${1:-apply}"

if [[ "$MODE" == "--check" ]]; then
  kubectl -n "$NS" get secret "$SECRET" -o jsonpath='{.data.tls\.crt}' | base64 -d \
    | openssl x509 -noout -subject -dates
  exit 0
fi

openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout "$WORKDIR/tls.key" -out "$WORKDIR/tls.crt" \
  -days "$DAYS" \
  -subj "/CN=${HOST}" \
  -addext "subjectAltName=DNS:${HOST}" >/dev/null 2>&1

if [[ "$MODE" == "--print-only" ]]; then
  cat "$WORKDIR/tls.crt" "$WORKDIR/tls.key"
  exit 0
fi

if [[ "$MODE" != "--apply" && -n "$MODE" ]]; then
  echo "unknown mode: $MODE (use --print-only or --check)" >&2
  exit 2
fi

kubectl -n "$NS" create secret tls "$SECRET" \
  --cert="$WORKDIR/tls.crt" --key="$WORKDIR/tls.key" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "✓ secret $SECRET created in ns $NS (CN=${HOST}, ${DAYS}d)"
kubectl -n "$NS" get secret "$SECRET" -o jsonpath='{.data.tls\.crt}' | base64 -d \
  | openssl x509 -noout -subject -dates
