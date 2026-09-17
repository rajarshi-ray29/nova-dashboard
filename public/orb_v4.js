/**
 * NOVA orbital particle orb — a bright core, projected paths and sparse cyan particles.
 * Keeps the existing audio-reactive idle/listening/thinking/speaking interface.
 */

const TAU = Math.PI * 2;
const STATES = {
  idle:      { energy: 0.58, speed: 0.10, spread: 0.96, pulse: 0.018, core: 0.86 },
  listening: { energy: 0.90, speed: 0.23, spread: 1.00, pulse: 0.045, core: 0.98 },
  thinking:  { energy: 1.10, speed: 0.55, spread: 1.06, pulse: 0.075, core: 1.05 },
  speaking:  { energy: 1.02, speed: 0.34, spread: 1.03, pulse: 0.120, core: 1.10 },
};

const RING_PLANES = [
  { rx: 0.18, rz: -0.72, radius: 0.83, squash: 0.78 },
  { rx: 0.92, rz: 0.20, radius: 0.76, squash: 0.91 },
  { rx: -0.58, rz: 0.82, radius: 0.91, squash: 0.84 },
  { rx: 1.18, rz: -0.38, radius: 0.66, squash: 0.88 },
  { rx: -0.30, rz: -1.12, radius: 0.56, squash: 0.82 },
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mix = (a, b, t) => a + (b - a) * t;
const follow = (value, target, dt, speed) => mix(value, target, 1 - Math.exp(-dt * speed));

function seededRandom(seed = 0x4e4f5641) {
  let n = seed >>> 0;
  return () => {
    n += 0x6d2b79f5;
    let t = n;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rotatePoint(x, y, z, rx, rz, spin) {
  let c = Math.cos(rx), s = Math.sin(rx);
  let yy = y * c - z * s;
  let zz = y * s + z * c;
  y = yy; z = zz;
  c = Math.cos(rz); s = Math.sin(rz);
  const xx = x * c - y * s;
  yy = x * s + y * c;
  x = xx; y = yy;
  c = Math.cos(spin); s = Math.sin(spin);
  return { x: x * c + z * s, y, z: -x * s + z * c };
}

function project(point, radius) {
  const perspective = 1 + point.z * 0.16;
  return { x: point.x * radius * perspective, y: point.y * radius * perspective, z: point.z, perspective };
}

export function createOrb(canvas, { sensitivity = 1 } = {}) {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return { setAudio() {}, setState() {}, setSensitivity() {}, resize() {}, destroy() {} };

  const random = seededRandom();
  const particles = [];
  for (let i = 0; i < 430; i++) {
    particles.push({
      band: i % RING_PLANES.length,
      angle: random() * TAU,
      speed: 0.78 + random() * 0.52,
      radiusJitter: 0.92 + random() * 0.16,
      size: 0.42 + Math.pow(random(), 2) * 1.55,
      alpha: 0.22 + random() * 0.70,
      twinkle: random() * TAU,
    });
  }

  let stateName = 'idle';
  let sensitivityValue = clamp(Number(sensitivity) || 1, 0.1, 4);
  const audio = { level: 0, bass: 0, mid: 0, treble: 0 };
  const smoothAudio = { level: 0, bass: 0, mid: 0, treble: 0 };
  const motion = { energy: STATES.idle.energy, speed: STATES.idle.speed, spread: STATES.idle.spread, core: STATES.idle.core };
  let width = 1, height = 1, dpr = 1, spin = 0, last = 0;
  let destroyed = false, visible = !document.hidden, raf = 0;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    dpr = Math.min(window.devicePixelRatio || 1, 1.6);
    const nextW = Math.round(width * dpr), nextH = Math.round(height * dpr);
    if (canvas.width !== nextW || canvas.height !== nextH) {
      canvas.width = nextW;
      canvas.height = nextH;
    }
  }

  function ringPoint(plane, angle, spread) {
    const r = plane.radius * spread;
    return rotatePoint(Math.cos(angle) * r, Math.sin(angle) * r * plane.squash, 0, plane.rx, plane.rz, spin);
  }

  function drawOrbit(plane, radius, spread, alpha, offset) {
    ctx.beginPath();
    for (let i = 0; i <= 88; i++) {
      const point = project(ringPoint(plane, (i / 88) * TAU + offset, spread), radius);
      if (i === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    }
    ctx.strokeStyle = `rgba(34, 211, 238, ${alpha})`;
    ctx.lineWidth = Math.max(0.55, dpr * 0.55) / dpr;
    ctx.stroke();
  }

  function draw(now) {
    raf = 0;
    if (destroyed || !visible) return;
    resize();
    const t = now * 0.001;
    const dt = last ? Math.min(0.05, (now - last) * 0.001) : 1 / 60;
    last = now;
    const target = STATES[stateName] || STATES.idle;

    for (const key of Object.keys(smoothAudio)) {
      smoothAudio[key] = follow(smoothAudio[key], audio[key], dt, audio[key] > smoothAudio[key] ? 12 : 4);
    }
    const mic = clamp((smoothAudio.level * 0.66 + smoothAudio.bass * 0.24 + smoothAudio.treble * 0.10) * sensitivityValue, 0, 1.4);
    motion.energy = follow(motion.energy, target.energy + mic * 0.42, dt, 5.5);
    motion.speed = follow(motion.speed, target.speed + mic * 0.18, dt, 4.0);
    motion.spread = follow(motion.spread, target.spread + smoothAudio.bass * 0.055 * sensitivityValue, dt, 4.0);
    motion.core = follow(motion.core, target.core + mic * 0.12, dt, 6.0);
    spin += dt * motion.speed;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.globalCompositeOperation = 'lighter';

    const minSide = Math.min(width, height);
    const breathing = 1 + Math.sin(t * 1.15) * 0.012 + Math.sin(t * TAU * (target.pulse + 0.001)) * target.pulse;
    const radius = minSide * 0.42 * breathing;

    for (let i = 0; i < RING_PLANES.length; i++) {
      drawOrbit(RING_PLANES[i], radius, motion.spread, (i === 0 || i === 2 ? 0.16 : 0.075) * motion.energy, i * 0.37);
    }

    const projected = particles.map((particle) => {
      const plane = RING_PLANES[particle.band];
      const angle = particle.angle + spin * particle.speed * (particle.band % 2 ? -1 : 1);
      return { ...particle, ...project(ringPoint(plane, angle, motion.spread * particle.radiusJitter), radius) };
    }).sort((a, b) => a.z - b.z);

    for (const p of projected) {
      const front = clamp(0.56 + p.z * 0.36, 0.18, 1);
      const twinkle = 0.72 + 0.28 * Math.sin(t * (1.2 + p.speed) + p.twinkle);
      const alpha = clamp(p.alpha * front * twinkle * motion.energy, 0.06, 0.92);
      const size = p.size * (0.72 + p.perspective * 0.42) * (0.86 + smoothAudio.treble * sensitivityValue * 0.55);
      if (size > 1.15) {
        ctx.beginPath();
        ctx.fillStyle = `rgba(34, 211, 238, ${alpha * 0.12})`;
        ctx.arc(p.x, p.y, size * 3.2, 0, TAU);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.fillStyle = p.z > 0.28 ? `rgba(207, 250, 254, ${alpha})` : `rgba(34, 211, 238, ${alpha})`;
      ctx.arc(p.x, p.y, Math.max(0.45, size), 0, TAU);
      ctx.fill();
    }

    const coreRadius = radius * 0.31 * motion.core;
    let gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, coreRadius * 2.5);
    gradient.addColorStop(0, `rgba(255,255,255,${0.90 * motion.energy})`);
    gradient.addColorStop(0.13, `rgba(165,243,252,${0.88 * motion.energy})`);
    gradient.addColorStop(0.42, `rgba(34,211,238,${0.34 * motion.energy})`);
    gradient.addColorStop(1, 'rgba(8,145,178,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, coreRadius * 2.5, 0, TAU);
    ctx.fill();

    gradient = ctx.createRadialGradient(-coreRadius * 0.08, -coreRadius * 0.12, 0, 0, 0, coreRadius);
    gradient.addColorStop(0, 'rgba(255,255,255,0.98)');
    gradient.addColorStop(0.28, 'rgba(207,250,254,0.94)');
    gradient.addColorStop(0.62, 'rgba(34,211,238,0.68)');
    gradient.addColorStop(1, 'rgba(8,145,178,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, coreRadius, 0, TAU);
    ctx.fill();

    ctx.restore();
    raf = requestAnimationFrame(draw);
  }

  function start() {
    if (!raf && !destroyed && visible) raf = requestAnimationFrame(draw);
  }

  function onVisibilityChange() {
    visible = !document.hidden;
    if (visible) { last = 0; start(); }
    else if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  observer?.observe(canvas);
  document.addEventListener('visibilitychange', onVisibilityChange);
  resize();
  start();

  return {
    setAudio(values = {}) {
      for (const key of Object.keys(audio)) audio[key] = clamp(Number(values[key]) || 0, 0, 1);
    },
    setState(next) { if (STATES[next]) stateName = next; },
    setSensitivity(next) { sensitivityValue = clamp(Number(next) || 1, 0.1, 4); },
    resize,
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      observer?.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}

export default createOrb;
