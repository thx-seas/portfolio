/* The red discs with their halftone halo, printed on the blood plate.
   Each one is the doorway to the next poster: the path runs straight through it,
   and it dissolves as the camera passes. */
import * as THREE from 'three';

export function makeSun({ shared, center, frame, disc, outer, cell, dot, delay = 0 }) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      uDisc: { value: disc },
      uOuter: { value: outer },
      uCell: { value: cell },
      uDot: { value: dot },
      uDelay: { value: delay },
      uCenter: { value: center.clone() },
      uVis: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcColorFactor,
    vertexShader: /* glsl */`
      uniform float uOuter;
      varying vec2 vLocal;
      varying float vDepth;
      void main() {
        vLocal = position.xy * uOuter * 1.02;
        vec4 c = modelViewMatrix * vec4(vLocal, 0.0, 1.0);
        vDepth = -c.z;
        gl_Position = projectionMatrix * c;
      }`,
    fragmentShader: /* glsl */`
      uniform float uDisc;
      uniform float uOuter;
      uniform float uCell;
      uniform float uDot;
      uniform float uTime;
      uniform float uDelay;
      uniform vec3 uCenter;
      uniform float uSunFogFar;
      uniform float uVis;
      varying vec2 vLocal;
      varying float vDepth;
      void main() {
        float grow = clamp((uTime - uDelay) / 1.1, 0.0, 1.0);
        grow = 1.0 - pow(1.0 - grow, 3.0);
        float growDots = clamp((uTime - uDelay - 0.35) / 1.2, 0.0, 1.0);

        float r = length(vLocal);
        float aa = fwidth(r) * 0.75;
        float R = uDisc * grow;
        float disc = 1.0 - smoothstep(R - aa, R + aa, r);

        vec2 g = mod(vLocal + uCell * 0.5, uCell) - uCell * 0.5;
        float dr = length(g);
        float daa = fwidth(dr) * 0.75;
        float dotR = uDot * smoothstep(0.0, 1.0, growDots * 1.6 - (r / uOuter) * 0.6);
        float dots = 1.0 - smoothstep(dotR - daa, dotR + daa, dr);
        float ring = 1.0 - smoothstep(uOuter - aa, uOuter + aa, r);

        // flying in, the solid disc gives way first and you pass through the halftone
        float dist = distance(cameraPosition, uCenter);
        float d = max(disc * smoothstep(3.0, 15.0, dist), dots * ring * smoothstep(1.0, 5.0, dist));
        d *= (1.0 - smoothstep(uSunFogFar * 0.45, uSunFogFar, vDepth)) * uVis;
        if (d < 0.003) discard;
        gl_FragColor = vec4(d, 0.0, 0.0, 1.0);
      }`,
  });
  material.extensions = { derivatives: true };
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  const basis = new THREE.Matrix4().makeBasis(frame.right, frame.up, frame.dir.clone().negate());
  mesh.quaternion.setFromRotationMatrix(basis);
  mesh.position.copy(center);
  return mesh;
}
