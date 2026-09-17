#!/usr/bin/env bash
# Keep http://127.0.0.1:8420 on this Mac forwarded to the Pi-hosted NOVA dashboard.
set -euo pipefail

LABEL="com.nova-dashboard.pi-tunnel"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_PLIST="$SOURCE_DIR/$LABEL.plist"
TARGET_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

mkdir -p "$HOME/Library/LaunchAgents"
install -m 0644 "$SOURCE_PLIST" "$TARGET_PLIST"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$TARGET_PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"

for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 http://127.0.0.1:8420/api/health >/dev/null; then
    printf 'NOVA tunnel is ready at http://127.0.0.1:8420/\n'
    exit 0
  fi
  sleep 0.5
done

printf 'Tunnel did not become ready. See /tmp/nova-dashboard-tunnel.log\n' >&2
exit 1
