/* The flight path.
   Posters hang along a winding line. In front of each poster the path is straight,
   so the camera arrives square to it; then it heads for the poster's red disc,
   passes straight through it and curves away to the next poster. */
import * as THREE from 'three';

export const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
export const UP = V(0, 1, 0);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const lerp = (a, b, t) => a + (b - a) * t;

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const F = 12;            // camera → poster plane at a stop
export const FOV = 44;
export const TAN0 = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
const GAP = 92;
const YAW = [0, 0.05, -0.035, 0.045, -0.02];
const PITCH = [0, 0.015, -0.012, 0.015, 0];

export function posterFrames(n) {
  const frames = [];
  for (let i = 0; i < n; i++) {
    const yaw = YAW[i % YAW.length], pitch = PITCH[i % PITCH.length];
    const dir = V(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).normalize();
    const P = i === 0 ? V()
      : frames[i - 1].P.clone().addScaledVector(frames[i - 1].dir.clone().add(dir).normalize(), GAP);
    const right = V().crossVectors(dir, UP).normalize();
    const up = V().crossVectors(right, dir).normalize();
    frames.push({ P, dir, right, up });
  }
  return frames;
}

/* Artboard → world. ax/ay in artboard px, d = layer depth (negative is further away). */
export function makeBoard(frames) {
  const board = {
    aw: 1440, ah: 900, u: 1, W: 1, H: 1,
    update(W, H, tall) {
      this.W = W; this.H = H;
      this.aw = tall ? 390 : 1440;
      this.ah = tall ? 760 : 900;
      this.u = Math.min(W / this.aw, H / this.ah);
    },
    /* world units per artboard px on a plane at layer depth d */
    scale(d) { return (2 * (F - d) * TAN0 / this.H) * this.u; },
    point(i, ax, ay, d, target = V()) {
      const f = frames[i];
      const k = this.scale(d);
      return target.copy(f.P)
        .addScaledVector(f.right, (ax - this.aw / 2) * k)
        .addScaledVector(f.up, -(ay - this.ah / 2) * k)
        .addScaledVector(f.dir, -d);
    },
    /* world point → artboard px, as seen from poster i's stop */
    project(i, W3, out = { x: 0, y: 0, depth: 0 }) {
      const f = frames[i];
      const rel = V().subVectors(W3, f.P).addScaledVector(f.dir, F);
      const depth = rel.dot(f.dir);
      const k = (F / Math.max(depth, 0.01)) / this.scale(0);
      out.x = this.aw / 2 + rel.dot(f.right) * k;
      out.y = this.ah / 2 - rel.dot(f.up) * k;
      out.depth = depth;
      return out;
    },
  };
  return board;
}

export function buildPath(frames, portals) {
  const n = frames.length;
  const pts = [];
  const stopIdx = [];
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    pts.push(f.P.clone().addScaledVector(f.dir, -(i === 0 ? F + 10 : F + 20)));
    stopIdx.push(pts.length);
    pts.push(f.P.clone().addScaledVector(f.dir, -F));
    const O = portals[i];
    pts.push(O.clone());
    pts.push(O.clone().addScaledVector(f.dir, 16));
  }
  const last = frames[n - 1];
  pts.push(portals[n - 1].clone().addScaledVector(last.dir, 70));
  pts.push(portals[n - 1].clone().addScaledVector(last.dir, 190));

  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const PER = 240;
  const M = (pts.length - 1) * PER;
  const samples = new Float32Array((M + 1) * 3);
  const lengths = new Float32Array(M + 1);
  const P = V(), Q = V();
  for (let j = 0; j <= M; j++) {
    curve.getPoint(j / M, P);
    samples[j * 3] = P.x; samples[j * 3 + 1] = P.y; samples[j * 3 + 2] = P.z;
    if (j > 0) lengths[j] = lengths[j - 1] + P.distanceTo(Q);
    Q.copy(P);
  }
  const length = lengths[M];
  const stopS = stopIdx.map((k) => lengths[k * PER]);
  const portalS = stopIdx.map((k) => lengths[(k + 1) * PER]);

  const at = (s, target = V()) => {
    s = clamp(s, 0, length);
    let lo = 0, hi = M;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (lengths[mid] < s) lo = mid; else hi = mid; }
    const t = (s - lengths[lo]) / (lengths[hi] - lengths[lo] || 1);
    return target.set(
      samples[lo * 3] + (samples[hi * 3] - samples[lo * 3]) * t,
      samples[lo * 3 + 1] + (samples[hi * 3 + 1] - samples[lo * 3 + 1]) * t,
      samples[lo * 3 + 2] + (samples[hi * 3 + 2] - samples[lo * 3 + 2]) * t,
    );
  };

  /* smooth local frame (tangent, right, up) at arc length s */
  const A = V(), B = V();
  const frame = (s, T = V(), R = V(), U = V()) => {
    at(s - 1.5, A); at(s + 1.5, B);
    T.subVectors(B, A).normalize();
    R.crossVectors(T, UP).normalize();
    U.crossVectors(R, T).normalize();
    return { T, R, U };
  };

  /* progress 0…n-1 → arc length, linear between stops */
  const sOf = (q) => {
    const i = clamp(Math.floor(q), 0, n - 2);
    return stopS[i] + (stopS[i + 1] - stopS[i]) * (q - i);
  };

  return { at, frame, sOf, stopS, portalS, length };
}
