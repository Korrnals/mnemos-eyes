#!/usr/bin/env bash
# Deploy vesmaro-eyes to the abyss-ai-agent k3s cluster (namespace kube-agents).
#
# Steps:
#   1. Ensure the vesmaro-eyes-mnemos secret exists. It is NEVER overwritten
#      by this script: the board bearer token (mnk_..., totp_required=0) is
#      minted once via `mnemos auth token create --no-totp` and patched into
#      the secret manually. Re-running deploy only fills the PLACEHOLDER.
#   2. Apply deploy/k8s/vesmaro-eyes.yaml.
#   3. Roll out and wait for readiness.
set -euo pipefail

NS=kube-agents
MANIFEST="$(dirname "$0")/k8s/vesmaro-eyes.yaml"

echo "→ ensuring vesmaro-eyes-mnemos secret exists (no overwrite)"
if ! kubectl -n "$NS" get secret vesmaro-eyes-mnemos >/dev/null 2>&1; then
  echo "  secret missing — creating with PLACEHOLDER; patch MNEMOS_TOKEN manually:"
  echo "  kubectl -n $NS exec deploy/agentsnode-mnemos -- mnemos auth token create --name vesmaro-eyes-board --no-totp"
  kubectl -n "$NS" create secret generic vesmaro-eyes-mnemos \
      --from-literal=MNEMOS_TOKEN=PLACEHOLDER
else
  echo "  secret exists — left untouched"
fi

echo "→ applying manifest (incl. memories.yaml ConfigMap)"
kubectl -n "$NS" create configmap vesmaro-eyes-memories \
    --from-file=memories.yaml="$(dirname "$0")/k8s/memories.yaml" \
    --dry-run=client -o yaml | kubectl -n "$NS" apply -f -
kubectl -n "$NS" apply -f "$MANIFEST"

echo "→ waiting for rollout"
kubectl -n "$NS" rollout status deployment/vesmaro-eyes --timeout=180s

echo "✓ deployed: http://vesmaro.abyss.lab"