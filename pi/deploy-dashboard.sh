#!/usr/bin/env bash
# Deploy the complete NOVA dashboard to the Raspberry Pi and run it as a user service.
set -euo pipefail

PI_HOST="${PI_HOST:-rajarshi@raspberrypi.local}"
PI_DIR="${PI_DIR:-/home/rajarshi/nova-dashboard}"
PORT="${PORT:-8420}"
UNIT="nova-dashboard.service"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
HOSTNAME_ONLY="${PI_HOST#*@}"
SSH_OPTS=(-4 -o BatchMode=yes -o ConnectTimeout=10)

say() { printf '\n==> %s\n' "$*"; }

for f in server.js package.json public/index.html "pi/$UNIT"; do
  [[ -f "$ROOT/$f" ]] || { echo "missing $ROOT/$f" >&2; exit 1; }
done

say "Checking the Pi runtime"
ssh "${SSH_OPTS[@]}" "$PI_HOST" 'test -x /home/rajarshi/.hermes/node/bin/node && /home/rajarshi/.hermes/node/bin/node --version'

say "Syncing dashboard files"
ssh "${SSH_OPTS[@]}" "$PI_HOST" "mkdir -p '$PI_DIR' ~/.config/systemd/user"
rsync -az --exclude='.env' --exclude='node_modules' --exclude='.git' \
  -e "ssh ${SSH_OPTS[*]}" "$ROOT/" "$PI_HOST:$PI_DIR/"
if [[ -f "$ROOT/.env" ]]; then
  scp "${SSH_OPTS[@]}" -q "$ROOT/.env" "$PI_HOST:$PI_DIR/.env"
  ssh "${SSH_OPTS[@]}" "$PI_HOST" "chmod 600 '$PI_DIR/.env'"
fi
scp "${SSH_OPTS[@]}" -q "$ROOT/pi/$UNIT" "$PI_HOST:.config/systemd/user/$UNIT"

say "Starting NOVA on the Pi"
ssh "${SSH_OPTS[@]}" "$PI_HOST" "
  /home/rajarshi/.hermes/node/bin/node --check '$PI_DIR/server.js' &&
  systemctl --user daemon-reload &&
  systemctl --user enable --now '$UNIT' &&
  systemctl --user restart '$UNIT'
"

say "Waiting for http://$HOSTNAME_ONLY:$PORT/api/health"
for _ in $(seq 1 20); do
  if curl -fsS --max-time 4 "http://$HOSTNAME_ONLY:$PORT/api/health"; then
    printf '\n'
    say "NOVA is live at http://$HOSTNAME_ONLY:$PORT/"
    exit 0
  fi
  sleep 1
done

echo "NOVA did not answer on port $PORT" >&2
ssh "${SSH_OPTS[@]}" "$PI_HOST" "journalctl --user-unit '$UNIT' -n 40 --no-pager" >&2 || true
exit 1
