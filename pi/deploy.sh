#!/usr/bin/env bash
# Deploy / redeploy the NOVA bridge to the Raspberry Pi from the Mac.
#
#   pi/deploy.sh                # rajarshi@raspberrypi.local, /home/rajarshi/nova-bridge
#   PI_HOST=user@host pi/deploy.sh
#
# Steps: scp nova_bridge.py + the systemd user unit, create the bridge venv (+ OpenCV) if it is
# missing, byte-compile on the Pi, install the unit into ~/.config/systemd/user, daemon-reload, enable --now,
# restart (so a redeploy picks up the new code), then curl /health from the Mac. No sudo anywhere.
set -euo pipefail

PI_HOST="${PI_HOST:-rajarshi@raspberrypi.local}"
PI_DIR="${PI_DIR:-/home/rajarshi/nova-bridge}"
PORT="${PORT:-8433}"
UNIT="nova-bridge.service"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOSTNAME_ONLY="${PI_HOST#*@}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)

say() { printf '\n==> %s\n' "$*"; }

for f in nova_bridge.py "$UNIT"; do
  [[ -f "$HERE/$f" ]] || { echo "missing $HERE/$f" >&2; exit 1; }
done

say "Checking ssh to $PI_HOST"
ssh "${SSH_OPTS[@]}" "$PI_HOST" 'echo "connected to $(hostname) as $(whoami), $(python3 --version)"'

say "Copying files"
ssh "${SSH_OPTS[@]}" "$PI_HOST" "mkdir -p '$PI_DIR' ~/.config/systemd/user"
scp "${SSH_OPTS[@]}" -q "$HERE/nova_bridge.py" "$PI_HOST:$PI_DIR/nova_bridge.py"
scp "${SSH_OPTS[@]}" -q "$HERE/$UNIT" "$PI_HOST:.config/systemd/user/$UNIT"

say "Installing + (re)starting the user service"
ssh "${SSH_OPTS[@]}" "$PI_HOST" bash -s -- "$PI_DIR" "$UNIT" <<'REMOTE'
set -euo pipefail
PI_DIR="$1"; UNIT="$2"
chmod +x "$PI_DIR/nova_bridge.py"
# The bridge runs from its own venv so OpenCV (face detection) can be pip-installed without sudo;
# --system-site-packages keeps the Debian picamera2 / libcamera / numpy / smbus2 visible inside it.
if [[ ! -x "$PI_DIR/venv/bin/python" ]]; then
  echo "creating venv at $PI_DIR/venv"
  python3 -m venv --system-site-packages "$PI_DIR/venv"
fi
if ! "$PI_DIR/venv/bin/python" -c 'import cv2' 2>/dev/null; then
  echo "installing opencv-python-headless into the venv (one-off, ~100 MB)"
  "$PI_DIR/venv/bin/python" -m pip install --quiet --upgrade pip
  "$PI_DIR/venv/bin/python" -m pip install --quiet "opencv-python-headless>=4.10,<5" \
    || echo "WARNING: OpenCV install failed; the bridge will fall back to the skin-chroma detector"
fi
"$PI_DIR/venv/bin/python" -m py_compile "$PI_DIR/nova_bridge.py" && echo "syntax OK ($("$PI_DIR/venv/bin/python" --version))"
"$PI_DIR/venv/bin/python" -c 'import cv2; print("opencv", cv2.__version__)' 2>/dev/null || echo "opencv: absent (skin-chroma fallback)"
systemctl --user daemon-reload
systemctl --user enable --now "$UNIT"
# enable --now is a no-op for an already-running service; restart so new code takes effect.
systemctl --user restart "$UNIT"
sleep 1
systemctl --user --no-pager --lines=0 status "$UNIT" | sed -n '1,5p' || true
REMOTE

say "Waiting for http://$HOSTNAME_ONLY:$PORT/health"
ok=0
for _ in $(seq 1 20); do
  if body="$(curl -sS -m 3 "http://$HOSTNAME_ONLY:$PORT/health" 2>/dev/null)"; then
    echo "$body"
    ok=1
    break
  fi
  sleep 1
done
if [[ $ok -ne 1 ]]; then
  echo "bridge did not answer on port $PORT; recent log:" >&2
  ssh "${SSH_OPTS[@]}" "$PI_HOST" "journalctl --user-unit $UNIT -n 30 --no-pager" >&2 || true
  exit 1
fi

say "Deployed. Logs: ssh $PI_HOST journalctl --user-unit nova-bridge -f"
