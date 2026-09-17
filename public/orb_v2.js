/*
 * NOVA plasma orb — variant v2: "layered surface shells".
 *
 * Interface (SPEC §7):
 *   createOrb(canvas, { sensitivity = 1 })
 *     → { setAudio({ level, bass, mid, treble }), setState(state), setSensitivity(n), resize(), destroy() }
 *   state ∈ 'idle' | 'listening' | 'thinking' | 'speaking'; audio values 0..1.
 *
 * Rendering (one full-screen triangle, everything analytic in the fragment shader — no marching):
 *   - A sphere of screen radius uRadius. For every pixel inside it we reconstruct 3-D points on four
 *     concentric shells (0.35 / 0.60 / 0.85 / 1.00 of the sphere radius): z = sqrt(s² − x² − y²).
 *   - Each shell rotates around its own axis at its own speed and samples a 3-octave simplex fbm.
 *     Ridged noise (1 − |fbm|) thresholded near 1 gives the ZERO-SET of the field: a thin curve on the
 *     shell → an electric filament. Front and back hemispheres are both sampled (back = dim, bluer)
 *     so filaments visibly wrap around and the sphere reads as a volume.
 *   - Inner shells are whiter/brighter, outer shells bluer/dimmer. Everything is composited additively
 *     over a dark glass body with a fresnel rim, a white→cyan radial core and a soft outer halo.
 *   - Noise budget: 4 shells × 2 hemispheres × 3 octaves + 1 (core flicker) = 25 simplex evaluations
 *     per fragment (spec budget ≤ 48).
 *
 * Motion: every input is smoothed here (exponential, attack fast / release slow) and rotation, flow and
 * pulse phases are integrated from wall-clock dt, so speed changes glide instead of jumping and nothing
 * jitters. The rAF loop pauses while the tab is hidden.
 */

const STATES = ['idle', 'listening', 'thinking', 'speaking'];
const TAU = Math.PI * 2;
const BASE_RADIUS = 0.66;      // sphere radius as a fraction of the canvas half-size (halo fills the rest)

// ---------------------------------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------------------------------

const VERT = (gl2) => `${gl2 ? '#version 300 es\nin' : 'attribute'} vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG_HEADER = (gl2) => gl2
  ? `#version 300 es
precision highp float;
out vec4 FRAG_OUT;
`
  : `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
#define FRAG_OUT gl_FragColor
`;

const FRAG_BODY = `
uniform vec2  uRes;     // drawing-buffer size in device pixels
uniform float uTime;    // "flow" time (s) — integrated in JS at a state-dependent speed; morphs the filaments
uniform float uRot;     // shell rotation phase (rad) — integrated in JS; faster while listening/thinking
uniform float uRadius;  // sphere radius, fraction of the canvas half-size (breathes with bass / pulses)
uniform float uCore;    // core brightness multiplier (idle ≈ 0.5 → loud ≈ 1.6)
uniform float uFil;     // filament brightness multiplier
uniform float uSpark;   // 0..1 treble sparkle: bright beads along the filaments
uniform float uCool;    // 0..1 shift toward cooler cyan/white (thinking)
uniform float uSoft;    // 0..1 softened rim/edge (speaking)
uniform float uHalo;    // outer halo strength

// ---------- 3-D simplex noise (Ashima Arts / Stefan Gustavson, MIT) ----------
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g  = step(x0.yzx, x0.xyz);
  vec3 l  = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j  = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x  = x_ * ns.x + ns.yyyy;
  vec4 y  = y_ * ns.x + ns.yyyy;
  vec4 h  = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// ---------- helpers ----------
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0,  0.0, c, -s,  0.0, s, c); }
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, s,  0.0, 1.0, 0.0,  -s, 0.0, c); }
mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, -s, 0.0,  s, c, 0.0,  0.0, 0.0, 1.0); }
float hash21(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

// 3-octave fbm in [-1,1]. Octave weights fall off fast (0.35 / 0.12) so the zero-set curves stay long and
// flowing instead of crinkly. 'mid'/'hi' return the 2nd/3rd octaves, used to vary brightness along a filament.
float fbm3(vec3 p, out float mid, out float hi) {
  float n0 = snoise(p);
  float n1 = snoise(p * 2.07 + vec3(3.1, -1.7, 2.3));
  float n2 = snoise(p * 4.19 + vec3(-2.2, 5.1, -3.7));
  mid = n1; hi = n2;
  return (n0 + 0.35 * n1 + 0.12 * n2) * (1.0 / 1.47);
}

// Shell-frame sample point → noise domain: a latitude-dependent twist around the shell's pole plus a
// stretch along the pole turns the isotropic "cell net" of a zero-set into long spiralling wisps.
vec3 warp(vec3 P, float freq, float twist, float stretch, vec3 drift) {
  float a = P.y * twist;
  float c = cos(a), s = sin(a);
  P.xz = mat2(c, -s, s, c) * P.xz;
  return P * vec3(freq, freq * stretch, freq) + drift;
}

// One concentric shell. Returns rgb (premultiplied light) + the raw front field in .a (for the inner wash).
//   q      pixel position in sphere units (|q| < 1 inside the sphere)    r2     dot(q, q)
//   s      shell radius (fraction of the sphere)                         freq   noise frequency on the shell
//   R      shell rotation (own axis + integrated phase)                  drift  slow domain translation (morphing)
//   twist  rad of swirl per unit latitude   stretch  <1 elongates wisps along the pole
//   w      filament half-width in noise units (smaller = thinner)        cF/cB  front / back filament colour
//   gain   brightness multiplier (inner shells > outer shells)
vec4 shell(vec2 q, float r2, float s, float freq, mat3 R, vec3 drift, float twist, float stretch,
           float w, vec3 cF, vec3 cB, float gain) {
  float s2 = s * s;
  if (r2 >= s2) return vec4(0.0);
  float z = sqrt(s2 - r2);
  float facing = z / s;                                  // 1 at the shell centre → 0 at its limb
  float wf = w * (1.0 + 2.2 * (1.0 - facing));           // widen toward the limb: keeps on-screen thickness ~constant (no aliasing)

  // front hemisphere — ridged noise: ridge = 1 - |fbm|, filament where ridge ≈ 1 (|fbm| < w)
  float mid, hi;
  float n = fbm3(warp(R * vec3(q, z), freq, twist, stretch, drift), mid, hi);
  float d = abs(n);
  float line = smoothstep(wf, 0.0, d); line *= line;     // crisp filament
  float hot  = smoothstep(wf * 0.45, 0.0, d);            // white-hot centre line
  float glow = 0.24 * exp(-d / (4.0 * wf));              // soft bloom hugging the filament
  float fade = 0.25 + 0.75 * smoothstep(-0.9, 0.9, mid); // tendrils fade in/out along their length (arcs, not wires)
  float spark = uSpark * 1.4 * exp(-d / wf) * exp(-abs(hi) * 10.0);   // treble: bright beads where the fine octave also crosses zero
  // fade toward the limb for depth, and to ZERO over the outer ~10% of the shell's disc: the projection
  // compresses the noise radially there (dz/dr → ∞), which would turn filaments into concentric rings
  float limb = smoothstep(0.03, 0.5, facing);
  float depth = mix(0.30, 1.0, facing) * limb;
  float hotAmt = 0.55 * clamp(uFil - 0.35, 0.0, 1.0);    // white-hot centre only when energised (idle stays blue)
  vec3 front = ((line * fade) * cF + hot * fade * hotAmt + glow * cF) * depth + spark * cF;

  // back hemisphere, seen through the glass: dimmer, wider, bluer → depth
  float midb, hib;
  float nb = fbm3(warp(R * vec3(q, -z), freq, twist, stretch, drift), midb, hib);
  float db = abs(nb);
  float wb = wf * 1.7;
  float fadeb = 0.25 + 0.75 * smoothstep(-0.9, 0.9, midb);
  float back = (0.40 * smoothstep(wb, 0.0, db) * fadeb + 0.14 * exp(-db / (4.0 * wb)))
             * mix(0.10, 0.45, facing) * limb;

  return vec4(gain * (front + back * cB), n);
}

void main() {
  // screen → sphere units: q = 1 on the sphere surface
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / (0.5 * min(uRes.x, uRes.y));
  vec2 q = p / uRadius;
  float r2 = dot(q, q);
  float r  = sqrt(r2);
  if (r > 1.6) { FRAG_OUT = vec4(0.0); return; }        // beyond the halo: fully transparent
  float px = 2.0 / (min(uRes.x, uRes.y) * uRadius);      // sphere units per device pixel

  // ---- glass body, fresnel rim, faint specular ------------------------------------------------
  float aa = mix(1.5 * px, 0.07, uSoft);                 // edge softness: 1.5 px normally, wide while speaking
  float inside = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
  float zs = sqrt(max(0.0, 1.0 - r2));                   // outer-sphere depth (1 centre → 0 rim)
  float fres = pow(1.0 - zs, 3.0);
  vec3 body = mix(vec3(0.015, 0.06, 0.20), vec3(0.03, 0.16, 0.42), zs * zs);   // darker blue toward the edge
  vec3 rimCol = vec3(0.10, 0.36, 1.0);                   // deeper saturated blue rim
  vec3 col = inside * (body + rimCol * fres * (1.0 - 0.4 * uSoft));
  vec3 N = vec3(q, zs);
  vec3 L = normalize(vec3(-0.45, 0.62, 0.64));
  col += inside * vec3(0.55, 0.8, 1.0) * pow(max(dot(N, L), 0.0), 60.0) * 0.16;

  // ---- four rotating shells ------------------------------------------------------------------
  // Each: rotation = own tilt ∘ spin(uRot × speed); drift moves the noise domain slowly so filaments morph.
  mat3 R0 = rotY( uRot * 1.00 + 0.3) * rotX( 0.55);
  mat3 R1 = rotX(-uRot * 0.72 + 1.1) * rotZ( 0.80);
  mat3 R2 = rotZ( uRot * 0.55 + 2.0) * rotY(-0.70);
  mat3 R3 = rotY(-uRot * 0.42 + 0.7) * rotX(-1.00);
  vec3 d0 = vec3( uTime * 0.16, -uTime * 0.09,  uTime * 0.12);
  vec3 d1 = vec3(-uTime * 0.11,  uTime * 0.14, -uTime * 0.08) + 7.0;
  vec3 d2 = vec3( uTime * 0.09,  uTime * 0.07,  uTime * 0.13) + 13.0;
  vec3 d3 = vec3(-uTime * 0.07, -uTime * 0.10,  uTime * 0.06) + 23.0;
  float fil = uFil;
  //                 radius freq  rot drift twist stretch width  front colour                back colour               gain
  vec4 s0 = shell(q, r2, 0.35, 2.4, R0, d0, 4.0, 0.55, 0.130, vec3(0.94, 0.98, 1.00), vec3(0.55, 0.85, 1.00), 1.50 * fil);
  vec4 s1 = shell(q, r2, 0.60, 1.8, R1, d1, 2.8, 0.50, 0.110, vec3(0.66, 0.90, 1.00), vec3(0.35, 0.68, 1.00), 1.15 * fil);
  vec4 s2 = shell(q, r2, 0.85, 1.5, R2, d2, 2.2, 0.45, 0.095, vec3(0.40, 0.74, 1.00), vec3(0.22, 0.50, 1.00), 0.90 * fil);
  vec4 s3 = shell(q, r2, 1.00, 1.3, R3, d3, 1.8, 0.45, 0.085, vec3(0.26, 0.58, 1.00), vec3(0.12, 0.36, 0.95), 0.70 * fil);
  col += s0.rgb + s1.rgb + s2.rgb + s3.rgb;
  // low-frequency plasma wash inside the sphere (re-uses the outer shells' fields — no extra noise)
  float wash = smoothstep(-0.8, 0.8, s3.a) * 0.5 + smoothstep(-0.8, 0.8, s2.a) * 0.5;
  col += inside * wash * vec3(0.04, 0.16, 0.45) * (0.15 + 0.35 * fil) * (1.0 - fres);

  // ---- core: white centre → cyan, with a slow flicker -----------------------------------------
  float flick = 0.92 + 0.08 * snoise(vec3(q * 2.5, uTime * 0.45));
  float core = uCore * flick * (1.6 * exp(-r2 * 11.0) + 0.42 * exp(-r2 * 3.5));
  vec3 coreCol = mix(vec3(0.30, 0.76, 1.0), vec3(1.0), clamp(core * 0.55, 0.0, 1.0));
  col += core * coreCol * (inside + 0.12);

  // thinking: cooler / slightly desaturated toward cyan-white
  float lum = dot(col, vec3(0.25, 0.5, 0.25));
  col = mix(col, vec3(lum) * vec3(0.72, 0.96, 1.0) + col * 0.15, uCool * 0.35);

  // ---- halo outside the sphere ---------------------------------------------------------------
  float hr = max(0.0, r - 1.0);
  float halo = uHalo * (0.55 * exp(-hr * 5.5) + 0.16 * exp(-hr * 1.9)) * smoothstep(1.55, 1.05, r);
  col += halo * vec3(0.12, 0.42, 1.0) * (1.0 - inside * 0.85);

  // ---- tonemap, dither (kills banding), premultiplied alpha -----------------------------------
  col = 1.0 - exp(-max(col, 0.0));
  col += (hash21(gl_FragCoord.xy) - 0.5) * (1.0 / 255.0);
  col = clamp(col, 0.0, 1.0);
  float a = max(max(col.r, col.g), col.b);
  a = clamp(max(a, inside * 0.92), 0.0, 1.0);            // the glass body is nearly opaque
  FRAG_OUT = vec4(col, a);
}
`;

// ---------------------------------------------------------------------------------------------------
// JS side
// ---------------------------------------------------------------------------------------------------

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Time-based exponential smoothing: attack (rising) and release (falling) time constants in seconds.
function smooth(cur, target, dt, tauAttack, tauRelease) {
  const tau = target > cur ? tauAttack : tauRelease;
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}

// Soft knee so sensitivity > 1 can push the audio past 1 without hard clipping.
function softClamp(x) {
  if (!(x > 0)) return 0;
  return x < 0.8 ? x : 0.8 + 0.2 * (1 - Math.exp(-(x - 0.8) / 0.2));
}

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('[orb] shader compile failed: ' + log);
  }
  return sh;
}

function noopOrb() {
  return { setAudio() {}, setState() {}, setSensitivity() {}, resize() {}, destroy() {} };
}

export function createOrb(canvas, { sensitivity = 1 } = {}) {
  const attrs = {
    alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
    preserveDrawingBuffer: false, powerPreference: 'high-performance',
  };
  let gl = canvas.getContext('webgl2', attrs);
  const isGL2 = !!gl;
  if (!gl) gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
  if (!gl) {
    console.warn('[orb] WebGL is not available; orb disabled.');
    return noopOrb();
  }

  // ---- program ----
  let program, uni = {}, vbo;
  function build() {
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT(isGL2));
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_HEADER(isGL2) + FRAG_BODY);
    program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, 'aPos');
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('[orb] program link failed: ' + gl.getProgramInfoLog(program));
    }
    gl.useProgram(program);
    for (const name of ['uRes', 'uTime', 'uRot', 'uRadius', 'uCore', 'uFil', 'uSpark', 'uCool', 'uSoft', 'uHalo']) {
      uni[name] = gl.getUniformLocation(program, name);
    }
    // one big triangle covering the viewport
    vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
  }
  try {
    build();
  } catch (err) {
    console.error(err);
    return noopOrb();
  }

  // ---- smoothed inputs ----
  let sens = clamp(+sensitivity || 1, 0.25, 3);
  const target = { level: 0, bass: 0, mid: 0, treble: 0 };  // raw, from setAudio
  const audio  = { level: 0, bass: 0, mid: 0, treble: 0 };  // smoothed, sensitivity applied
  const weights = [1, 0, 0, 0];                              // smoothed state vector (idle, listening, thinking, speaking)
  let targetState = 0;
  let firstFrame = true;

  // integrated phases (radians / seconds) — never multiplied by a changing speed, so no jumps
  let rot = 0, flow = 0, phThink = 0, phSpeak = 0, phBreath = 0;

  // values pushed to the shader each frame
  const u = { radius: BASE_RADIUS, core: 0.5, fil: 0.6, spark: 0, cool: 0, soft: 0, halo: 0.8 };

  function update(dt) {
    // audio: attack fast / release slow (seconds). Treble is snappiest (sparkle), bass the laziest (breath).
    audio.level  = smooth(audio.level,  softClamp(target.level  * sens), dt, 0.035, 0.22);
    audio.bass   = smooth(audio.bass,   softClamp(target.bass   * sens), dt, 0.050, 0.30);
    audio.mid    = smooth(audio.mid,    softClamp(target.mid    * sens), dt, 0.040, 0.20);
    audio.treble = smooth(audio.treble, softClamp(target.treble * sens), dt, 0.020, 0.12);

    // state vector: 300 ms cross-fade, renormalised so the weights always sum to 1
    const k = firstFrame ? 1 : 1 - Math.exp(-dt / 0.3);
    let sum = 0;
    for (let i = 0; i < 4; i++) { weights[i] += ((i === targetState ? 1 : 0) - weights[i]) * k; sum += weights[i]; }
    for (let i = 0; i < 4; i++) weights[i] /= sum;
    firstFrame = false;
    const idle = weights[0], listen = weights[1], think = weights[2], speak = weights[3];

    // rhythms: thinking 1.1 Hz gentle pulse, speaking ~2.4 Hz with a slowly varying amplitude, idle breath 0.16 Hz
    phThink  += dt * TAU * 1.1;
    phSpeak  += dt * TAU * 2.4;
    phBreath += dt * TAU * 0.16;
    const pulseT = 0.5 + 0.5 * Math.sin(phThink);
    const pulseS = (0.5 + 0.5 * Math.sin(phSpeak)) * (0.7 + 0.3 * Math.sin(phSpeak * 0.37 + 1.0));
    const breath = 0.5 + 0.5 * Math.sin(phBreath);

    const lv = audio.level;
    // overall "energy" 0..1: drives core, filaments and halo
    const energy = listen * lv + think * (0.35 + 0.30 * pulseT) + speak * (0.30 + 0.45 * pulseS);

    // motion speeds (rad/s and s/s), then integrate
    const rotSpeed  = 0.10 + listen * (0.10 + 0.60 * lv) + think * 0.60 + speak * (0.18 + 0.22 * pulseS);
    const flowSpeed = 0.22 + listen * 0.55 * lv + think * 0.55 + speak * 0.25;
    rot  += dt * rotSpeed;
    flow += dt * flowSpeed;

    // radius breathes: idle slow breath, listening bass swell, speaking/thinking pulses
    u.radius = BASE_RADIUS * (1
      + 0.012 * breath * (1 - listen * lv)
      + listen * (0.075 * audio.bass + 0.03 * lv)
      + think * 0.02 * pulseT
      + speak * 0.05 * pulseS);
    u.core  = 0.42 + 0.05 * breath * idle + 1.25 * energy + 0.12 * think;
    u.fil   = 0.50 + 0.06 * breath * idle + 1.10 * energy;
    u.spark = clamp(listen * audio.treble * 1.3 + think * 0.25, 0, 1);
    u.cool  = think;
    u.soft  = speak;
    u.halo  = 0.75 + 0.70 * energy + 0.50 * listen * audio.bass;
  }

  function draw() {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(uni.uRes, canvas.width, canvas.height);
    gl.uniform1f(uni.uTime, flow);
    gl.uniform1f(uni.uRot, rot);
    gl.uniform1f(uni.uRadius, u.radius);
    gl.uniform1f(uni.uCore, u.core);
    gl.uniform1f(uni.uFil, u.fil);
    gl.uniform1f(uni.uSpark, u.spark);
    gl.uniform1f(uni.uCool, u.cool);
    gl.uniform1f(uni.uSoft, u.soft);
    gl.uniform1f(uni.uHalo, u.halo);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ---- sizing (DPR-aware, capped at 2) ----
  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (!cw || !ch) return;                                 // display:none etc. — keep the old buffer
    const w = Math.max(1, Math.round(cw * dpr));
    const h = Math.max(1, Math.round(ch * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => { resize(); if (!running) draw(); });
    ro.observe(canvas);
  }
  window.addEventListener('resize', resize);
  resize();

  // ---- rAF loop, paused while the tab is hidden ----
  let raf = 0, running = false, destroyed = false, last = 0;
  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const dt = clamp((now - last) / 1000, 0, 0.1);         // cap dt: a long stall must not fling the smoothing
    last = now;
    update(dt);
    draw();
  }
  function start() {
    if (running || destroyed || gl.isContextLost()) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }
  const onVisibility = () => { if (document.hidden) stop(); else start(); };
  document.addEventListener('visibilitychange', onVisibility);

  const onLost = (e) => { e.preventDefault(); stop(); };
  const onRestored = () => { try { build(); resize(); start(); } catch (err) { console.error(err); } };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  if (!document.hidden) start();

  // ---- public API ----
  return {
    setAudio({ level = 0, bass = 0, mid = 0, treble = 0 } = {}) {
      target.level  = clamp(+level  || 0, 0, 1);
      target.bass   = clamp(+bass   || 0, 0, 1);
      target.mid    = clamp(+mid    || 0, 0, 1);
      target.treble = clamp(+treble || 0, 0, 1);
    },
    setState(state) {
      const i = STATES.indexOf(state);
      if (i >= 0) targetState = i;
    },
    setSensitivity(n) {
      sens = clamp(+n || 1, 0.25, 3);
    },
    resize,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      if (ro) ro.disconnect();
      try {
        gl.deleteBuffer(vbo);
        gl.deleteProgram(program);
        const ext = gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      } catch (_) { /* context may already be gone */ }
    },
  };
}

export default createOrb;
