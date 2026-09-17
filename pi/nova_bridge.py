#!/usr/bin/env python3
"""
nova_bridge.py -- NOVA dashboard bridge for the Raspberry Pi 5.

Serves, on http://0.0.0.0:8433 (every response carries Access-Control-Allow-Origin: *):

  GET  /health            {"status","camera","pantilt","attention","gestures","face_detector",...}
  GET  /stats             CPU / memory / disk / temperature / load / uptime / clock / throttle flags
  GET  /stream.mjpg       640x480 ~15 fps MJPEG (multipart/x-mixed-replace; boundary=FRAME)
  GET  /snapshot.jpg      one JPEG frame -- from the live stream if running, else a one-shot capture
  GET  /pantilt           {"ok","pan","tilt","limits","base","target","offset","gesture","ambient",...}
  POST /pantilt           {"pan": deg, "tilt": deg} (either optional) -> glide to the clamped target
  POST /pantilt/center    glide to 90/90
  POST /pantilt/release   stop the servo pulses (PWM off, no holding torque)
  GET  /gestures          the gesture / emote vocabulary the head can perform
  POST /gesture           {"name": "nod", "intensity": 1.0, "speed": 1.0, "queue": false} -> play it
  POST /gesture/stop      cancel the current gesture (and anything queued); return to the base pose
  POST /tts               synthesize speech through Hermes's configured TTS provider
  GET  /attention         current attention mode, lock state and detector telemetry
  GET  /attention/debug   what the face detector last saw, rendered as ASCII (on demand)
  POST /attention         {"mode": "wake"|"speak"|"think"|"tool"|"sleep"} -- drive the attention machine
  GET  /presence          is someone at the desk? since when? recent arrivals/departures
  POST /presence          {"enabled": bool} -- switch presence sensing on/off
  GET  /watch             desk watch state and recent motion/face events (with capture names)
  POST /watch             {"enabled": bool, "notify": bool} -- arm/disarm the desk watch
  POST /capture           {"label": "..."} -> take a photo, save it under ~/nova-captures, return its name
  GET  /captures          list saved photos (newest first); GET /captures/<name> serves one
  POST /notify            {"text": "...", "capture": "<name>"} -> message (and photo) to the user's Telegram
  GET  /status            one poll for the dashboard: presence + watch + attention + head + vibe summary
  GET  /vibe              music sensing: is there a beat, what tempo, how loud; is the head vibing
  POST /vibe              {"enabled": bool, "force": bool, "amplitude": float, "offset_ms": n} -- switch / force / trim
  GET  /vibe/trace        the last 15 s of commanded head pose plus the beat grid (is the nod on the beat?)
  GET  /metronome         is the visual metronome running, at what BPM
  POST /metronome         {"bpm": 100} nod on every beat of a fixed clock (up to an hour); {"enabled": false} stops

Vibe (v2.3). A USB microphone on the Pi feeds a small beat tracker: onset envelopes from spectral
flux at 100 frames/s (all bands plus the 300 Hz-3 kHz mids), tempo from a comb-filter tempogram
that is immune to the 3:2 / 4:3 confusions a plain autocorrelation makes, an octave-folding tempo
lock so the bobbing rate never flips mid-song, a phase-locked loop for the beat phase (median error
~17 ms on weak music), strong-beat parity, and a debounced gate (speech and room noise never pass).
While music plays and nobody is talking to Nova, the head drops onto every beat (every other beat
above ~130 BPM), sways across the bar and throws a flourish every eight bars or so.

Desk companion (v2.1). While nobody is talking to Nova the camera keeps quietly sensing presence
(a face check every few seconds; ~3% of one core for the sensor); when you sit down after being
away the head looks up and nods hello. "Watch my desk" arms motion + face detection at 2 Hz: the
head turns toward whatever moved, a photo is saved, and -- if the Hermes Telegram bot is
configured -- sent to your Telegram. Photos on demand and Telegram notifications are exposed for
the dashboard's reminders and "send me that" commands.

Motion model (v2). The head has one 40 Hz motion loop and three layers that sum into the pose
actually written to the servos:

  base pose    where the head *looks* -- set by the face tracker, the d-pad, or the parking logic;
               it glides toward its target at a per-command speed.
  gesture      a short keyframed script of offsets around the base pose (a nod, a shake, a bow ...).
               Played on request (POST /gesture) or by the attention machine while Nova thinks.
  ambient      procedural "talking" motion: small slow drifts and the odd micro-nod while Nova
               speaks, so she moves like someone talking rather than a camera on a stick.

Because gestures are offsets, the head keeps looking at you through a nod, and the tracker simply
pauses its integration while a gesture plays rather than fighting it.

Python 3.13 + picamera2/libcamera + smbus2 + numpy (system packages) + OpenCV headless from the
service's own venv (`~/nova-bridge/venv`, --system-site-packages). Without cv2 the face detector
falls back to the old skin-chroma finder. Runs as the `nova-bridge` systemd *user* service; logs
go to stdout -> journal.
"""

from __future__ import annotations

import io
import json
import logging
import math
import os
import queue
import random
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
import urllib.request
import urllib.error

# ----------------------------------------------------------------------------- configuration

VERSION = "2.3"
HOST = os.environ.get("NOVA_BRIDGE_HOST", "0.0.0.0")
PORT = int(os.environ.get("NOVA_BRIDGE_PORT", "8433"))

STREAM_SIZE = (640, 480)
STREAM_FPS = 15
JPEG_QUALITY = 80
LORES_SIZE = (320, 240)           # second ISP output, used only by the face tracker (free when unread)
CAMERA_IDLE_STOP_S = 5.0          # stop the camera this long after the last stream client leaves
CAMERA_TRANSFORM = {"hflip": 1, "vflip": 1}   # the module is mounted upside down on the bracket
SNAPSHOT_WARMUP_FRAMES = 8        # frames to let AE/AWB settle when a snapshot cold-starts the camera
SNAPSHOT_TIMEOUT_S = 8.0
CAMERA_FIRST_FRAME_TIMEOUT_S = 4.0   # libcamera occasionally reports "Camera frontend has timed out" right
CAMERA_START_ATTEMPTS = 3            # after a cold start and never delivers a frame; stop + retry fixes it

STATS_INTERVAL_S = 2.0

HERMES_HOME = os.environ.get("HERMES_HOME", "/home/rajarshi/.hermes")
HERMES_AGENT_DIR = os.environ.get("HERMES_AGENT_DIR", os.path.join(HERMES_HOME, "hermes-agent"))
HERMES_PYTHON = os.environ.get("HERMES_PYTHON", os.path.join(HERMES_AGENT_DIR, "venv", "bin", "python"))
TTS_MAX_CHARS = 6000
TTS_TIMEOUT_S = 120
TTS_MAX_BYTES = 16 * 1024 * 1024
TTS_LOCK = threading.Lock()
TTS_HELPER = """
import sys
from tools.tts_tool import text_to_speech_tool
print(text_to_speech_tool(text=sys.stdin.read()))
"""

I2C_BUS, PCA_ADDR = 1, 0x40
MODE1, PRESCALE, LED0_ON_L = 0x00, 0xFE, 0x06
PWM_FREQ = 50
TICK_US = 1_000_000.0 / PWM_FREQ / 4096   # ~4.88 us per PCA9685 tick
# Servo wiring, measured on the rig: channel 1 is the pan servo and channel 0 the tilt one
# (the reverse of the obvious order), and the pan servo swings the camera left as its angle
# rises, so pan is mirrored on the way out. Everything else -- the stored state, the limits,
# the HTTP API -- speaks logical degrees: pan grows to the right, tilt grows downward.
PAN_CH, TILT_CH = 1, 0
PAN_INVERT, TILT_INVERT = True, False
# Logical-degree limits. The defaults are the bracket's nominal range; the *mechanical* range of
# this rig is narrower (the camera meets the base well before tilt 150), and driving a servo into
# a stop is a stalled motor. POST /pantilt/calibrate measures the real stops with the camera and
# saves them to head_limits.json next to this script; NOVA_PAN_MIN/MAX and NOVA_TILT_MIN/MAX win
# over both.
LIMITS = {"pan": (10, 170), "tilt": (30, 150)}
LIMITS_FILE = os.environ.get("NOVA_HEAD_LIMITS", os.path.join(os.path.dirname(os.path.abspath(__file__)), "head_limits.json"))
LIMITS_MARGIN = 4                # degrees kept clear of a measured stop
CENTER = (90, 90)


def _load_limits() -> dict:
    info = {"source": "default"}
    try:
        with open(LIMITS_FILE) as fh:
            saved = json.load(fh)
        for axis in ("pan", "tilt"):
            lo, hi = saved[axis]
            if 0 <= int(lo) < int(hi) <= 180:
                LIMITS[axis] = (int(lo), int(hi))
        info = {"source": "calibrated", "at": saved.get("at"), "measured": saved.get("measured")}
    except (OSError, ValueError, TypeError, KeyError):
        pass
    for axis in ("pan", "tilt"):
        lo = os.environ.get(f"NOVA_{axis.upper()}_MIN")
        hi = os.environ.get(f"NOVA_{axis.upper()}_MAX")
        if lo or hi:
            cur = LIMITS[axis]
            LIMITS[axis] = (int(lo) if lo else cur[0], int(hi) if hi else cur[1])
            info["source"] = "env"
    return info


LIMITS_INFO = _load_limits()


def _save_limits(measured: dict) -> None:
    try:
        tmp = LIMITS_FILE + ".tmp"
        with open(tmp, "w") as fh:
            json.dump({"pan": list(LIMITS["pan"]), "tilt": list(LIMITS["tilt"]), "measured": measured, "at": time.time()}, fh)
        os.replace(tmp, LIMITS_FILE)
    except OSError as exc:
        log.warning("head limits not saved: %s", exc)

MOTION_HZ = 40                    # the motion loop; only writes the bus when a tick changes
GLIDE_SPEED_DPS = 200.0           # d-pad / tracker glides (3 deg per 15 ms, as before)
THINK_SPEED_DPS = 22.0            # slow enough to read as deliberate


def _envf(name: str, default: float) -> float:
    try:
        return float(os.environ[name])
    except (KeyError, ValueError):
        return default


# ------------------------------------------------------------------ attention / face tracking
#
# Every constant below with "measured" against it was taken off this rig, not from a datasheet.
#
# Geometry. Panning right moves the scene left, so both axes take the *natural* correction: a face
# on the right of the frame needs more pan, a face low in the frame needs more tilt. Measured by
# sweeping pan 75..105 and fitting the skin centroid (-11.23 px/deg, r=-0.978) and by moving tilt
# 49->61 (-13.35 px/deg). The implied FOV is what the control law converts pixels into degrees with.
TRACK_HFOV_DEG = _envf("NOVA_TRACK_HFOV", 57.0)     # 640 px / 11.23 px-per-deg
TRACK_VFOV_DEG = _envf("NOVA_TRACK_VFOV", 41.0)     # 480 px / 13.35 px-per-deg

# CENTER is (90, 90) and that points at the DESK -- measured. A seated head sits near tilt 55, so
# the attention machine parks here instead, and clamps tracking tilt to head height.
ATTENTION_HOME = (int(_envf("NOVA_HOME_PAN", 90)), int(_envf("NOVA_HOME_TILT", 55)))
# With the Haar detector a forearm on the desk is no longer mistaken for a face, so the tracker may
# aim well below the old 72 deg ceiling: on this rig (2026-09-13) the camera sits above head height
# and locks the seated face at tilt ~100-110, while tilt 55 looks at the ceiling light above it.
TRACK_TILT_RANGE = (int(_envf("NOVA_TRACK_TILT_MIN", 30)), int(_envf("NOVA_TRACK_TILT_MAX", 130)))


def track_tilt_range() -> tuple[int, int]:
    """The tilt the tracker may aim at: the configured range, kept inside the mechanical limits."""
    lo = max(TRACK_TILT_RANGE[0], LIMITS["tilt"][0])
    hi = min(TRACK_TILT_RANGE[1], LIMITS["tilt"][1] - LIMITS_MARGIN)
    return lo, max(lo, hi)
HEAD_STATE_FILE = os.environ.get("NOVA_HEAD_STATE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "head_state.json"))
REST_POSE_TTL_S = _envf("NOVA_REST_POSE_TTL", 24 * 3600.0)   # where a face was last found is where the head rests

TRACK_HZ = _envf("NOVA_TRACK_HZ", 4.0)              # detector cadence
TRACK_GAIN = _envf("NOVA_TRACK_GAIN", 0.38)         # fraction of the measured error applied per update.
                                                    # Deliberately under a half: the loop carries a
                                                    # frame of capture delay plus the glide's own lag,
                                                    # and a gain near 0.5 rings against that instead of
                                                    # settling. 0.38 converges in ~4 steps without
                                                    # overshoot, which reads as calm rather than twitchy.
TRACK_DEADZONE = _envf("NOVA_TRACK_DEADZONE", 0.07) # |offset| below this (frame fraction) => hold still
TRACK_MAX_STEP_DEG = _envf("NOVA_TRACK_MAX_STEP", 12.0)

# Haar cascade detector (OpenCV). 320x240 costs 5-14 ms a frame on the Pi 5; at 4 Hz that is a few
# percent of one core, which is the budget for a feature that runs beside Hermes.
FACE_DETECTOR = os.environ.get("NOVA_FACE_DETECTOR", "auto").strip().lower()   # auto | haar | skin
HAAR_SCALE = _envf("NOVA_HAAR_SCALE", 1.15)
HAAR_NEIGHBORS = int(_envf("NOVA_HAAR_NEIGHBORS", 4))
HAAR_MIN_PX = int(_envf("NOVA_HAAR_MIN_PX", 22))    # smaller faces than this on the 320-wide plane are noise
HAAR_EQUALIZE = os.environ.get("NOVA_HAAR_EQUALIZE", "1") != "0"
HAAR_PROFILE = os.environ.get("NOVA_HAAR_PROFILE", "1") != "0"   # also try the side-view cascade
HAAR_PROFILE_EVERY = int(_envf("NOVA_HAAR_PROFILE_EVERY", 3))    # ... but only on every Nth frame that the
                                                                  # frontal cascade misses: the two profile
                                                                  # passes (mirror included) cost ~45 ms
                                                                  # against ~7 ms for the frontal pass

# Skin locus for the fallback chroma detector (see SkinFaceFinder).
SKIN_CR_FLOOR = _envf("NOVA_SKIN_CR_FLOOR", 135.0)
SKIN_CB_CEIL = _envf("NOVA_SKIN_CB_CEIL", 132.0)
SKIN_CRCB_MIN = _envf("NOVA_SKIN_CRCB_MIN", 8.0)
SKIN_CR_MARGIN = _envf("NOVA_SKIN_CR_MARGIN", 8.0)
SKIN_CR_CEIL = _envf("NOVA_SKIN_CR_CEIL", 148.0)
LUMA_MIN, LUMA_MAX = 30, 245                        # ignore crushed blacks and blown highlights

TRACK_MIN_PX = 18
TRACK_MAX_FRAC = 0.40
TRACK_BLOB_MAX_PX = 520
TRACK_CONF_ACQUIRE = 0.40         # confidence needed to take a lock ...
TRACK_CONF_HOLD = 0.18            # ... and to keep one (hysteresis, so a profile view does not drop it)
TRACK_ACQUIRE_FRAMES = 2          # consecutive good frames before the lock counts

SEARCH_TIMEOUT_S = 2.5            # looking straight ahead and finding nobody -> start the scan
SEARCH_SCAN_DEG = _envf("NOVA_SEARCH_SCAN", 32.0)   # how far each way the scan looks
SEARCH_SCAN_TILT = (int(_envf("NOVA_SEARCH_TILT_DOWN", 24)), int(_envf("NOVA_SEARCH_TILT_UP", 15)))   # then lower, then higher
SEARCH_SCAN_HOLD_S = 2.4          # how long each scan pose is held while the detector looks
LAST_FACE_TTL_S = 600.0           # a face pose older than this is not worth starting the search at
LOST_GRACE_S = 1.6                # lost mid-track: hold still this long before giving up
PARK_WATCH_S = 8.0                # parked: keep watching this long in case she leans back into shot
PARK_HOLD_S = 25.0                # parked and quiet this long -> release the servos
CAMERA_SETTLE_S = 1.6             # after a cold start, ignore frames until AE/AWB converge
ATTENTION_LEASE_S = 12.0          # no word from the dashboard for this long -> park, then release
THINK_MAX_S = 150.0               # a runaway stream cannot gesture forever

THINK_DECAY = 0.86                # amplitude envelope per beat: a long tool run settles into waiting
THINK_DECAY_FLOOR = 0.35
THINK_GAP_S = (0.9, 2.2)          # pause between thinking beats (random in this range)

TALK_AMPLITUDE = _envf("NOVA_TALK_AMPLITUDE", 1.0)  # scales the ambient "talking" motion
IDLE_MOTION_AMPLITUDE = _envf("NOVA_IDLE_MOTION_AMPLITUDE", 1.0)
# A tracked face can be low in frame and is useful during a conversation, but keeping that
# pose as the all-day rest position makes the head appear to stare at the desk.  Idle rest is
# deliberately raised while active tracking remains free to use the full calibrated range.
IDLE_REST_TILT_MAX = int(_envf("NOVA_IDLE_TILT_MAX", 75))

# ------------------------------------------------------------------ desk companion
PRESENCE_ENABLED = os.environ.get("NOVA_PRESENCE", "1") != "0"
PRESENCE_PERIOD_S = _envf("NOVA_PRESENCE_PERIOD", 3.0)      # idle face check cadence (sensor stays on)
PRESENCE_AWAY_S = _envf("NOVA_PRESENCE_AWAY", 180.0)        # no face for this long -> "left"
PRESENCE_ARRIVE_FRAMES = 2                                  # consecutive detections before "arrived"
GREET_ON_ARRIVAL = os.environ.get("NOVA_GREET", "1") != "0" # the head looks up and nods when you sit down
GREET_COOLDOWN_S = _envf("NOVA_GREET_COOLDOWN", 1200.0)
GREET_LEASE_S = 10.0                                        # how long she keeps looking at you after a greeting
IDLE_GLANCE_S = _envf("NOVA_IDLE_GLANCE", 90.0)             # nobody seen: glance at another pose this often (0 = never)
IDLE_GLANCES = ((0, 0), (0, 25), (-22, 12), (22, 12), (0, -12))   # offsets from the rest pose the idle head cycles through
WATCH_PERIOD_S = _envf("NOVA_WATCH_PERIOD", 0.5)            # desk watch sampling cadence
WATCH_MOTION_DIFF = int(_envf("NOVA_WATCH_DIFF", 28))       # per-pixel luma change that counts as movement
WATCH_MOTION_FRAC = _envf("NOVA_WATCH_FRAC", 0.012)         # fraction of the frame that must move
WATCH_EVENT_GAP_S = _envf("NOVA_WATCH_EVENT_GAP", 20.0)     # one event per this many seconds at most
WATCH_NOTIFY_GAP_S = _envf("NOVA_WATCH_NOTIFY_GAP", 60.0)   # one Telegram message per this many seconds at most
WATCH_HOLD_S = 20.0                                         # after turning toward motion, hold this long, then release
# ------------------------------------------------------------------ music / vibe
VIBE_ENABLED = os.environ.get("NOVA_VIBE", "1") != "0"
MIC_SR, MIC_HOP, MIC_WIN = 16000, 160, 1024          # 10 ms hops (100 onset frames/s), 64 ms analysis window
MIC_CMD = os.environ.get("NOVA_MIC_CMD", "")          # override the capture command (shell syntax)
MIC_CMDS = (                                          # tried in order; each writes raw s16 mono to stdout
    ["pw-record", "--rate", str(MIC_SR), "--channels", "1", "--format", "s16", "--latency", "30ms", "--raw", "-"],
    ["arecord", "-q", "-D", "default", "-f", "S16_LE", "-r", str(MIC_SR), "-c", "1", "-t", "raw", "-"],
)
VIBE_MIN_DB = _envf("NOVA_VIBE_MIN_DB", -50.0)        # quieter than this (RMS dBFS) is never music worth moving
                                                      # to. This USB mic is quiet: a speaker beside it reads
                                                      # -40..-46 dBFS, a silent room about -60.
VIBE_SCORE_ON = _envf("NOVA_VIBE_SCORE_ON", 0.10)     # beat score (MusicSense: the time-averaged comb-tempogram
VIBE_SCORE_OFF = _envf("NOVA_VIBE_SCORE_OFF", 0.065)  # peak) that starts the vibe / under which it stops. Measured
                                                      # on this rig (2026-09-13): a Coldplay ballad from a small
                                                      # speaker at -41 dBFS 0.12-0.14 (0.09-0.11 with extra noise
                                                      # at -50 dBFS); white/pink noise, the room floor and speech
                                                      # at the same level <= 0.055.
VIBE_OFF_S = _envf("NOVA_VIBE_OFF_S", 4.0)            # score under VIBE_SCORE_OFF this long -> the music stopped
VIBE_DROP_DB = _envf("NOVA_VIBE_DROP_DB", 12.0)       # level this far under the level it started at -> stop
VIBE_DROP_S = _envf("NOVA_VIBE_DROP_S", 6.0)
VIBE_BPM_RANGE = (int(_envf("NOVA_VIBE_BPM_MIN", 60)), int(_envf("NOVA_VIBE_BPM_MAX", 200)))
VIBE_LATENCY_S = _envf("NOVA_VIBE_LATENCY", 0.045)    # capture pipeline delay (air -> pw-record -> here) taken off the grid
VIBE_LEAD_S = _envf("NOVA_VIBE_LEAD", 0.09)           # the nod is commanded this early: output low-pass + I2C tick + servo
VIBE_OFFSET_S = _envf("NOVA_VIBE_OFFSET_MS", 0.0) / 1000.0   # by-ear trim, live via POST /vibe {"offset_ms": n}; + = later
VIBE_AMPLITUDE = _envf("NOVA_VIBE_AMPLITUDE", 1.0)
VIBE_NOD_DEG = _envf("NOVA_VIBE_NOD", 15.0)           # full-depth nod at amplitude 1 (tilt degrees, downward)
VIBE_SWAY_DEG = _envf("NOVA_VIBE_SWAY", 12.0)         # pan sway amplitude (degrees)
VIBE_FORCE_MAX_S = _envf("NOVA_VIBE_FORCE_MAX", 600.0)   # a forced vibe stops on its own after this
METRO_MAX_S = _envf("NOVA_METRONOME_MAX", 3600.0)      # the metronome stops on its own after this
METRO_BPM_RANGE = (30.0, 240.0)

CAPTURES_DIR = os.environ.get("NOVA_CAPTURES_DIR", os.path.expanduser("~/nova-captures"))
CAPTURES_MAX = int(_envf("NOVA_CAPTURES_MAX", 500))
TELEGRAM_NOTIFY = os.environ.get("NOVA_TELEGRAM_NOTIFY", "auto").strip().lower()   # auto | 1 | 0

# Quiet libcamera's per-start INFO chatter in the journal (must be set before picamera2 is imported).
os.environ.setdefault("LIBCAMERA_LOG_LEVELS", "*:WARN")

logging.basicConfig(
    stream=sys.stdout,
    level=os.environ.get("NOVA_BRIDGE_LOGLEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("nova-bridge")

# ----------------------------------------------------------------------------- optional hardware libs

try:
    from picamera2 import Picamera2
    from picamera2.encoders import JpegEncoder
    from picamera2.outputs import FileOutput
    from libcamera import Transform

    PICAMERA_IMPORT_ERROR: Exception | None = None
    logging.getLogger("picamera2").setLevel(logging.WARNING)
except Exception as _exc:  # noqa: BLE001 - any import failure just disables the camera
    Picamera2 = JpegEncoder = FileOutput = Transform = None  # type: ignore[assignment]
    PICAMERA_IMPORT_ERROR = _exc

try:
    from smbus2 import SMBus

    SMBUS_IMPORT_ERROR: Exception | None = None
except Exception as _exc:  # noqa: BLE001
    SMBus = None  # type: ignore[assignment]
    SMBUS_IMPORT_ERROR = _exc

try:
    import numpy as np

    NUMPY_IMPORT_ERROR: Exception | None = None
except Exception as _exc:  # noqa: BLE001 - without numpy the tracker is disabled, nothing else breaks
    np = None  # type: ignore[assignment]
    NUMPY_IMPORT_ERROR = _exc

try:
    import cv2  # from the service venv; the system python does not have it

    CV2_IMPORT_ERROR: Exception | None = None
except Exception as _exc:  # noqa: BLE001 - the skin-chroma detector is the fallback
    cv2 = None  # type: ignore[assignment]
    CV2_IMPORT_ERROR = _exc


# ----------------------------------------------------------------------------- system stats

class StatsSampler:
    """Samples /proc/stat every STATS_INTERVAL_S in a background thread; everything else is read on demand."""

    def __init__(self, interval: float = STATS_INTERVAL_S) -> None:
        self.interval = interval
        self._lock = threading.Lock()
        self._prev = self._read_proc_stat()
        self._cpu_percent = 0.0
        self._cpu_per_core = [0.0] * len(self._prev[1])
        self._throttled = self._read_throttled()
        self._hostname = socket.gethostname()
        self._thread = threading.Thread(target=self._run, name="stats", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def _run(self) -> None:
        while True:
            time.sleep(self.interval)
            try:
                self._sample()
            except Exception:  # noqa: BLE001
                log.exception("stats sampler failed")

    def _sample(self) -> None:
        cur = self._read_proc_stat()
        prev, self._prev = self._prev, cur
        total = self._pct(prev[0], cur[0])
        cores = [self._pct(p, c) for p, c in zip(prev[1], cur[1])]
        throttled = self._read_throttled()
        with self._lock:
            self._cpu_percent, self._cpu_per_core, self._throttled = total, cores, throttled

    @staticmethod
    def _pct(prev: tuple[int, int], cur: tuple[int, int]) -> float:
        d_total, d_idle = cur[0] - prev[0], cur[1] - prev[1]
        if d_total <= 0:
            return 0.0
        return round(min(100.0, max(0.0, 100.0 * (1.0 - d_idle / d_total))), 1)

    @staticmethod
    def _read_proc_stat() -> tuple[tuple[int, int], list[tuple[int, int]]]:
        total, cores = (0, 0), []
        with open("/proc/stat") as f:
            for line in f:
                if not line.startswith("cpu"):
                    break
                name, *fields = line.split()
                vals = [int(v) for v in fields]
                idle = vals[3] + (vals[4] if len(vals) > 4 else 0)   # idle + iowait
                entry = (sum(vals), idle)
                if name == "cpu":
                    total = entry
                else:
                    cores.append(entry)
        return total, cores

    @staticmethod
    def _read_throttled() -> str | None:
        try:
            out = subprocess.run(["vcgencmd", "get_throttled"], capture_output=True, text=True, timeout=2)
            text = out.stdout.strip()            # "throttled=0x0"
            return text.split("=", 1)[1] if out.returncode == 0 and "=" in text else None
        except Exception:  # noqa: BLE001
            return None

    @staticmethod
    def _read_meminfo() -> dict:
        info: dict[str, int] = {}
        with open("/proc/meminfo") as f:
            for line in f:
                key, _, rest = line.partition(":")
                parts = rest.split()
                if parts:
                    info[key] = int(parts[0]) * 1024   # kB -> bytes
        total = info.get("MemTotal", 0)
        available = info.get("MemAvailable", info.get("MemFree", 0))
        used = max(0, total - available)
        return {
            "total": total,
            "used": used,
            "available": available,
            "percent": round(100.0 * used / total, 1) if total else 0.0,
        }

    @staticmethod
    def _read_first_number(path: str, scale: float) -> float | None:
        try:
            with open(path) as f:
                return float(f.read().split()[0]) * scale
        except Exception:  # noqa: BLE001
            return None

    def snapshot(self) -> dict:
        with self._lock:
            cpu, cores, throttled = self._cpu_percent, list(self._cpu_per_core), self._throttled
        du = shutil.disk_usage("/")
        temp = self._read_first_number("/sys/class/thermal/thermal_zone0/temp", 1 / 1000)
        freq = self._read_first_number("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq", 1 / 1000)
        uptime = self._read_first_number("/proc/uptime", 1)
        return {
            "hostname": self._hostname,
            "cpu_percent": cpu,
            "cpu_per_core": cores,
            "ncpu": os.cpu_count() or len(cores),
            "mem": self._read_meminfo(),
            "disk": {
                "total": du.total,
                "used": du.used,
                "percent": round(100.0 * du.used / du.total, 1) if du.total else 0.0,
            },
            "temp_c": round(temp, 1) if temp is not None else None,
            "load": [round(x, 2) for x in os.getloadavg()],
            "uptime_s": int(uptime) if uptime is not None else None,
            "cpu_freq_mhz": int(freq) if freq is not None else None,
            "throttled": throttled,
        }


# ----------------------------------------------------------------------------- camera

class CameraError(RuntimeError):
    pass


class StreamingOutput(io.BufferedIOBase):
    """picamera2 FileOutput sink: keeps the latest JPEG and wakes every waiting stream writer per frame."""

    def __init__(self) -> None:
        self.frame: bytes | None = None
        self.seq = 0
        self.condition = threading.Condition()

    def write(self, buf) -> int:  # noqa: ANN001 - picamera2 hands us bytes
        with self.condition:
            self.frame = bytes(buf)
            self.seq += 1
            self.condition.notify_all()
        return len(buf)

    def reset(self) -> None:
        with self.condition:
            self.frame = None
            self.condition.notify_all()


class Camera:
    """Lazy-start / idle-stop wrapper around one Picamera2 instance. All start/stop goes through `_lock`."""

    def __init__(self) -> None:
        self.output = StreamingOutput()
        self._lock = threading.Lock()
        self._picam = None
        self._started = False            # sensor + ISP running
        self._recording = False          # ... and the JPEG encoder attached on top
        self._encode_clients = 0         # MJPEG stream / snapshot: need JPEGs
        self._raw_clients = 0            # face tracker: needs frames, not pictures
        self._stop_timer: threading.Timer | None = None
        self._detected = False
        self._last_probe = 0.0
        self._lores_geom: tuple[int, int, int] | None = None   # (width, height, stride)
        self.probe()

    @staticmethod
    def _read_lores_geom(picam) -> tuple[int, int, int] | None:  # noqa: ANN001
        """Read the lores geometry back from the camera -- never assume it.

        The buffer is stride-padded and libcamera picks the stride, not us. Reshaping to the nominal
        width shears every row into a plausible-looking but meaningless image, and nothing raises.
        """
        try:
            cfg = picam.camera_configuration()["lores"]
            w, h = cfg["size"]
            stride = int(cfg["stride"])
        except Exception as exc:  # noqa: BLE001
            log.warning("no lores stream configured (%s); face tracking disabled", exc)
            return None
        if stride < w or h % 2 or w % 2:
            log.warning("unusable lores geometry %dx%d stride=%d; face tracking disabled", w, h, stride)
            return None
        log.info("lores tracker plane: %dx%d stride=%d", w, h, stride)
        return int(w), int(h), stride

    @property
    def lores_geom(self) -> tuple[int, int, int] | None:
        return self._lores_geom

    # -- detection ----------------------------------------------------------------
    def probe(self) -> bool:
        self._last_probe = time.monotonic()
        if PICAMERA_IMPORT_ERROR is not None:
            log.warning("picamera2 unavailable: %s", PICAMERA_IMPORT_ERROR)
            self._detected = False
            return False
        try:
            info = Picamera2.global_camera_info()
        except Exception as exc:  # noqa: BLE001
            log.warning("camera probe failed: %s", exc)
            info = []
        self._detected = bool(info)
        if info:
            log.info("camera detected: %s (%s)", info[0].get("Model"), info[0].get("Id"))
        else:
            log.warning("no camera detected")
        return self._detected

    @property
    def available(self) -> bool:
        # Re-probe occasionally if nothing was found, so a camera that shows up later is picked up.
        if not self._detected and PICAMERA_IMPORT_ERROR is None and time.monotonic() - self._last_probe > 30:
            with self._lock:
                if self._picam is None:
                    self.probe()
        return self._detected

    @property
    def running(self) -> bool:
        return self._started

    @property
    def encoding(self) -> bool:
        return self._recording

    @property
    def clients(self) -> int:
        return self._encode_clients + self._raw_clients

    @property
    def encode_clients(self) -> int:
        return self._encode_clients

    @property
    def raw_clients(self) -> int:
        return self._raw_clients

    # -- client bookkeeping ---------------------------------------------------------
    #
    # Two kinds of client, and the distinction is worth real CPU. A stream or snapshot viewer needs
    # JPEGs; the face tracker only needs raw frames off the lores plane. JpegEncoder is a *software*
    # encoder (there is no hardware JPEG path on a Pi 5), and measured on this rig encoding 640x480
    # at 15 fps costs 3.83% of one core -- against 2.83% for running the sensor alone. Attaching it
    # for a tracker that never reads a JPEG would more than double the price of the whole feature,
    # so the encoder is started only when somebody actually wants pictures.
    def acquire(self, *, encode: bool = True) -> tuple[StreamingOutput, bool]:
        """Register a client; start what it needs. Returns (output, cold_start)."""
        with self._lock:
            if self._stop_timer is not None:
                self._stop_timer.cancel()
                self._stop_timer = None
            cold = not self._started
            if cold:
                self._start_locked()
            if encode:
                if self._encode_clients == 0:
                    self._start_encoder_locked()
                self._encode_clients += 1
            else:
                self._raw_clients += 1
            return self.output, cold

    def release(self, immediate: bool = False, *, encode: bool = True) -> None:
        """Unregister a client; when none remain, stop now (immediate) or after CAMERA_IDLE_STOP_S."""
        with self._lock:
            if encode:
                self._encode_clients = max(0, self._encode_clients - 1)
                if self._encode_clients == 0 and self._recording:
                    self._stop_encoder_locked()
            else:
                self._raw_clients = max(0, self._raw_clients - 1)
            if self._encode_clients + self._raw_clients or not self._started:
                return
            if immediate:
                self._stop_locked()
                return
            self._stop_timer = threading.Timer(CAMERA_IDLE_STOP_S, self._idle_stop)
            self._stop_timer.daemon = True
            self._stop_timer.start()
            log.info("no camera clients left; camera stops in %.0f s unless someone reconnects", CAMERA_IDLE_STOP_S)

    def _idle_stop(self) -> None:
        with self._lock:
            self._stop_timer = None
            if self._encode_clients + self._raw_clients == 0 and self._picam is not None:
                self._stop_locked()

    def shutdown(self) -> None:
        with self._lock:
            if self._stop_timer is not None:
                self._stop_timer.cancel()
                self._stop_timer = None
            if self._started:
                self._stop_locked()
            if self._picam is not None:
                self._close_locked()

    # -- picamera2 plumbing (call with _lock held) -----------------------------------
    def _start_locked(self) -> None:
        if PICAMERA_IMPORT_ERROR is not None:
            raise CameraError(f"picamera2 unavailable: {PICAMERA_IMPORT_ERROR}")
        output = self.output
        last_error = "unknown"
        for attempt in range(1, CAMERA_START_ATTEMPTS + 1):
            t0 = time.monotonic()
            picam = self._picam
            reused = picam is not None
            try:
                if picam is None:
                    picam = Picamera2()
                    config = picam.create_video_configuration(
                        main={"size": STREAM_SIZE},
                        # Second ISP output for the face tracker. Declared unconditionally and for
                        # the life of the object: this block only runs when _picam is None, so a
                        # stream client that opened the camera first would otherwise leave the
                        # tracker with no lores plane. An unread lores stream costs nothing.
                        lores={"size": LORES_SIZE, "format": "YUV420"},
                        transform=Transform(**CAMERA_TRANSFORM),
                        controls={"FrameRate": STREAM_FPS},
                    )
                    picam.configure(config)
                    self._lores_geom = self._read_lores_geom(picam)
                picam.start()
                # Don't trust a start until the sensor has actually delivered a frame. Metadata
                # arrives per frame whether or not the encoder is attached, and `wait` bounds it so
                # a wedged sensor still fails rather than hanging this lock forever.
                picam.wait(picam.capture_metadata(wait=False), timeout=CAMERA_FIRST_FRAME_TIMEOUT_S)
            except Exception as exc:  # noqa: BLE001
                last_error = str(exc)
                log.warning("camera start attempt %d/%d failed: %s", attempt, CAMERA_START_ATTEMPTS, exc)
                if picam is not None:
                    for fn in (picam.stop, picam.close):
                        try:
                            fn()
                        except Exception:  # noqa: BLE001
                            pass
                self._picam = None
                self._started = False
                self._recording = False
                output.reset()
                if attempt < CAMERA_START_ATTEMPTS:
                    time.sleep(0.5)
                continue
            self._picam = picam
            self._started = True
            self._detected = True
            log.info(
                "camera started: %dx%d @ %d fps, hflip=%d vflip=%d (%.2f s, attempt %d, %s)",
                *STREAM_SIZE, STREAM_FPS, CAMERA_TRANSFORM["hflip"], CAMERA_TRANSFORM["vflip"],
                time.monotonic() - t0, attempt, "reused" if reused else "opened",
            )
            return
        log.error("camera start failed after %d attempts: %s", CAMERA_START_ATTEMPTS, last_error)
        raise CameraError(last_error)

    def _start_encoder_locked(self) -> None:
        """Attach the JPEG encoder. Only ever called for a client that actually wants pictures."""
        picam = self._picam
        if picam is None or not self._started or self._recording:
            return
        output = self.output
        with output.condition:
            seq0 = output.seq
        picam.start_encoder(JpegEncoder(q=JPEG_QUALITY), FileOutput(output))
        self._recording = True
        with output.condition:
            if not output.condition.wait_for(lambda: output.seq > seq0, timeout=CAMERA_FIRST_FRAME_TIMEOUT_S):
                log.warning("JPEG encoder produced no frame within %.0f s", CAMERA_FIRST_FRAME_TIMEOUT_S)
        log.info("JPEG encoder attached (q=%d, %dx%d)", JPEG_QUALITY, *STREAM_SIZE)

    def _stop_encoder_locked(self) -> None:
        picam = self._picam
        if picam is None or not self._recording:
            return
        try:
            picam.stop_encoder()
        except Exception:  # noqa: BLE001
            log.exception("stop_encoder failed")
        finally:
            self._recording = False
        self.output.reset()
        log.info("JPEG encoder detached (no viewers); sensor still running for the tracker")

    def _stop_locked(self) -> None:
        picam = self._picam
        if picam is None or not self._started:
            return
        if self._recording:
            self._stop_encoder_locked()
        try:
            picam.stop()
        except Exception:  # noqa: BLE001
            log.exception("camera stop failed")
        finally:
            self._started = False
        self.output.reset()
        # Keep the configured Picamera2 object open. Repeated close/reopen cycles can leave
        # the Pi ISP V4L2 node busy or unable to restart; retaining the object keeps ownership
        # stable while the sensor and encoder are stopped between viewers.
        log.info("camera capture stopped (configured device kept open)")

    def _close_locked(self) -> None:
        if self._started:
            self._stop_locked()
        picam, self._picam = self._picam, None
        if picam is None:
            return
        try:
            picam.close()
        except Exception:  # noqa: BLE001
            log.exception("camera close failed")
        self.output.reset()
        log.info("camera device closed")

    # -- tracker frame source ---------------------------------------------------------
    def grab_lores(self):
        """Latest lores frame as (luma, Cb, Cr) uint8 arrays, or None.

        `luma` is the full-resolution Y plane (h x w); Cb and Cr are the half-resolution chroma
        planes (h/2 x w/2). The caller must already hold an `acquire()` lease, and must not hold
        `_lock`: this blocks for up to one frame period waiting on the sensor.

        Two layout details, both silent if you get them wrong:
          * the rows are stride-padded, so the padding must be sliced off;
          * the plane order is plain I420 -- Y, then U (Cb), then V (Cr). Verified by
            reconstructing RGB both ways and looking at the pictures; the YV12 reading renders the
            room with red and blue swapped. Do not "verify" it by correlating against the main
            stream, which is XBGR8888 and inverts the answer if its own order is misread.
        """
        if np is None:
            return None
        geom = self._lores_geom
        picam = self._picam
        if geom is None or picam is None or not self._started:
            return None
        w, h, stride = geom
        try:
            raw = picam.capture_buffer("lores")
        except Exception as exc:  # noqa: BLE001 - the camera can be torn down underneath us
            log.debug("lores capture failed: %s", exc)
            return None
        ysz = h * stride
        csz = (h // 2) * (stride // 2)
        if raw is None or len(raw) < ysz + 2 * csz:
            return None
        f = np.frombuffer(raw, dtype=np.uint8)
        luma = f[:ysz].reshape(h, stride)[:, :w]
        cb = f[ysz:ysz + csz].reshape(h // 2, stride // 2)[:, :w // 2]     # U (Cb) plane first
        cr = f[ysz + csz:ysz + 2 * csz].reshape(h // 2, stride // 2)[:, :w // 2]   # then V (Cr)
        return luma, cb, cr

    # -- one-shot capture -------------------------------------------------------------
    def snapshot(self, timeout: float = SNAPSHOT_TIMEOUT_S) -> bytes:
        """Latest frame if the stream is running; otherwise start, wait for a settled frame, stop."""
        output, cold = self.acquire()
        try:
            with output.condition:
                if not cold and output.frame is not None:
                    return output.frame
                target_seq = output.seq + (SNAPSHOT_WARMUP_FRAMES if cold else 1)
                ok = output.condition.wait_for(
                    lambda: output.frame is not None and output.seq >= target_seq, timeout=timeout
                )
                if not ok or output.frame is None:
                    raise TimeoutError("no frame from camera")
                return output.frame
        finally:
            self.release(immediate=cold)


# ----------------------------------------------------------------------------- gestures

def _clamp(value: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, value))


def _clampf(value: float, lo: float, hi: float) -> float:
    return max(float(lo), min(float(hi), float(value)))


def _smoothstep(t: float) -> float:
    t = _clampf(t, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


class Gesture:
    """A keyframed script of (pan, tilt) offsets around the head's base pose.

    Authored as segments: each `(d_pan, d_tilt, seconds[, hold])` moves to that offset over
    `seconds` with an ease-in-out curve, then holds it for `hold`. Offsets are logical degrees:
    +pan looks to the head's right, +tilt looks down. A gesture normally ends back at (0, 0); one
    whose last key is elsewhere gets a return segment appended unless it `settle`s -- "hold" folds
    the final offset into the base pose (the head stays there), "release" does that and then
    powers the servos down (nodding off).
    """

    def __init__(self, name: str, segments, description: str = "", aliases=(),
                 settle: str | None = None, public: bool = True) -> None:
        self.name = name
        self.description = description
        self.aliases = tuple(aliases)
        self.settle = settle
        self.public = public
        keys: list[tuple[float, float, float, float]] = [(0.0, 0.0, 0.0, 0.0)]   # (t_start, t_end, dp, dt)
        t = 0.0
        for seg in segments:
            dp, dt, dur = float(seg[0]), float(seg[1]), max(0.02, float(seg[2]))
            hold = float(seg[3]) if len(seg) > 3 else 0.0
            keys.append((t, t + dur, dp, dt))
            t += dur + hold
            if hold > 0:
                keys.append((t - hold, t, dp, dt))      # a hold is a zero-motion segment
        last_dp, last_dt = keys[-1][2], keys[-1][3]
        if settle is None and (abs(last_dp) > 0.01 or abs(last_dt) > 0.01):
            dur = max(0.3, math.hypot(last_dp, last_dt) / 60.0)
            keys.append((t, t + dur, 0.0, 0.0))
            t += dur
        self._keys = keys
        self.duration = t
        self.final_offset = (keys[-1][2], keys[-1][3])

    def offset_at(self, t: float) -> tuple[float, float]:
        """Offset at gesture-time `t` (seconds from the start)."""
        if t <= 0:
            return 0.0, 0.0
        prev_dp, prev_dt = 0.0, 0.0
        for (t0, t1, dp, dt) in self._keys[1:]:
            if t < t0:
                return prev_dp, prev_dt
            if t <= t1:
                u = _smoothstep((t - t0) / (t1 - t0)) if t1 > t0 else 1.0
                return prev_dp + (dp - prev_dp) * u, prev_dt + (dt - prev_dt) * u
            prev_dp, prev_dt = dp, dt
        return self.final_offset

    def to_json(self) -> dict:
        return {
            "name": self.name,
            "aliases": list(self.aliases),
            "description": self.description,
            "duration_s": round(self.duration, 2),
        }


class GesturePlayer:
    """One gesture in flight: scales it by intensity and speed, samples it against wall time."""

    def __init__(self, gesture: Gesture, intensity: float = 1.0, speed: float = 1.0) -> None:
        self.gesture = gesture
        self.intensity = _clampf(intensity, 0.2, 1.6)
        self.speed = _clampf(speed, 0.4, 2.5)
        self.started = 0.0

    def begin(self, now: float) -> None:
        self.started = now

    @property
    def duration(self) -> float:
        return self.gesture.duration / self.speed

    def sample(self, now: float):
        """(d_pan, d_tilt) for now, or None once the gesture has finished."""
        t = (now - self.started) * self.speed
        if t >= self.gesture.duration:
            return None
        dp, dt = self.gesture.offset_at(t)
        return dp * self.intensity, dt * self.intensity

    def final_offset(self) -> tuple[float, float]:
        dp, dt = self.gesture.final_offset
        return dp * self.intensity, dt * self.intensity


def _G(name, segs, desc, aliases=(), settle=None, public=True):  # noqa: ANN001
    return Gesture(name, segs, desc, aliases, settle, public)


# The emote vocabulary. Offsets are logical degrees: +pan looks to the head's own right, +tilt
# looks down. Timings are tuned for hobby servos: nothing here asks for more than ~120 deg/s.
GESTURES: list[Gesture] = [
    _G("avoid_left", [(-12, -5, .3), (-14, -5, .45), (-12, -4, .35), (0, 0, 1.4)],
       "quickly turn away to the left, then cautiously return"),
    _G("avoid_right", [(12, -5, .3), (14, -5, .45), (12, -4, .35), (0, 0, 1.4)],
       "quickly turn away to the right, then cautiously return"),
    _G("nod", [(0, 7, .22), (0, -3, .22), (0, 6, .22), (0, 0, .28)], "a clear yes",
       aliases=("yes", "agree", "affirm", "okay")),
    _G("shake", [(-12, 0, .28), (12, 0, .4), (-8, 0, .36), (5, 0, .3), (0, 0, .26)], "a clear no",
       aliases=("no", "disagree", "deny", "nope")),
    _G("emphasis", [(0, 5, .16), (0, 0, .24)], "a small beat on a key word", aliases=("beat", "point")),
    _G("tilt", [(9, -6, .5, 1.2), (0, 0, .6)], "head cocked, curious", aliases=("curious", "hmm", "intrigued")),
    _G("look_around", [(-35, -4, .9, .5), (35, -4, 1.7, .5), (0, 0, .9)], "scan the room",
       aliases=("scan", "look_round", "search")),
    _G("bow", [(0, 32, .9, .7), (0, 0, 1.0)], "a bow", aliases=("take_a_bow", "thanks", "thank_you")),
    _G("excited", [(0, -6, .16), (0, 6, .16), (0, -6, .16), (0, 6, .16), (0, -5, .16), (0, 4, .16), (0, 0, .24)],
       "bouncy delight", aliases=("bounce", "happy", "joy", "delighted")),
    _G("celebrate", [(-14, -8, .3), (14, -8, .4), (-10, 4, .35), (10, -6, .35), (0, -4, .3), (0, 0, .4)],
       "a little victory dance", aliases=("cheer", "hooray", "yay", "woohoo")),
    _G("sad", [(-4, 20, 1.6, 1.2), (0, 0, 1.4)], "droop", aliases=("droop", "sorry", "disappointed", "apologetic")),
    _G("surprise", [(0, -15, .14), (3, -13, .4, .5), (0, 0, .7)], "a startled jolt back",
       aliases=("startled", "shocked", "wow", "gasp")),
    _G("laugh", [(0, -4, .13), (0, 4, .13), (0, -4, .13), (0, 4, .13), (0, -3, .13), (0, 3, .13), (0, 0, .2)],
       "a chuckle", aliases=("chuckle", "giggle", "amused")),
    _G("think", [(-9, -8, .7, 1.5), (8, -6, .9, 1.5), (0, 0, .7)], "look up and away, pondering",
       aliases=("ponder", "hmmm", "consider", "thinking")),
    _G("confused", [(-7, -5, .4), (7, -5, .6), (-5, -6, .5), (0, 0, .5)], "puzzled", aliases=("puzzled", "huh", "unsure")),
    _G("peek", [(24, 4, .5, 1.0), (0, 0, .6)], "peek round the side", aliases=("glance", "sneak")),
    _G("double_take", [(-26, 0, .3, .25), (0, 0, .28, .2), (-26, 0, .28, .8), (0, 0, .45)], "look away, snap back",
       aliases=("doubletake", "what")),
    _G("greet", [(0, -6, .28), (0, 5, .34), (0, -2, .26), (0, 0, .3)], "a friendly hello",
       aliases=("hello", "hi", "welcome")),
    _G("wave", [(-18, -3, .35), (18, -3, .45), (-18, -3, .45), (18, -3, .45), (0, 0, .4)], "a side-to-side wave",
       aliases=("bye", "goodbye", "farewell")),
    _G("dance", [(-16, -5, .32), (16, 5, .32), (-16, -5, .32), (16, 5, .32), (-12, -8, .3), (12, -8, .3),
                 (0, 6, .25), (0, -6, .25), (0, 0, .4)], "a little dance", aliases=("boogie", "groove", "party")),
    _G("shiver", [(-3, 0, .08), (3, 0, .08), (-3, 0, .08), (3, 0, .08), (-3, 0, .08), (3, 0, .08), (-2, 0, .08), (0, 0, .12)],
       "a shiver", aliases=("brr", "tremble", "scared")),
    _G("look_up", [(0, -16, .5, 1.0), (0, 0, .6)], "glance up", aliases=("up",)),
    _G("look_down", [(0, 16, .5, 1.0), (0, 0, .6)], "glance down", aliases=("down", "glance_down")),
    _G("look_left", [(-28, 0, .55, 1.0), (0, 0, .6)], "look to the head's own left", aliases=("left",)),
    _G("look_right", [(28, 0, .55, 1.0), (0, 0, .6)], "look to the head's own right", aliases=("right",)),
    _G("listen", [(0, 4, .5, 1.4), (0, 0, .5)], "lean in, attentive", aliases=("lean_in", "attentive", "focus")),
    _G("sleepy", [(0, 10, 1.6), (0, 7, .8), (0, 20, 1.8), (0, 17, .9), (0, 28, 1.6, 1.0)], "nod off",
       aliases=("tired", "yawn", "sleep", "nap"), settle="release"),
    # One unbroken nod-off animation. Negative offsets leave headroom at a downward
    # rest pose; zero final offset avoids ratcheting the base into the bracket.
    _G("fall_asleep", [(0, -18, 3.0), (0, -4, 3.0), (0, -16, 3.0), (0, -2, 3.0),
                       (0, -13, 3.0), (0, 0, 3.0), (0, -10, 3.0), (0, 0, 3.0),
                       (0, -6, 3.0), (0, 0, 3.0)],
       "30 seconds of sleepy nods, then stillness", settle="release"),
    # Private beats used by the attention machine while Nova thinks (not offered as emotes).
    _G("_think_a", [(-9, -8, .8, 1.6), (0, 0, .7)], "", public=False),
    _G("_think_b", [(8, -6, .9, 1.8), (0, -3, .6, 1.0), (0, 0, .6)], "", public=False),
    _G("_think_nod", [(0, 3, .35), (0, -4, .5, .8), (0, 0, .5)], "", public=False),
    _G("_think_glance", [(0, 0, .3, 1.2), (0, 0, .2)], "", public=False),   # "still with you": a beat of stillness
    _G("_tool_glance", [(0, 9, .5, .7), (0, 0, .5)], "", public=False),      # "glances at its hands"
]
GESTURE_INDEX: dict[str, Gesture] = {}
for _g in GESTURES:
    GESTURE_INDEX[_g.name] = _g
    for _a in _g.aliases:
        GESTURE_INDEX.setdefault(_a, _g)
THINK_SEQUENCE = ("_think_a", "_think_glance", "_think_nod", "_think_b", "_think_glance")


def find_gesture(name: str) -> Gesture | None:
    key = str(name or "").strip().lower().replace("-", "_").replace(" ", "_")
    return GESTURE_INDEX.get(key)


class AmbientTalk:
    """Procedural motion for while Nova speaks: slow drifting attention plus the odd micro-nod.

    Two sums of sines per axis (incommensurate periods so it never visibly loops), scaled by an
    envelope that ramps in over half a second and, once `stop()` is called, ramps out so the head
    settles instead of stopping dead mid-sway. Micro-nods are sprinkled every few seconds.
    """

    RAMP_S = 0.6

    def __init__(self, amplitude: float = 1.0) -> None:
        self.amp = _clampf(amplitude, 0.0, 2.0)
        self.started = 0.0
        self.stop_at: float | None = None
        self._phase = [random.random() * math.tau for _ in range(4)]
        self._nod_at = 0.0
        self._nod_gap = (2.0, 5.0)

    def begin(self, now: float) -> None:
        self.started = now
        self._nod_at = now + random.uniform(1.0, 2.5)

    def stop(self, now: float) -> None:
        if self.stop_at is None:
            self.stop_at = now

    def sample(self, now: float):
        """(d_pan, d_tilt), or None once the fade-out has completed."""
        t = now - self.started
        env = _smoothstep(t / self.RAMP_S)
        if self.stop_at is not None:
            env *= 1.0 - _smoothstep((now - self.stop_at) / self.RAMP_S)
            if now - self.stop_at >= self.RAMP_S:
                return None
        p = self._phase
        dp = 2.4 * (0.6 * math.sin(math.tau * t / 5.3 + p[0]) + 0.4 * math.sin(math.tau * t / 2.9 + p[1]))
        dt = 1.7 * (0.6 * math.sin(math.tau * t / 4.1 + p[2]) + 0.4 * math.sin(math.tau * t / 1.9 + p[3]))
        # micro-nod: a 0.7 s dip, scheduled at random intervals
        if now >= self._nod_at:
            u = (now - self._nod_at) / 0.7
            if u >= 1.0:
                self._nod_at = now + random.uniform(*self._nod_gap)
            else:
                dt += 3.0 * math.sin(math.pi * u)
        return dp * self.amp * env, dt * self.amp * env


class AmbientIdle(AmbientTalk):
    """Very small, unbroken idle drift so the desk companion feels alive between gestures."""

    RAMP_S = 1.5

    def sample(self, now: float):
        t = now - self.started
        env = _smoothstep(t / self.RAMP_S)
        if self.stop_at is not None:
            env *= 1.0 - _smoothstep((now - self.stop_at) / self.RAMP_S)
            if now - self.stop_at >= self.RAMP_S:
                return None
        p = self._phase
        dp = 1.8 * (0.62 * math.sin(math.tau * t / 11.3 + p[0])
                    + 0.38 * math.sin(math.tau * t / 7.1 + p[1]))
        dt = 1.2 * (0.65 * math.sin(math.tau * t / 13.7 + p[2])
                    + 0.35 * math.sin(math.tau * t / 8.9 + p[3]))
        return dp * self.amp * env, dt * self.amp * env


# ----------------------------------------------------------------------------- music sensing

class BeatClock:
    """What the motion layer needs to know about the music, and nothing else: a beat period, one
    beat's timestamp to phase-lock to, how sure we are, and how loud it is. Written by MusicSense,
    read at 40 Hz by AmbientVibe; a lock keeps the pair consistent."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.period = 0.5                 # seconds per beat (120 BPM until told otherwise)
        self.anchor = 0.0                 # monotonic time of a beat
        self.confidence = 0.0
        self.strength = 0.0               # 0..1 loudness relative to the recent loudest passage
        self.bpm = 0.0
        self.beats = 0
        self.break_at = 0.0               # when the tracker last asked the head for a listening break

    def request_break(self) -> None:
        with self._lock:
            self.break_at = time.monotonic()

    def set(self, *, period=None, anchor=None, confidence=None, strength=None, bpm=None) -> None:  # noqa: ANN001
        with self._lock:
            if period is not None:
                self.period = max(0.25, min(1.2, float(period)))
            if anchor is not None:
                self.anchor = float(anchor)
            if confidence is not None:
                self.confidence = float(confidence)
            if strength is not None:
                self.strength = float(strength)
            if bpm is not None:
                self.bpm = float(bpm)

    def read(self) -> tuple[float, float, float, float]:
        with self._lock:
            return self.period, self.anchor, self.confidence, self.strength

    def phase(self, now: float) -> float:
        period, anchor, _c, _s = self.read()
        return ((now - anchor) / period) % 1.0

    def beat_index(self, now: float) -> int:
        period, anchor, _c, _s = self.read()
        return int(math.floor((now - anchor) / period))


class MusicSense:
    """Listens to the Pi's microphone and decides whether there is music with a beat to move to --
    and exactly where its beats fall.

    Pipeline, all numpy: 16 kHz mono from `pw-record` (or `arecord`) in 10 ms hops, stamped from the
    sample counter (not the pipe's arrival time, which carries the quantum's buffering jitter) -> a
    Hann-windowed 1024-point FFT -> log band energies: 32 log-spaced bands over 60 Hz-7 kHz, plus 20
    over the 300 Hz-3 kHz mids, where a small speaker's transients survive the trip to a cheap mic
    (bass weighting was measured to be the worst choice here) -> spectral flux (half-wave rectified
    change) = two onset envelopes at 100 frames/s. Every 250 ms:

    * tempo. Normalised autocorrelation (one FFT, out to four times the longest beat period) of
      each mean-removed envelope over the last 8 s, averaged, then a pairwise-minimum comb --
      min(r(T), r(2T)) + min(r(2T), r(3T)) + min(r(3T), r(4T)), weighted -- so the real beat
      period, all of whose multiples are peaks, beats the 3:2 and 4:3 impostors a plain curve (or a
      plain sum of teeth) throws up: through this mic a 140 BPM ballad read 93 and an 82 BPM song
      read 109 before this. A soft log-Gaussian prior (120 BPM, one octave) breaks octave ties. The
      curve is averaged over time (tau ~1.4 s; a running mean while it fills) and its peak is the
      beat *score*.
    * the lock. Once the score passes VIBE_SCORE_ON the period is locked. Later estimates are folded
      by octaves onto the locked level and blended in; an estimate on another metrical level (3:2,
      4:3, ...) is ignored unless it persists for six seconds, so the bobbing rate never flips
      mid-song.
    * beat phase: a phase-locked loop onto the *strongest onset cluster*. The onset energy of the
      last 4 s (recency weighted) is laid on the current beat grid as a phase histogram; the circular
      mean of the cluster around its peak gives the phase error, which pulls the anchor (gain 0.35,
      0.6 while settling, a full jump at lock and when a clearly stronger cluster has held for
      1.5 s) and, gently, the period (second order: a 0.3 BPM error from the autocorrelation is
      gone within half a minute). The cluster's share of the onset energy is the phase coherence.
    * strong beats. Onset energy on even versus odd beats says which are the accented ones; the
      anchor is kept on a strong beat, which is where the head nods when it nods every other beat.
    * the gate. Score >= VIBE_SCORE_ON for two updates with the level above VIBE_MIN_DB (and six
      seconds of envelope in hand) switches it on; score under VIBE_SCORE_OFF for VIBE_OFF_S, the
      level VIBE_DROP_DB under where it started for VIBE_DROP_S, or under VIBE_MIN_DB for 4 s
      switches it off. No votes, no flapping: the old vote-based gate cycled on and off every
      10-70 s on the same song because its confidence sat right at the threshold.

    Measured on this rig (2026-09-13; music from a small speaker at -40..-44 dBFS at the mic): score
    medians 0.15-0.26 with post-lock minima 0.08-0.13 across three songs; white noise, the room
    floor and speech at the same level stay under 0.09 (95th percentile under 0.07); only
    time-shuffled music, which carries a genuine periodicity artefact, passes. Beat phase against
    a best-fit grid over 50 s of "Fix You": median error ~10 ms, 90th percentile ~25 ms; the onset
    energy under the nods is 2.0-2.2x the average. Locks 6-9 s into a song.

    Cost: ~2% of one core plus the capture client. The capture process only runs while `enabled`.
    """

    FPS = MIC_SR / MIC_HOP
    ENV_S = 8.0                    # autocorrelation window
    MIN_ENV_S = 6.0                # no verdict before this much envelope is in hand (short windows lie)
    UPDATE_EVERY = int(FPS / 4)    # frames between updates (250 ms)
    TEMPO_EMA = 0.18               # tempogram averaging per update (tau ~1.4 s)
    ON_UPDATES = 3                 # consecutive updates over VIBE_SCORE_ON to start (0.75 s)
    QUIET_S = 4.0                  # under VIBE_MIN_DB this long -> off
    FOLD_TOL = 0.07                # a folded candidate within this of the lock agrees with it
    RELOCK_UPDATES = 24            # a consistent other-level candidate for this many updates (6 s) wins
    PLL_GAIN, PLL_GAIN_BOOST, PLL_BOOST_UPDATES = 0.35, 0.6, 8
    PLL_FREQ_GAIN = 0.03
    PLL_WINDOW_S, PLL_DECAY_S = 4.0, 2.0
    PARITY_RATIO, PARITY_UPDATES = 1.4, 6
    PRIOR_BPM, PRIOR_SIGMA_OCT = 120.0, 1.0   # a soft nudge toward the middle; the comb does the real work
    COMB_MULT = 4                  # autocorrelate out to this multiple of the longest beat period (every tooth exists)
    COMB_WEIGHTS = (1.0, 0.8, 0.6, 0.5)
    PEAK_BINS, PEAK_HALF = 24, 0.15            # beat-phase histogram; the cluster is +-0.15 beat around its peak
    PEAK_RATIO, PEAK_UPDATES, PEAK_COOLDOWN = 1.5, 6, 32   # another cluster this much stronger for 1.5 s wins; then 8 s of calm
    ONSET_OFFSET_S = 0.015         # a frame's flux reflects sound ~15 ms before its last sample
    CLOCK_CREEP = 2e-4             # s/s the sample clock's origin may drift later (covers a slow mic crystal)

    def __init__(self, clock: BeatClock) -> None:
        self.clock = clock
        self.available = np is not None and (shutil.which("pw-record") or shutil.which("arecord") or MIC_CMD)
        self._enabled = VIBE_ENABLED and bool(self.available)
        self._lock = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self._stopping = False
        self._thread: threading.Thread | None = None
        # analysis state
        self._env_len = int(self.FPS * self.ENV_S)
        if np is not None:
            self._ring = np.zeros(MIC_WIN, dtype=np.float32)
            self._window = np.hanning(MIC_WIN).astype(np.float32)
            self._m_full = self._band_matrix(32, 60.0, 7000.0)
            self._m_mid = self._band_matrix(20, 300.0, 3000.0)
            tau = self.FPS * 0.4
            k = np.exp(-np.arange(int(tau * 4), dtype=np.float32) / tau)
            self._detrend_k = (k / k.sum()).astype(np.float32)
            lo = int(round(self.FPS * 60.0 / VIBE_BPM_RANGE[1]))
            hi = int(round(self.FPS * 60.0 / VIBE_BPM_RANGE[0]))
            self._lags = np.arange(lo, hi + 1)
            self._lag_f = self._lags.astype(np.float64)
            self._bpms = 60.0 * self.FPS / self._lags
            self._prior = np.exp(-(np.log2(self._bpms / self.PRIOR_BPM) ** 2) / (2 * self.PRIOR_SIGMA_OCT ** 2))
        self._prev_full = None
        self._prev_mid = None
        self._env_full: deque = deque(maxlen=self._env_len)
        self._env_mid: deque = deque(maxlen=self._env_len)
        self._env_t: deque = deque(maxlen=self._env_len)
        self._frames = 0
        self._S = None                # the time-averaged tempogram
        self._n_updates = 0
        # levels
        self.level_db = -90.0
        self.level_gate = -90.0       # fast-attack, slow-release: the gaps between beats must not read as silence
        self.peak_db = -90.0
        # lock + clock
        self.locked = False
        self.period = 0.5
        self.anchor = 0.0
        self.score = 0.0
        self.score_now = 0.0
        self.coherence = 0.0
        self.phase_err = 0.0
        self.cand_bpm = 0.0
        self._on_count = 0
        self._boost = 0
        self._dissent = 0
        self._dissent_period = 0.0
        self._odd_wins = 0
        self.parity_flips = 0
        self.relocks = 0
        self.phase_shifts = 0
        self._shift_wins = 0
        self._cool = 0
        # gate
        self.active = False
        self.since = 0.0
        self._off_since = 0.0
        self._drop_since = 0.0
        self._quiet_since = 0.0
        self._level_at_start = -90.0
        # telemetry
        self.listening = False
        self.device = ""
        self.last_error: str | None = None
        self.bpm = 0.0
        self.confidence = 0.0
        self.head = None               # the PanTilt: it says when the servos were still (the mic hears them)
        self.suppressed = False        # the metronome is running: whatever we hear is the head itself
        self._reset_pending = False
        self.clean_s = 0.0             # seconds of still-head onset frames in the window
        self.clean_ratio = 0.0         # on-beat / average onset energy in those frames (>1: a real beat)
        self._ghost = 0
        self._drop6_since = 0.0
        self._break_asked_at = 0.0

    def set_suppressed(self, on: bool) -> None:
        """While the metronome runs the only rhythm in the room is the head: ignore the microphone, and
        start from scratch when it stops (the last 8 s of envelope are servo noise)."""
        on = bool(on)
        if on == self.suppressed:
            return
        self.suppressed = on
        if on:
            self.active = False
            self.locked = False
            self._on_count = 0
        else:
            self._reset_pending = True

    # -- setup ------------------------------------------------------------------------
    @staticmethod
    def _band_matrix(n_bands: int, fmin: float, fmax: float):
        """Log-spaced bands as a (bands x bins) matrix of per-band means, weighted flat."""
        freqs = np.fft.rfftfreq(MIC_WIN, 1.0 / MIC_SR)
        edges = np.geomspace(fmin, fmax, n_bands + 1)
        m = np.zeros((n_bands, len(freqs)), dtype=np.float32)
        for i in range(n_bands):
            sel = (freqs >= edges[i]) & (freqs < edges[i + 1])
            if sel.any():
                m[i, sel] = 1.0 / sel.sum()
        return m

    @property
    def enabled(self) -> bool:
        return self._enabled

    def set_enabled(self, on: bool) -> None:
        on = bool(on) and bool(self.available)
        with self._lock:
            if on == self._enabled:
                return
            self._enabled = on
        if on:
            self.start()
        else:
            self._kill_proc()
            with self._lock:
                self.active = False
                self.locked = False
                self.listening = False

    def start(self) -> None:
        if not self._enabled or (self._thread is not None and self._thread.is_alive()):
            return
        self._stopping = False
        self._thread = threading.Thread(target=self._run, name="music", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stopping = True
        self._kill_proc()

    def _kill_proc(self) -> None:
        proc, self._proc = self._proc, None
        if proc is not None:
            try:
                proc.kill()
                proc.wait(timeout=2)
            except Exception:  # noqa: BLE001
                pass

    def _commands(self) -> list[list[str]]:
        if MIC_CMD:
            return [shlex.split(MIC_CMD)]
        return [c for c in MIC_CMDS if shutil.which(c[0])]

    # -- capture loop -----------------------------------------------------------------
    def _run(self) -> None:
        backoff = 2.0
        while not self._stopping:
            if not self._enabled:
                time.sleep(1.0)
                continue
            started = False
            for cmd in self._commands():
                try:
                    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
                except OSError as exc:
                    self.last_error = f"{cmd[0]}: {exc}"
                    continue
                self._proc = proc
                self.device = cmd[0]
                if self._pump(proc):
                    started = True
                    backoff = 2.0
                if self._stopping or not self._enabled:
                    break
                if started:
                    break
            if self._stopping or not self._enabled:
                continue
            with self._lock:
                self.listening = False
            log.warning("music sense: capture ended (%s); retrying in %.0f s", self.last_error or "no audio", backoff)
            time.sleep(backoff)
            backoff = min(30.0, backoff * 1.5)

    def _reset_analysis(self) -> None:
        self._prev_full = self._prev_mid = None
        self._env_full.clear()
        self._env_mid.clear()
        self._env_t.clear()
        self._frames = 0
        self._S = None
        self._n_updates = 0
        self.locked = False
        self.active = False
        self._on_count = 0

    def _pump(self, proc: subprocess.Popen) -> bool:
        """Read hops from one capture process until it ends. Returns True if it ever produced audio."""
        got = False
        need = MIC_HOP * 2
        buf = b""
        n_read = 0
        t0: float | None = None          # capture time of sample 0, from the least-buffered arrival
        self._reset_analysis()
        while not self._stopping and self._enabled:
            chunk = proc.stdout.read(need - len(buf)) if proc.stdout else b""
            if not chunk:
                self.last_error = f"{self.device} exited ({proc.poll()})"
                break
            buf += chunk
            if len(buf) < need:
                continue
            samples = np.frombuffer(buf[:need], dtype=np.int16).astype(np.float32) / 32768.0
            buf = buf[need:]
            if not got:
                got = True
                with self._lock:
                    self.listening = True
                log.info("music sense: listening via %s", self.device)
            # Frames are stamped from the sample counter. The pipe delivers a quantum at a time, so
            # arrival times jitter by up to 30 ms; the earliest (least buffered) arrival fixes the
            # clock's origin, which may creep later slowly in case the mic's crystal runs slow.
            # VIBE_LATENCY_S takes the pipeline's fixed delay off the grid.
            n_read += MIC_HOP
            est = time.monotonic() - n_read / MIC_SR
            if t0 is None or est < t0:
                t0 = est
            else:
                t0 = min(est, t0 + self.CLOCK_CREEP * MIC_HOP / MIC_SR)
            self.process(samples, t0 + n_read / MIC_SR)
        return got

    # -- analysis ---------------------------------------------------------------------
    def process(self, hop, t_end: float) -> None:  # noqa: ANN001
        """Feed one hop of float32 samples whose last sample was captured at `t_end` (monotonic).
        Pure numpy; also used by the offline replay in tools/vibe_replay.py."""
        if self._reset_pending:
            self._reset_pending = False
            self._reset_analysis()
        ring = self._ring
        ring[:-MIC_HOP] = ring[MIC_HOP:]
        ring[-MIC_HOP:] = hop
        rms = float(np.sqrt(np.mean(hop * hop)) + 1e-9)
        level = 20.0 * math.log10(rms)
        self.level_db = level if self.level_db < -80 else 0.9 * self.level_db + 0.1 * level
        self.level_gate = max(level, self.level_gate - 0.15)     # releases 15 dB/s: a bar of quiet still counts
        self.peak_db = max(level, self.peak_db - 0.01)           # decays ~1 dB/s
        spec = np.abs(np.fft.rfft(ring * self._window))
        lf = np.log1p(1000.0 * (self._m_full @ spec))
        lm = np.log1p(1000.0 * (self._m_mid @ spec))
        if self._prev_full is None:
            ff = fm = 0.0
        else:
            ff = float(np.sum(np.maximum(0.0, lf - self._prev_full)))
            fm = float(np.sum(np.maximum(0.0, lm - self._prev_mid)))
        self._prev_full, self._prev_mid = lf, lm
        self._env_full.append(ff)
        self._env_mid.append(fm)
        self._env_t.append(t_end - self.ONSET_OFFSET_S - VIBE_LATENCY_S)
        self._frames += 1
        if self._frames % self.UPDATE_EVERY == 0:
            self._update(t_end - VIBE_LATENCY_S)

    def _detrend(self, env):  # noqa: ANN001
        """The onsets without the level: the envelope minus a smooth running average (an exponential
        with a 0.4 s time constant -- not a boxcar, whose sidelobe stamps a fake periodicity at its
        own length onto any input), half-wave rectified. Returns (centred, positive)."""
        e = np.asarray(env, dtype=np.float32)
        local = np.convolve(e, self._detrend_k, mode="full")[: len(e)]
        x = np.maximum(0.0, e - local)
        return x - x.mean(), x

    def _acf(self, x):  # noqa: ANN001
        """Normalised autocorrelation for every lag from 0 to COMB_MULT x the longest beat period (one
        FFT; cumulative sums give the per-lag norms), or None when the track is flat."""
        x = np.asarray(x, dtype=np.float64)
        n = len(x)
        if float(np.dot(x, x)) <= 1e-9:
            return None
        max_lag = min(int(self.COMB_MULT * self._lags[-1]), n - 10)
        nfft = 1 << (2 * n - 1).bit_length()
        spec = np.fft.rfft(x, nfft)
        r = np.fft.irfft(spec * np.conj(spec), nfft)[: max_lag + 1]
        c = np.concatenate(([0.0], np.cumsum(x * x)))
        lags = np.arange(max_lag + 1)
        den = np.sqrt((c[-1] - c[lags]) * c[n - lags]) + 1e-9
        return r / den

    def _comb(self, r):  # noqa: ANN001
        """Pairwise-minimum comb over the periodicity curve: min(r(T), r(2T)), min(r(2T), r(3T)),
        min(r(3T), r(4T)), weighted. The true beat period has a peak at every multiple; a 3:2 or 4:3
        impostor has one low tooth in each pair and is punished for it. (A plain sum of the teeth
        let a 140 BPM ballad read 93 and an 82 BPM song read 109 through this mic, and a sum whose
        higher teeth fall off the end of the curve favours fast impostors for anything under 120
        BPM -- hence COMB_MULT.)"""
        axis = np.arange(len(r), dtype=np.float64)
        teeth = [np.interp(k * self._lag_f, axis, r, left=0.0, right=0.0) for k in range(1, len(self.COMB_WEIGHTS) + 1)]
        pairs = [np.minimum(teeth[i], teeth[i + 1]) for i in range(len(teeth) - 1)]
        w = self.COMB_WEIGHTS[: len(pairs)]
        return sum(a * b for a, b in zip(w, pairs)) / sum(w)

    @staticmethod
    def _fold(period: float, ref: float) -> float:
        """`period` moved by octaves into [ref/sqrt2, ref*sqrt2)."""
        while period >= ref * 1.4142:
            period *= 0.5
        while period < ref / 1.4142:
            period *= 2.0
        return period

    def _update(self, now: float) -> None:
        n = len(self._env_full)
        if n < int(self.FPS * 3.0):
            return
        xf_c, xf_p = self._detrend(self._env_full)
        xm_c, xm_p = self._detrend(self._env_mid)
        curves = [r for r in (self._acf(xf_c), self._acf(xm_c)) if r is not None]
        if not curves:
            self._S = None
            self.score = self.score_now = 0.0
            return
        c = self._comb(np.mean(curves, axis=0)) * self._prior
        self._n_updates += 1
        alpha = max(self.TEMPO_EMA, 1.0 / self._n_updates)      # a running mean at first, an EMA once mature
        self._S = c if self._S is None else (1.0 - alpha) * self._S + alpha * c
        S = self._S
        i = int(np.argmax(S))
        lag = float(self._lags[i])
        if 0 < i < len(S) - 1:
            y0, y1, y2 = S[i - 1], S[i], S[i + 1]
            den = y0 - 2 * y1 + y2
            if abs(den) > 1e-9:
                lag += 0.5 * (y0 - y2) / den
        self.score = float(S[i])
        self.score_now = float(c.max())
        if self.suppressed:
            self.locked = self.active = False
            self.clock.set(confidence=0.0, bpm=0.0)
            return
        cand = lag / self.FPS
        self.cand_bpm = 60.0 / cand
        loud = self.level_gate > VIBE_MIN_DB and n >= int(self.FPS * self.MIN_ENV_S)

        if not self.locked:
            self._on_count = self._on_count + 1 if (loud and self.score >= VIBE_SCORE_ON) else 0
            if self._on_count >= self.ON_UPDATES:
                self.locked = True
                self.period = cand
                self.anchor = now
                self._boost = self.PLL_BOOST_UPDATES
                self._dissent = 0
                self._odd_wins = 0
        else:
            folded = self._fold(cand, self.period)
            if abs(folded / self.period - 1.0) <= self.FOLD_TOL:
                self.period = 0.9 * self.period + 0.1 * folded
                self._dissent = max(0, self._dissent - 1)
            else:
                if self._dissent_period and abs(cand / self._dissent_period - 1.0) <= self.FOLD_TOL:
                    self._dissent += 1
                else:
                    self._dissent, self._dissent_period = 1, cand
                if self._dissent >= self.RELOCK_UPDATES:
                    log.info("music sense: relocking %.0f -> %.0f BPM", 60.0 / self.period, 60.0 / cand)
                    self.relocks += 1
                    self.period = cand
                    self._boost = self.PLL_BOOST_UPDATES
                    self._dissent = 0
        if self.locked:
            t = np.asarray(self._env_t, dtype=np.float64)
            x = xf_p + xm_p
            m = int(self.FPS * self.PLL_WINDOW_S)
            tt, xx = t[-m:], x[-m:]
            w = np.exp(-(tt[-1] - tt) / self.PLL_DECAY_S)
            wx = w * xx
            ph = ((tt - self.anchor) / self.period) % 1.0
            tot = float(np.sum(wx)) + 1e-9
            # Which onsets are "the beat"? Not the circular mean of everything -- two clusters half a
            # beat apart (kick and a strong off-beat) put that grid between them, on nothing -- but
            # the strongest cluster: a phase histogram, its peak, and the circular mean of the onsets
            # within +-PEAK_HALF of it. Once locked the grid stays with its own cluster unless another
            # is PEAK_RATIO stronger for PEAK_UPDATES in a row (then it jumps there and holds for
            # PEAK_COOLDOWN), so a song whose accents alternate does not flip it back and forth.
            hist = np.bincount((ph * self.PEAK_BINS).astype(int) % self.PEAK_BINS, weights=wx, minlength=self.PEAK_BINS)
            hist = hist + 0.5 * (np.roll(hist, 1) + np.roll(hist, -1))
            kb = int(np.argmax(hist))
            centre_peak = (kb + 0.5) / self.PEAK_BINS
            on_grid = [i for i in range(self.PEAK_BINS) if abs((((i + 0.5) / self.PEAK_BINS + 0.5) % 1.0) - 0.5) <= self.PEAK_HALF]
            near_grid = kb in on_grid
            hist_grid = max(hist[i] for i in on_grid)
            jump = False
            self._cool = max(0, self._cool - 1)
            if self._boost == self.PLL_BOOST_UPDATES:        # first update after a lock: onto the strongest cluster
                centre, jump = centre_peak, True
                self._shift_wins = 0
            elif near_grid or self._boost > 0 or self._cool > 0:
                centre = 0.0
                self._shift_wins = 0
            else:
                self._shift_wins = self._shift_wins + 1 if hist[kb] > self.PEAK_RATIO * hist_grid else 0
                centre = 0.0
                if self._shift_wins >= self.PEAK_UPDATES:
                    centre, jump = centre_peak, True
                    self._shift_wins = 0
                    self._cool = self.PEAK_COOLDOWN
                    self.phase_shifts += 1
            d = ((ph - centre + 0.5) % 1.0) - 0.5
            sel = np.abs(d) <= self.PEAK_HALF
            z = np.sum(wx[sel] * np.exp(2j * np.pi * ph[sel]))
            self.coherence = abs(z) / tot
            e = float(np.angle(z) / (2 * math.pi))          # beats, in (-0.5, 0.5]
            self.phase_err = e
            g = 1.0 if jump else (self.PLL_GAIN_BOOST if self._boost > 0 else self.PLL_GAIN)
            self.anchor += g * e * self.period
            if self._boost > 0:
                self._boost -= 1
            elif abs(e) < 0.15:
                self.period *= 1.0 + self.PLL_FREQ_GAIN * e
            self.period = min(60.0 / VIBE_BPM_RANGE[0], max(60.0 / VIBE_BPM_RANGE[1], self.period))
            # strong-beat parity: more onset energy on odd beats (counted from the anchor) than even?
            b = (tt - self.anchor) / self.period
            k = np.round(b)
            near = np.abs(b - k) < 0.15
            even = float(np.sum(wx[near & (k % 2 == 0)]))
            odd = float(np.sum(wx[near & (k % 2 == 1)]))
            if self._boost == 0 and odd > self.PARITY_RATIO * even:
                self._odd_wins += 1
            else:
                self._odd_wins = max(0, self._odd_wins - 1)
            if self._odd_wins >= self.PARITY_UPDATES:
                self.anchor += self.period
                self._odd_wins = 0
                self.parity_flips += 1
            # keep the anchor near now, moving by whole pairs of beats so its parity survives
            two = 2.0 * self.period
            if abs(now - self.anchor) > 2 * two:
                self.anchor += two * math.floor((now - self.anchor) / two)
        # -- evidence gathered while the head was still. The microphone is inches from the servos and a
        #    nodding head is a beat all by itself (measured: a 100 BPM metronome in a silent room scored
        #    0.30, more than real music), so the frames that count for "is this still music?" are the
        #    ones recorded while nothing was driving the servos: before the vibe starts, and during the
        #    listening breaks AmbientVibe takes every few bars (or on request when the level drops).
        if self.locked:
            t_all = np.asarray(self._env_t, dtype=np.float64)
            x_all = xf_p + xm_p
            quiet = self.head.quiet_intervals(float(t_all[0])) if self.head is not None else [(float(t_all[0]), now + 1.0)]
            qmask = np.zeros(len(t_all), dtype=bool)
            for a, b in quiet:
                qmask |= (t_all >= a + 0.25) & (t_all <= b + 0.02)      # the noise tail after the last write
            self.clean_s = float(qmask.sum()) / self.FPS
            if self.clean_s >= 1.5 and self._boost == 0:
                phq = ((t_all[qmask] - self.anchor) / self.period + 0.5) % 1.0 - 0.5
                near = np.abs(phq) <= 0.12
                xq = x_all[qmask]
                self.clean_ratio = float(xq[near].mean() / (xq.mean() + 1e-9)) if near.any() and xq.mean() > 0 else 0.0
            else:
                self.clean_ratio = 0.0
        else:
            self.clean_s = self.clean_ratio = 0.0
        # -- the gate
        if not self.active:
            if self.locked and loud and self.score >= VIBE_SCORE_ON:
                self.active, self.since = True, now
                self._level_at_start = self.level_gate
                self._off_since = self._drop_since = self._quiet_since = self._drop6_since = 0.0
                self._ghost = 0
                log.info("music sense: beat found, %.0f BPM (score %.2f, %.0f dBFS) -> vibing",
                         60.0 / self.period, self.score, self.level_db)
        else:
            self._off_since = (self._off_since or now) if self.score < VIBE_SCORE_OFF else 0.0
            self._drop_since = (self._drop_since or now) if self.level_gate < self._level_at_start - VIBE_DROP_DB else 0.0
            self._quiet_since = (self._quiet_since or now) if self.level_gate <= VIBE_MIN_DB else 0.0
            # a listening break when the level has fallen 6 dB: the music may have stopped and the
            # servos may be all that is left to hear
            drop6 = self.level_gate < self._level_at_start - 6.0
            self._drop6_since = (self._drop6_since or now) if drop6 else 0.0
            if self._drop6_since and now - self._drop6_since >= 1.0 and now - self._break_asked_at > 15.0:
                self._break_asked_at = now
                self.clock.request_break()
            if self.clean_s >= 1.5 and self.clean_ratio > 0:
                self._ghost = self._ghost + 1 if self.clean_ratio < 1.15 else 0
            why = None
            if self._ghost >= 4:
                why = "no beat while the head was still"
            elif self._off_since and now - self._off_since >= VIBE_OFF_S:
                why = "lost the beat"
            elif self._drop_since and now - self._drop_since >= VIBE_DROP_S:
                why = "the level fell"
            elif self._quiet_since and now - self._quiet_since >= self.QUIET_S:
                why = "quiet"
            if why:
                self.active = False
                self.locked = False
                self._on_count = 0
                self._n_updates = 0
                self._ghost = 0
                log.info("music sense: the music stopped (%s)", why)
        # -- publish
        self.bpm = 60.0 / self.period if self.locked else 0.0
        self.confidence = self.score
        strength = max(0.0, min(1.0, (self.level_db - (self.peak_db - 15.0)) / 15.0))
        if self.locked:
            self.clock.set(period=self.period, anchor=self.anchor, confidence=self.score, strength=strength, bpm=self.bpm)
        else:
            self.clock.set(confidence=self.score, strength=strength, bpm=0.0)

    def state(self) -> dict:
        period, anchor, conf, strength = self.clock.read()
        return {
            "available": bool(self.available),
            "enabled": self._enabled,
            "listening": self.listening,
            "device": self.device,
            "active": self.active,
            "since": round(time.time() - (time.monotonic() - self.since), 0) if self.active and self.since else None,
            "locked": self.locked,
            "bpm": round(60.0 / period, 1) if self.locked else None,
            "candidate_bpm": round(self.cand_bpm, 1) if self.cand_bpm else None,
            "score": round(self.score, 3),
            "score_now": round(self.score_now, 3),
            "confidence": round(self.score, 3),
            "coherence": round(self.coherence, 2),
            "phase_err_ms": round(self.phase_err * period * 1000.0) if self.locked else None,
            "parity_flips": self.parity_flips,
            "relocks": self.relocks,
            "phase_shifts": self.phase_shifts,
            "suppressed": self.suppressed,
            "still_head_s": round(self.clean_s, 1),
            "still_head_beat_ratio": round(self.clean_ratio, 2),
            "level_db": round(self.level_db, 1),
            "level_gate_db": round(self.level_gate, 1),
            "strength": round(strength, 2),
            "next_beat_in_s": round((period - ((time.monotonic() - anchor) % period)) if self.locked else 0, 3),
            "latency_ms": round(VIBE_LATENCY_S * 1000),
            "lead_ms": round(VIBE_LEAD_S * 1000),
            "offset_ms": round(VIBE_OFFSET_S * 1000),
            "error": self.last_error,
        }


class AmbientVibe:
    """The head moves to the music the way a person listening does. Tilt carries the nod: a quick
    drop (about 0.2 s) that bottoms out exactly on the beat and a slower recovery, on every beat at
    relaxed tempos and every other beat above ~130 BPM (so a 140 BPM song gets 70 nods a minute,
    not 140 twitches), with a light accent pattern across the bar. Pan carries one of a few slow
    moves -- a two-bar sway, a small groove wiggle, a slow gaze around, or stillness -- that change
    every couple of bars and cross-fade over a bar; every eight bars or so a small flourish gesture
    is handed to the motion loop through `flourish`.

    The nod phase is a local oscillator that slews toward the tracker's clock, so a phase or
    parity correction upstream never snaps the servo -- the head drifts onto the beat over a second
    or two, like someone catching the groove -- and the whole thing is commanded VIBE_LEAD_S (plus
    the by-ear VIBE_OFFSET_S) early so that after the output low-pass, the I2C tick and the servo's
    own lag the *camera* bottoms out on the beat. Depth scales with loudness, beat score and
    VIBE_AMPLITUDE, ramps in and out over most of a second, and the output is low-passed (35 ms) so
    nothing the servos see is ever an edge. (The first version snapped 7 deg on every beat -- "the
    robot is having a stroke" -- and the second was a 6 deg Gaussian that the tilt limit clipped to
    4 deg; this one is 15 deg deep and the vibe's base pose leaves room for it.)"""

    RAMP_S = 0.8
    DESCENT_S = 0.20               # the drop onto the beat takes this long...
    DESCENT_MAX_FRAC = 0.4         # ...but never more than this much of the nod cycle
    ASCENT_FRAC = 0.55             # the recovery takes this much of the cycle; the rest is a pause at the top
    LPF_S = 0.035
    MOVES = ("sway", "groove", "gaze", "still")

    def __init__(self, clock: BeatClock, amplitude: float = 1.0, nod_every: int = 0) -> None:
        """`nod_every` > 0 fixes the nod rate (1 = every beat; the metronome) and keeps the head plain:
        no pan moves, no flourishes -- just the beat."""
        self.clock = clock
        self.amp = _clampf(amplitude, 0.2, 2.0)
        self._nod_fixed = int(nod_every)
        self.started = 0.0
        self.stop_at: float | None = None
        self.flourish: str | None = None
        self._ph: float | None = None    # local nod phase in cycles: 0 = the beat (the bottom)
        self._beats = 0.0                # local beat counter for the slow moves
        self.nod_every = 0               # 1 or 2 beats per nod (0 = not decided yet)
        self._nods = 0
        self._move = "still" if self._nod_fixed else "sway"
        self._prev_move: str | None = None
        self._blend_from = 0.0
        self._last_bar = -1
        self._last_flourish_bar = 0
        self._sway_sign = 1.0 if random.random() < 0.5 else -1.0
        self._out = [0.0, 0.0]
        self._t_last: float | None = None
        self.depth = 0.0                 # telemetry: nod depth 0..1 right now
        self._break_until = 0.0          # listening breaks: a bar of stillness so the tracker can hear the room
        self._next_break_bar = random.randint(3, 5)
        self._break_seen = 0.0
        self.still = False
        self.breaks = 0

    def begin(self, now: float) -> None:
        self.started = now

    def stop(self, now: float) -> None:
        if self.stop_at is None:
            self.stop_at = now

    @staticmethod
    def _depth(u: float, d_frac: float, a_frac: float) -> float:
        """Nod depth 0..1 at cycle phase u: recovery (raised cosine) for u < a_frac, a pause at the
        top, then the drop over the last d_frac of the cycle, bottoming out at u = 1 == 0."""
        if u < a_frac:
            return 0.5 + 0.5 * math.cos(math.pi * u / a_frac)
        if u >= 1.0 - d_frac:
            v = (u - (1.0 - d_frac)) / d_frac
            return 0.5 - 0.5 * math.cos(math.pi * v)
        return 0.0

    def _pan_move(self, move: str, beats: float) -> tuple[float, float]:
        """(pan, tilt bias) of a slow move at local beat count `beats`."""
        if move == "sway":
            return self._sway_sign * VIBE_SWAY_DEG * math.sin(math.tau * beats / 8.0), 0.0
        if move == "groove":
            return 4.0 * math.sin(math.tau * (beats + 0.25) / max(1, self.nod_every)), 0.0
        if move == "gaze":
            return 10.0 * math.sin(math.tau * beats / 16.0), 2.0 * math.sin(math.tau * beats / 16.0 + 1.3)
        return 0.0, 0.0

    def sample(self, now: float):
        """(d_pan, d_tilt), or None once the fade-out has completed."""
        env = _smoothstep((now - self.started) / self.RAMP_S)
        if self.stop_at is not None:
            env *= 1.0 - _smoothstep((now - self.stop_at) / self.RAMP_S)
            if now - self.stop_at >= self.RAMP_S:
                return None
        period, anchor, conf, strength = self.clock.read()
        bpm = 60.0 / period
        if self._nod_fixed:
            if self.nod_every != self._nod_fixed:
                self.nod_every, self._ph = self._nod_fixed, None
        elif self.nod_every == 0:
            self.nod_every = 2 if bpm > 124 else 1
        elif self.nod_every == 1 and bpm > 130:
            self.nod_every, self._ph = 2, None
        elif self.nod_every == 2 and bpm < 118:
            self.nod_every, self._ph = 1, None
        cycle = period * self.nod_every
        t = now + VIBE_LEAD_S + VIBE_OFFSET_S
        u_target = ((t - anchor) / cycle) % 1.0
        dt = 0.025 if self._t_last is None else max(0.001, min(0.2, now - self._t_last))
        self._t_last = now
        if self._ph is None:
            self._ph = u_target
        else:
            prev = self._ph
            self._ph = (self._ph + dt / cycle) % 1.0
            if self._ph < prev:
                self._nods += 1
            diff = (u_target - self._ph + 0.5) % 1.0 - 0.5
            if abs(diff) < 0.12:
                self._ph += diff * min(1.0, dt / 0.25)          # small error: ease onto it
            else:
                self._ph += math.copysign(min(abs(diff), 0.25 * dt), diff)   # big one: slew a quarter cycle per second
            self._ph %= 1.0
        self._beats += dt / period
        d_frac = min(self.DESCENT_MAX_FRAC, self.DESCENT_S / cycle)
        a_frac = min(self.ASCENT_FRAC, 1.0 - d_frac - 0.02)
        u = self._ph
        k = self._nods + (1 if u >= 1.0 - d_frac else 0)       # the drop belongs to the nod it lands on
        accent = (1.0, 0.8, 0.9, 0.8)[k % 4] if self.nod_every == 1 else (1.0, 0.85)[k % 2]
        self.depth = self._depth(u, d_frac, a_frac)
        bar = int(self._beats // 4)
        if bar != self._last_bar and not self._nod_fixed:
            if self._last_bar >= 0 and bar % 2 == 0 and random.random() < 0.6:
                self._prev_move, self._move = self._move, random.choice([m for m in self.MOVES if m != self._move])
                self._blend_from = self._beats
            if self._last_bar >= 0 and bar - self._last_flourish_bar >= 8 and random.random() < 0.5:
                self._last_flourish_bar = bar
                self.flourish = random.choice(("tilt", "shake"))
            self._last_bar = bar
        # Listening breaks. The microphone sits next to the servos and a nodding head is a beat all
        # by itself, so every 8-12 bars -- or as soon as the tracker asks, having heard the level
        # drop -- the head holds still for a bar (at the top of a nod, so it reads as a held breath)
        # and the tracker checks that the beat is still there without the servos in its ears.
        if not self._nod_fixed:
            asked = self.clock.break_at > max(self._break_seen, self.started)
            if now >= self._break_until and (bar >= self._next_break_bar or asked) and self.depth < 0.08:
                self._break_until = now + max(2.4, 4.0 * period)
                self._next_break_bar = bar + random.randint(8, 12)
                self._break_seen = self.clock.break_at
                self.breaks += 1
            self.still = now < self._break_until
        pan, tilt_bias = self._pan_move(self._move, self._beats)
        if self._prev_move is not None:
            w = _smoothstep((self._beats - self._blend_from) / 4.0)   # cross-fade over one bar
            if w >= 1.0:
                self._prev_move = None
            else:
                p0, t0 = self._pan_move(self._prev_move, self._beats)
                pan, tilt_bias = p0 + (pan - p0) * w, t0 + (tilt_bias - t0) * w
        gain = (self.amp * env * (0.75 + 0.25 * min(1.0, strength))
                * (0.8 + 0.2 * _clampf((conf - 0.08) / 0.12, 0.0, 1.0)))
        fast = min(1.0, cycle / 0.42)      # a metronome above ~140 nods/min gets a shallower nod the servo can follow
        if self.still:
            self.depth, pan, tilt_bias = 0.0, 0.0, 0.0
        target = (pan * gain, (VIBE_NOD_DEG * accent * self.depth * fast + tilt_bias) * gain)
        kf = 1.0 - math.exp(-dt / self.LPF_S)
        self._out[0] += (target[0] - self._out[0]) * kf
        self._out[1] += (target[1] - self._out[1]) * kf
        return self._out[0], self._out[1]


# ----------------------------------------------------------------------------- pan-tilt (PCA9685)

def _servo_deg(deg: float, invert: bool) -> float:
    """Logical degrees -> the angle written to that servo."""
    return 180.0 - deg if invert else deg


class PanTilt:
    """PCA9685 servo driver with a 40 Hz motion loop: base pose + gesture offset + ambient motion.

    Everything public speaks logical degrees. `move()` sets where the head looks and how fast it
    gets there; `play()` layers a gesture on top; `set_ambient()` switches the "talking" motion
    on or off. The loop sleeps on a condition variable whenever nothing is moving, so an idle head
    costs nothing, and it writes the bus only when a servo tick actually changes.
    """

    def __init__(self) -> None:
        self.available = False
        self.error: str | None = None
        self._bus = None
        self._bus_lock = threading.Lock()      # serialises all I2C traffic
        self._cv = threading.Condition()       # guards the motion state below
        self._base_target = [float(CENTER[0]), float(CENTER[1])]
        self._base_pos = [float(CENTER[0]), float(CENTER[1])]
        self._base_speed = GLIDE_SPEED_DPS
        self._pan, self._tilt = float(CENTER[0]), float(CENTER[1])   # last pose written (summed)
        self._offset = (0.0, 0.0)
        self._written: tuple[int, int] | None = None                 # (pan ticks, tilt ticks)
        self._gesture: GesturePlayer | None = None
        self._queue: deque[GesturePlayer] = deque()
        self._ambient = None                   # AmbientTalk | AmbientVibe
        self._ambient_name: str | None = None
        self._fading = None                    # the previous ambient layer, fading out
        self._released = False
        self._release_pending = False
        self._release_when_settled = False
        self._resend = False
        self._moving = False
        self._stopping = False
        self._gen = 0                          # bumps on every command (state reporting / tests)
        self._trace: deque = deque(maxlen=600)   # (t, pan, tilt) as commanded, the last 15 s (GET /vibe/trace)
        self._write_times: deque = deque(maxlen=1600)   # when the servos were last driven (30+ s): the music
                                                        # sensor hears the servos and must know when the head was still
        self._thread: threading.Thread | None = None
        self._open()

    # -- setup -------------------------------------------------------------------------
    def _open(self) -> None:
        if SMBus is None:
            self.error = f"smbus2 unavailable: {SMBUS_IMPORT_ERROR}"
            log.warning("pan-tilt disabled: %s", self.error)
            return
        try:
            self._bus = SMBus(I2C_BUS)
            mode1 = self._bus.read_byte_data(PCA_ADDR, MODE1)   # probe: raises OSError if nobody answers
            prescale = self._pca_init()
            log.info("PCA9685 @0x%02x on i2c-%d answered (MODE1=0x%02x); %d Hz (prescale=%d)",
                     PCA_ADDR, I2C_BUS, mode1, PWM_FREQ, prescale)
            ticks = (self._ticks(PAN_CH, self._pan), self._ticks(TILT_CH, self._tilt))
            self._write_ticks(ticks)
            self._written = ticks
            log.info("servos initialised to %d/%d; releasing in 1 s", *CENTER)
        except Exception as exc:  # noqa: BLE001
            self.error = str(exc)
            log.warning("pan-tilt disabled: PCA9685 @0x%02x on i2c-%d not reachable: %s", PCA_ADDR, I2C_BUS, exc)
            self._close_bus()
            return
        self.available = True
        self._thread = threading.Thread(target=self._worker, name="pantilt", daemon=True)
        self._thread.start()
        t = threading.Timer(1.0, self._initial_release)
        t.daemon = True
        t.start()

    def _initial_release(self) -> None:
        with self._cv:
            if self._gen != 0:      # a real command already arrived; don't yank it away
                return
        self.release()

    def _close_bus(self) -> None:
        if self._bus is not None:
            try:
                self._bus.close()
            except Exception:  # noqa: BLE001
                pass
            self._bus = None

    # -- PCA9685 register access -------------------------------------------------------
    def _pca_init(self) -> int:
        bus = self._bus
        bus.write_byte_data(PCA_ADDR, MODE1, 0x00)
        time.sleep(0.01)
        pre = int(round(25_000_000.0 / (4096 * PWM_FREQ))) - 1
        old = bus.read_byte_data(PCA_ADDR, MODE1)
        bus.write_byte_data(PCA_ADDR, MODE1, (old & 0x7F) | 0x10)   # sleep
        bus.write_byte_data(PCA_ADDR, PRESCALE, pre)
        bus.write_byte_data(PCA_ADDR, MODE1, old)
        time.sleep(0.005)
        bus.write_byte_data(PCA_ADDR, MODE1, old | 0xA1)            # restart + auto-increment
        return pre

    @staticmethod
    def _ticks(ch: int, deg: float) -> int:
        invert = PAN_INVERT if ch == PAN_CH else TILT_INVERT
        sd = _clampf(_servo_deg(deg, invert), 0.0, 180.0)
        us = 500.0 + (sd / 180.0) * 2000.0          # 500..2500 us
        return int(round(us / TICK_US))

    def _write_ticks(self, ticks: tuple[int, int]) -> None:
        """One auto-increment block write covering channels 0 and 1 (tilt, pan)."""
        pan_off, tilt_off = ticks
        per_ch = {PAN_CH: pan_off, TILT_CH: tilt_off}
        block: list[int] = []
        for ch in range(max(PAN_CH, TILT_CH) + 1):
            off = per_ch.get(ch, 0)
            block += [0, 0, off & 0xFF, (off >> 8) & 0x0F]
        with self._bus_lock:
            self._bus.write_i2c_block_data(PCA_ADDR, LED0_ON_L, block)

    def _write_off(self) -> None:
        """Full-off on both channels: no pulses, no holding torque."""
        block: list[int] = []
        for _ch in range(max(PAN_CH, TILT_CH) + 1):
            block += [0, 0, 0, 0x10]
        with self._bus_lock:
            self._bus.write_i2c_block_data(PCA_ADDR, LED0_ON_L, block)

    # -- public API ------------------------------------------------------------------------
    def limits_json(self) -> dict:
        return {k: list(v) for k, v in LIMITS.items()}

    def state(self) -> dict:
        with self._cv:
            g = self._gesture
            return {
                "ok": True,
                "pan": int(round(self._pan)),
                "tilt": int(round(self._tilt)),
                "limits": self.limits_json(),
                "base": {"pan": round(self._base_pos[0], 1), "tilt": round(self._base_pos[1], 1)},
                "target": {"pan": int(round(self._base_target[0])), "tilt": int(round(self._base_target[1]))},
                "offset": {"pan": round(self._offset[0], 1), "tilt": round(self._offset[1], 1)},
                "moving": self._moving,
                "released": self._released,
                "gesture": g.gesture.name if g else None,
                "queued": len(self._queue),
                "ambient": self._ambient_name,
            }

    def quiet_intervals(self, since: float, min_len: float = 0.4) -> list:
        """[(t0, t1), ...]: spans since `since` (monotonic) in which the servos were not driven for at
        least min_len s -- when the microphone hears the room and not the head."""
        now = time.monotonic()
        with self._cv:
            times = [t for t in self._write_times if t >= since]
        edges = [since] + times + [now]
        return [(a, b) for a, b in zip(edges, edges[1:]) if b - a >= min_len]

    def trace(self) -> list:
        """The commanded pose over the last ~15 s as [t_monotonic, pan, tilt, beat_period, beat_anchor,
        nod_phase, nod_depth] rows (period/anchor are the clock in force at that tick, nod_phase the
        vibe's local oscillator in cycles with 0 = the bottom, -1 when not vibing) -- vibe tuning."""
        with self._cv:
            return [[round(t, 3), round(p, 2), round(tl, 2), round(per, 5), round(anc, 4), round(ph, 4), round(dp, 3)]
                    for (t, p, tl, per, anc, ph, dp) in self._trace]

    def move(self, pan: float | None, tilt: float | None, *, quiet: bool = False,
             speed: float | None = None, step: int | None = None, dwell: float | None = None) -> tuple[int, int]:
        """Glide the base pose to the clamped target (a missing axis keeps its current target).

        `speed` is degrees per second; `step`/`dwell` are accepted for compatibility (3 deg per
        15 ms == 200 deg/s). Re-commanding an unchanged target is a no-op, so a controller that
        re-sends its setpoint every cycle does not disturb a glide in flight.
        """
        if speed is None and step is not None and dwell:
            speed = float(step) / float(dwell)
        with self._cv:
            p = self._base_target[0] if pan is None else _clampf(pan, *LIMITS["pan"])
            t = self._base_target[1] if tilt is None else _clampf(tilt, *LIMITS["tilt"])
            if (p, t) == tuple(self._base_target) and not self._released and not self._release_pending:
                return int(round(p)), int(round(t))
            self._base_target = [p, t]
            self._base_speed = _clampf(speed or GLIDE_SPEED_DPS, 5.0, 400.0)
            self._release_pending = False
            self._release_when_settled = False
            if self._released:
                self._resend = True
            self._gen += 1
            self._cv.notify()
        log.log(logging.DEBUG if quiet else logging.INFO, "glide -> pan %d / tilt %d", int(round(p)), int(round(t)))
        return int(round(p)), int(round(t))

    def center(self) -> tuple[int, int]:
        return self.move(*CENTER)

    def release(self, *, immediate: bool = True) -> None:
        """Power the servos down. `immediate=False` first lets the base pose finish its glide (and any
        gesture finish), so the head can be *parked somewhere useful* -- at head height, where the
        idle presence check can still see a face -- before the torque goes."""
        with self._cv:
            self._release_pending = True
            self._release_when_settled = not immediate
            self._gen += 1
            self._cv.notify()

    def play(self, gesture: Gesture, *, intensity: float = 1.0, speed: float = 1.0,
             queue: bool = False) -> GesturePlayer:
        """Layer a gesture over the base pose. By default it replaces whatever is playing."""
        player = GesturePlayer(gesture, intensity, speed)
        with self._cv:
            if queue and (self._gesture is not None or self._queue):
                self._queue.append(player)
            else:
                self._queue.clear()
                self._gesture = None          # the loop starts the new one on its next tick
                self._queue.append(player)
            self._release_pending = False
            self._release_when_settled = False
            if self._released:
                self._resend = True
            self._gen += 1
            self._cv.notify()
        return player

    def stop_gesture(self) -> None:
        with self._cv:
            self._queue.clear()
            self._gesture = None
            self._gen += 1
            self._cv.notify()

    def gesture_active(self) -> bool:
        with self._cv:
            return self._gesture is not None or bool(self._queue)

    def current_gesture(self) -> str | None:
        with self._cv:
            return self._gesture.gesture.name if self._gesture else None

    def set_ambient(self, name: str | None, amplitude: float = 1.0, clock: BeatClock | None = None) -> None:
        """Switch the ambient motion: "talk" (while Nova speaks), "vibe" (to music, needs a
        BeatClock), "metronome" (the same nod on a fixed clock, every beat, no moves), or None.
        Idempotent; a change fades the old layer out and the new one in."""
        with self._cv:
            if name == self._ambient_name:
                return
            now = time.monotonic()
            if self._ambient is not None:
                self._ambient.stop(now)
                if name is not None:
                    self._fading = self._ambient      # keep fading out underneath the new layer
            if name is None:
                self._ambient_name = None      # the old layer stays until its fade-out completes
            else:
                if name == "vibe":
                    self._ambient = AmbientVibe(clock or BeatClock(), amplitude)
                elif name == "metronome":
                    self._ambient = AmbientVibe(clock or BeatClock(), amplitude, nod_every=1)
                elif name == "idle":
                    self._ambient = AmbientIdle(amplitude)
                else:
                    self._ambient = AmbientTalk(amplitude)
                self._ambient.begin(now)
                self._ambient_name = name
                self._release_pending = False
                self._release_when_settled = False
                if self._released:
                    self._resend = True
            self._gen += 1
            self._cv.notify()

    @property
    def ambient_name(self) -> str | None:
        with self._cv:
            return self._ambient_name

    def close(self) -> None:
        """Synchronous release + bus close, used at shutdown."""
        if not self.available:
            return
        self.available = False
        with self._cv:
            self._stopping = True
            self._queue.clear()
            self._gesture = None
            self._ambient = None
            self._cv.notify()
        if self._thread is not None:
            self._thread.join(timeout=1.0)
        try:
            self._write_off()
            log.info("servos released (PWM off)")
        except Exception as exc:  # noqa: BLE001
            log.warning("release at shutdown failed: %s", exc)
        self._close_bus()

    # -- motion loop -----------------------------------------------------------------------
    def _needs_motion_locked(self) -> bool:
        return (self._release_pending or self._resend or self._gesture is not None or bool(self._queue)
                or self._ambient is not None or self._fading is not None or self._base_pos != self._base_target)

    def _worker(self) -> None:
        period = 1.0 / MOTION_HZ
        last = time.monotonic()
        while True:
            with self._cv:
                while not self._stopping and not self._needs_motion_locked():
                    self._moving = False
                    self._cv.wait()
                    last = time.monotonic()
                if self._stopping:
                    return
                now = time.monotonic()
                dt = min(0.1, now - last)
                last = now
                cmd = self._step_locked(now, dt)
            try:
                if cmd is None:
                    pass
                elif cmd[0] == "release":
                    self._write_off()
                    with self._cv:
                        self._released = True
                        self._written = None
                    log.info("servos released (PWM off)")
                else:
                    self._write_ticks(cmd[1])
                    with self._cv:
                        self._write_times.append(time.monotonic())
            except OSError as exc:
                log.error("pan-tilt I2C error: %s", exc)
                time.sleep(0.5)
            except Exception:  # noqa: BLE001
                log.exception("pan-tilt worker error")
                time.sleep(0.5)
            time.sleep(period)

    def _step_locked(self, now: float, dt: float):
        settled = self._base_pos == self._base_target and self._gesture is None and not self._queue
        if self._release_pending and (settled or not self._release_when_settled):
            self._release_pending = False
            self._release_when_settled = False
            self._queue.clear()
            self._gesture = None
            self._ambient = None
            self._ambient_name = None
            self._fading = None
            self._offset = (0.0, 0.0)
            self._base_target = list(self._base_pos)
            self._moving = False
            return ("release",)

        # 1. base glide, per axis, at the commanded speed
        step = self._base_speed * dt
        for i in (0, 1):
            d = self._base_target[i] - self._base_pos[i]
            if abs(d) <= step:
                self._base_pos[i] = self._base_target[i]
            else:
                self._base_pos[i] += step if d > 0 else -step

        # 2. gesture layer
        off_p = off_t = 0.0
        if self._gesture is None and self._queue:
            self._gesture = self._queue.popleft()
            self._gesture.begin(now)
        if self._gesture is not None:
            sample = self._gesture.sample(now)
            if sample is None:
                g, self._gesture = self._gesture, None
                if g.gesture.settle in ("hold", "release"):
                    fp, ft = g.final_offset()
                    p = _clampf(self._base_pos[0] + fp, *LIMITS["pan"])
                    t = _clampf(self._base_pos[1] + ft, *LIMITS["tilt"])
                    self._base_pos = [p, t]
                    self._base_target = [p, t]
                    if g.gesture.settle == "release":
                        self._release_pending = True
                if self._queue:
                    self._gesture = self._queue.popleft()
                    self._gesture.begin(now)
                    sample = self._gesture.sample(now)
            if sample is not None:
                off_p, off_t = sample

        # 3. ambient layer(s): the live one plus whatever is still fading out
        if self._fading is not None:
            a = self._fading.sample(now)
            if a is None:
                self._fading = None
            else:
                off_p += a[0]
                off_t += a[1]
        if self._ambient is not None:
            a = self._ambient.sample(now)
            if a is None:
                self._ambient = None
                self._ambient_name = None
            else:
                off_p += a[0]
                off_t += a[1]
                flourish = getattr(self._ambient, "flourish", None)
                if flourish and self._gesture is None and not self._queue:
                    self._ambient.flourish = None
                    g = GESTURE_INDEX.get(flourish)
                    if g is not None:
                        self._gesture = GesturePlayer(g, intensity=0.55, speed=1.1)
                        self._gesture.begin(now)

        self._offset = (off_p, off_t)
        pan = _clampf(self._base_pos[0] + off_p, *LIMITS["pan"])
        tilt = _clampf(self._base_pos[1] + off_t, *LIMITS["tilt"])
        amb = self._ambient
        if isinstance(amb, AmbientVibe):
            _period, _anchor, _c, _s = amb.clock.read()
            self._trace.append((now, pan, tilt, _period, _anchor, -1.0 if amb._ph is None else amb._ph, amb.depth))
        else:
            self._trace.append((now, pan, tilt, 0.0, 0.0, -1.0, 0.0))
        ticks = (self._ticks(PAN_CH, pan), self._ticks(TILT_CH, tilt))
        self._moving = True
        if ticks != self._written or self._resend:
            self._resend = False
            self._pan, self._tilt = pan, tilt
            self._written = ticks
            self._released = False
            return ("write", ticks)
        return None


# ----------------------------------------------------------------------------- face finding

class HaarFaceFinder:
    """OpenCV Haar-cascade face detector on the lores luma plane.

    Frontal cascade first; when that finds nothing, the profile cascade on the frame and on its
    mirror (the cascade only knows one side). Detections are scored on size and on closeness to
    the last lock, so a bystander does not steal the head's attention mid-conversation.
    """

    kind = "haar"

    def __init__(self) -> None:
        d = cv2.data.haarcascades
        self._frontal = cv2.CascadeClassifier(os.path.join(d, "haarcascade_frontalface_default.xml"))
        self._profile = cv2.CascadeClassifier(os.path.join(d, "haarcascade_profileface.xml"))
        if self._frontal.empty():
            raise RuntimeError("frontal face cascade missing from the OpenCV install")
        self._profile_ok = HAAR_PROFILE and not self._profile.empty()
        self._last: tuple[float, float] | None = None
        self._n = 0
        self._debug: tuple | None = None
        self._cost_ms = 0.0

    def reset(self) -> None:
        self._last = None

    def _detect(self, cascade, gray):  # noqa: ANN001
        faces = cascade.detectMultiScale(
            gray, scaleFactor=HAAR_SCALE, minNeighbors=HAAR_NEIGHBORS,
            minSize=(HAAR_MIN_PX, HAAR_MIN_PX), flags=cv2.CASCADE_SCALE_IMAGE)
        return [tuple(int(v) for v in f) for f in faces] if len(faces) else []

    def find(self, luma, cb, cr) -> dict:  # noqa: ANN001
        h, w = luma.shape
        t0 = time.perf_counter()
        y_mean = float(luma[::4, ::4].mean())
        if y_mean < LUMA_MIN + 2:
            return {"found": False, "reason": "dark", "luma": round(y_mean, 1)}
        if y_mean > LUMA_MAX - 20:
            return {"found": False, "reason": "blown", "luma": round(y_mean, 1)}
        gray = np.ascontiguousarray(luma)             # the lores view is stride-padded and read-only
        if HAAR_EQUALIZE:
            gray = cv2.equalizeHist(gray)
        kind = "frontal"
        base_conf = 1.0
        faces = self._detect(self._frontal, gray)
        if not faces and self._profile_ok:
            # Side views cost two more passes (the cascade knows one side; the mirror covers the
            # other) at several times the price of the frontal pass. Measured on this rig while
            # searching an empty room: 37-57 ms a frame against 6-9 ms. So they run on every
            # frame only while a lock is held (a head that turns away must not be dropped) and
            # on every HAAR_PROFILE_EVERY-th frontal miss otherwise.
            if self._last is not None or self._n % max(1, HAAR_PROFILE_EVERY) == 0:
                faces = self._detect(self._profile, gray)
                if not faces:
                    flipped = cv2.flip(gray, 1)
                    faces = [(w - x - fw, y, fw, fh) for (x, y, fw, fh) in self._detect(self._profile, flipped)]
                kind = "profile"
                base_conf = 0.75
        self._n += 1
        self._cost_ms = (time.perf_counter() - t0) * 1000.0
        self._debug = (luma[::6, ::4].copy(), list(faces), kind)
        if not faces:
            return {"found": False, "reason": "none", "kind": kind, "luma": round(y_mean, 1),
                    "ms": round(self._cost_ms, 1)}

        best = None
        best_score = -1e9
        for (x, y, fw, fh) in faces:
            cx, cy = x + fw / 2.0, y + fh / 2.0
            score = min(1.0, fw / (0.25 * w))
            if self._last is not None:
                d = math.hypot(cx - self._last[0], cy - self._last[1])
                score += 2.0 * max(0.0, 1.0 - d / (0.35 * w))
            if score > best_score:
                best_score, best = score, (cx, cy, fw, fh)
        cx, cy, fw, fh = best
        # A face 9% of the frame width or wider is unmistakable; smaller (further away) ones are
        # weaker evidence. Profile detections are marked down: the cascade is less selective.
        conf = base_conf * min(1.0, fw / (0.09 * w))
        self._last = (cx, cy)
        return {
            "found": True, "x": round(cx / w, 3), "y": round(cy / h, 3), "w": round(fw / w, 3),
            "h": round(fh / h, 3), "conf": round(conf, 3), "kind": kind, "n": len(faces),
            "luma": round(y_mean, 1), "ms": round(self._cost_ms, 1), "reason": "ok",
        }

    def debug(self) -> dict | None:
        stash = self._debug
        if stash is None:
            return None
        small, faces, kind = stash
        # luma as ASCII shading (dark -> light), face boxes drawn with '#'
        rows = []
        sh, sw = small.shape
        shades = " .:-=+*#%@"
        canvas = [[shades[min(9, int(v) * 10 // 256)] for v in row] for row in small]
        for (x, y, fw, fh) in faces:
            x0, y0 = int(x / 4), int(y / 6)
            x1, y1 = int((x + fw) / 4), int((y + fh) / 6)
            for yy in range(max(0, y0), min(sh, y1 + 1)):
                for xx in range(max(0, x0), min(sw, x1 + 1)):
                    if yy in (y0, y1) or xx in (x0, x1):
                        canvas[yy][xx] = "#"
        rows = ["".join(r) for r in canvas]
        return {
            "detector": self.kind,
            "kind": kind,
            "faces": [{"x": x, "y": y, "w": fw, "h": fh} for (x, y, fw, fh) in faces],
            "cost_ms": round(self._cost_ms, 1),
            "mask": rows,
        }


class SkinFaceFinder:
    """The fallback: a skin-chroma blob finder on the half-resolution chroma planes.

    Kept for a Pi without OpenCV. It runs in ~0.5 ms a frame and needs no extra packages, but it
    cannot tell a face from a forearm by colour alone: two priors (prefer the highest blob, and
    the tilt clamp that keeps the desk out of shot) do that work. It reports *why* it failed, so
    the state machine can tell "nobody there" from "too dark to say".
    """

    kind = "skin"

    def __init__(self) -> None:
        self._last: tuple[float, float] | None = None
        self._debug: tuple | None = None     # last frame, copied raw; rendered only on demand

    def reset(self) -> None:
        self._last = None

    def _stash_debug(self, luma, cb, cr, mask, thr: float, bg: float) -> None:  # noqa: ANN001
        self._debug = (luma.copy(), cb.copy(), cr.copy(), mask.copy(), thr, bg)

    def debug(self) -> dict | None:
        stash = self._debug
        if stash is None:
            return None
        luma, cb, cr, mask, thr, bg = stash
        cr_i = cr.astype(np.int16)
        diff = cr_i - cb.astype(np.int16)
        h, w = mask.shape
        rh, rw = max(1, h // 20), max(1, w // 40)
        block = mask[: (h // rh) * rh, : (w // rw) * rw].reshape(h // rh, rh, w // rw, rw).mean(axis=(1, 3))
        rows = ["".join("#" if v > 0.30 else ("+" if v > 0.05 else ".") for v in row) for row in block]
        return {
            "detector": self.kind,
            "mask": rows,
            "thr": round(thr, 1),
            "bg_cr": round(bg, 1),
            "cr": {p: int(np.percentile(cr_i, p)) for p in (50, 90, 99)},
            "cb": {p: int(np.percentile(cb, p)) for p in (50, 90, 99)},
            "cr_minus_cb": {p: int(np.percentile(diff, p)) for p in (50, 90, 99)},
            "cr_max": int(cr_i.max()),
            "luma_mean": round(float(luma.mean()), 1),
            "px": int(mask.sum()),
        }

    def find(self, luma_full, cb, cr) -> dict:  # noqa: ANN001
        luma = luma_full[::2, ::2]                     # chroma-aligned
        h, w = cr.shape
        cr_i = cr.astype(np.int16)
        cb_i = cb.astype(np.int16)

        y_bg = float(luma[::2, ::2].mean())
        if y_bg < LUMA_MIN + 2:
            return {"found": False, "reason": "dark"}
        if y_bg > LUMA_MAX - 20:
            return {"found": False, "reason": "blown"}

        bg = float(np.median(cr_i[::3, ::3]))
        thr = min(SKIN_CR_CEIL, max(SKIN_CR_FLOOR, bg + SKIN_CR_MARGIN))
        mask = (
            (cr_i >= thr)
            & (cb_i <= SKIN_CB_CEIL)
            & ((cr_i - cb_i) >= SKIN_CRCB_MIN)
            & (luma > LUMA_MIN)
            & (luma < LUMA_MAX)
        )
        self._stash_debug(luma, cb_i, cr_i, mask, thr, bg)
        n = int(mask.sum())
        if n < TRACK_MIN_PX:
            return {"found": False, "reason": "none", "px": n, "thr": round(thr, 1), "bg": round(bg, 1)}
        if n > TRACK_MAX_FRAC * mask.size:
            return {"found": False, "reason": "flood", "px": n, "thr": round(thr, 1), "bg": round(bg, 1)}

        best = self._pick(mask, h, w)
        if best is None:
            return {"found": False, "reason": "none", "px": n, "thr": round(thr, 1), "bg": round(bg, 1)}
        cx, cy, px, conf, aspect, fill = best
        self._last = (cx, cy) if conf >= TRACK_CONF_HOLD else None
        return {
            "found": True, "x": round(cx / w, 3), "y": round(cy / h, 3), "conf": round(conf, 3),
            "px": px, "thr": round(thr, 1), "bg": round(bg, 1),
            "aspect": round(aspect, 2), "fill": round(fill, 2), "kind": "skin",
            "reason": "ok",
        }

    def _pick(self, mask, h: int, w: int):  # noqa: ANN001
        """Segment the mask into contiguous column runs and choose the most head-like one."""
        col = mask.sum(0)
        on = col > 0
        if not on.any():
            return None
        edges = np.diff(on.astype(np.int8))
        starts = list(np.nonzero(edges == 1)[0] + 1)
        ends = list(np.nonzero(edges == -1)[0] + 1)
        if on[0]:
            starts.insert(0, 0)
        if on[-1]:
            ends.append(w)

        best = None
        best_score = -1e9
        for s, e in zip(starts, ends):
            if e - s < 2:
                continue
            sub = mask[:, s:e]
            rows = np.nonzero(sub.any(axis=1))[0]
            if not len(rows):
                continue
            brk = np.nonzero(np.diff(rows) > 2)[0]
            band_end = rows[brk[0]] if len(brk) else rows[-1]
            sub = sub[: band_end + 1]
            ys, xs = np.nonzero(sub)
            px = len(ys)
            if px < TRACK_MIN_PX:
                continue
            top, bot = int(ys.min()), int(ys.max())
            bw, bh = e - s, bot - top + 1
            fill = px / float(bw * bh)
            aspect = bw / float(bh)
            if aspect > 2.6:
                shape = 0.22
            elif aspect < 0.28:
                shape = 0.8
            else:
                shape = 1.0
            size = min(1.0, px / 45.0) * (1.0 if px <= TRACK_BLOB_MAX_PX else 0.25)
            conf = size * (0.45 + 0.55 * fill) * shape

            score = 3.0 * (1.0 - top / float(h))        # topness: a face sits above the hands
            score += 1.5 * conf
            if self._last is not None:                  # stickiness: prefer what we were tracking
                cx0 = s + float(xs.mean())
                d = ((cx0 - self._last[0]) ** 2 + (float(ys.mean()) - self._last[1]) ** 2) ** 0.5
                score += 2.5 * max(0.0, 1.0 - d / (0.35 * w))
            if score <= best_score:
                continue
            cx = s + float(xs.mean())
            cy = float(ys.mean()) - 0.18 * bh
            best_score, best = score, (cx, max(0.0, cy), px, conf, aspect, fill)
        return best


def make_face_finder():
    """Pick the detector: Haar when OpenCV is importable (unless told otherwise), else skin chroma."""
    want = FACE_DETECTOR
    if want in ("auto", "haar") and cv2 is not None:
        try:
            finder = HaarFaceFinder()
            log.info("face detector: OpenCV %s Haar cascades (profile=%s, equalize=%s)",
                     cv2.__version__, finder._profile_ok, HAAR_EQUALIZE)
            return finder
        except Exception as exc:  # noqa: BLE001
            log.warning("Haar detector unavailable (%s); using the skin-chroma finder", exc)
    elif want == "haar":
        log.warning("NOVA_FACE_DETECTOR=haar but OpenCV is not importable (%s); using skin chroma", CV2_IMPORT_ERROR)
    else:
        log.info("face detector: skin chroma%s", "" if cv2 is None else " (by request)")
    return SkinFaceFinder()


# ----------------------------------------------------------------------------- desk companion

class Captures:
    """Photos on disk under CAPTURES_DIR, named by timestamp (+ an optional label slug), bounded."""

    NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,96}\.jpg$")

    def __init__(self, directory: str) -> None:
        self.dir = directory
        self._lock = threading.Lock()
        try:
            os.makedirs(directory, exist_ok=True)
            self.available = True
        except OSError as exc:
            log.warning("captures disabled: cannot create %s (%s)", directory, exc)
            self.available = False

    def save(self, jpeg: bytes, label: str = "") -> str:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        slug = re.sub(r"[^A-Za-z0-9-]+", "-", str(label or "").strip().lower())[:24].strip("-")
        base = f"{stamp}-{slug}" if slug else stamp
        with self._lock:
            name, i = f"{base}.jpg", 1
            while os.path.exists(os.path.join(self.dir, name)):
                name = f"{base}-{i}.jpg"
                i += 1
            tmp = os.path.join(self.dir, f".{name}.tmp")
            with open(tmp, "wb") as fh:
                fh.write(jpeg)
            os.replace(tmp, os.path.join(self.dir, name))
        self.prune()
        return name

    def prune(self) -> None:
        try:
            names = sorted(n for n in os.listdir(self.dir) if self.NAME_RE.match(n))
        except OSError:
            return
        for n in names[:-CAPTURES_MAX] if len(names) > CAPTURES_MAX else []:
            try:
                os.unlink(os.path.join(self.dir, n))
            except OSError:
                pass

    def list(self, limit: int = 50) -> list[dict]:
        out = []
        try:
            names = [n for n in os.listdir(self.dir) if self.NAME_RE.match(n)]
        except OSError:
            return out
        for n in sorted(names, reverse=True)[:limit]:
            try:
                st = os.stat(os.path.join(self.dir, n))
            except OSError:
                continue
            out.append({"name": n, "at": int(st.st_mtime), "bytes": st.st_size})
        return out

    def path(self, name: str) -> str | None:
        if not isinstance(name, str) or not self.NAME_RE.match(name):
            return None
        p = os.path.join(self.dir, name)
        return p if os.path.isfile(p) else None

    def read(self, name: str) -> bytes | None:
        p = self.path(name)
        if p is None:
            return None
        with open(p, "rb") as fh:
            return fh.read()


class TelegramNotifier:
    """Messages (and photos) to the user's own Telegram, through the Hermes bot already on this Pi.

    Credentials come from NOVA_TELEGRAM_TOKEN / NOVA_TELEGRAM_CHAT, else from Hermes's own
    ~/.hermes/.env (TELEGRAM_BOT_TOKEN and the first id in TELEGRAM_ALLOWED_USERS -- for a direct
    message the user id *is* the chat id). Sends run on a worker thread so a slow network never
    stalls the motion or detection loops. NOVA_TELEGRAM_NOTIFY=0 disables it outright.
    """

    def __init__(self) -> None:
        self.token, self.chat_id = self._load()
        self.enabled = TELEGRAM_NOTIFY != "0" and bool(self.token and self.chat_id)
        self.sent = 0
        self.last_error: str | None = None
        self.last_sent_at = 0.0
        self._q: queue.Queue = queue.Queue()
        if self.enabled:
            threading.Thread(target=self._worker, name="telegram", daemon=True).start()
            log.info("telegram notifier ready (chat %s...%s)", self.chat_id[:2], self.chat_id[-2:])
        else:
            log.info("telegram notifier disabled (%s)", "by config" if TELEGRAM_NOTIFY == "0" else "no bot token / chat id")

    @staticmethod
    def _load() -> tuple[str, str]:
        token = os.environ.get("NOVA_TELEGRAM_TOKEN", "").strip()
        chat = os.environ.get("NOVA_TELEGRAM_CHAT", "").strip()
        if token and chat:
            return token, chat
        env_path = os.path.join(HERMES_HOME, ".env")
        values: dict[str, str] = {}
        try:
            with open(env_path) as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, val = line.partition("=")
                    val = val.strip()
                    if val[:1] in ("'", '"') and val[-1:] == val[:1]:
                        val = val[1:-1]
                    else:
                        val = val.split(" #", 1)[0].split("\t#", 1)[0].strip()
                    values[key.strip()] = val
        except OSError:
            pass
        token = token or values.get("TELEGRAM_BOT_TOKEN", "")
        if not chat:
            users = values.get("TELEGRAM_ALLOWED_USERS", "")
            first = re.split(r"[,\s]+", users.strip())[0] if users.strip() else ""
            chat = first if first.lstrip("-").isdigit() else ""
        return token, chat

    def send(self, text: str, photo: bytes | None = None) -> bool:
        """Queue a message; returns False when the notifier is disabled."""
        if not self.enabled:
            return False
        self._q.put((text, photo))
        return True

    def send_now(self, text: str, photo: bytes | None = None) -> tuple[bool, str | None]:
        if not self.enabled:
            return False, "telegram notifications are not configured"
        try:
            self._post(text, photo)
            return True, None
        except Exception as exc:  # noqa: BLE001
            self.last_error = str(exc)[:200]
            return False, self.last_error

    def _worker(self) -> None:
        while True:
            text, photo = self._q.get()
            try:
                self._post(text, photo)
            except Exception as exc:  # noqa: BLE001
                self.last_error = str(exc)[:200]
                log.warning("telegram send failed: %s", exc)

    def _post(self, text: str, photo: bytes | None) -> None:
        base = f"https://api.telegram.org/bot{self.token}/"
        if photo is None:
            data = json.dumps({"chat_id": self.chat_id, "text": text[:4000]}).encode()
            req = urllib.request.Request(base + "sendMessage", data=data, headers={"Content-Type": "application/json"})
        else:
            boundary = "----nova" + os.urandom(8).hex()
            parts = []
            for name, value in (("chat_id", self.chat_id), ("caption", text[:1000])):
                parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode())
            parts.append((f"--{boundary}\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"capture.jpg\"\r\n"
                          "Content-Type: image/jpeg\r\n\r\n").encode() + photo + b"\r\n")
            parts.append(f"--{boundary}--\r\n".encode())
            req = urllib.request.Request(base + "sendPhoto", data=b"".join(parts),
                                         headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = json.loads(resp.read().decode("utf-8", "replace"))
        if not body.get("ok"):
            raise RuntimeError(str(body.get("description") or "telegram refused the message"))
        self.sent += 1
        self.last_sent_at = time.time()
        self.last_error = None


class Presence:
    """Is someone at the desk? Fed by whichever detection loop is running (idle sensing or the tracker).

    Arrival needs PRESENCE_ARRIVE_FRAMES consecutive detections so one false positive does not
    trigger a greeting; departure waits PRESENCE_AWAY_S so a glance away or a trip to the kettle
    does not count as leaving.
    """

    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled
        self.present = False
        self.since: float | None = None
        self.last_seen: float | None = None
        self.arrivals = 0
        self.events: deque[tuple[str, float]] = deque(maxlen=20)
        self._hits = 0
        self._lock = threading.Lock()

    def update(self, found: bool) -> str | None:
        """Feed one detection result; returns "arrived" / "left" on a transition, else None."""
        now = time.time()
        with self._lock:
            if found:
                self.last_seen = now
                self._hits += 1
                if not self.present and self._hits >= PRESENCE_ARRIVE_FRAMES:
                    self.present = True
                    self.since = now
                    self.arrivals += 1
                    self.events.append(("arrived", now))
                    return "arrived"
            else:
                self._hits = 0
                if self.present and self.last_seen is not None and now - self.last_seen > PRESENCE_AWAY_S:
                    self.present = False
                    self.since = now
                    self.events.append(("left", now))
                    return "left"
        return None

    def state(self) -> dict:
        with self._lock:
            now = time.time()
            return {
                "enabled": self.enabled,
                "present": self.present,
                "since": int(self.since) if self.since else None,
                "last_seen": int(self.last_seen) if self.last_seen else None,
                "at_desk_s": int(now - self.since) if self.present and self.since else 0,
                "away_s": int(now - self.since) if not self.present and self.since else 0,
                "arrivals": self.arrivals,
                "events": [{"kind": k, "at": int(t)} for (k, t) in self.events],
            }


class DeskWatch:
    """Motion + face watch for an unattended desk: frame differencing on a 60x80 luma thumbnail."""

    def __init__(self) -> None:
        self.enabled = False
        self.notify = True
        self.armed_at: float | None = None
        self.events: deque[dict] = deque(maxlen=30)
        self.last_event_at = 0.0
        self.last_notify_at = 0.0
        self._prev = None
        self._motion_frames = 0
        self._next_id = 1
        self._lock = threading.Lock()

    def set(self, enabled: bool, notify: bool | None = None) -> None:
        with self._lock:
            if notify is not None:
                self.notify = bool(notify)
            if enabled and not self.enabled:
                self.armed_at = time.time()
                self._prev = None
                self._motion_frames = 0
            if not enabled:
                self.armed_at = None
            self.enabled = bool(enabled)

    def step(self, small, now: float) -> dict | None:  # noqa: ANN001
        """Feed one thumbnail; returns {frac, cx, cy} when sustained motion warrants an event."""
        prev, self._prev = self._prev, small
        if prev is None or prev.shape != small.shape:
            return None
        diff = np.abs(small - prev)
        mask = diff > WATCH_MOTION_DIFF
        frac = float(mask.mean())
        if frac < WATCH_MOTION_FRAC:
            self._motion_frames = 0
            return None
        self._motion_frames += 1
        if self._motion_frames < 2 or now - self.last_event_at < WATCH_EVENT_GAP_S:
            return None
        ys, xs = np.nonzero(mask)
        h, w = mask.shape
        self.last_event_at = now
        return {"frac": frac, "cx": float(xs.mean()) / w, "cy": float(ys.mean()) / h}

    def record(self, kind: str, capture: str | None, frac: float, notified: bool) -> dict:
        with self._lock:
            ev = {"id": self._next_id, "at": int(time.time()), "kind": kind, "capture": capture,
                  "area": round(frac, 3), "notified": notified}
            self._next_id += 1
            self.events.append(ev)
            return ev

    def state(self, with_events: bool = True) -> dict:
        with self._lock:
            st = {
                "enabled": self.enabled,
                "notify": self.notify,
                "armed_at": int(self.armed_at) if self.armed_at else None,
                "event_count": len(self.events),
                "last_event": dict(self.events[-1]) if self.events else None,
            }
            if with_events:
                st["events"] = [dict(e) for e in self.events]
            return st


# ----------------------------------------------------------------------------- attention

class Attention:
    """Decides where the head looks: at you when Nova is listening, away when she is thinking.

    The Pi owns this rather than the browser, for one decisive reason: the browser is an unreliable
    controller. Tabs close, laptops sleep, `setInterval` is throttled in background tabs and Wi-Fi
    drops -- and every one of those would otherwise leave the servos energised, holding a pose, until
    someone noticed. The browser therefore publishes *intent* under a short lease (`wake`, `speak`,
    `think`, `tool`, `sleep`) and the Pi runs the loop; if the dashboard goes quiet the lease lapses
    and the head parks and then releases on its own.

    Internal states:
      off     nothing running, servos released, camera not held. Costs nothing.
      search  looking for a face: straight ahead first, then a slow scan left and right.
      track   locked on and following.
      park    "looked in a direction and stayed there" -- the last good face pose if there was one.
      think   detector off, playing thinking beats around the pose she was holding.

    `speak` is orthogonal: while it is fresh, the head keeps tracking and the ambient "talking"
    motion runs on top.
    """

    def __init__(self, camera: Camera, pantilt: PanTilt, *, presence: Presence | None = None,
                 watch: DeskWatch | None = None, captures: Captures | None = None,
                 notifier: TelegramNotifier | None = None, music: MusicSense | None = None) -> None:
        self.camera = camera
        self.pantilt = pantilt
        self.music = music
        if music is not None:
            music.head = pantilt
        self._vibe_forced_until = 0.0
        self._vibe_kind: str | None = None     # "vibe" | "metronome" while the head is bobbing
        self._metro_until = 0.0
        self._metro_bpm = 0.0
        self._metro_clock = BeatClock()
        self._vibing = False
        self.presence = presence or Presence(False)
        self.watch = watch or DeskWatch()
        self.captures = captures
        self.notifier = notifier
        self.finder = make_face_finder() if np is not None else None
        self.error: str | None = None
        if np is None:
            self.error = f"numpy unavailable: {NUMPY_IMPORT_ERROR}"

        self._cv = threading.Condition()
        self._stopping = False
        self._mode = "off"
        self._sleeping = False  # finite nod-off completed/in progress; only explicit intent wakes it
        self._since = time.monotonic()
        self._lease_until = 0.0
        self._speak_until = 0.0
        self._manual_until = 0.0
        self._holds_camera = False
        self._settle_until = 0.0
        self._sp: tuple[float, float] | None = None      # our own float setpoint, never read back
        self._last_face_pose: tuple[int, int] | None = None
        self._last_face_at = 0.0
        self._last_seen = 0.0
        self._good_frames = 0
        self._last_detect: dict = {"found": False, "reason": "idle"}
        self._cam_error_at = 0.0
        # search
        self._search_phase = 0
        self._search_phase_at = 0.0
        self._search_origin: tuple[int, int] = ATTENTION_HOME
        # thinking
        self._think_beat = 0
        self._think_next = 0.0
        self._think_pending_tool = False
        # desk companion
        self._greeted_at = 0.0
        self._greet_pending = False
        self._watch_release_at = 0.0
        self._rested = False
        self._rest_saved: tuple[int, int] | None = None
        self._rest_saved_at = 0.0
        self._glance_idx = 0
        self._glance_at = 0.0
        self._idle_seen_at = 0.0
        self._calibrating = False
        self._load_head_state()
        self._thread = threading.Thread(target=self._run, name="attention", daemon=True)

    @property
    def available(self) -> bool:
        return self.error is None and self.pantilt.available

    @property
    def detector(self) -> str | None:
        return self.finder.kind if self.finder is not None else None

    def start(self) -> None:
        if self.available:
            self._thread.start()

    # -- public API ---------------------------------------------------------------------
    def request(self, mode: str) -> dict:
        """Publish intent from the dashboard. Fire-and-forget; renews the lease."""
        mode = (mode or "").strip().lower()
        if mode not in ("wake", "listen", "think", "tool", "speak", "sleep", "idle"):
            raise BadRequest('mode must be one of "wake", "speak", "think", "tool", "sleep"')
        now = time.monotonic()
        with self._cv:
            if self._sleeping and mode not in ("sleep", "idle"):
                self._sleeping = False
                self.pantilt.stop_gesture()
                # Force a fresh camera search even during an early interruption.
                self._since = now - PARK_WATCH_S - 1.0
            if mode in ("sleep", "idle"):
                # Expire the lease rather than renewing it: "stop paying attention" must not also
                # mean "stay attentive for another twelve seconds".
                self._lease_until = 0.0
            else:
                self._lease_until = now + ATTENTION_LEASE_S
            self._speak_until = now + ATTENTION_LEASE_S if mode == "speak" else 0.0
            if mode == "tool":
                self._think_pending_tool = True
                if self._mode != "think":
                    self._enter("think", now)
            elif mode == "think":
                if self._mode != "think":
                    self._enter("think", now)
            elif mode in ("wake", "listen", "speak"):
                # Being spoken to outranks a stale d-pad nudge.
                self._manual_until = 0.0
                # `park` keeps watching for a while and upgrades itself to `track` if she reappears;
                # restarting the search on every heartbeat would make the head twitch. Once park
                # has given up the camera, though, a fresh wake really should look again.
                if self._mode in ("off", "think") or (
                    self._mode == "park" and now - self._since > PARK_WATCH_S
                ):
                    self._enter("search", now)
            else:                                          # sleep / idle
                if self._mode not in ("off", "park"):
                    self._enter("park", now)
            self._cv.notify()
        return self.state()

    def note_manual(self) -> None:
        """Someone drove the d-pad. Get out of the way for a moment rather than fighting them."""
        with self._cv:
            if self._sleeping:
                self._sleeping = False
            self.pantilt.stop_gesture()  # manual control wins even mid-avoidance
            self.pantilt.set_ambient(None)
            self._manual_until = time.monotonic() + 8.0
            self._sp = None                                # resync to wherever they put it

    def note_gesture(self, name: str | None = None) -> None:
        """Explicit gestures wake the pet, except the finite nod-off which latches sleep."""
        with self._cv:
            was_sleeping = self._sleeping
            self._sleeping = name == "fall_asleep"
            if self._sleeping:
                self.pantilt.set_ambient(None)
            if self._mode == "off" and not self._vibing:
                self._enter("park", time.monotonic())
            if was_sleeping or self._sleeping:
                self._since = time.monotonic()
            self._cv.notify()

    def force_vibe(self, on: bool) -> None:
        """Vibe now, music or not (for VIBE_FORCE_MAX_S), or stop a forced vibe."""
        with self._cv:
            self._vibe_forced_until = time.monotonic() + VIBE_FORCE_MAX_S if on else 0.0
            self._cv.notify()

    def set_metronome(self, bpm: float | None) -> None:
        """Nod on a fixed beat (a visual metronome) for up to METRO_MAX_S; None / 0 stops it. The
        metronome takes precedence over music while it runs."""
        with self._cv:
            now = time.monotonic()
            if self.music is not None:
                self.music.set_suppressed(bool(bpm))
            if bpm:
                bpm = _clampf(float(bpm), *METRO_BPM_RANGE)
                self._metro_bpm = bpm
                self._metro_clock.set(period=60.0 / bpm, anchor=now, confidence=1.0, strength=1.0, bpm=bpm)
                self._metro_until = now + METRO_MAX_S
            else:
                self._metro_until = 0.0
            self._cv.notify()

    def metronome_state(self) -> dict:
        now = time.monotonic()
        on = now < self._metro_until
        return {"enabled": on, "bpm": round(self._metro_bpm, 1) if on else None,
                "running": on and self._vibe_kind == "metronome",
                "remaining_s": int(self._metro_until - now) if on else 0}

    def vibe_state(self) -> dict:
        now = time.monotonic()
        st = self.music.state() if self.music is not None else {"available": False, "enabled": False, "active": False}
        st["vibing"] = self._vibing
        st["forced"] = now < self._vibe_forced_until
        return st

    def state(self) -> dict:
        with self._cv:
            now = time.monotonic()
            return {
                "ok": True,
                "available": self.available,
                "error": self.error,
                "detector": self.detector,
                "mode": self._mode,
                "sleeping": self._sleeping,
                "since_s": round(now - self._since, 1),
                "lease_s": round(max(0.0, self._lease_until - now), 1),
                "speaking": now < self._speak_until,
                "manual": now < self._manual_until,
                "locked": self._mode == "track",
                "detect": dict(self._last_detect),
                "home": list(ATTENTION_HOME),
                "last_face": list(self._last_face_pose) if self._last_face_pose else None,
                "gesture": self.pantilt.current_gesture(),
                "present": self.presence.present,
                "watching": self.watch.enabled,
                "vibing": self._vibing,
            }

    def stop(self) -> None:
        with self._cv:
            self._stopping = True
            self._cv.notify()
        if self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._drop_camera()

    # -- camera lease -------------------------------------------------------------------
    def _take_camera(self) -> bool:
        with self._cv:
            if self._holds_camera:
                return True
            now = time.monotonic()
            if now - self._cam_error_at < 30.0:
                return False
        try:
            _out, cold = self.camera.acquire(encode=False)
        except Exception as exc:  # noqa: BLE001
            with self._cv:
                self._cam_error_at = time.monotonic()
            log.warning("attention: camera unavailable (%s); parking instead", exc)
            return False
        with self._cv:
            self._holds_camera = True
            if cold:
                # A cold sensor delivers frames long before AE and AWB have converged.
                self._settle_until = time.monotonic() + CAMERA_SETTLE_S
        return True

    def _drop_camera(self) -> None:
        with self._cv:
            if not self._holds_camera:
                return
            self._holds_camera = False
        try:
            self.camera.release(encode=False)
        except Exception:  # noqa: BLE001
            log.exception("attention: camera release failed")

    # -- servo output -------------------------------------------------------------------
    def _aim(self, pan: float, tilt: float, *, slow: bool = False) -> None:
        if time.monotonic() < self._manual_until:
            return
        self.pantilt.move(pan, tilt, quiet=True, speed=THINK_SPEED_DPS if slow else GLIDE_SPEED_DPS)

    def _search_start_pose(self, now: float) -> tuple[int, int]:
        if self._last_face_pose and now - self._last_face_at < LAST_FACE_TTL_S:
            return self._last_face_pose
        if self._rest_saved and time.time() - self._rest_saved_at < REST_POSE_TTL_S:
            return self._rest_saved
        return ATTENTION_HOME

    def _enter(self, mode: str, now: float) -> None:
        """Called with _cv held."""
        if mode == self._mode:
            return
        prev = self._mode
        self._mode = mode
        self._since = now
        if mode == "search":
            self._good_frames = 0
            if self.finder is not None:
                self.finder.reset()
            self._last_seen = now
            self._sp = None
            self._search_phase = 0
            self._search_phase_at = now
            self._search_origin = self._search_start_pose(now)
            # Look toward them *now* -- the visible "she heard me" beat -- before the camera is
            # touched, because a cold start takes about a second.
            self._aim(*self._search_origin)
        elif mode == "park":
            self._good_frames = 0
            self._greet_pending = False
            if self.finder is not None:
                self.finder.reset()
        elif mode == "think":
            self._think_beat = 0
            self._think_next = 0.0
        elif mode == "off":
            self._sp = None
            if self.finder is not None:
                self.finder.reset()
            self.pantilt.set_ambient(None)
            self._rest_head()
        if prev == "think" and mode != "think":
            self.pantilt.stop_gesture()          # a pondering beat must not outlive the thought
        log.info("attention: %s -> %s", prev, mode)

    # -- loop ---------------------------------------------------------------------------
    def _run(self) -> None:
        log.info("attention engine ready (home=%s, track tilt %s, detector=%s)",
                 ATTENTION_HOME, track_tilt_range(), self.detector)
        period = 1.0 / max(1.0, TRACK_HZ)
        while True:
            with self._cv:
                if self._stopping:
                    break
                idle = self._mode == "off"
            if self._calibrating:
                time.sleep(0.2)
                continue
            if idle:
                # Nobody is talking to Nova. Keep a quiet eye on the desk: presence sensing every
                # few seconds, and the desk watch at 2 Hz when it is armed. Both disabled -> the
                # camera is dropped and the thread sleeps until something wakes it.
                try:
                    delay = self._step_idle(time.monotonic())
                except Exception:  # noqa: BLE001
                    log.exception("idle sensing failed")
                    delay = 2.0
                with self._cv:
                    if self._mode == "off" and not self._stopping:
                        self._cv.wait(timeout=delay if delay is not None else 5.0)
                    if self._stopping:
                        break
                    if self._mode == "off":
                        continue
            if self._vibing:
                self._vibing = False          # the conversation's own ambient logic takes over
            with self._cv:
                if self._stopping:
                    break
                mode = self._mode
                now = time.monotonic()
                if self._lease_until and now > self._lease_until and mode not in ("off", "park"):
                    log.info("attention: lease expired; parking")
                    self._enter("park", now)
                    mode = "park"
                speaking = now < self._speak_until and mode in ("search", "track", "park")
                leased = now <= self._lease_until
            # Talking motion wins. An unleased parked head keeps only the tiny idle drift; search and
            # tracking stay geometrically clean because their detector owns the pose.
            ambient = "talk" if speaking else ("idle" if mode == "park" and not leased and not self._sleeping else None)
            amplitude = TALK_AMPLITUDE if ambient == "talk" else IDLE_MOTION_AMPLITUDE
            if ambient == "idle" and self.pantilt.ambient_name != "idle":
                self._start_idle_motion()
            else:
                self.pantilt.set_ambient(ambient, amplitude)
            try:
                if mode in ("search", "track", "park"):
                    self._step_look(mode)
                elif mode == "think":
                    self._step_think()
            except Exception:  # noqa: BLE001 - one bad frame must never kill the thread
                log.exception("attention step failed")
                time.sleep(0.5)
            if self._mode == "think":
                time.sleep(0.05)
            elif self._mode == "park":
                time.sleep(0.5)                # parked: sample slowly, just enough to notice a return
            else:
                time.sleep(period)
        self.pantilt.set_ambient(None)
        self._drop_camera()
        log.info("attention engine stopped")

    def _step_search_scan(self, now: float) -> None:
        """Nobody straight ahead: sweep left, then right, then settle back where we started."""
        phase = self._search_phase
        elapsed = now - self._search_phase_at
        hold = SEARCH_TIMEOUT_S if phase == 0 else SEARCH_SCAN_HOLD_S
        if elapsed < hold:
            return
        self._search_phase = phase + 1
        self._search_phase_at = now
        op, ot = self._search_origin
        tilt = _clampf(ot, *track_tilt_range())
        down, up = SEARCH_SCAN_TILT
        # Left, right, then lower and higher: a seated face can sit well below the home pose.
        if self._search_phase == 1:
            self._aim(_clampf(op - SEARCH_SCAN_DEG, *LIMITS["pan"]), tilt, slow=True)
        elif self._search_phase == 2:
            self._aim(_clampf(op + SEARCH_SCAN_DEG, *LIMITS["pan"]), tilt, slow=True)
        elif self._search_phase == 3:
            self._aim(op, _clampf(tilt + down, *track_tilt_range()), slow=True)
        elif self._search_phase == 4:
            self._aim(op, _clampf(tilt - up, *track_tilt_range()), slow=True)
        elif self._search_phase == 5:
            self._aim(op, tilt, slow=True)
        else:
            with self._cv:
                self._enter("park", now)

    def _step_look(self, mode: str) -> None:
        now = time.monotonic()

        with self._cv:
            leased = now <= self._lease_until

        if self._sleeping and not leased and not self.watch.enabled:
            # Do not re-park at 25 seconds or wake the head after the 30-second gesture.
            self._drop_camera()
            return
        if mode == "park":
            music = now < self._metro_until or (self.music is not None and (self.music.active or now < self._vibe_forced_until))
            if (now - self._since > PARK_HOLD_S or (music and not leased)) and not self.pantilt.gesture_active():
                # The hold exists so the head is not powered down and up again between sentences;
                # music starting is a better use of the servos than holding still for it.
                with self._cv:
                    self._enter("off", now)
                self._drop_camera()
                return
            if not leased or now - self._since > PARK_WATCH_S:
                if self._holds_camera:
                    self._drop_camera()
                return

        if not self._take_camera():
            if mode != "park":
                self._aim(*self._search_start_pose(now))
                with self._cv:
                    self._last_detect = {"found": False, "reason": "no-camera"}
                    self._enter("park", now)
            return

        if now < self._settle_until:
            with self._cv:
                self._last_detect = {"found": False, "reason": "settling"}
            if mode == "search":
                self._search_phase_at = now        # the clock starts once the sensor has settled
            return

        frame = self.camera.grab_lores()
        if frame is None or self.finder is None:
            with self._cv:
                self._last_detect = {"found": False, "reason": "no-frame"}
            return
        det = self.finder.find(*frame)
        with self._cv:
            self._last_detect = det
        credible = bool(det.get("found") and det.get("conf", 0.0) >= TRACK_CONF_ACQUIRE)
        if self.presence.enabled:
            self._note_presence(self.presence.update(credible), now)

        if det.get("found") and det.get("conf", 0.0) >= (
            TRACK_CONF_HOLD if mode == "track" else TRACK_CONF_ACQUIRE
        ):
            self._good_frames += 1
            self._last_seen = now
            if mode != "track" and leased and self._good_frames >= TRACK_ACQUIRE_FRAMES:
                with self._cv:
                    self._enter("track", now)
                mode = "track"
            if mode == "track":
                self._follow(det)
                if self._greet_pending:
                    # She has found you after you sat down: a nod hello.
                    self._greet_pending = False
                    self.pantilt.play(GESTURE_INDEX["greet"], intensity=1.0)
            return

        self._good_frames = 0
        if mode == "track" and now - self._last_seen > LOST_GRACE_S:
            # Lost her. Do not jump or re-centre -- freeze, which is where she is most likely to
            # reappear; park keeps watching for a while.
            with self._cv:
                self._enter("park", now)
        elif mode == "search":
            self._step_search_scan(now)

    # -- desk companion -------------------------------------------------------------------
    def _load_head_state(self) -> None:
        """Where a face was last found, remembered across restarts (the head rests there)."""
        try:
            with open(HEAD_STATE_FILE) as fh:
                st = json.load(fh)
            pose = st.get("last_face")
            at = float(st.get("at", 0))
            if isinstance(pose, list) and len(pose) == 2 and time.time() - at < REST_POSE_TTL_S:
                lo, hi = track_tilt_range()
                self._rest_saved = (int(_clampf(pose[0], *LIMITS["pan"])), int(_clampf(pose[1], lo, hi)))
                self._rest_saved_at = at
                log.info("head state: last face at pan %d / tilt %d (%.0f min ago)", *self._rest_saved, (time.time() - at) / 60)
        except (OSError, ValueError, TypeError):
            pass

    def _save_head_state(self, pose: tuple[int, int]) -> None:
        now = time.time()
        if self._rest_saved == pose and now - self._rest_saved_at < 300:
            return
        self._rest_saved, self._rest_saved_at = pose, now
        try:
            tmp = HEAD_STATE_FILE + ".tmp"
            with open(tmp, "w") as fh:
                json.dump({"last_face": list(pose), "at": now}, fh)
            os.replace(tmp, HEAD_STATE_FILE)
        except OSError as exc:
            log.debug("head state not saved: %s", exc)

    def _rest_pose(self) -> tuple[int, int]:
        """Where the head rests while idle: where a face was last found (today), else home."""
        now = time.monotonic()
        if self._last_face_pose and now - self._last_face_at < LAST_FACE_TTL_S:
            pose = self._last_face_pose
        elif self._rest_saved and time.time() - self._rest_saved_at < REST_POSE_TTL_S:
            pose = self._rest_saved
        else:
            pose = ATTENTION_HOME
        raised_max = min(LIMITS["tilt"][1], IDLE_REST_TILT_MAX)
        return pose[0], int(_clampf(pose[1], LIMITS["tilt"][0], raised_max))

    def _start_idle_motion(self) -> None:
        """Raise the resting gaze and start the low-amplitude procedural idle layer."""
        if (self._sleeping or self._vibing or self._calibrating or self.watch.enabled
                or time.monotonic() < self._manual_until or self.pantilt.ambient_name == "idle"):
            return
        self.pantilt.move(*self._rest_pose(), quiet=True, speed=THINK_SPEED_DPS)
        self.pantilt.set_ambient("idle", IDLE_MOTION_AMPLITUDE)
        self._rested = True

    def _rest_head(self) -> None:
        """Relax the servos -- but, when the camera keeps sensing while idle, only after parking the
        head at head height. Released at the desk (the servos' own centre) the presence check would
        spend all day looking at a keyboard."""
        if self.finder is not None and (self.presence.enabled or self.watch.enabled):
            self.pantilt.move(*self._rest_pose(), quiet=True, speed=THINK_SPEED_DPS * 2)
            self.pantilt.release(immediate=False)
        else:
            self.pantilt.release()
        self._rested = True

    def _note_presence(self, event: str | None, now: float) -> None:
        if event == "arrived":
            log.info("presence: someone arrived at the desk")
            if GREET_ON_ARRIVAL and now - self._greeted_at > GREET_COOLDOWN_S:
                with self._cv:
                    if self._mode == "off":
                        # Look up and find them; the nod comes once the tracker has a lock. The
                        # self-granted lease is short: after it she parks and, later, relaxes.
                        self._greeted_at = now
                        self._greet_pending = True
                        self._lease_until = now + GREET_LEASE_S
                        self._enter("search", now)
        elif event == "left":
            log.info("presence: the desk is empty")

    def _step_idle(self, now: float) -> float | None:
        """Sense presence / watch the desk while idle. Returns how long to sleep, or None to wait."""
        if self._calibrating:
            return 0.5
        if self._sleeping and not self.watch.enabled:
            self._drop_camera()
            return 1.0
        # -- music / metronome: bob along while nobody is talking to her
        metro = now < self._metro_until
        vibing = metro or (self.music is not None and (self.music.active or now < self._vibe_forced_until))
        want = "metronome" if metro else "vibe"
        if vibing and (not self._vibing or self._vibe_kind != want):
            if not self._vibing:
                # Face forward first: an idle glance may have left the head looking off to one side.
                self._glance_idx = 0
                rp, rt = self._rest_pose()
                headroom = int(math.ceil(VIBE_NOD_DEG * min(2.0, VIBE_AMPLITUDE))) + 3
                rt = max(LIMITS["tilt"][0], min(rt, LIMITS["tilt"][1] - headroom))   # room to nod *down* from the base pose
                self.pantilt.move(rp, rt, quiet=True, speed=THINK_SPEED_DPS * 2)
            self._vibing = True
            self._vibe_kind = want
            if metro:
                self.pantilt.set_ambient("metronome", VIBE_AMPLITUDE, clock=self._metro_clock)
                log.info("metronome: on (%.0f BPM)", self._metro_bpm)
            else:
                self.pantilt.set_ambient("vibe", VIBE_AMPLITUDE, clock=self.music.clock)
                log.info("vibe: on (%s)", "forced" if now < self._vibe_forced_until else f"{self.music.bpm:.0f} BPM")
        elif not vibing and self._vibing:
            self._vibing = False
            self._vibe_kind = None
            self.pantilt.set_ambient(None)
            self._rest_head()
            log.info("vibe: off")

        if not vibing:
            self._start_idle_motion()

        sensing = self.finder is not None and (self.presence.enabled or self.watch.enabled)
        if not sensing:
            if self._watch_release_at:
                self._watch_release_at = 0.0
            self._drop_camera()
            return 0.5 if self._vibing else None
        if self._watch_release_at and now > self._watch_release_at:
            self._watch_release_at = 0.0
            self._rest_head()
        if not self._rested and not self._vibing:
            self._rest_head()            # after boot the servos sit at 90/90: the desk, not a face
        elif (IDLE_GLANCE_S > 0 and self.presence.enabled and not self.presence.present and not self._vibing
              and now - self._idle_seen_at > IDLE_GLANCE_S and now - self._glance_at > IDLE_GLANCE_S):
            # Nobody seen for a while: the rest pose may simply be wrong for where they sit (the
            # nominal home looked at the ceiling light on this rig), so glance at a few other poses
            # in turn. The first face found teaches the head where to rest from then on.
            self._glance_at = now
            self._glance_idx = (self._glance_idx + 1) % len(IDLE_GLANCES)
            dp, dt = IDLE_GLANCES[self._glance_idx]
            rp, rt = self._rest_pose()
            self.pantilt.move(_clampf(rp + dp, *LIMITS["pan"]), _clampf(rt + dt, *track_tilt_range()), quiet=True, speed=THINK_SPEED_DPS * 2)
            self.pantilt.release(immediate=False)
        if not self._take_camera():
            return 5.0
        if now < self._settle_until:
            return 0.5
        frame = self.camera.grab_lores()
        if frame is None:
            return 1.0
        luma, cb, cr = frame
        det = self.finder.find(luma, cb, cr)
        with self._cv:
            self._last_detect = det
        credible = bool(det.get("found") and det.get("conf", 0.0) >= TRACK_CONF_ACQUIRE)
        if credible:
            self._idle_seen_at = now
            # Seen from a glance pose: that pose is where they are -- make it the rest pose.
            st = self.pantilt.state()
            pose = (int(st["target"]["pan"]), int(st["target"]["tilt"]))
            if self._glance_idx and pose != self._rest_pose():
                self._last_face_pose, self._last_face_at = pose, now
                self._save_head_state(pose)
                self._glance_idx = 0
        if self.presence.enabled and not self._vibing:   # a nodding head looks above the face; that is not "left"
            self._note_presence(self.presence.update(credible), now)
        if self.watch.enabled:
            small = luma[::4, ::4].astype(np.float32)
            motion = self.watch.step(small, now)
            if motion is not None:
                self._on_watch_motion(motion, credible, now)
            return WATCH_PERIOD_S
        return PRESENCE_PERIOD_S

    def _on_watch_motion(self, motion: dict, face: bool, now: float) -> None:
        kind = "face" if face else "motion"
        # Turn toward whatever moved: one proportional step from the current base pose.
        st = self.pantilt.state()
        pan = _clampf(st["target"]["pan"] + (motion["cx"] - 0.5) * TRACK_HFOV_DEG, *LIMITS["pan"])
        tilt = _clampf(st["target"]["tilt"] + (motion["cy"] - 0.5) * TRACK_VFOV_DEG, *LIMITS["tilt"])
        self.pantilt.move(pan, tilt, quiet=True)
        self._watch_release_at = now + WATCH_HOLD_S
        log.info("desk watch: %s (%.1f%% of the frame moved) -> looking at pan %d / tilt %d",
                 kind, motion["frac"] * 100, int(pan), int(tilt))
        threading.Thread(target=self._watch_capture_and_notify, args=(kind, motion["frac"]),
                         name="watch-event", daemon=True).start()

    def _watch_capture_and_notify(self, kind: str, frac: float) -> None:
        time.sleep(0.4)                                  # let the head arrive before the photo
        jpeg = None
        name = None
        try:
            jpeg = self.camera.snapshot()
            if self.captures is not None and self.captures.available:
                name = self.captures.save(jpeg, f"watch-{kind}")
        except Exception as exc:  # noqa: BLE001
            log.warning("desk watch: capture failed (%s)", exc)
        notified = False
        if self.watch.notify and self.notifier is not None and self.notifier.enabled:
            now = time.time()
            if now - self.watch.last_notify_at >= WATCH_NOTIFY_GAP_S:
                self.watch.last_notify_at = now
                what = "someone's face" if kind == "face" else "movement"
                notified = self.notifier.send(f"Desk watch: {what} at {time.strftime('%H:%M:%S')}"
                                              f" ({frac * 100:.0f}% of the frame moved).", photo=jpeg)
        self.watch.record(kind, name, frac, notified)

    # -- mechanical limits ------------------------------------------------------------------
    def calibrate(self, axes=("tilt", "pan"), explore: bool = False) -> dict:  # noqa: ANN001
        """Find the mechanical stops with the camera: step each axis toward its extreme and watch
        the picture; when two consecutive steps no longer move the image, the previous step was the
        last one the servo could actually make. Limits are set LIMITS_MARGIN inside that and saved.

        By default the sweep stays *inside the current limits* -- it can only ever narrow them. On
        this rig the tilt servo was ground against its bracket by a sweep that went looking for the
        stop beyond a limit that was already at it; `explore=True` is the only way to go past the
        current limits again, and is not something to do twice. Blocks for up to ~40 s; the
        attention machine and the vibe stand still meanwhile."""
        if np is None or not self.pantilt.available:
            raise RuntimeError("calibration needs numpy and the servos")
        self._calibrating = True
        results: dict = {}
        try:
            with self._cv:
                self._manual_until = time.monotonic() + 120.0
            self.pantilt.stop_gesture()
            self.pantilt.set_ambient(None)
            if not self._take_camera():
                raise RuntimeError("camera unavailable")
            time.sleep(max(0.0, self._settle_until - time.monotonic()) + 0.3)

            def thumb():
                for _ in range(3):
                    frame = self.camera.grab_lores()
                    if frame is not None:
                        return frame[0][::4, ::4].astype(np.float32)
                    time.sleep(0.1)
                return None

            def shift_between(a, b, axis: int) -> tuple[float, float, float]:
                """Pixel shift of b relative to a along `axis` (0 = rows, for tilt; 1 = columns, for
                pan) by 1-D profile cross-correlation, the mean absolute frame difference, and the
                profile contrast (a blank wall or ceiling has none, and then nothing can be told)."""
                pa = a.mean(axis=1 - axis) if axis == 0 else a.mean(axis=0)
                pb = b.mean(axis=1 - axis) if axis == 0 else b.mean(axis=0)
                pa = pa - pa.mean()
                pb = pb - pb.mean()
                contrast = float(min(pa.std(), pb.std()))
                n = len(pa)
                best, best_r = 0, -2.0
                for sh in range(-n // 3, n // 3 + 1):
                    if sh >= 0:
                        x, y = pa[sh:], pb[: n - sh]
                    else:
                        x, y = pa[: n + sh], pb[-sh:]
                    den = float(np.linalg.norm(x) * np.linalg.norm(y)) + 1e-6
                    r = float(np.dot(x, y)) / den
                    if r > best_r:
                        best_r, best = r, sh
                return float(best), float(np.abs(a - b).mean()), contrast

            # A 4 deg step should shift the thumbnail by ~6 px (60 rows over a 41 deg field, 80 columns
            # over 57 deg). Measured on this rig, the tilt servo pressed against the bracket still
            # "moves" 1-2 px a step as the camera flexes -- so a real step must move at least 2.5 px,
            # and frames without contrast are not evidence either way.
            step, dwell = 4, 0.45
            MOVED_PX, BLANK_STD = 2.5, 2.0
            for axis in axes:
                if axis not in ("pan", "tilt"):
                    continue
                nominal = {"pan": (10, 170), "tilt": (30, 150)}[axis] if explore else LIMITS[axis]
                found = {}
                for direction in (+1, -1):
                    # start from the middle of the allowed range, never from a pose outside it
                    centre = int((nominal[0] + nominal[1]) / 2)
                    pos = centre
                    start = (centre, int((LIMITS["tilt"][0] + LIMITS["tilt"][1]) / 2)) if axis == "pan" else (int((LIMITS["pan"][0] + LIMITS["pan"][1]) / 2), centre)
                    self.pantilt.move(pan=start[0], tilt=start[1], quiet=True, speed=120)
                    time.sleep(0.8)
                    prev = thumb()
                    trace = []
                    still = 0
                    last_moved = None
                    moved_steps = 0
                    while prev is not None:
                        nxt = pos + direction * step
                        if nxt < nominal[0] or nxt > nominal[1]:
                            break
                        pos = nxt
                        if axis == "pan":
                            self.pantilt.move(pan=pos, tilt=None, quiet=True, speed=120)
                        else:
                            self.pantilt.move(pan=None, tilt=pos, quiet=True, speed=120)
                        time.sleep(dwell)
                        cur = thumb()
                        if cur is None:
                            break
                        sh, mad, contrast = shift_between(prev, cur, 0 if axis == "tilt" else 1)
                        blank = contrast < BLANK_STD
                        moved = (not blank) and abs(sh) >= MOVED_PX
                        trace.append({"deg": pos, "shift_px": round(sh, 1), "mad": round(mad, 1),
                                      "contrast": round(contrast, 1), "moved": moved, "blank": blank})
                        if moved:
                            still = 0
                            moved_steps += 1
                            last_moved = pos
                        elif not blank:
                            still += 1
                            if still >= 2 and moved_steps >= 2:
                                break
                        prev = cur
                    if last_moved is None:
                        found[direction] = {"stop": None, "trace": trace}
                    else:
                        found[direction] = {"stop": last_moved, "trace": trace}
                    self.pantilt.move(pan=start[0], tilt=start[1], quiet=True, speed=120)
                    time.sleep(0.8)
                hi = found[+1]["stop"]
                lo = found[-1]["stop"]
                cur_lo, cur_hi = LIMITS[axis]
                new_lo = max(nominal[0], int(lo) + LIMITS_MARGIN) if lo is not None else cur_lo
                new_hi = min(nominal[1], int(hi) - LIMITS_MARGIN) if hi is not None else cur_hi
                # A sweep that ran to the end of its allowed range without stalling learned nothing
                # new about that end; keep the existing limit there rather than "widening" to it.
                if lo is not None and lo <= nominal[0]:
                    new_lo = cur_lo if not explore else new_lo
                if hi is not None and hi >= nominal[1]:
                    new_hi = cur_hi if not explore else new_hi
                if new_hi - new_lo >= 30:
                    LIMITS[axis] = (new_lo, new_hi)
                results[axis] = {"limits": [new_lo, new_hi], "stop_low": lo, "stop_high": hi,
                                 "trace_up": found[+1]["trace"], "trace_down": found[-1]["trace"]}
                log.info("calibration: %s stops at %s / %s -> limits %s", axis, lo, hi, LIMITS[axis])
            _save_limits({a: {"stop_low": r["stop_low"], "stop_high": r["stop_high"]} for a, r in results.items()})
            LIMITS_INFO.update({"source": "calibrated", "at": time.time()})
            # a learned rest pose outside the new range would put the head back on the stop
            lo, hi = track_tilt_range()
            if self._rest_saved:
                self._rest_saved = (int(_clampf(self._rest_saved[0], *LIMITS["pan"])), int(_clampf(self._rest_saved[1], lo, hi)))
                self._save_head_state(self._rest_saved)
            if self._last_face_pose:
                self._last_face_pose = (int(_clampf(self._last_face_pose[0], *LIMITS["pan"])), int(_clampf(self._last_face_pose[1], lo, hi)))
            self._sp = None
            self.pantilt.move(*self._rest_pose(), quiet=True, speed=120)
        finally:
            with self._cv:
                self._manual_until = 0.0
            self._rested = False
            self._calibrating = False
        return {"limits": {k: list(v) for k, v in LIMITS.items()}, "axes": results}

    def _follow(self, det: dict) -> None:
        """Proportional control on our own setpoint.

        The setpoint is deliberately *ours* and a float. Reading the servo's actual angle back as
        feedback oscillates: the glide lags the command, so the controller keeps re-adding an error
        that is already in flight.
        """
        now = time.monotonic()
        if now < self._manual_until:
            self._sp = None
            return
        # A gesture displaces the head on purpose; integrating the "error" it causes would fight
        # it. Freeze the setpoint until the gesture has returned the head to its base pose.
        if self.pantilt.gesture_active():
            return

        st = self.pantilt.state()
        if self._sp is None:
            self._sp = (float(st["target"]["pan"]), float(st["target"]["tilt"]))

        err_x = det["x"] - 0.5
        err_y = det["y"] - 0.5
        if abs(err_x) < TRACK_DEADZONE and abs(err_y) < TRACK_DEADZONE:
            self._last_face_pose = (int(round(self._sp[0])), int(round(self._sp[1])))
            self._last_face_at = now
            self._save_head_state(self._last_face_pose)
            return

        d_pan = _clampf(TRACK_GAIN * err_x * TRACK_HFOV_DEG, -TRACK_MAX_STEP_DEG, TRACK_MAX_STEP_DEG)
        d_tilt = _clampf(TRACK_GAIN * err_y * TRACK_VFOV_DEG, -TRACK_MAX_STEP_DEG, TRACK_MAX_STEP_DEG)
        pan = _clampf(self._sp[0] + d_pan, *LIMITS["pan"])
        tilt = _clampf(self._sp[1] + d_tilt, *track_tilt_range())   # head height, not desk height
        self._sp = (pan, tilt)
        self._last_face_pose = (int(round(pan)), int(round(tilt)))
        self._last_face_at = now
        self._aim(pan, tilt)

    def _step_think(self) -> None:
        now = time.monotonic()
        # Thinking is a pose, not a search, so the detector is off -- and the sensor with it: a long
        # tool run is exactly when Hermes wants the CPU. Camera's idle-stop grace means a short
        # think never actually stops the sensor.
        if self._holds_camera:
            self._drop_camera()
        if now - self._since > THINK_MAX_S:
            with self._cv:
                self._enter("park", now)
            return
        with self._cv:
            tool = self._think_pending_tool
            self._think_pending_tool = False
        if tool:
            # "Glances at its hands" -- visibly distinct from pondering, and it interrupts a beat.
            self.pantilt.play(GESTURE_INDEX["_tool_glance"], intensity=1.0)
            self._think_next = now + 0.3
            return
        if now < self._think_next or self.pantilt.gesture_active():
            return
        beat_no = self._think_beat
        self._think_beat += 1
        name = THINK_SEQUENCE[beat_no % len(THINK_SEQUENCE)]
        # Settle as it goes on, so a two-minute tool run reads as concentration rather than a
        # metronome; alternate cycles mirror so it never looks like a loop.
        amp = max(THINK_DECAY_FLOOR, THINK_DECAY ** (beat_no // 2))
        gesture = GESTURE_INDEX[name]
        if (beat_no // len(THINK_SEQUENCE)) % 2 and name in ("_think_a", "_think_b"):
            gesture = GESTURE_INDEX["_think_b" if name == "_think_a" else "_think_a"]
        player = self.pantilt.play(gesture, intensity=amp, speed=1.0)
        self._think_next = now + player.duration + random.uniform(*THINK_GAP_S)


# ----------------------------------------------------------------------------- HTTP

class BadRequest(ValueError):
    pass


class TtsError(RuntimeError):
    pass


def synthesize_speech(text: str) -> tuple[bytes, str, str]:
    """Run Hermes's own TTS tool so provider, voice and credentials stay centralized there."""
    if not os.path.isfile(HERMES_PYTHON) or not os.path.isdir(HERMES_AGENT_DIR):
        raise TtsError("Hermes TTS runtime is unavailable")

    env = os.environ.copy()
    env["HERMES_HOME"] = HERMES_HOME
    try:
        with TTS_LOCK:
            proc = subprocess.run(
                [HERMES_PYTHON, "-c", TTS_HELPER],
                input=text,
                capture_output=True,
                text=True,
                cwd=HERMES_AGENT_DIR,
                env=env,
                timeout=TTS_TIMEOUT_S,
            )
    except subprocess.TimeoutExpired as exc:
        raise TtsError("speech synthesis timed out") from exc
    except OSError as exc:
        raise TtsError(f"could not start Hermes TTS: {exc}") from exc

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "Hermes TTS failed").strip().splitlines()[-1]
        raise TtsError(detail[:300])

    try:
        result = json.loads(proc.stdout.strip().splitlines()[-1])
    except (IndexError, ValueError) as exc:
        raise TtsError("Hermes returned an invalid TTS response") from exc
    if not result.get("success"):
        raise TtsError(str(result.get("error") or "speech synthesis failed")[:300])

    file_path = result.get("file_path")
    if not isinstance(file_path, str) or not os.path.isfile(file_path):
        raise TtsError("Hermes did not produce an audio file")
    try:
        size = os.path.getsize(file_path)
        if size <= 0 or size > TTS_MAX_BYTES:
            raise TtsError("Hermes produced an invalid audio file")
        with open(file_path, "rb") as fh:
            audio = fh.read()
    finally:
        try:
            os.unlink(file_path)
        except OSError:
            pass

    ext = os.path.splitext(file_path)[1].lower()
    mime = {".ogg": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav", ".flac": "audio/flac"}.get(ext, "audio/mpeg")
    provider = str(result.get("provider") or "hermes")
    return audio, mime, provider


class BridgeServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, handler, stats: StatsSampler, camera: Camera, pantilt: PanTilt,
                 attention: Attention, presence: Presence, watch: DeskWatch, captures: Captures,
                 notifier: TelegramNotifier, music: MusicSense | None = None) -> None:
        super().__init__(addr, handler)
        self.stats = stats
        self.camera = camera
        self.pantilt = pantilt
        self.attention = attention
        self.presence = presence
        self.watch = watch
        self.captures = captures
        self.notifier = notifier
        self.music = music
        self.started_at = time.time()


class Handler(BaseHTTPRequestHandler):
    server_version = f"nova-bridge/{VERSION}"
    sys_version = ""
    timeout = 30            # a stream client that stops reading for 30 s is dropped
    server: BridgeServer    # type: ignore[assignment]

    QUIET_PATHS = {"/stats", "/health", "/attention", "/pantilt", "/status", "/presence", "/watch", "/vibe", "/vibe/trace", "/metronome"}   # polled -> DEBUG only
    DISCONNECT_ERRORS = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError)

    # -- plumbing ---------------------------------------------------------------------------
    def log_message(self, fmt, *args) -> None:     # noqa: ANN001 - silence the default access log
        log.debug("%s %s", self.address_string(), fmt % args)

    def log_error(self, fmt, *args) -> None:       # noqa: ANN001
        log.warning("%s %s", self.address_string(), fmt % args)

    def send_response(self, code, message=None) -> None:  # noqa: ANN001
        self._status = code
        super().send_response(code, message)

    def send_error(self, code, message=None, explain=None) -> None:  # noqa: ANN001 - JSON + CORS for protocol errors
        try:
            self._json(code, {"error": message or self.responses.get(code, ("error",))[0]})
        except OSError:
            pass

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def _json(self, status: int, obj) -> None:  # noqa: ANN001
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _audio(self, body: bytes, mime: str, provider: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-TTS-Provider", provider)
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError as exc:
            raise BadRequest("bad Content-Length") from exc
        raw = self.rfile.read(n) if n > 0 else b""
        if not raw.strip():
            return {}
        try:
            data = json.loads(raw)
        except ValueError as exc:
            raise BadRequest("invalid JSON body") from exc
        if not isinstance(data, dict):
            raise BadRequest("JSON object expected")
        return data

    @staticmethod
    def _number(value, name: str):  # noqa: ANN001
        if value is None:
            return None
        if isinstance(value, bool):
            raise BadRequest(f"{name} must be a number")
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            try:
                return float(value.strip())
            except ValueError:
                pass
        raise BadRequest(f"{name} must be a number")

    # -- dispatch ---------------------------------------------------------------------------
    def do_OPTIONS(self) -> None:
        self._status = None
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def _dispatch(self, method: str) -> None:
        self._status = None
        path = urlsplit(self.path).path.rstrip("/") or "/"
        t0 = time.monotonic()
        try:
            handler = self.ROUTES.get((method, path))
            if handler is None and method == "GET" and path.startswith("/captures/"):
                handler = Handler.h_capture_file
            if handler is None:
                if any(p == path for (_m, p) in self.ROUTES):
                    self._json(405, {"error": f"method {method} not allowed for {path}"})
                else:
                    self._json(404, {"error": f"no such endpoint: {path}"})
            else:
                handler(self)
        except BadRequest as exc:
            self._json(400, {"error": str(exc)})
        except self.DISCONNECT_ERRORS as exc:
            log.info("%s %s %s: client went away (%s)", self.address_string(), method, path, type(exc).__name__)
        except OSError as exc:
            log.info("%s %s %s: socket error (%s)", self.address_string(), method, path, exc)
        except Exception:  # noqa: BLE001
            log.exception("%s %s failed", method, path)
            try:
                self._json(500, {"error": "internal error"})
            except OSError:
                pass
        finally:
            level = logging.DEBUG if (path in self.QUIET_PATHS and method == "GET") else logging.INFO
            log.log(level, '%s "%s %s" %s %d ms', self.address_string(), method, self.path,
                    self._status if self._status is not None else "-", int((time.monotonic() - t0) * 1000))

    # -- endpoints --------------------------------------------------------------------------
    def h_index(self) -> None:
        self._json(200, {
            "service": "nova-bridge",
            "version": VERSION,
            "endpoints": sorted(f"{m} {p}" for (m, p) in self.ROUTES),
        })

    def h_health(self) -> None:
        cam = self.server.camera
        att = self.server.attention
        self._json(200, {
            "status": "ok",
            "camera": cam.available,
            "pantilt": self.server.pantilt.available,
            "attention": att.available,
            "gestures": self.server.pantilt.available,
            "face_detector": att.detector if att.available else None,
            "presence": self.server.presence.enabled and att.available,
            "watch": self.server.watch.enabled,
            "telegram": self.server.notifier.enabled,
            "captures": self.server.captures.available,
            "microphone": bool(self.server.music is not None and self.server.music.listening),
            "vibe": bool(att.available and self.server.music is not None and self.server.music.enabled),
            "hostname": socket.gethostname(),
            "version": VERSION,
            "camera_active": cam.running,
            "encoding": cam.encoding,
            "stream_clients": cam.encode_clients,
            "tracker_clients": cam.raw_clients,
            "attention_mode": att.state()["mode"],
            "uptime_s": int(time.time() - self.server.started_at),
        })

    def h_stats(self) -> None:
        self._json(200, self.server.stats.snapshot())

    def h_stream(self) -> None:
        camera = self.server.camera
        try:
            output, _cold = camera.acquire()
        except CameraError as exc:
            self._json(503, {"error": f"camera unavailable: {exc}"})
            return
        client = self.address_string()
        frames = 0
        try:
            self.send_response(200)
            self.send_header("Age", "0")
            self.send_header("Cache-Control", "no-cache, private")
            self.send_header("Pragma", "no-cache")
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=FRAME")
            self._cors()
            self.end_headers()
            log.info("stream client %s connected (%d active)", client, camera.clients)
            last_seq = -1
            while True:
                with output.condition:
                    if not output.condition.wait_for(
                        lambda: output.seq != last_seq and output.frame is not None, timeout=5.0
                    ):
                        log.warning("stream client %s: no frame for 5 s, closing", client)
                        break
                    frame, last_seq = output.frame, output.seq
                self.wfile.write(b"--FRAME\r\n")
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(frame)))
                self.end_headers()
                self.wfile.write(frame)
                self.wfile.write(b"\r\n")
                frames += 1
        finally:
            camera.release()
            log.info("stream client %s disconnected after %d frames (%d active)", client, frames, camera.clients)

    def h_snapshot(self) -> None:
        try:
            frame = self.server.camera.snapshot()
        except CameraError as exc:
            self._json(503, {"error": f"camera unavailable: {exc}"})
            return
        except TimeoutError:
            self._json(504, {"error": "no frame from camera"})
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(frame)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(frame)

    def h_tts(self) -> None:
        body = self._read_json()
        text = body.get("text")
        if not isinstance(text, str) or not text.strip():
            raise BadRequest('body must contain non-empty "text"')
        text = text.strip()
        if len(text) > TTS_MAX_CHARS:
            raise BadRequest(f"text must be {TTS_MAX_CHARS} characters or fewer")
        try:
            audio, mime, provider = synthesize_speech(text)
        except TtsError as exc:
            self._json(502, {"error": str(exc)})
            return
        log.info("tts synthesized %d chars via %s (%d bytes)", len(text), provider, len(audio))
        self._audio(audio, mime, provider)

    def _pantilt_or_503(self) -> PanTilt | None:
        pt = self.server.pantilt
        if not pt.available:
            self._json(503, {"error": "pantilt unavailable"})
            return None
        return pt

    def h_pantilt_get(self) -> None:
        pt = self._pantilt_or_503()
        if pt:
            self._json(200, pt.state())

    def h_pantilt_post(self) -> None:
        pt = self._pantilt_or_503()
        if not pt:
            return
        body = self._read_json()
        pan = self._number(body.get("pan"), "pan")
        tilt = self._number(body.get("tilt"), "tilt")
        if pan is None and tilt is None:
            raise BadRequest('body must contain "pan" and/or "tilt" (degrees)')
        speed = self._number(body.get("speed"), "speed")
        # A human is driving. Stand down for a few seconds rather than fighting them for the servos.
        self.server.attention.note_manual()
        p, t = pt.move(pan, tilt, speed=speed)
        self._json(200, {"ok": True, "pan": p, "tilt": t, "limits": pt.limits_json()})

    def h_pantilt_center(self) -> None:
        pt = self._pantilt_or_503()
        if not pt:
            return
        self.server.attention.note_manual()
        p, t = pt.center()
        self._json(200, {"ok": True, "pan": p, "tilt": t, "limits": pt.limits_json()})

    def h_pantilt_limits(self) -> None:
        self._json(200, {"ok": True, "limits": self.server.pantilt.limits_json(), "track_tilt": list(track_tilt_range()),
                         "info": LIMITS_INFO, "file": LIMITS_FILE})

    def h_pantilt_calibrate(self) -> None:
        pt = self._pantilt_or_503()
        if not pt:
            return
        body = self._read_json()
        axes = body.get("axes") or ["tilt", "pan"]
        if not isinstance(axes, list) or not all(a in ("pan", "tilt") for a in axes):
            raise BadRequest('"axes" must be a list of "pan" / "tilt"')
        explore = bool(body.get("explore", False))
        log.info("calibration: measuring %s stops with the camera (%s)", ", ".join(axes),
                 "exploring past the current limits" if explore else "within the current limits")
        try:
            result = self.server.attention.calibrate(tuple(axes), explore=explore)
        except RuntimeError as exc:
            self._json(503, {"error": str(exc)})
            return
        self._json(200, {"ok": True, **result, "track_tilt": list(track_tilt_range())})

    def h_pantilt_release(self) -> None:
        pt = self._pantilt_or_503()
        if not pt:
            return
        self.server.attention.note_manual()
        pt.release()
        st = pt.state()
        self._json(200, {"ok": True, "pan": st["pan"], "tilt": st["tilt"], "released": True,
                         "limits": pt.limits_json()})

    def h_gestures(self) -> None:
        self._json(200, {
            "ok": True,
            "available": self.server.pantilt.available,
            "gestures": [g.to_json() for g in GESTURES if g.public],
            "ambient": ["talk"],
        })

    def h_gesture_post(self) -> None:
        pt = self._pantilt_or_503()
        if not pt:
            return
        body = self._read_json()
        name = body.get("name") or body.get("gesture")
        if not isinstance(name, str) or not name.strip():
            raise BadRequest('body must contain "name"')
        gesture = find_gesture(name)
        if gesture is None or not gesture.public:
            self._json(404, {"error": f"unknown gesture: {name.strip()[:40]}",
                             "known": [g.name for g in GESTURES if g.public]})
            return
        intensity = self._number(body.get("intensity"), "intensity")
        speed = self._number(body.get("speed"), "speed")
        queue = bool(body.get("queue", False))
        att = self.server.attention
        with att._cv:
            if body.get("autonomous", False):
                now = time.monotonic()
                if (att._sleeping or att._calibrating or att._vibing or att.watch.enabled
                        or now < max(att._manual_until, att._lease_until, att._speak_until)
                        or pt.gesture_active() or pt.ambient_name not in (None, "idle")):
                    self._json(409, {"ok": False, "error": "head busy; autonomous gesture skipped"})
                    return
            att.note_gesture(gesture.name)
            if gesture.name == "fall_asleep":
                # Keep the whole nod arc inside the measured limits, away from the bracket.
                lo, hi = LIMITS["tilt"]
                pt.move(None, max(lo, hi - 4.0), speed=10.0)
            player = pt.play(gesture, intensity=intensity if intensity is not None else 1.0,
                             speed=speed if speed is not None else 1.0, queue=queue)
        log.info("gesture: %s (intensity %.2f, speed %.2f%s)", gesture.name, player.intensity, player.speed,
                 ", queued" if queue else "")
        self._json(200, {"ok": True, "name": gesture.name, "duration_s": round(player.duration, 2),
                         "queued": queue})

    def h_gesture_stop(self) -> None:
        pt = self._pantilt_or_503()
        if not pt:
            return
        pt.stop_gesture()
        self._json(200, {"ok": True, "stopped": True})

    def h_attention_get(self) -> None:
        self._json(200, self.server.attention.state())

    def h_attention_debug(self) -> None:
        att = self.server.attention
        finder = att.finder
        self._json(200, {
            "ok": True,
            "mode": att.state()["mode"],
            "detector": (finder.debug() if finder is not None else None) or {"note": "no frame sampled yet"},
        })

    def h_attention_post(self) -> None:
        att = self.server.attention
        if not att.available:
            self._json(503, {"error": att.error or "attention unavailable"})
            return
        body = self._read_json()
        mode = body.get("mode")
        if not isinstance(mode, str):
            raise BadRequest('body must contain "mode"')
        self._json(200, att.request(mode))

    # -- desk companion ---------------------------------------------------------------------
    def h_status(self) -> None:
        att = self.server.attention.state()
        pt = self.server.pantilt.state() if self.server.pantilt.available else {}
        self._json(200, {
            "ok": True,
            "presence": self.server.presence.state(),
            "watch": self.server.watch.state(with_events=False),
            "attention": {"mode": att["mode"], "locked": att["locked"], "speaking": att["speaking"],
                          "gesture": att["gesture"]},
            "head": {"pan": pt.get("pan"), "tilt": pt.get("tilt"), "released": pt.get("released"),
                     "ambient": pt.get("ambient")},
            "vibe": self.server.attention.vibe_state(),
            "metronome": self.server.attention.metronome_state(),
            "telegram": self.server.notifier.enabled,
            "time": int(time.time()),
        })

    def h_vibe_get(self) -> None:
        self._json(200, {"ok": True, **self.server.attention.vibe_state()})

    def h_vibe_post(self) -> None:
        global VIBE_AMPLITUDE, VIBE_OFFSET_S
        body = self._read_json()
        att = self.server.attention
        music = self.server.music
        if music is None or not music.available:
            self._json(503, {"error": "no microphone capture available on this Pi"})
            return
        if "enabled" in body:
            music.set_enabled(bool(body.get("enabled")))
            log.info("vibe %s", "enabled" if music.enabled else "disabled")
        if "force" in body:
            att.force_vibe(bool(body.get("force")))
            log.info("vibe %s", "forced on" if body.get("force") else "force cleared")
        amp = self._number(body.get("amplitude"), "amplitude")
        if amp is not None:
            VIBE_AMPLITUDE = _clampf(amp, 0.2, 2.0)
        off = self._number(body.get("offset_ms"), "offset_ms")
        if off is not None:
            VIBE_OFFSET_S = _clampf(off, -400.0, 400.0) / 1000.0
            log.info("vibe offset %+.0f ms (+ = the nod lands later)", VIBE_OFFSET_S * 1000)
        with att._cv:
            att._cv.notify()
        self._json(200, {"ok": True, **att.vibe_state(), "amplitude": VIBE_AMPLITUDE})

    def h_metronome_get(self) -> None:
        self._json(200, {"ok": True, **self.server.attention.metronome_state()})

    def h_metronome_post(self) -> None:
        """{"bpm": 100} starts (or retunes) the visual metronome; {"enabled": false} or bpm 0 stops it."""
        body = self._read_json()
        att = self.server.attention
        if not self.server.pantilt.available:
            self._json(503, {"error": "no pan-tilt head on this Pi"})
            return
        bpm = self._number(body.get("bpm"), "bpm")
        enabled = body.get("enabled", True)
        if not enabled or (bpm is not None and bpm <= 0):
            att.set_metronome(None)
            log.info("metronome: stopped")
        elif bpm is None:
            self._json(400, {"error": "bpm required"})
            return
        else:
            att.set_metronome(bpm)
            log.info("metronome: %.0f BPM", _clampf(bpm, *METRO_BPM_RANGE))
        self._json(200, {"ok": True, **att.metronome_state()})

    def h_vibe_trace(self) -> None:
        """The last ~15 s of commanded head pose, each tick with the beat clock then in force: does the
        nod bottom out on the beat?"""
        music = self.server.music
        period, anchor, _conf, _strength = music.clock.read() if music is not None else (0.5, 0.0, 0.0, 0.0)
        self._json(200, {"ok": True, "now": time.monotonic(), "period": period, "anchor": anchor,
                         "locked": bool(music is not None and music.locked), "active": bool(music is not None and music.active),
                         "lead_s": VIBE_LEAD_S, "offset_s": VIBE_OFFSET_S, "latency_s": VIBE_LATENCY_S,
                         "head": self.server.attention.pantilt.state(), "trace": self.server.attention.pantilt.trace()})

    def h_presence_get(self) -> None:
        self._json(200, {"ok": True, **self.server.presence.state()})

    def h_presence_post(self) -> None:
        body = self._read_json()
        if "enabled" in body:
            enabled = bool(body.get("enabled"))
            self.server.presence.enabled = enabled
            log.info("presence sensing %s", "enabled" if enabled else "disabled")
            with self.server.attention._cv:
                self.server.attention._cv.notify()
        self._json(200, {"ok": True, **self.server.presence.state()})

    def h_watch_get(self) -> None:
        self._json(200, {"ok": True, **self.server.watch.state(), "telegram": self.server.notifier.enabled})

    def h_watch_post(self) -> None:
        body = self._read_json()
        if "enabled" not in body and "notify" not in body:
            raise BadRequest('body must contain "enabled" and/or "notify"')
        watch = self.server.watch
        enabled = bool(body.get("enabled", watch.enabled))
        notify = body.get("notify")
        if not self.server.attention.available and enabled:
            self._json(503, {"error": "desk watch needs the camera and the face detector"})
            return
        watch.set(enabled, None if notify is None else bool(notify))
        log.info("desk watch %s (telegram %s)", "armed" if enabled else "disarmed",
                 "on" if watch.notify and self.server.notifier.enabled else "off")
        with self.server.attention._cv:
            self.server.attention._cv.notify()
        self._json(200, {"ok": True, **watch.state(with_events=False), "telegram": self.server.notifier.enabled})

    def h_capture_post(self) -> None:
        body = self._read_json()
        label = body.get("label") if isinstance(body.get("label"), str) else ""
        if not self.server.captures.available:
            self._json(503, {"error": "captures directory unavailable"})
            return
        try:
            jpeg = self.server.camera.snapshot()
        except CameraError as exc:
            self._json(503, {"error": f"camera unavailable: {exc}"})
            return
        except TimeoutError:
            self._json(504, {"error": "no frame from camera"})
            return
        name = self.server.captures.save(jpeg, label)
        log.info("capture saved: %s (%d bytes)", name, len(jpeg))
        sent = False
        if body.get("notify"):
            sent, _err = self.server.notifier.send_now(label or "Photo from the desk camera.", photo=jpeg)
        self._json(200, {"ok": True, "name": name, "url": f"/captures/{name}", "bytes": len(jpeg), "notified": sent})

    def h_captures_get(self) -> None:
        self._json(200, {"ok": True, "captures": self.server.captures.list()})

    def h_capture_file(self) -> None:
        name = urlsplit(self.path).path.rsplit("/", 1)[-1]
        data = self.server.captures.read(name)
        if data is None:
            self._json(404, {"error": "no such capture"})
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "private, max-age=86400")
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def h_notify_post(self) -> None:
        body = self._read_json()
        text = body.get("text")
        if not isinstance(text, str) or not text.strip():
            raise BadRequest('body must contain non-empty "text"')
        photo = None
        capture = body.get("capture")
        if isinstance(capture, str) and capture:
            photo = self.server.captures.read(capture)
            if photo is None:
                self._json(404, {"error": "no such capture"})
                return
        ok, err = self.server.notifier.send_now(text.strip()[:4000], photo=photo)
        self._json(200 if ok else 502, {"ok": ok, "sent": ok, "error": err, "telegram": self.server.notifier.enabled})

    ROUTES = {
        ("GET", "/"): h_index,
        ("GET", "/health"): h_health,
        ("GET", "/stats"): h_stats,
        ("GET", "/stream.mjpg"): h_stream,
        ("GET", "/snapshot.jpg"): h_snapshot,
        ("POST", "/tts"): h_tts,
        ("GET", "/pantilt"): h_pantilt_get,
        ("POST", "/pantilt"): h_pantilt_post,
        ("POST", "/pantilt/center"): h_pantilt_center,
        ("POST", "/pantilt/release"): h_pantilt_release,
        ("GET", "/pantilt/limits"): h_pantilt_limits,
        ("POST", "/pantilt/calibrate"): h_pantilt_calibrate,
        ("GET", "/gestures"): h_gestures,
        ("POST", "/gesture"): h_gesture_post,
        ("POST", "/gesture/stop"): h_gesture_stop,
        ("GET", "/attention"): h_attention_get,
        ("GET", "/attention/debug"): h_attention_debug,
        ("POST", "/attention"): h_attention_post,
        ("GET", "/status"): h_status,
        ("GET", "/presence"): h_presence_get,
        ("POST", "/presence"): h_presence_post,
        ("GET", "/watch"): h_watch_get,
        ("POST", "/watch"): h_watch_post,
        ("POST", "/capture"): h_capture_post,
        ("GET", "/captures"): h_captures_get,
        ("POST", "/notify"): h_notify_post,
        ("GET", "/vibe"): h_vibe_get,
        ("POST", "/vibe"): h_vibe_post,
        ("GET", "/vibe/trace"): h_vibe_trace,
        ("GET", "/metronome"): h_metronome_get,
        ("POST", "/metronome"): h_metronome_post,
    }


# ----------------------------------------------------------------------------- main

def main() -> int:
    log.info("nova-bridge %s starting (python %s, pid %d, cv2 %s)", VERSION, sys.version.split()[0], os.getpid(),
             getattr(cv2, "__version__", "absent"))
    log.info("head limits: pan %s tilt %s (%s)", LIMITS["pan"], LIMITS["tilt"], LIMITS_INFO.get("source"))
    stats = StatsSampler()
    stats.start()
    camera = Camera()
    pantilt = PanTilt()
    presence = Presence(PRESENCE_ENABLED)
    watch = DeskWatch()
    captures = Captures(CAPTURES_DIR)
    notifier = TelegramNotifier()
    music = MusicSense(BeatClock()) if np is not None else None
    if music is not None and music.available and pantilt.available:
        music.start()
    elif music is not None:
        log.info("music sense: %s", "no capture command (pw-record/arecord) found" if not music.available else "no servos, not started")
    attention = Attention(camera, pantilt, presence=presence, watch=watch, captures=captures, notifier=notifier, music=music)
    if attention.available:
        attention.start()
    else:
        log.warning("attention/face tracking disabled: %s", attention.error or "pan-tilt unavailable")

    try:
        server = BridgeServer((HOST, PORT), Handler, stats, camera, pantilt, attention, presence, watch, captures, notifier, music)
    except OSError as exc:
        log.error("cannot bind %s:%d: %s", HOST, PORT, exc)
        attention.stop()
        pantilt.close()
        return 1

    def _on_signal(signum, _frame) -> None:  # noqa: ANN001
        log.info("received %s, shutting down", signal.Signals(signum).name)
        threading.Thread(target=server.shutdown, name="shutdown", daemon=True).start()

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    log.info("listening on http://%s:%d  camera=%s pantilt=%s attention=%s detector=%s gestures=%d presence=%s telegram=%s",
             HOST, PORT, camera.available, pantilt.available, attention.available, attention.detector,
             sum(1 for g in GESTURES if g.public), presence.enabled, notifier.enabled)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        # The attention thread captures frames and drives servos, so it must be joined *before* the
        # camera is closed and the I2C bus goes away underneath it.
        attention.stop()
        if music is not None:
            music.stop()
        camera.shutdown()
        pantilt.close()
        log.info("nova-bridge stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
