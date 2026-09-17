// NOVA — mic analyser (spec §8). Zero dependencies.
//
// createMicAnalyser() → { start(), stop(), isActive(), getLevels() }
// getLevels() → { level, bass, mid, treble, raw }  (all 0..1 except raw = plain RMS)

const FFT_SIZE = 1024;
const SMOOTHING = 0.8;
const NOISE_GATE = 0.008;       // RMS below this is treated as silence
const PEAK_DECAY = 0.995;       // per-call decay of the AGC reference peak (slow release)
const PEAK_FLOOR = 0.04;        // never normalise against a peak smaller than this (avoids amplifying hiss)
const PEAK_MIN_RISE = 0.02;     // only let the reference peak follow signal above this
const BAND_LEVEL_MAX = 200;     // byte-frequency avg that maps to 1.0 for a band

function bandRange(lo, hi, binHz, nBins) {
  const a = Math.max(0, Math.floor(lo / binHz));
  const b = Math.min(nBins - 1, Math.ceil(hi / binHz));
  return [a, Math.max(a + 1, b)];
}

export function createMicAnalyser() {
  let ctx = null;
  let stream = null;
  let source = null;
  let analyser = null;
  let timeBuf = null;
  let freqBuf = null;
  let active = false;
  let refPeak = PEAK_FLOOR;
  let bands = null;
  let smoothed = { level: 0, bass: 0, mid: 0, treble: 0 };
  const last = { level: 0, bass: 0, mid: 0, treble: 0, raw: 0 };

  async function start() {
    if (active) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Microphone capture is not supported in this browser');
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('Web Audio is not supported in this browser');

    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    ctx = ctx || new AC();
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { /* resumed on the next gesture */ }
    }
    analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = SMOOTHING;
    source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);
    timeBuf = new Float32Array(analyser.fftSize);
    freqBuf = new Uint8Array(analyser.frequencyBinCount);
    const binHz = ctx.sampleRate / analyser.fftSize;
    bands = {
      bass: bandRange(20, 250, binHz, freqBuf.length),
      mid: bandRange(250, 2000, binHz, freqBuf.length),
      treble: bandRange(2000, 8000, binHz, freqBuf.length),
    };
    refPeak = PEAK_FLOOR;
    smoothed = { level: 0, bass: 0, mid: 0, treble: 0 };
    active = true;
  }

  function stop() {
    active = false;
    try { source && source.disconnect(); } catch { /* ignore */ }
    if (stream) for (const t of stream.getTracks()) { try { t.stop(); } catch { /* ignore */ } }
    stream = null; source = null; analyser = null;
    if (ctx) { ctx.suspend().catch(() => {}); }
    last.level = last.bass = last.mid = last.treble = last.raw = 0;
  }

  function bandAvg([a, b]) {
    let s = 0;
    for (let i = a; i < b; i++) s += freqBuf[i];
    return Math.min(1, (s / (b - a)) / BAND_LEVEL_MAX);
  }

  function getLevels() {
    if (!active || !analyser) return { level: 0, bass: 0, mid: 0, treble: 0, raw: 0 };
    analyser.getFloatTimeDomainData(timeBuf);
    let sum = 0;
    for (let i = 0; i < timeBuf.length; i++) sum += timeBuf[i] * timeBuf[i];
    const raw = Math.sqrt(sum / timeBuf.length);

    // Noise gate + soft AGC: normalise against a slowly decaying recent peak.
    let gated = raw < NOISE_GATE ? 0 : raw - NOISE_GATE;
    if (gated > PEAK_MIN_RISE && gated > refPeak) refPeak = refPeak + (gated - refPeak) * 0.5;
    refPeak = Math.max(PEAK_FLOOR, refPeak * PEAK_DECAY);
    let level = gated > 0 ? Math.pow(Math.min(1, gated / refPeak), 0.75) : 0;

    analyser.getByteFrequencyData(freqBuf);
    const targets = { level, bass: bandAvg(bands.bass), mid: bandAvg(bands.mid), treble: bandAvg(bands.treble) };
    for (const k of Object.keys(targets)) {
      const t = targets[k], c = smoothed[k];
      smoothed[k] = c + (t - c) * (t > c ? 0.5 : 0.12); // attack fast, release slow
    }
    last.raw = raw;
    last.level = Math.max(0, Math.min(1, smoothed.level));
    last.bass = Math.max(0, Math.min(1, smoothed.bass));
    last.mid = Math.max(0, Math.min(1, smoothed.mid));
    last.treble = Math.max(0, Math.min(1, smoothed.treble));
    return { ...last };
  }

  return { start, stop, isActive: () => active, getLevels };
}
