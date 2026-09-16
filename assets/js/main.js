/* ==========================================================================
   SEAS — ink tunnel
   Free flight along a curved path. Scroll drives the camera directly, speed
   widens the lens and banks it into turns; standing still, the frame is level.
   Posters hang on the path; their layers sit at very different depths and are
   projected from 3D, so they fly apart in motion and lock into one composition
   when you stop in front of them. Two blood-red ink lines run the whole way.
   ========================================================================== */
import * as THREE from 'three';

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const TALL = matchMedia('(max-aspect-ratio: 4/5)');

const posters = [...document.querySelectorAll('.poster')];
const N = posters.length;
const canvas = document.getElementById('ink');
const spacer = document.getElementById('spacer');
const progressEl = document.getElementById('progress');
const stopLinks = [...document.querySelectorAll('#stops [data-go]')];

const FOV = 44;
const TAN0 = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
const F = 12;                 // camera → poster at a stop
const GAP = 84;               // path length between posters
const SCROLL_PER_GAP = 1.5;   // viewport heights of scroll per poster
const YAW = [0, 0.5, -0.12, 0.44, -0.05];    // travel direction at each poster
const PITCH = [0, 0.07, -0.06, 0.05, 0];

const PAPER = 0xEDEBE6;
const INK = new THREE.Color('#141414');
const BLOOD = new THREE.Color('#7E0B06');
const RED = new THREE.Color('#9E140C');
const GRAY = new THREE.Color('#8E8B85');

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const blade = (W, peak) => (t) => W * (t < peak ? Math.pow(t / peak, 0.7) : Math.pow((1 - t) / (1 - peak), 1.35));

/* ---------------------------------------------------------------- path */

function posterFrames() {
  const frames = [];
  for (let i = 0; i < N; i++) {
    const dir = V(Math.sin(YAW[i]) * Math.cos(PITCH[i]), Math.sin(PITCH[i]), -Math.cos(YAW[i]) * Math.cos(PITCH[i])).normalize();
    const P = i === 0 ? V(0, 0, 0)
      : frames[i - 1].P.clone().addScaledVector(frames[i - 1].dir.clone().add(dir).normalize(), GAP);
    const right = V(0, 0, 0).crossVectors(dir, UP).normalize();
    const up = V(0, 0, 0).crossVectors(right, dir).normalize();
    frames.push({ P, dir, right, up });
  }
  return frames;
}

/* straight in front of every poster, curves in between */
function buildPath(frames) {
  const pts = [];
  const stopIdx = [];
  frames.forEach((f, i) => {
    pts.push(f.P.clone().addScaledVector(f.dir, -(i === 0 ? F + 8 : F + 18)));
    stopIdx.push(pts.length);
    pts.push(f.P.clone().addScaledVector(f.dir, -F));
    pts.push(f.P.clone().addScaledVector(f.dir, 14));
  });
  const last = frames[N - 1];
  pts.push(last.P.clone().addScaledVector(last.dir, 80));
  pts.push(last.P.clone().addScaledVector(last.dir, 200));

  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const PER = 300;
  const M = (pts.length - 1) * PER;
  const samples = [];
  const lengths = [0];
  for (let j = 0; j <= M; j++) {
    samples.push(curve.getPoint(j / M));
    if (j > 0) lengths.push(lengths[j - 1] + samples[j].distanceTo(samples[j - 1]));
  }
  const stopS = stopIdx.map((k) => lengths[k * PER]);
  const at = (s, target = V(0, 0, 0)) => {
    s = clamp(s, 0, lengths[M]);
    let lo = 0, hi = M;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (lengths[mid] < s) lo = mid; else hi = mid; }
    return target.copy(samples[lo]).lerp(samples[hi], (s - lengths[lo]) / (lengths[hi] - lengths[lo] || 1));
  };
  return { at, stopS, length: lengths[M] };
}

/* local frame of the path at arc length s */
function pathFrame(path, s, T = V(0, 0, 0), R = V(0, 0, 0), U = V(0, 0, 0)) {
  const a = path.at(s - 0.5), b = path.at(s + 0.5);
  T.subVectors(b, a).normalize();
  R.crossVectors(T, UP).normalize();
  U.crossVectors(R, T).normalize();
  return { T, R, U };
}

/* ---------------------------------------------------------------- start */

function start() {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    if (!renderer.getContext()) return;
  } catch (e) { return; }

  THREE.ColorManagement.enabled = false;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearColor(PAPER, 1);
  document.body.classList.add('tunnel');

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 900);
  const frames = posterFrames();
  const path = buildPath(frames);

  const layers = posters.map((poster) =>
    [...poster.querySelectorAll('.layer')].map((el) => ({ el, d: parseFloat(el.dataset.d) || 0, W: V(0, 0, 0) })));
  layers.forEach((ls, i) => ls.forEach((L) => L.W.copy(frames[i].P).addScaledVector(frames[i].dir, -L.d)));

  const uniforms = { uPx: { value: 0 }, uTime: { value: 0 }, uFogNear: { value: 50 }, uFogFar: { value: 230 } };
  const material = makeInkMaterial(uniforms);
  let world = null;
  let revealed = false;
  const t0 = performance.now();

  function rebuild() {
    if (world) { scene.remove(world); world.geometry.dispose(); }
    world = buildInk(material, path, frames);
    if (revealed) shiftDelays(world.geometry, -100);
    revealed = true;
    scene.add(world);
  }

  /* ------------------------------------------------------------ layout */
  let targetP = 0, p = 0;
  const maxScroll = () => Math.max(1, spacer.offsetHeight - innerHeight);
  function layout() {
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    spacer.style.height = `${innerHeight + (N - 1) * innerHeight * SCROLL_PER_GAP}px`;
  }
  layout();
  rebuild();

  const hashIndex = posters.findIndex((el) => `#${el.id}` === location.hash);
  if (hashIndex > 0) scrollTo(0, (hashIndex / (N - 1)) * maxScroll());
  const readScroll = () => { targetP = N > 1 ? clamp(scrollY / maxScroll(), 0, 1) : 0; };
  readScroll();
  p = targetP;

  let resizeT;
  addEventListener('resize', () => {
    const keep = p;
    layout();
    scrollTo(0, keep * maxScroll());
    clearTimeout(resizeT);
    resizeT = setTimeout(rebuild, 160);
  });
  addEventListener('scroll', readScroll, { passive: true });

  document.querySelectorAll('[data-go]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      scrollTo({ top: (parseInt(a.dataset.go, 10) / Math.max(1, N - 1)) * maxScroll(), behavior: 'smooth' });
      history.replaceState(null, '', a.getAttribute('href'));
    });
  });
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    const label = btn.querySelector('[data-copy-label]');
    btn.addEventListener('click', () => {
      const done = () => { label.textContent = 'Copied'; setTimeout(() => { label.textContent = 'Copy'; }, 1600); };
      if (navigator.clipboard) navigator.clipboard.writeText(btn.dataset.copy).then(done, done);
      else done();
    });
  });

  /* ------------------------------------------------------------ frame */
  const pos = V(0, 0, 0), look = V(0, 0, 0), tmp = V(0, 0, 0);
  const T1 = V(0, 0, 0), T2 = V(0, 0, 0);
  let last = performance.now();
  let vel = 0, fov = FOV, roll = 0;
  let current = -1;

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const prev = p;
    p += (targetP - p) * (1 - Math.exp(-dt * 6));
    if (Math.abs(targetP - p) < 1e-6) p = targetP;
    vel += ((p - prev) / Math.max(dt, 1e-3) - vel) * (1 - Math.exp(-dt * 8));   // progress per second, smoothed

    // progress → arc length, linear between posters: no plateaus, no slideshow
    const q = p * (N - 1);
    const i = Math.min(N - 2, Math.floor(q));
    const s = path.stopS[i] + (path.stopS[i + 1] - path.stopS[i]) * (q - i);

    path.at(s, pos);
    path.at(s + 12, look);
    // near a poster the view locks onto the poster's axis so every layer lines up exactly
    const n0 = Math.round(q);
    const lock = 1 - smooth(0, 0.3, Math.abs(q - n0));
    look.sub(pos).normalize().lerp(frames[n0].dir, lock).normalize().multiplyScalar(12).add(pos);

    // bank into the turn only while moving; level when you stop
    path.at(s - 6, tmp); T1.subVectors(pos, tmp).normalize();
    path.at(s + 6, tmp); T2.subVectors(tmp, pos).normalize();
    const turn = T1.x * T2.z - T1.z * T2.x;
    const speed = smooth(0.02, 0.35, Math.abs(vel));
    roll += (clamp(turn * 1.6, -0.09, 0.09) * speed - roll) * (1 - Math.exp(-dt * 4));

    fov += (FOV + Math.min(12, Math.abs(vel) * 26) - fov) * (1 - Math.exp(-dt * 5));
    const tan = Math.tan(THREE.MathUtils.degToRad(fov / 2));

    camera.fov = fov;
    camera.updateProjectionMatrix();
    camera.position.copy(pos);
    camera.up.copy(UP);
    camera.lookAt(look);
    camera.rotateZ(roll);
    camera.updateMatrixWorld();

    const hw = innerWidth / 2, hh = innerHeight / 2;
    for (let n = 0; n < N; n++) {
      let near = false;
      for (const L of layers[n]) {
        tmp.copy(L.W).applyMatrix4(camera.matrixWorldInverse);
        const depth = -tmp.z;
        let o = 0;
        if (depth > 0.8) {
          const sc = ((F - L.d) / depth) * (TAN0 / tan);
          const x = (tmp.x / (depth * tan * camera.aspect)) * hw;
          const y = (-tmp.y / (depth * tan)) * hh;
          o = Math.min(smooth(0.26, 0.55, sc), 1 - smooth(1.3, 3.4, sc));
          if (Math.abs(x) > innerWidth * 1.6 || Math.abs(y) > innerHeight * 1.6) o = 0;
          if (o > 0.001) {
            L.el.style.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0) rotate(${roll.toFixed(4)}rad) scale(${sc.toFixed(4)})`;
          }
        }
        L.el.style.opacity = o.toFixed(3);
        if (o > 0.001) near = true;
      }
      posters[n].classList.toggle('is-near', near);
      posters[n].classList.toggle('is-live', Math.abs(q - n) < 0.1);
    }

    const idx = Math.round(q);
    if (idx !== current) {
      current = idx;
      stopLinks.forEach((a) => a.setAttribute('aria-current', String(parseInt(a.dataset.go, 10) === idx)));
    }
    if (progressEl) progressEl.style.width = `${(p * 100).toFixed(3)}%`;

    uniforms.uPx.value = (2 * tan) / innerHeight;
    uniforms.uTime.value = (now - t0) / 1000;
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/* ---------------------------------------------------------------- ink world */

function buildInk(material, path, frames) {
  const tall = TALL.matches;
  const aw = tall ? 390 : 1440, ah = tall ? 760 : 900;
  const aspect = innerWidth / innerHeight;
  const fh = F * TAN0;                  // half-height of the frame at a stop
  const fw = fh * aspect;               // half-width
  const u = Math.min(innerWidth / aw, innerHeight / ah);   // css px per artboard px
  const spread = clamp(fw / 7.8, 0.42, 1.25);
  const batch = new InkBatch();
  const T = V(0, 0, 0), R = V(0, 0, 0), U = V(0, 0, 0), P = V(0, 0, 0);

  /* artboard point on poster i, dz toward camera (+) or away (−) → world */
  const onPoster = (i, ax, ay, dz) => {
    const f = frames[i];
    const wpp = (2 * (F - dz) * TAN0) / innerHeight;
    return f.P.clone()
      .addScaledVector(f.right, (ax - aw / 2) * u * wpp)
      .addScaledVector(f.up, -(ay - ah / 2) * u * wpp)
      .addScaledVector(f.dir, -dz);
  };

  /* ---- the lines: two blood-red ink strokes along the whole path ---- */
  const rails = [
    { x: -0.98, y: -0.8, w: 0.05, seed: 3, dry: 0.3, op: 1 },
    { x: 0.98, y: -0.8, w: 0.03, seed: 9, dry: 0.45, op: 0.95 },
  ];
  const L = rng(5);
  for (const r of rails) {
    const pts = [];
    const swells = Array.from({ length: 22 }, () => [L(), 0.002 + L() * 0.004, 0.03 + L() * 0.1]);
    for (let s = 0.6; s <= path.length; s += 1.5) {
      pathFrame(path, s, T, R, U);
      path.at(s, P);
      const wx = Math.sin(s * 0.019 + r.seed) * 0.06, wy = Math.sin(s * 0.027 + r.seed * 2) * 0.05;
      pts.push(P.clone().addScaledVector(R, (r.x + wx) * fw).addScaledVector(U, (r.y + wy) * fh));
    }
    batch.add(pts, {
      color: BLOOD, seed: r.seed, dry: r.dry, op: r.op, delay: 0.1, density: 1.4,
      width: (t) => {
        let w = r.w * (0.7 + 0.6 * Math.pow(0.5 + 0.5 * Math.sin(t * 90 + r.seed), 2));
        for (const [c, sd, a] of swells) w += a * Math.exp(-Math.pow((t - c) / sd, 2));
        return w * spread;
      },
    });
    // a hair strand that follows the stroke and drifts off it now and then
    const strand = pts.map((pt, k) => {
      const s = 0.6 + k * 1.5;
      pathFrame(path, s, T, R, U);
      const drift = 0.06 + 0.1 * Math.max(0, Math.sin(s * 0.013 + r.seed));
      return pt.clone().addScaledVector(R, -Math.sign(r.x) * drift * fw).addScaledVector(U, drift * 0.6 * fh);
    });
    batch.add(strand, { color: BLOOD, seed: r.seed + 40, dry: 0.6, op: 0.7, delay: 0.3, density: 1.2, width: () => 0.009 * spread });
  }

  /* ---- ink hairs streaming past the edges: the feeling of speed ---- */
  const H = rng(23);
  for (let n = 0; n < 130; n++) {
    const s = H() * path.length;
    pathFrame(path, s, T, R, U);
    path.at(s, P);
    const a = H() * Math.PI * 2;
    const k = 1.25 + H() * 1.3;
    const base = P.clone().addScaledVector(R, Math.cos(a) * fw * k).addScaledVector(U, Math.sin(a) * fh * k);
    const len = 4 + H() * 16;
    const bend = (H() - 0.5) * 1.4;
    const color = H() < 0.8 ? INK : GRAY;
    batch.add([
      base,
      base.clone().addScaledVector(T, len * 0.5).addScaledVector(R, bend * 0.4),
      base.clone().addScaledVector(T, len).addScaledVector(R, bend),
    ], { color, width: blade((0.012 + Math.pow(H(), 3) * 0.1) * spread, 0.2 + H() * 0.5), seed: H() * 80, dry: 0.7, op: 0.8, delay: 0.5 + H() * 0.8, density: 3 });
  }

  /* ---- shaggy bursts around the suns ---- */
  const burst = (i, ax, ay, seed, count, scale, dirs, keepBelow = false) => {
    const f = frames[i];
    const C = onPoster(i, ax, ay, -16);
    const B = rng(seed);
    for (let n = 0; n < count; n++) {
      let ang = B() * Math.PI * 2;
      if (dirs && B() < 0.5) ang = dirs[Math.floor(B() * dirs.length)] + (B() - 0.5) * 0.9;
      const r0 = (B() < 0.2 ? 0.3 + B() * 1.2 : 2.6 + B() * 2.8) * scale;
      let len = (2 + Math.pow(B(), 1.8) * 12) * scale;
      const down = Math.sin(ang) < -0.35;
      if (keepBelow && down) len = Math.min(len, 2.2 * scale);   // text sits under the sun
      const bend = (B() - 0.5) * 0.75;
      const zA = (B() - 0.5) * 14, zB = zA + (B() - 0.3) * 16;
      const pt = (ang2, r, z) => C.clone()
        .addScaledVector(f.right, Math.cos(ang2) * r)
        .addScaledVector(f.up, Math.sin(ang2) * r)
        .addScaledVector(f.dir, -z);
      const k = B();
      const color = k < 0.62 ? INK : k < 0.84 ? RED : GRAY;
      const W = (0.016 + Math.pow(B(), 3.4) * 0.4) * scale * (color === GRAY ? 0.7 : 1);
      batch.add([pt(ang, r0, zA * 0.4), pt(ang + bend * 0.5, r0 + len * 0.5, (zA + zB) * 0.5), pt(ang + bend, r0 + len, zB)], {
        color, width: blade(W, 0.18 + B() * 0.4), seed: B() * 100, dry: B() * 0.9, op: color === GRAY ? 0.5 : 0.94, delay: 0.25 + B() * 0.8, density: 6,
      });
    }
    for (let n = 0; n < count; n++) {
      const a = B() * Math.PI * 2;
      const r = (2.4 + Math.pow(B(), 0.6) * 7) * scale;
      const sp = C.clone().addScaledVector(f.right, Math.cos(a) * r).addScaledVector(f.up, Math.sin(a) * r * 0.85).addScaledVector(f.dir, (B() - 0.5) * 10);
      const d = f.right.clone().multiplyScalar(Math.cos(a)).addScaledVector(f.up, Math.sin(a)).multiplyScalar((0.02 + B() * 0.09) * scale);
      const W = (0.035 + Math.pow(B(), 2) * 0.08) * scale;
      batch.add([sp, sp.clone().add(d)], { color: B() < 0.85 ? INK : RED, width: () => W, seed: B() * 40, dry: 0, op: 0.85, delay: 0.6 + B() * 0.8, samples: 2 });
    }
  };

  const at = (id) => posters.findIndex((el) => el.id === id);
  if (tall) {
    burst(at('cover'), 195, 262, 7, 46, spread * 0.9);
    burst(at('contact'), 195, 262, 19, 34, spread);
  } else {
    burst(at('cover'), 1111.5, 400, 7, 70, spread, [0.45, 2.75], true);
    burst(at('contact'), 1111.5, 400, 19, 60, spread * 1.1, [0.7, 2.6], true);
    burst(at('profile'), 239.7, 488.9, 29, 30, spread * 0.8, [3.6, -2.6]);
  }

  /* fields: ink leaking out of the vertical word */
  if (!tall) {
    const i = at('fields');
    const f = frames[i];
    const B = rng(31);
    const C = onPoster(i, 190, 450, -18);
    for (let n = 0; n < 40; n++) {
      const ang = Math.PI * (0.55 + B() * 0.9);
      const len = (2 + Math.pow(B(), 1.6) * 12) * spread;
      const bend = (B() - 0.5) * 0.6;
      const base = C.clone().addScaledVector(f.up, (B() - 0.5) * 12 * spread).addScaledVector(f.dir, (B() - 0.5) * 6);
      const pt = (a, r, z) => base.clone().addScaledVector(f.right, Math.cos(a) * r).addScaledVector(f.up, Math.sin(a) * r * 1.4).addScaledVector(f.dir, -z);
      const color = B() < 0.72 ? INK : RED;
      batch.add([pt(ang, 0, 0), pt(ang + bend * 0.5, len * 0.5, (B() - 0.3) * 5), pt(ang + bend, len, (B() - 0.2) * 9)], {
        color, width: blade((0.016 + Math.pow(B(), 3) * 0.3) * spread, 0.15 + B() * 0.3), seed: B() * 90, dry: 0.6 + B() * 0.4, op: 0.9, delay: 0.4, density: 6,
      });
    }
  }

  return batch.mesh(material);
}

/* ---------------------------------------------------------------- ink material */

function makeInkMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.CustomBlending,       // ink multiplies into the paper
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
    vertexShader: /* glsl */`
      attribute vec3 tangent3;
      attribute float width;
      attribute float aV;
      attribute float aU;
      attribute vec3 inkColor;
      attribute vec4 meta;       // seed, length, dryness, opacity
      attribute float delay;
      uniform float uPx;
      uniform float uTime;
      varying float vU;
      varying float vV;
      varying vec3 vColor;
      varying vec4 vMeta;
      varying float vFade;
      varying float vDepth;
      varying float vReveal;
      void main() {
        vec4 c = modelViewMatrix * vec4(position, 1.0);
        float depth = max(0.05, -c.z);
        float hw = width * 0.5;
        float w = max(hw, 0.65 * uPx * depth);
        vFade = sqrt(hw / w);
        vec3 toEye = normalize(cameraPosition - position);
        vec3 side = cross(tangent3, toEye);
        float sl = length(side);
        side = sl > 1e-4 ? side / sl : vec3(0.0, 1.0, 0.0);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position + side * w * aV, 1.0);
        vU = aU; vV = aV; vColor = inkColor; vMeta = meta; vDepth = depth;
        float r = clamp((uTime - delay) / 2.2, 0.0, 1.0);
        vReveal = 1.0 - pow(1.0 - r, 3.0);
      }`,
    fragmentShader: /* glsl */`
      uniform float uFogNear;
      uniform float uFogFar;
      varying float vU;
      varying float vV;
      varying vec3 vColor;
      varying vec4 vMeta;
      varying float vFade;
      varying float vDepth;
      varying float vReveal;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      void main() {
        if (vU > vReveal) discard;
        float seed = vMeta.x;
        float along = vU * vMeta.y;
        float en = noise(vec2(along * 2.6 + seed * 17.0, seed)) * 0.6 + noise(vec2(along * 10.0, seed * 3.0)) * 0.4;
        float edge = 1.0 - smoothstep(0.5 + 0.38 * en, 1.0, abs(vV));
        float st = noise(vec2(along * 0.9 + seed * 5.0, vV * 5.0 + seed * 3.0));
        float dry = vMeta.z * smoothstep(0.05, 0.9, vU);
        float a = edge * mix(1.0, smoothstep(0.25, 0.58, st), dry) * vMeta.w * vFade;
        a *= 1.0 - smoothstep(uFogNear, uFogFar, vDepth);
        if (a < 0.004) discard;
        gl_FragColor = vec4(mix(vec3(1.0), vColor, a), 1.0);
      }`,
  });
}

class InkBatch {
  constructor() {
    this.a = { position: [], tangent3: [], width: [], aV: [], aU: [], inkColor: [], meta: [], delay: [] };
    this.index = [];
    this.count = 0;
  }

  add(points, o) {
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    const len = curve.getLength();
    const S = o.samples || clamp(Math.ceil(len * (o.density || 4)), 6, 9000);
    const base = this.count;
    const P = V(0, 0, 0), T = V(0, 0, 0);
    for (let i = 0; i <= S; i++) {
      const t = i / S;
      curve.getPointAt(t, P);
      curve.getTangentAt(t, T);
      const w = Math.max(0, o.width(t));
      for (const v of [-1, 1]) {
        this.a.position.push(P.x, P.y, P.z);
        this.a.tangent3.push(T.x, T.y, T.z);
        this.a.width.push(w);
        this.a.aV.push(v);
        this.a.aU.push(t);
        this.a.inkColor.push(o.color.r, o.color.g, o.color.b);
        this.a.meta.push(o.seed ?? 0, len, o.dry ?? 0.3, o.op ?? 1);
        this.a.delay.push(o.delay ?? 0);
      }
      if (i < S) {
        const k = base + i * 2;
        this.index.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    this.count += (S + 1) * 2;
  }

  mesh(material) {
    const g = new THREE.BufferGeometry();
    const sizes = { position: 3, tangent3: 3, width: 1, aV: 1, aU: 1, inkColor: 3, meta: 4, delay: 1 };
    for (const [name, arr] of Object.entries(this.a)) g.setAttribute(name, new THREE.Float32BufferAttribute(arr, sizes[name]));
    g.setIndex(this.index);
    const m = new THREE.Mesh(g, material);
    m.frustumCulled = false;
    return m;
  }
}

function shiftDelays(geometry, offset) {
  const attr = geometry.getAttribute('delay');
  for (let i = 0; i < attr.count; i++) attr.setX(i, attr.getX(i) + offset);
  attr.needsUpdate = true;
}

if (!REDUCED) start();
