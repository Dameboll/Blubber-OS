'use client';

/**
 * BackgroundField — a genuinely FULL, alive 3D background. Three composited
 * layers rendered through an EffectComposer + bloom, back to front:
 *
 *   Layer 0 — domain-warped FBM nebula (fullscreen shader). The continuous
 *             glowing "substance" that fixes "empty": mostly near-black with
 *             bright green filaments, no countable gaps.
 *   Layer 1 — 2,500 huge soft dust blobs. Kills the black gaps between the
 *             sharp particles, cheap volumetric floor.
 *   Layer 2 — 90,000 curl-noise flow-field particles. The alive layer: a deep
 *             volume of points flowing along a curl-noise field, animated
 *             entirely in the vertex shader (buffers never touched per frame),
 *             with a near/mid/far color+size depth ramp and rare teal accents.
 *
 * On top: UnrealBloom (high threshold so only bright things bloom), a center
 * "dark well" that carves a pool of darkness the orb floats in (keeps the orb
 * dominant), an edge vignette, exponential fog so the far field dissolves into
 * black, cursor parallax + grab-drag push, and one 0-1 `intensity` uniform
 * (music/activity) that makes the whole field breathe.
 *
 * Fixed + full-viewport, mounted once near the root so it stays pinned behind
 * every section. Works because `body` is kept free of filter/opacity/transform
 * (see globals.css) — otherwise body would become the containing block for its
 * fixed descendants.
 *
 * Reference: build spec synthesized from a 3-agent research workflow (IQ FBM
 * domain warp, Ashima simplex + Bridson curl noise, additive volumetric
 * particle fields).
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
// NOTE: EffectComposer + UnrealBloomPass were removed for performance — the
// multi-pass full-res bloom was a major cost on this machine. The glow now
// comes purely from additive particle overdraw + the nebula's own brightness,
// rendered in a single direct pass. Cheaper and smoother.

// Perf: the old 90k particles (18 noise calls each) + 2,500 huge additive
// blobs caused massive vertex-noise cost AND fill-rate/overdraw lag. The
// fullscreen nebula shader now carries the "fullness" (cheap, per-pixel,
// covers every corner including the top); particles are a much lighter
// "alive sparkle" layer on top with far cheaper flow math.
const DUST_COUNT = 600;
const FLOW_COUNT = 14000;

// Orb sits in the upper-center of the viewport (command-deck is the top ~52vh).
// This is where the "dark well" is carved so the bright orb keeps dominance.
// In screen UV with y measured from the BOTTOM (gl_FragCoord convention).
const ORB_NDC = new THREE.Vector2(0.5, 0.72);

// Grab-drag push (same gesture as the orb) applied to the whole field's camera.
const DRAG_PULL_STRENGTH = 1.4;
const DRAG_PULL_MAX = 1.6;
const DRAG_LERP_ENGAGE = 8;
const DRAG_LERP_RELEASE = 2.6;
const PARALLAX = 3.0;

export interface BackgroundFieldProps {
  /** 0..1, same combined usage+audio intensity Core3D's orb reacts to. */
  intensity?: number;
}

// ---- shared GLSL: Ashima simplex noise (3D) + Bridson curl ----
const GLSL_SIMPLEX = /* glsl */ `
vec3 mod289(vec3 x){return x - floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x - floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
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
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ *ns.x + ns.yyyy;
  vec4 y = y_ *ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
vec3 snoiseVec3(vec3 x){
  float s  = snoise(x);
  float s1 = snoise(vec3(x.y - 19.1, x.z + 33.4, x.x + 47.2));
  float s2 = snoise(vec3(x.z + 74.2, x.x - 124.5, x.y + 99.4));
  return vec3(s, s1, s2);
}
vec3 curlNoise(vec3 p){
  const float e = 0.1;
  vec3 dx = vec3(e, 0.0, 0.0);
  vec3 dy = vec3(0.0, e, 0.0);
  vec3 dz = vec3(0.0, 0.0, e);
  vec3 p_x0 = snoiseVec3(p - dx); vec3 p_x1 = snoiseVec3(p + dx);
  vec3 p_y0 = snoiseVec3(p - dy); vec3 p_y1 = snoiseVec3(p + dy);
  vec3 p_z0 = snoiseVec3(p - dz); vec3 p_z1 = snoiseVec3(p + dz);
  float x = p_y1.z - p_y0.z - p_z1.y + p_z0.y;
  float y = p_z1.x - p_z0.x - p_x1.z + p_x0.z;
  float z = p_x1.y - p_x0.y - p_y1.x + p_y0.x;
  return normalize(vec3(x, y, z) / (2.0 * e));
}
`;

// ---- Layer 0: domain-warped FBM nebula (fullscreen triangle) ----
const NEBULA_VERT = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
const NEBULA_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform float uIntensity;
uniform vec2 uResolution;
uniform vec2 uOrbNDC;
uniform vec2 uMouse;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vnoise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f*f*(3.0 - 2.0*f);
  return mix(a, b, u.x) + (c - a)*u.y*(1.0 - u.x) + (d - b)*u.x*u.y;
}
mat2 rot = mat2(1.6, 1.2, -1.2, 1.6);
float fbm(vec2 p){
  // 3 octaves (was 5) — big perf win in the fragment shader (runs per-pixel).
  float s = 0.0; float a = 0.5;
  for(int i = 0; i < 3; i++){ s += a * vnoise(p); p = rot * p; a *= 0.5; }
  return s;
}
void main(){
  vec2 uv = vUv;
  float aspect = uResolution.x / uResolution.y;
  vec2 auv = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);

  // one domain-warp layer (was two) — 3 fbm calls per pixel instead of 5.
  vec2 p = uv * 3.0;
  float t = uTime * mix(0.03, 0.09, uIntensity);
  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3 - t)));
  float f = fbm(p + 3.5*q);
  vec2 r = q; // reuse warp vector for the hot-filament tint below

  // Locked middle brightness: visible green substance everywhere (incl. top),
  // clearly dimmer than the orb, no wash-out. No more bright/dark oscillation.
  float shade = f*f*0.7 + 0.55*f + 0.16;

  vec3 col = vec3(0.02, 0.08, 0.045);
  col = mix(col, vec3(0.04, 0.24, 0.11), clamp(f, 0.0, 1.0));
  col = mix(col, vec3(0.11, 0.52, 0.23), clamp(length(q) * 0.75, 0.0, 1.0));
  col = mix(col, vec3(0.32, 0.86, 0.42), clamp(r.x*r.x*0.9, 0.0, 1.0));

  col *= shade * (0.6 + 0.4 * uIntensity);
  // guaranteed ambient floor so no region is ever fully black
  col += vec3(0.010, 0.030, 0.016);

  // cursor bloom
  vec2 mouseUv = vec2((uMouse.x*0.5 + 0.5 - 0.5) * aspect, uMouse.y*0.5 + 0.5 - 0.5);
  col += vec3(0.05, 0.20, 0.09) * smoothstep(0.30, 0.0, length(auv - mouseUv)) * 0.35;

  // center dark well (orb dominance) — smaller + shallower so it dims behind
  // the orb without carving a huge empty hole. Floor at 0.35 so it never goes
  // fully black there. + edge vignette.
  vec2 orbUv = vec2((uOrbNDC.x - 0.5) * aspect, uOrbNDC.y - 0.5);
  float d = length(auv - orbUv);
  col *= mix(0.35, 1.0, smoothstep(0.0, 0.30, d));
  col *= 1.0 - smoothstep(1.15, 1.65, d);

  // grain — OLED banding killer
  col += (hash(gl_FragCoord.xy + uTime) - 0.5) * 0.015;

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

// ---- shared point fragment: soft radial sprite + screen-space dark well ----
const POINT_FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vAlpha;
varying vec2 vScreen;
uniform vec2 uOrbNDC;
uniform float uAspect;
void main(){
  float d = length(gl_PointCoord - 0.5);
  float sprite = smoothstep(0.5, 0.0, d);
  // screen-space dark well so particles also thin out behind the orb
  vec2 auv = vec2((vScreen.x - 0.5) * uAspect, vScreen.y - 0.5);
  vec2 orbUv = vec2((uOrbNDC.x - 0.5) * uAspect, uOrbNDC.y - 0.5);
  float well = mix(0.4, 1.0, smoothstep(0.0, 0.30, length(auv - orbUv)));
  gl_FragColor = vec4(vColor, sprite * vAlpha * well);
}
`;

// ---- Layer 2: curl flow-field points ----
const FLOW_VERT = /* glsl */ `
precision highp float;
attribute float aScale;
attribute float aBrightness;
attribute float aAccent;
varying vec3 vColor;
varying float vAlpha;
varying vec2 vScreen;
uniform float uTime;
uniform float uIntensity;
uniform float uSize;
uniform float uPixelRatio;
uniform float uFlowStrength;
uniform float uTimeScale;
uniform float uNoiseScale;
${GLSL_SIMPLEX}
void main(){
  vec3 home = position;
  // Cheap organic flow: one snoiseVec3 (3 noise calls) as a drift direction,
  // instead of a true curl (18 calls). Reads the same at this scale and is 6x
  // cheaper — the difference between smooth and laggy at this particle count.
  vec3 flow = snoiseVec3(home * uNoiseScale + vec3(0.0, 0.0, uTime * uTimeScale)) * uFlowStrength;
  vec3 pos = home + flow;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  // near/mid/far color ramp by depth
  float depth = clamp((-mv.z - 8.0) / 55.0, 0.0, 1.0); // 0 near, 1 far
  vec3 far  = vec3(0.06, 0.22, 0.11);
  vec3 mid  = vec3(0.16, 0.55, 0.26);
  vec3 near = vec3(0.35, 0.95, 0.45);
  vec3 c = mix(near, mid, smoothstep(0.0, 0.5, depth));
  c = mix(c, far, smoothstep(0.5, 1.0, depth));
  // ~4% teal accents for chromatic life
  c = mix(c, vec3(0.20, 0.72, 0.72), step(0.96, aAccent));
  vColor = c * aBrightness;

  // alpha ceiling — brightness comes from additive overlap, stays green
  vAlpha = mix(0.34, 0.09, depth);

  // fog: far field dissolves to black
  float fog = exp(-max(-mv.z - 10.0, 0.0) * 0.010);
  vAlpha *= fog;

  gl_PointSize = uSize * aScale * uPixelRatio * (60.0 / max(-mv.z, 1.0)) * (0.9 + uIntensity * 0.35);

  vScreen = gl_Position.xy / gl_Position.w * 0.5 + 0.5;
}
`;

// ---- Layer 1: dust points (big soft floor) ----
const DUST_VERT = /* glsl */ `
precision highp float;
attribute float aScale;
varying vec3 vColor;
varying float vAlpha;
varying vec2 vScreen;
uniform float uTime;
uniform float uIntensity;
uniform float uPixelRatio;
void main(){
  vec3 pos = position;
  pos.x += sin(uTime * 0.15 + position.y * 0.1) * 1.5;
  pos.y += cos(uTime * 0.12 + position.x * 0.1) * 1.2;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  vColor = vec3(0.11, 0.36, 0.18);
  vAlpha = (0.05 + 0.03 * uIntensity);
  gl_PointSize = (90.0 + aScale * 130.0) * uPixelRatio * (40.0 / max(-mv.z, 1.0));
  vScreen = gl_Position.xy / gl_Position.w * 0.5 + 0.5;
}
`;

export default function BackgroundField({ intensity = 0 }: BackgroundFieldProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const intensityRef = useRef(intensity);

  useEffect(() => {
    intensityRef.current = Math.min(1, Math.max(0, intensity));
  }, [intensity]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const pixelRatio = Math.min(window.devicePixelRatio, 2);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x0d0d0d, 0.012);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
    camera.position.set(0, 0, 10);

    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
    renderer.setClearColor(0x0d0d0d, 1);
    renderer.setPixelRatio(pixelRatio);
    container.appendChild(renderer.domElement);

    const uMouse = new THREE.Vector2(0, 0);
    const uOrbNDC = ORB_NDC.clone();

    // ---- Layer 0: nebula fullscreen triangle ----
    const nebGeo = new THREE.BufferGeometry();
    nebGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
    );
    const nebUniforms = {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uOrbNDC: { value: uOrbNDC },
      uMouse: { value: uMouse },
    };
    const nebMat = new THREE.ShaderMaterial({
      vertexShader: NEBULA_VERT,
      fragmentShader: NEBULA_FRAG,
      uniforms: nebUniforms,
      depthTest: false,
      depthWrite: false,
    });
    const nebMesh = new THREE.Mesh(nebGeo, nebMat);
    nebMesh.frustumCulled = false;
    nebMesh.renderOrder = -10;
    scene.add(nebMesh);

    // ---- Layer 1: dust ----
    const dustPos = new Float32Array(DUST_COUNT * 3);
    const dustScale = new Float32Array(DUST_COUNT);
    for (let i = 0; i < DUST_COUNT; i++) {
      const z = -20 - Math.random() * 40;
      const spread = (10 - z) * 0.62;
      dustPos[i * 3] = (Math.random() - 0.5) * 2 * spread;
      dustPos[i * 3 + 1] = (Math.random() - 0.5) * 2 * spread * 0.72;
      dustPos[i * 3 + 2] = z;
      dustScale[i] = Math.random();
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
    dustGeo.setAttribute('aScale', new THREE.BufferAttribute(dustScale, 1));
    const dustUniforms = {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uPixelRatio: { value: pixelRatio },
      uOrbNDC: { value: uOrbNDC },
      uAspect: { value: 1 },
    };
    const dustMat = new THREE.ShaderMaterial({
      vertexShader: DUST_VERT,
      fragmentShader: POINT_FRAG,
      uniforms: dustUniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    const dust = new THREE.Points(dustGeo, dustMat);
    dust.frustumCulled = false;
    dust.renderOrder = -5;
    scene.add(dust);

    // ---- Layer 2: curl flow field ----
    const flowPos = new Float32Array(FLOW_COUNT * 3);
    const flowScale = new Float32Array(FLOW_COUNT);
    const flowBright = new Float32Array(FLOW_COUNT);
    const flowAccent = new Float32Array(FLOW_COUNT);
    for (let i = 0; i < FLOW_COUNT; i++) {
      // Distribute inside the camera's view FRUSTUM (a cone), not a fixed box —
      // otherwise most particles fall outside the visible view and the field
      // reads far sparser than 90k. Spread xy proportional to distance from
      // the camera at each particle's depth so the whole visible volume fills
      // densely, near to far.
      const z = -58 + Math.random() * 62; // z ∈ [-58, +4]
      const dist = 10 - z; // distance from camera (z=10)
      const spread = dist * 0.62; // ~tan(fov/2)*aspect, fills frustum + margin
      flowPos[i * 3] = (Math.random() - 0.5) * 2 * spread;
      flowPos[i * 3 + 1] = (Math.random() - 0.5) * 2 * spread * 0.72;
      flowPos[i * 3 + 2] = z;
      flowScale[i] = 0.4 + Math.random() * 1.2;
      flowBright[i] = 0.35 + Math.random() * 0.65;
      flowAccent[i] = Math.random();
    }
    const flowGeo = new THREE.BufferGeometry();
    flowGeo.setAttribute('position', new THREE.BufferAttribute(flowPos, 3));
    flowGeo.setAttribute('aScale', new THREE.BufferAttribute(flowScale, 1));
    flowGeo.setAttribute('aBrightness', new THREE.BufferAttribute(flowBright, 1));
    flowGeo.setAttribute('aAccent', new THREE.BufferAttribute(flowAccent, 1));
    const flowUniforms = {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uSize: { value: 3.6 },
      uPixelRatio: { value: pixelRatio },
      uFlowStrength: { value: 0.6 },
      uTimeScale: { value: 0.15 },
      uNoiseScale: { value: 0.06 },
      uOrbNDC: { value: uOrbNDC },
      uAspect: { value: 1 },
    };
    const flowMat = new THREE.ShaderMaterial({
      vertexShader: FLOW_VERT,
      fragmentShader: POINT_FRAG,
      uniforms: flowUniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    const flow = new THREE.Points(flowGeo, flowMat);
    flow.frustumCulled = false;
    flow.renderOrder = -1;
    scene.add(flow);

    // group the particle layers so cursor/drag parallax moves them together
    const parallaxGroup = new THREE.Group();
    parallaxGroup.add(dust);
    parallaxGroup.add(flow);
    scene.add(parallaxGroup);

    const resize = () => {
      const width = container.clientWidth || 1;
      const height = container.clientHeight || 1;
      const aspect = width / height;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      nebUniforms.uResolution.value.set(width * pixelRatio, height * pixelRatio);
      dustUniforms.uAspect.value = aspect;
      flowUniforms.uAspect.value = aspect;
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    // ---- cursor parallax + grab-drag push ----
    const parallax = { x: 0, y: 0 };
    let isDragging = false;
    const dragStart = { x: 0, y: 0 };
    const dragTarget = { x: 0, y: 0 };
    const dragCurrent = { x: 0, y: 0 };

    const handlePointerMove = (event: PointerEvent) => {
      const nx = (event.clientX / window.innerWidth - 0.5) * 2;
      const ny = -(event.clientY / window.innerHeight - 0.5) * 2;
      parallax.x = nx * 0.55;
      parallax.y = ny * 0.4;
      uMouse.set(nx, ny);
      if (isDragging) {
        const dx = event.clientX / window.innerWidth - 0.5 - dragStart.x;
        const dy = event.clientY / window.innerHeight - 0.5 - dragStart.y;
        const mag = Math.hypot(dx, dy);
        const clampedMag = Math.min(mag, DRAG_PULL_MAX / DRAG_PULL_STRENGTH);
        const scale = mag > 0 ? clampedMag / mag : 0;
        dragTarget.x = dx * scale * DRAG_PULL_STRENGTH;
        dragTarget.y = dy * scale * DRAG_PULL_STRENGTH;
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      isDragging = true;
      dragStart.x = event.clientX / window.innerWidth - 0.5;
      dragStart.y = event.clientY / window.innerHeight - 0.5;
    };
    const handlePointerUp = () => {
      isDragging = false;
      dragTarget.x = 0;
      dragTarget.y = 0;
    };
    if (!prefersReducedMotion) {
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerdown', handlePointerDown);
      window.addEventListener('pointerup', handlePointerUp);
      window.addEventListener('pointercancel', handlePointerUp);
    }

    let smoothedIntensity = 0;
    let rafId = 0;
    let lastFrame = performance.now();
    let running = true;

    const handleVisibility = () => {
      running = document.visibilityState === 'visible';
      if (running) {
        lastFrame = performance.now();
        rafId = requestAnimationFrame(tick);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    function tick(now: number) {
      if (!running) return;
      rafId = requestAnimationFrame(tick);
      const dt = Math.min((now - lastFrame) / 1000, 0.1);
      lastFrame = now;

      // smooth the intensity so pulses breathe, never strobe
      const target = intensityRef.current;
      smoothedIntensity += (target - smoothedIntensity) * 0.08;
      const I = prefersReducedMotion ? Math.min(smoothedIntensity, 0.2) : smoothedIntensity;

      const timeScale = prefersReducedMotion ? 0.15 : 1;
      const t = now * 0.001 * timeScale;

      nebUniforms.uTime.value = t;
      nebUniforms.uIntensity.value = I;
      dustUniforms.uTime.value = t;
      dustUniforms.uIntensity.value = I;
      flowUniforms.uTime.value = t;
      flowUniforms.uIntensity.value = I;
      flowUniforms.uFlowStrength.value = 0.6 + I * 1.4;
      flowUniforms.uTimeScale.value = 0.15 + I * 0.85;

      // parallax + drag on the particle group
      const dragLerpRate = isDragging ? DRAG_LERP_ENGAGE : DRAG_LERP_RELEASE;
      dragCurrent.x += (dragTarget.x - dragCurrent.x) * Math.min(dt * dragLerpRate, 1);
      dragCurrent.y += (dragTarget.y - dragCurrent.y) * Math.min(dt * dragLerpRate, 1);
      const px = parallax.x * PARALLAX + dragCurrent.x * PARALLAX;
      const py = parallax.y * PARALLAX + dragCurrent.y * PARALLAX;
      parallaxGroup.position.x += (px - parallaxGroup.position.x) * Math.min(dt * 1.5, 1);
      parallaxGroup.position.y += (py - parallaxGroup.position.y) * Math.min(dt * 1.5, 1);

      renderer.render(scene, camera);
    }
    rafId = requestAnimationFrame(tick);

    return () => {
      running = false;
      cancelAnimationFrame(rafId);
      document.removeEventListener('visibilitychange', handleVisibility);
      resizeObserver.disconnect();
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      nebGeo.dispose();
      nebMat.dispose();
      dustGeo.dispose();
      dustMat.dispose();
      flowGeo.dispose();
      flowMat.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  return <div ref={containerRef} className="background-field" aria-hidden="true" />;
}
