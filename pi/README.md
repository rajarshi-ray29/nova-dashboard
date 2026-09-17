# NOVA bridge (Raspberry Pi side)

`nova_bridge.py` is a small HTTP service that runs beside the NOVA dashboard on the Raspberry Pi 5.
It provides Pi system stats, the camera as an MJPEG stream, pan-tilt control, face tracking, a
gesture/emote engine for the head, presence sensing, a desk watch, photos, Telegram notifications,
and speech synthesized through Hermes's configured TTS provider. It runs from its own venv
(`~/nova-bridge/venv`, created with `--system-site-packages` by `deploy.sh`) so that OpenCV can be
pip-installed without sudo on top of the Debian picamera2, numpy and smbus2; Hermes's venv is
invoked only for a `/tts` request.

It listens on `0.0.0.0:8433` and every response carries `Access-Control-Allow-Origin: *`
(`OPTIONS` preflights are answered too), so browsers and the Mac server can hit it directly.

| Method | Path                | What it does |
|--------|---------------------|--------------|
| GET    | `/health`           | `{"status":"ok","camera":true,"pantilt":true,"attention":true,"hostname":"raspberrypi","version":"1.2", ...}` -- `camera` = picamera2 imported and a camera was detected, `pantilt` = the PCA9685 answered on I2C, `attention` = numpy is present and the servos work, so face tracking can run. Extras: `camera_active`, `encoding`, `stream_clients`, `tracker_clients`, `attention_mode`, `uptime_s`. |
| GET    | `/stats`            | `hostname, cpu_percent, cpu_per_core[], ncpu, mem{total,used,available,percent}, disk{total,used,percent}, temp_c, load[l1,l5,l15], uptime_s, cpu_freq_mhz, throttled` (bytes for mem/disk; `throttled` is the `vcgencmd get_throttled` hex string or `null`). CPU comes from `/proc/stat` deltas sampled every 2 s by a background thread. |
| GET    | `/stream.mjpg`      | `multipart/x-mixed-replace; boundary=FRAME`, 640x480, ~15 fps, JPEG q=80, hflip+vflip (the module is mounted upside down). The camera starts on the first client and stops ~5 s after the last one disconnects. |
| GET    | `/snapshot.jpg`     | One JPEG. If the stream is running it is the latest frame; otherwise the camera is started, a few frames are skipped so exposure settles, one frame is returned, and the camera is stopped again. |
| GET    | `/pantilt`          | `{"ok":true,"pan":90,"tilt":90,"limits":{"pan":[10,170],"tilt":[30,150]}}` plus `base` (where the head looks), `target`, `offset` (gesture + ambient), `moving`, `released`, `gesture`, `queued`, `ambient`. |
| POST   | `/pantilt`          | Body `{"pan":100,"tilt":80,"speed":200}` (`pan`/`tilt` either optional, `speed` in deg/s optional). Angles are clamped to the limits and the base pose glides there; a newer command retargets the glide. Responds immediately with the target angles. |
| GET    | `/gestures`         | The emote vocabulary: `{"gestures":[{"name","aliases","description","duration_s"}, ...]}`. |
| POST   | `/gesture`          | Body `{"name":"nod","intensity":1.0,"speed":1.0,"queue":false}`. Plays a gesture as an offset layer over the base pose (the head keeps looking at you through a nod). Aliases work (`yes`, `no`, `hello`, `bye`, ...). `queue:true` appends instead of replacing. `404` with the known names for an unknown gesture. |
| POST   | `/gesture/stop`     | Cancel the current gesture and the queue; the head settles back on its base pose. |
| GET    | `/status`           | One poll for the dashboard: `presence`, `watch` (without the event list), `attention` (`mode`, `locked`, `speaking`, `gesture`), `head`, `telegram`. |
| GET/POST | `/presence`       | Presence state (`present`, `since`, `last_seen`, `at_desk_s`, `away_s`, `arrivals`, `events`); `POST {"enabled": bool}` switches the idle face check. |
| GET/POST | `/watch`          | Desk watch state and events (`{"id","at","kind":"motion"\|"face","capture","area","notified"}`); `POST {"enabled": bool, "notify": bool}` arms/disarms and sets whether events go to Telegram. |
| POST   | `/capture`          | `{"label": "...", "notify": false}` -> take a photo, save it under `~/nova-captures` (`NOVA_CAPTURES_DIR`), return `{"name","url","bytes","notified"}`. `notify:true` also sends it to Telegram. |
| GET    | `/captures`, `/captures/<name>` | List saved photos (newest first, 50) / serve one. |
| POST   | `/notify`           | `{"text": "...", "capture": "<name>"}` -> Telegram message (with the photo when a capture is named) through Nova's own bot; `502` when Telegram is not configured or refuses. |
| GET/POST | `/vibe`           | Music sensing: `available`, `enabled`, `listening`, `device`, `active`, `locked`, `bpm`, `candidate_bpm`, `score`, `score_now`, `coherence`, `phase_err_ms`, `parity_flips`, `relocks`, `level_db`, `level_gate_db`, `strength`, `next_beat_in_s`, `latency_ms`, `lead_ms`, `offset_ms`, `vibing`, `forced`. `POST {"enabled": bool, "force": bool, "amplitude": 0.2-2, "offset_ms": -400..400}`. |
| GET/POST | `/metronome`      | The head as a visual metronome: `GET` -> `enabled`, `bpm`, `running`, `remaining_s`; `POST {"bpm": 100}` nods on every beat of a fixed clock (30-240 BPM, up to `NOVA_METRONOME_MAX` = 3600 s; it takes precedence over music and silences the music sensor while it runs); `POST {"enabled": false}` stops. |
| GET    | `/vibe/trace`       | The last 15 s of commanded head pose at 40 Hz, each row `[t, pan, tilt, beat_period, beat_anchor, nod_phase, nod_depth]` with the beat clock in force at that tick (monotonic seconds; `nod_phase` is the vibe's local oscillator, 0 = the bottom), plus the lead/offset/latency in force: is the nod bottoming out on the beat? |
| POST   | `/pantilt/center`   | Glide to 90/90. |
| POST   | `/pantilt/release`  | Stop the servo pulses (PWM off, no holding torque). |
| GET    | `/pantilt/limits`   | The logical-degree limits in force (`head_limits.json` next to the script, or `NOVA_PAN_MIN/MAX`, `NOVA_TILT_MIN/MAX`), the tracker's tilt range, and where they came from. |
| POST   | `/pantilt/calibrate` | `{"axes": ["tilt","pan"], "explore": false}`: step each axis 4 deg at a time while watching the camera; two steps that no longer move the picture (>= 2.5 px on the thumbnail; blank frames do not count) mark the stop, and the limit is set 4 deg inside it and saved. **Stays inside the current limits unless `explore` is true** -- see the warning below. Blocks ~40 s. |
| GET    | `/attention`        | `{"mode","locked","detect",...}` -- what the head is doing and what the detector last saw. `mode` is one of `off`, `search`, `track`, `park`, `think`. |
| POST   | `/attention`        | Body `{"mode":"wake"}` (or `speak`, `think`, `tool`, `sleep`). Publishes *intent*; the Pi runs the loop. Each call also renews a 12 s lease. `speak` keeps tracking and layers the ambient "talking" motion on top. |
| GET    | `/attention/debug`  | What the detector last saw, as ASCII: with the Haar detector a shaded luma thumbnail with `#` boxes around detections (`faces`, `cost_ms`); with the skin fallback the mask plus Cr/Cb percentiles. Rendered on demand (never in the per-frame path). |
| POST   | `/tts`              | Body `{"text":"..."}` → audio bytes from Hermes's selected provider. The response includes `X-TTS-Provider`; synthesis is serialized and temporary files are removed after reading. |

Errors are JSON `{"error":"..."}`: `400` bad body, `404`/`405` routing, `503` when the camera or
the PCA9685 is unavailable (`{"error":"pantilt unavailable"}`), `504` if the camera produced no frame.

At startup the servos are driven to 90/90 and released one second later.

## The motion model (v2)

One 40 Hz loop owns the servos and sums three layers into the pose it writes (one auto-increment
I2C block write per change, nothing written while nothing moves):

| layer | set by | what it is |
|---|---|---|
| **base** | tracker, d-pad, parking | where the head *looks*; glides to its target at a per-command speed (200 deg/s for nudges and tracking, 22 deg/s for thinking beats) |
| **gesture** | `POST /gesture`, the attention machine | a keyframed script of offsets around the base pose, ease-in-out between keys; replaces or queues |
| **ambient** | `{"mode":"speak"}` | procedural "talking" motion: slow sum-of-sines drift (about 2 deg) plus a micro-nod every few seconds, ramped in and out over 0.6 s |

Because gestures are offsets the head keeps facing you through a nod; the tracker just pauses its
integration while a gesture plays. Offsets are logical degrees: `+pan` is the head's own right,
`+tilt` looks down. The vocabulary lives in `GESTURES` at the top of the file -- add one line to
add an emote (`(d_pan, d_tilt, seconds[, hold])` segments); it is exported by `/gestures`, so the
dashboard's chips and the model's cue list pick it up. `sleepy` ends with `settle="release"`: the
head sags and the servos power down. A release can also be deferred until the base glide has
finished (`release(immediate=False)`), which is how the idle head parks at head height first.

## Face tracking and the attention machine

When the dashboard hears the wake word it POSTs `{"mode":"wake"}`. The Pi then, in order: glides the
head to **pan 90 / tilt 55** immediately (the visible "she heard you" beat -- note that the servos'
own centre, tilt 90, points at the *desk*, not at a seated person), brings up the camera, and looks
for a face. Finding one it tracks it. Finding nothing straight ahead within 2.5 s it **scans**: 32
deg to the left, then to the right, then 24 deg lower, then 15 deg higher, then back (about 14 s in
all, detector running throughout), and only then parks where it started. The tracker may aim
anywhere in tilt 30-110 (`NOVA_TRACK_TILT_MIN/MAX`): on this rig a seated face sits near tilt 85-90
while the nominal home (55) looks at the ceiling light above it. Where a face was last settled on is
written to `head_state.json` next to the script and reused for a day as the search start and the
idle rest pose, so the head learns where you sit. While nobody has been seen for `NOVA_IDLE_GLANCE`
(90 s) the idle head glances at a few other poses in turn (lower, left, right, higher); the first
face found from a glance pose makes that the rest pose. `{"mode":"speak"}` keeps tracking and adds the talking motion.
`{"mode":"think"}` switches the detector off and plays thinking beats (look up and away, a still
"with you" glance, a small nod, the other way) with decaying amplitude; `{"mode":"tool"}` splices in
one distinct downward "glances at its hands" beat. `{"mode":"sleep"}` parks and, shortly after,
relaxes the servos -- at head height, so the idle presence check below still sees a face.

Modes internally: `off` -> `search` -> `track` / `park`, with `think` orthogonal to all of them.

**The detector** is OpenCV's Haar cascade on the luma plane of a second 320x240 `lores` camera
stream: the frontal cascade every frame, and (since the profile cascade only knows one side) a
profile pass on the frame and on its mirror -- every frame while a lock is held, every third
frontal miss otherwise, because the two profile passes cost 37-57 ms against 6-9 ms for the frontal
one. Detections are scored on size and on closeness to the last lock, so a passer-by does not
steal the head. Confidence is 1.0 (frontal) or 0.75 (profile) scaled down for faces narrower than
9% of the frame. A search starts at the last face pose if it is under ten minutes old, else at
home -- the old detector once locked onto a ceiling light at tilt 35 and every later search began
by staring at the ceiling.

If OpenCV is not importable (`face_detector: "skin"` in `/health`) the old skin-chroma blob finder
runs instead; it works but cannot tell a face from a forearm by colour and is fooled by warm
walls. `NOVA_FACE_DETECTOR=skin` forces it.

## The desk companion: presence, desk watch, photos, Telegram

While the attention machine is `off` (nobody is talking to Nova) the same thread keeps a quiet
eye on the desk. With **presence** on (`NOVA_PRESENCE`, default on; the dashboard toggles it with
`POST /presence`) it holds the sensor and runs one face check every `NOVA_PRESENCE_PERIOD` (3 s).
Two consecutive detections after an absence of `NOVA_PRESENCE_AWAY` (180 s) is an **arrival**: the
head looks up, finds you and nods hello (`NOVA_GREET`, once per 20 min); no face for that long is
a **departure**. The dashboard reads `/status` every few seconds and does the talking. So that the
idle camera can see a face at all, the head always parks at head height (the last face pose, else
home) *before* the servos relax.

**Desk watch** (`POST /watch {"enabled": true}`) raises the idle cadence to 2 Hz and adds frame
differencing on a 60x80 luma thumbnail: when more than `NOVA_WATCH_FRAC` (1.2%) of the pixels
change by more than `NOVA_WATCH_DIFF` (28 levels) on two consecutive frames, that is an event --
the head turns toward the centroid of the movement (one proportional step through the same FOV
maths the tracker uses), holds there for 20 s, a JPEG is saved under `~/nova-captures`
(`watch-motion` / `watch-face` when the Haar detector also found a face), and, if `notify` is on
and the bot is configured, the photo goes to Telegram. Events are rate-limited (one per 20 s,
one Telegram message per 60 s). While you talk to her the normal search/track behaviour takes
over; the watch resumes when she goes idle again.

**Vibe.** `MusicSense` captures the USB microphone (`pw-record --rate 16000 --channels 1 --format
s16 --latency 30ms --raw -`, falling back to `arecord -D default`; `NOVA_MIC_CMD` overrides) in
10 ms hops, stamped from the sample counter (the pipe delivers a 30 ms quantum at a time, so
arrival times jitter; the least-buffered arrival fixes the clock's origin, which may creep slowly
in case the mic's crystal runs slow). Each hop: Hann-windowed 1024-point FFT, log band energies
over 32 log-spaced bands (60 Hz-7 kHz) plus 20 over the 300 Hz-3 kHz mids (measured here: a small
speaker's transients reach a cheap mic in the mids; bass weighting was the worst choice), spectral
flux = two onset envelopes at 100 frames/s. Every 250 ms:

- *tempo*: each envelope is detrended with a 0.4 s exponential running average (not a boxcar,
  whose sidelobe once stamped a fake 120 BPM onto white noise), rectified and centred; one FFT
  gives the normalised autocorrelation out to four times the longest beat period, the two tracks
  are averaged, and a **pairwise-minimum comb** -- min(r(T), r(2T)) + min(r(2T), r(3T)) +
  min(r(3T), r(4T)), weighted 1/0.8/0.6 -- scores each candidate period. The real beat has a peak
  at every multiple; a 3:2 or 4:3 impostor has one low tooth in each pair and is punished for it.
  (Before this, "Fix You" at 140 BPM read 93 for seconds at a time, and an 82 BPM song flipped
  between 109 and 164 every 20-60 s -- a plain sum of teeth, cut off at the 60 BPM lag, favours
  fast impostors for anything under 120 BPM.) A soft log-Gaussian prior (120 BPM, one octave)
  only breaks octave ties. The curve is averaged over time (tau 1.4 s) and its peak is the **beat
  score**.
- *the lock*: once the score passes `NOVA_VIBE_SCORE_ON` (0.10) for three updates the period is
  locked; later estimates are folded by octaves onto that level and blended in, and an estimate
  on another metrical level is ignored unless it persists for 6 s -- the bobbing rate never flips
  mid-song.
- *phase*: a phase-locked loop onto the **strongest onset cluster**. The last 4 s of onset energy
  (recency weighted) is laid on the beat grid as a 24-bin phase histogram; the circular mean of
  the cluster around its peak is the phase error, which pulls the anchor (gain 0.35, 0.6 while
  settling, a full jump at lock) and, second-order, the period. The grid stays with its own
  cluster unless another is 1.5x stronger for 1.5 s (then it jumps and holds for 8 s), so songs
  whose accents alternate do not flip it back and forth. A plain circular mean put the grid
  *between* a kick and a strong off-beat, on nothing: the onset energy under the nods was 0.7x
  the average on one song; the cluster loop gets 2.0-2.2x.
- *strong beats*: onset energy on even versus odd beats keeps the anchor on the accented beats,
  which is where the head nods when it nods every other beat.
- *gate*: score >= `NOVA_VIBE_SCORE_ON` with the level above `NOVA_VIBE_MIN_DB` (-50 dBFS) and six
  seconds of envelope in hand -> music; score under `NOVA_VIBE_SCORE_OFF` (0.065) for
  `NOVA_VIBE_OFF_S` (4 s), the level 12 dB under where it started for 6 s, under the floor for
  4 s, or **no beat while the head was still** (below) -> stopped. (The old vote-based gate
  cycled on and off every 10-70 s on the same song because its confidence sat at the threshold.)

**The microphone hears the servos.** It sits inches from them, and a nodding head is a beat all
by itself: a 100 BPM metronome in a silent room scored 0.30 -- more than real music -- and the
first version of this tracker, told to stop the metronome, kept the head nodding to its own
noise. The servo transients land ~150 ms before and ~100 ms after each nod bottom, 3-5x the
mean above 1.2 kHz, 2-3x in 200 Hz-1.2 kHz, nearly nothing under 200 Hz; the bottom of the nod
itself is quiet. Masking those windows does not work (a mask that repeats at the nod period is
itself a periodic signal, and the tempogram locks onto it). What works is physics: the head
records when its servos were last driven (`quiet_intervals`), `AmbientVibe` takes a
**listening break** -- a bar of stillness, at the top of a nod -- every 8-12 bars and as soon as
the tracker asks (it asks when the level has fallen 6 dB, i.e. the music may have stopped), and
the gate only trusts beat evidence from frames recorded while nothing drove the servos: during
those breaks, and before the vibe starts. If the on-beat onset energy in the still-head frames
is under 1.15x the average, four updates in a row, the beat was the head and the vibe stops.
While the metronome runs the sensor is suppressed outright and starts from scratch when it
stops. The best fix is still mechanical: a USB extension that puts the mic a hand's width or
more from the servos, pointed at the speaker.

**Measured on this rig** (2026-09-13; music from a small speaker at -40..-44 dBFS at the mic; the
numbers the thresholds come from): score medians 0.15-0.26 with post-lock minima 0.08-0.13 across
three songs; white noise, the room floor (-50 dBFS with the head still) and speech at the same
level stay under 0.09 (95th percentile under 0.07); only time-shuffled music, which carries a
genuine periodicity artefact, passes. Beat phase against a best-fit grid over 50 s of "Fix You":
median error ~10 ms, 90th percentile ~25 ms; live, the nod oscillator sits within 10 ms of the
tracker's grid and the commanded bottoms land 55-70 ms ahead of the beat, which is the servo's
share. It locks 6-9 s into a song. `python3 pi/tools/vibe_replay.py mic.raw` replays a capture
through the tracker offline (the docstring says how to record one) -- tune against a recording
before touching the robot.

While music plays and the attention machine is idle, `AmbientVibe` runs as the ambient layer. Tilt
carries the nod: a 0.2 s drop that bottoms out *on the beat* (downward -- rising tilt pitches the
camera down), `NOVA_VIBE_NOD` = 15 deg deep at amplitude 1 (the dashboard's "Vibe intensity"
scales it 0.6/1/1.5), then a slower recovery and a pause at the top; on every beat at relaxed
tempos and every other beat above ~130 BPM (a 140 BPM song gets 70 nods a minute, not 140
twitches), with a light accent pattern. Pan carries a slow move -- a two-bar sway
(`NOVA_VIBE_SWAY` = 12 deg), a small groove wiggle, a slow gaze around, or stillness -- changed
every couple of bars and cross-faded over a bar; a `tilt`/`shake` flourish every eight bars or so.
The nod phase is a local oscillator that slews toward the tracker's clock, so a phase or parity
correction upstream never snaps the servo: the head drifts onto the beat over a second or two,
like someone catching the groove. All of it scales with loudness, beat score and
`NOVA_VIBE_AMPLITUDE`, ramps in and out over 0.8 s and is low-passed at 35 ms. The base pose while
vibing is the rest pose raised by the nod depth + 3 deg, so the drop never reaches the mechanical
tilt limit (the previous 6 deg nod was clipped to 4 deg there).

**Metronome.** `POST /metronome {"bpm": 100}` drives the same nod from a fixed clock: every beat,
no pan moves, no flourishes, no listening breaks, a shallower nod above ~140 BPM so the servo can
follow, and the nod bottom lands on the tick (the same lead/offset as the vibe applies). It takes
precedence over music and suppresses the music sensor while it runs (which would otherwise lock
onto the head); it stops on `{"enabled": false}` or after `NOVA_METRONOME_MAX` (3600 s), and the
music sensor then starts from scratch. Live: 100 BPM gave nods every 600 ms with the oscillator
0 ms from the grid. The dashboard's **Groove** panel (left column) has the vibe on/off switch in
its header, a mode dropdown (Vibe to music / Metronome), the BPM field and Play/Stop.

**Timing.** The nod is commanded `NOVA_VIBE_LEAD` (90 ms: 35 ms low-pass + I2C tick + servo lag)
early and the grid is shifted back by `NOVA_VIBE_LATENCY` (45 ms: pw-record's quantum + USB), so
the *camera* should bottom out as the beat is heard. Trim by ear without redeploying:
`curl -X POST localhost:8433/vibe -H 'content-type: application/json' -d '{"offset_ms": 40}'`
makes every nod land 40 ms later (negative = earlier; `NOVA_VIBE_OFFSET_MS` in the unit makes it
stick). `GET /vibe/trace` returns the last 15 s of commanded pose plus the beat grid, so the
bottoms can be checked against the beats numerically. Saying the wake word takes the head away
from the music; it resumes when the conversation ends. `POST /vibe {"force": true}` vibes without
music (free-running at the last tempo, else 120 BPM) for up to `NOVA_VIBE_FORCE_MAX` (600 s).

**Telegram** credentials come from `NOVA_TELEGRAM_TOKEN` / `NOVA_TELEGRAM_CHAT`, else from Hermes's
own `~/.hermes/.env` (`TELEGRAM_BOT_TOKEN`, first id in `TELEGRAM_ALLOWED_USERS`), so nothing has
to be configured twice; `NOVA_TELEGRAM_NOTIFY=0` disables it. Sends run on a worker thread.

**Cost, measured on this rig** (Hermes runs on the same Pi):

| state | CPU |
|---|---|
| idle, presence sensing off | 0% -- no camera, no thread work, servos released |
| idle, presence sensing on (one Haar pass every 3 s) | ~3-4% of one core, almost all of it the sensor and ISP being on |
| desk watch armed (2 Hz differencing + Haar) | ~8% of one core |
| searching an empty room (Haar at 4 Hz, profile passes throttled) | ~8% of one core |
| tracking a face (frontal hits, no profile passes) | ~5% of one core |
| thinking / speaking | ~0-1% -- the detector and the sensor are off; the motion loop only runs while something moves |
| music sensing (always on while enabled) | ~2% for the maths (100 FFTs/s + a tempogram every 250 ms) plus the `pw-record` client |

The JPEG encoder is **not** attached for the tracker or the watch: it is a software encoder
costing a further 3.8% of a core, and neither looks at a JPEG. `Camera` counts *encode* clients
(the MJPEG stream, snapshots, captures) separately from *raw* clients (the tracker), and only
attaches the encoder when something actually wants pictures.

**Tuning.** Knobs are environment variables on the unit -- `NOVA_HAAR_SCALE`, `NOVA_HAAR_NEIGHBORS`,
`NOVA_HAAR_MIN_PX`, `NOVA_HAAR_PROFILE=0`, `NOVA_HAAR_PROFILE_EVERY`, `NOVA_TRACK_GAIN`,
`NOVA_TRACK_TILT_MIN/MAX`, `NOVA_HOME_PAN/TILT`, `NOVA_TRACK_HZ`, `NOVA_SEARCH_SCAN`,
`NOVA_TALK_AMPLITUDE`, `NOVA_PRESENCE*`, `NOVA_WATCH*` and friends. Look at `GET /attention/debug`
while she is searching.

## Deploy / redeploy (from the Mac)

```sh
pi/deploy.sh
```

This scp's `nova_bridge.py` to `/home/rajarshi/nova-bridge/` and `nova-bridge.service` to
`~/.config/systemd/user/`, byte-compiles the script with the Pi's `python3` as a syntax check, runs
`systemctl --user daemon-reload && systemctl --user enable --now nova-bridge`, restarts the unit so
new code takes effect, and finally curls `http://raspberrypi.local:8433/health` from the Mac.
Override the target with `PI_HOST=user@host` / `PI_DIR=/path` if needed. ssh key auth must work
(`BatchMode=yes`); nothing needs sudo. `loginctl` linger is enabled on the Pi, so the user service
starts at boot without a login session.

Run it again any time you change `nova_bridge.py` or the unit -- it is idempotent.

Deploy the dashboard itself with `pi/deploy-dashboard.sh`. It uses Hermes's bundled Node runtime,
installs `nova-dashboard.service`, and serves the complete UI at `http://raspberrypi.local:8420/`.

## Operating it

```sh
ssh rajarshi@raspberrypi.local systemctl --user status nova-bridge          # is it running? (+ last log lines)
ssh rajarshi@raspberrypi.local journalctl --user-unit nova-bridge -f        # follow logs
ssh rajarshi@raspberrypi.local journalctl --user-unit nova-bridge -n 100    # last 100 lines
ssh rajarshi@raspberrypi.local systemctl --user restart nova-bridge
ssh rajarshi@raspberrypi.local systemctl --user disable --now nova-bridge   # stop + don't start at boot
```

Note the `--user-unit` spelling: on this Pi `journalctl --user -u nova-bridge` prints "No journal files
were found" because journald keeps no per-user journal files there; `--user-unit` (or
`journalctl _SYSTEMD_USER_UNIT=nova-bridge.service`) reads the same entries from the system journal,
which the `rajarshi` account can see via the `adm` group.

Quick checks from the Mac:

```sh
curl -s http://raspberrypi.local:8433/health
curl -s http://raspberrypi.local:8433/stats | python3 -m json.tool
curl -s -o snap.jpg http://raspberrypi.local:8433/snapshot.jpg && open snap.jpg
curl -s -m 4 http://raspberrypi.local:8433/stream.mjpg | head -c 200000 | grep -ac -- --FRAME   # ~9 (one frame ~20-45 KB)
curl -s -X POST -H 'Content-Type: application/json' -d '{"pan":100,"tilt":80}' http://raspberrypi.local:8433/pantilt
curl -s -X POST http://raspberrypi.local:8433/pantilt/center
curl -s -X POST http://raspberrypi.local:8433/pantilt/release
curl -s http://raspberrypi.local:8433/gestures
curl -s -X POST -H 'Content-Type: application/json' -d '{"name":"nod"}' http://raspberrypi.local:8433/gesture
curl -s -X POST -H 'Content-Type: application/json' -d '{"mode":"speak"}' http://raspberrypi.local:8433/attention
curl -s http://raspberrypi.local:8433/status
curl -s -X POST -H 'Content-Type: application/json' -d '{"enabled":true,"notify":false}' http://raspberrypi.local:8433/watch
curl -s -X POST -H 'Content-Type: application/json' -d '{"label":"test"}' http://raspberrypi.local:8433/capture
curl -s -o nova-test.mp3 -H 'Content-Type: application/json' -d '{"text":"Nova is ready."}' http://raspberrypi.local:8433/tts
```

Running it by hand (for debugging; stop the service first so the camera and port are free):

```sh
ssh rajarshi@raspberrypi.local
systemctl --user stop nova-bridge
NOVA_BRIDGE_LOGLEVEL=DEBUG ~/nova-bridge/venv/bin/python ~/nova-bridge/nova_bridge.py     # Ctrl-C to quit
systemctl --user start nova-bridge
```

Environment knobs (set in the unit's `Environment=` lines or the shell): `NOVA_BRIDGE_HOST`
(default `0.0.0.0`), `NOVA_BRIDGE_PORT` (default `8433`), `NOVA_BRIDGE_LOGLEVEL` (default `INFO`;
`/stats` and `/health` requests are only logged at `DEBUG` because the dashboard polls them constantly),
plus `HERMES_HOME`, `HERMES_AGENT_DIR`, and `HERMES_PYTHON` for the TTS runtime.

## Limits and notes

- **No auth, plain HTTP, LAN only.** Anyone on the network can view the camera and move the servos.
  The Mac dashboard server binds to `127.0.0.1` and proxies; keep the Pi off untrusted networks.
- **One camera, in-process.** picamera2 owns the sensor while the stream is running, so `rpicam-*`
  tools fail with "busy" until ~5 s after the last stream client leaves (and immediately after a
  cold snapshot). Conversely, if something else holds the camera, `/stream.mjpg` and
  `/snapshot.jpg` return `503 camera unavailable`.
- **Stream is software-encoded** (Pi 5 has no hardware JPEG encoder). 640x480 @ 15 fps costs a few
  percent of one core per client; every client shares the same frames, so extra viewers are cheap.
  A client that stops reading for 30 s is dropped. If the camera delivers no frame for 5 s the
  stream ends and the client should reconnect.
- **Orientation is baked in**: `Transform(hflip=1, vflip=1)` because the module hangs upside down on
  the bracket. Remount the camera -> edit `CAMERA_TRANSFORM` at the top of `nova_bridge.py`.
- **Snapshot on a cold camera takes ~1-2 s** (camera init + 8 warm-up frames for exposure).
- **Cold-start hiccup handling**: libcamera occasionally logs `Camera frontend has timed out!` right
  after a start and then never delivers a frame (seen once on this rig; it suggests checking the
  ribbon cable). The bridge waits up to 4 s for the first frame and stops/retries the start up to
  3 times before answering `503`, so a single hiccup costs a few seconds instead of a dead stream.
  If it happens every time, reseat the camera cable.
- **Pan-tilt state is dead-reckoned**: the servos have no feedback, so `pan`/`tilt` are the last
  angles written. After `/pantilt/release` the arm can be nudged by hand; the next move first
  re-asserts the last known angle and glides from there.
- **The mechanical tilt range is much smaller than the servo's.** On this rig the camera meets the
  bracket at roughly tilt 100: from 90 to 98 the picture still moved, beyond that the servo
  only flexed the mount by a pixel or two per step -- and driving it there **grinds the gears**
  (2026-09-13: two calibration sweeps that went looking for the stop did exactly that). The limits
  are therefore held in `head_limits.json` as `pan 14-166`, `tilt 32-96` (the servo was checked
  afterwards and moves freely), the tracker stops at 92, the vibe raises its base pose by the nod depth + 3 deg
  so the (downward) nod never reaches the limit, and every
  other motion source (gestures, glances, desk-watch turns, the d-pad) is clamped to the same
  numbers. `/pantilt/calibrate` can only narrow these unless `"explore": true` is passed; do not
  explore tilt again unless the bracket changes.
- **I2C must be enabled** (`dtparam=i2c_arm=on`); it is on this Pi. If the PCA9685 is missing at
  startup, `/health` reports `pantilt:false` and the pan-tilt endpoints answer 503 -- restart the
  service after fixing the wiring.
- **The `lores` plane order is I420** -- Y, then Cb (U), then Cr (V) -- and the rows are
  stride-padded (320 wide arrives as stride 384). Both are silent if you get them wrong. Do not try
  to settle the plane order by correlating against the `main` stream: `main` is XBGR8888 and getting
  *its* channel order wrong inverts the answer. It was verified by reconstructing RGB from the lores
  planes both ways and looking at the two images -- the wrong one renders the room with red and blue
  swapped. While it was wrong the tracker locked confidently onto a navy microphone.
- **The head yields to you.** Any `POST /pantilt` or `/pantilt/center` (which is what the dashboard
  d-pad sends) suspends tracking for 8 s rather than fighting you for the servos.
- **A dead dashboard cannot leave the servos energised.** Every `/attention` POST renews a 12 s
  lease; when it lapses the head parks, and 25 s later it releases.
- `Restart=always` in the unit means a crash (or `kill`) comes back in 2 s.
