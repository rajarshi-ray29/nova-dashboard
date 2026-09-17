// orb_v1.js — NOVA plasma orb, variant 1: RAY-MARCHED EMISSIVE VOLUME.
//
// A view ray is intersected with a sphere and marched front-to-back through it, accumulating
// emissive plasma density from a domain-warped 3-octave 3D value-noise field. Thin bright
// filaments are the intersection curves of two ridged (1-|n|)^k fields, the core is a white-cyan
// Gaussian, and front samples absorb light from samples behind them, which is where the depth
// comes from. A fresnel rim (deep blue) and a radial halo outside the silhouette finish the look.
//
// Interface (SPEC §7):
//   createOrb(canvas, { sensitivity = 1 })
//     → { setAudio({level,bass,mid,treble}), setState(state), setSensitivity(n), resize(), destroy() }
//
// Everything that reaches the shader is smoothed here (attack fast / release slow), and every
// animation is time-based: rotation phases are integrated with dt so speed changes never jump.

const VERT_SRC = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG_SRC = `
#define STEPS  28        // march samples per ray (3 noise evaluations each; only fragments inside the disc march)
#define R0     0.62      // sphere radius as a fraction of the canvas half-size (halo needs the rest)
#define FREQ   2.6       // base noise frequency across the unit ball
#define ABSORB 3.0       // extinction per unit filament density (higher = more occlusion / depth)
#define FIL_GAIN 7.0     // filament emission per unit density
#define CORE_GAIN 3.5    // core emission per unit density

uniform vec2 u_res;      // drawing-buffer size in pixels
uniform mat3 u_rotA;     // rigid rotation of the whole noise domain (slow drift)
uniform mat3 u_rotB;     // extra rotation of the fine octaves only (inner swirl)
uniform vec3 u_off;      // bounded Lissajous drift of the warp field (never grows, so hashes stay precise)
uniform vec4 u_p1;       // x core brightness, y core size, z filament gain, w 1/filament width
uniform vec4 u_p2;       // x radius scale (breathing), y halo gain, z rim gain, w edge softness (0..1)
uniform vec4 u_p3;       // x cool colour shift, y sparkle (treble), z glass alpha, w spiral twist (rad)
uniform vec4 u_p4;       // x domain-warp amount, y exposure, z radial stretch, w ambient fill

const vec3 C_BLUE = vec3(0.10, 0.36, 1.00);   // electric blue (filament edges)
const vec3 C_CYAN = vec3(0.62, 0.93, 1.00);   // cyan-white   (filament centres)
const vec3 C_CORE = vec3(0.88, 0.98, 1.00);   // core, tonemaps to white
const vec3 C_RIM  = vec3(0.05, 0.20, 1.00);   // deep saturated blue rim
const vec3 C_HALO = vec3(0.12, 0.40, 1.00);   // halo
const vec3 C_COOL = vec3(0.35, 0.90, 1.00);   // 'thinking' tint
const vec3 TWIST_AXIS = vec3(0.30, 0.45, 0.84); // unit-length; tilted so the spiral reads in projection

// ---- hashing / noise ----------------------------------------------------------------------
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
// 3D value noise, quintic interpolation, output in [-1,1]. The vec3 flavour returns three
// independent channels for the price of one lattice walk (used as value + warp vector).
vec3 vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec3 x0 = mix(hash33(i),                    hash33(i + vec3(1.0, 0.0, 0.0)), u.x);
  vec3 x1 = mix(hash33(i + vec3(0.0, 1.0, 0.0)), hash33(i + vec3(1.0, 1.0, 0.0)), u.x);
  vec3 x2 = mix(hash33(i + vec3(0.0, 0.0, 1.0)), hash33(i + vec3(1.0, 0.0, 1.0)), u.x);
  vec3 x3 = mix(hash33(i + vec3(0.0, 1.0, 1.0)), hash33(i + vec3(1.0, 1.0, 1.0)), u.x);
  return mix(mix(x0, x1, u.y), mix(x2, x3, u.y), u.z) * 2.0 - 1.0;
}
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float x0 = mix(hash13(i),                    hash13(i + vec3(1.0, 0.0, 0.0)), u.x);
  float x1 = mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), u.x);
  float x2 = mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), u.x);
  float x3 = mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), u.x);
  return mix(mix(x0, x1, u.y), mix(x2, x3, u.y), u.z) * 2.0 - 1.0;
}
// interleaved gradient noise: per-pixel jitter for the march start and output dithering
float ign(vec2 p) { return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y)); }

// ---- plasma field ---------------------------------------------------------------------------
// p: point in unit-ball coordinates, r = |p|. Returns (filament density, filament 'heat' 0..1).
vec2 plasma(vec3 p, float r) {
  // static spiral twist about a tilted axis (mostly the view axis, so the wrap is visible in projection),
  // strongest at the core: radial tendrils become spirals that hug the inside of the sphere
  float ang = u_p3.w * (1.0 - r) * (1.0 - r);
  float c = cos(ang), s = sin(ang);
  vec3 ax = TWIST_AXIS;
  vec3 q = p * c + cross(ax, p) * s + ax * dot(ax, p) * (1.0 - c);
  q = u_rotA * q;
  // radial stretch: the field becomes mostly a function of direction, so filaments shoot outward
  // from the core like plasma-globe tendrils (u_p4.z: 1 = no stretch, ~0.25 = strong)
  vec3 pn = q * (FREQ / (u_p4.z + (1.0 - u_p4.z) * r));
  vec3 n1 = vnoise3(pn + u_off);                                // octave 1 (three channels)
  vec3 pw = u_rotB * (pn * 2.05) + n1 * u_p4.x;                 // warped, independently drifting fine domain
  float n2 = vnoise(pw);                                        // octave 2
  float n3 = vnoise(pw * 2.15 + n1.zxy * (0.6 * u_p4.x));       // octave 3
  float nA = n1.x * 0.60 + n2 * 0.30 + n3 * (0.10 + 0.18 * u_p3.y);
  float nB = n1.y * 0.70 + n2 * 0.18 + n3 * 0.12;
  // ridged transform: (1-|n|·k)^3 makes a thin bright band on each zero-surface; the product of two
  // independent bands is the intersection curve → true 3D filaments instead of sheets
  float ra = max(1.0 - abs(nA) * u_p1.w, 0.0); ra = ra * ra;
  float rb = max(1.0 - abs(nB) * u_p1.w * 0.7, 0.0); rb = rb * rb;
  float hot = ra * rb;
  return vec2(hot + ra * 0.06, hot);                     // filaments + faint wisps
}

void main() {
  float side = min(u_res.x, u_res.y);
  vec2 uv = (gl_FragCoord.xy * 2.0 - u_res) / side;             // -1..1 on the short axis
  float px = 2.0 / side;                                        // one pixel in uv units
  float R = R0 * u_p2.x;
  float l = length(uv);
  float d = l - R;                                              // signed distance to the silhouette

  // silhouette mask, anti-aliased; 'speaking' feathers the edge
  float feather = px * 1.5 + u_p2.w * 0.05;
  float mask = 1.0 - smoothstep(-feather, feather, d);

  // ---- halo: soft radial falloff outside the sphere, windowed so it dies before the canvas edge
  float dh = max(d, 0.0);
  float halo = (exp(-dh * 9.0) * 0.50 + exp(-dh * 3.2) * 0.20) * (1.0 - smoothstep(0.0, 0.37, dh));
  vec3 haloCol = mix(C_HALO, vec3(0.30, 0.75, 1.00), clamp((u_p2.y - 0.6) * 0.8 + u_p3.x * 0.4, 0.0, 0.7));
  vec3 col = haloCol * halo * u_p2.y * (1.0 - mask);

  if (mask > 0.001) {
    // ---- ray / sphere: orthographic view along +z, chord from -h to +h
    float h = sqrt(max(R * R - l * l, 0.0));
    float ds = 2.0 * h / float(STEPS);                          // step in screen units
    float dsu = ds / R;                                         // step in unit-ball units
    float z = -h + ds * ign(gl_FragCoord.xy);                   // jittered start hides step banding
    float T = 1.0;                                              // transmittance (front-to-back)
    vec3 acc = vec3(0.0);
    for (int i = 0; i < STEPS; i++) {
      vec3 p = vec3(uv, z) / R;
      float r = length(p);
      vec2 pl = plasma(p, r);
      float shell  = 1.0 - smoothstep(0.78, 1.0, r);            // filaments die at the glass
      float radial = 0.45 + 1.10 * exp(-r * r * 3.5);           // denser near the core
      float fadeIn = smoothstep(0.0, 0.2, r);                   // let the core own the centre
      float fil  = u_p1.z * pl.x * shell * radial * fadeIn;
      float core = u_p1.x * exp(-r * r / (u_p1.y * u_p1.y));
      vec3 fcol = mix(C_BLUE, C_CYAN, min(pl.y * pl.y * 2.2, 1.0));   // hot cores go cyan-white
      fcol = mix(fcol, C_COOL, u_p3.x * 0.7);                        // thinking: cooler filaments
      vec3 ccol = mix(C_CORE, vec3(0.62, 0.95, 1.00), u_p3.x * 0.5); // thinking: cyan-shifted core
      vec3 e = fcol * (fil * FIL_GAIN) + ccol * (core * CORE_GAIN);
      float dens = fil * ABSORB + core * 0.8;
      acc += T * e * dsu;
      T *= exp(-dens * dsu);
      z += ds;
    }
    // ---- glass shell: fresnel rim (deep blue), faint scatter fill, thin edge ring
    float ndv = h / R;                                          // cos(view, normal) at the entry point
    float fres = pow(1.0 - ndv, 3.0);
    vec3 rim = C_RIM * fres * u_p2.z * 0.9;
    vec3 amb = vec3(0.02, 0.06, 0.16) * u_p4.w * ndv;               // faint scatter so the glass is not pure black
    float ring = exp(-abs(d) / (px * 4.0)) * 0.05 * u_p2.z * (1.0 - 0.8 * u_p2.w);
    col += (acc + rim + amb) * mask + vec3(0.30, 0.70, 1.00) * ring;
  }

  // ---- tonemap + premultiplied alpha: emissive layer over a translucent dark-blue glass disc
  col = 1.0 - exp(-col * u_p4.y);
  float ea = max(col.r, max(col.g, col.b));
  float gA = u_p3.z * mask;
  vec3 G = vec3(0.015, 0.045, 0.11) * gA;
  vec3 rgb = col + (1.0 - ea) * G;
  float a = ea + (1.0 - ea) * gA;
  rgb += (ign(gl_FragCoord.xy + 17.0) - 0.5) / 255.0;           // dither kills 8-bit banding
  rgb = clamp(rgb, 0.0, 1.0);
  gl_FragColor = vec4(min(rgb, vec3(a)), a);
}
`;

// ---- state presets -------------------------------------------------------------------------
// drift: whole-domain rotation rate (rad/s); swirl: fine-octave rotation rate (rad/s)
const PRESETS = {
  idle:      { drift: 0.16, swirl: 0.10, core: 0.65, coreSize: 0.20, fil: 0.80, width: 0.20, halo: 0.55, rim: 0.75, radius: 1.00, edge: 0.0, cool: 0.00, twist: 2.0, warp: 0.70, stretch: 0.50, exposure: 1.10, glass: 0.55, ambient: 0.9 },
  listening: { drift: 0.28, swirl: 0.22, core: 0.85, coreSize: 0.22, fil: 1.00, width: 0.19, halo: 0.75, rim: 0.85, radius: 1.00, edge: 0.0, cool: 0.10, twist: 2.2, warp: 0.75, stretch: 0.50, exposure: 1.15, glass: 0.55, ambient: 1.0 },
  thinking:  { drift: 0.32, swirl: 0.95, core: 1.05, coreSize: 0.19, fil: 1.05, width: 0.17, halo: 0.70, rim: 0.85, radius: 1.00, edge: 0.0, cool: 0.90, twist: 2.8, warp: 0.85, stretch: 0.45, exposure: 1.15, glass: 0.55, ambient: 1.0 },
  speaking:  { drift: 0.30, swirl: 0.35, core: 1.00, coreSize: 0.23, fil: 0.95, width: 0.20, halo: 0.80, rim: 0.55, radius: 1.00, edge: 1.0, cool: 0.15, twist: 2.2, warp: 0.75, stretch: 0.50, exposure: 1.15, glass: 0.50, ambient: 1.0 },
};
const STATES = Object.keys(PRESETS);
const PARAM_KEYS = Object.keys(PRESETS.idle);

// exponential approach with separate attack/release time constants (seconds)
function approach(cur, target, dt, tauUp, tauDown) {
  const tau = target > cur ? tauUp : tauDown;
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}
const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

// column-major 3x3 rotation about a unit axis (Rodrigues)
function axisAngle(out, ax, ay, az, angle) {
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  out[0] = t * ax * ax + c;      out[1] = t * ax * ay + s * az; out[2] = t * ax * az - s * ay;
  out[3] = t * ax * ay - s * az; out[4] = t * ay * ay + c;      out[5] = t * ay * az + s * ax;
  out[6] = t * ax * az + s * ay; out[7] = t * ay * az - s * ax; out[8] = t * az * az + c;
  return out;
}
function unit(x, y, z) { const n = Math.hypot(x, y, z); return [x / n, y / n, z / n]; }
const AXIS_A = unit(0.18, 1.0, 0.12);   // drift axis: mostly vertical, like a globe
const AXIS_B = unit(1.0, 0.35, 0.55);   // swirl axis: tilted so the fine layer slides over the coarse one

export function createOrb(canvas, { sensitivity = 1 } = {}) {
  const attrs = {
    alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
    preserveDrawingBuffer: false, powerPreference: 'high-performance',
  };
  let gl = canvas.getContext('webgl2', attrs);
  const isGL2 = !!gl;
  if (!gl) gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);

  // ---- smoothed inputs -------------------------------------------------------------------------
  let sens = Number.isFinite(sensitivity) ? Math.max(0, sensitivity) : 1;
  const rawAudio = { level: 0, bass: 0, mid: 0, treble: 0 };
  const audio = { level: 0, bass: 0, mid: 0, treble: 0 };
  const target = { idle: 1, listening: 0, thinking: 0, speaking: 0 };
  const weight = { idle: 1, listening: 0, thinking: 0, speaking: 0 };
  const P = {};                                  // blended look parameters for this frame
  let phaseA = 0.7, phaseB = 2.1, phaseO = 0;    // integrated rotation / drift phases
  let clock = 0;                                 // seconds of visible run time (for pulses)
  let last = 0, raf = 0, running = false, destroyed = false;
  const rotA = new Float32Array(9), rotB = new Float32Array(9);

  function step(now) {
    const dt = last ? Math.min(0.05, Math.max(0, (now - last) / 1000)) : 1 / 60;
    last = now;
    clock += dt;

    // state vector: equal time constants keep the weights summing to 1 through a transition
    let sum = 0;
    for (const s of STATES) { weight[s] = approach(weight[s], target[s], dt, 0.35, 0.35); sum += weight[s]; }
    for (const s of STATES) weight[s] /= sum || 1;

    // audio: attack fast, release slow; sensitivity scales the influence
    audio.level  = approach(audio.level,  clamp01(rawAudio.level  * sens), dt, 0.045, 0.22);
    audio.bass   = approach(audio.bass,   clamp01(rawAudio.bass   * sens), dt, 0.060, 0.30);
    audio.mid    = approach(audio.mid,    clamp01(rawAudio.mid    * sens), dt, 0.045, 0.22);
    audio.treble = approach(audio.treble, clamp01(rawAudio.treble * sens), dt, 0.030, 0.15);

    // blend presets by state weight
    for (const k of PARAM_KEYS) { let v = 0; for (const s of STATES) v += PRESETS[s][k] * weight[s]; P[k] = v; }

    // audio modulation (idle reacts at half strength so a stray signal never makes it look 'on')
    const gain = 1 - 0.5 * weight.idle;
    const lv = audio.level * gain, bs = audio.bass * gain, md = audio.mid * gain, tr = audio.treble * gain;
    P.core     += 1.6 * lv;
    P.coreSize += 0.07 * lv;
    P.fil      += 0.9 * lv;
    P.width     = Math.max(0.10, P.width - 0.04 * lv);
    P.radius   += 0.075 * bs + 0.02 * lv;
    P.halo     += 0.55 * lv;
    P.rim      += 0.20 * lv;
    P.drift    += 0.9 * lv;
    P.swirl    += 0.7 * lv + 0.4 * md;
    P.exposure += 0.15 * lv;
    P.sparkle   = Math.min(1, 1.2 * tr);

    // synthetic rhythms: speaking pulses ~2.4 Hz, thinking breathes ~0.8 Hz, idle barely moves
    const t = clock;
    const pSpk = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 2.4);
    const pThk = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 0.8);
    const pIdl = 0.5 + 0.5 * Math.sin(t * 0.7);
    P.core   *= 1 + 0.55 * weight.speaking * pSpk + 0.30 * weight.thinking * pThk + 0.10 * weight.idle * pIdl;
    P.radius += 0.035 * weight.speaking * pSpk + 0.015 * weight.thinking * pThk + 0.008 * weight.idle * pIdl;
    P.halo   += 0.25 * weight.speaking * pSpk + 0.10 * weight.thinking * pThk;

    // integrate motion phases (rad); rotations are periodic so nothing ever grows unbounded
    phaseA = (phaseA + dt * P.drift) % (Math.PI * 2);
    phaseB = (phaseB + dt * P.swirl) % (Math.PI * 2);
    phaseO += dt * P.drift * 1.35;
  }

  // ---- GL setup ---------------------------------------------------------------------------------
  let prog = null, U = null;
  if (gl) {
    const vs = compile(gl, gl.VERTEX_SHADER,
      isGL2 ? '#version 300 es\n#define attribute in\n#define varying out\n' + VERT_SRC : VERT_SRC);
    const fs = compile(gl, gl.FRAGMENT_SHADER,
      isGL2
        ? '#version 300 es\nprecision highp float;\nout vec4 fragColor;\n#define gl_FragColor fragColor\n' + FRAG_SRC
        : '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n' + FRAG_SRC);
    if (vs && fs) {
      prog = gl.createProgram();
      gl.attachShader(prog, vs); gl.attachShader(prog, fs);
      gl.bindAttribLocation(prog, 0, 'a_pos');
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error('[orb] link failed:', gl.getProgramInfoLog(prog));
        prog = null;
      }
    }
    if (prog) {
      gl.useProgram(prog);
      U = {};
      for (const n of ['u_res', 'u_rotA', 'u_rotB', 'u_off', 'u_p1', 'u_p2', 'u_p3', 'u_p4']) U[n] = gl.getUniformLocation(prog, n);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);  // one big triangle
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
      gl.clearColor(0, 0, 0, 0);
    }
  }
  const ctx2d = (!gl || !prog) ? canvas.getContext('2d') : null;   // last-resort fallback

  function draw() {
    if (prog) {
      gl.uniform2f(U.u_res, canvas.width, canvas.height);
      gl.uniformMatrix3fv(U.u_rotA, false, axisAngle(rotA, AXIS_A[0], AXIS_A[1], AXIS_A[2], phaseA));
      gl.uniformMatrix3fv(U.u_rotB, false, axisAngle(rotB, AXIS_B[0], AXIS_B[1], AXIS_B[2], phaseB));
      gl.uniform3f(U.u_off, 0.45 * Math.sin(phaseO * 0.71), 0.45 * Math.sin(phaseO * 0.53 + 1.7), 0.45 * Math.sin(phaseO * 0.62 + 3.1));
      gl.uniform4f(U.u_p1, P.core, P.coreSize, P.fil, 1 / P.width);
      gl.uniform4f(U.u_p2, P.radius, P.halo, P.rim, P.edge);
      gl.uniform4f(U.u_p3, P.cool, P.sparkle, P.glass, P.twist);
      gl.uniform4f(U.u_p4, P.warp, P.exposure, P.stretch, P.ambient);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else if (ctx2d) {
      // no WebGL: a breathing radial glow so the dashboard never shows a hole
      const w = canvas.width, h = canvas.height, r = Math.min(w, h) * 0.5 * 0.62 * P.radius;
      ctx2d.clearRect(0, 0, w, h);
      const g = ctx2d.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, r * 1.5);
      g.addColorStop(0, `rgba(220,245,255,${Math.min(1, 0.55 * P.core)})`);
      g.addColorStop(0.35, 'rgba(60,140,255,0.55)');
      g.addColorStop(0.66, 'rgba(20,60,200,0.35)');
      g.addColorStop(1, 'rgba(10,40,160,0)');
      ctx2d.fillStyle = g;
      ctx2d.fillRect(0, 0, w, h);
    }
  }

  // ---- sizing -----------------------------------------------------------------------------------
  function resize() {
    if (destroyed) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = canvas.clientWidth || canvas.width || 360;
    const ch = canvas.clientHeight || canvas.height || cw;
    const w = Math.max(1, Math.round(cw * dpr)), h = Math.max(1, Math.round(ch * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      if (gl) gl.viewport(0, 0, w, h);
    }
  }
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(resize); ro.observe(canvas); }
  else window.addEventListener('resize', resize);
  resize();

  // ---- loop: paused while the tab is hidden --------------------------------------------------------
  function frame(now) {
    raf = 0;
    if (!running || destroyed) return;
    step(now);
    draw();
    raf = requestAnimationFrame(frame);
  }
  function start() { if (!running && !destroyed) { running = true; last = 0; raf = requestAnimationFrame(frame); } }
  function stop() { running = false; if (raf) { cancelAnimationFrame(raf); raf = 0; } }
  function onVisibility() { if (document.hidden) stop(); else start(); }
  document.addEventListener('visibilitychange', onVisibility);
  if (!document.hidden) start();

  return {
    setAudio(a) {
      if (!a) return;
      rawAudio.level  = clamp01(a.level);
      rawAudio.bass   = clamp01(a.bass);
      rawAudio.mid    = clamp01(a.mid);
      rawAudio.treble = clamp01(a.treble);
    },
    setState(state) {
      const s = STATES.includes(state) ? state : 'idle';
      for (const k of STATES) target[k] = k === s ? 1 : 0;
    },
    setSensitivity(n) { if (Number.isFinite(n)) sens = Math.max(0, n); },
    resize,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
      if (gl) { const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); }
    },
  };
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('[orb] shader compile failed:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}
