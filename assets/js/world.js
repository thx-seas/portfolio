/* Everything drawn in ink along the flight:
   - life lines: blood-red strokes that run the whole path, twisting around it between posters
   - bursts: the shaggy explosion of pointed strokes around each poster's red disc
   - brush arcs: big dry-brush circles you fly through between posters
   - speed strokes and ink specks streaming past the camera */
import { V, clamp, smooth, lerp, rng, F } from './path.js';
import { InkBatch, PLATE, blade, brush } from './ink.js';

const TAU = Math.PI * 2;

export function buildWorld({ material, path, frames, board, posters, tall, aspect }) {
  const batch = new InkBatch();
  const n = frames.length;
  const fh = F * Math.tan((44 / 2) * Math.PI / 180);
  const rx = fh * Math.max(0.78, Math.min(aspect, 1.9));
  const ry = fh;
  const T = V(), R = V(), U = V(), P = V(), Q = V();
  const mobile = tall || board.W < 700;

  /* ink draws itself as the camera comes up on it: from LEAD ahead, over OVER of travel */
  const LEAD = 78, OVER = 34, LINE_LEAD = 190;
  const drawAt = (s) => [s - LEAD, OVER];

  /* ---- text keeps clear: world point → is it over type on the poster it is seen from? ---- */
  const seen = { x: 0, y: 0, depth: 0 };
  const overText = (W3, i, pad = 12) => {
    if (i < 0 || i >= n) return false;
    board.project(i, W3, seen);
    if (seen.depth < 2 || seen.depth > 90) return false;
    for (const r of posters[i].rects) {
      if (seen.x > r.x - pad && seen.x < r.x + r.w + pad && seen.y > r.y - pad && seen.y < r.y + r.h + pad) return true;
    }
    return false;
  };
  /* which poster's stop looks at arc length s (the last stop behind it) */
  const viewerOf = (s) => {
    let i = -1;
    for (let k = 0; k < n; k++) if (path.stopS[k] <= s + 1) i = k;
    return i;
  };
  /* cut a polyline where it first runs into type; returns null if too little is left */
  const clipToText = (pts, i, minKeep = 3) => {
    for (let k = 0; k < pts.length; k++) {
      if (overText(pts[k], i)) return k >= minKeep ? pts.slice(0, k) : null;
    }
    return pts;
  };

  /* ---- twist of the lines around the path: still at posters, turning in between ---- */
  const TWIST = Math.PI * 0.62;
  const twist = (s) => {
    const st = path.stopS;
    if (s <= st[0]) return 0;
    for (let k = 0; k < n - 1; k++) {
      if (s < st[k + 1]) return TWIST * (k + smooth(0.12, 0.88, (s - st[k]) / (st[k + 1] - st[k])));
    }
    return TWIST * (n - 1);
  };
  /* extra radius just past each poster so the lines open around the composition */
  const flare = (s) => {
    let f = 0;
    for (const st of path.stopS) f += Math.exp(-Math.pow((s - st - 14) / 16, 2));
    return 1 + f * 0.55;
  };

  /* ================================================================ life lines */
  const lines = [
    { th: -2.3, k: 1.02, w: 0.06, plate: PLATE.blood, dry: 0.25, op: 1, seed: 3, beat: 1, strand: true },
    { th: -0.72, k: 1.12, w: 0.028, plate: PLATE.blood, dry: 0.4, op: 0.95, seed: 9, beat: 0.8, strand: true },
    { th: 0.9, k: 1.3, w: 0.014, plate: PLATE.ink, dry: 0.55, op: 0.85, seed: 17, beat: 0 },
    { th: 2.25, k: 1.42, w: 0.011, plate: PLATE.blood, dry: 0.5, op: 0.8, seed: 23, beat: 0.6 },
    { th: -1.55, k: 1.75, w: 0.009, plate: PLATE.gray, dry: 0.3, op: 0.8, seed: 31, beat: 0 },
    { th: 0.15, k: 1.95, w: 0.022, plate: PLATE.ink, dry: 0.75, op: 0.9, seed: 37, beat: 0 },
    { th: 1.62, k: 2.3, w: 0.013, plate: PLATE.blood, dry: 0.45, op: 0.85, seed: 41, beat: 0.5 },
  ];
  const L = rng(5);
  const s0 = Math.max(0, path.stopS[0] - 8);
  for (const ln of lines) {
    const pts = [];
    const strand = [];
    const swells = Array.from({ length: 26 }, () => [L(), 0.002 + L() * 0.004, 0.02 + L() * 0.09]);
    for (let s = s0; s <= path.length - 4; s += 1.4) {
      path.frame(s, T, R, U);
      path.at(s, P);
      const th = ln.th + twist(s) + Math.sin(s * 0.021 + ln.seed) * 0.12;
      const k = ln.k * flare(s) * (1 + Math.sin(s * 0.033 + ln.seed * 2) * 0.05);
      const pt = P.clone().addScaledVector(R, Math.cos(th) * rx * k).addScaledVector(U, Math.sin(th) * ry * k);
      pts.push(pt);
      if (ln.strand) {
        const drift = 0.05 + 0.12 * Math.max(0, Math.sin(s * 0.011 + ln.seed));
        strand.push(P.clone()
          .addScaledVector(R, Math.cos(th + drift * 0.5) * rx * (k + drift))
          .addScaledVector(U, Math.sin(th + drift * 0.5) * ry * (k + drift)));
      }
    }
    batch.add(pts, {
      plate: ln.plate, seed: ln.seed, dry: ln.dry, op: ln.op, draw: [s0 - LINE_LEAD, path.length - s0], density: 1.3, fx: [0, ln.beat, 0],
      width: (t) => {
        let w = ln.w * (0.72 + 0.56 * Math.pow(0.5 + 0.5 * Math.sin(t * 97 + ln.seed), 2));
        for (const [c, sd, a] of swells) w += a * Math.exp(-Math.pow((t - c) / sd, 2)) * (ln.w / 0.06);
        return w;
      },
    });
    if (strand.length) {
      batch.add(strand, { plate: ln.plate, seed: ln.seed + 40, dry: 0.65, op: 0.7, draw: [s0 - LINE_LEAD * 0.8, path.length - s0], density: 1.1, width: () => 0.009 });
    }
  }

  /* ================================================================ bursts */
  const B = rng(101);
  posters.forEach((po, i) => {
    const cfg = po.burst;
    if (!cfg) return;
    const f = frames[i];
    const d = po.portal.d;
    const C = board.point(i, po.portal.x, po.portal.y, d);
    const Rw = po.sunR * board.scale(d) * cfg.scale;
    const reach = cfg.len ?? 1, thick = cfg.width ?? 1, black = cfg.black ?? 0.55;
    const count = Math.round(cfg.count * (mobile ? 0.7 : 1));
    const burstDraw = drawAt(path.portalS[i]);
    const pick = () => {
      if (cfg.dirs && B() < 0.55) return cfg.dirs[Math.floor(B() * cfg.dirs.length)] + (B() - 0.5) * 0.75;
      return B() * TAU;
    };
    const at = (ang, r, z, out = V()) => out.copy(C)
      .addScaledVector(f.right, Math.cos(ang) * r)
      .addScaledVector(f.up, Math.sin(ang) * r)
      .addScaledVector(f.dir, -z);

    for (let m = 0; m < count; m++) {
      const kind = B();
      const ang = pick();
      const c = B();
      let pts = [];
      let o;
      if (kind < 0.58) {
        // pointed radial blade
        const r0 = Rw * (0.84 + B() * 0.4);
        const len = Rw * (0.45 + Math.pow(B(), 1.6) * 5.4) * reach;
        const bend = (B() - 0.5) * 0.8;
        const z0 = (B() - 0.5) * Rw * 0.8;
        const z1 = z0 + (B() - 0.3) * Rw * 3.6;
        for (let k = 0; k <= 28; k++) {
          const t = k / 28;
          pts.push(at(ang + bend * Math.pow(t, 1.5), r0 + len * t, lerp(z0, z1, t)));
        }
        const W = Rw * (0.012 + Math.pow(B(), 3.2) * 0.15) * thick;
        o = {
          plate: c < black ? PLATE.ink : c < black + 0.3 ? PLATE.blood : PLATE.gray,
          width: blade(W, 0.1 + B() * 0.35), dry: B() * 0.9, op: 0.95, density: 6, fx: [0, 0, 1],
        };
      } else if (kind < 0.78) {
        // sweeping curve around the disc
        const dirn = B() < 0.5 ? -1 : 1;
        const sweep = 0.5 + B() * 1.5;
        const rA = Rw * (1.1 + B() * 0.6), rB = Rw * (1.5 + B() * 2.2 * reach);
        const z0 = (B() - 0.5) * Rw, z1 = z0 + (B() - 0.4) * Rw * 2.5;
        for (let k = 0; k <= 28; k++) {
          const t = k / 28;
          pts.push(at(ang + dirn * sweep * t, lerp(rA, rB, Math.pow(t, 1.4)), lerp(z0, z1, t)));
        }
        const W = Rw * (0.01 + Math.pow(B(), 2) * 0.06) * thick;
        o = { plate: c < 0.6 + (0.55 - black) ? PLATE.blood : PLATE.ink, width: blade(W, 0.35 + B() * 0.3), dry: 0.3 + B() * 0.5, op: 0.95, density: 6, fx: [0, 0, 1] };
      } else {
        // long hair
        const r0 = Rw * (0.95 + B() * 0.5);
        const len = Rw * (2 + B() * 6) * reach;
        const bend = (B() - 0.5) * 0.25;
        const z0 = (B() - 0.5) * Rw, z1 = z0 + (B() - 0.3) * Rw * 4;
        for (let k = 0; k <= 28; k++) {
          const t = k / 28;
          pts.push(at(ang + bend * t, r0 + len * t, lerp(z0, z1, t)));
        }
        o = { plate: c < black * 0.9 ? PLATE.ink : c < 0.85 ? PLATE.gray : PLATE.blood, width: () => Rw * 0.005 * thick, dry: 0.2, op: 0.8, density: 3, fx: [0, 0, 1] };
      }
      pts = clipToText(pts, i, 6);
      if (!pts) continue;
      batch.add(pts, { ...o, seed: B() * 100, draw: [burstDraw[0] + B() * 12, OVER], owner: i });
    }

    // splatter
    for (let m = 0; m < count * 0.8; m++) {
      const a = pick();
      const r = Rw * (1.15 + Math.pow(B(), 0.7) * 3.6 * reach);
      const z = (B() - 0.5) * Rw * 2;
      const p0 = at(a, r, z);
      if (overText(p0, i, 6)) continue;
      const size = Rw * (0.012 + Math.pow(B(), 4) * 0.07);
      const p1 = at(a + (B() - 0.5) * 0.02, r + size * (1 + B() * 3), z);
      batch.add([p0, p1], { plate: B() < 0.8 ? PLATE.ink : PLATE.blood, width: blade(size, 0.35), seed: B() * 40, dry: 0, op: 0.9, draw: [burstDraw[0] + 8 + B() * 14, OVER], samples: 4, owner: i });
    }
  });

  /* ================================================================ brush arcs */
  const A = rng(57);
  for (let g = 0; g < n - 1; g++) {
    const s = lerp(path.stopS[g], path.stopS[g + 1], 0.5 + A() * 0.18);
    path.frame(s, T, R, U);
    const C = path.at(s, V());
    const tilt = (A() - 0.5) * 0.5;
    const Rr = R.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(T, Math.sin(tilt));
    const radius = fh * (1.7 + A() * 0.5) * Math.max(1, aspect * 0.62);
    const a0 = A() * TAU;
    const sweep = TAU * (0.55 + A() * 0.22);
    const ring = (rad, from, span, samples) => {
      const pts = [];
      for (let k = 0; k <= samples; k++) {
        const th = from + span * (k / samples);
        const wob = 1 + Math.sin(th * 3 + g) * 0.025;
        pts.push(C.clone().addScaledVector(Rr, Math.cos(th) * rad * wob).addScaledVector(U, Math.sin(th) * rad * wob));
      }
      return pts;
    };
    const red = g === 1;
    batch.add(ring(radius, a0, sweep, 64), {
      plate: red ? PLATE.blood : PLATE.ink, width: brush(fh * (red ? 0.05 : 0.075), 0.3), seed: 60 + g * 7, dry: 0.85, op: 1, draw: drawAt(s), density: 2,
    });
    for (let h = 0; h < 3; h++) {
      batch.add(ring(radius * (1.07 + h * 0.055), a0 + sweep * (0.4 + A() * 0.4), TAU * (0.12 + A() * 0.25), 40), {
        plate: h === 1 ? PLATE.blood : PLATE.gray, width: () => fh * 0.004, seed: 90 + g * 3 + h, dry: 0.1, op: 0.9, draw: [s - LEAD + 6, OVER], density: 2,
      });
    }
  }

  /* ================================================================ blooms: loose bursts off the path */
  const Bl = rng(313);
  for (let g = 0; g < n - 1; g++) {
    const blooms = mobile ? 3 : 4;
    for (let b = 0; b < blooms; b++) {
      const s = lerp(path.stopS[g] + 22, path.stopS[g + 1] - 26, (b + 0.2 + Bl() * 0.6) / blooms);
      path.frame(s, T, R, U);
      const Cb = path.at(s, V());
      const a = Bl() * TAU;
      const kk = 1.25 + Bl() * 1.2;
      Cb.addScaledVector(R, Math.cos(a) * rx * kk).addScaledVector(U, Math.sin(a) * ry * kk);
      const size = fh * (0.35 + Bl() * 0.45);
      const main = a + Math.PI + (Bl() - 0.5) * 1.2;          // spray back toward the path
      const strokes = 18 + Math.floor(Bl() * 14);
      const i = viewerOf(s);
      for (let m = 0; m < strokes; m++) {
        const ang = Bl() < 0.6 ? main + (Bl() - 0.5) * 1.6 : Bl() * TAU;
        const r0 = size * (0.1 + Bl() * 0.3);
        const len = size * (0.4 + Math.pow(Bl(), 1.5) * 3.2);
        const bend = (Bl() - 0.5) * 0.9;
        const zt = (Bl() - 0.5) * size * 3;
        const pts = [];
        for (let k = 0; k <= 10; k++) {
          const t = k / 10;
          const an = ang + bend * t;
          pts.push(Cb.clone()
            .addScaledVector(R, Math.cos(an) * (r0 + len * t))
            .addScaledVector(U, Math.sin(an) * (r0 + len * t))
            .addScaledVector(T, zt * t));
        }
        if (pts.some((p) => overText(p, i))) continue;
        const c = Bl();
        batch.add(pts, {
          plate: c < 0.6 ? PLATE.ink : c < 0.85 ? PLATE.blood : PLATE.gray,
          width: blade(size * (0.01 + Math.pow(Bl(), 3) * 0.12), 0.1 + Bl() * 0.4),
          seed: Bl() * 90, dry: Bl() * 0.9, op: 0.92, draw: [s - LEAD + Bl() * 10, OVER], density: 5, fx: [0.4, 0, 1],
        });
      }
    }
  }

  /* ================================================================ speed strokes */
  const S = rng(23);
  const strokeCount = mobile ? 420 : 760;
  for (let m = 0; m < strokeCount; m++) {
    const s = lerp(path.stopS[0] + 3, path.length - 40, S());
    path.frame(s, T, R, U);
    path.at(s, P);
    const a = S() * TAU;
    const k = 1.05 * Math.pow(3, S());
    const base = P.clone().addScaledVector(R, Math.cos(a) * rx * k).addScaledVector(U, Math.sin(a) * ry * k);
    const len = 2 + Math.pow(S(), 1.5) * 18;
    const bend = (S() - 0.5) * 1.2;
    const pts = [
      base,
      base.clone().addScaledVector(T, len * 0.5).addScaledVector(R, bend * 0.35),
      base.clone().addScaledVector(T, len).addScaledVector(R, bend),
    ];
    const i = viewerOf(s);
    if (pts.some((p) => overText(p, i))) continue;
    const c = S();
    batch.add(pts, {
      plate: c < 0.66 ? PLATE.ink : c < 0.86 ? PLATE.gray : PLATE.blood,
      width: blade(0.01 + Math.pow(S(), 2.4) * 0.13, 0.15 + S() * 0.5),
      seed: S() * 80, dry: 0.7, op: 0.85, draw: drawAt(s), density: 3, fx: [1, 0, 0],
    });
  }

  /* ================================================================ specks */
  const D = rng(77);
  const speckCount = mobile ? 900 : 1600;
  for (let m = 0; m < speckCount; m++) {
    const s = lerp(path.stopS[0] - 4, path.length - 30, D());
    path.frame(s, T, R, U);
    path.at(s, P);
    const a = D() * TAU;
    const k = 0.4 + Math.pow(D(), 1.6) * 2.6;
    const p0 = P.clone().addScaledVector(R, Math.cos(a) * rx * k).addScaledVector(U, Math.sin(a) * ry * k)
      .addScaledVector(T, (D() - 0.5) * 2);
    // nothing floats in front of a poster's face
    let near = false;
    for (const st of path.stopS) if (Math.abs(s - st) < 26 && k < 1.25) near = true;
    if (near) continue;
    if (overText(p0, viewerOf(s), 4)) continue;
    const size = 0.02 + Math.pow(D(), 4) * 0.22;
    const p1 = Q.copy(p0).addScaledVector(T, size * (1.2 + D() * 1.5)).clone();
    batch.add([p0, p1], {
      plate: D() < 0.86 ? PLATE.ink : PLATE.blood, width: blade(size, 0.4), seed: D() * 50, dry: 0, op: 0.9,
      draw: drawAt(s), samples: 4, fx: [1.4, 0, 0],
    });
  }

  return batch.mesh(material);
}

export { clamp };
