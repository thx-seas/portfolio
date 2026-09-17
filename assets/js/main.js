/* ==========================================================================
   SEAS — ink tunnel, v6
   Scroll flies a camera along a winding path. Each poster's type and drawing
   are HTML layers placed at different depths and projected from 3D, so in
   flight they separate and at a stop they lock into one composition.
   The ink (lines, bursts, arcs, specks) is WebGL, printed on paper by print.js.
   ========================================================================== */
import * as THREE from 'three';
import Lenis from 'lenis';
import { V, UP, clamp, smooth, F, FOV, TAN0, posterFrames, makeBoard, buildPath } from './path.js?v=6';
import { makeInkMaterial } from './ink.js?v=6';
import { buildWorld } from './world.js?v=6';
import { makePrint } from './print.js?v=6';
import { makeSun } from './suns.js?v=6';

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const TALL = matchMedia('(max-aspect-ratio: 4/5)');
const SCROLL_PER_GAP = 1.6;     // viewport heights of scroll between two posters

const posters = [...document.querySelectorAll('.poster')];
const N = posters.length;

const BURSTS = {
  cover: { count: 140, scale: 1, dirs: [0.42, 2.8, -1.95] },
  about: { count: 64, scale: 0.9, dirs: [3.5, -2.5] },
  fields: { count: 46, scale: 1.6, dirs: [-0.5, 2.4] },
  works: { count: 60, scale: 2.6, dirs: [-0.6, 2.5, 1.6] },
  contact: { count: 160, scale: 1, dirs: [0.75, 2.55, -2.25] },
};

function readPoster(el, tall) {
  const [x, y, d] = (tall ? el.dataset.portalTall : el.dataset.portal).split(',').map(Number);
  const [disc, outer, cell, dot] = (tall ? el.dataset.sunTall : el.dataset.sun).split(',').map(Number);
  return {
    el,
    portal: { x, y, d },
    sun: { disc, outer, cell, dot, dom: el.hasAttribute('data-dom-sun') },
    sunR: disc,
    burst: BURSTS[el.id],
    rects: [],
  };
}

/* type boxes in artboard px, so the ink can keep clear of them */
function measureText(info, u) {
  info.rects = [];
  info.el.querySelectorAll('.layer[data-d="0"] .at, .layer[data-d="3"] .at').forEach((el) => {
    if (getComputedStyle(el).display === 'none') return;
    const w = el.offsetWidth / u, h = el.offsetHeight / u;
    if (w < 4 || h < 4) return;
    let x = el.offsetLeft / u;
    const y = el.offsetTop / u;
    if (el.classList.contains('ar')) x -= w;
    info.rects.push({ x, y, w, h });
  });
}

/* without the tunnel the posters stack as printed sheets; their discs are drawn here */
function paintStaticSuns() {
  const NS = 'http://www.w3.org/2000/svg';
  posters.forEach((el, n) => {
    if (el.hasAttribute('data-dom-sun')) return;
    const layer = document.createElement('div');
    layer.className = 'layer';
    layer.setAttribute('aria-hidden', 'true');
    for (const tall of [false, true]) {
      const [x, y] = (tall ? el.dataset.portalTall : el.dataset.portal).split(',').map(Number);
      const [disc, outer, cell, dot] = (tall ? el.dataset.sunTall : el.dataset.sun).split(',').map(Number);
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', `draft ${tall ? 'tall' : 'wide'}`);
      svg.setAttribute('viewBox', tall ? '0 0 390 760' : '0 0 1440 900');
      const id = `sun-${n}-${tall ? 't' : 'w'}`;
      svg.innerHTML = `<defs><pattern id="${id}" x="${x - cell / 2}" y="${y - cell / 2}" width="${cell}" height="${cell}" patternUnits="userSpaceOnUse">`
        + `<circle cx="${cell / 2}" cy="${cell / 2}" r="${dot}" class="dot"/></pattern></defs>`
        + `<circle cx="${x}" cy="${y}" r="${outer}" fill="url(#${id})"/><circle class="disc" cx="${x}" cy="${y}" r="${disc}"/>`;
      layer.appendChild(svg);
    }
    const sheet = el.querySelector('.sheet');
    const behind = [...sheet.children].find((c) => parseFloat(c.dataset.d) > -6 || c.querySelector('.hero, .paperfill'));
    sheet.insertBefore(layer, behind || null);
  });
}

function start() {
  let renderer;
  try {
    const canvas = document.getElementById('ink');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    if (!renderer.capabilities.isWebGL2) { renderer.dispose(); paintStaticSuns(); return; }
  } catch (e) { paintStaticSuns(); return; }

  THREE.ColorManagement.enabled = false;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.autoClear = true;
  document.body.classList.add('tunnel');

  const spacer = document.getElementById('spacer');
  const progressEl = document.getElementById('progress');
  const stopLinks = [...document.querySelectorAll('#stops [data-go]')];
  const coarse = matchMedia('(pointer: coarse)').matches;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 1200);
  const frames = posterFrames(N);
  const board = makeBoard(frames);

  const target = new THREE.WebGLRenderTarget(2, 2, { samples: coarse ? 2 : 4, depthBuffer: false });
  const print = makePrint();
  print.uniforms.tInk.value = target.texture;

  const inkUniforms = {
    uPx: { value: 0 }, uTime: { value: 0 }, uStretch: { value: 0 },
    uFogNear: { value: 55 }, uFogFar: { value: 175 }, uSunFogFar: { value: 200 },
    uVis: { value: new Array(8).fill(1) },
    uDrawn: { value: -1e6 },     // how far along the path the ink has been drawn in
  };
  const material = makeInkMaterial(inkUniforms);

  /* layers: each HTML layer sits at depth d in front of (+) or behind (−) its poster */
  const layers = posters.map((poster, i) =>
    [...poster.querySelectorAll('.layer')].map((el) => {
      const d = parseFloat(el.dataset.d) || 0;
      return { el, d, W: frames[i].P.clone().addScaledVector(frames[i].dir, -d), k: -1 };
    }));

  const drifts = [...document.querySelectorAll('.drift')].map((el) => ({
    el,
    gap: parseInt(el.dataset.gap, 10),
    t: parseFloat(el.dataset.t),
    off: el.dataset.off.split(',').map(Number),
    W: V(),
    w: 0, h: 0,
  }));

  let info = [];
  let path = null;
  let world = null;
  let suns = [];
  let built = false;
  let clock0 = performance.now();

  function rebuild() {
    const tall = TALL.matches;
    board.update(innerWidth, innerHeight, tall);
    info = posters.map((el) => readPoster(el, tall));
    info.forEach((po) => measureText(po, board.u));
    // the fixed header reads over every poster
    const sheetX = (innerWidth - board.aw * board.u) / 2, sheetY = (innerHeight - board.ah * board.u) / 2;
    document.querySelectorAll('.hud--top a').forEach((el) => {
      const r = el.getBoundingClientRect();
      const box = { x: (r.left - sheetX) / board.u, y: (r.top - sheetY) / board.u, w: r.width / board.u, h: r.height / board.u };
      info.forEach((po) => po.rects.push(box));
    });
    const portals = info.map((po, i) => board.point(i, po.portal.x, po.portal.y, po.portal.d));
    // the path runs straight through each poster, square to it; the discs sit where the
    // composition wants them, not where the camera goes
    const onPath = frames.map((f, i) => f.P.clone().addScaledVector(f.dir, -info[i].portal.d));
    path = buildPath(frames, onPath);
    if (world) { scene.remove(world); world.geometry.dispose(); }
    suns.forEach((m) => { scene.remove(m); m.geometry.dispose(); m.material.dispose(); });
    world = buildWorld({ material, path, frames, board, posters: info, tall, aspect: innerWidth / innerHeight });
    suns = info.map((po, i) => {
      const k = board.scale(po.portal.d);
      return makeSun({
        shared: { uDrawn: inkUniforms.uDrawn, uSunFogFar: inkUniforms.uSunFogFar },
        center: portals[i], frame: frames[i],
        disc: po.sun.disc * k, outer: po.sun.outer * k, cell: po.sun.cell * k, dot: po.sun.dot * k,
        draw: [path.portalS[i] - 112, 74],
      });
    });
    suns.forEach((m) => scene.add(m));
    const fh = F * TAN0, rx = fh * clamp(innerWidth / innerHeight, 0.78, 1.9);
    const T = V(), R = V(), U = V();
    drifts.forEach((dr) => {
      const s = path.stopS[dr.gap] + (path.stopS[dr.gap + 1] - path.stopS[dr.gap]) * dr.t;
      path.frame(s, T, R, U);
      path.at(s, dr.W).addScaledVector(R, dr.off[0] * rx).addScaledVector(U, dr.off[1] * fh);
      dr.w = dr.el.offsetWidth; dr.h = dr.el.offsetHeight;
    });
    if (!built) clock0 = performance.now();
    built = true;
    scene.add(world);
  }

  /* ------------------------------------------------------------ size */
  function layout() {
    const dpr = Math.min(devicePixelRatio || 1, coarse ? 2 : 1.75);
    renderer.setPixelRatio(dpr);
    renderer.setSize(innerWidth, innerHeight, false);
    target.setSize(Math.round(innerWidth * dpr), Math.round(innerHeight * dpr));
    camera.aspect = innerWidth / innerHeight;
    print.uniforms.uAspect.value = camera.aspect;
    spacer.style.height = `${innerHeight + (N - 1) * innerHeight * SCROLL_PER_GAP}px`;
  }
  layout();

  /* ------------------------------------------------------------ scroll */
  const lenis = new Lenis({ lerp: 0.08, wheelMultiplier: 0.9, touchMultiplier: 1.35, autoRaf: false });
  const limit = () => Math.max(1, spacer.offsetHeight - innerHeight);
  const goTo = (i, immediate = false) => {
    const y = (i / Math.max(1, N - 1)) * limit();
    const dist = Math.abs(y - lenis.scroll) / (innerHeight * SCROLL_PER_GAP);
    lenis.scrollTo(y, { immediate, duration: clamp(0.9 + dist * 0.55, 1, 3.2), easing: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2) });
  };

  const hashIndex = posters.findIndex((el) => `#${el.id}` === location.hash);
  if (hashIndex > 0) goTo(hashIndex, true);

  document.querySelectorAll('[data-go]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      goTo(parseInt(a.dataset.go, 10));
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

  let resizeT;
  let builtW = innerWidth, builtH = innerHeight;
  addEventListener('resize', () => {
    const keep = lenis.scroll / limit();
    layout();
    lenis.resize();
    lenis.scrollTo(keep * limit(), { immediate: true });
    // a phone's toolbar sliding in and out only changes the height a little: keep the ink as it is
    if (innerWidth === builtW && Math.abs(innerHeight - builtH) < 160 && TALL.matches === (builtH / builtW > 1.25)) return;
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { builtW = innerWidth; builtH = innerHeight; rebuild(); }, 180);
  });

  /* pointer: the frame leans a touch toward the cursor */
  const pointer = { x: 0, y: 0 };
  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    pointer.x = (e.clientX / innerWidth) * 2 - 1;
    pointer.y = (e.clientY / innerHeight) * 2 - 1;
  }, { passive: true });

  /* ------------------------------------------------------------ frame */
  const pos = V(), look = V(), tmp = V(), fwd = V(), aim = V(), right = V(), up = V();
  const T1 = V(), T2 = V(), hvel = V(), err = V();
  let heading = null;
  const lean = { x: 0, y: 0, vx: 0, vy: 0 };
  let last = performance.now();
  let speed = 0, fov = FOV, roll = 0, drawn = -1e6;
  let current = -1;

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    lenis.raf(now);

    if (!built) {
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.setRenderTarget(null);
      renderer.render(print.scene, print.camera);
      requestAnimationFrame(frame);
      return;
    }
    const t = (now - clock0) / 1000;

    const p = clamp(lenis.scroll / limit(), 0, 1);
    const vps = (lenis.velocity * 60) / innerHeight / SCROLL_PER_GAP;     // posters per second
    speed += (smooth(0.03, 1.6, Math.abs(vps)) - speed) * (1 - Math.exp(-dt * 7));

    const q = p * (N - 1);
    const s = path.sOf(q);

    // the ink is drawn in as the camera reaches it and stays drawn; on load it draws itself in
    const opening = clamp(t / 4, 0, 1);
    const introS = path.stopS[0] - 300 + 300 * opening * opening * (3 - 2 * opening);
    drawn = Math.max(drawn, opening < 1 ? Math.min(s, introS) : s);
    inkUniforms.uDrawn.value = drawn;
    path.at(s, pos);
    path.at(s + 10, look);

    // square to the poster when near it
    const n0 = clamp(Math.round(q), 0, N - 1);
    const lock = 1 - smooth(0, 0.5, Math.abs(q - n0));

    // where the camera wants to look: far down the path, averaged, so the dive into a
    // poster's disc is something it slides through rather than a corner it takes
    aim.set(0, 0, 0);
    for (const ahead of [20, 42, 70]) aim.add(path.at(s + ahead, tmp).sub(pos).normalize());
    aim.normalize().lerp(frames[n0].dir, lock).normalize();
    // and it swings onto that on a spring, so a turn eases in and eases out
    if (!heading) heading = aim.clone();
    err.copy(aim).sub(heading);
    hvel.addScaledVector(err, (8 + lock * 10) * dt).addScaledVector(hvel, -6 * dt);
    heading.addScaledVector(hvel, dt).normalize();
    fwd.copy(heading);

    // the view turns toward the cursor on a quick spring: the camera looks around from
    // where it stands, with a touch of travel for parallax between the depths
    const calm = 1 - speed * 0.55;
    const kx = pointer.x * 1.25 * calm + Math.sin(t * 0.21) * 0.06;
    const ky = -pointer.y * 0.8 * calm + Math.sin(t * 0.17 + 1.3) * 0.045;
    lean.vx += ((kx - lean.x) * 30 - lean.vx * 10.5) * dt;
    lean.vy += ((ky - lean.y) * 30 - lean.vy * 10.5) * dt;
    lean.x += lean.vx * dt;
    lean.y += lean.vy * dt;
    right.crossVectors(fwd, UP).normalize();
    up.crossVectors(right, fwd).normalize();
    look.copy(pos).addScaledVector(fwd, 12).addScaledVector(right, lean.x).addScaledVector(up, lean.y);
    pos.addScaledVector(right, lean.x * 0.2).addScaledVector(up, lean.y * 0.14);

    // bank into turns only while moving
    path.at(s - 6, tmp); T1.subVectors(path.at(s, V()), tmp).normalize();
    path.at(s + 6, tmp); T2.subVectors(tmp, path.at(s, V())).normalize();
    const turn = T1.x * T2.z - T1.z * T2.x;
    roll += (clamp(turn * 1.5, -0.075, 0.075) * speed - roll) * (1 - Math.exp(-dt * 2.6));

    fov += (FOV + speed * 15 - fov) * (1 - Math.exp(-dt * 5));
    const tan = Math.tan(THREE.MathUtils.degToRad(fov / 2));

    camera.fov = fov;
    camera.updateProjectionMatrix();
    camera.position.copy(pos);
    camera.up.copy(UP);
    camera.lookAt(look);
    camera.rotateZ(roll);
    camera.updateMatrixWorld();

    /* project the HTML layers */
    const hw = innerWidth / 2, hh = innerHeight / 2;
    const intro = smooth(0.15, 1.6, t);
    for (let n = 0; n < N; n++) {
      let near = false;
      for (let li = 0; li < layers[n].length; li++) {
        const Ly = layers[n][li];
        tmp.copy(Ly.W).applyMatrix4(camera.matrixWorldInverse);
        const depth = -tmp.z;
        let o = 0;
        if (depth > 0.6) {
          const sc = ((F - Ly.d) / depth) * (TAN0 / tan);
          const x = (tmp.x / (depth * tan * camera.aspect)) * hw;
          const y = (-tmp.y / (depth * tan)) * hh;
          o = Math.min(smooth(0.22, 0.5, sc), 1 - smooth(1.4, 3.2, sc));
          o *= 1 - smooth(0.72, 0.96, Math.abs(q - n));   // the poster ahead stays off the frame
          if (Math.abs(x) > innerWidth * 1.5 || Math.abs(y) > innerHeight * 1.5) o = 0;
          if (o > 0.001) {
            Ly.el.style.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0) rotate(${roll.toFixed(4)}rad) scale(${sc.toFixed(4)})`;
            let k = sc >= 1 ? 1 : smooth(0.42, 0.97, sc);
            if (n === 0) k = Math.min(k, clamp(intro * 1.25 - li * 0.08, 0, 1));
            if (Math.abs(k - Ly.k) > 0.002) { Ly.el.style.setProperty('--k', k.toFixed(3)); Ly.k = k; }
          }
        }
        Ly.el.style.opacity = o.toFixed(3);
        if (o > 0.001) near = true;
      }
      posters[n].classList.toggle('is-near', near);
      posters[n].classList.toggle('is-live', Math.abs(q - n) < 0.12);
    }

    /* drifting words: billboards at their place in the tunnel */
    for (const dr of drifts) {
      tmp.copy(dr.W).applyMatrix4(camera.matrixWorldInverse);
      const depth = -tmp.z;
      let o = 0;
      if (depth > 1) {
        const sc = (F / depth) * (TAN0 / tan);
        const x = (tmp.x / (depth * tan * camera.aspect)) * hw;
        const y = (-tmp.y / (depth * tan)) * hh;
        o = smooth(4, 12, depth) * (1 - smooth(80, 130, depth)) * (1 - smooth(0.36, 0.48, Math.abs(q - dr.gap - 0.5)));
        if (o > 0.001) {
          dr.el.style.transform = `translate3d(${(x - dr.w * sc / 2).toFixed(2)}px,${(y - dr.h * sc / 2).toFixed(2)}px,0) rotate(${roll.toFixed(4)}rad) scale(${sc.toFixed(4)})`;
        }
      }
      dr.el.style.opacity = o.toFixed(3);
    }

    const idx = Math.round(q);
    if (idx !== current) {
      current = idx;
      stopLinks.forEach((a) => a.setAttribute('aria-current', String(parseInt(a.dataset.go, 10) === idx)));
    }
    if (progressEl) progressEl.style.transform = `scaleX(${p.toFixed(4)})`;

    /* ink: a poster's disc and burst show up once you set off toward it, never behind the poster you stand at */
    for (let j = 0; j < N; j++) {
      const vis = 1 - smooth(0.74, 0.97, Math.abs(q - j));
      inkUniforms.uVis.value[j] = vis;
      if (suns[j]) suns[j].material.uniforms.uVis.value = vis;
    }
    inkUniforms.uPx.value = (2 * tan) / innerHeight;
    inkUniforms.uTime.value = t;
    inkUniforms.uStretch.value = speed * 1.6;

    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);

    /* print */
    path.at(s + 45, tmp).project(camera);
    const pu = print.uniforms;
    pu.uCenter.value.set(clamp(tmp.x * 0.5 + 0.5, 0.15, 0.85), clamp(tmp.y * 0.5 + 0.5, 0.15, 0.85));
    pu.uBlur.value = speed * 0.05;
    pu.uShift.value.set(0.0028 * speed, -0.0018 * speed);
    pu.uGrain.value = Math.floor(t * 12) % 64;
    renderer.setRenderTarget(null);
    renderer.render(print.scene, print.camera);

    requestAnimationFrame(frame);
  }

  const fontsReady = document.fonts ? Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2500))]) : Promise.resolve();
  fontsReady.then(() => { rebuild(); });
  TALL.addEventListener('change', () => { clearTimeout(resizeT); resizeT = setTimeout(rebuild, 60); });
  requestAnimationFrame(frame);
}

if (REDUCED) paintStaticSuns();
else start();
