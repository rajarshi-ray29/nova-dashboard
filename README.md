# NOVA Dashboard

A Raspberry Pi-hosted web console for **Nova**, the Hermes agent. It shows a lightweight, mic-reactive
particle orb, live Pi stats, weather, the Pi camera with pan-tilt control, streaming chat, real Hermes
session history, and speech through Hermes's configured TTS provider.

The pan-tilt head is Nova's body and the camera is her eye. She finds your face when you talk to her,
nods, shakes, looks around and reacts as she speaks, ponders while she works, and takes emotes on
demand ("Nova, dance"). Replies run down a **quick** lane (an answer in a second or two) or a **deep**
lane (she says what she is about to do, goes off to do it, and comes back with the result). As a desk
companion she notices when you sit down or leave (and says hello), looks at what you hold up ("what is
this?"), takes photos, watches the desk while you are away and messages your Telegram if anything moves,
and keeps your reminders and timers — spoken at the desk and pushed to your phone. Play some music and
she bobs her head to the beat.

```
 Mac browser ── localhost SSH tunnel ──► Pi dashboard  (server.js, 127.0.0.1:8420)
                 ├─►  Hermes gateway     127.0.0.1:8642   chat, sessions, health
                 ├─►  Pi bridge          127.0.0.1:8433   stats, camera, pan-tilt, TTS
                 ├─►  Open-Meteo                                   weather (10 min cache)
                 └─►  ip-api.com                                   geolocation (once per run)
```

The browser only talks to the dashboard. The server proxies Hermes and the bridge, so the Hermes and
ElevenLabs keys never reach the page.

## Requirements

- A Raspberry Pi 5 on the LAN reachable as `raspberrypi.local`, running:
  - the Hermes gateway user service (`hermes-gateway`) with its API server on port 8642, and
  - the NOVA Pi bridge (`nova-bridge`) on port 8433 — see [pi/README.md](pi/README.md).
- Hermes's bundled Node.js **20 or newer** (`~/.hermes/node/bin/node`). **No `npm install`** is needed.
- Chrome, Edge or Safari for voice features (see [Browser support](#browser-support-for-speech)).

## Deploy and run on the Pi

```sh
cd nova-dashboard
cp .env.example .env      # first time only — put the Hermes gateway key in HERMES_KEY
PI_HOST=rajarshi@192.168.1.181 ./pi/deploy.sh
PI_HOST=rajarshi@192.168.1.181 ./pi/deploy-dashboard.sh
chmod +x mac/install-local-tunnel.sh
./mac/install-local-tunnel.sh
# open http://127.0.0.1:8420/ on the Mac
```

`deploy-dashboard.sh` syncs the app, copies `.env` without printing its secrets, installs the
`nova-dashboard` systemd user service, enables it at boot, restarts it, and verifies `/api/health`.
Use `systemctl --user status nova-dashboard` and `journalctl --user-unit nova-dashboard -f` on the Pi.

The localhost tunnel is a macOS LaunchAgent. It reconnects automatically, keeps dashboard compute on
the Pi, and gives the page a browser-trusted origin for MacBook microphone permission. Voice input uses
the Mac browser's microphone; Hermes/ElevenLabs replies play through that browser's current Mac audio
output. Opening the Pi's raw LAN address still works for non-microphone features.

The service binds to the Pi's LAN interface. Keep it on a trusted network: anyone who can reach port
8420 can chat with the agent and view its dashboard session history. Add authenticated HTTPS before
exposing it beyond the LAN.

Useful variations:

| Command | Effect |
| --- | --- |
| `PORT=8421 node server.js` | listen on another port (environment variables override `.env`) |
| `LOG_LEVEL=debug node server.js` or `npm run dev` | also log `/api/stats` polling and every SSE frame sent to the browser |
| `HOST=0.0.0.0 node server.js` | listen on all interfaces; the Pi service uses this so the dashboard is reachable on the LAN |

## Configuration (`.env`)

`server.js` parses `.env` itself (`KEY=VALUE`, `#` comments, optional quotes). Real environment variables win
over the file. `.env` is git-ignored; `.env.example` is the template.

| Key | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8420` | dashboard port |
| `HOST` | `127.0.0.1` | bind address (see the warning above) |
| `HERMES_URL` | `http://raspberrypi.local:8642` | Hermes gateway API server (the Pi service overrides this to `127.0.0.1`) |
| `HERMES_KEY` | *(required for chat)* | bearer key for Hermes; never sent to the browser |
| `HERMES_MODEL` | `nova` | model id passed to `/v1/chat/completions` |
| `HERMES_SESSION_KEY` | `nova-dashboard` | `X-Hermes-Session-Key` header; groups the dashboard's transcripts on the Pi |
| `PI_BRIDGE_URL` | `http://raspberrypi.local:8433` | NOVA Pi bridge (the Pi service overrides this to `127.0.0.1`) |
| `WEATHER_LAT`, `WEATHER_LON` | *(blank)* | fixed location for the weather panel; blank = auto-detect via ip-api |
| `WEATHER_CITY` | *(blank)* | override the displayed city name |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` (`DEBUG=1` is a shortcut for `debug`) |
| `NOVA_QUICK_REASONING` | `none` | Hermes reasoning effort for the quick lane (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) |
| `NOVA_DEEP_REASONING` | `high` | reasoning effort for the deep lane |
| `NOVA_GESTURES` | `1` | `0` stops telling Nova she has a robot head (no gesture cues in replies) |
| `NOVA_DATA_DIR` | `~/.local/share/nova-dashboard` | where `reminders.json` lives |

## What the server exposes

| Endpoint | Purpose |
| --- | --- |
| `GET /` and `public/*` | the dashboard (`index.html`, `styles.css`, `app.js`, `orb.js`, …); `no-cache` for html/js/css |
| `GET /api/config` | name, wordmark, Hermes / Pi URLs, dashboard hostname |
| `GET /api/health` | Hermes (`ok`, `version`, `latency_ms`) and Pi bridge (`ok`, `camera`, `pantilt`, `attention`) reachability — cached 5 s |
| `GET /api/stats` | dashboard-host stats plus the Pi bridge's `/stats` (`pi: null` when the bridge is down) — cached 2 s |
| `GET /api/weather` | Open-Meteo current conditions with WMO code → description/icon; cached 10 min, serves stale data (`stale: true`) if the upstream fails |
| `POST /api/chat` | `{"message", "session_id", "mode": "auto\|quick\|deep", "voice", "gestures", "image"?}` → Server-Sent Events `lane` / `delta` / `gesture` / `tool` / `done` / `error`. Only the latest user message is sent; Hermes keeps the transcript for the `session_id` returned in `done`. The server picks the lane, sets Hermes's per-request reasoning effort, adds a one-turn system message (voice delivery, lane guidance, the gesture protocol) and strips `[nod]`-style cues out of the text into `gesture` events carrying the character offset they belong to. `image` (a `data:image/jpeg;base64` URL, what the desk camera sees) rides along as an image part |
| `GET /api/sessions`, `GET /api/sessions/:id/messages` | authenticated server-side proxies for browsing and reopening Hermes conversations |
| `POST /api/tts` | `{"text"}` → audio from Hermes's configured provider (currently ElevenLabs); keys stay on the Pi. Disk-cached by text; `X-TTS-Cache: hit\|miss`. Off unless `TTS_REMOTE=1`, otherwise `503` |
| `GET /api/pi/stream.mjpg` | unbuffered proxy of the Pi's MJPEG stream (the Pi starts its camera on the first viewer and stops it ~5 s after the last one leaves) |
| `GET /api/pi/snapshot.jpg` | one JPEG frame |
| `GET`/`POST /api/pi/pantilt`, `POST /api/pi/pantilt/center`, `POST /api/pi/pantilt/release` | JSON proxies to the servo controller (body, status and JSON are forwarded) |
| `GET`/`POST /api/pi/attention` | JSON proxy to the attention machine — the dashboard POSTs `{"mode": "wake"}` / `speak` / `think` / `tool` / `sleep` so the head looks at whoever is talking, "talks" with small movements while Nova speaks, and ponders while she works |
| `GET /api/pi/gestures`, `POST /api/pi/gesture`, `POST /api/pi/gesture/stop` | the head's emote vocabulary, `{"name": "nod"}` to perform one (optional `intensity`, `speed`, `queue`), and stop |
| `GET /api/pi/status`, `GET`/`POST /api/pi/presence`, `GET`/`POST /api/pi/watch` | one poll for presence + desk watch + head state; switch presence sensing; arm/disarm the desk watch (`{"enabled", "notify"}`) |
| `POST /api/pi/capture`, `GET /api/pi/captures`, `GET /api/pi/captures/:name.jpg`, `POST /api/pi/notify` | take a photo (saved on the Pi under `~/nova-captures`), list them, fetch one, send a message (+ photo) to the user's Telegram through Nova's bot |
| `GET`/`POST`/`DELETE /api/reminders`, `DELETE /api/reminders/:id` | reminders and timers, kept in `reminders.json` on the Pi and fired by the server (the head waves; Telegram gets the line too) |
| `GET`/`POST /api/pi/vibe` | music sensing state (`listening`, `active`, `bpm`, `confidence`, `level_db`); `{"enabled", "force", "amplitude"}` to switch, force or scale the vibe |

Errors are JSON `{"error": "..."}` with a proper status (`502` when a Pi service is unreachable, `503` for
weather/Hermes-key problems, `403` for path traversal, `404`/`405` as usual). One log line per request
(`METHOD path status ms`); `/api/stats` polling is logged only at `debug`.

## How the Pi pieces fit

Three services run on the Pi, all as **systemd user services** (no sudo anywhere; `loginctl` linger keeps
them running at boot):

1. **Hermes gateway** (`hermes-gateway`, port 8642) hosts the agent "Nova". The dashboard uses only
   health, streaming chat, and the session list/transcripts. Each turn takes real model time
   (typically 10–60 s); `/api/chat` streams tokens as they arrive and never times the stream out. The
   browser's Stop button closes the request, which aborts the upstream call.
2. **NOVA Pi bridge** (`pi/nova_bridge.py`, port 8433) exposes Pi system stats, the IMX219 camera as an
   MJPEG stream, PCA9685 pan-tilt servos, and Hermes-configured TTS (currently ElevenLabs).
   Deploy or update it from the Mac with `bash pi/deploy.sh`. Endpoints, service management and hardware
   notes are in [pi/README.md](pi/README.md).
3. **NOVA dashboard** (`server.js`, port 8420) serves the UI and keeps both API keys server-side.

The dashboard prefers bridge stats and falls back to its host process stats if the bridge is unavailable.

## Troubleshooting

### Hermes offline (red `● Offline` pill, "Nova backend offline")

- From the Mac: `curl http://raspberrypi.local:8642/health` should print `{"status":"ok",...}`.
- On the Pi: `ssh rajarshi@raspberrypi.local`, then `systemctl --user status hermes-gateway` and
  `journalctl --user -u hermes-gateway -n 50 --no-pager`. Restart with `systemctl --user restart hermes-gateway`.
- Chat shows `Hermes returned 401`: `HERMES_KEY` in `.env` is missing or wrong (the server also warns at startup
  when it is empty). Restart `node server.js` after editing `.env`.
- Chat shows `Hermes request failed: host not found`: mDNS is not resolving `raspberrypi.local` — try
  `ping raspberrypi.local`, or put the Pi's IP in `HERMES_URL`/`PI_BRIDGE_URL`.
- Slow first token is normal — Hermes runs the model on the Pi. Check `/api/health` → `hermes.latency_ms`
  to separate network trouble from model time.

### Pi bridge offline (Mac stats shown, camera error, `pi_bridge.ok: false`)

- `curl http://raspberrypi.local:8433/health` from the Mac. Connection refused / timeout means the service is
  not running or not deployed: `bash pi/deploy.sh` installs and enables it.
- On the Pi: `systemctl --user status nova-bridge`, `journalctl --user -u nova-bridge -f`.
- The dashboard keeps working without it: `/api/stats` returns `pi: null`, `/api/pi/*` answer `502`
  with a JSON error, and the frontend falls back to Mac stats.

### Camera

- "Camera is inactive" → press the power button in the Camera panel (or the center camera button).
- Broken image / `502` on `/api/pi/stream.mjpg`: the bridge is down (above) or the camera is busy. On the
  Pi, `rpicam-hello --list-cameras` should list the IMX219; make sure no other `rpicam-*`/`picamera2` process
  holds it. Check `journalctl --user -u nova-bridge` for `camera start failed` lines. The dashboard retries
  transient start failures automatically, and the bridge keeps one configured camera object between viewers
  to avoid unreliable close/reopen cycles in Picamera2/libcamera.
- Upside-down picture means the bridge was started without the hflip/vflip transform — redeploy.
- Pan-tilt d-pad missing: `/api/health` reports `pantilt: false`, i.e. the PCA9685 did not answer on I2C
  bus 1 at `0x40`. On the Pi run `i2cdetect -y 1`; check the HAT is seated and I2C is enabled. `503`
  `{"error":"pantilt unavailable"}` from the proxies means the same thing.
- The head does not find you: `curl http://raspberrypi.local:8433/attention/debug` while she is
  searching shows what the detector sees (ASCII, with `#` boxes around faces) and `face_detector` in
  `/health` says whether it is `haar` (OpenCV) or the `skin` fallback — the latter means the bridge
  venv is missing OpenCV; rerun `pi/deploy.sh`. Lighting matters: a face lit from behind reads as
  `dark`.
- No gestures during replies: Settings → *Expressive gestures* must be on and the bridge reachable;
  the server log line `chat ← done … N gesture cues` says whether Nova wrote any.
- The head buzzes or grinds while trying to look down: the tilt servo is being driven into the
  bracket. The bridge holds the mechanical limits in `~/nova-bridge/head_limits.json` on the Pi
  (`tilt 32-96` on this rig; `curl …:8433/pantilt/limits` shows them) and clamps every motion to
  them. If it happens, stop the bridge (`systemctl --user stop nova-bridge` releases the servos),
  lower `tilt` in that file, and start it again. Never run `/pantilt/calibrate` with
  `"explore": true` on tilt.
- Presence never shows "At desk": the camera must be able to see your face from where the head
  rests (it parks at head height, tilt ~55, before relaxing). `curl …:8433/presence` shows the raw
  state; `/attention/debug` shows the frame.
- Nothing arrives on Telegram: `curl …:8433/health` must say `"telegram": true`; the bridge log says
  `telegram notifier disabled (no bot token / chat id)` otherwise.
- She does not vibe: `curl …:8433/vibe` while the music plays. `listening` must be true (the USB
  mic is captured through `pw-record`; `arecord -l` should list it), `level_gate_db` must be above
  `NOVA_VIBE_MIN_DB` (-50 dBFS), and `confidence` (the time-averaged beat strength) must reach
  0.19 with `agree` climbing to 5 of 8 — that takes six to ten seconds of steady music. This USB
  mic is quiet: a speaker beside it reads only -44..-47 dBFS and scores 0.21-0.29, so louder or
  closer music helps most; sections without a clear beat will drop out. Off-beat bobbing: adjust
  `NOVA_VIBE_LATENCY` (capture delay, default 0.07 s) on the bridge unit.

### Microphone permission

- The browser asks for microphone access the first time you press the mic button. If it was denied, click
  the padlock/site-info icon in the address bar and allow the microphone, then reload.
- macOS also gates microphone access per application: **System Settings → Privacy & Security →
  Microphone** must list your browser as allowed.
- `getUserMedia` only works in a *secure context*: `http://127.0.0.1:8420` qualifies, but opening the
  dashboard by IP from another machine (`http://192.168.x.x:8420`) does not — the mic and speech buttons
  will fail. Install the included localhost tunnel (or use an HTTPS reverse proxy).
- The orb still animates and typed chat still works with the mic off; the status pill identifies the
  MacBook microphone when Nova is opened through the local tunnel.

### Talking to Nova

Nova holds a conversation instead of ending after every command:

1. Say **"hey Nova, …"** (or just "Nova" and wait for *Yes?*) to start.
2. Once she has finished answering, the pill shows **"Go ahead — no wake word needed"** — ask the
   follow-up straight away. The window reopens after every reply and lasts 30 s by default
   (Settings → *Follow-up window*, up to "until I say goodbye").
3. Say **"goodbye"**, "that's all", "stop listening" or "go to sleep" to hand back to the wake word.

**Cutting her off.** While she is talking, say **"Nova, …"** with what you want, or just **"Nova"** /
**"stop"** on its own. Either way she stops immediately — including the answer still being generated —
and then *waits*: she keeps listening for at least 25 seconds with no wake word needed, so you can take
your time. "Nova" on its own gets a short "Yes?" back; "stop" gets silence. This works even if you have
continuous conversation switched off, and Settings → *Let me interrupt* turns it off entirely.

**She will not interrupt herself.** The speaker and mic share a room, so her own voice comes back through
the mic a moment later. Two filters stop that becoming a command: anything matching what she said in the
last 20 seconds is discarded, and any sentence that *began* while she was still delivering an answer has
to carry the wake word or a stop phrase. That second rule is why an ordinary sentence spoken over her is
ignored — lead with "Nova". It stops applying the moment she hands the floor back, so answering the
instant she finishes, or carrying straight on after interrupting her, always works.

### Quick replies and deep work

Every message is routed down one of two lanes before it reaches Hermes (`server.js`, "Conversation
lanes"). A **quick** exchange — a greeting, a fact, a yes/no, a small lookup — runs with the model's
reasoning switched off and a one-turn instruction to answer in a sentence or two, so the first words
arrive in about a second (measured 0.8–2.5 s on this Pi, against 6–30 s before). **Deep** work —
"research …", "write me a script …", "plan …", "take your time …", anything long or multi-line — gets a
real thinking budget and is told to say one concrete sentence about what it is going to do *before*
it touches a tool, then to go and do it properly, then to lead with the result. The lane is chosen
with cheap phrasing heuristics (no classifier round trip); Settings → *Answer style* forces it.

Slow answers are never silent: a quick reply that has not arrived within about a second gets an
"On it."; a deep request is acknowledged at once ("Leave it with me."), then Nova's own opening line
("Let me check the load on the machine, sir.") follows, and she speaks each sentence of the reply as
it streams rather than waiting for the whole answer. Turn the fillers off with Settings → *Thinking
acknowledgements*.

### The robot head

With the Pi bridge running, the pan-tilt head is Nova's body:

- **Looking at you.** The wake word makes her look up and find your face (an OpenCV Haar-cascade
  detector on the Pi); if nobody is straight ahead she sweeps left and right before settling. She
  keeps tracking through the conversation and ponders — looking up and away, glancing at her
  "hands" when a tool starts — while she works.
- **Talking with her body.** Nova's replies carry gesture cues (`[nod]`, `[shake]`, `[think]`,
  `[celebrate]` …) that the server strips out and the page performs the moment the sentence they
  belong to is spoken; while her voice is in the air the head also drifts and micro-nods the way a
  person talking does. Settings → *Expressive gestures* switches all of this off.
- **Emotes on demand.** Say "Nova, nod", "shake your head", "look around", "take a bow", "dance",
  "celebrate", "look sad", "act surprised", "laugh", "wave", "peek", "do a double take", "shiver",
  "look left/right/up/down", "look at me", "hold still" or "center" — or type it, or click a chip
  under the orb. These go straight to the Pi, no model round trip. The full vocabulary is
  `GET /api/pi/gestures`.

### Desk companion

Everything below is handled by the console and the Pi directly — no model round trip — and shows up
as an italic action line in the transcript:

- **Presence.** While nobody is talking to her the camera checks for a face every few seconds
  (Settings → *Presence awareness*; the head rests at head height so it can see you). The "At desk"
  tile shows how long you have been sitting there. Sit down after being away for three minutes and
  the head looks up and nods (the nod is the Pi's own, `NOVA_GREET`) — she says nothing.
  *Daily briefing on first arrival* runs "give me my daily briefing" the first time each day.
  *Break reminder* nags gently after 45/60/90 minutes without leaving.
- **"Look at this."** "What is this?", "what am I holding?", "read this", "what do you see?",
  "describe my desk" — the current frame goes to Nova with the words. The camera button in the
  composer attaches a frame to whatever you type next.
- **Photos.** "Take a photo" (or the picture button in the Camera panel) saves a JPEG under
  `~/nova-captures` on the Pi and shows it in the transcript; "take a photo and send it to me" or
  "send me the photo" pushes it to your Telegram.
- **Desk watch.** "Watch my desk" (or the eye button in the Camera panel) arms motion and face
  detection at 2 Hz. Anything that moves makes the head turn toward it, saves a snapshot, logs an
  event, and — with *Desk watch & reminders to Telegram* on — messages your Telegram with the photo
  (at most one message a minute). "Stop watching" / "stand down" disarms it.
- **Reminders and timers.** "Set a timer for ten minutes", "remind me in twenty minutes to check
  the oven", "remind me at 3:30 to call the dentist", "remind me tomorrow at 9 to submit the form";
  "what are my reminders?", "cancel the timer", "cancel all reminders". The server on the Pi keeps
  the clock (a closed tab does not matter): when one falls due it is spoken here, the head waves,
  and the same line goes to Telegram. The Reminders panel lists and cancels them and takes typed
  ones. Anything the console cannot parse ("remind me to buy milk", no time) goes to Nova as usual.

- **Vibing to music.** A USB microphone on the Pi listens for a beat (this is separate from the
  MacBook microphone you talk to Nova with). When music with a steady tempo plays and nobody is
  talking to her, the head bobs on the beat, sways across the bar and throws a flourish every few
  bars; the status pill reads "Vibing · 124 BPM" and the orb pulses in time. Speech and room noise
  never pass the gate. It stops within a few seconds of the music stopping, and pauses the moment
  you say "Nova". "Nova, vibe" / "dance mode" starts it on demand (for up to ten minutes),
  "stop vibing" / "chill" ends it. Settings → *Vibe to music* and *Vibe intensity*.

Telegram uses the bot Hermes already runs on the Pi (`TELEGRAM_BOT_TOKEN` and the first id in
`TELEGRAM_ALLOWED_USERS` from `~/.hermes/.env`); `NOVA_TELEGRAM_NOTIFY=0` on the bridge unit turns
it off, and Settings shows whether it is configured.

Those filler phrases live in `public/phrases.js` and are cached as audio on the Pi
(`~/.cache/nova-dashboard/tts`, pre-synthesized a few seconds after the service starts), because each
fresh synthesis costs about 2.5 s. `X-TTS-Cache: hit` on `/api/tts` confirms a phrase came from the cache.
Set `TTS_PREWARM=0` to skip the warm-up or `TTS_CACHE=0` to disable caching entirely.

**Nova speaks with the browser's own voice by default.** Server-side synthesis (Hermes → ElevenLabs)
is opt-in: set `TTS_REMOTE=1` in `.env` and restart to use it. It ships off because an ElevenLabs
plan that has run out of credits fails *every* request, which put a doomed round trip in front of
every sentence Nova spoke. With it off, `/api/tts` answers `503 remote TTS disabled` and the page
goes straight to `speechSynthesis`.

### Browser support for speech

- **Speech recognition** (wake word and dictation) uses the Web Speech API, which is available in Chrome,
  Edge and Safari. Firefox does not implement `SpeechRecognition`: the pill shows
  "Speech recognition not supported in this browser", but the mic still drives the orb and typing works.
- Chrome and Edge send recognition audio to Google/Microsoft servers, so recognition needs an internet
  connection even though everything else is local. Chrome also stops listening after a period of silence;
  the dashboard restarts it automatically.
- **Text-to-speech** uses the browser's English `speechSynthesis` voice unless `TTS_REMOTE=1` turns on
  `/api/tts` (Hermes's selected provider on the Pi — currently ElevenLabs). Either way a failed synthesis
  falls back to the browser voice silently: the failure is logged to the console, and the page then leaves
  the server alone for five minutes rather than stalling on it once per sentence.
- Speech is played from a single queue, and the next sentence is fetched while the current one plays, so
  synthesis latency is hidden behind the audio already in the air. If a reply arrives in long sentences and
  the cache is cold, the first one still costs a synthesis round trip.

### Other

- `error: 127.0.0.1:8420 is already in use` — another process has the port. Stop it or run with another
  `PORT` (port 8000 is taken on this Mac, which is why the dashboard uses 8420).
- Wrong weather location: ip-api geolocates by public IP once per run; set `WEATHER_LAT`, `WEATHER_LON`
  (and optionally `WEATHER_CITY`) in `.env` for a fixed location. `stale: true` in `/api/weather` means the
  last good reading is being served because Open-Meteo did not answer.
- Node prefers IPv4 for `.local` names (`dns.setDefaultResultOrder('ipv4first')`) because link-local IPv6
  answers from mDNS can stall connections.

## Project layout

```
server.js            Pi dashboard server: static files + /api/*
package.json         { "type": "module", "scripts": { "start": "node server.js" } } — no dependencies
.env / .env.example  configuration (see above)
public/              UI, session browser, voice controls, and orbital particle renderer (orb_v4.js)
  speech.js          wake word, conversation mode, interruptions, echo rejection, the speech queue
  phrases.js         Nova's spoken fillers — also imported by server.js to pre-cache them
pi/                  bridge + dashboard systemd units and deployment scripts
SPEC.md              the build contract every piece follows
```
