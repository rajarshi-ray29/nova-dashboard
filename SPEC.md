# NOVA Dashboard — Build Spec (contract for all build agents)

Read this whole file before writing code. Every file you write must match the interfaces here exactly,
because other agents are building the other pieces in parallel against this same contract.

Project root: `/Users/rajarshiray/Documents/Projects/raspberrypi-fix/nova-dashboard/`
Scratchpad for temp files/screenshots: `/private/tmp/claude-501/-Users-rajarshiray-Documents-Projects-raspberrypi-fix/b54a9b27-ab04-4a57-8b00-8508a41b4d00/scratchpad/`

## 1. Goal

A Raspberry Pi-hosted web dashboard at `http://raspberrypi.local:8420` re-themed as **NOVA**: a
mic-reactive orbital particle orb, chat routed to the colocated Hermes agent, real Hermes session
history, and a bridge service exposing Pi stats, camera, pan-tilt control, and Hermes-configured TTS.

Environment facts:
- Mac: macOS (darwin, zsh), Node **v26.8.1** at `/Users/rajarshiray/.local/bin/node` (native `fetch`,
  ES modules). No `timeout` command on macOS. Port 8000 is taken by something else; use **8420** for the
  dashboard. Python on the Mac is 3.9 (do not use Python on the Mac).
- Headless Chrome works for screenshots (WebGL2 via SwiftShader):
  `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --use-angle=swiftshader --enable-unsafe-swiftshader --no-sandbox --hide-scrollbars --window-size=1440,900 --virtual-time-budget=5000 --screenshot=/abs/path/out.png "http://localhost:8420/"`
  (run it from the scratchpad dir; it prints 2 harmless `task_policy_set` errors).
- Raspberry Pi 5 (8 GB, 4 cores, Pi OS trixie, Python **3.13**): `ssh rajarshi@raspberrypi.local` works with
  key auth (BatchMode ok). **sudo needs a password — never use sudo.** `loginctl` linger is enabled, so
  `systemctl --user` services run at boot. `picamera2`, `numpy`, `smbus2` are importable with the system
  `python3`. `rpicam-jpeg`/`rpicam-vid` exist. Camera: IMX219, **mounted upside down** (needs hflip+vflip).
  I2C bus 1 has a PCA9685 servo driver at 0x40 (ch0 = tilt, ch1 = pan, 50 Hz, 500–2500 µs = 0–180°;
  the pan servo turns the camera left as its angle rises, so the bridge mirrors pan on the way out).
  Reference servo code: `/Users/rajarshiray/Documents/Projects/raspberrypi-fix/pantilt_test.py`.
  pipewire holds `/dev/video4,6,7,20` (ISP nodes) — that is fine, rpicam/picamera2 still work.
- Hermes bundles Node **v26.8.1** at `/home/rajarshi/.hermes/node/bin/node`; the dashboard runs from that
  runtime as the `nova-dashboard` systemd user service and requires no package installation.
- Hermes gateway v0.21.0 runs on the Pi as the systemd **user** service `hermes-gateway`. Its API server is
  enabled at `http://raspberrypi.local:8642` (bearer key in `nova-dashboard/.env` as `HERMES_KEY`,
  model id `nova`). Verified endpoints: `GET /health` (no auth) →
  `{"status":"ok","platform":"hermes-agent","version":"0.21.0"}`; `GET /v1/models` (auth);
  `POST /v1/chat/completions` with `"stream": true` → SSE. Each Hermes turn costs real model time (10–60 s),
  so keep live chat tests to one or two short prompts like "Reply with exactly the word PONG".

## 2. Reference layout (what the user showed; replicate every component)

Dark navy/cyan "JARVIS" console. Rename everything to NOVA (`N.O.V.A` wordmark, "Nova" in copy).

- **Top bar** (full width, ~56px): left — wordmark `N.O.V.A` (letter-spaced, geometric font) + green pill
  `● Online` (red `● Offline` when Hermes is unreachable). Center — pill: clock icon + `2:52:27 PM | July 23, 2025`
  (live). Right — pill: thermometer icon + `25.2°C  Quezon City` (live weather, city dim) + a square gear button.
- **Default view is the centre alone.** Nova is driven by voice, so on load the window shows only the
  orb, the wordmark, the status pill and the three round buttons. Both side columns are **drawers**
  (`state.ui.left` / `state.ui.right`, persisted under `nova.ui`, both `false` on first run) that slide in
  **over** the centre — the orb never moves. Open them with the chevron tabs at the window edges;
  `Escape` closes both. The keyboard button opens the conversation drawer before focusing the composer,
  and switching the camera on opens the left drawer so the feed is actually visible.
- **Left drawer** (~320px, scrolls) — one column of macOS-widget-style cards: soft 18px radius, heavy
  translucent blur, no header strip (the title row sits directly on the card).
  Panels, in order:
  1. **System Stats** (refresh icon): rows `CPU Usage ……… 8%` and `RAM Usage ……… 7 GB` each with a thin
     progress bar; then tiles `Memory 44%` and `Disk GB 439/475`. (A third tile `Temp 49.0°C` appears when Pi
     stats are shown.) No `CPU` tile — the bar directly above it already carries that number.
  2. **Weather** (refresh icon): big temp `25.2°C`, city line `Quezon City, PH`, description `overcast clouds`,
     a weather icon at right; 3 tiles: `Humidity 94%`, `Wind m/s 5.8`, `Feels Like 26.3°C`.
  3. **Camera** (snapshot icon + power icon): bordered 4:3 viewport (matching the Pi feed, so the image is
     never cropped or letterboxed) with camera-off icon + `Camera Off`; caption
     `Camera is inactive. Click the power button to start.`
  (System Uptime sits second, right under System Stats, then Weather, Camera, Groove, Reminders.)
  2. **System Uptime** (header right: expand icon): `System Running For:` + big mono `00:07:19`;
     tiles `Session 1`, `Commands 0`, `At desk`; `System Load` bar with `Moderate ……… 26%`.
- **Center**: big orb (`clamp(210px, 34vh, 340px)` — it is the only element allowed to give up height, so
  the pill and chips below it are never squeezed on a short window) with faint concentric rings; below it the wordmark `N.O.V.A` (large, spaced);
  status pill `● Listening for wake word...`; at the bottom a row of 3 square icon buttons: camera, mic, keyboard.
- **Right drawer** (~380px): **Conversation** panel: header with `Clear` (trash icon) and `Extract Conversation`
  (download icon) buttons; message bubbles (assistant greeting with timestamp); bottom composer
  `Type a message...` + send (paper-plane) button.
- Small chevron tabs at the far left/right edges (vertically centered) open/close the two drawers. While a
  drawer is open the centre is inset by that width on **both** sides, so the orb stays centred in the window
  and nothing wraps underneath a drawer. `.layout` is `overflow: clip` — a parked drawer sits outside the
  box and must never become scrollable.

## 3. Visual design tokens (frontend must use these)

```css
:root {
  --bg-0: #04080f; --bg-1: #081120;
  --panel: rgba(10, 22, 40, 0.72); --panel-header: rgba(14, 30, 52, 0.75);
  --panel-border: rgba(56, 189, 248, 0.16); --panel-border-strong: rgba(56, 189, 248, 0.35);
  --tile: rgba(6, 14, 26, 0.7);
  --accent: #38bdf8; --accent-2: #22d3ee; --accent-glow: rgba(56, 189, 248, 0.35);
  --text: #dbe7f5; --text-dim: #8aa2bd; --text-faint: #5b7290;
  --ok: #34d399; --warn: #fbbf24; --bad: #f87171;
  --radius: 12px; --radius-sm: 8px;
  --font-ui: 'Inter', system-ui, sans-serif;
  --font-display: 'Space Grotesk', 'Inter', sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
}
```
Fonts via Google Fonts `<link>` (Inter 400/500/600, Space Grotesk 500/700, JetBrains Mono 400/500) with real
fallbacks. Icons: inline SVG (Lucide style, 1.75 stroke, `currentColor`), no icon fonts, no image files.
Background: `--bg-0` with a faint radial cyan glow behind the orb and a vignette; optional very subtle grid
lines (≤6% opacity). Panels: 1px `--panel-border`, `--radius`, slight backdrop blur, header row 38px.
Progress bars: 4px, rounded, cyan gradient fill with soft glow. Tiles: `--tile` background, 1px border,
label 10.5px uppercase dim, value 13px mono. Everything should feel crisp, modern, quiet, and high-end —
not neon-garish. Motion: subtle (rings rotate slowly, status dot pulses, hover lifts ≤1px).

## 4. Orb (reference look)

A **blue plasma energy sphere on black**: translucent glass-like sphere; bright white→cyan core at the
center; swirling electric-blue plasma filaments/tendrils wrapping around the inside of the sphere like a
plasma ball / wisps of energy; soft outer halo; the rim a deeper saturated blue; visible depth (core fades
to darker blue toward the edge). It must look **alive**: filaments drift/rotate slowly at idle; with mic
input the core brightens and pulses, filaments accelerate and intensify, and the radius "breathes" with the
level. Tasteful — no strobing, no hard edges, no visible tiling/banding.

## 5. Files

```
nova-dashboard/
  package.json          {"name":"nova-dashboard","private":true,"type":"module","scripts":{"start":"node server.js"}}  (ZERO npm deps)
  server.js             Node 26 ES module, zero dependencies
  .env / .env.example   KEY=VALUE, parsed by server.js itself (no dotenv)
  README.md             how to run (Mac + Pi), config, troubleshooting
  public/index.html     markup (all panels), loads styles.css + app.js (type=module)
  public/styles.css     all styling (tokens above)
  public/app.js         dashboard logic (polling, panels, chat, settings, wiring)
  public/audio.js       mic analyser  (interface §8)
  public/speech.js      wake word / conversation mode / dictation / TTS (interface §9)
  public/phrases.js     spoken filler phrases, shared with server.js (§9.4)
  public/orb.js         the orb renderer (interface §7) — produced by the orb pipeline; frontend agent
                        writes ONLY a trivial placeholder so the page loads, never a real implementation
  public/orb-test.html  orb-only harness for screenshots (§7)
  pi/nova_bridge.py     Pi bridge service (§10)
  pi/nova-bridge.service  systemd user unit
  pi/deploy.sh          scp + install + enable from the Mac
  pi/nova-dashboard.service  dashboard systemd user unit
  pi/deploy-dashboard.sh     sync + install + enable the complete dashboard on the Pi
  pi/README.md
```

`.env` keys (already present): `PORT=8420`, `HERMES_URL=http://raspberrypi.local:8642`, `HERMES_KEY=…`,
`HERMES_MODEL=nova`, `HERMES_SESSION_KEY=nova-dashboard`, `PI_BRIDGE_URL=http://raspberrypi.local:8433`,
`WEATHER_LAT=`, `WEATHER_LON=`, `WEATHER_CITY=` (blank = auto-detect). Optional `HOST` (default `127.0.0.1`),
`TTS_CACHE_DIR` (default `~/.cache/nova-dashboard/tts`), `TTS_CACHE=0` to disable the cache, `TTS_PREWARM=0`
to keep the cache but skip the boot warm-up, `TTS_REMOTE=1` to synthesize speech through Hermes at all
(off by default: Nova reads with the browser's own voice, so an exhausted ElevenLabs plan cannot put a
failing round trip in front of every sentence).

## 6. Dashboard server API (`server.js`, default 127.0.0.1:8420; Pi service binds 0.0.0.0)

Bind to 127.0.0.1 by default: `/api/chat` reaches an agent with terminal access. Never send `HERMES_KEY`
to the browser. Serve `public/` statically with correct MIME types (html, css, js, json, png, svg, ico,
woff2), `index.html` at `/`, reject path traversal, `Cache-Control: no-cache` for html/js/css.

- `GET /api/config` → `{"name":"Nova","wordmark":"N.O.V.A","hermes_url":"http://raspberrypi.local:8642","pi_bridge_url":"http://raspberrypi.local:8433","host_name":"<mac hostname>"}`
- `GET /api/health` (cache 5 s) → `{"hermes":{"ok":true,"version":"0.21.0","latency_ms":12},"pi_bridge":{"ok":true,"camera":true,"pantilt":true},"server_time":"<iso>"}`
  Hermes via `GET HERMES_URL/health` (no auth, 3 s timeout); pi_bridge via `GET PI_BRIDGE_URL/health` (2 s).
- `GET /api/stats` (cache 2 s) →
  `{"host":{"hostname","platform":"darwin","cpu_percent","ncpu","mem":{"total","used","available","percent"},"disk":{"total","used","percent"},"load":[l1,l5,l15],"uptime_s"},"pi": <Pi /stats JSON or null>}`
  Bytes for mem/disk totals. Mac CPU% = delta of `os.cpus()` times sampled by a 2 s background interval.
  Mac memory on darwin: parse `vm_stat` (`Pages free/inactive/speculative` × page size = available;
  used = total − available). Disk: parse `df -k /`. Pi stats: `GET PI_BRIDGE_URL/stats`, 1.5 s timeout, null on failure.
- `GET /api/weather` (cache 10 min, serve stale on error) →
  `{"temp_c","feels_like_c","humidity","wind_ms","code","description","icon","is_day","city","region","country","lat","lon","updated_at"}`
  Source: Open-Meteo `https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m&wind_speed_unit=ms&timezone=auto`
  (verified reachable). Location: `.env` override, else `http://ip-api.com/json/?fields=status,city,regionName,country,countryCode,lat,lon`
  once per process (verified reachable; returns e.g. Wappingers Falls, NY). Map WMO `weather_code` →
  `description` (lowercase like "overcast clouds", "light rain") and `icon` ∈ {clear, partly-cloudy, cloudy, fog, drizzle, rain, snow, thunder}.
- `POST /api/chat` body `{"message": "...", "session_id": "api-…" | null, "mode": "auto"|"quick"|"deep", "voice": bool, "gestures": bool, "image": "data:image/jpeg;base64,…"?}` → SSE (`text/event-stream`, flush every frame):
  - `event: lane`   `data: {"lane":"quick"|"deep","reason":"default|asked|long|task|setting","reasoning":"off"|"low"|...}` — first frame; the server classifies the message (phrasing heuristics, `mode` forces) and sets Hermes's per-request `model_options.reasoning` (`NOVA_QUICK_REASONING` default `none`, `NOVA_DEEP_REASONING` default `high`).
  - `event: delta`  `data: {"text":"..."}` — with gesture cues already stripped out
  - `event: gesture` `data: {"name":"nod","at":123}` — a cue Nova wrote as `[nod]`; `at` is the character offset in the cleaned reply it belongs to. Names are the bridge's vocabulary (aliases resolved). A cue split across two upstream chunks is reassembled (32-char holdback).
  - `image` (≤ 2.5 MB data URL, what the desk camera sees) becomes an `image_url` part of the user message and the one-turn prompt says so.
  - `event: tool`   `data: {"tool":"terminal","emoji":"💻","label":"ls -la","toolCallId":"…","status":"running"|"completed"}`
  - `event: done`   `data: {"session_id":"api-…","usage":{...}}`
  - `event: error`  `data: {"message":"..."}`
  Implementation: `fetch(HERMES_URL + '/v1/chat/completions', {method:'POST', headers:{Authorization:'Bearer '+HERMES_KEY, 'Content-Type':'application/json', 'X-Hermes-Session-Key': HERMES_SESSION_KEY, ...(session_id ? {'X-Hermes-Session-Id': session_id} : {})}, body: JSON.stringify({model: HERMES_MODEL, stream: true, messages:[{role:'system', content: <one-turn prompt>}, {role:'user', content: message | [text part, image_url part]}], model_options: {reasoning}})})`.
  The system message is ephemeral (Hermes layers it over its core prompt for this turn only) and carries: voice-vs-typed delivery, lane guidance (quick: answer from knowledge in 1–3 sentences, tools only if needed; deep: one concrete spoken sentence about what you will do *before* any tool, then thorough work, then the result), the gesture protocol (`[nod]`-style cues from the bridge vocabulary, placed before the sentence they belong to), and, with an image, that the photo is what her own camera sees.
  Send ONLY the latest user message; Hermes keeps the transcript server-side when `X-Hermes-Session-Id`
  is passed (the id comes back in the response header `X-Hermes-Session-Id` — read it and put it in `done`).
  Upstream SSE format (verified): default-event frames `data: {"choices":[{"delta":{"content":"..."},"finish_reason":null}]}`,
  a final chunk with `finish_reason:"stop"` and `usage`, then `data: [DONE]`; tool events arrive as
  `event: hermes.tool.progress` + `data: {"tool","emoji","label","toolCallId","status"}`. Parse SSE frames
  robustly (split on blank lines, handle `event:` + `data:` lines, partial chunks across reads). Client
  disconnect → abort the upstream fetch (AbortController). Timeouts: none on the stream itself, but emit
  `error` if upstream returns non-200 (include Hermes's error message).
- `GET /api/sessions` and `GET /api/sessions/:id/messages` → authenticated server-side proxies for
  Hermes's persisted `api_server` sessions. Never expose the gateway key to the browser.
- `POST /api/tts` body `{"text":"..."}` → audio bytes proxied from `PI_BRIDGE_URL/tts`; preserve content
  type and `X-TTS-Provider` and never expose provider credentials. Results are cached to disk by
  `sha256(text)` under `TTS_CACHE_DIR` (LRU, 400 entries) and reported as `X-TTS-Cache: hit|miss`;
  identical concurrent requests share one synthesis. The filler phrases of §9.4 are pre-synthesized in
  the background a few seconds after boot, so a cached phrase answers in ~2 ms instead of ~2.5 s.
- `GET /api/pi/stream.mjpg` → stream proxy of `PI_BRIDGE_URL/stream.mjpg` (use `http.request`, forward the
  upstream `Content-Type` incl. boundary, pipe bytes unbuffered, destroy upstream when the client closes).
- `GET /api/pi/snapshot.jpg` → proxy. `GET|POST /api/pi/pantilt`, `POST /api/pi/pantilt/center`,
  `POST /api/pi/pantilt/release`, `GET|POST /api/pi/attention`, `GET /api/pi/gestures`,
  `POST /api/pi/gesture`, `POST /api/pi/gesture/stop`, `GET /api/pi/status`, `GET|POST /api/pi/presence`,
  `GET|POST /api/pi/watch`, `POST /api/pi/capture`, `GET /api/pi/captures`, `POST /api/pi/notify` → JSON
  proxies (forward body, status code, and JSON); `GET /api/pi/captures/:name.jpg` → raw JPEG proxy.
- `GET /api/config` also reports `gestures` (bool), `lanes: {quick, deep}` (the reasoning efforts) and `reminders: true`.
- Reminders (`NOVA_DATA_DIR/reminders.json`, default `~/.local/share/nova-dashboard`): `GET /api/reminders?since=<ms>` →
  `{"now","pending":[...],"fired":[items fired after since]}`; `POST /api/reminders {"text","at"|"in_s","kind":"timer"|"reminder","notify"}`
  → 201 + the item; `DELETE /api/reminders/:id`; `DELETE /api/reminders` clears pending. Items: `{id, kind, text, at, createdAt,
  notify, fired, firedAt}`. A 1 s scheduler marks due items fired, POSTs `{"name":"wave"}` to the bridge and, when `notify`,
  `{"text": "⏰ Reminder: …"}` to `PI_BRIDGE_URL/notify`. Fired items are kept 24 h.
- Errors → JSON `{"error":"..."}` with proper status. Log one line per request (method, path, status, ms)
  except for `/api/stats` polling (log those at debug only). Print a banner on start with the URL and the
  Hermes/Pi targets. Graceful SIGINT shutdown.

## 7. Orb renderer (`public/orb.js`)

```js
export function createOrb(canvas, { sensitivity = 1 } = {})
// → { setAudio({ level, bass, mid, treble }), setState(state), setSensitivity(n), resize(), destroy() }
// state ∈ 'idle' | 'listening' | 'thinking' | 'speaking'; all audio values are 0..1
```
Canvas 2D renderer with a transparent background, circular core glow, projected orbital paths, and sparse
cyan particles. DPR-aware (cap 1.6); rAF pauses when hidden. Smooth audio and state inputs internally so the
visual never jitters. Idle is calm; listening responds to level/bass/treble; thinking rotates faster; speaking
pulses. The glow must remain radial and never reveal the square canvas boundary.

`public/orb-test.html` — black page, one square 480px canvas, imports `./orb.js`, reads
`?state=listening&level=0.7&anim=1` from the query string; when `anim=1` it drives synthetic audio
(`level = base + 0.25*sin(t*3)`, bass/mid/treble derived) so screenshots show the reactive look. Also a
`?variant=orb_v2.js` param to load a different module file (used while judging variants).

## 8. Mic analyser (`public/audio.js`)

```js
export function createMicAnalyser()
// → { start(): Promise<void>, stop(): void, isActive(): boolean, getLevels(): { level, bass, mid, treble, raw } }
```
`AudioContext` + `getUserMedia({audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true}})`
+ `AnalyserNode` (fftSize 1024, smoothingTimeConstant 0.8). `raw` = RMS of the time-domain buffer;
`level` = raw after a noise gate (~0.008) and soft AGC (normalize against a slowly decaying recent peak, so
quiet rooms still animate and loud rooms don't clip), clamped 0..1. Bands from frequency data: bass 20–250 Hz,
mid 250–2000 Hz, treble 2000–8000 Hz, each normalized 0..1. `start()` must resume a suspended AudioContext
(user gesture). Release tracks on `stop()`.

## 9. Speech (`public/speech.js` + `public/phrases.js`)

```js
export function stripForSpeech(text): string          // markdown → something worth reading aloud
export function createSpeech({ onCommand, onStatus, onInterim, onTtsFallback,
                               onConversation, onBargeIn, onInterrupt, onSignoff })
// → { supported, startListening(), stopListening(), isListening(),
//     setWakeWord(enabled, phrase = 'nova'),
//     setConversation({ enabled, windowMs, bargeIn }), setAcks(enabled),
//     openFollowUp(), holdForUser(), closeFollowUp(), endConversation(), inConversation(),
//     speak(text, {onStart}), speakChunk(text, {onStart}), speakAck(text), whenIdle(), cancelSpeech(),
//     isSpeaking(), prewarm(phrases?) }
```
`onStart` fires once, when that chunk's audio actually begins (not when it is queued or synthesized);
the reply speaker uses it to fire the gesture cues attached to that sentence.
Uses `window.SpeechRecognition || window.webkitSpeechRecognition` (Chrome/Edge/Safari), `continuous=true`,
`interimResults=true`, `lang='en-US'`; auto-restart on `onend` while listening (Chrome stops after silence),
with backoff on repeated `not-allowed`/`network` errors. `onInterim(text)` for live captions.

### 9.1 Conversation model

Three states, reported through `onStatus`:

| state | how it is entered | what a plain utterance does |
|---|---|---|
| `listening` | default | ignored — the wake word is required |
| `awake` | wake word heard on its own (8 s) | treated as the command |
| `open` | `openFollowUp()`, called after Nova finishes speaking (default 30 s) | treated as the command |

The wake word works in every state. `windowMs: 0` keeps the window open until an end phrase. Ending the
conversation early: `goodbye` / `bye` / `that's all` / `stop listening` / `go to sleep` / `we're done` →
`onSignoff()` and back to `listening`. Wake word off = every final transcript is a command, as before.

### 9.2 Interrupting her

`stop` / `wait` / `hold on` / `never mind` / …, or the wake word on its own, cancels playback, aborts
the answer still generating, and calls `holdForUser()`: she goes quiet and keeps listening for at least
`INTERRUPT_HOLD_MS` (25 s) with **no wake word needed** — even when continuous conversation is switched
off, because interrupting her is itself a request for her attention. The wake-word form also fires
`onInterrupt()` so she answers "Yes?"; a stop phrase is answered with silence. `"nova stop"` counts as a
stop, not as a command named "stop".

### 9.3 Hearing herself

The speaker and the microphone share a room, so her own voice returns through the mic a beat later.
Two independent filters, because either alone leaks:

1. **`isSelfEcho(text)`** — ≥60 % of the meaningful words heard appear in something she said in the last
   `ECHO_MEMORY_MS` (20 s). Checked on *every* transcript, not only while audio is playing, because
   Chrome delivers finals long after the audio that produced them; and against everything recently
   spoken, not just the sentence currently playing, because a transcript of sentence three lands while
   sentence four is in the air. An utterance of only stop-words ("yes") counts as echo *only* if she
   just said those words — otherwise it is a real answer to a question.
2. **`startedOverReply(startedAt, precise)`** — the utterance *began* while she was delivering an
   answer, so it must carry the wake word or a stop phrase to count. This catches her own voice
   mis-transcribed into words she never said, which word matching cannot see. Utterance start comes
   from the first interim result; without one, only the delivery time is known, so the tail widens from
   250 ms to `ECHO_TAIL_MS`.

Even past both filters, a barge-in's *command half* is re-tested with `isSelfEcho`: "…I'll check that
for you…" can transcribe as "nova check that for you", which survives the whole-utterance test only
because the stray wake word dilutes it.

Neither filter applies once she has handed the floor over — `awaitingUser`, set by `openFollowUp()` and
`holdForUser()` and cleared when a reply chunk starts playing. Answering the instant she stops, or
continuing straight after interrupting her, always works. Short fillers ("On it.", "Yes?") never create
a guarded window at all: the user is meant to talk over those.

### 9.4 Speech output

One serial queue; `speakChunk` (reply) and `speakAck` (filler) never overlap. A filler is dropped
whenever a reply is playing or queued, so Nova never stalls a real answer to say "one moment". The
queue prefetches the next item's audio as soon as the current one starts playing — synthesis takes
~2.5 s on a cache miss, which would otherwise be a silent gap between every sentence. `whenIdle()`
resolves when the queue drains; `cancelSpeech()` clears it. On a server/provider/playback failure,
notify through `onTtsFallback` and use browser `speechSynthesis` as a graceful fallback.

### 9.5 Fillers (`public/phrases.js`)

`ACK_PHRASES` (spoken when a quick reply has not arrived within ~1.1 s), `DEEP_PHRASES` (spoken the
instant a message is routed down the deep lane), `TOOL_PHRASES` (a tool call started while nothing
had been said), `WORKING_PHRASES` (after 20 s of silence while still working), `INTERRUPT_PHRASES`, `SIGNOFF_PHRASES`,
plus `ALL_PHRASES` and
`pickPhrase(list, recent, key)` which avoids repeating the previous choice. Imported by both the browser
and `server.js`, which pre-synthesizes the whole list into the TTS cache at boot. Phrases must stay short,
honest (never claim progress Nova cannot know about) and free of markdown, digits and emoji.

## 10. Pi bridge (`pi/nova_bridge.py`, Python 3.13 stdlib + picamera2 + smbus2, port 8433, bind 0.0.0.0)

`http.server.ThreadingHTTPServer`; every response has `Access-Control-Allow-Origin: *` and handles `OPTIONS`.
Runs as systemd user service `nova-bridge` (unit in `pi/nova-bridge.service`: `ExecStart=/usr/bin/python3 /home/rajarshi/nova-bridge/nova_bridge.py`,
`Restart=always`, `WantedBy=default.target`, `WorkingDirectory=/home/rajarshi/nova-bridge`). `pi/deploy.sh`
(run from the Mac): scp `nova_bridge.py` + unit to the Pi, install the unit into
`~/.config/systemd/user/`, `systemctl --user daemon-reload && systemctl --user enable --now nova-bridge`,
then curl `/health` from the Mac. No sudo anywhere.

- `GET /health` → `{"status":"ok","camera":true,"pantilt":true,"attention":true,"hostname":"raspberrypi","version":"1.2"}`
  (`camera` = picamera2 importable and a camera is detected; `pantilt` = PCA9685 answered on I2C;
  `attention` = numpy present and the servos usable, so face tracking can run).
- `GET /stats` → `{"hostname","cpu_percent","cpu_per_core":[...],"ncpu","mem":{"total","used","available","percent"},"disk":{"total","used","percent"},"temp_c","load":[l1,l5,l15],"uptime_s","cpu_freq_mhz","throttled": "0x0"|null}`
  CPU from `/proc/stat` deltas sampled by a background thread every 2 s; mem from `/proc/meminfo`
  (available = MemAvailable); disk `shutil.disk_usage('/')`; temp `/sys/class/thermal/thermal_zone0/temp`/1000;
  throttled via `vcgencmd get_throttled` (null if unavailable); freq from `scaling_cur_freq`/1000.
- `POST /tts` → invoke Hermes's `tools.tts_tool.text_to_speech_tool` inside its existing venv, return the
  generated audio with `X-TTS-Provider`, and remove the temporary file. Serialize synthesis requests.
- `GET /stream.mjpg` → `multipart/x-mixed-replace; boundary=FRAME`, 640×480, ~15 fps, JPEG q≈80. Camera
  via picamera2 following the official `mjpeg_server.py` pattern (`Picamera2()`, `create_video_configuration(main={"size": (640, 480)}, transform=Transform(hflip=1, vflip=1), controls={"FrameRate": 15})`,
  `JpegEncoder`, `FileOutput(StreamingOutput)` with a `threading.Condition`). Start the camera lazily on the
  first client; stop it ~5 s after the last client disconnects (timer thread). Serialize start/stop with a lock.
- `GET /snapshot.jpg` → latest frame if streaming, else start the camera, grab one frame, stop.
- `GET /pantilt` → `{"ok":true,"pan":90,"tilt":90,"limits":{"pan":[10,170],"tilt":[30,150]},"base":{},"target":{},"offset":{},"moving","released","gesture","queued","ambient"}`
- `POST /pantilt` body `{"pan": 100, "tilt": 80, "speed": 200}` (pan/tilt either optional) → clamp to limits and
  glide the **base pose** there at `speed` deg/s (default 200) in the 40 Hz motion loop (latest command retargets),
  respond immediately with the target angles. `POST /pantilt/center` → 90/90. `POST /pantilt/release` → stop pulses
  (PWM off, no holding torque). PCA9685 code: port from `pantilt_test.py` (bus 1, 0x40, MODE1/PRESCALE init at 50 Hz,
  auto-increment block writes). Init the servos at startup to 90/90 then release after 1 s. If smbus2/the device is
  unavailable → `pantilt:false` and 503 `{"error":"pantilt unavailable"}`.
- Motion is three summed layers: base pose (tracker / d-pad / park), a **gesture** offset script, and an **ambient**
  "talking" motion. `GET /gestures` lists the vocabulary (`name`, `aliases`, `description`, `duration_s`);
  `POST /gesture {"name","intensity","speed","queue"}` plays one (404 + `known` for an unknown name; aliases such as
  `yes`, `no`, `hello`, `bye` resolve); `POST /gesture/stop` cancels. `POST /attention {"mode":"speak"}` turns the
  ambient motion on for the lease period. Gestures never fight the tracker: it pauses integration while one plays.
- Face detection is OpenCV Haar cascades (frontal every frame, profile + mirrored profile throttled) on a 320×240
  `lores` luma plane, from the bridge venv (`~/nova-bridge/venv`, `--system-site-packages`); without cv2 the
  skin-chroma finder is the fallback. `/health` reports `face_detector: "haar"|"skin"|null`, `gestures`, `presence`,
  `watch`, `telegram`, `captures`. A search that finds nobody straight ahead scans ±32° before parking.
- Desk companion: `GET /status` (presence + watch + attention + head, one poll); `GET|POST /presence` (`{"enabled"}`);
  `GET|POST /watch` (`{"enabled","notify"}`; events `{id, at, kind: motion|face, capture, area, notified}`);
  `POST /capture {"label","notify"}` → `{"name","url","bytes","notified"}` saved under `~/nova-captures`;
  `GET /captures`, `GET /captures/<name>`; `POST /notify {"text","capture"?}` → Telegram through Nova's bot;
  `GET|POST /vibe` (`{"enabled","force","amplitude"}`; state carries `listening`, `active`, `bpm`, `confidence`,
  `level_db`, `next_beat_in_s`, `vibing`, `forced`) — the USB microphone is captured via `pw-record` at 16 kHz, an
  onset envelope (exponentially detrended, all-band + bass flux) + time-averaged autocorrelation tempo + comb phase
  drive an `AmbientVibe` motion layer (smooth asymmetric nods, six cross-faded moves, a flourish every few bars,
  45 ms output low-pass) whenever a steady beat is heard above -50 dBFS (confidence ≥ 0.19, 5 of 8 estimates
  agreeing) and the head is idle
  (`TELEGRAM_BOT_TOKEN` + first `TELEGRAM_ALLOWED_USERS` id from `~/.hermes/.env`, or `NOVA_TELEGRAM_TOKEN/CHAT`).
  While idle the attention thread keeps the sensor and checks for a face every 3 s (presence), or every 0.5 s with
  frame differencing when the watch is armed; the head parks at head height before the servos relax so the idle
  camera can see a face. An arrival after ≥180 s away makes the head look up and nod (once per 20 min).
- Log to stdout (journal). Never crash on a client disconnect (catch `BrokenPipeError`/`ConnectionResetError`).

## 11. Frontend behaviour (`public/app.js` + `index.html`)

- Clock: `h:mm:ss AM/PM` + `Month D, YYYY`, updated every second.
- `/api/health` every 15 s → Online/Offline pill, status pill text, greeting variant.
- `/api/stats` every 3 s → System Stats. Show **Pi** stats when `pi` is non-null (small `PI` tag in the panel
  header, tooltip "raspberrypi.local"), else Mac stats (tag `MAC`). Setting to force one. Bars: CPU %, RAM
  (`used GB` label, percent width). Tiles: CPU %, Memory %, Disk `used/total GB`, Temp °C (Pi only).
  Refresh icon forces an immediate fetch and spins while loading.
- `/api/weather` every 10 min (+ refresh icon). Unit toggle °C/°F in settings (header chip follows).
- Camera: power toggles on/off. Source (setting): `pi` → `<img src="/api/pi/stream.mjpg?ts=…">`;
  `local` → `getUserMedia({video:true})` into a `<video>`. Snapshot icon downloads the current frame
  (`nova-snapshot-<timestamp>.jpg`; for `pi` fetch `/api/pi/snapshot.jpg`, for `local` draw the video to a canvas).
  When the Pi source is live and `pantilt` is available, show a compact d-pad overlay (◀ ▲ ▼ ▶ + center) in
  the viewport corner; each press = ±10°; arrow keys work while the viewport is focused. Caption text reflects
  state ("Streaming from raspberrypi.local · 640×480", "Camera is inactive. Click the power button to start.",
  error text on failure). The center camera button toggles the same power state.
- Attention (setting `Look at me`, on by default): the dashboard derives one of five intents from
  state it already tracks and POSTs it to `/api/pi/attention` on transitions plus a 4 s heartbeat —
  `speak` while her voice is actually playing (the Pi layers the talking motion over tracking),
  `think` while tools are running or nothing has been said or written yet, `wake` while Nova is
  listening or answering silently, `tool` as a one-shot pulse when a tool starts (skipped while she
  is mid-sentence), and `sleep` otherwise. Hook points: `updateStatus()` (which every state change already funnels
  through, so the push is change-detected — it can be called from the orb's rAF loop), the
  `onCommand` callback in `initVoice()` (because `speech.js` only emits `onStatus('awake')` for a
  *bare* wake word — "nova, what's the weather" goes straight to `dispatch()`), and `onTool` in
  `sendMessage()`. A `pagehide` handler sends `sleep` with `keepalive`. The Pi owns the actual
  state machine and holds a 12 s lease, so a closed tab or a sleeping laptop parks and releases the
  servos rather than leaving them staring at a wall.
- System Uptime: session timer `HH:MM:SS` since page load (shown in the panel header too); tiles: Session
  (counter in `localStorage`, +1 per page load) and Commands (messages sent this session); System Load bar =
  Pi `load[0]/ncpu*100` (fallback Mac), label Low <30 / Moderate <70 / High. Expand icon reveals two extra rows:
  Pi uptime (e.g. `1h 34m`) and Hermes version.
- Conversation: greeting bubble on load — `Hello, I am NOVA. How can I assist you today?` (offline variant:
  `Hello, I am NOVA. The Nova backend is offline. Some features may be limited.`). User bubbles right-aligned
  (accent-tinted), assistant left; timestamps `h:mm AM/PM`. Assistant text rendered with a small **safe**
  markdown-lite renderer (escape HTML first; then code fences, inline code, bold, italics, links, bullet lists,
  line breaks). Streaming: a typing indicator (3 dots) until the first delta, then the bubble grows with text;
  tool events show as small inline chips (`💻 terminal · ls -la`, spinner while running → check when completed).
  Stop button (replaces send while streaming) aborts the fetch. Enter sends, Shift+Enter newline, textarea
  auto-grows to 5 lines. `New` resets `session_id` and starts a fresh Hermes transcript. `History` lists
  recent sessions from Hermes and reopens the selected transcript for continued chat.
  `Extract Conversation` downloads `nova-conversation-YYYYMMDD-HHMMSS.md`. Persist messages + session_id in
  `localStorage` (`nova.conversation`) so a reload keeps the thread; Clear removes it.
- Orb: `createOrb(canvas)`; feed `getLevels()` every frame while the mic is active (else zeros). States:
  `idle` (mic off, nothing happening), `listening` (mic on), `thinking` (awaiting/streaming Nova),
  `speaking` (TTS playing — polled from the speech queue each frame). Orb sensitivity slider in settings.
- Mic button: toggles mic capture (`audio.start()`) + speech recognition, and warms the filler-phrase
  cache once (`speech.prewarm()`). Status pill text:
  `Listening for wake word...` (wake word on + mic on) / `Listening...` (dictation) / `Yes?` (awake) /
  `Go ahead — no wake word needed` (follow-up window open) / `Thinking...` / `Speaking...` /
  `Mic off — click the mic to enable` / `Nova backend offline` /
  `Speech recognition not supported in this browser` (mic still drives the orb).
  Interim transcript shows as faint text under the status pill (echo of Nova's own voice is not shown).
- Voice turns (§9): a spoken command opens the follow-up window immediately and `sendMessage` re-arms it
  once Nova has actually stopped talking, so the next turn needs no wake word. A spoken command arriving
  while Nova is thinking or talking stops the current answer and replaces it (barge-in); an interruption
  carrying no command leaves her waiting instead (§9.2). `bargeInSeq` is bumped on every voice
  interruption so the turn it cuts short can tell, and leaves the cancelled speech and the longer
  listening window alone rather than undoing them.
- While a voice reply is generating, Nova speaks fillers so the wait is never silent — but never in front
  of a fast answer: a quick-lane reply that has not produced text within 1.1 s gets one `ACK_PHRASES`
  entry; a deep-lane request gets a `DEEP_PHRASES` entry the moment the `lane` event arrives; a
  `TOOL_PHRASES` entry plays when the first tool starts before anything was said; `WORKING_PHRASES`
  after 20 s of silence while still working. Fillers are skipped whenever real speech is playing, and
  suppressed entirely by the *Thinking acknowledgements* setting.
- The reply itself is spoken **while it streams**: completed sentences are handed to the speech queue as
  they arrive (≥40 chars for the first chunk, ≥80 after — or any complete sentence once no more text has
  arrived for 350 ms, so a deep-lane "Let me check that, sir." is heard before the tool runs). Text
  inside an unterminated ``` fence is held back and never read aloud.
- Gesture cues (`gesture` events) are attached to the sentence they fall in and fired (`POST /api/pi/gesture`)
  from that chunk's `onStart`; with speech off they fire on arrival. Setting *Expressive gestures* (default on)
  gates both the cues and the `speak` intent; `gestures: false` in the chat body then stops the server from
  asking Nova for cues at all.
- Local commands (`handleLocalCommand`) are carried out by the console without Hermes and echoed as an italic
  action line: reminders/timers (parsed in the browser — durations in words or digits, "at 3:30 pm", "tomorrow at
  9", noon/midnight — then `POST /api/reminders`; "what are my reminders", "cancel the timer / all reminders");
  photos ("take a photo [and send it to me]", "send me the photo" → `/api/pi/capture`, `/api/pi/notify`); desk watch
  ("watch my desk" / "stop watching" → `/api/pi/watch`); emotes ("Nova, nod" / "shake your head" / "look around" /
  "bow" / "dance" / "celebrate" / "laugh" / "look sad" / "act surprised" / "wave" / "peek" / "double take" / "shiver" /
  "look left|right|up|down" / "look at me" / "hold still" / "center"). Politeness prefixes are stripped, ≤6 words.
  Vision phrasing ("what is this?", "what am I holding?", "read this", "what do you see?", "describe my desk") is
  not intercepted: it goes to Nova with a live frame attached; the composer's camera button attaches one to the
  next typed message.
- The page polls `GET /api/pi/status` every 4 s: the "At desk" tile and the camera caption show presence and the
  watch state; a new arrival (the `arrivals` counter) is silent in the transcript — there is no time-of-day
  greeting — and, with *Daily briefing on first arrival*, sends "give me my daily briefing" once a
  day; *Break reminder* (45/60/90 min of `at_desk_s`) speaks a nudge and plays `listen`; a new desk-watch event
  (`last_event.id`) is spoken, toasted and shown with its capture. Presence sensing and the watch's `notify`
  follow the settings (*Presence awareness*, *Desk watch & reminders to Telegram*).
- Vibe: `/api/pi/status` carries `vibe`; while `vibing` the status pill reads `Vibing · N BPM` (state `vibing`) and
  the orb, when the Mac mic is off, is fed a synthetic pulse phase-locked to `next_beat_in_s`. Commands "vibe" /
  "dance mode" / "feel the beat" → `POST /api/pi/vibe {force:true}`, "stop vibing" / "chill" → `{force:false}`.
  Settings *Vibe to music* (`enabled`) and *Vibe intensity* (`amplitude` 0.6/1/1.5) are pushed to the bridge on load
  and on change.
- Reminders panel (left column): pending items with relative/absolute time and a cancel button, a typed quick-add
  ("in 20 minutes to …" / "at 3:30 to …"), clear-all. `GET /api/reminders?since=` is polled every 2–20 s
  depending on what is pending; newly fired items are spoken ("Time's up: …" / "Reminder: …"), toasted and echoed.
- Emotes: a chip row under the status pill (built from `GET /api/pi/gestures`, hidden when the head is offline)
  plays gestures on click, plus Stop. Settings → *Answer style*: `auto` (default) | `quick` | `deep`, sent as
  `mode`. Status pill while streaming: quick → `Thinking...` / `Checking…` (tool running), deep →
  `Looking into it…` / `Working on it…`.
- Keyboard button: focuses the composer. Camera button: toggles the camera panel.
- Settings modal (gear): wake word on/off + phrase (default `nova`); keep the conversation open (default
  on); follow-up window `15 | 30 | 60 s | until "goodbye"` (default 30, disabled when conversation mode is
  off); let me interrupt (default on); thinking acknowledgements (default on);
  Speak replies: `off | voice | always`
  (default `voice` = speak only replies to voice commands); camera source `pi | local` (default `pi`);
  stats source `auto | pi | mac`; orb sensitivity 0.5–2; weather unit `C | F`. Persist in `localStorage`
  (`nova.settings`). Also show read-only connection info from `/api/config` + `/api/health`. Close on Esc /
  backdrop click.
- Toasts (bottom-center, auto-dismiss) for errors (mic denied, chat failure, camera failure).
- Side-column collapse chevrons at the page edges; state persisted.
- Responsive: ≥1200px three columns; 900–1200px narrower side columns; <900px stack (center first).
- Accessibility: every icon button has `aria-label` + `title`; visible focus rings; `prefers-reduced-motion`
  reduces ring rotation/pulses.
- No console errors on load. No external JS libraries.

## 12. Definition of done for each piece

- Server: the `nova-dashboard` Pi user service starts on 8420, every endpoint above returns the documented shape,
  `/api/chat` streams a real Nova reply, `/api/pi/stream.mjpg` proxies frames.
- Pi bridge: deployed and enabled as `nova-bridge` user service, all endpoints curl-tested from the Mac,
  a snapshot saved to the scratchpad and viewed (Read the PNG/JPG) to confirm the image is right-side up and exposed.
- Frontend: loads with zero console errors against the running server; every component in §2 is present;
  screenshot at 1440×900 looks like the reference (dark navy, cyan accents, 3 columns, orb centered).
- Orb: `orb-test.html` screenshots at idle/listening/thinking match §4; smooth in a real browser.
