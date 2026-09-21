#!/bin/sh
# Host-side launcher for vesmaro-assignment-poller-user.service — starts
# the poller inside the distrobox and pins the two things distrobox-exec
# gets wrong for this layout (live-verified 2026-09-21):
#
# 1. the exec env leaks the HOST $HOME — start-poller.sh's $HOME-relative
#    paths would resolve to the wrong tree, so every path is absolute and
#    HOME is re-exported to the container home before anything runs;
# 2. `python3` in the exec PATH resolves to the host ~/.local/bin shim
#    (the mounted host home sits in PATH), which re-execs the interpreter
#    with a SCRUBBED environment — the board token never reached the
#    poller. The absolute container interpreter keeps the env.
#
# Install (HOST side): cp poller-unit-launcher.sh ~/.local/bin/ && chmod 700
# Adjust the two absolute prefixes below if the container/home layout
# differs (CONTAINER_BOX_HOME = the container's $HOME as seen from both
# sides; DISTROBOX_NAME = `distrobox list` name).
DISTROBOX_BIN=/var/home/abyss/.local/bin/distrobox-enter
DISTROBOX_NAME=ubuntu
CONTAINER_BOX_HOME=/var/home/abyss/.distrobox/ubuntu/home
exec "$DISTROBOX_BIN" -n "$DISTROBOX_NAME" -- /bin/sh -c '
  export HOME="'"$CONTAINER_BOX_HOME"'";
  cd "$HOME/.local/share/mnemos-eyes/bridge" || exit 1
  set -a; . "$HOME/.config/mnemos-eyes/poller.env"; set +a
  exec /usr/bin/python3 scripts/assignment_poller.py \
    --config "$HOME/.config/mnemos-eyes/poller.yaml"'
