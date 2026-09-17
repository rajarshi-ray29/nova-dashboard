#!/usr/bin/env node
/**
 * NOVA dashboard server (SPEC.md §6), normally hosted on the Raspberry Pi.
 *
 * Zero dependencies, Node >= 20 (built for v26). Serves `public/` and a small JSON/SSE API
 * that fronts three upstreams so the browser never talks to them (or sees HERMES_KEY):
 *
 *   HERMES_URL     Hermes agent "Nova" on the Raspberry Pi — chat via its OpenAI-compatible SSE API
 *                  (each turn is routed down a quick or deep lane and carries gesture cues, see
 *                  "Conversation lanes" below)
 *   PI_BRIDGE_URL  Pi bridge — system stats, MJPEG camera stream, pan-tilt servos, gestures
 *   Open-Meteo     + ip-api.com geolocation for the weather chip
 *
 * Run: `node server.js` (or `npm start`). Config comes from `.env` (parsed here, no dotenv);
 * real environment variables win over the file. `LOG_LEVEL=debug` also logs /api/stats polling.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import dns from 'node:dns';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);

// `.local` (mDNS) names can resolve to link-local IPv6 first and stall; prefer IPv4 like curl does.
dns.setDefaultResultOrder('ipv4first');

// ───────────────────────────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────────────────────────

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

/** Minimal `.env` parser: KEY=VALUE, `export KEY=…`, quotes, `#` comments. */
function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      const comment = value.search(/\s#/);
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    out[key] = value;
  }
  return out;
}

function loadEnvFile(file) {
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`warn: could not read ${file}: ${err.message}`);
    return {};
  }
}

const fileEnv = loadEnvFile(path.join(ROOT, '.env'));
const env = (key, fallback = '') => {
  const v = process.env[key] ?? fileEnv[key];
  return v === undefined || v === '' ? fallback : v;
};
const stripSlash = (u) => String(u).replace(/\/+$/, '');

const CONFIG = Object.freeze({
  host: env('HOST', '127.0.0.1'),
  port: Number(env('PORT', '8420')) || 8420,
  hermesUrl: stripSlash(env('HERMES_URL', 'http://raspberrypi.local:8642')),
  hermesKey: env('HERMES_KEY'),
  hermesModel: env('HERMES_MODEL', 'nova'),
  hermesSessionKey: env('HERMES_SESSION_KEY', 'nova-dashboard'),
  piBridgeUrl: stripSlash(env('PI_BRIDGE_URL', 'http://raspberrypi.local:8433')),
  weatherLat: env('WEATHER_LAT'),
  weatherLon: env('WEATHER_LON'),
  weatherCity: env('WEATHER_CITY'),
  logLevel: env('DEBUG') ? 'debug' : env('LOG_LEVEL', 'info').toLowerCase(),
  // Synthesis runs a Python subprocess on the Pi and takes ~2.5 s even for three words, so the
  // spoken acknowledgements ("On it.") are only bearable if they are cached on disk.
  ttsCacheDir: env('TTS_CACHE_DIR', path.join(os.homedir(), '.cache', 'nova-dashboard', 'tts')),
  ttsCache: env('TTS_CACHE', '1') !== '0',
  ttsPrewarm: env('TTS_PREWARM', '1') !== '0',
  // ElevenLabs credits run out well before the month does, and an exhausted cloud voice is worse
  // than a plain local one: every sentence stalls on a doomed round trip before falling back.
  // Remote synthesis is therefore opt-in — Nova speaks with the browser's own voice unless
  // TTS_REMOTE=1 says otherwise.
  ttsRemote: env('TTS_REMOTE', '0') !== '0',
  // Conversation lanes (see handleChat). A quick exchange runs Hermes with reasoning off, so the
  // first word arrives in a second or two; real work gets a thinking budget and is told to say
  // what it is about to do before it starts. Values are Hermes reasoning efforts:
  // none | minimal | low | medium | high | xhigh | max.
  quickReasoning: env('NOVA_QUICK_REASONING', 'none').toLowerCase(),
  deepReasoning: env('NOVA_DEEP_REASONING', 'high').toLowerCase(),
  // Gesture cues: Nova is told she has a robot head and may write [nod]-style cues, which are
  // stripped from the text and forwarded to the browser as `gesture` events.
  gestures: env('NOVA_GESTURES', '1') !== '0',
  // Reminders and timers live on this server (a browser tab is not a reliable clock), in a JSON
  // file under the data dir.
  dataDir: env('NOVA_DATA_DIR', path.join(os.homedir(), '.local', 'share', 'nova-dashboard')),
});

const TIMEOUTS = Object.freeze({
  hermesHealth: 3000,
  piHealth: 2000,
  piStats: 1500,
  piJson: 5000,
  piTts: 125_000,
  // The Pi bridge may make three four-second camera-start attempts before answering.
  piStreamResponse: 20_000,
  piSnapshot: 15000,
  geo: 6000,
  weather: 8000,
});

// ───────────────────────────────────────────────────────────────────────────────
// Logging
// ───────────────────────────────────────────────────────────────────────────────

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const activeLevel = LEVELS[CONFIG.logLevel] ?? LEVELS.info;

function emit(level, args) {
  if (LEVELS[level] < activeLevel) return;
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] ${level.toUpperCase().padEnd(5)} ${args.map(String).join(' ')}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

const log = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
};

// ───────────────────────────────────────────────────────────────────────────────
// Small helpers
// ───────────────────────────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const round1 = (n) => Math.round(n * 10) / 10;

const ERROR_TEXT = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  ENOTFOUND: 'host not found',
  EAI_AGAIN: 'DNS lookup failed',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ETIMEDOUT: 'connection timed out',
  UND_ERR_CONNECT_TIMEOUT: 'connection timed out',
  UND_ERR_HEADERS_TIMEOUT: 'response timed out',
  UND_ERR_BODY_TIMEOUT: 'response timed out',
  UND_ERR_SOCKET: 'socket closed',
};

/** Short human-readable message for fetch / socket errors (ECONNREFUSED, timeouts, …). */
function describeError(err) {
  if (!err) return 'unknown error';
  if (err.name === 'TimeoutError') return 'timed out';
  if (err.name === 'AbortError') return 'aborted';
  const code = err.cause?.code ?? err.code;
  if (code) return ERROR_TEXT[code] ?? `${code}${err.cause?.message ? ` (${err.cause.message})` : ''}`;
  return err.message || String(err);
}

/** `fetch` with a timeout, optionally chained to an outer AbortSignal. */
function fetchWithTimeout(url, options = {}, ms = 5000) {
  const timeout = AbortSignal.timeout(ms);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  return fetch(url, { ...options, signal });
}

/**
 * Memoize an async producer for `ttlMs`. Concurrent callers share one in-flight promise.
 * With `staleOnError`, a failure after a previous success returns the old value (marked `stale`)
 * and waits `retryAfterMs` before trying upstream again.
 */
function memoizeAsync(ttlMs, producer, { staleOnError = false, retryAfterMs = 60_000 } = {}) {
  let value;
  let expiresAt = 0;
  let inflight = null;
  return () => {
    if (value !== undefined && Date.now() < expiresAt) return Promise.resolve(value);
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        value = await producer();
        expiresAt = Date.now() + ttlMs;
        return value;
      } catch (err) {
        if (staleOnError && value !== undefined) {
          log.warn(`serving stale data: ${describeError(err)}`);
          value = { ...value, stale: true };
          expiresAt = Date.now() + retryAfterMs;
          return value;
        }
        throw err;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.headersSent || res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

const sendError = (res, status, message, extraHeaders) => sendJson(res, status, { error: message }, extraHeaders);

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req, limit = 64 * 1024) {
  const raw = (await readBody(req, limit)).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

/** `/a/b?x=1` → { pathname: '/a/b', search: '?x=1' } without URL-parser host tricks. */
function splitUrl(rawUrl) {
  const q = rawUrl.indexOf('?');
  const pathname = q < 0 ? rawUrl : rawUrl.slice(0, q);
  const search = q < 0 ? '' : rawUrl.slice(q);
  return { pathname, search };
}

// ───────────────────────────────────────────────────────────────────────────────
// Static files
// ───────────────────────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};
const NO_CACHE_EXT = new Set(['.html', '.css', '.js', '.mjs']);

/**
 * Map a request path to a file inside PUBLIC_DIR, or null when it is not allowed
 * (traversal, NUL bytes, undecodable escapes, dotfiles such as `.env`).
 */
function resolvePublicPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  if (decoded.endsWith('/')) decoded += 'index.html';
  const normalized = path.posix.normalize('/' + decoded.replace(/\\/g, '/'));
  if (normalized.split('/').some((seg) => seg.startsWith('.') && seg !== '')) return null;
  const abs = path.resolve(PUBLIC_DIR, '.' + normalized);
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) return null;
  return abs;
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 405, 'method not allowed', { Allow: 'GET, HEAD' });
  }
  let file = resolvePublicPath(pathname);
  if (!file) return sendError(res, 403, 'forbidden');

  let stat;
  try {
    stat = await fsp.stat(file);
    if (stat.isDirectory()) {
      file = path.join(file, 'index.html');
      stat = await fsp.stat(file);
    }
  } catch {
    return sendError(res, 404, 'not found');
  }
  if (!stat.isFile()) return sendError(res, 404, 'not found');

  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Last-Modified': stat.mtime.toUTCString(),
    'Cache-Control': NO_CACHE_EXT.has(ext) ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    // Audio capture stays in the client. Through the Mac localhost tunnel, only this page may
    // request the MacBook microphone.
    'Permissions-Policy': 'microphone=(self)',
  });
  if (req.method === 'HEAD') return res.end();

  const stream = fs.createReadStream(file);
  stream.on('error', (err) => {
    log.error(`static read error ${file}: ${err.message}`);
    res.destroy();
  });
  stream.pipe(res);
}

// ───────────────────────────────────────────────────────────────────────────────
// Dashboard-host system stats
// ───────────────────────────────────────────────────────────────────────────────

/** Background CPU sampler: percent busy from the delta of os.cpus() times every `intervalMs`. */
function createCpuSampler(intervalMs = 2000) {
  const snapshot = () => {
    let idle = 0;
    let total = 0;
    for (const { times } of os.cpus()) {
      idle += times.idle;
      total += times.user + times.nice + times.sys + times.idle + times.irq;
    }
    return { idle, total };
  };
  let prev = snapshot();
  let percent = 0;
  const sample = () => {
    const cur = snapshot();
    const dTotal = cur.total - prev.total;
    const dIdle = cur.idle - prev.idle;
    if (dTotal > 0) percent = round1(Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100)));
    prev = cur;
  };
  const warmup = setTimeout(sample, 300); // first reading soon after boot instead of 0%
  const timer = setInterval(sample, intervalMs);
  warmup.unref();
  timer.unref();
  return {
    get percent() {
      return percent;
    },
    stop() {
      clearTimeout(warmup);
      clearInterval(timer);
    },
  };
}

/** Memory: on darwin use vm_stat (free + inactive + speculative pages = available). */
async function readMemory() {
  const total = os.totalmem();
  let available = os.freemem();
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileP('vm_stat', [], { timeout: 3000 });
      const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1]) || 16384;
      const pages = (name) => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)`, 'm').exec(stdout)?.[1]) || 0;
      available = (pages('free') + pages('inactive') + pages('speculative')) * pageSize;
    } catch (err) {
      log.debug(`vm_stat failed, using os.freemem(): ${err.message}`);
    }
  }
  const used = Math.max(0, total - available);
  return { total, used, available, percent: round1((used / total) * 100) };
}

/** Disk: `df -k /`. On APFS the root volume's "Used" column ignores the shared container, so
 *  used = total − available, which matches what macOS itself reports. */
async function readDisk() {
  try {
    const { stdout } = await execFileP('df', ['-k', '/'], { timeout: 3000 });
    const cols = stdout.trim().split('\n').at(-1).trim().split(/\s+/);
    const [blocks, , avail] = cols.slice(1, 4).map(Number);
    const total = blocks * 1024;
    const used = Math.max(0, total - avail * 1024);
    return { total, used, percent: total ? round1((used / total) * 100) : 0 };
  } catch (err) {
    log.debug(`df failed: ${err.message}`);
    return { total: 0, used: 0, percent: 0 };
  }
}

const cpuSampler = createCpuSampler(2000);

async function fetchPiStats() {
  try {
    const r = await fetchWithTimeout(`${CONFIG.piBridgeUrl}/stats`, {}, TIMEOUTS.piStats);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    return json && typeof json === 'object' ? json : null;
  } catch (err) {
    log.debug(`pi stats unavailable: ${describeError(err)}`);
    return null;
  }
}

async function computeStats() {
  const [mem, disk, pi] = await Promise.all([readMemory(), readDisk(), fetchPiStats()]);
  return {
    host: {
      hostname: os.hostname(),
      platform: process.platform,
      cpu_percent: cpuSampler.percent,
      ncpu: os.cpus().length,
      mem,
      disk,
      load: os.loadavg().map(round1),
      uptime_s: Math.round(os.uptime()),
    },
    pi,
  };
}

const getStats = memoizeAsync(2000, computeStats);

// ───────────────────────────────────────────────────────────────────────────────
// Health
// ───────────────────────────────────────────────────────────────────────────────

async function probeHermes() {
  const t0 = performance.now();
  try {
    const r = await fetchWithTimeout(`${CONFIG.hermesUrl}/health`, {}, TIMEOUTS.hermesHealth);
    const json = await r.json().catch(() => ({}));
    return {
      ok: r.ok && (json.status === undefined || json.status === 'ok'),
      version: json.version ?? null,
      latency_ms: Math.round(performance.now() - t0),
    };
  } catch (err) {
    return { ok: false, version: null, latency_ms: null, error: describeError(err) };
  }
}

async function probePiBridge() {
  try {
    const r = await fetchWithTimeout(`${CONFIG.piBridgeUrl}/health`, {}, TIMEOUTS.piHealth);
    const json = await r.json().catch(() => ({}));
    return {
      ok: r.ok && (json.status === undefined || json.status === 'ok'),
      camera: json.camera === true,
      pantilt: json.pantilt === true,
      attention: json.attention === true,
      hostname: json.hostname ?? null,
      version: json.version ?? null,
    };
  } catch (err) {
    return { ok: false, camera: false, pantilt: false, attention: false, hostname: null, version: null, error: describeError(err) };
  }
}

async function computeHealth() {
  const [hermes, pi_bridge] = await Promise.all([probeHermes(), probePiBridge()]);
  return { hermes, pi_bridge, server_time: new Date().toISOString() };
}

const getHealth = memoizeAsync(5000, computeHealth);

// ───────────────────────────────────────────────────────────────────────────────
// Weather (Open-Meteo + ip-api geolocation)
// ───────────────────────────────────────────────────────────────────────────────

/** WMO weather_code → [description, icon]. */
const WMO = {
  0: ['clear sky', 'clear'],
  1: ['mainly clear', 'clear'],
  2: ['partly cloudy', 'partly-cloudy'],
  3: ['overcast clouds', 'cloudy'],
  45: ['fog', 'fog'],
  48: ['rime fog', 'fog'],
  51: ['light drizzle', 'drizzle'],
  53: ['drizzle', 'drizzle'],
  55: ['dense drizzle', 'drizzle'],
  56: ['light freezing drizzle', 'drizzle'],
  57: ['freezing drizzle', 'drizzle'],
  61: ['light rain', 'rain'],
  63: ['moderate rain', 'rain'],
  65: ['heavy rain', 'rain'],
  66: ['light freezing rain', 'rain'],
  67: ['freezing rain', 'rain'],
  71: ['light snow', 'snow'],
  73: ['moderate snow', 'snow'],
  75: ['heavy snow', 'snow'],
  77: ['snow grains', 'snow'],
  80: ['light rain showers', 'rain'],
  81: ['rain showers', 'rain'],
  82: ['violent rain showers', 'rain'],
  85: ['light snow showers', 'snow'],
  86: ['heavy snow showers', 'snow'],
  95: ['thunderstorm', 'thunder'],
  96: ['thunderstorm with light hail', 'thunder'],
  99: ['thunderstorm with heavy hail', 'thunder'],
};

function describeWmo(code) {
  const [description, icon] = WMO[code] ?? ['unknown conditions', 'cloudy'];
  return { description, icon };
}

async function geolocateByIp() {
  const url = 'http://ip-api.com/json/?fields=status,city,regionName,country,countryCode,lat,lon';
  const r = await fetchWithTimeout(url, {}, TIMEOUTS.geo);
  if (!r.ok) throw new Error(`ip-api HTTP ${r.status}`);
  const json = await r.json();
  if (json.status !== 'success') throw new Error(`ip-api: ${json.message ?? 'lookup failed'}`);
  return {
    city: json.city ?? '',
    region: json.regionName ?? '',
    country: json.countryCode ?? '',
    country_name: json.country ?? '',
    lat: json.lat,
    lon: json.lon,
  };
}

let ipLocation = null; // resolved once per process (retried only while it keeps failing)

async function getLocation() {
  const lat = Number(CONFIG.weatherLat);
  const lon = Number(CONFIG.weatherLon);
  const hasOverride = CONFIG.weatherLat !== '' && CONFIG.weatherLon !== '' && Number.isFinite(lat) && Number.isFinite(lon);
  if (hasOverride) {
    return {
      city: CONFIG.weatherCity || `${lat.toFixed(2)}, ${lon.toFixed(2)}`,
      region: '',
      country: '',
      country_name: '',
      lat,
      lon,
    };
  }
  if (!ipLocation) {
    ipLocation = await geolocateByIp();
    log.info(`location: ${ipLocation.city}, ${ipLocation.region} ${ipLocation.country} (${ipLocation.lat}, ${ipLocation.lon})`);
  }
  return CONFIG.weatherCity ? { ...ipLocation, city: CONFIG.weatherCity } : ipLocation;
}

async function fetchWeather() {
  const loc = await getLocation();
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: String(loc.lat),
    longitude: String(loc.lon),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m',
    wind_speed_unit: 'ms',
    timezone: 'auto',
  }).toString();
  const r = await fetchWithTimeout(url, {}, TIMEOUTS.weather);
  if (!r.ok) throw new Error(`open-meteo HTTP ${r.status}`);
  const json = await r.json();
  const cur = json.current ?? {};
  const code = cur.weather_code ?? null;
  return {
    temp_c: cur.temperature_2m ?? null,
    feels_like_c: cur.apparent_temperature ?? null,
    humidity: cur.relative_humidity_2m ?? null,
    wind_ms: cur.wind_speed_10m ?? null,
    code,
    ...describeWmo(code),
    is_day: cur.is_day === 1 || cur.is_day === true,
    city: loc.city,
    region: loc.region,
    country: loc.country,
    country_name: loc.country_name,
    lat: loc.lat,
    lon: loc.lon,
    updated_at: new Date().toISOString(),
  };
}

const getWeather = memoizeAsync(10 * 60 * 1000, fetchWeather, { staleOnError: true, retryAfterMs: 60_000 });

// ───────────────────────────────────────────────────────────────────────────────
// Server-Sent Events: parser (upstream) + writer (downstream)
// ───────────────────────────────────────────────────────────────────────────────

/** Incremental SSE frame parser: feed text chunks, get [{event, id, data}] per complete frame. */
class SseParser {
  #buffer = '';

  feed(chunk) {
    this.#buffer += chunk;
    let text = this.#buffer;
    let carry = '';
    // A trailing CR may be the first half of a CRLF split across reads — hold it back.
    if (text.endsWith('\r')) {
      carry = '\r';
      text = text.slice(0, -1);
    }
    text = text.replace(/\r\n?/g, '\n');
    const frames = text.split('\n\n');
    this.#buffer = frames.pop() + carry;
    return frames.map(SseParser.parseFrame).filter(Boolean);
  }

  /** Call at end-of-stream: a final frame without a trailing blank line is still a frame. */
  flush() {
    const rest = this.#buffer.replace(/\r\n?/g, '\n');
    this.#buffer = '';
    const ev = SseParser.parseFrame(rest);
    return ev ? [ev] : [];
  }

  static parseFrame(frame) {
    let event = 'message';
    let id;
    const data = [];
    for (const line of frame.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value || 'message';
      else if (field === 'data') data.push(value);
      else if (field === 'id') id = value;
    }
    return data.length ? { event, id, data: data.join('\n') } : null;
  }
}

/** Open an SSE response and return a tiny writer that flushes every frame immediately. */
function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.socket?.setNoDelay(true);
  res.flushHeaders();
  const writable = () => !res.destroyed && !res.writableEnded;
  return {
    send(event, data) {
      if (!writable()) return false;
      log.debug(`sse → ${event} ${JSON.stringify(data).slice(0, 160)}`);
      return res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      if (writable()) res.end();
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Conversation lanes, the per-request system prompt, and gesture cues
// ───────────────────────────────────────────────────────────────────────────────
//
// Hermes runs the full agent for every request. Left to its configured defaults (a large model at
// maximum reasoning effort, every toolset) a "how are you?" took six to thirty seconds on this
// rig, which is not a conversation. Two things fix the cadence without touching Hermes's own
// config: a per-request `model_options.reasoning` override, and an ephemeral system message
// (Hermes layers it on top of its core prompt for this turn only) that tells Nova how to behave.
//
//   quick  reasoning off; answer from what you know; tools only when the answer needs them.
//   deep   a real thinking budget; say one spoken sentence about what you are going to do, then
//          go and do it, then report. The sentence streams before the first tool call, so the
//          dashboard can speak it while the head switches to its "thinking" gestures.
//
// The lane is picked here with cheap heuristics (an LLM classifier would cost a round trip on
// every turn, which is the very latency this exists to remove). Misclassifying is harmless: a
// quick-lane turn can still use tools, and a deep-lane turn merely thinks a little longer.

const DEEP_HINT_RE = /\b(take your time|think (?:hard|carefully|deeply|it through)|research|investigate|dig (?:in|into)|deep[- ]dive|thorough(?:ly)?|in depth|step by step|comprehensive)\b/i;
const QUICK_HINT_RE = /\b(quick(?:ly)?|briefly|short answer|in a word|just tell me|one[- ]liner?|yes or no)\b/i;
const DEEP_TASK_RE = /\b(analy[sz]e|compare|evaluate|review|audit|plan (?:my|a|the|out)|write (?:me |us )?(?:a |an |the |some |my )?(?:\w+[- ]){0,3}(?:script|program|code|function|class|module|essay|report|document|article|blog|post|poem|story|proposal|spec|tests?)|draft|compose|create|build|implement|generate|design|debug|fix|refactor|install|deploy|set up|configure|migrate|automate|summari[sz]e (?:this|the|that|my) (?:article|page|link|url|file|document|thread|repo)|explain in detail|walk me through|troubleshoot)\b/i;

/** Pick the lane for a message: an explicit setting wins, then phrasing, then length, then task words. */
function classifyLane(message, mode = 'auto') {
  if (mode === 'quick' || mode === 'deep') return { lane: mode, reason: 'setting' };
  const text = String(message || '').trim();
  if (DEEP_HINT_RE.test(text)) return { lane: 'deep', reason: 'asked' };
  if (QUICK_HINT_RE.test(text)) return { lane: 'quick', reason: 'asked' };
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words > 45 || /\n/.test(text)) return { lane: 'deep', reason: 'long' };
  if (DEEP_TASK_RE.test(text)) return { lane: 'deep', reason: 'task' };
  return { lane: 'quick', reason: 'default' };
}

function laneReasoning(lane) {
  const effort = lane === 'deep' ? CONFIG.deepReasoning : CONFIG.quickReasoning;
  return effort === 'none' || effort === 'off' ? { enabled: false } : { enabled: true, effort };
}

// The gesture vocabulary of pi/nova_bridge.py (public names and their aliases). Only these words
// are treated as cues when they appear in brackets; "[1]" or "[citation needed]" pass through.
const GESTURE_VOCAB = ['nod', 'shake', 'emphasis', 'tilt', 'look_around', 'bow', 'excited', 'celebrate', 'sad', 'surprise', 'laugh', 'think', 'confused', 'peek', 'double_take', 'greet', 'wave', 'dance', 'shiver', 'look_up', 'look_down', 'look_left', 'look_right', 'listen', 'sleepy'];
const GESTURE_ALIASES = {
  yes: 'nod', agree: 'nod', affirm: 'nod', okay: 'nod', no: 'shake', disagree: 'shake', deny: 'shake', nope: 'shake',
  beat: 'emphasis', point: 'emphasis', curious: 'tilt', hmm: 'tilt', intrigued: 'tilt', scan: 'look_around', look_round: 'look_around',
  take_a_bow: 'bow', thanks: 'bow', thank_you: 'bow', bounce: 'excited', happy: 'excited', joy: 'excited', delighted: 'excited',
  cheer: 'celebrate', hooray: 'celebrate', yay: 'celebrate', woohoo: 'celebrate', droop: 'sad', sorry: 'sad', disappointed: 'sad', apologetic: 'sad',
  startled: 'surprise', shocked: 'surprise', wow: 'surprise', gasp: 'surprise', chuckle: 'laugh', giggle: 'laugh', amused: 'laugh',
  ponder: 'think', hmmm: 'think', consider: 'think', thinking: 'think', puzzled: 'confused', huh: 'confused', unsure: 'confused',
  glance: 'peek', sneak: 'peek', doubletake: 'double_take', what: 'double_take', hello: 'greet', hi: 'greet', welcome: 'greet',
  bye: 'wave', goodbye: 'wave', farewell: 'wave', boogie: 'dance', groove: 'dance', party: 'dance', brr: 'shiver', tremble: 'shiver', scared: 'shiver',
  up: 'look_up', down: 'look_down', glance_down: 'look_down', left: 'look_left', right: 'look_right',
  lean_in: 'listen', attentive: 'listen', focus: 'listen', tired: 'sleepy', yawn: 'sleepy', sleep: 'sleepy', nap: 'sleepy',
};
const GESTURE_NAMES = new Set(GESTURE_VOCAB);

function normalizeGesture(raw) {
  const key = String(raw || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (GESTURE_NAMES.has(key)) return key;
  return GESTURE_ALIASES[key] || null;
}

// Cue syntax Nova is asked to use: "[nod]" (also accepted: "[gesture: nod]").
const GESTURE_TAG_RE = /\[\s*(?:gesture\s*:\s*)?([a-z][a-z_ -]{1,24}?)\s*\]/gi;
const GESTURE_HOLDBACK = 32; // a cue split across two deltas is at most this long

/**
 * Strips gesture cues out of a streaming reply and reports them with the character offset (in the
 * cleaned text) they belong to, so the browser can fire each one as that part is spoken. Text is
 * released as it goes; only a possible half-arrived "[no" at the very end is held back.
 */
class GestureTagFilter {
  #buffer = '';
  #emitted = 0;

  push(chunk) {
    this.#buffer += chunk;
    return this.#drain(false);
  }

  flush() {
    return this.#drain(true);
  }

  #drain(final) {
    const text = this.#buffer;
    let holdFrom = text.length;
    if (!final) {
      const open = text.lastIndexOf('[');
      if (open >= 0 && open >= text.length - GESTURE_HOLDBACK && text.indexOf(']', open) < 0) {
        holdFrom = open;
        // ... together with the whitespace in front of it, so "sir. [nod]" split at the bracket
        // still collapses to "sir." rather than leaving a stray space behind.
        while (holdFrom > 0 && /\s/.test(text[holdFrom - 1])) holdFrom -= 1;
      }
    }
    const scan = text.slice(0, holdFrom);
    const gestures = [];
    let out = '';
    let last = 0;
    let m;
    GESTURE_TAG_RE.lastIndex = 0;
    while ((m = GESTURE_TAG_RE.exec(scan))) {
      const name = normalizeGesture(m[1]);
      if (!name) continue;
      out += scan.slice(last, m.index);
      let end = m.index + m[0].length;
      // "[nod] Certainly" → "Certainly"; "sir. [nod]" → "sir." — eat one space so the cue leaves no hole.
      if (scan[end] === ' ') end += 1;
      else if (out.endsWith(' ') && (end >= scan.length || /[\s.,!?;:]/.test(scan[end]))) out = out.slice(0, -1);
      gestures.push({ name, at: this.#emitted + out.length });
      last = end;
    }
    out += scan.slice(last);
    this.#buffer = text.slice(holdFrom);
    this.#emitted += out.length;
    return { text: out, gestures };
  }
}

/** The ephemeral system message for one turn: delivery mode, lane guidance and the gesture protocol. */
function buildSystemPrompt({ lane, voice, gestures, image = false }) {
  const parts = [];
  if (image) {
    parts.push('The attached photo is what your own desk camera sees right now — the user is showing you something or asking about the scene. Answer about the photo directly and concretely; if text is visible, read it; if asked what something is, say so plainly, and say when you cannot tell.');
  }
  parts.push(voice
    ? 'The user is talking to you by voice through the Nova console and will hear this reply read aloud. Write for the ear: short natural sentences, no markdown, no bullet points, no tables, no URLs and no code unless explicitly asked; say numbers, times and units the way you would speak them.'
    : 'The user is typing to you in the Nova console. Plain text or light markdown is fine.');
  if (lane === 'quick') {
    parts.push('This is a quick exchange. Answer directly from what you already know, in one to three sentences, with no preamble. Reach for a tool only if the answer truly depends on live information or on doing something — and if you do, first say one short sentence so the user knows what you are checking.');
  } else {
    parts.push('This is real work. Before using any tool, reply with ONE short spoken sentence that says specifically what you are about to do (for example: "Let me check the load on the machine, sir." — the console has already said a generic "leave it with me", so be concrete rather than generic). Then take your time: use your tools thoroughly, verify what you find, and only then give the result — leading with the answer, then the essentials.');
  }
  if (gestures) {
    parts.push(`You are embodied: you speak through a small robot head (a pan-tilt camera) that can gesture while you talk. Add gesture cues to your reply as a single bracketed word such as [nod], placed immediately before the sentence or clause it belongs to. Allowed cues: ${GESTURE_VOCAB.join(', ')}. Use one to three cues in a short reply and a few more in a long one, chosen for meaning: nod for agreement or confirmation, shake for no, think while weighing something, excited or celebrate for good news, sad for bad news or an apology, surprise, laugh, tilt when curious, emphasis on the key point, greet for hello, wave for goodbye, bow for thanks. Cues are never read aloud, never go inside code or inside a word, and never replace your words.`);
  }
  return parts.join('\n\n');
}

// ───────────────────────────────────────────────────────────────────────────────
// Chat proxy → Hermes (OpenAI-compatible streaming)
// ───────────────────────────────────────────────────────────────────────────────

const activeChats = new Set();

/** Pull a readable message out of whatever Hermes/OpenAI-style error payload we got. */
function extractErrorMessage(payload, fallback) {
  if (!payload) return fallback;
  if (typeof payload === 'string') return payload;
  const e = payload.error ?? payload.detail ?? payload.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') return e.message ?? e.detail ?? JSON.stringify(e);
  return fallback;
}

async function describeUpstreamFailure(upstream) {
  const text = await upstream.text().catch(() => '');
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  const detail = extractErrorMessage(parsed, text.trim().slice(0, 300));
  return `Hermes returned ${upstream.status}${detail ? `: ${detail}` : ''}`;
}

/** Translate one upstream SSE event into dashboard events; returns bookkeeping via `state`. */
function translateHermesEvent(ev, sse, state) {
  if (ev.event === 'hermes.tool.progress') {
    let tool;
    try {
      tool = JSON.parse(ev.data);
    } catch {
      return;
    }
    sse.send('tool', {
      ...tool,
      tool: tool.tool ?? 'tool',
      emoji: tool.emoji ?? '🔧',
      label: tool.label ?? '',
      toolCallId: tool.toolCallId ?? tool.tool_call_id ?? null,
      status: tool.status ?? 'running',
    });
    return;
  }
  if (ev.event !== 'message') {
    if (/error/i.test(ev.event)) sse.send('error', { message: extractErrorMessage(safeJson(ev.data), ev.data) });
    else log.debug(`hermes event ignored: ${ev.event} ${ev.data.slice(0, 120)}`);
    return;
  }
  if (ev.data.trim() === '[DONE]') {
    state.done = true;
    return;
  }
  const json = safeJson(ev.data);
  if (!json) {
    log.debug(`hermes: unparseable frame ${ev.data.slice(0, 120)}`);
    return;
  }
  if (json.error) {
    sse.send('error', { message: extractErrorMessage(json, 'upstream error') });
    return;
  }
  if (json.usage) state.usage = json.usage;
  const choice = Array.isArray(json.choices) ? json.choices[0] : null;
  const text = choice?.delta?.content;
  if (typeof text === 'string' && text.length) emitReplyText(sse, state, state.filter ? state.filter.push(text) : { text, gestures: [] });
  if (choice?.finish_reason) state.finishReason = choice.finish_reason;
}

/** Forward cleaned reply text and any gesture cues that were embedded in it. */
function emitReplyText(sse, state, { text, gestures }) {
  if (text) sse.send('delta', { text });
  for (const g of gestures) {
    state.gestures += 1;
    sse.send('gesture', g);
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function pumpHermesStream(body, sse, { gestures = false } = {}) {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const state = { usage: null, finishReason: null, done: false, gestures: 0, filter: gestures ? new GestureTagFilter() : null };
  for await (const chunk of body) {
    for (const ev of parser.feed(decoder.decode(chunk, { stream: true }))) translateHermesEvent(ev, sse, state);
    if (state.done) break;
  }
  if (!state.done) for (const ev of parser.flush()) translateHermesEvent(ev, sse, state);
  if (state.filter) emitReplyText(sse, state, state.filter.flush());
  return state;
}

const CHAT_IMAGE_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const CHAT_IMAGE_MAX = 2_500_000; // a 640x480 JPEG is ~20-60 KB as base64; this is generous

async function handleChat(req, res) {
  const body = await readJsonBody(req, 4 * 1024 * 1024);
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) throw new HttpError(400, '"message" (non-empty string) is required');
  // "Look at this": a live frame from the desk camera rides along as an image part.
  const image = typeof body.image === 'string' && body.image.length <= CHAT_IMAGE_MAX && CHAT_IMAGE_RE.test(body.image) ? body.image : null;
  if (body.image && !image) throw new HttpError(400, '"image" must be a data:image/jpeg|png|webp;base64 URL under 2.5 MB');
  const sessionId = typeof body.session_id === 'string' && body.session_id ? body.session_id : null;
  if (!CONFIG.hermesKey) throw new HttpError(503, 'HERMES_KEY is not configured on the server');
  const mode = ['auto', 'quick', 'deep'].includes(body.mode) ? body.mode : 'auto';
  const voice = body.voice === true;
  const gestures = CONFIG.gestures && body.gestures !== false;
  const { lane, reason } = classifyLane(message, mode);
  const reasoning = laneReasoning(lane);

  const controller = new AbortController();
  activeChats.add(controller);
  res.on('close', () => {
    if (!res.writableFinished) controller.abort(); // client went away mid-stream
  });

  const sse = openSse(res);
  const t0 = performance.now();
  const effortLabel = reasoning.enabled ? reasoning.effort : 'off';
  log.info(`chat → hermes (${message.length} chars${sessionId ? `, session ${sessionId}` : ', new session'}, ${lane} lane [${reason}], reasoning ${effortLabel}${voice ? ', voice' : ''}${gestures ? ', gestures' : ''}${image ? ', image' : ''})`);
  sse.send('lane', { lane, reason, reasoning: effortLabel, voice, gestures });

  try {
    const upstream = await fetch(`${CONFIG.hermesUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CONFIG.hermesKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-Hermes-Session-Key': CONFIG.hermesSessionKey,
        ...(sessionId ? { 'X-Hermes-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify({
        model: CONFIG.hermesModel,
        stream: true,
        messages: [
          { role: 'system', content: buildSystemPrompt({ lane, voice, gestures, image: !!image }) },
          { role: 'user', content: image ? [{ type: 'text', text: message }, { type: 'image_url', image_url: { url: image } }] : message },
        ],
        model_options: { reasoning },
      }),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      const messageText = await describeUpstreamFailure(upstream);
      log.warn(`chat: ${messageText}`);
      sse.send('error', { message: messageText });
      return;
    }
    if (!upstream.body) throw new Error('Hermes returned an empty body');

    const newSessionId = upstream.headers.get('x-hermes-session-id') || sessionId;
    const state = await pumpHermesStream(upstream.body, sse, { gestures });
    sse.send('done', { session_id: newSessionId, usage: state.usage, lane });
    log.info(`chat ← done in ${Math.round(performance.now() - t0)}ms (session ${newSessionId ?? 'unknown'}${state.finishReason ? `, ${state.finishReason}` : ''}${state.gestures ? `, ${state.gestures} gesture cue${state.gestures === 1 ? '' : 's'}` : ''})`);
  } catch (err) {
    if (controller.signal.aborted) {
      const clientGone = res.destroyed;
      if (!clientGone) sse.send('error', { message: 'Nova server is shutting down' });
      log.info(`chat: ${clientGone ? 'client disconnected' : 'aborted by shutdown'} after ${Math.round(performance.now() - t0)}ms, upstream aborted`);
      return;
    }
    const messageText = `Hermes request failed: ${describeError(err)}`;
    log.warn(`chat: ${messageText}`);
    sse.send('error', { message: messageText });
  } finally {
    activeChats.delete(controller);
    sse.end();
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Hermes sessions (server-side proxy; the gateway key never reaches the browser)
// ───────────────────────────────────────────────────────────────────────────────

async function proxyHermesJson(res, upstreamPath) {
  if (!CONFIG.hermesKey) throw new HttpError(503, 'HERMES_KEY is not configured on the server');
  let upstream;
  try {
    upstream = await fetchWithTimeout(`${CONFIG.hermesUrl}${upstreamPath}`, {
      headers: {
        Authorization: `Bearer ${CONFIG.hermesKey}`,
        Accept: 'application/json',
        'X-Hermes-Session-Key': CONFIG.hermesSessionKey,
      },
    }, 10_000);
  } catch (err) {
    return sendError(res, 502, `Hermes request failed: ${describeError(err)}`);
  }
  const text = await upstream.text();
  const json = safeJson(text);
  if (json === null) return sendError(res, 502, `Hermes returned ${upstream.status}`);
  sendJson(res, upstream.status, json);
}

async function handleSessions(req, res) {
  const url = new URL(req.url, 'http://nova.local');
  const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '40', 10) || 40));
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  return proxyHermesJson(res, `/api/sessions?limit=${limit}&offset=${offset}&source=api_server`);
}

async function handleSessionMessages(res, rawSessionId) {
  let sessionId;
  try { sessionId = decodeURIComponent(rawSessionId); }
  catch { throw new HttpError(400, 'invalid session id'); }
  if (!sessionId || sessionId.length > 256 || /[\r\n\0/]/.test(sessionId)) throw new HttpError(400, 'invalid session id');
  return proxyHermesJson(res, `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=500&order=oldest`);
}

// ───────────────────────────────────────────────────────────────────────────────
// Pi bridge proxies (camera stream / snapshot / pan-tilt / Hermes TTS)
// ───────────────────────────────────────────────────────────────────────────────

const activeProxies = new Set();

/** Raw byte proxy via http.request — used for the MJPEG stream and JPEG snapshot. */
function proxyPiRaw(req, res, upstreamPath, responseTimeoutMs) {
  const target = new URL(upstreamPath, `${CONFIG.piBridgeUrl}/`);
  const upstreamReq = http.request(target, { method: 'GET', headers: { Accept: '*/*' } });
  activeProxies.add(upstreamReq);

  let clientGone = false;
  const timer = setTimeout(() => {
    upstreamReq.destroy(new Error(`no response from Pi bridge within ${responseTimeoutMs} ms`));
  }, responseTimeoutMs);
  const cleanup = () => {
    clearTimeout(timer);
    activeProxies.delete(upstreamReq);
  };

  upstreamReq.on('response', (up) => {
    clearTimeout(timer);
    if (up.statusCode >= 400) {
      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim().slice(0, 300);
        sendError(res, 502, `Pi bridge ${up.statusCode}${text ? `: ${extractErrorMessage(safeJson(text), text)}` : ''}`);
      });
      return;
    }
    const headers = {
      'Content-Type': up.headers['content-type'] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store',
      Pragma: 'no-cache',
    };
    if (up.headers['content-length']) headers['Content-Length'] = up.headers['content-length'];
    res.socket?.setNoDelay(true);
    res.writeHead(up.statusCode, headers);
    up.pipe(res); // unbuffered: each upstream chunk is written as it arrives
    up.on('error', (err) => {
      if (clientGone) return; // we destroyed it ourselves after the viewer left
      log.warn(`pi stream error: ${err.message}`);
      res.destroy();
    });
  });

  upstreamReq.on('error', (err) => {
    cleanup();
    if (clientGone) return;
    if (!res.headersSent) sendError(res, 502, `Pi bridge unreachable: ${describeError(err)}`);
    else res.destroy();
  });
  upstreamReq.on('close', cleanup);

  res.on('close', () => {
    clientGone = true;
    cleanup();
    upstreamReq.destroy(); // client gone → stop pulling frames from the Pi
  });

  upstreamReq.end();
}

/** JSON proxy for the pan-tilt endpoints: forwards body, status code and JSON. */
async function proxyPiJson(req, res, upstreamPath, timeoutMs = TIMEOUTS.piJson) {
  const target = new URL(upstreamPath, `${CONFIG.piBridgeUrl}/`);
  const init = { method: req.method, headers: { Accept: 'application/json' } };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = (await readBody(req, 64 * 1024)).toString('utf8');
    init.headers['Content-Type'] = req.headers['content-type'] ?? 'application/json';
  }
  let upstream;
  try {
    upstream = await fetchWithTimeout(target, init, timeoutMs);
  } catch (err) {
    return sendError(res, 502, `Pi bridge unreachable: ${describeError(err)}`);
  }
  const text = await upstream.text();
  const json = safeJson(text);
  if (json === null) {
    return sendError(res, upstream.ok ? 502 : upstream.status, text.trim().slice(0, 300) || `Pi bridge returned ${upstream.status}`);
  }
  sendJson(res, upstream.status, json);
}

// ───────────────────────────────────────────────────────────────────────────────
// TTS — synthesis with a disk cache
// ───────────────────────────────────────────────────────────────────────────────
//
// Every synthesis spawns a Python process on the Pi that loads Hermes and calls the provider:
// ~2.5 s for a three-word phrase, serialized behind a lock. Nova's short conversational fillers
// are drawn from a fixed list (public/phrases.js), so they are cached to disk once and replayed
// from there forever after. Identical concurrent requests share one synthesis.

const TTS_CACHE_MAX_ENTRIES = 400;
const ttsInFlight = new Map(); // hash → Promise<{audio, mime, provider}>

const ttsHash = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
const ttsPaths = (hash) => ({
  audio: path.join(CONFIG.ttsCacheDir, `${hash}.audio`),
  meta: path.join(CONFIG.ttsCacheDir, `${hash}.json`),
});

async function ttsCacheRead(hash) {
  if (!CONFIG.ttsCache) return null;
  const { audio, meta } = ttsPaths(hash);
  try {
    const [buf, metaText] = await Promise.all([fsp.readFile(audio), fsp.readFile(meta, 'utf8')]);
    if (!buf.length) return null;
    const parsed = JSON.parse(metaText);
    fsp.utimes(audio, new Date(), new Date()).catch(() => {}); // touch for LRU pruning
    return { audio: buf, mime: parsed.mime || 'audio/mpeg', provider: parsed.provider || 'hermes' };
  } catch {
    return null;
  }
}

async function ttsCacheWrite(hash, text, { audio, mime, provider }) {
  if (!CONFIG.ttsCache) return;
  const paths = ttsPaths(hash);
  try {
    await fsp.mkdir(CONFIG.ttsCacheDir, { recursive: true });
    // Write to a temp name first so a crash mid-write cannot leave a truncated entry behind.
    const tmp = `${paths.audio}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, audio);
    await fsp.rename(tmp, paths.audio);
    await fsp.writeFile(paths.meta, JSON.stringify({ text: text.slice(0, 200), mime, provider, at: Date.now() }));
    ttsCachePrune().catch(() => {});
  } catch (err) {
    log.warn(`tts cache write failed: ${err.message}`);
  }
}

/** Keep the cache bounded: drop the least recently read entries past the cap. */
async function ttsCachePrune() {
  const names = await fsp.readdir(CONFIG.ttsCacheDir).catch(() => []);
  const audios = names.filter((n) => n.endsWith('.audio'));
  if (audios.length <= TTS_CACHE_MAX_ENTRIES) return;
  const stats = await Promise.all(audios.map(async (n) => {
    const st = await fsp.stat(path.join(CONFIG.ttsCacheDir, n)).catch(() => null);
    return { name: n, mtime: st ? st.mtimeMs : 0 };
  }));
  stats.sort((a, b) => a.mtime - b.mtime);
  for (const { name } of stats.slice(0, audios.length - TTS_CACHE_MAX_ENTRIES)) {
    const hash = name.replace(/\.audio$/, '');
    const p = ttsPaths(hash);
    await fsp.rm(p.audio, { force: true }).catch(() => {});
    await fsp.rm(p.meta, { force: true }).catch(() => {});
  }
}

/** Synthesize through the Pi bridge. Concurrent callers asking for the same text share one run. */
function ttsSynthesize(hash, text) {
  const existing = ttsInFlight.get(hash);
  if (existing) return existing;

  const job = (async () => {
    const upstream = await fetchWithTimeout(`${CONFIG.piBridgeUrl}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'audio/*, application/json' },
      body: JSON.stringify({ text }),
    }, TIMEOUTS.piTts).catch((err) => {
      throw new HttpError(502, `Hermes TTS unavailable: ${describeError(err)}`);
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      throw new HttpError(502, `Hermes TTS failed: ${extractErrorMessage(safeJson(detail), detail.trim().slice(0, 300))}`);
    }
    const audio = Buffer.from(await upstream.arrayBuffer());
    if (!audio.length) throw new HttpError(502, 'Hermes TTS returned empty audio');
    const result = {
      audio,
      mime: upstream.headers.get('content-type') || 'audio/mpeg',
      provider: upstream.headers.get('x-tts-provider') || 'hermes',
    };
    await ttsCacheWrite(hash, text, result);
    return result;
  })().finally(() => ttsInFlight.delete(hash));

  ttsInFlight.set(hash, job);
  return job;
}

async function handleTts(req, res) {
  const body = await readJsonBody(req, 16 * 1024);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) throw new HttpError(400, '"text" (non-empty string) is required');
  if (text.length > 6000) throw new HttpError(400, 'text must be 6000 characters or fewer');
  // Answered before touching the cache: with remote synthesis off, a half-cached voice would read
  // the fillers as Alice and the answers as the browser, which is worse than either alone.
  // Returned rather than thrown: this is the configured state, not a fault, and it should not fill
  // the journal with a stack trace every time the page asks.
  if (!CONFIG.ttsRemote) return sendError(res, 503, 'remote TTS disabled (set TTS_REMOTE=1 to enable)');

  const hash = ttsHash(text);
  let hit = true;
  let result = await ttsCacheRead(hash);
  if (!result) {
    hit = false;
    try {
      result = await ttsSynthesize(hash, text);
    } catch (err) {
      if (err instanceof HttpError) return sendError(res, err.status, err.message);
      return sendError(res, 502, `Hermes TTS failed: ${describeError(err)}`);
    }
  }

  log.debug(`tts ${hit ? 'hit ' : 'miss'} ${hash.slice(0, 8)} "${text.slice(0, 40)}"`);
  res.writeHead(200, {
    'Content-Type': result.mime,
    'Content-Length': result.audio.length,
    // Cached phrases are immutable for a given text, so let the browser keep them too.
    'Cache-Control': CONFIG.ttsCache ? 'private, max-age=86400' : 'no-store',
    ETag: `"${hash}"`,
    'X-TTS-Provider': result.provider,
    'X-TTS-Cache': hit ? 'hit' : 'miss',
  });
  res.end(result.audio);
}

/**
 * Synthesize the conversational fillers once, at boot, so the first acknowledgement of the day is
 * instant. Runs sequentially in the background and yields between phrases — a real chat asking for
 * speech must never queue behind the warm-up.
 */
async function prewarmTts() {
  if (!CONFIG.ttsCache || !CONFIG.ttsPrewarm || !CONFIG.ttsRemote) return;
  const { ALL_PHRASES } = await import('./public/phrases.js');
  let made = 0;
  for (const phrase of ALL_PHRASES) {
    const hash = ttsHash(phrase);
    if (await ttsCacheRead(hash)) continue;
    try {
      await ttsSynthesize(hash, phrase);
      made++;
      await new Promise((r) => setTimeout(r, 400));
    } catch (err) {
      log.warn(`tts prewarm stopped: ${err.message}`);
      return;
    }
  }
  log.info(made ? `tts prewarm: synthesized ${made} filler phrase(s)` : 'tts prewarm: all filler phrases already cached');
}

// ───────────────────────────────────────────────────────────────────────────────
// Reminders & timers
// ───────────────────────────────────────────────────────────────────────────────
//
// The browser parses "remind me in twenty minutes to …" (public/app.js) and posts the result here;
// this server keeps the clock, because a browser tab may be closed, asleep or throttled when the
// moment comes. When a reminder falls due it is marked fired (the page announces it on its next
// poll), the robot head waves to catch the eye, and — with a Telegram bot configured on the Pi —
// the same line goes to the user's phone, so a reminder set at the desk still reaches them in the
// kitchen.

const REMINDERS_FILE = path.join(CONFIG.dataDir, 'reminders.json');
const REMINDER_MAX_TEXT = 240;
const REMINDER_MAX_AHEAD_MS = 366 * 24 * 3600 * 1000;
const REMINDER_KEEP_FIRED_MS = 24 * 3600 * 1000;
const reminders = { items: [], nextId: 1, loaded: false, saving: null };

function loadReminders() {
  try {
    const parsed = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
    reminders.items = Array.isArray(parsed.items) ? parsed.items.filter((r) => r && typeof r.id === 'number' && typeof r.at === 'number') : [];
    reminders.nextId = Math.max(Number(parsed.nextId) || 1, ...reminders.items.map((r) => r.id + 1), 1);
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`reminders: could not read ${REMINDERS_FILE}: ${err.message}`);
    reminders.items = [];
  }
  reminders.loaded = true;
  const pending = reminders.items.filter((r) => !r.fired).length;
  if (pending) log.info(`reminders: ${pending} pending`);
}

async function saveReminders() {
  const cutoff = Date.now() - REMINDER_KEEP_FIRED_MS;
  reminders.items = reminders.items.filter((r) => !r.fired || (r.firedAt || 0) >= cutoff);
  const payload = JSON.stringify({ nextId: reminders.nextId, items: reminders.items }, null, 1);
  try {
    await fsp.mkdir(CONFIG.dataDir, { recursive: true });
    const tmp = `${REMINDERS_FILE}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, payload);
    await fsp.rename(tmp, REMINDERS_FILE);
  } catch (err) {
    log.warn(`reminders: save failed: ${err.message}`);
  }
}

function listReminders(since = 0) {
  const now = Date.now();
  return {
    now,
    pending: reminders.items.filter((r) => !r.fired).sort((a, b) => a.at - b.at),
    fired: reminders.items.filter((r) => r.fired && (r.firedAt || 0) >= since).sort((a, b) => b.firedAt - a.firedAt).slice(0, 20),
  };
}

async function createReminder(body) {
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, REMINDER_MAX_TEXT) : '';
  if (!text) throw new HttpError(400, '"text" is required');
  const now = Date.now();
  let at = Number(body.at);
  if (!Number.isFinite(at) && Number.isFinite(Number(body.in_s))) at = now + Number(body.in_s) * 1000;
  if (!Number.isFinite(at)) throw new HttpError(400, '"at" (ms since epoch) or "in_s" is required');
  if (at < now - 5000) throw new HttpError(400, 'that time has already passed');
  if (at > now + REMINDER_MAX_AHEAD_MS) throw new HttpError(400, 'reminders can be at most a year ahead');
  const item = {
    id: reminders.nextId++,
    kind: body.kind === 'timer' ? 'timer' : 'reminder',
    text,
    at: Math.round(at),
    createdAt: now,
    notify: body.notify !== false,
    fired: false,
    firedAt: null,
  };
  reminders.items.push(item);
  await saveReminders();
  log.info(`reminder #${item.id} set for ${new Date(item.at).toISOString()} (${item.kind}): "${item.text}"`);
  return item;
}

async function deleteReminder(id) {
  const idx = reminders.items.findIndex((r) => r.id === id && !r.fired);
  if (idx < 0) return false;
  reminders.items.splice(idx, 1);
  await saveReminders();
  return true;
}

async function clearReminders() {
  const before = reminders.items.length;
  reminders.items = reminders.items.filter((r) => r.fired);
  await saveReminders();
  return before - reminders.items.length;
}

/** The moment a reminder falls due: mark it, wave, and tell the phone. The page speaks it. */
async function checkReminders() {
  if (!reminders.loaded) return;
  const now = Date.now();
  const due = reminders.items.filter((r) => !r.fired && r.at <= now);
  if (!due.length) return;
  for (const r of due) { r.fired = true; r.firedAt = now; }
  await saveReminders();
  for (const r of due) {
    log.info(`reminder #${r.id} due: "${r.text}"`);
    const line = r.kind === 'timer' ? `⏱ Time's up: ${r.text}` : `⏰ Reminder: ${r.text}`;
    fetchWithTimeout(`${CONFIG.piBridgeUrl}/gesture`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'wave' }),
    }, 4000).catch(() => {});
    if (r.notify) {
      fetchWithTimeout(`${CONFIG.piBridgeUrl}/notify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: line }),
      }, 25_000).then(async (up) => {
        if (!up.ok) log.debug(`reminder #${r.id}: telegram not sent (${up.status})`);
      }).catch((err) => log.debug(`reminder #${r.id}: notify failed: ${describeError(err)}`));
    }
  }
}

async function handleReminders(req, res) {
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://nova.local');
    const since = Number(url.searchParams.get('since')) || 0;
    return sendJson(res, 200, listReminders(since));
  }
  if (req.method === 'POST') {
    const item = await createReminder(await readJsonBody(req));
    return sendJson(res, 201, { ok: true, reminder: item, ...listReminders() });
  }
  if (req.method === 'DELETE') {
    const removed = await clearReminders();
    return sendJson(res, 200, { ok: true, removed, ...listReminders() });
  }
  return sendError(res, 405, 'method not allowed', { Allow: 'GET, POST, DELETE' });
}

async function handleReminderDelete(res, rawId) {
  const id = Number.parseInt(rawId, 10);
  if (!Number.isFinite(id)) throw new HttpError(400, 'invalid reminder id');
  const ok = await deleteReminder(id);
  if (!ok) return sendError(res, 404, 'no such pending reminder');
  return sendJson(res, 200, { ok: true, ...listReminders() });
}

// ───────────────────────────────────────────────────────────────────────────────
// Routing
// ───────────────────────────────────────────────────────────────────────────────

const ROUTES = [
  { path: '/api/config', methods: ['GET'], handler: handleConfig },
  { path: '/api/health', methods: ['GET'], handler: async (req, res) => sendJson(res, 200, await getHealth()) },
  { path: '/api/stats', methods: ['GET'], handler: async (req, res) => sendJson(res, 200, await getStats()) },
  { path: '/api/weather', methods: ['GET'], handler: handleWeather },
  { path: '/api/chat', methods: ['POST'], handler: handleChat },
  { path: '/api/tts', methods: ['POST'], handler: handleTts },
  { path: '/api/sessions', methods: ['GET'], handler: handleSessions },
  { path: '/api/pi/stream.mjpg', methods: ['GET'], handler: (req, res) => proxyPiRaw(req, res, 'stream.mjpg', TIMEOUTS.piStreamResponse) },
  { path: '/api/pi/snapshot.jpg', methods: ['GET'], handler: (req, res) => proxyPiRaw(req, res, 'snapshot.jpg', TIMEOUTS.piSnapshot) },
  { path: '/api/pi/pantilt', methods: ['GET', 'POST'], handler: (req, res) => proxyPiJson(req, res, 'pantilt') },
  { path: '/api/pi/pantilt/center', methods: ['POST'], handler: (req, res) => proxyPiJson(req, res, 'pantilt/center') },
  { path: '/api/pi/pantilt/release', methods: ['POST'], handler: (req, res) => proxyPiJson(req, res, 'pantilt/release') },
  { path: '/api/pi/pantilt/limits', methods: ['GET'], handler: (req, res) => proxyPiJson(req, res, 'pantilt/limits') },
  { path: '/api/pi/pantilt/calibrate', methods: ['POST'], handler: (req, res) => proxyPiJson(req, res, 'pantilt/calibrate', 120_000) },
  { path: '/api/pi/attention', methods: ['GET', 'POST'], handler: (req, res) => proxyPiJson(req, res, 'attention') },
  { path: '/api/pi/gestures', methods: ['GET'], handler: (req, res) => proxyPiJson(req, res, 'gestures') },
  { path: '/api/pi/gesture', methods: ['POST'], handler: (req, res) => proxyPiJson(req, res, 'gesture') },
  { path: '/api/pi/gesture/stop', methods: ['POST'], handler: (req, res) => proxyPiJson(req, res, 'gesture/stop') },
  { path: '/api/pi/status', methods: ['GET'], handler: (req, res) => proxyPiJson(req, res, 'status') },
  { path: '/api/pi/presence', methods: ['GET', 'POST'], handler: (req, res) => proxyPiJson(req, res, 'presence') },
  { path: '/api/pi/watch', methods: ['GET', 'POST'], handler: (req, res) => proxyPiJson(req, res, 'watch') },
  { path: '/api/pi/capture', methods: ['POST'], handler: (req, res) => proxyPiJson(req, res, 'capture') },
  { path: '/api/pi/captures', methods: ['GET'], handler: (req, res) => proxyPiJson(req, res, 'captures') },
  { path: '/api/pi/notify', methods: ['POST'], handler: (req, res) => proxyPiJson(req, res, 'notify') },
  { path: '/api/pi/vibe', methods: ['GET', 'POST'], handler: (req, res) => proxyPiJson(req, res, 'vibe') },
  { path: '/api/pi/metronome', methods: ['GET', 'POST'], handler: (req, res) => proxyPiJson(req, res, 'metronome') },
  { path: '/api/reminders', methods: ['GET', 'POST', 'DELETE'], handler: handleReminders },
];

function handleConfig(req, res) {
  sendJson(res, 200, {
    name: 'Nova',
    wordmark: 'N.O.V.A',
    hermes_url: CONFIG.hermesUrl,
    pi_bridge_url: CONFIG.piBridgeUrl,
    host_name: os.hostname(),
    tts_remote: CONFIG.ttsRemote,
    gestures: CONFIG.gestures,
    lanes: { quick: CONFIG.quickReasoning, deep: CONFIG.deepReasoning },
    reminders: true,
  });
}

async function handleWeather(req, res) {
  try {
    sendJson(res, 200, await getWeather());
  } catch (err) {
    throw new HttpError(503, `weather unavailable: ${describeError(err)}`);
  }
}

async function dispatch(req, res, pathname) {
  const route = ROUTES.find((r) => r.path === pathname);
  if (route) {
    if (!route.methods.includes(req.method)) {
      return sendError(res, 405, 'method not allowed', { Allow: route.methods.join(', ') });
    }
    return route.handler(req, res);
  }
  const sessionMessages = /^\/api\/sessions\/([^/]+)\/messages$/.exec(pathname);
  if (sessionMessages) {
    if (req.method !== 'GET') return sendError(res, 405, 'method not allowed', { Allow: 'GET' });
    return handleSessionMessages(res, sessionMessages[1]);
  }
  const reminderOne = /^\/api\/reminders\/(\d+)$/.exec(pathname);
  if (reminderOne) {
    if (req.method !== 'DELETE') return sendError(res, 405, 'method not allowed', { Allow: 'DELETE' });
    return handleReminderDelete(res, reminderOne[1]);
  }
  const captureFile = /^\/api\/pi\/captures\/([A-Za-z0-9._-]{1,96}\.jpg)$/.exec(pathname);
  if (captureFile) {
    if (req.method !== 'GET') return sendError(res, 405, 'method not allowed', { Allow: 'GET' });
    return proxyPiRaw(req, res, `captures/${captureFile[1]}`, TIMEOUTS.piSnapshot);
  }
  if (pathname.startsWith('/api/')) return sendError(res, 404, 'no such endpoint');
  return serveStatic(req, res, pathname);
}

function onRequest(req, res) {
  const startedAt = process.hrtime.bigint();
  const { pathname } = splitUrl(req.url ?? '/');
  let logged = false;
  const logOnce = (suffix = '') => {
    if (logged) return;
    logged = true;
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const write = pathname === '/api/stats' ? log.debug : log.info;
    write(`${req.method} ${pathname} ${res.statusCode} ${ms.toFixed(ms < 10 ? 1 : 0)}ms${suffix}`);
  };
  res.on('finish', () => logOnce());
  res.on('close', () => logOnce(res.writableFinished ? '' : ' (client closed)'));

  if (!pathname.startsWith('/')) return sendError(res, 400, 'bad request');

  Promise.resolve()
    .then(() => dispatch(req, res, pathname))
    .catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) log.error(`${req.method} ${pathname}: ${err.stack ?? err}`);
      if (!res.headersSent) sendError(res, status, err instanceof HttpError ? err.message : 'internal server error');
      else res.destroy();
    });
}

// ───────────────────────────────────────────────────────────────────────────────
// Startup, banner, graceful shutdown
// ───────────────────────────────────────────────────────────────────────────────

const server = http.createServer(onRequest);

function printBanner() {
  const url = `http://${CONFIG.host}:${CONFIG.port}`;
  console.log('');
  console.log('  N.O.V.A  dashboard server');
  console.log('  ' + '─'.repeat(62));
  console.log(`  Dashboard  ${url}`);
  console.log(`  Hermes     ${CONFIG.hermesUrl}  (model "${CONFIG.hermesModel}", session key "${CONFIG.hermesSessionKey}")`);
  console.log(`  Pi bridge  ${CONFIG.piBridgeUrl}`);
  console.log(`  Lanes      quick: reasoning ${CONFIG.quickReasoning} · deep: reasoning ${CONFIG.deepReasoning} · gesture cues ${CONFIG.gestures ? 'on' : 'off'}`);
  console.log(`  Data       ${CONFIG.dataDir}  (reminders)`);
  console.log(`  Static     ${PUBLIC_DIR}`);
  console.log(`  Weather    ${CONFIG.weatherLat && CONFIG.weatherLon ? `fixed ${CONFIG.weatherLat},${CONFIG.weatherLon}` : 'auto (ip-api)'}${CONFIG.weatherCity ? ` · city "${CONFIG.weatherCity}"` : ''}`);
  console.log(`  Log level  ${CONFIG.logLevel}${CONFIG.logLevel === 'debug' ? '' : '  (LOG_LEVEL=debug for /api/stats + SSE frames)'}`);
  console.log('  ' + '─'.repeat(62));
  if (!CONFIG.hermesKey) console.log('  ⚠ HERMES_KEY is empty — /api/chat will answer 503 until it is set in .env');
  console.log('');
}

async function reportUpstreams() {
  const { hermes, pi_bridge } = await getHealth();
  log.info(hermes.ok ? `hermes: ok v${hermes.version ?? '?'} (${hermes.latency_ms} ms)` : `hermes: unreachable (${hermes.error ?? 'error'})`);
  log.info(
    pi_bridge.ok
      ? `pi bridge: ok (camera ${pi_bridge.camera ? 'yes' : 'no'}, pantilt ${pi_bridge.pantilt ? 'yes' : 'no'})`
      : `pi bridge: unreachable (${pi_bridge.error ?? 'error'}) — Pi stats/camera/pan-tilt degrade gracefully`,
  );
}

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) {
    log.warn('second signal — exiting immediately');
    process.exit(1);
  }
  shuttingDown = true;
  log.info(`${signal} received, shutting down…`);
  cpuSampler.stop();
  for (const controller of activeChats) controller.abort();
  for (const upstreamReq of activeProxies) upstreamReq.destroy();
  server.close(() => {
    log.info('server closed, bye');
    process.exit(0);
  });
  server.closeIdleConnections?.();
  setTimeout(() => server.closeAllConnections?.(), 500).unref();
  setTimeout(() => {
    log.warn('shutdown timed out, forcing exit');
    process.exit(0);
  }, 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error(`unhandled rejection: ${err?.stack ?? err}`));
process.on('uncaughtException', (err) => log.error(`uncaught exception: ${err?.stack ?? err}`));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`error: ${CONFIG.host}:${CONFIG.port} is already in use — stop the other process or set PORT in .env`);
  } else {
    console.error(`server error: ${err.stack ?? err}`);
  }
  process.exit(1);
});

server.listen(CONFIG.port, CONFIG.host, () => {
  printBanner();
  loadReminders();
  setInterval(() => checkReminders().catch((err) => log.warn(`reminders: ${describeError(err)}`)), 1000).unref();
  reportUpstreams().catch((err) => log.warn(`startup probe failed: ${describeError(err)}`));
  // Deliberately unawaited: warming the filler phrases must not hold up serving.
  setTimeout(() => prewarmTts().catch((err) => log.warn(`tts prewarm failed: ${describeError(err)}`)), 2500).unref();
});
