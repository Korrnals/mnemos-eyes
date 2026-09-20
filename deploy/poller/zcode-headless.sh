#!/bin/sh
# Headless zcode launcher for the assignment poller (agent bridge).
# Envelope on stdin → one-shot headless session (zcode.cjs --prompt).
# ELECTRON_RUN_AS_NODE keeps the desktop app out (no GUI/singleton clash).
# Provider configs are injected by the desktop app via env in interactive
# sessions; a minimal-env child must supply them itself. The glob survives
# app upgrades (version + endpoint hash live in the path).
PROMPT="$(cat)"
WORKSPACE="${ZCODE_WORKSPACE:-/var/home/abyss/LABs/Projects}"
BUILTIN=$(ls "$HOME"/.zcode/v2/runtime/provider/linux-x86_64/*/endpoint-*/zcode-builtin.json 2>/dev/null | head -1)
APPVER=$(printf '%s' "$BUILTIN" | sed -E 's#.*/linux-x86_64/([^/]+)/.*#\1#')
[ -n "$BUILTIN" ] || { echo "zcode provider config not found" >&2; exit 3; }
exec env ELECTRON_RUN_AS_NODE=1 \
    ZCODE_APP_VERSION="$APPVER" \
    ZCODE_RUNTIME_ENV=production \
    ZCODE_BASE_URL=https://zcode.z.ai \
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE="$BUILTIN" \
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE="$HOME/.zcode/v2/provider_config.json" \
    /opt/ZCode/zcode /opt/ZCode/resources/glm/zcode.cjs \
    --cwd "$WORKSPACE" --mode yolo -p "$PROMPT"
