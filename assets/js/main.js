/* ==========================================================================
   SEAS — ink tunnel
   Free flight: scroll moves a camera down a paper tunnel, no snapping. Every
   section is a poster whose DOM layers hang at very different depths, so they
   drift apart in flight and line up into one composition when you arrive.
   Thin blood-red ink lines run the whole length of the path.
   ========================================================================== */
import * as THREE from 'three';

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const TALL = matchMedia('(max-aspect-ratio: 4/5)');

const posters = [...document.querySelectorAll('.poster')];
const N = posters.length;
const canvas = document.getElementById('ink');
const spacer = document.getElementById('spacer');
const playhead = document.getElementById('playhead');
const stopLinks = [...document.querySelectorAll('#stops [data-go]')];

const FOV = 44;
const TAN0 = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
const F = 12;     // camera → poster distance when you are "on" a poster
const GAP = 64;   // distance between posters
const SCROLL_PER_GAP = 1.7; // viewport heights of scrolling per poster
const stopZ = (i) => -i * GAP;

const PAPER = 0xEDEBE6;
const INK = new THREE.Color('#141414');
const BLOOD = new THREE.Color('#8C0C07');
const RED = new THREE.Color('#B8190F');
const GRAY = new THREE.Color('#8E8B85');

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const AXIS_Z = V(0, 0, 1);

/* seeded random: the drawing is composed once and stays the same on every visit */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* blade profile: sharp tips, belly at `peak` */
const blade = (W, peak) => (t) => W * (t < peak ? Math.pow(t / peak, 0.7) : Math.pow((1 - t) / (1 - peak), 1.35));

/* ---------------------------------------------------------------- init */

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
  scene.fog = new THREE.Fog(PAPER, 34, 190);
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 500);

  const inkUniforms = {
    uPx: { value: 0 },
    uTime: { value: 0 },
    uFogNear: { value: 40 },
    uFogFar: { value: 230 },
  };
  const inkMaterial = makeInkMaterial(inkUniforms);

  const layers = posters.map((poster) =>
    [...poster.querySelectorAll('.layer')].map((el) => ({ el, d: parseFloat(el.dataset.d) || 0 })));

  let world = null;
  let revealed = false;
  const t0 = performance.now();

  /* ------------------------------------------------------------ layout */
  let targetP = 0;
  let p = 0;
  const maxScroll = () => Math.max(1, spacer.offsetHeight - innerHeight);

  function layout() {
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    spacer.style.height = `${innerHeight + (N - 1) * innerHeight * SCROLL_PER_GAP}px`;
  }

  function rebuild() {
    if (world) {
      scene.remove(world);
      world.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material && o.material !== inkMaterial) o.material.dispose();
      });
    }
    world = buildWorld(inkMaterial, posters);
    if (revealed) world.traverse((o) => { if (o.userData.ink) shiftDelays(o.geometry, -100); });
    revealed = true;
    scene.add(world);
  }

  layout();
  rebuild();

  const hashIndex = posters.findIndex((el) => `#${el.id}` === location.hash);
  if (hashIndex > 0) scrollTo(0, (hashIndex / (N - 1)) * maxScroll());
  readScroll();
  p = targetP;

  let resizeT;
  addEventListener('resize', () => {
    const keep = p;
    layout();
    scrollTo(0, keep * maxScroll());
    clearTimeout(resizeT);
    resizeT = setTimeout(rebuild, 180);
  });

  /* ------------------------------------------------------------ input */
  function readScroll() { targetP = N > 1 ? clamp(scrollY / maxScroll(), 0, 1) : 0; }
  addEventListener('scroll', readScroll, { passive: true });

  let mx = 0, my = 0, mxs = 0, mys = 0;
  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    mx = (e.clientX / innerWidth) * 2 - 1;
    my = (e.clientY / innerHeight) * 2 - 1;
  }, { passive: true });

  document.querySelectorAll('[data-go]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const i = parseInt(a.dataset.go, 10);
      scrollTo({ top: (i / Math.max(1, N - 1)) * maxScroll(), behavior: 'smooth' });
      history.replaceState(null, '', a.getAttribute('href'));
    });
  });

  document.querySelectorAll('[data-copy]').forEach((btn) => {
    const label = btn.querySelector('[data-copy-label]');
    btn.addEventListener('click', () => {
      const done = () => { label.textContent = 'copied ✓'; setTimeout(() => { label.textContent = 'copy'; }, 1600); };
      if (navigator.clipboard) navigator.clipboard.writeText(btn.dataset.copy).then(done, done);
      else done();
    });
  });

  /* ------------------------------------------------------------ frame */
  let last = performance.now();
  let current = -1;
  let fov = FOV;

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const prev = p;
    p += (targetP - p) * (1 - Math.exp(-dt * 4.2));
    if (Math.abs(targetP - p) < 1e-6) p = targetP;
    const vel = (p - prev) / Math.max(dt, 1e-3);      // progress per second
    mxs += (mx - mxs) * (1 - Math.exp(-dt * 3.5));
    mys += (my - mys) * (1 - Math.exp(-dt * 3.5));

    const q = p * (N - 1);
    const sway = Math.sin(q * Math.PI);                 // zero on every poster
    const camZ = F - q * GAP;
    const camX = sway * 2.2 + mxs * 0.75;
    const camY = -sway * 0.7 - mys * 0.45;
    const roll = sway * 0.035 + clamp(vel * 0.05, -0.06, 0.06);

    // speed kick, like the old flythrough
    const fovT = FOV + Math.min(9, Math.abs(vel) * 18);
    fov += (fovT - fov) * (1 - Math.exp(-dt * 6));
    const TAN = Math.tan(THREE.MathUtils.degToRad(fov / 2));

    camera.fov = fov;
    camera.updateProjectionMatrix();
    camera.position.set(camX, camY, camZ);
    camera.rotation.set(0, 0, roll);

    for (let i = 0; i < N; i++) {
      let near = false;
      for (const L of layers[i]) {
        const dist = camZ - (stopZ(i) + L.d);
        let o = 0;
        if (dist > 1.2) {
          const s = ((F - L.d) / dist) * (TAN0 / TAN);
          o = Math.min(smooth(0.3, 0.6, s), 1 - smooth(1.3, 3.4, s));
          if (o > 0.001) {
            const ppw = innerHeight / (2 * dist * TAN);
            L.el.style.transform =
              `translate3d(${(-camX * ppw).toFixed(2)}px,${(camY * ppw).toFixed(2)}px,0) rotate(${roll.toFixed(4)}rad) scale(${s.toFixed(4)})`;
          }
        }
        L.el.style.opacity = o.toFixed(3);
        if (o > 0.001) near = true;
      }
      posters[i].classList.toggle('is-near', near);
      posters[i].classList.toggle('is-live', Math.abs(q - i) < 0.14);
    }

    const idx = Math.round(q);
    if (idx !== current) {
      current = idx;
      stopLinks.forEach((a) => a.setAttribute('aria-current', String(parseInt(a.dataset.go, 10) === idx)));
    }
    if (playhead) playhead.style.left = `${(p * 100).toFixed(3)}%`;

    inkUniforms.uPx.value = (2 * TAN) / innerHeight;
    inkUniforms.uTime.value = (now - t0) / 1000;
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/* ---------------------------------------------------------------- ink material */

function makeInkMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    // ink multiplies into the paper
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
    vertexShader: /* glsl */`
      attribute vec3 side;
      attribute float width;
      attribute float aV;
      attribute float aU;
      attribute vec3 inkColor;
      attribute vec4 meta;     // seed, length, dryness, opacity
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
        float w = max(hw, 0.7 * uPx * depth);   // never thinner than ~1.4px: fade instead of aliasing
        vFade = sqrt(hw / w);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position + side * w * aV, 1.0);
        vU = aU; vV = aV; vColor = inkColor; vMeta = meta; vDepth = depth;
        float r = clamp((uTime - delay) / 1.4, 0.0, 1.0);
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
        float en = noise(vec2(along * 2.4 + seed * 17.0, seed)) * 0.6 + noise(vec2(along * 9.0, seed * 3.0)) * 0.4;
        float edge = 1.0 - smoothstep(0.5 + 0.38 * en, 1.0, abs(vV));
        float s = noise(vec2(along * 0.8 + seed * 5.0, vV * 5.5 + seed * 3.0));
        float dry = vMeta.z * smoothstep(0.1, 0.95, vU);
        float a = edge * mix(1.0, smoothstep(0.28, 0.6, s), dry) * vMeta.w * vFade;
        a *= 1.0 - smoothstep(uFogNear, uFogFar, vDepth);
        if (a < 0.004) discard;
        gl_FragColor = vec4(mix(vec3(1.0), vColor, a), 1.0);
      }`,
  });
}

/* ---------------------------------------------------------------- ink batch */

class InkBatch {
  constructor() {
    this.a = { position: [], side: [], width: [], aV: [], aU: [], inkColor: [], meta: [], delay: [] };
    this.index = [];
    this.count = 0;
  }

  /* points: Vector3[] · o: { width(t), color, hint: 'z' | 'axis', seed, dry, op, delay, density } */
  add(points, o) {
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    const len = curve.getLength();
    const S = o.samples || clamp(Math.ceil(len * (o.density || 10)), 6, 1400);
    const base = this.count;
    const P = V(0, 0, 0), T = V(0, 0, 0), H = V(0, 0, 0), side = V(0, 0, 0);
    for (let i = 0; i <= S; i++) {
      const t = i / S;
      curve.getPointAt(t, P);
      curve.getTangentAt(t, T);
      if (o.hint === 'axis') {
        H.set(P.x, P.y, 0);
        if (H.lengthSq() < 1e-4) H.set(0, 1, 0);
        H.normalize();
      } else H.copy(AXIS_Z);
      side.crossVectors(T, H);
      if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
      side.normalize();
      const w = Math.max(0, o.width(t));
      for (const v of [-1, 1]) {
        this.a.position.push(P.x, P.y, P.z);
        this.a.side.push(side.x, side.y, side.z);
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
    const sizes = { position: 3, side: 3, width: 1, aV: 1, aU: 1, inkColor: 3, meta: 4, delay: 1 };
    for (const [name, arr] of Object.entries(this.a)) g.setAttribute(name, new THREE.Float32BufferAttribute(arr, sizes[name]));
    g.setIndex(this.index);
    const m = new THREE.Mesh(g, material);
    m.frustumCulled = false;
    m.userData.ink = true;
    return m;
  }
}

function shiftDelays(geometry, offset) {
  const attr = geometry.getAttribute('delay');
  for (let i = 0; i < attr.count; i++) attr.setX(i, attr.getX(i) + offset);
  attr.needsUpdate = true;
}

/* ---------------------------------------------------------------- world */

function sheetMetrics() {
  const tall = TALL.matches;
  const aw = tall ? 390 : 1440;
  const ah = tall ? 760 : 900;
  const sheet = posters[0].querySelector('.sheet');
  return { tall, aw, ah, u: sheet.offsetWidth / aw };
}

/* artboard px → world point on poster i, dz toward the camera (+) or away (−) */
function toWorld(ax, ay, i, dz, m) {
  const dist = F - dz;
  const wpp = (2 * dist * TAN0) / innerHeight;
  return V((ax - m.aw / 2) * m.u * wpp, -(ay - m.ah / 2) * m.u * wpp, stopZ(i) + dz);
}

const hair = (color, opacity) => new THREE.LineBasicMaterial({ color, transparent: true, opacity });
const lineOf = (pts, mat) => new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
const segsOf = (pts, mat) => new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), mat);
function arcPts(cx, cy, rx, ry, a0, a1, n, z) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push(V(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, z));
  }
  return pts;
}

function buildWorld(material, posterEls) {
  const group = new THREE.Group();
  const m = sheetMetrics();
  const aspect = innerWidth / innerHeight;
  const ey = F * TAN0;           // frame half-height on a poster
  const ex = ey * aspect;        // frame half-width
  const spread = clamp(ex / 7.8, 0.42, 1.25);
  const zStart = F + 6;
  const zEnd = stopZ(N - 1) - 120;
  const ink = new InkBatch();

  /* ---- blood lines: thin red ink running the whole way, like rails ---- */
  const LR = rng(11);
  const rails = [
    { x: -1.02, y: -0.74, w: 0.055, seed: 1 },
    { x: 1.02, y: -0.74, w: 0.055, seed: 2 },
    { x: -1.22, y: 0.9, w: 0.034, seed: 3 },
    { x: 0.64, y: 1.08, w: 0.026, seed: 4 },
  ];
  for (const r of rails) {
    const pts = [];
    const ph = LR() * 6;
    for (let z = zStart; z >= zEnd; z -= 6) {
      pts.push(V(
        (r.x + Math.sin(z * 0.011 + ph) * 0.05) * ex,
        (r.y + Math.sin(z * 0.017 + ph * 2) * 0.035) * ey,
        z,
      ));
    }
    const swells = Array.from({ length: 12 }, () => [LR(), 0.0015 + LR() * 0.004, 0.02 + LR() * 0.09]);
    ink.add(pts, {
      hint: 'axis', color: BLOOD, seed: r.seed * 13.7, dry: 0.22, op: 1, delay: 0.05 * r.seed, density: 1.6,
      width: (t) => {
        let w = r.w;
        for (const [c, s, a] of swells) w += a * Math.exp(-Math.pow((t - c) / s, 2));
        return w * spread;
      },
    });
  }
  // one life line that slowly winds around the path
  {
    const pts = [];
    for (let z = zStart; z >= zEnd; z -= 4) {
      const a = 2.2 + z * 0.021;
      const k = 1.08 + Math.sin(z * 0.013) * 0.12;
      pts.push(V(Math.cos(a) * ex * k, Math.sin(a) * ey * k, z));
    }
    ink.add(pts, { hint: 'axis', color: BLOOD, seed: 71, dry: 0.4, op: 0.9, delay: 0.3, density: 1.4, width: () => 0.03 * spread });
  }

  // companion hairlines + ruler ticks under the floor lines
  const railHair = hair(0x141414, 0.3);
  const tickHair = hair(0x141414, 0.42);
  for (const sx of [-1, 1]) {
    const x = sx * 1.12 * ex, y = -0.74 * ey;
    group.add(lineOf([V(x, y, zStart), V(x, y, zEnd)], railHair));
    const ticks = [];
    for (let z = zStart, i = 0; z >= zEnd; z -= 3, i++) {
      const l = (i % 5 === 0 ? 0.12 : 0.05) * ex;
      ticks.push(V(x, y, z), V(x - sx * l, y, z));
    }
    group.add(segsOf(ticks, tickHair));
  }

  /* ---- drafting rings between posters ---- */
  const ringHair = hair(0x141414, 0.24);
  const ringTick = hair(0x141414, 0.36);
  const ringRed = hair(0x9E120C, 0.75);
  for (let i = 0; i < N; i++) {
    const z = stopZ(i) - GAP * 0.5;
    const r = ey * 1.35;
    group.add(lineOf(arcPts(0, 0, r, r, 0, Math.PI * 2, 180, z), ringHair));
    const ticks = [];
    for (let j = 0; j < 72; j++) {
      const a = (j / 72) * Math.PI * 2;
      const l = j % 6 === 0 ? 0.08 : 0.03;
      ticks.push(V(Math.cos(a) * r, Math.sin(a) * r, z), V(Math.cos(a) * r * (1 - l), Math.sin(a) * r * (1 - l), z));
    }
    group.add(segsOf(ticks, ringTick));
    group.add(lineOf(arcPts(0, 0, r * 1.04, r * 1.04, 0.5 + i * 1.3, 1.4 + i * 1.3, 30, z), ringRed));
  }

  /* ---- golden-section plates floating off the path ---- */
  const PHI = 1.618;
  const plateLines = [[0, 0, PHI, 0], [PHI, 0, PHI, 1], [PHI, 1, 0, 1], [0, 1, 0, 0], [1, 0, 1, 1],
    [1, 0.382, PHI, 0.382], [1.236, 0, 1.236, 0.382], [1, 0.236, 1.236, 0.236], [1.146, 0.236, 1.146, 0.382]];
  const plateArcs = [[1, 0, 1, Math.PI, Math.PI / 2], [1, 0.382, 0.618, Math.PI / 2, 0], [1.236, 0.382, 0.382, 0, -Math.PI / 2],
    [1.236, 0.236, 0.236, -Math.PI / 2, -Math.PI], [1.146, 0.236, 0.146, Math.PI, Math.PI / 2]];
  const plateHair = hair(0x141414, 0.3);
  const plateInk = hair(0x141414, 0.7);
  [[-1.5, 0.62, 0.3, 4.6], [1.55, -0.2, 0.52, 3.8], [-1.6, -0.45, 0.72, 5.2], [1.45, 0.55, 0.9, 4.2]].forEach(([fx, fy, f, s]) => {
    const z = stopZ(0) - (N - 1) * GAP * f;
    const ox = fx * ex, oy = fy * ey;
    const seg = [];
    for (const [x1, y1, x2, y2] of plateLines) {
      seg.push(V(ox + (x1 - PHI / 2) * s, oy + (y1 - 0.5) * s, z), V(ox + (x2 - PHI / 2) * s, oy + (y2 - 0.5) * s, z));
    }
    group.add(segsOf(seg, plateHair));
    let spiral = [];
    for (const [cx, cy, r, a0, a1] of plateArcs) spiral = spiral.concat(arcPts(ox + (cx - PHI / 2) * s, oy + (cy - 0.5) * s, r * s, r * s, a0, a1, 24, z));
    group.add(lineOf(spiral, plateInk));
  });

  /* ---- hair strokes streaming along the edges ---- */
  const HR = rng(23);
  for (let n = 0; n < 110; n++) {
    const z = zStart - HR() * (zStart - zEnd);
    const a = HR() * Math.PI * 2;
    const r = 1.15 + HR() * 1.4;
    const len = 4 + HR() * 16;
    const x = Math.cos(a) * ex * r, y = Math.sin(a) * ey * r;
    const drift = (HR() - 0.5) * 1.4;
    const color = HR() < 0.8 ? INK : GRAY;
    ink.add([V(x, y, z), V(x + drift * 0.5, y + drift * 0.2, z - len * 0.5), V(x + drift, y + drift * 0.5, z - len)], {
      hint: 'axis', color, width: blade((0.012 + Math.pow(HR(), 3) * 0.1) * spread, 0.2 + HR() * 0.5),
      seed: HR() * 80, dry: 0.7, op: 0.8, delay: 0.4 + HR() * 0.8,
    });
  }

  /* ---- poster ink ---- */
  posterEls.forEach((poster, i) => {
    if (poster.id === 'cover') burst(ink, toWorld(m.tall ? 195 : 1018, m.tall ? 210 : 404, i, -13, m), spread, m, 7, m.tall ? 46 : 84);
    if (poster.id === 'fields') fieldsInk(ink, i, m, spread);
    if (poster.id === 'contact') burst(ink, toWorld(m.tall ? 286 : 1080, m.tall ? 262 : 420, i, -15, m), spread * 1.1, m, 19, m.tall ? 30 : 56);
  });

  group.add(ink.mesh(material));
  return group;
}

/* ONETRUXX-style burst, spread deep in z so it opens up as you fly in */
function burst(batch, C, spread, m, seed, count) {
  const R = rng(seed);
  for (let n = 0; n < count; n++) {
    let ang = R() * Math.PI * 2;
    if (R() < 0.5) ang = (R() < 0.55 ? -0.62 : 2.5) + (R() - 0.5) * 0.9;
    const dir = V(Math.cos(ang), Math.sin(ang), 0);
    const r0 = (R() < 0.2 ? 0.2 + R() * 0.8 : 2.4 + R() * 2.4) * spread;
    const len = (1.5 + Math.pow(R(), 1.7) * 14) * spread;
    const bend = (R() - 0.5) * 0.75;
    const zA = (R() - 0.5) * 12;
    const zB = zA + (R() - 0.3) * 14;
    const p0 = C.clone().addScaledVector(dir, r0).setZ(C.z + zA * 0.4);
    const p1 = C.clone().addScaledVector(dir.clone().applyAxisAngle(AXIS_Z, bend * 0.5), r0 + len * 0.5).setZ(C.z + (zA + zB) * 0.5);
    const p2 = C.clone().addScaledVector(dir.clone().applyAxisAngle(AXIS_Z, bend), r0 + len).setZ(C.z + zB);
    const k = R();
    const color = k < 0.62 ? INK : k < 0.84 ? RED : GRAY;
    const W = (0.014 + Math.pow(R(), 3.4) * 0.36) * spread * (color === GRAY ? 0.7 : 1);
    batch.add([p0, p1, p2], {
      hint: 'z', color, width: blade(W, 0.18 + R() * 0.4),
      seed: R() * 100, dry: R() * 0.9, op: color === GRAY ? 0.5 : 0.94, delay: 0.2 + R() * 0.7,
    });
  }
  // speckle
  for (let n = 0; n < count; n++) {
    const a = R() * Math.PI * 2;
    const r = (2.2 + Math.pow(R(), 0.6) * 6) * spread;
    const P = C.clone().add(V(Math.cos(a) * r, Math.sin(a) * r * 0.8, (R() - 0.5) * 10));
    const d = V(Math.cos(a), Math.sin(a), 0).multiplyScalar((0.02 + R() * 0.08) * spread);
    const W = (0.03 + Math.pow(R(), 2) * 0.07) * spread;
    batch.add([P, P.clone().add(d)], {
      hint: 'z', color: R() < 0.85 ? INK : RED, width: () => W, seed: R() * 40, dry: 0, op: 0.85, delay: 0.5 + R() * 0.8, samples: 2,
    });
  }
}

/* 02 — ink leaking out of the vertical word */
function fieldsInk(batch, i, m, spread) {
  const R = rng(31);
  const C = toWorld(m.tall ? 50 : 220, m.tall ? 250 : 450, i, -14, m);
  for (let n = 0; n < (m.tall ? 22 : 40); n++) {
    const ang = Math.PI * (0.55 + R() * 0.9);
    const dir = V(Math.cos(ang), Math.sin(ang) * 1.6, 0).normalize();
    const len = (2 + Math.pow(R(), 1.6) * 11) * spread;
    const bend = (R() - 0.5) * 0.6;
    const p0 = C.clone().add(V(0, (R() - 0.5) * 12 * spread, (R() - 0.5) * 6));
    const p1 = p0.clone().addScaledVector(dir.clone().applyAxisAngle(AXIS_Z, bend * 0.5), len * 0.5).setZ(p0.z + (R() - 0.3) * 5);
    const p2 = p0.clone().addScaledVector(dir.clone().applyAxisAngle(AXIS_Z, bend), len).setZ(p0.z + (R() - 0.2) * 9);
    const color = R() < 0.72 ? INK : RED;
    batch.add([p0, p1, p2], {
      hint: 'z', color, width: blade((0.016 + Math.pow(R(), 3) * 0.3) * spread, 0.15 + R() * 0.3),
      seed: R() * 90, dry: 0.6 + R() * 0.4, op: 0.9, delay: 0.3,
    });
  }
}

if (!REDUCED) start();
