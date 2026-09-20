#!/bin/sh
# Start the assignment poller detached (nohup — laptop mnemos precedent;
# systemd alternative: vesmaro-assignment-poller.service).
# Runtime layout: a git-archive snapshot of main in
#   ~/.local/share/mnemos-eyes/bridge/  (scripts/ + deploy/poller/)
# Config:  ~/.config/mnemos-eyes/poller.yaml   (no secrets)
# Env:     ~/.config/mnemos-eyes/poller.env    (0600: board + executor tokens)
cd "$(dirname "$0")/../.." || exit 1   # bridge/ root
set -a; . "$HOME/.config/mnemos-eyes/poller.env"; set +a
exec python3 scripts/assignment_poller.py --config "$HOME/.config/mnemos-eyes/poller.yaml"
