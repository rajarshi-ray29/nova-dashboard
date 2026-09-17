/**
 * orb_v3.js — NOVA plasma orb, variant 3: "PLASMA TENDRILS"
 *
 * A mic-reactive blue plasma sphere rendered with one full-screen fragment shader
 * (WebGL2, falling back to WebGL1). The look is built from three "shells" of a
 * translucent glass sphere (front surface, mid-depth, back surface). Each shell
 * point is pushed through two levels of domain warping and then several rotating
 * 3D noise fields; the filaments are the near-zero set of those fields rendered
 * as 1/(1 + k*|n|) glow lines, so they read as curved arcs of lightning wrapping
 * the sphere. On top: a soft volumetric white→cyan core (exp falloff), a fresnel
 * rim in deep blue, and a two-stage halo outside the glass.
 *
 * Interface (SPEC §7):
 *   createOrb(canvas, { sensitivity = 1 })
 *     → { setAudio({level,bass,mid,treble}), setState(state), setSensitivity(n), resize(), destroy() }
 *   state ∈ 'idle' | 'listening' | 'thinking' | 'speaking'; audio values are 0..1.
 *
 * Everything the shader receives is smoothed here first (exponential smoothing with a
 * fast attack / slow release, and a continuously interpolated state-weight vector), and
 * every "speed" is integrated into a phase (phase += dt * speed) so changing the speed
 * never causes the pattern to jump. Animation is time-based (dt from rAF timestamps).
 *
 * Noise budget: 31 simplex evaluations per fragment (front 12, mid 10, back 5, core 2,
 * sparkle 1, halo 1) — under the ≈48 target in the spec.
 */

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

const VERT_GL2 = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const VERT_GL1 = `attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

// Shared fragment shader body. The version header / precision / output declaration is
// prepended by fragSource() depending on the context type.
const FRAG_BODY = `
// ---- uniforms (all smoothed / integrated on the JS side) --------------------------
uniform vec2  u_res;      // canvas size in device pixels
uniform float u_time;     // wall-clock seconds (only used for the sparkle twinkle)
uniform float u_phase;    // integrated filament time — advances faster when the orb is excited
uniform float u_phase2;   // same for the inner (mid-depth) shell — extra fast while "thinking"
uniform float u_rot;      // integrated rotation of the sphere (radians)
uniform float u_energy;   // core brightness / excitement, ~0.3 (idle) .. 1.6 (loud)
uniform float u_breath;   // radius multiplier (bass swell + pulses), ~0.98 .. 1.12
uniform float u_warp;     // domain-warp strength = how curly the filaments are, ~0.35 .. 1.0
uniform float u_glow;     // filament brightness multiplier, ~0.7 .. 1.6
uniform float u_sparkle;  // treble sparkle amount 0..1
uniform float u_cool;     // 0..1 shifts the tint toward white / ice blue ("thinking")
uniform float u_soft;     // 0..1 softens the rim and widens the halo ("speaking")

// ---- 3D simplex noise (Ian McEwan / Ashima Arts, MIT) ------------------------------
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
  vec3  ns = n_ * D.wyz - D.xzx;
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

// ---- helpers ----------------------------------------------------------------------
// A smooth pseudo-random 3D offset field (3 noise evaluations) used for domain warping.
vec3 warp3(vec3 p) {
  return vec3(snoise(p), snoise(p + vec3(19.1, 33.4, 7.2)), snoise(p + vec3(-11.3, 5.7, 27.8)));
}
// Distance-to-zero-set of a two-octave noise field (2 evaluations). The second octave
// adds the fine wiggle that makes the arcs look like lightning rather than contour lines.
float ridge2(vec3 p) {
  return abs(snoise(p) + 0.5 * snoise(p * 2.07 + vec3(3.1, -1.7, 5.9)));
}
// Single-octave version (1 evaluation) for the dim back shell.
float ridge1(vec3 p) { return abs(snoise(p)); }
// Glow line profile: 1 on the zero set, falling off with 1/(1 + k*m). Bigger k = thinner line.
float line(float m, float k) { return 1.0 / (1.0 + k * m); }

mat3 rotY(float a) { float c = cos(a); float s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rotX(float a) { float c = cos(a); float s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c); }

// Cheap screen-space hash for the dither.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  // Normalised coordinates: -1..1 across the shorter canvas axis, origin at the centre.
  vec2  uv = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y) * 2.0;
  float px = 2.0 / min(u_res.x, u_res.y);   // one device pixel in uv units
  float R  = 0.70 * u_breath;               // sphere radius (leaves ~0.3 for the halo)
  float r  = length(uv);
  float rr = r / R;                         // 0 at the centre, 1 at the rim
  float z  = sqrt(max(0.0, 1.0 - rr * rr)); // depth of the front surface (0 at the rim)
  vec2  d  = uv / R;                        // disc coordinates

  // Anti-aliased sphere coverage; the rim gets softer while speaking.
  float edge   = px * (1.5 + 5.0 * u_soft);
  float inside = 1.0 - smoothstep(R - edge, R + edge, r);

  float t  = u_phase;
  float t2 = u_phase2;

  // Palette (white core lines → cyan → electric blue → deep blue body).
  vec3 white = vec3(1.0);
  vec3 cyan  = mix(vec3(0.42, 0.88, 1.0), vec3(0.74, 0.90, 1.0), u_cool);
  vec3 blue  = mix(vec3(0.12, 0.42, 1.0), vec3(0.36, 0.62, 1.0), u_cool * 0.6);
  vec3 deep  = vec3(0.02, 0.09, 0.42);

  vec3 col = vec3(0.0);

  if (inside > 0.001) {
    // Sphere rotation: a slow spin about a tilted axis. The inner shell counter-rotates
    // a little faster, which sells the parallax / depth.
    mat3 M  = rotX(0.42) * rotY(u_rot);
    mat3 Mi = rotX(-0.25) * rotY(1.7 - u_rot * 1.8);
    vec3 Pf = M  * vec3(d, z);                  // front surface point
    vec3 Pb = M  * vec3(d, -z);                 // back surface point (same field, seen through the glass)
    vec3 Pm = Mi * (vec3(d, z * 0.6) * 0.72);   // mid-depth shell

    // Filaments get thicker (smaller k) as the orb gets excited.
    float kf = 1.15 - 0.25 * min(u_energy, 1.0);
    // Filaments passing near the core are lit by it (the core "feeds" the tendrils).
    float feed = 1.0 + 1.3 * exp(-rr * rr / 0.22) * min(u_energy, 1.0);

    // ---- front shell: 2-level domain warp + 3 filament fields ----------------------
    vec3 q = Pf;
    vec3 w1 = warp3(q * 1.10 + vec3(0.0, t * 0.10, t * 0.06));               // big slow swirls
    q += u_warp * 0.50 * w1;
    q += u_warp * 0.20 * warp3(q * 2.60 - vec3(t * 0.12, 0.0, t * 0.08));   // finer curls
    // Brightness varies along each filament (bright and faint segments, like a discharge)
    // using the first warp field we already paid for.
    float segA = 0.45 + 0.55 * smoothstep(-0.7, 0.7, w1.x);
    float segB = 0.45 + 0.55 * smoothstep(-0.7, 0.7, w1.y);
    // Layer A is squashed along x so its arcs run "around" the sphere like latitude
    // lines; B uses a swizzled axis so its arcs cross A; C is finer and isotropic.
    float mA = ridge2(q * vec3(0.9, 1.9, 1.7) + vec3(0.0, 0.0, t * 0.22));
    float mB = ridge2(q.yzx * vec3(1.7, 1.1, 2.0) + vec3(t * 0.18, 4.7, 0.0));
    float mC = ridge2(q * 2.8 + vec3(8.0, t * 0.30, -2.0));
    float lA = line(mA, 16.0 * kf) * segA;
    float lB = line(mB, 20.0 * kf) * segB;
    float lC = line(mC, 18.0 * kf);
    float lineF = lA * lA + 0.8 * lB * lB + (0.20 + 0.35 * min(u_energy, 1.0)) * lC * lC;
    float hotF  = pow(lA, 6.0) + 0.7 * pow(lB, 6.0) + 0.3 * pow(lC, 6.0);  // white-hot centres
    float hazeF = (line(mA, 3.0) * segA + line(mB, 3.0) * segB + 0.5 * line(mC, 3.0)) * 0.055;
    col += (mix(blue, cyan, 0.6) * lineF * feed + cyan * hazeF) * u_glow;
    col += white * hotF * 0.7 * feed * u_glow;

    // ---- mid shell: 2-level warp + 2 filament fields (bluer, dimmer, deeper) -------
    vec3 s = Pm;
    vec3 w2 = warp3(s * 1.3 + vec3(t2 * 0.09, 0.0, t2 * 0.12));
    s += u_warp * 0.50 * w2;
    s += u_warp * 0.20 * warp3(s * 2.8 + vec3(0.0, t2 * 0.14, 0.0));
    float segM = 0.4 + 0.6 * smoothstep(-0.7, 0.7, w2.z);
    float nA = ridge2(s * vec3(1.9, 1.1, 1.6) + vec3(0.0, t2 * 0.25, 3.0));
    float nB = ridge2(s.zxy * 2.4 + vec3(t2 * 0.20, 0.0, 6.0));
    float kA = line(nA, 14.0 * kf) * segM;
    float kB = line(nB, 14.0 * kf);
    float depthM = 0.45 + 0.55 * z;                                   // fades toward the rim
    col += (blue * kA * kA + mix(blue, deep * 2.0, 0.5) * kB * kB * 0.7) * 0.55 * u_glow * depthM * feed;
    col += (line(nA, 3.0) + line(nB, 3.0)) * 0.03 * blue * u_glow;
    col += white * pow(kA, 7.0) * 0.25 * u_glow * depthM;

    // ---- back shell: 1-level warp + 2 wide, dim, deep-blue filaments ---------------
    vec3 b = Pb;
    b += u_warp * 0.50 * warp3(b * 1.10 + vec3(0.0, t * 0.10, t * 0.06));
    float oA = ridge1(b * vec3(0.9, 1.9, 1.7) + vec3(0.0, 0.0, t * 0.22));
    float oB = ridge1(b.yzx * vec3(1.7, 1.1, 2.0) + vec3(t * 0.18, 4.7, 0.0));
    col += deep * 2.4 * (line(oA, 7.0) + 0.8 * line(oB, 7.0)) * 0.30 * u_glow;

    // ---- glass body + light bleeding from the core --------------------------------
    col += deep * (0.22 + 0.50 * z);
    col += mix(blue, cyan, 0.5) * exp(-rr * rr * 2.2) * (0.10 + 0.22 * u_energy);

    // ---- volumetric core: exp falloff, wobbling with low-frequency noise -----------
    float cn = 0.75 + 0.35 * snoise(vec3(d * 2.4, t * 0.35)) + 0.15 * snoise(vec3(d * 6.0 + 2.0, t * 0.6));
    float cr = 0.050 + 0.070 * u_energy;                // core radius grows with energy
    float core = exp(-rr * rr / cr) * cn;
    float hot  = exp(-rr * rr / (cr * 0.30));           // white-hot centre
    col += mix(cyan, white, 0.35 + 0.35 * u_cool) * core * (0.45 + 1.10 * u_energy);
    col += white * hot * (0.30 + 1.1 * u_energy);

    // ---- glass specular: a soft highlight from the upper-left, sells the glass -------
    vec3 N = vec3(d, z);
    vec3 L = normalize(vec3(-0.55, 0.62, 0.55));
    float ndl = max(dot(N, L), 0.0);
    col += mix(cyan, white, 0.5) * (0.09 * pow(ndl, 22.0) + 0.05 * pow(ndl, 5.0));

    // ---- fresnel rim: deeper saturated blue -------------------------------------
    float fres = pow(1.0 - z, 3.5);
    col += mix(deep * 2.5, blue, 0.5) * fres * (0.75 + 0.5 * u_energy);

    // ---- treble sparkle: tiny bright motes on the front surface ------------------
    float sp = snoise(Pf * 9.0 + vec3(0.0, u_time * 0.9, 0.0));
    col += white * smoothstep(0.62, 0.98, sp) * u_sparkle * 0.6;

    col *= inside;
  }

  // ---- halo outside the glass: tight glow + wide faint glow ------------------------
  float o    = max(r - R, 0.0);
  float hw   = 0.075 + 0.05 * min(u_energy, 1.2) + 0.07 * u_soft;
  float hn   = 0.88 + 0.12 * snoise(vec3(uv * 2.2, u_phase * 0.2 + 17.0));
  float halo = exp(-o / hw) * hn * (1.0 - inside);
  float halo2 = exp(-o / (hw * 3.2)) * (1.0 - inside) * 0.18;
  // Fade the halo to true transparency before it reaches the square canvas bounds.
  // Without this radial vignette, the wide exponential tail reveals the canvas edges.
  float canvasFade = 1.0 - smoothstep(0.86, 0.985, r);
  halo *= canvasFade;
  halo2 *= canvasFade;
  vec3 haloCol = mix(deep * 2.0, mix(blue, cyan, 0.5), 0.35 + 0.45 * min(u_energy, 1.0));
  col += haloCol * halo  * (0.55 + 0.55 * u_energy);
  col += haloCol * halo2 * (0.40 + 0.50 * u_energy);

  // ---- output: premultiplied alpha (rgb = emitted light, a = coverage) -------------
  float alpha = inside * (0.86 + 0.12 * z) + clamp(halo * 0.95 + halo2 * 0.6, 0.0, 1.0);
  col = 1.0 - exp(-col * 1.25);                                   // soft tone map, no hard clipping
  col += (hash12(gl_FragCoord.xy) - 0.5) / 255.0 * alpha;         // dither only visible pixels
  col = max(col, 0.0);
  alpha = clamp(max(alpha, max(col.r, max(col.g, col.b))), 0.0, 1.0);
  fragColor = vec4(col, alpha);
}
`;

function fragSource(isGL2, highp) {
  const prec = highp ? 'highp' : 'mediump';
  if (isGL2) return `#version 300 es\nprecision ${prec} float;\nout vec4 fragColor;\n${FRAG_BODY}`;
  return `precision ${prec} float;\n#define fragColor gl_FragColor\n${FRAG_BODY}`;
}

// ---------------------------------------------------------------------------
// Per-state parameters. Columns: idle, listening, thinking, speaking.
// They are blended by the smoothed state-weight vector, so transitions glide.
// ---------------------------------------------------------------------------
const STATES = ['idle', 'listening', 'thinking', 'speaking'];
const PARAMS = {
  core:     [0.28, 0.55, 0.72, 0.60], // base core brightness
  speed:    [0.32, 0.65, 1.50, 0.85], // filament phase rate (1/s)
  rot:      [0.05, 0.11, 0.28, 0.14], // sphere rotation rate (rad/s)
  warp:     [0.38, 0.55, 0.78, 0.55], // domain-warp strength
  gain:     [0.30, 1.00, 0.35, 0.55], // how much the mic influences the look
  glow:     [0.65, 1.00, 1.10, 1.00], // filament brightness
  pulseHz:  [0.00, 0.00, 0.90, 2.50], // rhythmic pulse frequency
  pulseAmt: [0.00, 0.00, 0.22, 0.38], // rhythmic pulse depth
  cool:     [0.00, 0.00, 1.00, 0.15], // cooler / whiter tint
  soft:     [0.00, 0.00, 0.00, 1.00], // softened rim + wider halo
};

const UNIFORMS = ['u_res', 'u_time', 'u_phase', 'u_phase2', 'u_rot', 'u_energy', 'u_breath',
  'u_warp', 'u_glow', 'u_sparkle', 'u_cool', 'u_soft'];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Exponential smoothing with separate attack / release time constants (seconds).
function follow(cur, target, dt, attack, release) {
  const tau = target > cur ? attack : release;
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------
export function createOrb(canvas, { sensitivity = 1 } = {}) {
  let sens = clamp(Number(sensitivity) || 1, 0.1, 4);

  // Raw inputs (set by callers) and their smoothed versions.
  const raw = { level: 0, bass: 0, mid: 0, treble: 0 };
  const sm  = { level: 0, bass: 0, mid: 0, treble: 0 };
  const stateTarget = [1, 0, 0, 0];
  const w = [1, 0, 0, 0];

  // Integrated phases (never jump when speeds change).
  let phase = 0, phase2 = 0, rot = 0, pulsePhase = 0, breathPhase = 0;
  let energy = PARAMS.core[0];
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // GL state
  let gl = null, isGL2 = false, program = null, buffer = null, loc = {};
  let raf = 0, last = 0, running = false, destroyed = false, contextLost = false;
  let scale = 1;                 // internal resolution scale (adaptive: 1 → 0.75 when GPU-bound)
  let slowFrames = 0, emaDt = 1 / 60;
  let ro = null;

  // ---- GL setup --------------------------------------------------------------------
  function getContext() {
    const attrs = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false,
      stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' };
    let ctx = null;
    try { ctx = canvas.getContext('webgl2', attrs); } catch (_) { ctx = null; }
    if (ctx) { isGL2 = true; return ctx; }
    isGL2 = false;
    try { ctx = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs); } catch (_) { ctx = null; }
    return ctx;
  }

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('orb_v3 shader compile error: ' + log);
    }
    return sh;
  }

  function init() {
    gl = getContext();
    if (!gl) { console.warn('orb_v3: WebGL is not available; orb disabled.'); return false; }
    const fmt = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    const highp = !!(fmt && fmt.precision > 0);
    const vs = compile(gl.VERTEX_SHADER, isGL2 ? VERT_GL2 : VERT_GL1);
    const fs = compile(gl.FRAGMENT_SHADER, fragSource(isGL2, highp));
    program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, 'a_pos');
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error('orb_v3 program link error: ' + gl.getProgramInfoLog(program));
    }
    gl.useProgram(program);
    loc = {};
    for (const name of UNIFORMS) loc[name] = gl.getUniformLocation(program, name);

    // One triangle that covers the whole clip space (cheaper than a quad, no seam).
    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    resize();
    return true;
  }

  // ---- sizing ----------------------------------------------------------------------
  function resize() {
    if (!gl) return;
    const dpr = clamp((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 1, 2) * scale;
    const cssW = canvas.clientWidth || canvas.width || 360;
    const cssH = canvas.clientHeight || canvas.height || cssW;
    const W = Math.max(1, Math.round(cssW * dpr));
    const H = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    gl.viewport(0, 0, W, H);
  }

  // ---- per-frame update ------------------------------------------------------------
  const blend = (key) => {
    const p = PARAMS[key];
    return w[0] * p[0] + w[1] * p[1] + w[2] * p[2] + w[3] * p[3];
  };

  function update(dt, now) {
    // Audio smoothing: fast attack, slower release, treble snappiest.
    sm.level  = follow(sm.level,  raw.level,  dt, 0.045, 0.22);
    sm.bass   = follow(sm.bass,   raw.bass,   dt, 0.060, 0.30);
    sm.mid    = follow(sm.mid,    raw.mid,    dt, 0.050, 0.20);
    sm.treble = follow(sm.treble, raw.treble, dt, 0.030, 0.12);

    // State weights glide toward the target and stay normalised.
    let sum = 0;
    for (let i = 0; i < 4; i++) { w[i] = follow(w[i], stateTarget[i], dt, 0.35, 0.35); sum += w[i]; }
    for (let i = 0; i < 4; i++) w[i] /= sum || 1;

    // Derived drive values.
    const gain = blend('gain') * sens;
    const a    = clamp(sm.level * gain, 0, 1.2);          // main excitement
    const bass = clamp(sm.bass * gain, 0, 1.2);
    const treb = clamp(sm.treble * gain, 0, 1.0);

    const speed = blend('speed') * (1 + 2.2 * a);
    phase      += dt * speed;
    phase2     += dt * speed * (1 + 1.2 * w[2]);          // extra inner swirl while thinking
    rot        += dt * blend('rot') * (1 + 1.5 * a);
    pulsePhase += dt * 2 * Math.PI * blend('pulseHz');
    breathPhase += dt * 0.7;
    const pulse = blend('pulseAmt') * (0.5 - 0.5 * Math.cos(pulsePhase));

    const energyTarget = clamp(blend('core') + 0.85 * a + pulse, 0, 1.6);
    energy = follow(energy, energyTarget, dt, 0.05, 0.12);

    const breath  = 1 + 0.07 * bass + 0.035 * pulse + 0.012 * Math.sin(breathPhase);
    const warp    = blend('warp') + 0.25 * a;
    const glow    = blend('glow') + 0.5 * a;
    const sparkle = treb * (0.4 + 0.6 * w[1]);            // sparkle is mostly a listening thing
    const cool    = blend('cool');
    const soft    = blend('soft');

    gl.uniform2f(loc.u_res, canvas.width, canvas.height);
    gl.uniform1f(loc.u_time, ((now - t0) / 1000) % 3600);
    gl.uniform1f(loc.u_phase, phase);
    gl.uniform1f(loc.u_phase2, phase2);
    gl.uniform1f(loc.u_rot, rot);
    gl.uniform1f(loc.u_energy, energy);
    gl.uniform1f(loc.u_breath, breath);
    gl.uniform1f(loc.u_warp, warp);
    gl.uniform1f(loc.u_glow, glow);
    gl.uniform1f(loc.u_sparkle, sparkle);
    gl.uniform1f(loc.u_cool, cool);
    gl.uniform1f(loc.u_soft, soft);
  }

  function frame(now) {
    raf = 0;
    if (!running || destroyed || contextLost || !gl) return;
    const dt = clamp((now - last) / 1000, 0, 0.1);      // clamp so a stall never jumps the animation
    last = now;

    // Adaptive quality: if we are GPU-bound (rAF cadence collapses) drop the internal
    // resolution once; it is restored on the next resize() when the canvas changes.
    emaDt += (dt - emaDt) * 0.1;
    if (emaDt > 1 / 36 && scale > 0.75) {
      if (++slowFrames > 90) { scale = 0.75; slowFrames = 0; resize(); }
    } else slowFrames = 0;

    update(dt, now);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running || destroyed || !gl) return;
    running = true;
    last = performance.now();
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  // ---- events ----------------------------------------------------------------------
  function onVisibility() {
    if (document.visibilityState === 'hidden') {
      stop();
      // Nobody is watching: fold the phases back to keep float precision after long runs.
      if (phase > 5000) phase -= 5000;
      if (phase2 > 5000) phase2 -= 5000;
      if (rot > 1000 * Math.PI) rot -= 1000 * Math.PI;
    } else {
      start();
    }
  }
  function onContextLost(e) { e.preventDefault(); contextLost = true; stop(); }
  function onContextRestored() {
    contextLost = false;
    try { if (init()) start(); } catch (err) { console.error(err); }
  }
  function onWindowResize() { resize(); }

  // ---- boot ------------------------------------------------------------------------
  let ok = false;
  try { ok = init(); } catch (err) { console.error(err); ok = false; }

  if (ok) {
    canvas.addEventListener('webglcontextlost', onContextLost, false);
    canvas.addEventListener('webglcontextrestored', onContextRestored, false);
    document.addEventListener('visibilitychange', onVisibility);
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => resize());
      ro.observe(canvas);
    } else {
      window.addEventListener('resize', onWindowResize);
    }
    if (document.visibilityState !== 'hidden') start();
  }

  // ---- public API (SPEC §7) --------------------------------------------------------
  return {
    setAudio({ level = 0, bass = 0, mid = 0, treble = 0 } = {}) {
      raw.level  = clamp(+level  || 0, 0, 1);
      raw.bass   = clamp(+bass   || 0, 0, 1);
      raw.mid    = clamp(+mid    || 0, 0, 1);
      raw.treble = clamp(+treble || 0, 0, 1);
    },
    setState(state) {
      const i = STATES.indexOf(state);
      if (i < 0) return;
      for (let k = 0; k < 4; k++) stateTarget[k] = k === i ? 1 : 0;
    },
    setSensitivity(n) { sens = clamp(Number(n) || 1, 0.1, 4); },
    resize() { scale = 1; resize(); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onWindowResize);
      if (ro) { ro.disconnect(); ro = null; }
      if (gl) {
        try {
          if (buffer) gl.deleteBuffer(buffer);
          if (program) gl.deleteProgram(program);
          const ext = gl.getExtension('WEBGL_lose_context');
          if (ext) ext.loseContext();
        } catch (_) { /* context may already be gone */ }
      }
      gl = null; program = null; buffer = null;
    },
  };
}

export default createOrb;
