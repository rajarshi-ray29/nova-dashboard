// NOVA — wake word / conversation mode / dictation / TTS (spec §9). Zero dependencies.
//
// createSpeech({ onCommand, onStatus, onInterim, onConversation, onBargeIn, onInterrupt,
//                onSignoff }) → { … }
//
// onStatus values: 'listening' | 'awake' | 'open' | 'stopped' | 'unsupported' | 'error:<msg>'
//
// ── Conversation model ────────────────────────────────────────────────────────────────────────
// Nova used to close the conversation after every single command, so each turn needed the wake
// word again. She now keeps a *follow-up window* open once she has finished answering:
//
//   idle   → wake word required ("hey nova, what's the weather")
//   awake  → wake word heard on its own; the next utterance is the command (8 s)
//   open   → follow-up window: just talk, no wake word (default 30 s, restarted after each reply)
//
// While Nova is reading an answer aloud, only the wake word or a stop phrase interrupts her, and
// being interrupted makes her go quiet and *wait* (`holdForUser`) rather than resume — she keeps
// listening with no wake word needed, even if continuous conversation is switched off.
//
// The speaker and the microphone share a room, so two independent filters stop her hearing herself:
//   • `isSelfEcho` — the transcript's words match something she said in the last 20 s. Checked on
//     every transcript, not only while audio is playing, because final results arrive late.
//   • `startedOverReply` — the utterance *began* while she was reading an answer out. Catches her
//     own voice mis-transcribed into words she never said, which is how she interrupted herself.
// Short fillers ("On it.", "Yes?") are exempt from the second filter: the user is meant to talk
// over those.
//
// ── Speech output ─────────────────────────────────────────────────────────────────────────────
// Output runs through one serial queue so acknowledgements ("On it.") and reply chunks never talk
// over each other. Replies are enqueued sentence-by-sentence while the answer is still streaming,
// so Nova starts talking early instead of after the whole answer lands. Each queued chunk may
// carry an `onStart` hook, fired when its audio actually begins: that is how the robot head's
// gesture cues stay in step with the sentence they belong to.

import { ALL_PHRASES } from './phrases.js';

const AWAKE_WINDOW_MS = 8000;          // wake word heard alone → how long we wait for the command
const DEFAULT_FOLLOW_UP_MS = 30000;    // "just talk" window after Nova finishes a reply
const ECHO_TAIL_MS = 1500;             // recognizer lag: transcripts of her voice arrive this late
const ECHO_MEMORY_MS = 20000;          // how long her own words stay comparable for echo rejection
const INTERRUPT_HOLD_MS = 25000;       // after being cut off she waits at least this long, in silence
const TTS_RETRY_MS = 300000;           // after a failed synthesis, how long before we try the server again
// Browser-side fallback only (used when /api/tts is unreachable). Kept female and British-leaning
// so an offline Nova still sounds like her ElevenLabs voice (Alice) rather than switching gender.
const PREFERRED_VOICES = ['Google UK English Female', 'Samantha', 'Karen', 'Serena', 'Moira'];

// Server-side synthesis is unavailable (no credits, no network, switched off) until this moment.
// Nova simply reads with the browser's own voice meanwhile: retrying on every sentence would only
// put a stall in front of each one, and the fallback voice needs no apology.
let ttsDownUntil = 0;

// Ends the conversation and drops back to wake-word mode.
const END_RE = /^(?:ok(?:ay)?[\s,]*)?(?:thanks?(?:\s+you)?[\s,]*)?(?:nova[\s,]*)?(?:goodbye|good\s*bye|bye(?:\s+bye)?|that'?s\s+all|that\s+is\s+all|that'?ll\s+be\s+all|stop\s+listening|go\s+to\s+sleep|we'?re\s+done|i'?m\s+done|nothing\s+else)\b/i;

// Interrupts Nova mid-sentence without asking anything new.
const STOP_RE = /^(?:nova[\s,]*)?(?:stop|wait|hold\s+on|hang\s+on|quiet|be\s+quiet|shut\s+up|pause|cancel|never\s*mind)\b/i;

const STOPWORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'for', 'i', 'in', 'is', 'it', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'so', 'that', 'the', 'this', 'to', 'up', 'was', 'we', 'yes', 'you']);

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function words(s) { return String(s).toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter(Boolean); }

/** Reduce markdown to something worth reading aloud. Exported so chunkers can size by it. */
export function stripForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')          // code fences
    .replace(/`[^`]*`/g, ' ')                 // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')    // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')  // links → label
    .replace(/https?:\/\/\S+/g, ' ')          // bare URLs
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')       // headings
    .replace(/^\s*[-*+]\s+/gm, '')            // bullets
    .replace(/^\s*\d+\.\s+/gm, '')            // numbered lists
    .replace(/^\s*>\s?/gm, '')                // quotes
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1') // emphasis
    .replace(/[*_#>|]/g, ' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ') // emoji
    .replace(/\s+/g, ' ')
    .trim();
}

export function createSpeech({
  onCommand = () => {},
  onStatus = () => {},
  onInterim = () => {},
  onTtsFallback = () => {},
  onConversation = () => {},
  onBargeIn = () => {},
  onInterrupt = () => {},
  onSignoff = () => {},
} = {}) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const supported = !!SR;

  let rec = null;
  let listening = false;         // user intent: should we be listening?
  let running = false;           // recognizer actually running
  let wakeEnabled = true;
  let wakePhrase = 'nova';
  let wakeRe = buildWakeRe('nova');
  let awakeUntil = 0;
  let awakeTimer = 0;
  let restartTimer = 0;
  let errorStreak = 0;

  // Conversation (follow-up) mode.
  let conversationEnabled = true;
  let followUpMs = DEFAULT_FOLLOW_UP_MS;   // 0 = stay open until an end phrase
  let bargeInEnabled = true;
  let openUntil = 0;                        // ms timestamp, or Infinity when followUpMs === 0
  let openTimer = 0;

  // Speech output.
  let acksEnabled = true;
  const queue = [];              // { text, kind: 'reply' | 'ack', resolve }
  let current = null;            // { kind, text, controller, audio, url, owned }
  let speaking = false;
  let speechGeneration = 0;
  let currentUtterance = null;
  // Everything Nova has said recently. The speaker and the microphone share a room, so her own
  // voice comes back through the mic a beat later; without this she hears herself, answers herself,
  // and — worse — interrupts herself when a stray word transcribes as the wake word.
  let spokenLog = [];            // { text, words: Set<string>, at }
  let speechWindows = [];        // { from, to, kind } — `to` stays Infinity while audio is playing
  let utteranceStart = 0;        // when the utterance now being transcribed began
  let awaitingUser = false;      // she has finished and handed the floor over — anything now is theirs
  let idleWaiters = [];
  const ttsCache = new Map();    // phrase → object URL, kept for the life of the page

  function buildWakeRe(phrase) {
    const p = escapeRe(phrase.trim().toLowerCase());
    // "hey nova", "okay nova", "ok nova", or bare "nova" followed by optional punctuation.
    return new RegExp(`(?:^|\\b)(?:hey|okay|ok)?[\\s,]*${p}\\b[\\s,.!?:;-]*`, 'i');
  }

  function setWakeWord(enabled, phrase = 'nova') {
    wakeEnabled = !!enabled;
    wakePhrase = (phrase || 'nova').trim() || 'nova';
    wakeRe = buildWakeRe(wakePhrase);
    if (listening) emitState();
  }

  function setConversation({ enabled, windowMs, bargeIn } = {}) {
    if (enabled !== undefined) conversationEnabled = !!enabled;
    if (windowMs !== undefined) followUpMs = Math.max(0, Number(windowMs) || 0);
    if (bargeIn !== undefined) bargeInEnabled = !!bargeIn;
    if (!conversationEnabled) closeFollowUp({ silent: true });
    else if (isOpen()) openFollowUp();   // re-arm with the new duration
    if (listening) emitState();
  }

  /* ---- conversation window ------------------------------------------------------------------ */

  function isOpen() { return openUntil === Infinity || (openUntil > 0 && Date.now() <= openUntil); }

  function openFollowUp() {
    if (!conversationEnabled || !listening) return;
    clearTimeout(openTimer);
    openTimer = 0;
    const wasOpen = isOpen();
    if (followUpMs === 0) {
      openUntil = Infinity;
    } else {
      openUntil = Date.now() + followUpMs;
      openTimer = setTimeout(() => { openUntil = 0; onConversation(false); emitState(); }, followUpMs);
    }
    clearAwake();
    awaitingUser = true;
    if (!wasOpen) onConversation(true);
    emitState();
  }

  function closeFollowUp({ silent = false } = {}) {
    const wasOpen = isOpen();
    openUntil = 0;
    awaitingUser = false;
    clearTimeout(openTimer);
    openTimer = 0;
    if (wasOpen && !silent) onConversation(false);
    if (listening) emitState();
  }

  function clearAwake() {
    awakeUntil = 0;
    if (awakeTimer) { clearTimeout(awakeTimer); awakeTimer = 0; }
  }

  function setAwake() {
    clearAwake();
    awakeUntil = Date.now() + AWAKE_WINDOW_MS;
    awakeTimer = setTimeout(() => { awakeUntil = 0; if (listening) emitState(); }, AWAKE_WINDOW_MS);
    emitState();
  }

  /** Report the state the recognizer is actually in, so the status pill always matches reality. */
  function emitState() {
    if (!listening) { onStatus('stopped'); return; }
    if (awakeUntil && Date.now() <= awakeUntil) onStatus('awake');
    else if (isOpen()) onStatus('open');
    else onStatus('listening');
  }

  /* ---- echo suppression ---------------------------------------------------------------------- */

  function pruneEchoMemory() {
    const cutoff = Date.now() - ECHO_MEMORY_MS;
    spokenLog = spokenLog.filter((e) => e.at >= cutoff);
    speechWindows = speechWindows.filter((w) => w.to === Infinity || w.to >= cutoff);
  }

  function noteSpeechStart(item) {
    pruneEchoMemory();
    if (item.kind === 'reply') awaitingUser = false;
    const at = Date.now();
    spokenLog.push({ text: item.text, words: new Set(words(item.text)), at });
    speechWindows.push({ from: at, to: Infinity, kind: item.kind });
  }

  function noteSpeechEnd() {
    const at = Date.now();
    for (const w of speechWindows) if (w.to === Infinity) w.to = at;
  }

  /**
   * True when the recognizer almost certainly picked up Nova rather than the user: most of the
   * meaningful words heard appear in something she has said in the last few seconds.
   *
   * This is checked against everything recently spoken, not just the sentence playing right now,
   * because a transcript of her third sentence can easily land while her fourth is playing — and
   * it is checked on every transcript, not only while audio is out, because Chrome delivers final
   * results well after the audio that produced them.
   */
  function isSelfEcho(heard) {
    pruneEchoMemory();
    if (!spokenLog.length) return false;
    const mine = new Set();
    for (const entry of spokenLog) for (const w of entry.words) mine.add(w);
    const all = words(heard);
    if (!all.length) return false;
    const meaningful = all.filter((w) => !STOPWORDS.has(w));
    // A bare "yes" / "no" / "sure" is a real answer to a question — echo only if she just said it.
    if (!meaningful.length) return all.every((w) => mine.has(w));
    const hits = meaningful.filter((w) => mine.has(w)).length;
    return hits / meaningful.length >= 0.6;
  }

  /**
   * True when this utterance *began* while Nova was reading an answer aloud (or in the tail after
   * it). Timing catches what word matching cannot: her voice mis-transcribed into words she never
   * said, which is exactly how she used to interrupt herself.
   *
   * Short fillers ("On it.", "Yes?") deliberately do not count — the user is expected to talk over
   * those, so speaking during one is treated as ordinary conversation.
   */
  function startedOverReply(startedAt, precise) {
    const t = startedAt || Date.now();
    // With a real interim timestamp we know when the user opened their mouth, so answering the
    // instant she stops works. Without one the delivery time is all we have, and a late transcript
    // of her own voice looks identical to a prompt reply — so fall back to a cautious tail.
    const tail = precise ? 250 : ECHO_TAIL_MS;
    return speechWindows.some((w) => w.kind === 'reply' && t >= w.from - 200 && t <= w.to + tail);
  }

  /* ---- recognition --------------------------------------------------------------------------- */

  function dispatch(text, meta) {
    clearAwake();
    awaitingUser = false;
    // Hold the window open across the round trip; app.js re-arms it when Nova finishes speaking.
    if (conversationEnabled && listening) openFollowUp();
    onCommand(text, meta);
    emitState();
  }

  function endConversation({ spoken = true } = {}) {
    closeFollowUp();
    cancelSpeech();
    if (spoken) onSignoff();
  }

  /**
   * Nova was cut off: stop talking and stay attentive so the user can take their time saying what
   * they actually want. This holds even when continuous conversation is switched off — interrupting
   * her is itself a request for her attention, and making the user repeat the wake word after it
   * defeats the point.
   */
  function holdForUser() {
    if (!listening) return;
    const wasOpen = isOpen();
    clearAwake();
    clearTimeout(openTimer);
    openTimer = 0;
    if (conversationEnabled && followUpMs === 0) {
      openUntil = Infinity;
    } else {
      const ms = Math.max(INTERRUPT_HOLD_MS, conversationEnabled ? followUpMs : 0);
      openUntil = Date.now() + ms;
      openTimer = setTimeout(() => { openUntil = 0; onConversation(false); emitState(); }, ms);
    }
    awaitingUser = true;
    if (!wasOpen) onConversation(true);
    emitState();
  }

  function handleFinal(text, startedAt, precise) {
    const clean = text.trim();
    if (!clean) return;

    // 0. Never act on Nova's own voice, whatever state she is in.
    if (isSelfEcho(clean)) return;

    // 1. Spoken over an answer she was still delivering: only a deliberate interruption counts, so
    //    a mis-transcription of her own voice cannot pass for a command. Once she has handed the
    //    floor over — finished the answer, or been interrupted and gone quiet — this does not
    //    apply: whatever is said then is meant for her, however soon it comes.
    if (!awaitingUser && startedOverReply(startedAt, precise)) {
      if (!bargeInEnabled) return;
      const m = wakeEnabled ? wakeRe.exec(clean) : null;
      const isStop = STOP_RE.test(clean);
      if (!m && !isStop) return;
      const rest = m ? clean.slice(m.index + m[0].length).trim() : '';
      // Second-guess the wake word itself. "...I'll check that for you..." can transcribe as
      // "nova check that for you", which survives the whole-utterance echo test only because the
      // stray "nova" dilutes it — but the command half on its own is pure echo.
      if (rest && isSelfEcho(rest)) return;
      onBargeIn();
      cancelSpeech();
      if (END_RE.test(clean)) { endConversation(); return; }
      if (!rest || STOP_RE.test(rest)) {
        // Nothing to act on yet — go quiet and wait. "Nova?" gets a word back; "stop" gets silence.
        holdForUser();
        if (m && !isStop && !STOP_RE.test(rest)) onInterrupt();
        return;
      }
      dispatch(rest, { viaWake: !!m, bargeIn: true });
      return;
    }

    // 2. Wake word anywhere in the utterance always works, in every state.
    if (wakeEnabled) {
      const m = wakeRe.exec(clean);
      if (m) {
        const rest = clean.slice(m.index + m[0].length).trim();
        if (!rest) { setAwake(); return; }
        if (END_RE.test(rest)) { endConversation(); return; }
        if (STOP_RE.test(rest)) { onBargeIn(); cancelSpeech(); holdForUser(); return; }
        dispatch(rest, { viaWake: true });
        return;
      }
    }

    // 3. No wake word needed while the awake or follow-up window is open.
    const awake = awakeUntil && Date.now() <= awakeUntil;
    if (!wakeEnabled || awake || isOpen()) {
      if (END_RE.test(clean)) { endConversation(); return; }
      if (STOP_RE.test(clean)) { onBargeIn(); cancelSpeech(); holdForUser(); return; }
      dispatch(clean, { viaWake: false, viaFollowUp: isOpen() && !awake });
    }
  }

  function createRecognizer() {
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-US';
    r.maxAlternatives = 1;

    r.onstart = () => { running = true; errorStreak = 0; };
    r.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const t = res[0] && res[0].transcript ? res[0].transcript : '';
        if (res.isFinal) {
          onInterim('');
          // When this utterance *started* matters more than when it was delivered.
          const startedAt = utteranceStart || Date.now();
          const precise = !!utteranceStart;
          utteranceStart = 0;
          handleFinal(t, startedAt, precise);
        } else {
          if (!utteranceStart) utteranceStart = Date.now();
          interim += t;
        }
      }
      // Never show Nova's own voice back to the user as if they had said it.
      if (interim) onInterim(isSelfEcho(interim) ? '' : interim.trim());
    };
    r.onerror = (ev) => {
      const code = ev.error || 'unknown';
      if (code === 'no-speech' || code === 'aborted') return; // benign; onend restarts
      errorStreak++;
      onStatus('error:' + code);
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        if (errorStreak >= 3) { listening = false; onStatus('stopped'); }
      }
    };
    r.onend = () => {
      running = false;
      onInterim('');
      if (!listening) { onStatus('stopped'); return; }
      const delay = errorStreak ? Math.min(15000, 500 * Math.pow(2, errorStreak)) : 250;
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => { if (listening && !running) safeStart(); }, delay);
    };
    return r;
  }

  function safeStart() {
    if (!supported || running) return;
    try {
      if (!rec) rec = createRecognizer();
      rec.start();
    } catch (e) {
      // "already started" and similar races — retry shortly.
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => { if (listening && !running) { rec = null; safeStart(); } }, 800);
    }
  }

  function startListening() {
    if (!supported) { onStatus('unsupported'); return; }
    if (listening) return;
    listening = true;
    errorStreak = 0;
    emitState();
    safeStart();
  }

  function stopListening() {
    listening = false;
    clearAwake();
    closeFollowUp({ silent: true });
    clearTimeout(restartTimer);
    onInterim('');
    if (rec) { try { rec.stop(); } catch { /* ignore */ } }
    if (!running) onStatus('stopped');
  }

  /* ---- TTS ----------------------------------------------------------------------------------- */


  function pickVoice() {
    const synth = window.speechSynthesis;
    if (!synth) return null;
    const voices = synth.getVoices() || [];
    for (const name of PREFERRED_VOICES) {
      const v = voices.find((x) => x.name && x.name.includes(name));
      if (v) return v;
    }
    return voices.find((x) => /^en[-_]/i.test(x.lang)) || voices.find((x) => /^en/i.test(x.lang)) || null;
  }

  // Chrome loads voices asynchronously; warm the list.
  if (window.speechSynthesis) {
    try { window.speechSynthesis.getVoices(); } catch { /* ignore */ }
    window.speechSynthesis.onvoiceschanged = () => { try { window.speechSynthesis.getVoices(); } catch { /* ignore */ } };
  }

  function speakWithBrowser(clean, generation) {
    return new Promise((resolve) => {
      const synth = window.speechSynthesis;
      if (!synth || !window.SpeechSynthesisUtterance || generation !== speechGeneration) { resolve(); return; }
      const u = new SpeechSynthesisUtterance(clean);
      const v = pickVoice();
      if (v) u.voice = v;
      u.lang = (v && v.lang) || 'en-US';
      u.rate = 1.0;
      u.pitch = 1.0;
      let done = false;
      const finish = () => { if (done) return; done = true; if (currentUtterance === u) currentUtterance = null; resolve(); };
      u.onend = finish;
      u.onerror = finish;
      currentUtterance = u;
      try { synth.speak(u); } catch { finish(); }
      // Safety net: some engines never fire end on cancel().
      const ms = Math.min(120000, 4000 + clean.length * 90);
      setTimeout(() => { if (!done && !synth.speaking) finish(); }, ms);
    });
  }

  /** Fetch synthesized audio for `text`. Phrases in the warm cache come back without a round trip. */
  async function fetchAudioUrl(text, signal) {
    const cached = ttsCache.get(text);
    if (cached) return { url: cached, owned: false };
    if (Date.now() < ttsDownUntil) throw new Error('remote TTS unavailable');
    let res;
    try {
      res = await fetch('/api/tts', {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Accept: 'audio/*, application/json' },
        body: JSON.stringify({ text }),
      });
    } catch (err) {
      // An abort is us cancelling her, not the server failing — that must not disable the voice.
      if (!signal || !signal.aborted) ttsDownUntil = Date.now() + TTS_RETRY_MS;
      throw err;
    }
    if (!res.ok) {
      ttsDownUntil = Date.now() + TTS_RETRY_MS;
      let detail = `HTTP ${res.status}`;
      try { const data = await res.json(); if (data && data.error) detail = data.error; } catch { /* ignore */ }
      throw new Error(detail);
    }
    const blob = await res.blob();
    if (!blob.size) throw new Error('empty audio response');
    return { url: URL.createObjectURL(blob), owned: true };
  }

  /**
   * Start fetching an item's audio before it is its turn. Synthesis takes ~2.5 s on a cache miss,
   * which would otherwise fall as a silent gap between every spoken sentence; prefetching the next
   * chunk while the current one plays hides that latency behind the audio already in the air.
   */
  function prefetch(item) {
    if (!item || item.fetch) return;
    item.controller = new AbortController();
    item.fetch = fetchAudioUrl(item.text, item.controller.signal)
      .then((r) => ({ ok: r }), (err) => ({ err }));
  }

  /** Throw away audio fetched for items that will never be played. */
  function discard(item) {
    if (!item || !item.fetch) return;
    if (item.controller) { try { item.controller.abort(); } catch { /* ignore */ } }
    item.fetch.then((r) => { if (r && r.ok && r.ok.owned) URL.revokeObjectURL(r.ok.url); }, () => {});
    item.fetch = null;
  }

  async function playItem(item) {
    const generation = speechGeneration;
    prefetch(item);
    const controller = item.controller;
    current = { ...item, controller, audio: null, url: null, owned: false };
    speaking = true;
    noteSpeechStart(item);
    // Fired once, when this item's audio actually begins — not when it is queued and not when
    // its synthesis starts — so a gesture attached to a sentence lands as that sentence is heard.
    let startedFired = false;
    const started = () => {
      if (startedFired || typeof item.onStart !== 'function') return;
      startedFired = true;
      try { item.onStart(); } catch (e) { console.warn('speech onStart failed', e); }
    };

    try {
      const result = await item.fetch;
      if (result.err) throw result.err;
      const { url, owned } = result.ok;
      if (generation !== speechGeneration || controller.signal.aborted) {
        if (owned) URL.revokeObjectURL(url);
        return;
      }
      current.url = url;
      current.owned = owned;
      const audio = new Audio(url);
      current.audio = audio;
      await new Promise((resolve, reject) => {
        audio.onended = resolve;
        audio.onerror = () => reject(new Error('audio playback failed'));
        audio.play().then(() => { started(); prefetch(queue[0]); }, reject);
      });
    } catch (err) {
      if (controller.signal.aborted || generation !== speechGeneration) return;
      onTtsFallback((err && err.message) || String(err));
      prefetch(queue[0]);
      started();
      await speakWithBrowser(item.text, generation);
    } finally {
      if (current && current.audio) { current.audio.onended = null; current.audio.onerror = null; }
      if (current && current.url && current.owned) URL.revokeObjectURL(current.url);
      current = null;
      speaking = false;
      noteSpeechEnd();
    }
  }

  let pumping = false;
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) {
        const item = queue.shift();
        try { await playItem(item); } catch { /* already handled */ }
        item.resolve();
      }
    } finally {
      pumping = false;
      if (!queue.length) { const w = idleWaiters; idleWaiters = []; for (const r of w) r(); }
    }
  }

  function enqueue(text, kind, { onStart = null } = {}) {
    const clean = stripForSpeech(text);
    if (!clean) {
      // Nothing to say (a cue-only chunk, or pure markdown) — still honour the hook so a gesture
      // attached to it is not lost.
      if (onStart) { try { onStart(); } catch { /* ignore */ } }
      return Promise.resolve();
    }
    if (kind === 'ack') {
      if (!acksEnabled) return Promise.resolve();
      // Fillers are only worth playing when nothing real is waiting to be said.
      if (queue.length || (current && current.kind === 'reply')) return Promise.resolve();
      if (current && current.kind === 'ack') return Promise.resolve();
    }
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    queue.push({ text: clean, kind, resolve, onStart });
    pump();
    return done;
  }

  function speakAck(text) { return enqueue(text, 'ack'); }
  /** Queue a reply sentence; `onStart` fires the moment its audio begins (gesture sync). */
  function speakChunk(text, opts) { return enqueue(text, 'reply', opts); }
  function speak(text, opts) { cancelSpeech(); return enqueue(text, 'reply', opts); }

  /** Resolves once everything queued has finished playing. */
  function whenIdle() {
    if (!queue.length && !current && !pumping) return Promise.resolve();
    return new Promise((r) => idleWaiters.push(r));
  }

  function cancelSpeech() {
    speechGeneration++;
    queue.splice(0, queue.length).forEach((item) => { discard(item); item.resolve(); });
    if (current) {
      if (current.controller) { try { current.controller.abort(); } catch { /* ignore */ } }
      if (current.audio) {
        current.audio.onended = null;
        current.audio.onerror = null;
        try { current.audio.pause(); } catch { /* ignore */ }
      }
      if (current.url && current.owned) URL.revokeObjectURL(current.url);
      current = null;
    }
    const synth = window.speechSynthesis;
    if (synth) { try { synth.cancel(); } catch { /* ignore */ } }
    currentUtterance = null;
    speaking = false;
    noteSpeechEnd();
    const w = idleWaiters; idleWaiters = []; for (const r of w) r();
  }

  /**
   * Pull the filler phrases into memory so the first "On it." plays instantly. The server keeps a
   * disk cache of the same phrases, so this is a handful of small, already-synthesized downloads.
   */
  async function prewarm(list = ALL_PHRASES) {
    if (Date.now() < ttsDownUntil) return;
    for (const phrase of list) {
      if (ttsCache.has(phrase)) continue;
      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'audio/*, application/json' },
          body: JSON.stringify({ text: phrase, prewarm: true }),
        });
        if (!res.ok) { ttsDownUntil = Date.now() + TTS_RETRY_MS; return; }  // don't hammer a dead TTS
        const blob = await res.blob();
        if (blob.size) ttsCache.set(phrase, URL.createObjectURL(blob));
      } catch {
        ttsDownUntil = Date.now() + TTS_RETRY_MS;
        return;
      }
    }
  }

  return {
    supported,
    startListening,
    stopListening,
    isListening: () => listening,
    setWakeWord,
    setConversation,
    setAcks: (on) => { acksEnabled = !!on; },
    openFollowUp,
    holdForUser,
    closeFollowUp,
    endConversation,
    inConversation: isOpen,
    speak,
    speakAck,
    speakChunk,
    whenIdle,
    cancelSpeech,
    isSpeaking: () => speaking,
    prewarm,
  };
}
