/* The print pass: lays the two ink plates on paper.
   At rest it is a clean print with paper tooth and grain. In flight the ink smears
   toward the vanishing point and the blood plate slips out of register. */
import * as THREE from 'three';

export function makePrint() {
  const uniforms = {
    tInk: { value: null },
    uAspect: { value: 1 },
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uBlur: { value: 0 },
    uShift: { value: new THREE.Vector2() },
    uGrain: { value: 0 },
    uPaper: { value: new THREE.Color('#ECEAE4') },
    uBlood: { value: new THREE.Color('#8C0E08') },
    uInk: { value: new THREE.Color('#141414') },
    uTexel: { value: new THREE.Vector2(1, 1) },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform sampler2D tInk;
      uniform float uAspect;
      uniform vec2 uCenter;
      uniform float uBlur;
      uniform vec2 uShift;
      uniform float uGrain;
      uniform vec3 uPaper;
      uniform vec3 uBlood;
      uniform vec3 uInk;
      uniform vec2 uTexel;
      varying vec2 vUv;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
        return v;
      }

      vec2 plates(vec2 uv) {
        vec2 d = vec2(0.0);
        if (uBlur < 0.0005) {
          d.y = texture2D(tInk, uv).g;
          d.x = texture2D(tInk, uv + uShift).r;
          return d;
        }
        float wsum = 0.0;
        vec2 dir = uv - uCenter;
        for (int i = 0; i < 12; i++) {
          float t = float(i) / 11.0;
          float wt = 1.0 - t * 0.88;
          vec2 q = uCenter + dir * (1.0 - uBlur * t);
          d.y += texture2D(tInk, q).g * wt;
          d.x += texture2D(tInk, q + uShift).r * wt;
          wsum += wt;
        }
        return d / wsum;
      }

      void main() {
        vec2 d = clamp(plates(vUv), 0.0, 1.0);

        vec2 p = vUv * vec2(uAspect, 1.0);
        float mottle = fbm(p * 2.4 + 3.1);
        float fibre = noise(vec2(p.x * 380.0, p.y * 38.0)) * 0.5 + noise(vec2(p.x * 40.0, p.y * 420.0)) * 0.5;
        float grain = hash(floor(gl_FragCoord.xy) + uGrain);
        float tooth = noise(gl_FragCoord.xy * 0.42 + uGrain * 0.0);

        vec3 paper = uPaper * (0.968 + 0.05 * mottle) * (0.988 + 0.02 * fibre) * (0.982 + 0.03 * grain);

        // ink sits in the paper tooth: thin coverage breaks up, solid coverage stays solid
        float red = d.x * mix(0.82, 1.0, smoothstep(0.0, 0.7, tooth + d.x * 0.6));
        float blk = d.y * mix(0.82, 1.0, smoothstep(0.0, 0.7, tooth + d.y * 0.6));

        vec3 col = paper * mix(vec3(1.0), uBlood, red) * mix(vec3(1.0), uInk, blk);

        float vig = length((vUv - 0.5) * vec2(uAspect, 1.0));
        col *= 1.0 - 0.06 * smoothstep(0.45, 1.2, vig);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  return { scene, camera, uniforms };
}
