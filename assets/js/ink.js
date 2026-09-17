/* Ink strokes as camera-facing ribbons.
   The shader writes ink *density* per plate into a render target:
   red channel = blood plate, green channel = black plate. The print pass
   (print.js) lays both plates on paper, so the red can slip out of register
   when the camera moves fast, the way a print does. */
import * as THREE from 'three';
import { V, clamp } from './path.js';

export function makeInkMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    // densities combine like layers of ink: 1 - (1 - a)(1 - b)
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcColorFactor,
    vertexShader: /* glsl */`
      attribute vec3 tangent3;
      attribute float width;
      attribute float aV;
      attribute float aU;
      attribute vec2 plate;      // blood, black
      attribute vec4 meta;       // seed, length, dryness, opacity
      attribute vec2 draw;       // arc length where this stroke starts drawing, and over what distance
      attribute vec3 fx;         // stretch with speed, heartbeat, breathing
      attribute float owner;     // poster index for ink that belongs to one poster, -1 otherwise
      uniform float uVis[8];
      varying float vVis;
      uniform float uPx;
      uniform float uTime;
      uniform float uStretch;
      uniform float uDrawn;      // furthest the camera has been along the path
      varying float vU;
      varying float vV;
      varying vec2 vPlate;
      varying vec4 vMeta;
      varying float vFade;
      varying float vDepth;
      varying float vReveal;
      varying float vBeat;

      float beatAt(float x) {
        // lub-dub, travelling away from the viewer along the line
        float ph = fract(x);
        return exp(-pow((ph - 0.05) / 0.012, 2.0)) + 0.55 * exp(-pow((ph - 0.1) / 0.014, 2.0));
      }

      void main() {
        float len = meta.y;
        vec3 p = position + tangent3 * (aU - 0.5) * len * uStretch * fx.x;

        float along = aU * len;
        float beat = fx.y > 0.0 ? fx.y * beatAt((along - uTime * 42.0) / 96.0) : 0.0;

        vec4 c = modelViewMatrix * vec4(p, 1.0);
        float depth = max(0.05, -c.z);
        float hw = width * 0.5 * (1.0 + beat * 1.1);
        float w = max(hw, 0.6 * uPx * depth);
        vFade = sqrt(hw / w);

        vec3 toEye = normalize(cameraPosition - p);
        vec3 side = cross(tangent3, toEye);
        float sl = length(side);
        side = sl > 1e-4 ? side / sl : vec3(0.0, 1.0, 0.0);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p + side * w * aV, 1.0);

        vU = aU; vV = aV; vPlate = plate; vMeta = meta; vDepth = depth; vBeat = beat;
        vVis = owner < 0.0 ? 1.0 : uVis[int(owner + 0.5)];
        float r = clamp((uDrawn - draw.x) / max(draw.y, 0.001), 0.0, 1.0);
        vReveal = 1.0 - pow(1.0 - r, 3.0);
        vReveal *= 1.0 - fx.z * (0.05 + 0.05 * sin(uTime * 0.7 + meta.x * 6.283));
      }`,
    fragmentShader: /* glsl */`
      uniform float uFogNear;
      uniform float uFogFar;
      varying float vU;
      varying float vV;
      varying vec2 vPlate;
      varying vec4 vMeta;
      varying float vFade;
      varying float vDepth;
      varying float vReveal;
      varying float vBeat;
      varying float vVis;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      void main() {
        if (vU > vReveal || vVis < 0.003) discard;
        float seed = vMeta.x;
        float along = vU * vMeta.y;
        // ragged edge
        float en = noise(vec2(along * 2.4 + seed * 17.0, seed)) * 0.6 + noise(vec2(along * 11.0, seed * 3.0)) * 0.4;
        float edge = 1.0 - smoothstep(0.46 + 0.4 * en, 1.0, abs(vV));
        // dry brush: bristle streaks that open up toward the tail
        float st = noise(vec2(along * 0.8 + seed * 5.0, vV * 6.0 + seed * 3.0));
        float dry = vMeta.z * smoothstep(0.0, 0.95, vU);
        float a = edge * mix(1.0, smoothstep(0.28, 0.6, st), dry) * vMeta.w * vFade;
        a = min(1.0, a * (1.0 + vBeat * 0.6));
        a *= (1.0 - smoothstep(uFogNear, uFogFar, vDepth)) * vVis;
        if (a < 0.004) discard;
        gl_FragColor = vec4(vPlate * a, 0.0, 1.0);
      }`,
  });
}

export const PLATE = {
  blood: [1, 0],
  ink: [0, 1],
  gray: [0, 0.42],
  pale: [0, 0.22],
  rust: [0.75, 0.25],
};

export class InkBatch {
  constructor() {
    this.a = { position: [], tangent3: [], width: [], aV: [], aU: [], plate: [], meta: [], draw: [], fx: [], owner: [] };
    this.index = [];
    this.count = 0;
  }

  /* points: Vector3[]; o: { width(t), plate, seed, dry, op, draw: [from, over], density, samples, fx } */
  add(points, o) {
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    const len = curve.getLength();
    if (len < 1e-4) return;
    const S = o.samples || clamp(Math.ceil(len * (o.density || 4)), 6, 12000);
    const base = this.count;
    const P = V(), T = V();
    const plate = o.plate || PLATE.ink;
    const fx = o.fx || [0, 0, 0];
    const draw = o.draw || [-1e6, 1];
    const a = this.a;
    for (let i = 0; i <= S; i++) {
      const t = i / S;
      curve.getPointAt(t, P);
      curve.getTangentAt(t, T);
      const w = Math.max(0, o.width(t));
      for (const v of [-1, 1]) {
        a.position.push(P.x, P.y, P.z);
        a.tangent3.push(T.x, T.y, T.z);
        a.width.push(w);
        a.aV.push(v);
        a.aU.push(t);
        a.plate.push(plate[0], plate[1]);
        a.meta.push(o.seed ?? 0, len, o.dry ?? 0.3, o.op ?? 1);
        a.draw.push(draw[0], draw[1]);
        a.fx.push(fx[0], fx[1], fx[2]);
        a.owner.push(o.owner ?? -1);
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
    const sizes = { position: 3, tangent3: 3, width: 1, aV: 1, aU: 1, plate: 2, meta: 4, draw: 2, fx: 3, owner: 1 };
    for (const [name, arr] of Object.entries(this.a)) g.setAttribute(name, new THREE.Float32BufferAttribute(arr, sizes[name]));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.index, 1) : new THREE.Uint16BufferAttribute(this.index, 1));
    const m = new THREE.Mesh(g, material);
    m.frustumCulled = false;
    return m;
  }
}

/* width profiles */
export const blade = (W, peak = 0.3) => (t) => W * (t < peak ? Math.pow(t / peak, 0.7) : Math.pow((1 - t) / (1 - peak), 1.35));
export const brush = (W, swell = 0.35) => (t) => W * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.8)), 0.55) * (1 + swell * Math.sin(t * 7.1));
