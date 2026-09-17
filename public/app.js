// NOVA dashboard — application logic (spec §11). Vanilla ES module, zero dependencies.
//
// Sections: utils · state/settings · api · clock · health · stats · weather · camera · attention ·
//           gestures/emotes · uptime · chat (render/markdown/stream/persist/export) ·
//           orb + mic + speech · settings modal · side columns · init

import { createOrb } from './orb.js';
import { createMicAnalyser } from './audio.js';
import { createSpeech } from './speech.js';
import { ACK_PHRASES, TOOL_PHRASES, DEEP_PHRASES, WORKING_PHRASES, INTERRUPT_PHRASES, SIGNOFF_PHRASES, pickPhrase } from './phrases.js';

/* =============================================================================================
   Utils
   ============================================================================================= */

const $ = (id) => document.getElementById(id);
const GiB = 1024 ** 3;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ZERO_AUDIO = Object.freeze({ level: 0, bass: 0, mid: 0, treble: 0 });

const pad2 = (n) => String(n).padStart(2, '0');
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

function fmtClock(d) {
  const h = d.getHours() % 12 || 12;
  return `${h}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}
function fmtDate(d) { return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; }
function fmtShortTime(ts) {
  const d = new Date(ts);
  const h = d.getHours() % 12 || 12;
  return `${h}:${pad2(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}
function fmtHMS(sec) {
  sec = Math.max(0, Math.floor(sec));
  return `${pad2(Math.floor(sec / 3600))}:${pad2(Math.floor((sec % 3600) / 60))}:${pad2(sec % 60)}`;
}
function fmtUptime(sec) {
  if (!isNum(sec)) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
function fmtStamp(d) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function setIcon(svgEl, symbolId) {
  const use = svgEl.querySelector('use');
  if (use) use.setAttribute('href', '#' + symbolId);
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
const storage = {
  get(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw == null ? fallback : JSON.parse(raw); } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota / private mode */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

/* ---- toasts ---- */
function toast(message, kind = 'error', ms = 4200) {
  const host = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'info' ? ' info' : '');
  el.setAttribute('role', 'alert');
  el.innerHTML = `<svg class="icon"><use href="#${kind === 'info' ? 'i-link' : 'i-alert'}"/></svg><span></span>`;
  el.querySelector('span').textContent = message;
  host.appendChild(el);
  while (host.children.length > 4) host.firstElementChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms);
}

/* =============================================================================================
   State & settings
   ============================================================================================= */

const DEFAULT_SETTINGS = Object.freeze({
  wakeWord: true,
  wakePhrase: 'nova',
  conversation: true,      // keep listening after a reply so follow-ups need no wake word
  followUpSec: 30,         // how long that window stays open; 0 = until "goodbye"
  bargeIn: true,           // "nova …" / "stop" interrupts Nova mid-sentence
  acks: true,              // speak short fillers while Nova is thinking
  speak: 'voice',          // off | voice | always
  followMe: true,          // point the pan-tilt head at whoever is talking, and gesture while thinking
  gestures: true,          // Nova's replies carry gesture cues; the head acts them out as she speaks
  lane: 'auto',            // auto | quick | deep — how much thinking Nova puts into a reply
  presence: true,          // the camera notices when you sit down / leave (idle face check on the Pi)
  briefing: false,         // run the daily briefing the first time you sit down each day
  breakMin: 0,             // suggest a break after this many minutes at the desk (0 = off)
  telegram: true,          // desk-watch events and reminders also go to Telegram (when the Pi has the bot)
  vibe: true,              // the Pi's mic listens for a beat; the head bobs to music while idle
  vibeAmp: 1,              // 0.6 | 1 | 1.5
  grooveMode: 'vibe',      // vibe | metronome — which control the Groove panel shows
  metroBpm: 100,           // the metronome's tempo
  cameraSource: 'pi',      // pi | local
  statsSource: 'auto',     // auto | pi | mac
  sensitivity: 1,
  unit: 'C',               // C | F
});

const state = {
  settings: { ...DEFAULT_SETTINGS, ...(storage.get('nova.settings', {}) || {}) },
  config: null,
  health: null,            // null until first poll; {hermes:{ok}, pi_bridge:{ok,camera,pantilt}}
  stats: null,
  statsError: null,
  weather: null,
  weatherError: null,
  pageStart: Date.now(),
  commands: 0,
  sessionNo: 1,
  ui: (() => {
    // v2 made the side columns drawers that start closed — a voice-first screen shows only the orb.
    // Stored state from v1 had them pinned open, so drop those two keys once on upgrade.
    const saved = { ...(storage.get('nova.ui', {}) || {}) };
    if (saved.v !== 2) { delete saved.left; delete saved.right; saved.v = 2; }
    return { left: false, right: false, uptimeExpanded: false, ...saved };
  })(),
};

function saveSettings() { storage.set('nova.settings', state.settings); }
function saveUi() { storage.set('nova.ui', state.ui); }

/* =============================================================================================
   API
   ============================================================================================= */

async function getJSON(path, timeoutMs = 5000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(path, { signal: ac.signal, headers: { Accept: 'application/json' }, cache: 'no-store' });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      if (ct.includes('json')) { try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* ignore */ } }
      throw new Error(msg);
    }
    if (!ct.includes('json')) throw new Error('Unexpected response');
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function postJSON(path, body, timeoutMs = 5000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  } finally { clearTimeout(timer); }
}

/**
 * Consume the /api/chat SSE stream. Frames are separated by blank lines; each frame carries
 * `event:` and one or more `data:` lines. Partial chunks are buffered across reads.
 */
async function streamChat({ message, sessionId, mode, voice, gestures, image = null, signal, onDelta, onTool, onDone, onError, onGesture = () => {}, onLane = () => {} }) {
  const res = await fetch('/api/chat', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ message, session_id: sessionId || null, mode: mode || 'auto', voice: !!voice, gestures: !!gestures, ...(image ? { image } : {}) }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  if (!res.body) throw new Error('Streaming responses are not supported by this browser');

  const dispatch = (frame) => {
    let event = 'message';
    const data = [];
    for (const raw of frame.split(/\r?\n/)) {
      if (!raw || raw[0] === ':') continue;
      const i = raw.indexOf(':');
      const field = i === -1 ? raw : raw.slice(0, i);
      let value = i === -1 ? '' : raw.slice(i + 1);
      if (value[0] === ' ') value = value.slice(1);
      if (field === 'event') event = value.trim();
      else if (field === 'data') data.push(value);
    }
    if (!data.length) return;
    const text = data.join('\n');
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { text }; }
    if (payload === null || typeof payload !== 'object') payload = { text: String(payload) };
    switch (event) {
      case 'delta': if (typeof payload.text === 'string') onDelta(payload.text); break;
      case 'tool': onTool(payload); break;
      case 'gesture': onGesture(payload); break;
      case 'lane': onLane(payload); break;
      case 'done': onDone(payload); break;
      case 'error': onError(payload.message || payload.error || 'Unknown error'); break;
      default: if (typeof payload.text === 'string') onDelta(payload.text);
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const SEP = /\r?\n\r?\n/;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let m;
    while ((m = SEP.exec(buf))) {
      dispatch(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
    }
  }
  buf += decoder.decode();
  if (buf.trim()) dispatch(buf);
}

/* =============================================================================================
   Clock
   ============================================================================================= */

function startClock() {
  const timeEl = $('clockTime'), dateEl = $('clockDate');
  const tick = () => { const d = new Date(); timeEl.textContent = fmtClock(d); dateEl.textContent = fmtDate(d); };
  tick();
  setInterval(tick, 1000);
}

/* =============================================================================================
   Health
   ============================================================================================= */

const OFFLINE_HEALTH = Object.freeze({ hermes: { ok: false }, pi_bridge: { ok: false, camera: false, pantilt: false }, unreachable: true });

function hermesOnline() { return !!(state.health && state.health.hermes && state.health.hermes.ok); }
function piBridgeOk() { return !!(state.health && state.health.pi_bridge && state.health.pi_bridge.ok); }
function pantiltOk() { return piBridgeOk() && !!state.health.pi_bridge.pantilt; }

async function pollHealth() {
  try { state.health = await getJSON('/api/health', 6000); }
  catch { state.health = { ...OFFLINE_HEALTH }; }
  renderHealth();
}

function renderHealth() {
  const online = hermesOnline();
  const pill = $('onlinePill');
  pill.classList.toggle('online', online);
  pill.classList.toggle('offline', !online);
  $('onlineText').textContent = online ? 'Online' : 'Offline';
  pill.title = online
    ? `Hermes ${state.health.hermes.version || ''} · ${isNum(state.health.hermes.latency_ms) ? state.health.hermes.latency_ms + ' ms' : ''}`.trim()
    : (state.health && state.health.unreachable ? 'Dashboard server unreachable' : 'Hermes agent unreachable');
  $('hermesVersion').textContent = online && state.health.hermes.version ? `v${state.health.hermes.version}` : 'offline';
  renderCameraOverlay();
  renderEmotes();
  renderWatch();
  if (piBridgeOk() && !companion.presenceApplied) { companion.presenceApplied = true; applyPresenceSetting(); pollStatus(); }
  renderConnectionInfo();
  updateStatus();
}

/* =============================================================================================
   System Stats
   ============================================================================================= */

let statsInFlight = false;

function pickStats() {
  const s = state.stats;
  if (!s) return null;
  const pref = state.settings.statsSource;
  const pi = s.pi && typeof s.pi === 'object' ? s.pi : null;
  const host = s.host && typeof s.host === 'object' ? s.host : null;
  if (pref === 'pi') return pi ? { src: 'pi', d: pi } : { src: 'pi', d: null };
  if (pref === 'mac') return host ? { src: 'mac', d: host } : { src: 'mac', d: null };
  return pi ? { src: 'pi', d: pi } : { src: 'mac', d: host };
}

function barClass(pct) { return pct >= 85 ? 'bad' : pct >= 65 ? 'warn' : ''; }
function setBar(el, pct) {
  const p = isNum(pct) ? clamp(pct, 0, 100) : 0;
  el.style.width = p + '%';
  el.className = barClass(p);
}

async function pollStats(force = false) {
  if (statsInFlight && !force) return;
  statsInFlight = true;
  const btn = $('statsRefresh');
  const started = performance.now();
  btn.classList.add('spinning');
  try {
    state.stats = await getJSON('/api/stats', 5000);
    state.statsError = null;
  } catch (e) {
    state.statsError = e.message || 'unavailable';
  } finally {
    const wait = Math.max(0, 500 - (performance.now() - started));
    setTimeout(() => btn.classList.remove('spinning'), wait);
    statsInFlight = false;
  }
  renderStats();
  renderLoad();
}

function renderStats() {
  const tag = $('statsTag'), note = $('statsNote');
  const picked = pickStats();
  const tempWrap = $('tileTempWrap'), tiles = $('statsTiles');

  if (!picked || !picked.d) {
    tag.textContent = picked ? picked.src.toUpperCase() : '—';
    tag.className = 'tag muted';
    tag.title = picked && picked.src === 'pi' ? 'Pi bridge offline' : 'No data';
    $('statCpuPct').textContent = '—'; setBar($('statCpuBar'), 0);
    $('statRamLabel').textContent = '—'; setBar($('statRamBar'), 0);
    $('tileMem').textContent = '—'; $('tileDisk').textContent = '—';
    tempWrap.hidden = true; tiles.dataset.count = '2';
    note.hidden = false;
    note.textContent = state.statsError
      ? 'Stats unavailable — dashboard server offline'
      : (picked && picked.src === 'pi' ? 'Raspberry Pi bridge is offline' : 'Waiting for system stats…');
    return;
  }

  const { src, d } = picked;
  tag.textContent = src === 'pi' ? 'PI' : 'HOST';
  tag.className = 'tag';
  tag.title = src === 'pi' ? 'Raspberry Pi bridge' : (d.hostname || 'dashboard host');
  note.hidden = !state.statsError;
  if (state.statsError) note.textContent = 'Showing last known stats — server unreachable';

  const cpu = isNum(d.cpu_percent) ? Math.round(d.cpu_percent) : null;
  const mem = d.mem || {};
  const disk = d.disk || {};
  const memPct = isNum(mem.percent) ? Math.round(mem.percent) : (isNum(mem.used) && isNum(mem.total) ? Math.round(mem.used / mem.total * 100) : null);
  const diskPct = isNum(disk.percent) ? Math.round(disk.percent) : null;

  $('statCpuPct').textContent = cpu == null ? '—' : `${cpu}%`;
  setBar($('statCpuBar'), cpu);
  $('statRamLabel').textContent = isNum(mem.used) ? `${(mem.used / GiB).toFixed(1)} GB` : '—';
  setBar($('statRamBar'), memPct);
  $('tileMem').textContent = memPct == null ? '—' : `${memPct}%`;
  $('tileDisk').textContent = isNum(disk.used) && isNum(disk.total)
    ? `${Math.round(disk.used / GiB)}/${Math.round(disk.total / GiB)}`
    : (diskPct == null ? '—' : `${diskPct}%`);

  const showTemp = src === 'pi' && isNum(d.temp_c);
  tempWrap.hidden = !showTemp;
  tiles.dataset.count = showTemp ? '3' : '2';
  if (showTemp) $('tileTemp').textContent = `${d.temp_c.toFixed(1)}°C`;
}

/* =============================================================================================
   Weather
   ============================================================================================= */

const WX_ICON = {
  clear: ['i-sun', 'i-moon'],
  'partly-cloudy': ['i-cloud-sun', 'i-cloud-moon'],
  cloudy: ['i-cloud', 'i-cloud'],
  fog: ['i-cloud-fog', 'i-cloud-fog'],
  drizzle: ['i-cloud-drizzle', 'i-cloud-drizzle'],
  rain: ['i-cloud-rain', 'i-cloud-rain'],
  snow: ['i-cloud-snow', 'i-cloud-snow'],
  thunder: ['i-cloud-thunder', 'i-cloud-thunder'],
};

function fmtTemp(c, decimals = 1) {
  if (!isNum(c)) return `--.-°${state.settings.unit}`;
  const v = state.settings.unit === 'F' ? c * 9 / 5 + 32 : c;
  return `${v.toFixed(decimals)}°${state.settings.unit}`;
}

let weatherInFlight = false;
async function pollWeather() {
  if (weatherInFlight) return;
  weatherInFlight = true;
  const btn = $('weatherRefresh');
  const started = performance.now();
  btn.classList.add('spinning');
  try {
    state.weather = await getJSON('/api/weather', 8000);
    state.weatherError = null;
  } catch (e) {
    state.weatherError = e.message || 'unavailable';
  } finally {
    const wait = Math.max(0, 500 - (performance.now() - started));
    setTimeout(() => btn.classList.remove('spinning'), wait);
    weatherInFlight = false;
  }
  renderWeather();
}

function renderWeather() {
  const w = state.weather;
  const note = $('wxNote');
  if (!w) {
    $('hdrTemp').textContent = fmtTemp(null);
    $('hdrCity').textContent = '—';
    $('wxTemp').textContent = fmtTemp(null);
    $('wxCity').textContent = state.weatherError ? 'Location unknown' : 'Locating…';
    $('wxDesc').textContent = state.weatherError ? 'no data' : 'waiting for weather';
    $('wxHumidity').textContent = '—'; $('wxWind').textContent = '—'; $('wxFeels').textContent = '—';
    setIcon($('wxIcon'), 'i-cloud');
    note.hidden = !state.weatherError;
    note.textContent = 'Weather unavailable — dashboard server offline';
    return;
  }
  const city = w.city || 'Unknown';
  const place = w.country ? `${city}, ${w.country}` : city;
  $('hdrTemp').textContent = fmtTemp(w.temp_c);
  $('hdrCity').textContent = city;
  $('hdrWeather').title = `${w.description || ''} · ${place}`.trim();
  $('wxTemp').textContent = fmtTemp(w.temp_c);
  $('wxCity').textContent = place;
  $('wxDesc').textContent = w.description || '—';
  $('wxHumidity').textContent = isNum(w.humidity) ? `${Math.round(w.humidity)}%` : '—';
  $('wxWind').textContent = isNum(w.wind_ms) ? w.wind_ms.toFixed(1) : '—';
  $('wxFeels').textContent = fmtTemp(w.feels_like_c);
  const pair = WX_ICON[w.icon] || WX_ICON.cloudy;
  setIcon($('wxIcon'), pair[w.is_day === 0 || w.is_day === false ? 1 : 0]);
  note.hidden = !state.weatherError;
  if (state.weatherError) note.textContent = 'Showing last known weather — server unreachable';
}

/* =============================================================================================
   Camera
   ============================================================================================= */

const PI_CAMERA_RETRY_DELAYS = [750, 1500, 3000, 5000];
const camera = {
  on: false, source: 'pi', live: false, error: null, localStream: null, angles: null, anglesAt: 0,
  busy: false, retryTimer: null, generation: 0,
};

function camEls() {
  return {
    viewport: $('camViewport'), img: $('camImg'), video: $('camVideo'), placeholder: $('camPlaceholder'),
    caption: $('camCaption'), dpad: $('camDpad'), power: $('camPower'), snap: $('camSnapshot'), center: $('btnCamera'),
  };
}

function setCaption(text, cls = '') {
  const c = $('camCaption');
  c.textContent = text;
  c.className = 'cam-caption' + (cls ? ' ' + cls : '');
  $('camViewport').classList.toggle('live', cls === 'live');
  $('camViewport').classList.toggle('error', cls === 'error');
}

function setCameraPlaceholder(text) {
  const label = $('camPlaceholder').querySelector('span');
  if (label) label.textContent = text;
}

function renderCameraButtons() {
  const { power, snap, center } = camEls();
  power.classList.toggle('on', camera.on);
  power.setAttribute('aria-pressed', String(camera.on));
  power.title = camera.on ? 'Turn camera off' : 'Turn camera on';
  center.classList.toggle('active', camera.on);
  center.classList.toggle('live', camera.on && camera.live);
  center.setAttribute('aria-pressed', String(camera.on));
  snap.disabled = !(camera.on && camera.live);
  renderCameraOverlay();
}

function renderCameraOverlay() {
  const dpad = $('camDpad');
  const show = camera.on && camera.live && camera.source === 'pi' && pantiltOk();
  if (show && dpad.hidden) syncPantilt();
  dpad.hidden = !show;
}

async function setCamera(on) {
  const { img, video, placeholder } = camEls();
  if (on === camera.on) return;
  if (on) drawers.open('left');
  camera.generation += 1;
  if (camera.retryTimer) { clearTimeout(camera.retryTimer); camera.retryTimer = null; }
  if (!on) {
    camera.on = false; camera.live = false; camera.error = null;
    img.onload = img.onerror = null;
    img.removeAttribute('src'); img.hidden = true;
    if (camera.localStream) { for (const t of camera.localStream.getTracks()) t.stop(); camera.localStream = null; }
    video.srcObject = null; video.hidden = true;
    placeholder.hidden = false;
    setCameraPlaceholder('Camera Off');
    setCaption('Camera is inactive. Click the power button to start.');
    renderCameraButtons();
    return;
  }
  camera.on = true; camera.live = false; camera.error = null;
  camera.source = state.settings.cameraSource;
  renderCameraButtons();
  if (camera.source === 'local') await startLocalCamera();
  else startPiCamera(camera.generation);
}

function startPiCamera(generation, attempt = 0) {
  const { img, placeholder } = camEls();
  if (!camera.on || camera.source !== 'pi' || generation !== camera.generation) return;
  camera.retryTimer = null;
  setCameraPlaceholder(attempt ? 'Reconnecting…' : 'Connecting…');
  setCaption(attempt
    ? `Camera start was interrupted — retrying ${attempt}/${PI_CAMERA_RETRY_DELAYS.length}…`
    : 'Connecting to raspberrypi.local…');
  img.onload = () => {
    if (!camera.on || camera.source !== 'pi' || generation !== camera.generation) return;
    camera.live = true; placeholder.hidden = true; img.hidden = false;
    setCaption('Streaming from raspberrypi.local · 640×480', 'live');
    renderCameraButtons();
  };
  img.onerror = () => {
    if (!camera.on || camera.source !== 'pi' || generation !== camera.generation) return;
    img.onload = img.onerror = null;
    img.removeAttribute('src'); img.hidden = true; placeholder.hidden = false;
    camera.live = false;
    if (attempt < PI_CAMERA_RETRY_DELAYS.length) {
      const delay = PI_CAMERA_RETRY_DELAYS[attempt];
      setCameraPlaceholder('Reconnecting…');
      setCaption(`Camera start was interrupted — retrying in ${(delay / 1000).toFixed(delay < 1000 ? 2 : 1)}s…`);
      renderCameraButtons();
      camera.retryTimer = setTimeout(() => startPiCamera(generation, attempt + 1), delay);
      return;
    }
    camera.on = false;
    const why = piBridgeOk() ? 'stream failed' : 'Pi bridge offline';
    setCameraPlaceholder('Camera Unavailable');
    setCaption(`Camera stream unavailable — ${why}.`, 'error');
    renderCameraButtons();
    toast(`Camera stream failed (${why})`);
  };
  img.hidden = true;
  img.src = `/api/pi/stream.mjpg?ts=${Date.now()}&attempt=${attempt}`;
}

async function startLocalCamera() {
  const { video, placeholder } = camEls();
  setCaption('Requesting camera access…');
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('getUserMedia not supported');
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    if (!camera.on || camera.source !== 'local') { for (const t of stream.getTracks()) t.stop(); return; }
    camera.localStream = stream;
    video.srcObject = stream;
    video.hidden = false; placeholder.hidden = true;
    try { await video.play(); } catch { /* autoplay policy — muted video should still play */ }
    camera.live = true;
    const s = stream.getVideoTracks()[0] && stream.getVideoTracks()[0].getSettings ? stream.getVideoTracks()[0].getSettings() : {};
    setCaption(`Streaming from this computer${s.width ? ` · ${s.width}×${s.height}` : ''}`, 'live');
    renderCameraButtons();
  } catch (e) {
    camera.on = false; camera.live = false;
    placeholder.hidden = false; video.hidden = true;
    const msg = e && e.name === 'NotAllowedError' ? 'permission denied' : (e && e.message) || 'unavailable';
    setCaption(`Local camera unavailable — ${msg}.`, 'error');
    renderCameraButtons();
    toast(`Camera failed: ${msg}`);
  }
}

async function snapshot() {
  if (!camera.on || !camera.live) return;
  const name = `nova-snapshot-${fmtStamp(new Date())}.jpg`;
  try {
    if (camera.source === 'pi') {
      const res = await fetch(`/api/pi/snapshot.jpg?ts=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      downloadBlob(await res.blob(), name);
    } else {
      const video = $('camVideo');
      const c = document.createElement('canvas');
      c.width = video.videoWidth || 640; c.height = video.videoHeight || 480;
      c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
      if (!blob) throw new Error('could not encode frame');
      downloadBlob(blob, name);
    }
    toast('Snapshot saved', 'info', 2200);
  } catch (e) {
    toast(`Snapshot failed: ${e.message || e}`);
  }
}

const PANTILT_ANGLES_FRESH_MS = 1200;

async function syncPantilt() {
  try {
    const r = await getJSON('/api/pi/pantilt', 4000);
    if (r && isNum(r.pan) && isNum(r.tilt)) {
      camera.angles = { pan: r.pan, tilt: r.tilt, limits: r.limits || { pan: [10, 170], tilt: [30, 150] } };
      camera.anglesAt = Date.now();
    }
  } catch { /* overlay stays usable; nudges will sync from responses */ }
}

async function nudge(dir) {
  if (camera.busy) return;
  camera.busy = true;
  try {
    let r;
    if (dir === 'center') {
      r = await postJSON('/api/pi/pantilt/center', undefined, 4000);
    } else {
      // A nudge is relative, so it needs a current base. While the head is tracking a face the Pi
      // moves it between clicks, and a cached angle would make every press jump by the accumulated
      // drift — so re-read the real position first whenever the cached one has aged.
      if (!camera.anglesAt || Date.now() - camera.anglesAt > PANTILT_ANGLES_FRESH_MS) await syncPantilt();
      const a = camera.angles || { pan: 90, tilt: 90, limits: { pan: [10, 170], tilt: [30, 150] } };
      const lim = a.limits || { pan: [10, 170], tilt: [30, 150] };
      const body = {};
      if (dir === 'left') body.pan = clamp(a.pan - 10, lim.pan[0], lim.pan[1]);
      if (dir === 'right') body.pan = clamp(a.pan + 10, lim.pan[0], lim.pan[1]);
      if (dir === 'up') body.tilt = clamp(a.tilt - 10, lim.tilt[0], lim.tilt[1]);
      if (dir === 'down') body.tilt = clamp(a.tilt + 10, lim.tilt[0], lim.tilt[1]);
      r = await postJSON('/api/pi/pantilt', body, 4000);
    }
    if (r && isNum(r.pan) && isNum(r.tilt)) {
      camera.angles = { pan: r.pan, tilt: r.tilt, limits: r.limits || (camera.angles && camera.angles.limits) || { pan: [10, 170], tilt: [30, 150] } };
      camera.anglesAt = Date.now();
    }
  } catch (e) {
    toast(`Pan/tilt failed: ${e.message || e}`);
  } finally { camera.busy = false; }
}

function initCamera() {
  const { viewport, dpad, power, snap, center } = camEls();
  power.addEventListener('click', () => setCamera(!camera.on));
  center.addEventListener('click', () => setCamera(!camera.on));
  snap.addEventListener('click', snapshot);
  dpad.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-dir]');
    if (b) { nudge(b.dataset.dir); viewport.focus({ preventScroll: true }); }
  });
  viewport.addEventListener('keydown', (e) => {
    if (dpad.hidden) return;
    const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Home: 'center' };
    if (map[e.key]) { e.preventDefault(); nudge(map[e.key]); }
  });
  setCaption('Camera is inactive. Click the power button to start.');
  renderCameraButtons();
}

/** Restart the stream when the source setting changes while live. */
async function restartCamera() {
  if (!camera.on) return;
  await setCamera(false);
  await setCamera(true);
}

/* =============================================================================================
   Attention — the pan-tilt head looks at you, and gestures while Nova thinks
   ============================================================================================= */

// The browser publishes *intent* only; the Pi owns the loop, because it has the frames and because
// this tab is an unreliable controller — it gets throttled in the background, and closing it must
// not leave the servos energised. The Pi's lease does that: stop talking to it and the head parks
// and then releases on its own.
//
// Two hazards shape the code below. updateStatus() is called from initOrb()'s requestAnimationFrame
// loop whenever `voice.speaking` flips, so this must never POST without change detection — a naive
// hook fires hundreds of requests a second through two proxies. And background tabs throttle
// setInterval to about once a minute, which is what the Pi-side lease is there to survive.

const ATTENTION_HEARTBEAT_MS = 4000;   // the Pi's lease is 12 s; renew comfortably inside it
const ATTENTION_TOOL_GAP_MS = 3500;    // tool events can burst; one gesture pulse is enough
const ATTENTION_RETRY_MS = 60000;      // after repeated failures, go quiet this long -- then try again
const attention = { mode: 'sleep', sentAt: 0, toolAt: 0, fails: 0, mutedUntil: 0 };

/** The mode the head should be in, derived from state the dashboard already tracks. */
function attentionMode() {
  if (!state.settings.followMe) return 'sleep';
  // Order matters. While her voice is actually in the air she looks at you and "talks" (the Pi
  // layers its ambient talking motion over the tracker); while tools run, or before anything has
  // been said or written, she ponders; otherwise she simply pays attention.
  if (voice.speaking) return state.settings.gestures ? 'speak' : 'wake';
  if (chat.streaming && (chat.toolsRunning > 0 || !chat.answering)) return 'think';
  if (chat.streaming || chat.answering) return 'wake';
  if (voice.micOn && (voice.awake || voice.conversation)) return 'wake';
  return 'sleep';
}

function attentionMuted() { return Date.now() < attention.mutedUntil; }

async function pushAttention(mode) {
  if (attentionMuted() || !pantiltOk()) return;
  attention.sentAt = Date.now();
  try {
    await postJSON('/api/pi/attention', { mode }, 4000);
    attention.fails = 0;
  } catch (e) {
    // A bridge without the endpoint must not spam the console or the network on every state
    // change -- but go quiet for a while rather than disabling for the life of the page. The
    // bridge restarts on every redeploy, and a permanent latch meant head tracking stayed dead
    // until someone reloaded the tab or toggled the setting off and on again.
    if (++attention.fails >= 3) {
      attention.fails = 0;
      attention.mutedUntil = Date.now() + ATTENTION_RETRY_MS;
      console.warn('pan-tilt attention unavailable; retrying in %ds:', ATTENTION_RETRY_MS / 1000, (e && e.message) || e);
    }
  }
}

/** Called from updateStatus() on every state change. Cheap and idempotent. */
function syncAttention() {
  // Read the authoritative speaking flag rather than trusting `voice.speaking`. That mirror is
  // only written inside initOrb()'s rAF loop, which returns early while `document.hidden` — so
  // hiding the tab while Nova is talking latches it true for good. attentionMode() would then
  // answer 'wake' forever and the heartbeat would keep renewing the Pi's lease, which is exactly
  // the guarantee ("a closed or sleeping tab parks and releases the servos") this all rests on.
  // speech.js maintains its own flag from audio callbacks, and those still fire in a hidden tab.
  if (voice.speech) voice.speaking = !!voice.speech.isSpeaking();
  const mode = attentionMode();
  const now = Date.now();
  if (mode === attention.mode && (mode === 'sleep' || now - attention.sentAt < ATTENTION_HEARTBEAT_MS)) return;
  attention.mode = mode;
  pushAttention(mode);
}

/** A tool started: splice one distinct "glances at its hands" beat into the thinking gesture. */
function noteAttentionTool() {
  if (attentionMuted() || !state.settings.followMe || !pantiltOk()) return;
  // Not while her voice is in the air: a pulse would yank the head into a pondering beat in the
  // middle of a sentence. Once she has finished the sentence, syncAttention() moves her to
  // `think` on its own and later tool starts get their glance.
  if (voice.speaking) return;
  const now = Date.now();
  if (now - attention.toolAt < ATTENTION_TOOL_GAP_MS) return;
  attention.toolAt = now;
  attention.mode = 'think';
  pushAttention('tool');
}

function initAttention() {
  // Heartbeat: renews the lease while something is happening, silent while asleep.
  setInterval(() => { if (attention.mode !== 'sleep') syncAttention(); }, ATTENTION_HEARTBEAT_MS);
  // Coming back to a throttled tab: re-assert immediately rather than waiting for the next tick.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { attention.sentAt = 0; syncAttention(); }
  });
  // Leaving the page should put the head down now, not twelve seconds from now. keepalive lets the
  // request outlive the document; sendBeacon cannot be used because it will not set the JSON type.
  window.addEventListener('pagehide', () => {
    if (attentionMuted() || attention.mode === 'sleep' || !pantiltOk()) return;
    try {
      fetch('/api/pi/attention', {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'sleep' }),
      }).catch(() => {});
    } catch { /* ignore */ }
  });
}

/* =============================================================================================
   Gestures & emotes — the robot head acts out Nova's replies, and takes direct orders
   ============================================================================================= */

// Two sources of motion. (1) Nova herself: her replies carry cues such as [nod] that the server
// strips out and forwards as `gesture` events with the character offset they belong to; the reply
// speaker below fires each one as the sentence carrying it starts playing, so the nod lands on the
// "yes" rather than seconds ahead of it. (2) You: "Nova, dance" / "look around" / the emote chips
// go straight to the Pi without a round trip through the model.

const EMOTE_ORDER = ['nod', 'shake', 'tilt', 'greet', 'wave', 'bow', 'look_around', 'excited', 'celebrate', 'laugh', 'surprise', 'confused', 'think', 'sad', 'dance', 'peek', 'double_take', 'shiver', 'listen', 'sleepy'];
const EMOTE_LABEL = {
  nod: 'Nod', shake: 'Shake', tilt: 'Curious', greet: 'Hello', wave: 'Wave', bow: 'Bow', look_around: 'Look around',
  excited: 'Excited', celebrate: 'Celebrate', laugh: 'Laugh', surprise: 'Surprise', confused: 'Confused', think: 'Think',
  sad: 'Sad', dance: 'Dance', peek: 'Peek', double_take: 'Double take', shiver: 'Shiver', listen: 'Listen', sleepy: 'Sleepy',
  emphasis: 'Emphasis', look_up: 'Look up', look_down: 'Look down', look_left: 'Look left', look_right: 'Look right',
};
const EMOTE_REPLY = {
  nod: '*nods*', shake: '*shakes her head*', tilt: '*tilts her head, curious*', greet: '*nods hello*', wave: '*waves*',
  bow: '*bows*', look_around: '*looks around the room*', excited: '*bounces excitedly*', celebrate: '*does a little victory dance*',
  laugh: '*chuckles*', surprise: '*startles*', confused: '*looks puzzled*', think: '*looks up, pondering*', sad: '*droops sadly*',
  dance: '*dances*', peek: '*peeks round the side*', double_take: '*does a double take*', shiver: '*shivers*',
  listen: '*leans in, listening*', sleepy: '*nods off*', emphasis: '*nods firmly*', look_up: '*looks up*', look_down: '*looks down*',
  look_left: '*looks to her left*', look_right: '*looks to her right*',
};

// Spoken or typed orders that are actions, not questions. Leading politeness is stripped first.
const EMOTE_PREFIX_RE = /^(?:(?:hey|ok|okay|nova|please|now|can you|could you|would you|will you|go ahead and|go on and|just)[\s,]+)*/i;
const EMOTE_COMMANDS = [
  [/^(?:nod|nod (?:your|yer) head|say yes|agree)$/i, { kind: 'gesture', name: 'nod' }],
  [/^(?:shake (?:your |yer )?head|say no|disagree)$/i, { kind: 'gesture', name: 'shake' }],
  [/^(?:tilt (?:your |yer )?head|be curious|look curious|act curious)$/i, { kind: 'gesture', name: 'tilt' }],
  [/^(?:look around|look round|scan the room|have a look around|look about)$/i, { kind: 'gesture', name: 'look_around' }],
  [/^(?:bow|take a bow)$/i, { kind: 'gesture', name: 'bow' }],
  [/^(?:dance|do a (?:little )?dance|dance for me|boogie|bust a move|show me (?:your|yer) moves)$/i, { kind: 'gesture', name: 'dance' }],
  [/^(?:celebrate|cheer|do a victory dance|hooray)$/i, { kind: 'gesture', name: 'celebrate' }],
  [/^(?:get excited|be excited|act excited|bounce)$/i, { kind: 'gesture', name: 'excited' }],
  [/^(?:look sad|be sad|act sad|droop|sulk)$/i, { kind: 'gesture', name: 'sad' }],
  [/^(?:look surprised|act surprised|be surprised|gasp)$/i, { kind: 'gesture', name: 'surprise' }],
  [/^(?:laugh|chuckle|giggle|laugh for me)$/i, { kind: 'gesture', name: 'laugh' }],
  [/^(?:look confused|act confused|be confused)$/i, { kind: 'gesture', name: 'confused' }],
  [/^(?:think|ponder|look thoughtful|pretend to think)$/i, { kind: 'gesture', name: 'think' }],
  [/^(?:peek|sneak a peek|peek (?:a)?round)$/i, { kind: 'gesture', name: 'peek' }],
  [/^(?:do a double take|double take)$/i, { kind: 'gesture', name: 'double_take' }],
  [/^(?:wave|wave (?:at|to) me|wave goodbye|say goodbye|wave bye)$/i, { kind: 'gesture', name: 'wave' }],
  [/^(?:say hello|say hi|greet me|greet|hello there)$/i, { kind: 'gesture', name: 'greet' }],
  [/^(?:shiver|be scared|act scared|brr)$/i, { kind: 'gesture', name: 'shiver' }],
  [/^(?:look up)$/i, { kind: 'gesture', name: 'look_up' }],
  [/^(?:look down)$/i, { kind: 'gesture', name: 'look_down' }],
  [/^(?:look (?:to (?:the |your |yer )?)?left)$/i, { kind: 'gesture', name: 'look_left' }],
  [/^(?:look (?:to (?:the |your |yer )?)?right)$/i, { kind: 'gesture', name: 'look_right' }],
  [/^(?:listen|lean in|pay attention)$/i, { kind: 'gesture', name: 'listen' }],
  [/^(?:nod off|take a nap|fall asleep|pretend to sleep|act sleepy|be sleepy)$/i, { kind: 'gesture', name: 'sleepy' }],
  [/^(?:look at me|find me|find my face|where am i|track me|follow me)$/i, { kind: 'lookat' }],
  [/^(?:stop moving|hold still|stay still|freeze|stand still|be still)$/i, { kind: 'stop' }],
  [/^(?:center|centre|center (?:your |yer )?head|look straight|look straight ahead|look ahead|face forward)$/i, { kind: 'center' }],
];

function matchEmote(text) {
  const clean = String(text || '').trim().replace(EMOTE_PREFIX_RE, '').replace(/[\s.!?,]+$/g, '').trim();
  if (!clean || clean.split(/\s+/).length > 6) return null;
  for (const [re, action] of EMOTE_COMMANDS) if (re.test(clean)) return action;
  return null;
}

const gestureLog = { lastName: '', lastAt: 0 };

/** Ask the Pi to perform a gesture. Fire-and-forget; failures are logged, never toasted. */
function triggerGesture(name, opts = {}) {
  if (!pantiltOk() || !name) return Promise.resolve(false);
  const now = Date.now();
  // Two identical cues inside 400 ms are one cue (a model can repeat itself across a split).
  if (name === gestureLog.lastName && now - gestureLog.lastAt < 400) return Promise.resolve(true);
  gestureLog.lastName = name; gestureLog.lastAt = now;
  return postJSON('/api/pi/gesture', { name, ...opts }, 4000)
    .then(() => true)
    .catch((e) => { console.warn('gesture failed:', name, (e && e.message) || e); return false; });
}

function stopGesture() {
  if (!pantiltOk()) return Promise.resolve(false);
  return postJSON('/api/pi/gesture/stop', undefined, 4000).then(() => true).catch(() => false);
}

/** Run an emote action from a command. Returns the transcript line to show for it. */
function runEmote(action) {
  switch (action.kind) {
    case 'gesture': triggerGesture(action.name); return EMOTE_REPLY[action.name] || `*${action.name.replace(/_/g, ' ')}*`;
    case 'lookat':
      attention.mode = 'wake'; attention.sentAt = 0;
      pushAttention('wake');
      return '*looks for you*';
    case 'stop': stopGesture(); return '*holds still*';
    case 'center': postJSON('/api/pi/pantilt/center', undefined, 4000).catch(() => {}); return '*looks straight ahead*';
    default: return '';
  }
}

/**
 * "Nova, nod" / "dance" / "look at me": act on it here and now, no model round trip. Returns true
 * when the text was an order the head can carry out. Falls through (false) when the head is
 * offline, so Nova can still answer "can you dance?" in words.
 */
function handleEmoteCommand(text, { viaVoice = false } = {}) {
  const action = matchEmote(text);
  if (!action || !pantiltOk()) return false;
  addMessage({ role: 'user', text: String(text).trim(), ts: Date.now() });
  bumpCommands();
  const line = runEmote(action);
  if (line) addMessage({ role: 'assistant', text: line, ts: Date.now(), emote: true });
  if (viaVoice && voice.micOn && state.settings.conversation) voice.speech.openFollowUp();
  return true;
}

let emotesLoaded = false;
async function loadEmotes() {
  if (emotesLoaded) return;
  emotesLoaded = true;
  try {
    const r = await getJSON('/api/pi/gestures', 5000);
    const names = Array.isArray(r && r.gestures) ? r.gestures.map((g) => g.name) : [];
    if (names.length) {
      const known = new Set(names);
      const order = EMOTE_ORDER.filter((n) => known.has(n)).concat(names.filter((n) => !EMOTE_ORDER.includes(n)));
      buildEmoteRow(order);
    }
  } catch { /* the static list below stands */ }
}

function buildEmoteRow(names) {
  const row = $('emoteRow');
  row.innerHTML = '';
  for (const name of names) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'emote';
    b.dataset.gesture = name;
    b.textContent = EMOTE_LABEL[name] || name.replace(/_/g, ' ');
    b.title = `Ask the head to ${(EMOTE_LABEL[name] || name).toLowerCase()}`;
    row.appendChild(b);
  }
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.className = 'emote stop';
  stop.dataset.gesture = '';
  stop.textContent = 'Stop';
  stop.title = 'Stop the current gesture';
  row.appendChild(stop);
}

function renderEmotes() {
  const row = $('emoteRow');
  const show = pantiltOk();
  row.hidden = !show;
  if (show) loadEmotes();
}

function initEmotes() {
  buildEmoteRow(EMOTE_ORDER);
  $('emoteRow').addEventListener('click', (e) => {
    const b = e.target.closest('button.emote');
    if (!b) return;
    const name = b.dataset.gesture;
    b.classList.add('pressed');
    setTimeout(() => b.classList.remove('pressed'), 500);
    if (!name) { stopGesture(); return; }
    triggerGesture(name);
  });
}

/* =============================================================================================
   Desk companion — what the camera sees, photos, desk watch, presence
   ============================================================================================= */

const companion = {
  status: null,            // last /api/pi/status
  lastArrivals: null,      // presence.arrivals as last seen (null until the first poll)
  lastEventId: null,       // desk-watch event id as last seen
  lastNudgeAt: 0,
  lastCapture: null,       // name of the last photo taken from here
  telegram: false,
};
const NUDGE_GAP_MS = 30 * 60 * 1000;

function fmtDurShort(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${pad2(m)}m`;
  if (m > 0) return `${m}m`;
  return '<1m';
}

/** Speak a line of Nova's own (a greeting, a reminder) when speech output is on at all. */
function sayLine(text) {
  if (state.settings.speak === 'off' || !voice.speech) return;
  voice.speech.speakChunk(text);
}

function dataUrlFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('could not read image'));
    r.readAsDataURL(blob);
  });
}

/** A small JPEG (for the transcript and localStorage) from a full frame. */
async function makeThumb(blob, width = 200) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, width / bmp.width);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close && bmp.close();
    return c.toDataURL('image/jpeg', 0.72);
  } catch { return null; }
}

/** Grab what the desk camera sees right now: { dataUrl (full frame), thumb }. */
async function captureFrame() {
  if (!piBridgeOk()) return null;
  try {
    const res = await fetch(`/api/pi/snapshot.jpg?ts=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (!blob.size) throw new Error('empty frame');
    const [dataUrl, thumb] = await Promise.all([dataUrlFromBlob(blob), makeThumb(blob)]);
    return { dataUrl, thumb };
  } catch (e) {
    console.warn('snapshot failed', e);
    return null;
  }
}

// "Look at this" — questions about what the camera can see go to Nova with the frame attached.
const VISION_RE = /^(?:(?:take a look|have a look|look)(?: at (?:this|that|these|here|it|me|my desk|the desk|what i'?m holding))?|what(?:'s| is| are) (?:this|these|that|those|it)(?: (?:thing|object|called))?|what am i holding|what'?s in my hand|what do you see|what can you see|what'?s (?:in front of you|on (?:the|my) desk)|describe (?:this|that|it|what you see|the scene|my desk)|read (?:this|that|it|the label|the text|this (?:page|note|card|screen)|what this says)|what does (?:this|that|it) say|can you see (?:this|that|it|me|what i'?m holding)|check this out|scan this|how do i look|what colou?r is (?:this|that|it)|identify (?:this|that)|guess what this is)$/i;

function isVisionRequest(text) {
  const clean = String(text || '').trim().replace(EMOTE_PREFIX_RE, '').replace(/[\s.!?,]+$/g, '').trim();
  return !!clean && VISION_RE.test(clean);
}

function setAttachNext(on) {
  chat.attachNext = !!on && piBridgeOk();
  const b = $('chatAttach');
  b.classList.toggle('active', chat.attachNext);
  b.setAttribute('aria-pressed', String(chat.attachNext));
  b.title = chat.attachNext ? 'The next message will include what the camera sees' : 'Attach what the desk camera sees to the next message';
}

/* ---- photos ---- */
const PHOTO_RE = /^(?:take|snap|shoot|capture|grab)\s+(?:a\s+|another\s+)?(?:photo|picture|pic|snapshot|selfie)(?:\s+of\s+(?:me|us|this|that|the desk|my desk))?(?:\s+(?:and|then)\s+(?:send|text|message)\s+(?:it\s+)?(?:to\s+)?me)?$/i;
const SEND_PHOTO_RE = /^(?:send|text|message|forward)\s+(?:me\s+)?(?:the\s+|that\s+|this\s+|the last\s+)?(?:photo|picture|pic|snapshot)(?:\s+to\s+(?:me|my phone|telegram))?$/i;

async function takePhoto({ notify = false, viaVoice = false } = {}) {
  try {
    const r = await postJSON('/api/pi/capture', { label: 'photo', notify: notify && state.settings.telegram }, 15000);
    companion.lastCapture = r.name;
    let thumb = null;
    try {
      const res = await fetch(`/api/pi/captures/${encodeURIComponent(r.name)}`, { cache: 'no-store' });
      if (res.ok) thumb = await makeThumb(await res.blob(), 240);
    } catch { /* the line still goes in without a preview */ }
    const sent = r.notified ? ' and sent to your Telegram' : (notify ? ' — Telegram is not set up, so it stays on the Pi' : '');
    addMessage({ role: 'assistant', text: `*click* Saved as \`${r.name}\`${sent}.`, ts: Date.now(), emote: true, image: thumb || undefined });
    triggerGesture('celebrate');
    if (viaVoice) sayLine(r.notified ? 'There we are. Sent to your phone.' : 'There we are.');
  } catch (e) {
    toast(`Photo failed: ${(e && e.message) || e}`);
  }
}

async function sendLastPhoto({ viaVoice = false } = {}) {
  if (!companion.lastCapture) { toast('No photo taken yet — say "take a photo" first', 'info', 2600); return; }
  try {
    await postJSON('/api/pi/notify', { text: 'Photo from the desk camera.', capture: companion.lastCapture }, 30000);
    addMessage({ role: 'assistant', text: '*sent the photo to your Telegram*', ts: Date.now(), emote: true });
    if (viaVoice) sayLine('Sent.');
  } catch (e) {
    toast(`Could not send it: ${(e && e.message) || e}`);
  }
}

/* ---- desk watch ---- */
const WATCH_ON_RE = /^(?:watch (?:my |the )?desk(?: for me)?|keep (?:an eye|watch) on (?:my desk|the desk|things|it|the room)|guard (?:my |the )?desk|sentry mode(?: on)?|start watching|watch for (?:anyone|anybody|intruders|movement)|keep watch|watch the room)$/i;
const WATCH_OFF_RE = /^(?:stop watching|stand down|at ease|stop (?:the )?(?:desk )?watch|watch off|disarm|sentry mode off|stop guarding)$/i;

async function setWatch(on, { viaVoice = false, quiet = false } = {}) {
  try {
    const r = await postJSON('/api/pi/watch', { enabled: !!on, notify: !!state.settings.telegram }, 5000);
    companion.status = companion.status || {};
    companion.status.watch = { ...(companion.status.watch || {}), enabled: r.enabled, notify: r.notify };
    renderWatch();
    if (quiet) return;
    const tg = r.telegram && r.notify;
    const line = on
      ? (tg ? "*keeps watch* I'll message your Telegram with a photo if anything moves." : "*keeps watch* I'll note anything that moves; Telegram is not set up, so check back here.")
      : '*stands down*';
    addMessage({ role: 'assistant', text: line, ts: Date.now(), emote: true });
    triggerGesture(on ? 'look_around' : 'nod');
    if (viaVoice) sayLine(on ? (tg ? "Watching the desk. I'll message you if anything moves." : 'Watching the desk.') : 'Standing down.');
  } catch (e) {
    toast(`Desk watch failed: ${(e && e.message) || e}`);
  }
}

function renderWatch() {
  const w = companion.status && companion.status.watch;
  const b = $('camWatch');
  const on = !!(w && w.enabled);
  b.classList.toggle('watching', on);
  b.setAttribute('aria-pressed', String(on));
  b.title = on ? 'Desk watch is on — click to stand down' : 'Watch the desk while you are away';
  b.disabled = !piBridgeOk();
  $('camPhoto').disabled = !piBridgeOk();
}

async function onWatchEvent(ev) {
  const when = fmtShortTime((ev.at || 0) * 1000);
  const what = ev.kind === 'face' ? 'Someone is at the desk' : 'Movement at the desk';
  let thumb = null;
  if (ev.capture) {
    try {
      const res = await fetch(`/api/pi/captures/${encodeURIComponent(ev.capture)}`, { cache: 'no-store' });
      if (res.ok) thumb = await makeThumb(await res.blob(), 240);
    } catch { /* no preview */ }
  }
  addMessage({ role: 'assistant', text: `👁 ${what} at ${when}${ev.notified ? ' — sent to your Telegram' : ''}.`, ts: Date.now(), emote: true, image: thumb || undefined });
  toast(`${what} (${when})`, 'info', 5000);
  sayLine(`${what}.`);
}

/* ---- vibe: the head moves to music heard by the Pi's microphone ---- */
const VIBE_ON_RE = /^(?:vibe(?: with me| to (?:this|the music|it))?|dance (?:to (?:this|the music|it)|with me|along)|dance mode(?: on)?|feel the beat|groove(?: with me)?|bob (?:your head|along)|get into it|party mode|let'?s dance|move to the music)$/i;
const VIBE_OFF_RE = /^(?:stop vibing|stop dancing|stop grooving|enough dancing|chill|calm down|settle down|dance mode off|party'?s over|stop moving to the music|stop the music thing)$/i;

let vibeSyncApplied = false;
async function applyVibeSetting() {
  if (!piBridgeOk()) return;
  try {
    await postJSON('/api/pi/vibe', { enabled: !!state.settings.vibe, amplitude: Number(state.settings.vibeAmp) || 1 }, 5000);
  } catch { /* no microphone on the Pi; the next poll says so */ }
}

async function forceVibe(on, { viaVoice = false } = {}) {
  try {
    const r = await postJSON('/api/pi/vibe', { force: !!on, ...(on ? { enabled: true } : {}) }, 5000);
    const line = on
      ? (r.active ? `*bobs along at ${Math.round(r.bpm)} BPM*` : '*starts bobbing along*')
      : '*settles down*';
    addMessage({ role: 'assistant', text: line, ts: Date.now(), emote: true });
    if (viaVoice) sayLine(on ? 'Let us have it.' : 'Settling down.');
  } catch (e) {
    toast(`Vibe failed: ${(e && e.message) || e}`);
  }
}

function vibeState() {
  const v = companion.status && companion.status.vibe;
  return v && typeof v === 'object' ? v : null;
}

/* ---- groove panel: the vibe switch, and the head as a visual metronome ---- */
function metroState() {
  const m = companion.status && companion.status.metronome;
  return m && typeof m === 'object' ? m : null;
}

async function setMetronome(bpm) {
  if (!piBridgeOk()) { toast('The Pi bridge is offline', 'info', 2600); return; }
  try {
    const r = await postJSON('/api/pi/metronome', bpm ? { bpm } : { enabled: false }, 5000);
    if (companion.status) companion.status.metronome = { enabled: !!r.enabled, bpm: r.bpm, running: !!r.running, remaining_s: r.remaining_s };
  } catch (e) {
    toast(`Metronome failed: ${(e && e.message) || e}`);
  }
  renderGroove();
  updateStatus();
}

function renderGroove() {
  const sw = $('grooveVibe'), mode = $('grooveMode'), bpm = $('grooveBpm'), play = $('groovePlay'), tag = $('grooveTag'), status = $('grooveStatus');
  if (!sw) return;
  const s = state.settings;
  sw.checked = !!s.vibe;
  mode.value = s.grooveMode === 'metronome' ? 'metronome' : 'vibe';
  const metro = mode.value === 'metronome';
  $('grooveMetro').hidden = !metro;
  if (document.activeElement !== bpm) bpm.value = String(s.metroBpm || 100);
  const m = metroState();
  const v = vibeState();
  const running = !!(m && m.enabled);
  play.setAttribute('aria-pressed', String(running));
  play.classList.toggle('active', running);
  play.querySelector('use').setAttribute('href', running ? '#i-stop' : '#i-play');
  $('groovePlayLabel').textContent = running ? 'Stop' : 'Play';
  let tagText = 'off', muted = true, line;
  if (!piBridgeOk()) {
    line = 'The Pi bridge is offline';
  } else if (running) {
    tagText = `${Math.round(m.bpm)} BPM`; muted = false;
    line = m.running
      ? `<span class="ok">Metronome</span> · nodding on every beat at ${Math.round(m.bpm)} BPM`
      : `Metronome set to ${Math.round(m.bpm)} BPM — the head joins in as soon as Nova is idle`;
  } else if (!s.vibe) {
    line = v && v.available === false ? 'No microphone capture is available on the Pi' : 'Vibe to music is off — flip the switch and play something';
  } else if (v && v.vibing) {
    tagText = v.bpm ? `♪ ${Math.round(v.bpm)}` : '♪'; muted = false;
    line = `<span class="ok">Vibing</span>${v.bpm ? ` at ${Math.round(v.bpm)} BPM` : ''}${isNum(v.score) ? ` · beat score ${v.score.toFixed(2)}` : ''}`;
  } else if (v && v.active) {
    tagText = 'beat'; muted = false;
    line = `Beat found${v.bpm ? ` at ${Math.round(v.bpm)} BPM` : ''} — the head joins in when Nova is idle`;
  } else if (v && v.listening) {
    tagText = 'listening';
    line = `Listening on the Pi microphone${isNum(v.level_db) ? ` · ${Math.round(v.level_db)} dBFS` : ''}${isNum(v.score) ? ` · beat score ${v.score.toFixed(2)} (starts at 0.10)` : ''}`;
  } else if (v && v.available === false) {
    line = 'No microphone capture is available on the Pi';
  } else {
    line = 'The Pi microphone is not being captured right now';
  }
  tag.textContent = tagText;
  tag.classList.toggle('muted', muted);
  status.innerHTML = line;
}

function initGroove() {
  const sw = $('grooveVibe'), mode = $('grooveMode'), bpm = $('grooveBpm'), play = $('groovePlay');
  if (!sw) return;
  sw.addEventListener('change', () => {
    state.settings.vibe = sw.checked; saveSettings(); applyVibeSetting();
    const setVibe = $('setVibe');
    if (setVibe) setVibe.checked = sw.checked;
    renderGroove();
  });
  mode.addEventListener('change', () => {
    state.settings.grooveMode = mode.value; saveSettings();
    const m = metroState();
    if (mode.value !== 'metronome' && m && m.enabled) setMetronome(0);
    renderGroove();
  });
  const commitBpm = () => {
    const n = Math.min(240, Math.max(30, Math.round(Number(bpm.value) || 100)));
    bpm.value = String(n);
    if (n !== state.settings.metroBpm) { state.settings.metroBpm = n; saveSettings(); }
    const m = metroState();
    if (m && m.enabled && Math.round(m.bpm) !== n) setMetronome(n);   // retune while it plays
  };
  bpm.addEventListener('change', commitBpm);
  bpm.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    commitBpm();
    const m = metroState();
    if (!(m && m.enabled)) setMetronome(state.settings.metroBpm);
  });
  play.addEventListener('click', () => {
    const m = metroState();
    if (m && m.enabled) { setMetronome(0); return; }
    commitBpm();
    setMetronome(state.settings.metroBpm);
  });
  renderGroove();
}

/* ---- presence: briefing, break nudges ---- */
function onArrival() {
  if (state.settings.briefing) {
    const today = new Date().toDateString();
    if (storage.get('nova.lastBriefing', '') !== today && !chat.streaming) {
      storage.set('nova.lastBriefing', today);
      const spoken = state.settings.speak !== 'off';
      setTimeout(() => sendMessage('Give me my daily briefing, please.', { viaVoice: spoken }), 2500);
    }
  }
}

function maybeNudgeBreak(presence) {
  const limitMin = Number(state.settings.breakMin) || 0;
  if (!limitMin || !presence || !presence.present) return;
  const now = Date.now();
  if (presence.at_desk_s < limitMin * 60 || now - companion.lastNudgeAt < NUDGE_GAP_MS) return;
  companion.lastNudgeAt = now;
  const line = `You have been at the desk for ${fmtDurShort(presence.at_desk_s).replace('h ', ' hours ').replace(/m$/, ' minutes')}, sir. A short stretch might be in order.`;
  addMessage({ role: 'assistant', text: line, ts: now, emote: true });
  sayLine(line);
  triggerGesture('listen');
}

function renderPresence() {
  const st = companion.status;
  const pres = st && st.presence;
  const tile = $('tilePresence');
  const line = $('camPresence');
  if (!pres || !pres.enabled) {
    tile.textContent = piBridgeOk() ? 'off' : '—';
    line.hidden = true;
    return;
  }
  if (pres.present) tile.textContent = fmtDurShort(pres.at_desk_s);
  else tile.textContent = 'Away';
  const w = st.watch || {};
  const bits = [];
  bits.push(pres.present ? `<span class="ok">At your desk</span> · ${fmtDurShort(pres.at_desk_s)}` : (pres.since ? `Away since ${fmtShortTime(pres.since * 1000)}` : 'Nobody at the desk yet'));
  if (w.enabled) bits.push(`<span class="warn">watching the desk</span>${w.event_count ? ` · ${w.event_count} event${w.event_count === 1 ? '' : 's'}` : ''}`);
  const v = st.vibe || {};
  if (v.vibing) bits.push(`<span class="ok">♪ vibing${v.bpm ? ` at ${Math.round(v.bpm)} BPM` : ''}</span>`);
  line.innerHTML = bits.join(' · ');
  line.hidden = camera.on && camera.live && !w.enabled;
}

async function pollStatus() {
  if (!piBridgeOk()) { renderPresence(); renderWatch(); renderGroove(); return; }
  let st;
  try { st = await getJSON('/api/pi/status', 5000); } catch { return; }
  companion.status = st;
  companion.statusAt = Date.now();
  companion.telegram = !!st.telegram;
  const pres = st.presence || {};
  if (companion.lastArrivals !== null && isNum(pres.arrivals) && pres.arrivals > companion.lastArrivals) onArrival();
  if (isNum(pres.arrivals)) companion.lastArrivals = pres.arrivals;
  const ev = st.watch && st.watch.last_event;
  if (ev && isNum(ev.id)) {
    if (companion.lastEventId !== null && ev.id > companion.lastEventId) onWatchEvent(ev);
    companion.lastEventId = ev.id;
  } else if (companion.lastEventId === null && st.watch) {
    companion.lastEventId = 0;
  }
  maybeNudgeBreak(pres);
  renderPresence();
  renderWatch();
  renderGroove();
  const note = $('setTelegramNote');
  if (note) note.textContent = st.telegram ? "Uses Nova's Telegram bot on the Pi (configured)" : 'No Telegram bot is configured on the Pi — events stay in this transcript';
  const v = st.vibe || {};
  const vnote = $('setVibeNote');
  if (vnote) {
    vnote.textContent = !v.available ? 'No microphone capture is available on the Pi'
      : v.listening ? `Listening on the Pi microphone (${isNum(v.level_db) ? `${Math.round(v.level_db)} dBFS` : 'level unknown'}${v.bpm ? `, ${Math.round(v.bpm)} BPM` : ''})`
      : 'The Pi microphone is not being captured right now';
  }
  if (!vibeSyncApplied) { vibeSyncApplied = true; applyVibeSetting(); }
  updateStatus();
}

async function applyPresenceSetting() {
  if (!piBridgeOk()) return;
  try { await postJSON('/api/pi/presence', { enabled: !!state.settings.presence }, 5000); } catch { /* next poll shows the truth */ }
}

function initCompanion() {
  $('camWatch').addEventListener('click', () => {
    const on = !!(companion.status && companion.status.watch && companion.status.watch.enabled);
    setWatch(!on);
  });
  $('camPhoto').addEventListener('click', () => takePhoto());
  setInterval(pollStatus, 4000);
  renderWatch();
  renderPresence();
}

/* =============================================================================================
   Reminders & timers — parsed here, kept by the server, announced here (and on the phone)
   ============================================================================================= */

const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90 };
const UNIT_RE = '(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)';

/** "twenty minutes", "an hour and a half", "half an hour" → digits, so one regex can read durations. */
function normalizeTimeWords(text) {
  let t = ` ${String(text).toLowerCase().replace(/,/g, ' ')} `;
  t = t.replace(/\b(?:an?|one) hour and a half\b/g, '90 minutes')
    .replace(/\bhalf an hour\b/g, '30 minutes')
    .replace(/\b(?:a )?quarter of an hour\b/g, '15 minutes')
    .replace(/\bthree quarters of an hour\b/g, '45 minutes')
    .replace(/\b(?:an?|one) minute and a half\b/g, '90 seconds')
    .replace(/\bhalf a minute\b/g, '30 seconds');
  t = t.replace(/\b(twenty|thirty|forty|fifty)[\s-](one|two|three|four|five|six|seven|eight|nine)\b/g, (m, a, b) => String(NUM_WORDS[a] + NUM_WORDS[b]));
  t = t.replace(new RegExp(`\\b(${Object.keys(NUM_WORDS).join('|')})\\b(?=\\s+${UNIT_RE}\\b)`, 'g'), (m, w) => String(NUM_WORDS[w]));
  return t.replace(/\s+/g, ' ').trim();
}

/** Sum every "N unit" in the text → seconds, plus the text with them removed. */
function parseDuration(text) {
  const re = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT_RE})\\b`, 'gi');
  let seconds = 0;
  let m;
  let rest = text;
  while ((m = re.exec(text))) {
    const n = Number(m[1]);
    const u = m[2].toLowerCase();
    seconds += n * (u.startsWith('h') ? 3600 : u.startsWith('m') ? 60 : 1);
    rest = rest.replace(m[0], ' ');
  }
  return { seconds, rest: rest.replace(/\s+/g, ' ').trim() };
}

/** "at 3:30 pm", "at 9", "at noon", optionally "tomorrow" → an absolute time in the future. */
function parseClock(text) {
  const tomorrow = /\btomorrow\b/i.test(text);
  let m = /\b(?:at|by|around)\s+(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?|o'?clock)?\b/i.exec(text);
  let hour, minute = 0, meridiem = null, matched = '';
  if (m) {
    hour = Number(m[1]); minute = Number(m[2] || 0); matched = m[0];
    const mer = (m[3] || '').replace(/\./g, '').toLowerCase();
    if (mer === 'am' || mer === 'pm') meridiem = mer;
  } else {
    m = /\b(?:(?:at|by|around)\s+)?(noon|midday|midnight)\b/i.exec(text);
    if (!m) return null;
    matched = m[0];
    hour = /midnight/i.test(m[1]) ? 0 : 12;
    meridiem = 'fixed';
  }
  if (!(hour >= 0 && hour <= 23) || !(minute >= 0 && minute <= 59)) return null;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  const now = new Date();
  const candidate = (h, dayOffset) => { const d = new Date(now); d.setDate(d.getDate() + dayOffset); d.setHours(h, minute, 0, 0); return d; };
  let at;
  if (tomorrow) {
    at = candidate(hour, 1);
    if (!meridiem && hour < 8) at = candidate(hour + 12, 1);   // "tomorrow at 3" means the afternoon
  } else {
    at = candidate(hour, 0);
    if (at <= now && !meridiem && hour < 12) at = candidate(hour + 12, 0);   // "at 3" this afternoon
    if (at <= now) at = candidate(hour, 1);
  }
  return { at, matched, tomorrow };
}

function fmtDuration(seconds) {
  seconds = Math.round(seconds);
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), sec = seconds % 60;
  const parts = [];
  if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  if (sec && !h) parts.push(`${sec} second${sec === 1 ? '' : 's'}`);
  return parts.join(' ') || '0 seconds';
}

/**
 * "set a timer for 10 minutes", "remind me in 20 minutes to check the oven", "remind me at 3:30 pm
 * to call the dentist", "remind me tomorrow at 9 to submit the form" → { kind, at, text, whenLabel }
 * or null when it is not a reminder at all.
 */
function parseReminder(raw) {
  const t = normalizeTimeWords(String(raw || '').trim().replace(EMOTE_PREFIX_RE, '').replace(/[.!?]+$/g, ''));
  if (/\b(?:timer|countdown)\b/.test(t)) {
    const d = parseDuration(t);
    if (d.seconds >= 5) {
      const label = d.rest.replace(/\b(?:set|start|put on|create|a|an|the|another|timer|countdown|for|of|me|please|and|then)\b/g, ' ').replace(/\s+/g, ' ').trim();
      return { kind: 'timer', at: Date.now() + d.seconds * 1000, text: `${fmtDuration(d.seconds)} timer${label ? `: ${label}` : ''}`, whenLabel: `in ${fmtDuration(d.seconds)}` };
    }
  }
  const m = /^(?:remind me|set (?:a |an )?reminder|reminder|wake me(?: up)?)\b(.*)$/i.exec(t);
  if (!m) return null;
  let rest = m[1].trim();
  let at = null;
  let whenLabel = '';
  const inMatch = new RegExp(`\\bin\\s+((?:\\d+(?:\\.\\d+)?\\s*${UNIT_RE}\\b(?:\\s+(?:and\\s+)?)?)+)`, 'i').exec(rest);
  if (inMatch) {
    const d = parseDuration(inMatch[1]);
    if (d.seconds >= 5) {
      at = Date.now() + d.seconds * 1000;
      whenLabel = `in ${fmtDuration(d.seconds)}`;
      rest = rest.replace(inMatch[0], ' ');
    }
  }
  if (!at) {
    const c = parseClock(rest);
    if (c) {
      at = c.at.getTime();
      whenLabel = `at ${fmtShortTime(at)}${c.tomorrow ? ' tomorrow' : ''}`;
      rest = rest.replace(c.matched, ' ').replace(/\btomorrow\b/i, ' ');
    }
  }
  if (!at) return null;
  let task = rest.replace(/^\s*(?:to|that|about|and)\s+/i, '').replace(/\s+/g, ' ').trim().replace(/^(?:to|that)\s+/i, '');
  if (/^wake me/i.test(t)) task = task || 'wake up';
  return { kind: 'reminder', at, text: task || 'reminder', whenLabel };
}

const REMINDER_LIST_RE = /^(?:(?:what|which|show|list|read|tell me)\b.*\b(?:reminders?|timers?)\b|(?:do i have|are there|is there|any)\b.*\b(?:reminders?|timers?)\b|how (?:much|long)\b.*\b(?:left|remaining|to go)\b|how long (?:is |until |till )?(?:the |my )?timer)/i;
const REMINDER_CANCEL_RE = /^(?:cancel|clear|delete|remove|stop|dismiss|kill)\b.*\b(?:reminders?|timers?|alarms?|countdown)\b/i;

const remindersUi = { pending: [], lastFiredSeen: Date.now(), timer: 0 };

function reminderWhen(r) {
  const ms = r.at - Date.now();
  if (r.kind === 'timer' || Math.abs(ms) < 6 * 3600 * 1000) return ms <= 0 ? 'now' : `in ${fmtDurShort(ms / 1000)}`;
  const d = new Date(r.at);
  return d.toDateString() === new Date().toDateString() ? fmtShortTime(r.at) : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${fmtShortTime(r.at)}`;
}

function renderReminders() {
  const list = $('remindersList');
  const items = remindersUi.pending;
  list.innerHTML = '';
  for (const r of items) {
    const li = document.createElement('li');
    li.className = `reminder ${r.kind}`;
    li.innerHTML = '<span class="when"></span><span class="what"></span><button class="icon-btn" type="button" aria-label="Cancel" title="Cancel"><svg class="icon"><use href="#i-x"/></svg></button>';
    li.querySelector('.when').textContent = reminderWhen(r);
    li.querySelector('.what').textContent = r.text;
    li.querySelector('.what').title = `${r.kind} · ${new Date(r.at).toLocaleString()}`;
    li.querySelector('button').addEventListener('click', () => cancelReminder(r.id));
    list.appendChild(li);
  }
  $('remindersEmpty').hidden = items.length > 0;
  $('remindersTag').textContent = String(items.length);
  $('remindersTag').className = items.length ? 'tag' : 'tag muted';
  $('remindersClear').disabled = !items.length;
}

function announceReminder(r) {
  const line = r.kind === 'timer' ? `⏱ Time's up: ${r.text}.` : `⏰ Reminder: ${r.text}.`;
  addMessage({ role: 'assistant', text: line, ts: Date.now(), emote: true });
  toast(line, 'info', 8000);
  sayLine(r.kind === 'timer' ? `Time's up. ${r.text}.` : `Reminder: ${r.text}.`);
}

async function pollReminders() {
  let data;
  try { data = await getJSON(`/api/reminders?since=${remindersUi.lastFiredSeen}`, 5000); } catch { return; }
  remindersUi.pending = Array.isArray(data.pending) ? data.pending : [];
  for (const r of (Array.isArray(data.fired) ? data.fired : []).slice().reverse()) {
    if ((r.firedAt || 0) > remindersUi.lastFiredSeen) announceReminder(r);
  }
  if (isNum(data.now)) remindersUi.lastFiredSeen = data.now;
  renderReminders();
  scheduleReminderPoll();
}

function scheduleReminderPoll() {
  clearTimeout(remindersUi.timer);
  const soon = remindersUi.pending.some((r) => r.at - Date.now() < 120000);
  remindersUi.timer = setTimeout(pollReminders, remindersUi.pending.length ? (soon ? 2000 : 8000) : 20000);
}

async function addReminder(parsed, { viaVoice = false, echo = true } = {}) {
  try {
    const data = await postJSON('/api/reminders', { text: parsed.text, at: parsed.at, kind: parsed.kind, notify: !!state.settings.telegram }, 5000);
    remindersUi.pending = data.pending || remindersUi.pending;
    renderReminders();
    scheduleReminderPoll();
    const line = parsed.kind === 'timer' ? `Timer set for ${parsed.whenLabel.replace(/^in /, '')}.` : `I'll remind you ${parsed.whenLabel}: ${parsed.text}.`;
    if (echo) addMessage({ role: 'assistant', text: line, ts: Date.now(), emote: true });
    if (viaVoice) sayLine(line);
    triggerGesture('nod');
    return true;
  } catch (e) {
    toast(`Could not set that: ${(e && e.message) || e}`);
    return false;
  }
}

async function cancelReminder(id) {
  try {
    const r = await fetch(`/api/reminders/${id}`, { method: 'DELETE' });
    const data = await r.json();
    if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
    if (Array.isArray(data.pending)) remindersUi.pending = data.pending;
    renderReminders();
  } catch (e) { toast(`Could not cancel: ${(e && e.message) || e}`); }
}

async function clearAllReminders() {
  try {
    const r = await fetch('/api/reminders', { method: 'DELETE' });
    const data = await r.json();
    if (data && Array.isArray(data.pending)) remindersUi.pending = data.pending;
    renderReminders();
    return data.removed || 0;
  } catch (e) { toast(`Could not clear: ${(e && e.message) || e}`); return 0; }
}

/** Reminder-shaped commands: set, list, cancel. Returns true when handled. */
function handleReminderCommand(text, { viaVoice = false } = {}) {
  const clean = String(text || '').trim().replace(EMOTE_PREFIX_RE, '').replace(/[\s.!?,]+$/g, '').trim();
  if (!clean) return false;
  const parsed = parseReminder(clean);
  if (parsed) {
    addMessage({ role: 'user', text: String(text).trim(), ts: Date.now() });
    bumpCommands();
    addReminder(parsed, { viaVoice });
    if (viaVoice && voice.micOn && state.settings.conversation) voice.speech.openFollowUp();
    return true;
  }
  if (REMINDER_CANCEL_RE.test(clean)) {
    addMessage({ role: 'user', text: String(text).trim(), ts: Date.now() });
    bumpCommands();
    const all = /\b(?:all|every|everything)\b/i.test(clean) || /reminders|timers/i.test(clean);
    const target = remindersUi.pending[0];
    (async () => {
      let line;
      if (!remindersUi.pending.length) line = 'There is nothing to cancel.';
      else if (all) { const n = await clearAllReminders(); line = `Cancelled ${n} reminder${n === 1 ? '' : 's'}.`; }
      else { await cancelReminder(target.id); line = `Cancelled: ${target.text}.`; }
      addMessage({ role: 'assistant', text: line, ts: Date.now(), emote: true });
      if (viaVoice) sayLine(line);
    })();
    if (viaVoice && voice.micOn && state.settings.conversation) voice.speech.openFollowUp();
    return true;
  }
  if (REMINDER_LIST_RE.test(clean)) {
    addMessage({ role: 'user', text: String(text).trim(), ts: Date.now() });
    bumpCommands();
    const items = remindersUi.pending;
    const line = !items.length
      ? 'No reminders or timers are set.'
      : `${items.length === 1 ? 'One reminder' : `${items.length} reminders`}: ${items.slice(0, 5).map((r) => `${r.text} ${reminderWhen(r)}`).join('; ')}.`;
    addMessage({ role: 'assistant', text: line, ts: Date.now(), emote: true });
    if (viaVoice) sayLine(line);
    if (viaVoice && voice.micOn && state.settings.conversation) voice.speech.openFollowUp();
    return true;
  }
  return false;
}

function initReminders() {
  $('reminderForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('reminderInput');
    const text = input.value.trim();
    if (!text) return;
    const parsed = parseReminder(/^(?:remind|set|timer|wake)/i.test(text) ? text : `remind me ${text}`);
    if (!parsed) { toast('Try "in 20 minutes to …" or "at 3:30 to …"', 'info', 3200); return; }
    input.value = '';
    addReminder(parsed, { echo: false });
  });
  $('remindersClear').addEventListener('click', () => clearAllReminders());
  pollReminders();
}

/**
 * Everything the console handles itself, without a trip to the model: head emotes, reminders and
 * timers, photos, the desk watch. Returns true when the text was such an order.
 */
function handleLocalCommand(text, { viaVoice = false } = {}) {
  if (handleReminderCommand(text, { viaVoice })) return true;
  const clean = String(text || '').trim().replace(EMOTE_PREFIX_RE, '').replace(/[\s.!?,]+$/g, '').trim();
  if (clean && piBridgeOk()) {
    if (PHOTO_RE.test(clean)) {
      addMessage({ role: 'user', text: String(text).trim(), ts: Date.now() });
      bumpCommands();
      takePhoto({ notify: /\b(?:send|text|message)\b/i.test(clean), viaVoice });
      if (viaVoice && voice.micOn && state.settings.conversation) voice.speech.openFollowUp();
      return true;
    }
    if (SEND_PHOTO_RE.test(clean)) {
      addMessage({ role: 'user', text: String(text).trim(), ts: Date.now() });
      bumpCommands();
      sendLastPhoto({ viaVoice });
      if (viaVoice && voice.micOn && state.settings.conversation) voice.speech.openFollowUp();
      return true;
    }
    if (WATCH_ON_RE.test(clean) || WATCH_OFF_RE.test(clean)) {
      addMessage({ role: 'user', text: String(text).trim(), ts: Date.now() });
      bumpCommands();
      setWatch(WATCH_ON_RE.test(clean), { viaVoice });
      if (viaVoice && voice.micOn && state.settings.conversation) voice.speech.openFollowUp();
      return true;
    }
    if (VIBE_ON_RE.test(clean) || VIBE_OFF_RE.test(clean)) {
      addMessage({ role: 'user', text: String(text).trim(), ts: Date.now() });
      bumpCommands();
      forceVibe(VIBE_ON_RE.test(clean), { viaVoice });
      if (viaVoice && voice.micOn && state.settings.conversation) voice.speech.openFollowUp();
      return true;
    }
  }
  return handleEmoteCommand(text, { viaVoice });
}

/* =============================================================================================
   System Uptime
   ============================================================================================= */

function initUptime() {
  const count = (storage.get('nova.sessionCount', 0) | 0) + 1;
  storage.set('nova.sessionCount', count);
  state.sessionNo = count;
  $('tileSession').textContent = String(count);
  $('tileCommands').textContent = '0';
  const tick = () => {
    const t = fmtHMS((Date.now() - state.pageStart) / 1000);
    $('uptimeBig').textContent = t;
  };
  tick();
  setInterval(tick, 1000);

  const expand = $('uptimeExpand'), extra = $('uptimeExtra');
  const apply = () => {
    extra.hidden = !state.ui.uptimeExpanded;
    expand.setAttribute('aria-expanded', String(state.ui.uptimeExpanded));
    expand.classList.toggle('on', state.ui.uptimeExpanded);
  };
  expand.addEventListener('click', () => { state.ui.uptimeExpanded = !state.ui.uptimeExpanded; saveUi(); apply(); });
  apply();
}

function renderLoad() {
  const picked = pickStats();
  const d = picked && picked.d;
  const pi = state.stats && state.stats.pi;
  $('piUptime').textContent = pi && isNum(pi.uptime_s) ? fmtUptime(pi.uptime_s) : 'offline';
  if (!d || !Array.isArray(d.load) || !isNum(d.load[0]) || !isNum(d.ncpu) || d.ncpu <= 0) {
    $('loadLabel').textContent = '—'; $('loadPct').textContent = '—'; setBar($('loadBar'), 0);
    return;
  }
  const pct = clamp(Math.round(d.load[0] / d.ncpu * 100), 0, 100);
  $('loadLabel').textContent = pct < 30 ? 'Low' : pct < 70 ? 'Moderate' : 'High';
  $('loadPct').textContent = `${pct}%`;
  setBar($('loadBar'), pct);
}

function bumpCommands() {
  state.commands += 1;
  $('tileCommands').textContent = String(state.commands);
}

/* =============================================================================================
   Conversation
   ============================================================================================= */

const chat = {
  messages: [],       // {id, role:'user'|'assistant', text, ts, tools?:[], error?, aborted?, pending?}
  sessionId: null,
  title: 'Conversation',
  sessions: [],
  historyOpen: false,
  streaming: false,
  answering: false,   // the reply has started arriving (as opposed to still being worked on)
  toolsRunning: 0,    // tool calls in flight for the current reply (drives the "thinking" head)
  lane: null,         // 'quick' | 'deep' for the reply in progress, as the server decided it
  attachNext: false,  // the composer's camera toggle: send what the desk camera sees with the next message
  abort: null,
  els: new Map(),     // id → DOM node
  nextId: 1,
};

/* ---- markdown-lite (escape first, then a handful of constructs) ---- */
function renderMarkdown(src) {
  const text = escapeHtml(String(src || '').replace(/ /g, '').replace(/\r\n?/g, '\n'));
  const blocks = [];
  const stash = (html) => { blocks.push(html); return `\n B${blocks.length - 1} \n`; };

  let out = text.replace(/```([\w+-]*)[^\n]*\n([\s\S]*?)```/g, (m, lang, code) =>
    stash(`<pre><code${lang ? ` class="lang-${lang}"` : ''}>${code.replace(/\n$/, '')}</code></pre>`));
  out = out.replace(/```([\w+-]*)[^\n]*\n?([\s\S]*)$/, (m, lang, code) => stash(`<pre><code>${code}</code></pre>`)); // open fence while streaming

  const inline = (s) => {
    const spans = [];
    s = s.replace(/`([^`\n]+)`/g, (m, c) => { spans.push(`<code>${c}</code>`); return ` S${spans.length - 1} `; });
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, href) =>
      /^(https?:|mailto:)/i.test(href) ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>` : m);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    return s.replace(/ S(\d+) /g, (m, i) => spans[+i]);
  };

  const html = [];
  let para = [], list = null;
  const flushPara = () => { if (para.length) { html.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { html.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`); list = null; } };

  for (const line of out.split('\n')) {
    const ref = /^ B(\d+) $/.exec(line.trim());
    if (ref) { flushPara(); flushList(); html.push(blocks[+ref[1]]); continue; }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const type = ul ? 'ul' : 'ol';
      if (!list || list.type !== type) { flushList(); list = { type, items: [] }; }
      list.items.push((ul || ol)[1]);
      continue;
    }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ' ' + line.trim(); continue; }
    flushList();
    const h = /^\s*#{1,6}\s+(.*)$/.exec(line);
    para.push(h ? `<strong>${h[1]}</strong>` : line);
  }
  flushPara(); flushList();
  return html.join('');
}

/* ---- persistence ---- */
function persistConversation() {
  const messages = chat.messages
    .filter((m) => !m.pending || m.text)
    .map(({ role, text, ts, tools, error, aborted, emote, image }) => ({ role, text, ts, tools: tools && tools.length ? tools : undefined, error, aborted, emote: emote || undefined, image: image || undefined }));
  storage.set('nova.conversation', { sessionId: chat.sessionId, title: chat.title, messages });
}

function restoreConversation() {
  const saved = storage.get('nova.conversation', null);
  if (!saved || !Array.isArray(saved.messages)) return;
  chat.sessionId = typeof saved.sessionId === 'string' ? saved.sessionId : null;
  chat.title = typeof saved.title === 'string' && saved.title.trim() ? saved.title.trim() : 'Conversation';
  for (const m of saved.messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.text !== 'string') continue;
    addMessage({ role: m.role, text: m.text, ts: isNum(m.ts) ? m.ts : Date.now(), tools: Array.isArray(m.tools) ? m.tools : [], error: m.error, aborted: m.aborted, emote: !!m.emote, image: typeof m.image === 'string' ? m.image : undefined }, { persist: false, animate: false });
  }
}

/* ---- rendering ---- */
function isNearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 90; }

function renderEmpty() {
  const host = $('chatMessages');
  if (chat.messages.length) { const e = host.querySelector('.chat-empty'); if (e) e.remove(); return; }
  if (!host.querySelector('.chat-empty')) {
    const e = document.createElement('div');
    e.className = 'chat-empty';
    e.innerHTML = '<svg class="icon"><use href="#i-chat"/></svg><span>Connecting to Nova…</span>';
    host.appendChild(e);
  }
}

function addMessage(msg, { persist = true, animate = true } = {}) {
  msg.id = chat.nextId++;
  msg.tools = msg.tools || [];
  chat.messages.push(msg);
  const host = $('chatMessages');
  renderEmpty();
  const el = document.createElement('div');
  el.className = `msg ${msg.role}${msg.emote ? ' emote' : ''}`;
  if (!animate) el.style.animation = 'none';
  el.innerHTML = '<div class="bubble"><div class="chips"></div><div class="md"></div></div><div class="meta"></div>';
  host.appendChild(el);
  chat.els.set(msg.id, el);
  renderMessage(msg);
  host.scrollTop = host.scrollHeight;
  if (persist) persistConversation();
  return msg;
}

function renderMessage(msg) {
  const el = chat.els.get(msg.id);
  if (!el) return;
  const host = $('chatMessages');
  const stick = isNearBottom(host);
  el.classList.toggle('error', !!msg.error && !msg.text);
  const md = el.querySelector('.md');
  if (msg.pending && !msg.text) md.innerHTML = '<span class="typing" aria-label="Nova is typing"><i></i><i></i><i></i></span>';
  else md.innerHTML = msg.role === 'user' ? `<p>${escapeHtml(msg.text).replace(/\n/g, '<br>')}</p>` : (renderMarkdown(msg.text) || '<p class="dim">(empty reply)</p>');
  // A frame from the desk camera ("look at this", a photo, a desk-watch event) sits above the text.
  if (typeof msg.image === 'string' && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(msg.image)) {
    const img = document.createElement('img');
    img.className = 'attach';
    img.alt = msg.role === 'user' ? 'What the camera saw' : 'Photo';
    img.src = msg.image;
    md.prepend(img);
  }
  const chips = el.querySelector('.chips');
  chips.innerHTML = '';
  for (const t of msg.tools) {
    const chip = document.createElement('span');
    const done = t.status === 'completed' || t.status === 'done' || t.status === 'error';
    chip.className = `chip ${done ? 'completed' : 'running'}`;
    chip.title = `${t.tool || 'tool'} · ${t.status || ''}`;
    chip.innerHTML = `<svg class="icon"><use href="#${done ? 'i-check' : 'i-loader'}"/></svg><span class="chip-label"></span>`;
    chip.querySelector('.chip-label').textContent = `${t.emoji ? t.emoji + ' ' : ''}${t.tool || 'tool'}${t.label ? ' · ' + t.label : ''}`;
    chips.appendChild(chip);
  }
  const meta = el.querySelector('.meta');
  let stamp = fmtShortTime(msg.ts);
  if (msg.aborted) stamp += ' · stopped';
  else if (msg.error && msg.text) stamp += ' · error';
  meta.textContent = stamp;
  if (stick) host.scrollTop = host.scrollHeight;
}

let renderQueued = null;
function scheduleRender(msg) {
  if (renderQueued) return;
  renderQueued = requestAnimationFrame(() => { renderQueued = null; renderMessage(msg); });
}

function addGreeting() {
  const text = hermesOnline()
    ? 'Hello, I am NOVA. How can I assist you today?'
    : 'Hello, I am NOVA. The Nova backend is offline. Some features may be limited.';
  addMessage({ role: 'assistant', text, ts: Date.now(), greeting: true });
}

function setChatTitle(title) {
  chat.title = String(title || 'Conversation').trim() || 'Conversation';
  const el = $('chatTitle');
  el.textContent = chat.historyOpen ? 'Past sessions' : chat.title;
  el.title = chat.title;
}

function resetConversation({ greeting = true } = {}) {
  stopStreaming();
  voice.speech?.cancelSpeech();
  chat.messages = [];
  chat.els.clear();
  chat.sessionId = null;
  chat.nextId = 1;
  $('chatMessages').innerHTML = '';
  storage.remove('nova.conversation');
  if (greeting) addGreeting();
}

function showHistory(open) {
  chat.historyOpen = !!open;
  $('chatView').hidden = chat.historyOpen;
  $('sessionHistory').hidden = !chat.historyOpen;
  $('chatHistory').setAttribute('aria-pressed', String(chat.historyOpen));
  $('chatHistory').classList.toggle('active', chat.historyOpen);
  $('chatExport').disabled = chat.historyOpen;
  $('chatTitle').textContent = chat.historyOpen ? 'Past sessions' : chat.title;
  if (chat.historyOpen) loadSessions();
}

function startNewChat() {
  showHistory(false);
  setChatTitle('New chat');
  resetConversation();
  $('chatInput').focus();
  toast('New Nova chat started', 'info', 1800);
}

function sessionTimestamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Date.now();
  return n < 1e12 ? n * 1000 : n;
}

function sessionDate(value) {
  const date = new Date(sessionTimestamp(value));
  if (!Number.isFinite(date.getTime())) return '';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay ? fmtShortTime(date.getTime()) : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderSessions({ loading = false, error = '' } = {}) {
  const host = $('sessionList');
  host.innerHTML = '';
  if (loading || error || !chat.sessions.length) {
    const empty = document.createElement('div');
    empty.className = `session-empty${error ? ' error' : ''}`;
    empty.textContent = loading ? 'Loading conversations…' : error || 'No past Hermes sessions yet.';
    host.appendChild(empty);
    return;
  }

  for (const session of chat.sessions) {
    if (!session || typeof session.id !== 'string') continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'session-row';
    if (session.id === chat.sessionId) button.classList.add('current');
    const heading = document.createElement('span');
    heading.className = 'session-row-title';
    heading.textContent = session.title || session.preview || 'Untitled conversation';
    // Hermes titles a session after its first message, so the preview is usually the
    // same line again — sometimes ellipsised. Only show it when it really adds something.
    const norm = (t) => String(t || '').replace(/[…]|\.\.\.$/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const title = norm(heading.textContent), prev = norm(session.preview);
    const previewText = !prev || prev === title || prev.startsWith(title) || title.startsWith(prev)
      ? '' : (session.preview || '');
    const preview = document.createElement('span');
    preview.className = 'session-row-preview';
    preview.textContent = previewText;
    preview.hidden = !previewText;
    const meta = document.createElement('span');
    meta.className = 'session-row-meta mono';
    const count = Number(session.message_count) || 0;
    meta.textContent = `${sessionDate(session.last_active || session.started_at)} · ${count} message${count === 1 ? '' : 's'}`;
    button.append(heading, preview, meta);
    button.addEventListener('click', () => openSession(session));
    host.appendChild(button);
  }
}

async function loadSessions({ silent = false } = {}) {
  const refresh = $('sessionRefresh');
  refresh.classList.add('spinning');
  if (!silent) renderSessions({ loading: true });
  try {
    const result = await getJSON('/api/sessions?limit=50', 10000);
    chat.sessions = Array.isArray(result.data) ? result.data : [];
    if (chat.historyOpen) renderSessions();
  } catch (err) {
    if (chat.historyOpen) renderSessions({ error: `Could not load sessions: ${(err && err.message) || err}` });
    if (!silent) toast('Could not load Hermes session history');
  } finally {
    refresh.classList.remove('spinning');
  }
}

async function openSession(session) {
  if (chat.streaming) {
    toast('Stop the current reply before switching chats', 'info', 2200);
    return;
  }
  renderSessions({ loading: true });
  try {
    const result = await getJSON(`/api/sessions/${encodeURIComponent(session.id)}/messages`, 12000);
    resetConversation({ greeting: false });
    chat.sessionId = session.id;
    setChatTitle(session.title || session.preview || 'Conversation');
    for (const item of Array.isArray(result.data) ? result.data : []) {
      if (!item || (item.role !== 'user' && item.role !== 'assistant') || typeof item.content !== 'string' || !item.content.trim()) continue;
      addMessage({ role: item.role, text: item.content, ts: sessionTimestamp(item.timestamp) }, { persist: false, animate: false });
    }
    if (!chat.messages.length) renderEmpty();
    persistConversation();
    showHistory(false);
    toast('Hermes session loaded', 'info', 1600);
  } catch (err) {
    renderSessions({ error: `Could not open this session: ${(err && err.message) || err}` });
  }
}

/* ---- streaming send ---- */
const streamIdleWaiters = [];

function setStreaming(on) {
  chat.streaming = on;
  const btn = $('chatSend');
  btn.classList.toggle('stop', on);
  btn.setAttribute('aria-label', on ? 'Stop generating' : 'Send message');
  btn.title = on ? 'Stop (Esc)' : 'Send (Enter)';
  if (!on) { const w = streamIdleWaiters.splice(0); for (const r of w) r(); }
  updateStatus();
}

/** Resolves once no answer is streaming — used when a spoken interruption replaces the current one. */
function whenStreamIdle(timeoutMs = 2000) {
  if (!chat.streaming) return Promise.resolve();
  return new Promise((resolve) => {
    streamIdleWaiters.push(resolve);
    setTimeout(resolve, timeoutMs);
  });
}

/* ---- speaking a reply while it is still streaming ---- */

// Waiting for the whole answer before speaking leaves seconds of silence on long replies, so
// completed sentences are handed to the speech queue as they arrive. The first chunk is allowed
// to be short (start talking sooner); later ones are longer so the delivery is not choppy — but
// a finished sentence that is followed by silence (Nova has gone off to use a tool) is spoken
// after CHUNK_IDLE_MS regardless of length, so "Let me look into that, sir." is heard at once.
const FIRST_CHUNK_CHARS = 40;
const NEXT_CHUNK_CHARS = 80;
const CHUNK_IDLE_MS = 350;
const SENTENCE_END = /[.!?…]["'”’)\]]*(?=\s|$)|\n{2,}/g;

/** Longest prefix of `text` ending on a sentence boundary, or 0 when there is none. */
function sentenceCut(text) {
  SENTENCE_END.lastIndex = 0;
  let cut = 0;
  let m;
  while ((m = SENTENCE_END.exec(text))) cut = m.index + m[0].length;
  return cut;
}

function createReplySpeaker(enabled, { onGesture = () => {} } = {}) {
  let pending = '';        // reply text not yet handed to the speech queue
  let base = 0;            // offset, in the whole reply, of pending[0]
  let spoke = false;
  let idleTimer = 0;
  const cues = [];         // gesture cues waiting for the sentence they belong to: { name, at }

  /** Take the cues that fall inside [from, to) of the reply, in order. */
  function cuesFor(from, to) {
    const taken = [];
    for (let i = 0; i < cues.length;) {
      if (cues[i].at >= from && cues[i].at < to) taken.push(cues.splice(i, 1)[0]);
      else i += 1;
    }
    return taken;
  }

  function fire(list) { for (const c of list) onGesture(c.name); }

  function flush(force, relaxed = false) {
    if (!enabled) return;
    clearTimeout(idleTimer); idleTimer = 0;
    // An unterminated ``` fence means code is still arriving — never read that aloud.
    const fenceOpen = (pending.match(/```/g) || []).length % 2 === 1;
    if (fenceOpen && !force) return;
    const take = force ? pending.length : sentenceCut(pending);
    if (!take) { if (force) fire(cuesFor(-Infinity, Infinity)); return; }
    let chunk = pending.slice(0, take);
    if (force && fenceOpen) chunk = chunk.replace(/```[\s\S]*$/, ' ');
    if (!force && !relaxed && chunk.trim().length < (spoke ? NEXT_CHUNK_CHARS : FIRST_CHUNK_CHARS)) return;
    const from = base;
    const to = base + take;
    pending = pending.slice(take);
    base = to;
    const attached = cuesFor(from, force ? Infinity : to);
    voice.speech.speakChunk(chunk, { onStart: attached.length ? () => fire(attached) : null });
    spoke = true;
  }

  function armIdle() {
    clearTimeout(idleTimer);
    if (!sentenceCut(pending)) return;
    idleTimer = setTimeout(() => { idleTimer = 0; flush(false, true); }, CHUNK_IDLE_MS);
  }

  return {
    push(t) { if (!enabled) return; pending += t; flush(false); armIdle(); },
    /** A gesture cue arrived for reply offset `at`. */
    cue(name, at) {
      if (!enabled) { onGesture(name); return; }
      // Belongs to text that is already playing or played: do it now rather than never.
      if (at < base) { onGesture(name); return; }
      cues.push({ name, at: Number(at) || 0 });
    },
    /** Flush whatever is left and wait for the queue to drain. */
    async finish() { if (!enabled) return; flush(true); await voice.speech.whenIdle(); },
    cancel() { clearTimeout(idleTimer); idleTimer = 0; cues.length = 0; },
    spokeAnything: () => spoke,
  };
}

/* ---- fillers: an acknowledgement when the answer is slow, "still on it" when it is very slow ---- */

const recentPhrases = new Map();
const ACK_INITIAL_DELAY_MS = 1100;  // a quick reply beats this, and then no filler is needed at all
const WORKING_GAP_MS = 20000;       // silence this long while still working -> "Still on it."

function createAckRunner(enabled) {
  let timer = 0;
  let started = 0;
  let lastHeard = 0;      // when Nova's voice was last in the air (filler or reply)
  let opened = false;     // the opening acknowledgement has been decided (spoken or skipped)
  let toolAcked = false;

  function say(list, key) {
    if (!enabled) return;
    lastHeard = Date.now();
    voice.speech.speakAck(pickPhrase(list, recentPhrases, key));
  }

  function tick() {
    if (!enabled || !chat.streaming) return;
    const now = Date.now();
    if (voice.speech.isSpeaking()) { lastHeard = now; return; }   // something is already playing
    if (!opened) {
      if (now - started < ACK_INITIAL_DELAY_MS) return;
      opened = true;
      if (!chat.answering) say(ACK_PHRASES, 'ack');               // nothing has arrived yet: "On it."
      return;
    }
    if (now - lastHeard < WORKING_GAP_MS) return;
    say(WORKING_PHRASES, 'working');
  }

  return {
    start() {
      if (!enabled) return;
      started = lastHeard = Date.now();
      timer = setInterval(tick, 250);
    },
    /** The reply itself has started: it is the acknowledgement, so no filler in front of it. */
    noteFirstText() { opened = true; lastHeard = Date.now(); },
    /**
     * The server has picked the lane. Deep work never answers inside a second, and Nova's own
     * opening line ("Let me check the load for you, sir") follows only after she has thought about
     * it — so say at once that she is on it, rather than leaving the first seconds silent.
     */
    noteLane(lane) {
      if (!enabled || opened || lane !== 'deep') return;
      opened = true;
      if (!chat.answering) say(DEEP_PHRASES, 'deep');
    },
    noteTool() {
      if (!enabled || toolAcked) return;
      toolAcked = true;
      // In the deep lane Nova has already said what she is about to do; and a very fresh "On it."
      // still covers a tool that starts a moment later.
      if (chat.answering || Date.now() - lastHeard < 4000) return;
      say(TOOL_PHRASES, 'tool');
    },
    stop() { if (timer) { clearInterval(timer); timer = 0; } },
  };
}

async function sendMessage(text, { viaVoice = false, withImage = false } = {}) {
  text = String(text || '').trim();
  if (!text || chat.streaming) return;

  const mode = state.settings.speak;
  const willSpeak = mode === 'always' || (mode === 'voice' && viaVoice);
  const useAcks = willSpeak && state.settings.acks;
  const useGestures = state.settings.gestures && pantiltOk();

  // "Look at this": grab what the desk camera sees right now and send it along with the words.
  let image = null;
  let thumb = null;
  if (withImage) {
    const frame = await captureFrame();
    if (frame) { image = frame.dataUrl; thumb = frame.thumb; }
    else toast('Could not get a frame from the camera — asking without it', 'info', 2600);
  }

  if (!chat.sessionId && (chat.title === 'Conversation' || chat.title === 'New chat')) {
    setChatTitle(text.length > 42 ? `${text.slice(0, 39).trim()}…` : text);
  }
  addMessage({ role: 'user', text, ts: Date.now(), image: thumb || undefined });
  bumpCommands();
  chat.answering = false;
  chat.toolsRunning = 0;
  chat.lane = null;
  const reply = addMessage({ role: 'assistant', text: '', ts: Date.now(), tools: [], pending: true }, { persist: false });
  setStreaming(true);

  // A quick reply arrives in about a second; the acknowledgement filler is only spoken if it
  // does not (createAckRunner decides), so a fast exchange is not padded with "On it."
  const speaker = createReplySpeaker(willSpeak, { onGesture: (name) => { if (useGestures) triggerGesture(name); } });
  const acks = createAckRunner(useAcks);
  acks.start();

  const bargeMark = bargeInSeq;
  const ac = new AbortController();
  chat.abort = ac;
  let streamError = null;

  try {
    await streamChat({
      message: text,
      sessionId: chat.sessionId,
      mode: state.settings.lane,
      voice: willSpeak,
      gestures: useGestures,
      image,
      signal: ac.signal,
      onLane: (p) => { if (p && typeof p.lane === 'string') { chat.lane = p.lane; acks.noteLane(p.lane); updateStatus(); } },
      onDelta: (t) => {
        reply.text += t; reply.pending = false; scheduleRender(reply); speaker.push(t);
        if (!chat.answering) { chat.answering = true; acks.noteFirstText(); updateStatus(); }   // stop pondering, look back at them
      },
      onGesture: (p) => { if (p && typeof p.name === 'string') speaker.cue(p.name, p.at); },
      onTool: (p) => {
        if (!p || typeof p !== 'object') return;
        const key = p.toolCallId || `${p.tool}:${p.label}`;
        const existing = reply.tools.find((x) => (x.toolCallId || `${x.tool}:${x.label}`) === key);
        if (existing) Object.assign(existing, p);
        else reply.tools.push({ tool: p.tool, emoji: p.emoji, label: p.label, toolCallId: p.toolCallId, status: p.status });
        reply.pending = reply.pending && !reply.text;
        scheduleRender(reply);
        chat.toolsRunning = reply.tools.filter((x) => !(x.status === 'completed' || x.status === 'done' || x.status === 'error')).length;
        acks.noteTool();
        noteAttentionTool();
        updateStatus();
      },
      onDone: (p) => { if (p && typeof p.session_id === 'string' && p.session_id) chat.sessionId = p.session_id; },
      onError: (m) => { streamError = m; },
    });
    if (streamError) {
      reply.error = streamError;
      if (!reply.text) reply.text = `Nova returned an error: ${streamError}`;
      toast(`Nova error: ${streamError}`);
    }
  } catch (e) {
    if (e && e.name === 'AbortError') {
      reply.aborted = true;
      if (!reply.text) reply.text = '_Stopped._';
    } else {
      const m = (e && e.message) || 'request failed';
      reply.error = m;
      if (!reply.text) reply.text = hermesOnline() ? `I couldn't reach Nova: ${m}` : 'The Nova backend is offline, so I can\'t answer right now.';
      toast(`Chat failed: ${m}`);
    }
  } finally {
    acks.stop();
    if (renderQueued) { cancelAnimationFrame(renderQueued); renderQueued = null; }
    reply.pending = false;
    chat.abort = null;
    chat.toolsRunning = 0;
    setStreaming(false);
    renderMessage(reply);
    persistConversation();
    loadSessions({ silent: true });
  }

  const interrupted = bargeInSeq !== bargeMark;
  if (reply.aborted) {
    // A voice interruption has already cancelled playback and opened the listening window; only a
    // keyboard stop needs to silence her here.
    speaker.cancel();
    if (!interrupted) voice.speech.cancelSpeech();
  } else if (willSpeak && reply.text) {
    // Errors were never streamed through the speaker, so they still need saying in full.
    if (!speaker.spokeAnything() && reply.error) await speakReply(reply.text);
    else await speakOut(() => speaker.finish());
  }

  chat.answering = false;
  chat.lane = null;
  updateStatus();

  // Nova has stopped talking: reopen the "just talk" window so the next turn needs no wake word.
  // After an interruption speech.js already holds a longer one, so leave that alone.
  if (!interrupted && viaVoice && voice.micOn && state.settings.conversation) voice.speech.openFollowUp();
}

function stopStreaming() { if (chat.abort) chat.abort.abort(); }

function exportConversation() {
  const now = new Date();
  const lines = [`# Nova conversation`, ``, `_Exported ${fmtDate(now)} ${fmtClock(now)}_`, ``];
  if (chat.sessionId) lines.push(`Session: \`${chat.sessionId}\``, ``);
  for (const m of chat.messages) {
    if (m.pending && !m.text) continue;
    const who = m.role === 'user' ? 'You' : 'Nova';
    lines.push(`**${who}** · ${fmtShortTime(m.ts)}`, ``);
    if (m.tools && m.tools.length) lines.push(...m.tools.map((t) => `> ${t.emoji ? t.emoji + ' ' : ''}${t.tool}${t.label ? ' · ' + t.label : ''} (${t.status || ''})`), ``);
    lines.push(m.text.trim(), ``);
  }
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/markdown;charset=utf-8' });
  downloadBlob(blob, `nova-conversation-${fmtStamp(now)}.md`);
}

function initChat() {
  const form = $('chatForm'), input = $('chatInput'), send = $('chatSend');
  const autoGrow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 118)}px`; };
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
    if (e.key === 'Escape' && chat.streaming) stopStreaming();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (chat.streaming) { stopStreaming(); return; }
    const text = input.value;
    if (!text.trim()) return;
    input.value = '';
    autoGrow();
    const withImage = chat.attachNext;
    setAttachNext(false);
    if (!withImage && handleLocalCommand(text)) return;
    sendMessage(text, { withImage: withImage || isVisionRequest(text) });
  });
  $('chatAttach').addEventListener('click', () => setAttachNext(!chat.attachNext));
  send.addEventListener('click', (e) => { if (chat.streaming) { e.preventDefault(); stopStreaming(); } });
  $('chatNew').addEventListener('click', startNewChat);
  $('chatHistory').addEventListener('click', () => showHistory(!chat.historyOpen));
  $('sessionRefresh').addEventListener('click', () => loadSessions());
  $('chatExport').addEventListener('click', exportConversation);
  $('btnKeyboard').addEventListener('click', () => {
    drawers.open('right');
    requestAnimationFrame(() => { input.focus(); input.scrollIntoView({ block: 'nearest' }); });
  });
  restoreConversation();
  setChatTitle(chat.title);
  renderEmpty();
  autoGrow();
}

/* =============================================================================================
   Orb · mic · speech · status
   ============================================================================================= */

const voice = { micOn: false, awake: false, conversation: false, speaking: false, recStatus: 'stopped', warmed: false, orb: null, audio: null, speech: null };

// Bumped every time the user cuts Nova off by voice. A turn compares the count it started with to
// find out whether it was interrupted, which is exact and cannot leak into the following turn.
let bargeInSeq = 0;

/** A synthetic beat for the orb while the head vibes: a pulse phase-locked to the Pi's beat clock. */
function vibePulse() {
  const v = vibeState();
  if (!v || !v.vibing || !isNum(v.bpm) || v.bpm <= 0) return ZERO_AUDIO;
  const period = 60 / v.bpm;
  // /api/pi/status told us when the next beat was due (relative to the Pi clock at poll time).
  const anchor = (companion.statusAt || 0) + (Number(v.next_beat_in_s) || 0) * 1000;
  const phase = ((Date.now() - anchor) / 1000 / period) % 1;
  const p = Math.exp(-((phase + 1) % 1) / 0.22) * (0.35 + 0.65 * (Number(v.strength) || 0.5));
  return { level: p * 0.9, bass: p, mid: p * 0.4, treble: p * 0.25 };
}

function orbState() {
  if (chat.streaming) return 'thinking';
  if (voice.speaking) return 'speaking';
  if (voice.micOn) return 'listening';
  return 'idle';
}

function computeStatus() {
  if (voice.speaking) return ['speaking', 'Speaking...'];
  if (chat.streaming) {
    if (chat.lane === 'deep') return ['thinking', chat.toolsRunning > 0 ? 'Working on it…' : 'Looking into it…'];
    return ['thinking', chat.toolsRunning > 0 ? 'Checking…' : 'Thinking...'];
  }
  if (voice.micOn) {
    if (!voice.speech.supported) return ['unsupported', 'Speech recognition not supported in this browser'];
    if (voice.awake) return ['awake', 'Yes?'];
    if (voice.recStatus.startsWith('error:')) return ['unsupported', `Speech recognition error: ${voice.recStatus.slice(6)}`];
    if (voice.conversation) return ['conversation', 'Go ahead — no wake word needed'];
    const vibeNow = vibeState();
    if (vibeNow && vibeNow.vibing) return ['vibing', `Vibing${vibeNow.bpm ? ` · ${Math.round(vibeNow.bpm)} BPM` : ''} — say "Nova" to talk`];
    return ['listening', state.settings.wakeWord ? 'Listening for wake word...' : 'Listening...'];
  }
  const metro = metroState();
  if (metro && metro.running) return ['vibing', `Metronome · ${Math.round(metro.bpm)} BPM`];
  const vibe = vibeState();
  if (vibe && vibe.vibing) return ['vibing', `Vibing${vibe.bpm ? ` · ${Math.round(vibe.bpm)} BPM` : ''}`];
  if (!state.health) return ['offline', 'Connecting…'];
  if (!hermesOnline()) return ['offline', 'Nova backend offline'];
  if (!window.isSecureContext) return ['unsupported', 'Open Nova at localhost:8420 to use this Mac\'s microphone'];
  return ['idle', 'MacBook mic off — click the mic to enable'];
}

function updateStatus() {
  if (!voice.orb) return;
  const [st, text] = computeStatus();
  const pill = $('statusPill');
  pill.dataset.state = st;
  $('statusText').textContent = text;
  pill.title = text;
  voice.orb.setState(orbState());
  // Every state transition already funnels through here, so this is the one place the head needs
  // to be told about. It change-detects internally — updateStatus() can be called from a rAF loop.
  syncAttention();
}

function initOrb() {
  const canvas = $('orb');
  try {
    voice.orb = createOrb(canvas, { sensitivity: state.settings.sensitivity });
  } catch (e) {
    voice.orb = { setAudio() {}, setState() {}, setSensitivity() {}, resize() {}, destroy() {} };
    toast('Orb renderer failed to start; continuing without it');
  }
  const loop = () => {
    requestAnimationFrame(loop);
    if (document.hidden) return;
    voice.orb.setAudio(voice.micOn && voice.audio.isActive() ? voice.audio.getLevels() : vibePulse());
    // The speech queue plays acknowledgements and reply chunks on its own schedule; watch it here
    // rather than wrapping every call site, so the orb and status pill always match what is heard.
    const nowSpeaking = !!(voice.speech && voice.speech.isSpeaking());
    if (nowSpeaking !== voice.speaking) { voice.speaking = nowSpeaking; updateStatus(); }
  };
  requestAnimationFrame(loop);
  window.addEventListener('resize', () => voice.orb.resize && voice.orb.resize());
}

function applyVoiceSettings() {
  const s = state.settings;
  voice.speech.setWakeWord(s.wakeWord, s.wakePhrase);
  voice.speech.setConversation({
    enabled: s.conversation,
    windowMs: Math.max(0, Number(s.followUpSec) || 0) * 1000,
    bargeIn: s.bargeIn,
  });
  voice.speech.setAcks(s.acks);
}

function initVoice() {
  voice.audio = createMicAnalyser();
  voice.speech = createSpeech({
    onCommand: async (text, meta = {}) => {
      $('interim').textContent = '';
      // "Nova, nod" / "set a timer" / "take a photo" / "watch my desk": handled here, at once.
      if (!chat.streaming && handleLocalCommand(text, { viaVoice: true })) return;
      const withImage = isVisionRequest(text);
      // Look at them *now*, before the round trip. speech.js only emits onStatus('awake') for a
      // bare wake word ("Nova?"); the far commoner "Nova, what's the weather" goes straight to
      // dispatch(), which clears the awake flag first. Without this hook the head would never
      // search for a face on the normal path -- it would go straight to the thinking gesture.
      if (state.settings.followMe && pantiltOk() && !attentionMuted()) {
        attention.mode = 'wake';
        pushAttention('wake');
      }
      // A deliberate interruption replaces whatever Nova was doing instead of being turned away.
      if (chat.streaming) {
        if (!meta.bargeIn && !state.settings.bargeIn) {
          toast('Nova is still thinking — try again in a moment', 'info', 2500);
          return;
        }
        stopStreaming();
        await whenStreamIdle();
      }
      voice.speech.cancelSpeech();
      sendMessage(text, { viaVoice: true, withImage });
    },
    onStatus: (s) => {
      voice.recStatus = s;
      voice.awake = s === 'awake';
      voice.conversation = s === 'open';
      if (s === 'unsupported') toast('Speech recognition is not supported in this browser — the mic will still drive the orb', 'info');
      else if (s === 'error:not-allowed' || s === 'error:service-not-allowed') toast('Speech recognition was blocked — check the microphone permission');
      else if (s === 'error:network') toast('Speech recognition network error — retrying');
      updateStatus();
    },
    onInterim: (t) => { $('interim').textContent = t || ''; },
    onConversation: (active) => { voice.conversation = active; updateStatus(); },
    onBargeIn: () => {
      // speech.js has already stopped the audio and is holding the mic open for the user; the turn
      // this interrupts must not undo either of those.
      bargeInSeq++;
      if (chat.streaming) stopStreaming();
    },
    onInterrupt: () => {
      if (state.settings.speak === 'off') return;
      voice.speech.speakAck(pickPhrase(INTERRUPT_PHRASES, recentPhrases, 'interrupt'));
    },
    onSignoff: () => {
      // A courtesy even when the thinking fillers are switched off, so a "goodbye" is acknowledged.
      if (state.settings.speak === 'off') return;
      voice.speech.speak(pickPhrase(SIGNOFF_PHRASES, recentPhrases, 'signoff'));
    },
    onTtsFallback: (message) => {
      // The browser's own voice is a perfectly good Nova, and speech.js only reaches for the
      // server once every few minutes once it has failed. A toast about it every time she speaks
      // is noise about a fallback that is working.
      console.warn('Hermes TTS unavailable; using browser voice:', message);
    },
  });
  applyVoiceSettings();
  $('btnMic').addEventListener('click', () => setMic(!voice.micOn));
  $('btnMic').title = 'Use this MacBook microphone';
}

async function setMic(on) {
  const btn = $('btnMic');
  if (on === voice.micOn) return;
  if (on) {
    if (!window.isSecureContext) {
      toast('For MacBook microphone access, open Nova at http://127.0.0.1:8420');
      return;
    }
    try { await voice.audio.start(); }
    catch (e) {
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      toast(denied ? 'MacBook microphone access denied — allow microphone access for this browser' : `MacBook microphone unavailable: ${(e && e.message) || e}`);
      return;
    }
    voice.micOn = true;
    voice.recStatus = 'stopped';
    if (voice.speech.supported) voice.speech.startListening();
    else voice.recStatus = 'unsupported';
    // Pull the filler phrases into memory once, so the first "On it." plays without a round trip.
    if (!voice.warmed && state.settings.acks) {
      voice.warmed = true;
      voice.speech.prewarm().catch(() => {});
    }
  } else {
    voice.micOn = false; voice.awake = false; voice.conversation = false;
    voice.speech.stopListening();
    voice.audio.stop();
    $('interim').textContent = '';
  }
  btn.classList.toggle('active', voice.micOn);
  btn.setAttribute('aria-pressed', String(voice.micOn));
  btn.title = voice.micOn ? 'Turn MacBook microphone off' : 'Use this MacBook microphone';
  updateStatus();
}

/** Speak `text` as one block (used for errors, which never went through the streaming speaker). */
async function speakReply(text) {
  await voice.speech.speak(text);
}

/** Run a speech operation to completion; `voice.speaking` is tracked by the orb loop. */
async function speakOut(fn) {
  try { await fn(); } catch (e) { console.warn('speech failed', e); }
}

/* =============================================================================================
   Settings modal
   ============================================================================================= */

function renderConnectionInfo() {
  const c = state.config || {};
  const h = state.health;
  $('connServer').textContent = location.origin + (h && h.unreachable ? '  (API unreachable)' : '');
  const hermesEl = $('connHermes');
  if (h && h.hermes && h.hermes.ok) {
    hermesEl.innerHTML = `${escapeHtml(c.hermes_url || '')} <span class="ok">● online</span>${h.hermes.version ? ` · v${escapeHtml(h.hermes.version)}` : ''}${isNum(h.hermes.latency_ms) ? ` · ${h.hermes.latency_ms} ms` : ''}`;
  } else {
    hermesEl.innerHTML = `${escapeHtml(c.hermes_url || 'http://raspberrypi.local:8642')} <span class="bad">● offline</span>`;
  }
  const piEl = $('connPi');
  if (h && h.pi_bridge && h.pi_bridge.ok) {
    piEl.innerHTML = `${escapeHtml(c.pi_bridge_url || '')} <span class="ok">● online</span> · camera ${h.pi_bridge.camera ? '✓' : '✗'} · pan-tilt ${h.pi_bridge.pantilt ? '✓' : '✗'}`;
  } else {
    piEl.innerHTML = `${escapeHtml(c.pi_bridge_url || 'http://raspberrypi.local:8433')} <span class="bad">● offline</span>`;
  }
  $('connHost').textContent = c.host_name || '—';
}

function initSettings() {
  const modal = $('settingsModal');
  const s = state.settings;
  const wake = $('setWake'), phrase = $('setWakePhrase'), speak = $('setSpeak'), cam = $('setCamSource');
  const convo = $('setConversation'), followUp = $('setFollowUp'), bargeIn = $('setBargeIn'), acks = $('setAcks');
  const followMe = $('setFollowMe'), gestures = $('setGestures'), lane = $('setLane');
  const presence = $('setPresence'), briefing = $('setBriefing'), brk = $('setBreak'), telegram = $('setTelegram');
  const vibe = $('setVibe'), vibeAmp = $('setVibeAmp');
  const statsSrc = $('setStatsSource'), sens = $('setSensitivity'), sensVal = $('setSensitivityVal'), unit = $('setUnit');

  const syncSens = () => {
    sensVal.textContent = `${Number(sens.value).toFixed(2)}×`;
    sens.style.setProperty('--pct', `${((sens.value - sens.min) / (sens.max - sens.min)) * 100}%`);
  };
  const syncForm = () => {
    $('setAudioDevice').textContent = window.isSecureContext ? 'MacBook browser' : 'Needs localhost';
    wake.checked = !!s.wakeWord;
    phrase.value = s.wakePhrase;
    phrase.disabled = !s.wakeWord;
    convo.checked = !!s.conversation;
    followUp.value = String(s.followUpSec);
    followUp.disabled = !s.conversation;
    bargeIn.checked = !!s.bargeIn;
    acks.checked = !!s.acks;
    speak.value = s.speak;
    cam.value = s.cameraSource;
    followMe.checked = !!s.followMe;
    gestures.checked = !!s.gestures;
    lane.value = ['auto', 'quick', 'deep'].includes(s.lane) ? s.lane : 'auto';
    presence.checked = !!s.presence;
    briefing.checked = !!s.briefing;
    brk.value = String([0, 45, 60, 90].includes(Number(s.breakMin)) ? Number(s.breakMin) : 0);
    telegram.checked = !!s.telegram;
    vibe.checked = !!s.vibe;
    vibeAmp.value = String([0.6, 1, 1.5].includes(Number(s.vibeAmp)) ? Number(s.vibeAmp) : 1);
    statsSrc.value = s.statsSource;
    sens.value = String(s.sensitivity);
    syncSens();
    for (const b of unit.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.unit === s.unit));
  };

  wake.addEventListener('change', () => { s.wakeWord = wake.checked; phrase.disabled = !s.wakeWord; saveSettings(); applyVoiceSettings(); updateStatus(); });
  convo.addEventListener('change', () => {
    s.conversation = convo.checked;
    followUp.disabled = !s.conversation;
    saveSettings();
    applyVoiceSettings();
    updateStatus();
  });
  followUp.addEventListener('change', () => { s.followUpSec = Number(followUp.value) || 0; saveSettings(); applyVoiceSettings(); });
  bargeIn.addEventListener('change', () => { s.bargeIn = bargeIn.checked; saveSettings(); applyVoiceSettings(); });
  acks.addEventListener('change', () => {
    s.acks = acks.checked;
    saveSettings();
    applyVoiceSettings();
    if (s.acks && !voice.warmed) { voice.warmed = true; voice.speech.prewarm().catch(() => {}); }
  });
  let phraseTimer = 0;
  phrase.addEventListener('input', () => {
    clearTimeout(phraseTimer);
    phraseTimer = setTimeout(() => { s.wakePhrase = (phrase.value.trim() || 'nova').toLowerCase(); saveSettings(); applyVoiceSettings(); }, 300);
  });
  speak.addEventListener('change', () => { s.speak = speak.value; saveSettings(); if (s.speak === 'off') { voice.speech.cancelSpeech(); } });
  cam.addEventListener('change', () => { s.cameraSource = cam.value; saveSettings(); restartCamera(); });
  followMe.addEventListener('change', () => {
    s.followMe = followMe.checked;
    saveSettings();
    // Switching it off must put the head down now, not when the lease happens to lapse.
    attention.mutedUntil = 0;
    attention.fails = 0;
    attention.mode = null;      // force a push in either direction, whatever the derived mode is
    syncAttention();
  });
  gestures.addEventListener('change', () => { s.gestures = gestures.checked; saveSettings(); if (!s.gestures) stopGesture(); syncAttention(); });
  lane.addEventListener('change', () => { s.lane = lane.value; saveSettings(); });
  presence.addEventListener('change', () => { s.presence = presence.checked; saveSettings(); applyPresenceSetting(); });
  briefing.addEventListener('change', () => { s.briefing = briefing.checked; saveSettings(); });
  brk.addEventListener('change', () => { s.breakMin = Number(brk.value) || 0; saveSettings(); });
  telegram.addEventListener('change', () => {
    s.telegram = telegram.checked; saveSettings();
    if (companion.status && companion.status.watch && companion.status.watch.enabled) setWatch(true, { quiet: true });
  });
  vibe.addEventListener('change', () => { s.vibe = vibe.checked; saveSettings(); applyVibeSetting(); renderGroove(); });
  vibeAmp.addEventListener('change', () => { s.vibeAmp = Number(vibeAmp.value) || 1; saveSettings(); applyVibeSetting(); });
  statsSrc.addEventListener('change', () => { s.statsSource = statsSrc.value; saveSettings(); renderStats(); renderLoad(); });
  sens.addEventListener('input', () => { s.sensitivity = Number(sens.value); syncSens(); voice.orb.setSensitivity(s.sensitivity); });
  sens.addEventListener('change', saveSettings);
  unit.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-unit]');
    if (!b) return;
    s.unit = b.dataset.unit; saveSettings(); syncForm(); renderWeather();
  });

  let lastFocus = null;
  const open = () => { syncForm(); renderConnectionInfo(); lastFocus = document.activeElement; modal.hidden = false; $('settingsClose').focus(); };
  const close = () => { modal.hidden = true; if (lastFocus && lastFocus.focus) lastFocus.focus(); };
  $('settingsBtn').addEventListener('click', open);
  $('settingsClose').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) { e.preventDefault(); close(); } });
  syncForm();
}

/* =============================================================================================
   Side columns
   ============================================================================================= */

const drawers = { open() {}, toggle() {} };

function initColumns() {
  const layout = $('layout');
  const apply = () => {
    layout.classList.toggle('no-left', !state.ui.left);
    layout.classList.toggle('no-right', !state.ui.right);
    $('colLeft').setAttribute('aria-hidden', String(!state.ui.left));
    $('colRight').setAttribute('aria-hidden', String(!state.ui.right));
    $('edgeLeft').setAttribute('aria-expanded', String(state.ui.left));
    $('edgeRight').setAttribute('aria-expanded', String(state.ui.right));
    $('edgeLeft').title = state.ui.left ? 'Hide panels' : 'Show panels';
    $('edgeRight').title = state.ui.right ? 'Hide conversation' : 'Show conversation';
    if (voice.orb && voice.orb.resize) requestAnimationFrame(() => voice.orb.resize());
  };
  const set = (side, on) => { if (state.ui[side] === on) return; state.ui[side] = on; saveUi(); apply(); };
  drawers.open = (side) => set(side, true);
  drawers.toggle = (side) => set(side, !state.ui[side]);

  $('edgeLeft').addEventListener('click', () => drawers.toggle('left'));
  $('edgeRight').addEventListener('click', () => drawers.toggle('right'));
  // Escape closes whatever is open, so the screen goes back to just the orb
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !$('settingsModal').hidden) return;
    if (!state.ui.left && !state.ui.right) return;
    if (document.activeElement && document.activeElement.closest('.col')) document.activeElement.blur();
    set('left', false); set('right', false);
  });
  apply();
}

/* =============================================================================================
   Init
   ============================================================================================= */

async function loadConfig() {
  try {
    state.config = await getJSON('/api/config', 5000);
    if (state.config.wordmark) { $('wordmark').textContent = state.config.wordmark; $('centerWordmark').textContent = state.config.wordmark; }
    if (state.config.name) document.title = state.config.wordmark || state.config.name;
  } catch { state.config = null; }
  renderConnectionInfo();
}

async function init() {
  startClock();
  initOrb();
  initVoice();
  initColumns();
  initUptime();
  initCamera();
  initAttention();
  initEmotes();
  initCompanion();
  initGroove();
  initChat();
  initReminders();
  initSettings();
  renderStats();
  renderWeather();
  renderLoad();
  updateStatus();

  $('statsRefresh').addEventListener('click', () => pollStats(true));
  $('weatherRefresh').addEventListener('click', () => pollWeather());

  loadConfig();
  pollStats();
  pollWeather();
  await pollHealth();
  if (!chat.messages.length) addGreeting();

  setInterval(pollHealth, 15000);
  setInterval(() => pollStats(), 3000);
  setInterval(() => pollWeather(), 10 * 60 * 1000);
}

init();
