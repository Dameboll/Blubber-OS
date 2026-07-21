'use client';

/**
 * Core3D — the reactor-core orb, "Blubber" pass.
 *
 * Single ray-marched SDF metaball fragment shader rendered on a full-screen
 * quad. No multi-mesh scene, no post-processing pipeline — one ShaderMaterial,
 * one draw call, 60fps on modest GPUs. Reference pattern: Codrops "droplet-like
 * metaballs" raymarching tutorial + the "Morphing Blobs" single-shader technique.
 *
 * WHAT CHANGED IN THIS PASS (see PLAN-FLUBBER.md section 1):
 * - Idle motion is no longer a constant in-shader sine-orbit (that read as
 *   "tweaking out"). The 4 metaball centers now live in a small CPU-side
 *   mass-spring simulation (per-center pos/vel springing toward a slowly
 *   wandering rest target) and get uploaded as a `vec3[4]` uniform each
 *   frame. Calmer by construction: the spring is close to critically damped,
 *   and the wander amplitude is small relative to the ~0.6 unit sphere
 *   radius. It also removes several sin/cos calls from the raymarch hot loop
 *   (they were being evaluated per-step before; now it's a per-frame CPU
 *   cost for 4 points).
 * - Event-driven squash/stretch: `pulseSignal` (a counter prop — see the
 *   PROP CONTRACT note below) drives a single scalar spring-damper
 *   (`uSquashAmount`) that deforms the whole cluster non-uniformly along a
 *   mostly-vertical axis (`uSquashAxis`) via a volume-ish-preserving SDF
 *   domain deformation. A kick is applied as *negative* velocity first, so
 *   the orb visibly squashes on impact, then the restoring spring force
 *   carries it past zero into a stretch overshoot before it settles — the
 *   "squashes then rebounds" behavior from the brief. Repeated events inside
 *   a short combo window amplify each other (bigger kick each time), which
 *   is the "increasing energy" bounce read from the Blubber reference
 *   material; the combo resets and the spring naturally decays once events
 *   stop.
 * - Material is glossier/wetter: sharper + a second broader specular lobe,
 *   plus a fresnel/clearcoat-style sheen term. Hue is untouched — still
 *   --core-accent / --core-accent-bright.
 * - New `audioEnergy` prop blends with the existing usage-driven `intensity`
 *   (`effectiveIntensity = max(intensity, audioEnergy * AUDIO_INTENSITY_WEIGHT)`)
 *   so the same visual language reacts to real agent/token activity AND to
 *   music playing through the music-player component.
 *
 * PROP CONTRACT (picked the "counter prop" option from PLAN-FLUBBER.md over
 * a ref-based `coreRef.current.pulse()` — this component is loaded via
 * `next/dynamic({ ssr: false })` in page.tsx, and a plain prop is simpler to
 * thread through that than wiring forwardRef + useImperativeHandle through a
 * dynamic import):
 *   <Core3D
 *     intensity={intensity}                 // 0..1, existing — usage-driven
 *     audioEnergy={audioEnergy}              // 0..1, new — from music player's analyser
 *     pulseSignal={pulseSignal}               // increment on ANY real event (agent
 *                                              // launched, task completed, error…).
 *                                              // Core3D fires an impulse whenever this
 *                                              // number CHANGES — the value itself is
 *                                              // never read as data, only diffed.
 *     pulseStrength={pulseStrength}            // optional, default 1. Set right before
 *                                              // bumping pulseSignal to make a specific
 *                                              // event's bounce bigger/smaller.
 *   />
 * If another agent's output needs a different shape, this is the file to change —
 * nothing else in the codebase depends on the internals, only these four props.
 *
 * Boot sequence: unchanged from the previous pass — GSAP timeline pushes a
 * virtual raymarch camera in toward the orb once on mount, then docks into
 * the standing position, with an Observer skip-on-first-input and a
 * ScrollTrigger parallax once docked. prefers-reduced-motion skips the boot
 * tween, freezes the idle clock to a near-static rate (which also calms the
 * wander/spring system for free, see below), and dampens impulse kicks
 * instead of fully disabling them — the orb still visibly acknowledges real
 * events, it just doesn't perform decorative motion.
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { Observer } from 'gsap/Observer';

if (typeof window !== 'undefined') {
  gsap.registerPlugin(ScrollTrigger, Observer);
}

export interface Core3DProps {
  /** 0 = idle, 1 = max token-burn intensity. Smoothed internally — pass raw values freely. */
  intensity?: number;
  /** 0 = silence, 1 = peak audio energy from the music player's analyser. Smoothed internally. */
  audioEnergy?: number;
  /** Increment on any real event to fire a one-shot squash/stretch impulse. See PROP CONTRACT above. */
  pulseSignal?: number;
  /** Strength of the next impulse when pulseSignal changes. 1 = normal event. Default 1. */
  pulseStrength?: number;
  /**
   * Fires at each key moment of the boot cinematic (see the boot-sequence
   * block below) so a DOM overlay (flash / wordmark) elsewhere in the tree
   * can stay in sync without duplicating Core3D's own timeline constants.
   * Never fires at all if prefers-reduced-motion is set -- the boot tween
   * itself is skipped in that case, straight to the docked state.
   */
  onBootEvent?: (phase: 'chaos-start' | 'flash' | 'reveal' | 'docked') => void;
  className?: string;
}

// ---- design tokens (mirrors src/app/globals.css — kept in sync manually) ----
const COLOR_BASE = { h: 155, c: 0.19, l: 0.7 }; // --core-accent
const COLOR_BRIGHT = { h: 150, c: 0.22, l: 0.85 }; // --core-accent-bright
const COLOR_BG = { h: 0, c: 0, l: 0.07 }; // --bg-primary

// How much a full-strength audioEnergy (1.0) counts toward effective intensity.
// Kept under 1 so music alone reads as lively but a real heavy token-burn
// moment can still visibly outrank it.
const AUDIO_INTENSITY_WEIGHT = 0.85;

// ---- idle mass-spring wobble (replaces the old constant sine-orbit) ----
const SPRING_K = 10; // stiffness
const SPRING_C = 5; // damping — under the critical value (2*sqrt(K)=6.32) on purpose,
// a little underdamped so it reads as a soft living jiggle rather than a dead settle
const WANDER_BASE_AMP = 0.05;
const WANDER_INTENSITY_AMP = 0.1; // extra wander amplitude at full effective intensity
const WANDER_FREQ_BASE = 0.35;
const WANDER_FREQ_INTENSITY = 0.5;

// ---- grab-and-drag stretch (Mario 64 title-screen face reference) ----
// Converts a normalized (-1..1) screen-space drag distance into world units
// applied to the metaball centers. GRAB_PULL_MAX caps how far a single drag
// can stretch it regardless of how far off-screen the cursor goes -- keeps
// the shape recognizable instead of flying apart.
const GRAB_PULL_STRENGTH = 0.85;
const GRAB_PULL_MAX = 0.85;
const GRAB_LERP_ENGAGE = 9; // fast -- feels stuck to the cursor while actively dragging
const GRAB_LERP_RELEASE = 3.2; // slower -- a visible glide back before the spring jiggle takes over

// Resting cluster formation the spring settles toward (world units, matches
// the ~0.6 unit main-sphere radius scale below).
const REST_POSITIONS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [0.34, 0.12, -0.22],
  [-0.3, -0.16, 0.28],
  [0.06, -0.3, -0.16],
];

// ---- event-driven squash/stretch impulse spring ----
const SQUASH_SPRING_K = 40;
const SQUASH_SPRING_C = 9; // underdamped enough for a couple of visible rebounds
const IMPULSE_KICK_UNIT = 3.2;
const MAX_KICK = 7;
const COMBO_WINDOW_SECONDS = 2.2; // events inside this window chain and amplify each other
const COMBO_STEP = 0.35; // multiplier added per chained event
const COMBO_MAX_STACKS = 4; // cap so a long burst of events doesn't blow the deformation out
const SQUASH_CLAMP_MIN = -0.4;
const SQUASH_CLAMP_MAX = 0.6;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function oklchToRGB(l: number, c: number, h: number): [number, number, number] {
  // Minimal OKLCH -> linear sRGB conversion (Björn Ottosson's reference method).
  const hRad = (h * Math.PI) / 180;
  const a = Math.cos(hRad) * c;
  const b = Math.sin(hRad) * c;

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;

  const l3 = l_ * l_ * l_;
  const m3 = m_ * m_ * m_;
  const s3 = s_ * s_ * s_;

  let r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  let g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  let bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;

  const toSRGB = (v: number) => {
    v = Math.max(0, Math.min(1, v));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  };

  r = toSRGB(r);
  g = toSRGB(g);
  bl = toSRGB(bl);

  return [r, g, bl];
}

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  varying vec2 vUv;

  uniform vec2 uResolution;
  uniform float uTime;
  uniform float uIntensity;      // smoothed 0..1, drives glow + color (combines usage + audio)
  uniform float uCamDist;        // boot push-in distance, animated by GSAP
  uniform float uParallax;       // subtle scroll-driven offset once docked
  uniform vec3 uColorBase;
  uniform vec3 uColorBright;
  uniform vec3 uColorBg;
  uniform vec3 uCenters[4];      // metaball centers, CPU mass-spring simulated per frame
  uniform vec3 uSquashAxis;      // normalized axis of the current squash/stretch deformation
  uniform float uSquashAmount;   // -0.4..0.6, negative = squashed, positive = stretched
  uniform float uAudioPump;      // 0..1, music-loudness swell -- the orb breathes/inflates to the track
  uniform float uFlash;          // 0..1, one-shot boot-sequence "engulfing" flash (see PLAN.md boot cinematic)
  uniform vec2 uCursorOffset;    // smoothed cursor lean, -1..1 each axis -- "the orb notices you"

  #define STEPS 80
  #define MAX_DIST 14.0
  #define SURF_EPS 0.001

  float smin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
  }

  float sphere(vec3 p, vec3 c, float r) {
    return length(p - c) - r;
  }

  // Volume-ish-preserving squash/stretch: compress/expand along uSquashAxis,
  // expand/compress perpendicular to it by the inverse sqrt so the blob reads
  // as squashed (flattened + wider) or stretched (taller + thinner), not just
  // uniformly scaled.
  vec3 applySquash(vec3 p) {
    vec3 axis = normalize(uSquashAxis);
    float s = clamp(1.0 + uSquashAmount, 0.15, 2.2);
    float along = dot(p, axis);
    vec3 perp = p - axis * along;
    return axis * (along / s) + perp * sqrt(s);
  }

  // Blended cluster of metaballs. Centers arrive pre-simulated (CPU spring),
  // count/blend-tightness still respond to uIntensity like before.
  float sdScene(vec3 p) {
    vec3 pd = applySquash(p);

    // uAudioPump swells the WHOLE cluster with music loudness -- the orb
    // physically breathes/inflates to the track, distinct from the glow-only
    // uIntensity response. This is the "dances to music" continuous layer;
    // discrete beats come through the squash impulse (firePulse) instead.
    float pump = 1.0 + uAudioPump * 0.22;

    float r0 = 0.62 * pump;
    float r1 = (0.34 + uIntensity * 0.05) * pump;
    float r2 = 0.28 * pump;
    float r3 = 0.24 * pump;

    float k = 0.55 - uIntensity * 0.12; // tighter blend under load = more agitated surface

    float d = sphere(pd, uCenters[0], r0);
    d = smin(d, sphere(pd, uCenters[1], r1), k);
    d = smin(d, sphere(pd, uCenters[2], r2), k);
    d = smin(d, sphere(pd, uCenters[3], r3), k);

    // conservative fudge while deformed — the non-uniform domain warp above
    // isn't distance-preserving, so shrink the reported distance a little
    // whenever a squash/stretch is actually active (costs nothing at rest).
    float fudge = mix(1.0, 0.82, clamp(abs(uSquashAmount) * 2.2, 0.0, 1.0));
    return d * fudge;
  }

  vec3 calcNormal(vec3 p) {
    vec2 e = vec2(0.0016, 0.0);
    return normalize(vec3(
      sdScene(p + e.xyy) - sdScene(p - e.xyy),
      sdScene(p + e.yxy) - sdScene(p - e.yxy),
      sdScene(p + e.yyx) - sdScene(p - e.yyx)
    ));
  }

  void main() {
    vec2 uv = vUv * 2.0 - 1.0;
    uv.x *= uResolution.x / uResolution.y;

    vec3 camPos = vec3(uParallax * 0.25 + uCursorOffset.x * 0.55, uParallax * 0.12 - uCursorOffset.y * 0.4, uCamDist);
    vec3 target = vec3(0.0, 0.0, 0.0);
    vec3 forward = normalize(target - camPos);
    vec3 right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
    vec3 up = cross(right, forward);

    float fovScale = tan(radians(32.0) * 0.5);
    vec3 rd = normalize(forward + (uv.x * right + uv.y * up) * fovScale);
    vec3 ro = camPos;

    float t = 0.0;
    bool hit = false;
    vec3 p = ro;

    for (int i = 0; i < STEPS; i++) {
      p = ro + rd * t;
      float d = sdScene(p);
      if (d < SURF_EPS) { hit = true; break; }
      t += d;
      if (t > MAX_DIST) break;
    }

    // background: soft radial gradient + faint glow bleeding from the orb's screen position
    float vign = smoothstep(1.35, 0.15, length(uv));
    vec3 bg = mix(uColorBg * 0.55, uColorBg * 1.6, vign);

    if (!hit) {
      // ambient bloom falloff for rays that graze near the surface without hitting it
      float minD = 999.0;
      float march = 0.0;
      for (int i = 0; i < 40; i++) {
        vec3 pp = ro + rd * march;
        float d = sdScene(pp);
        minD = min(minD, d);
        march += max(d, 0.08);
        if (march > MAX_DIST) break;
      }
      // Rays that miss the orb are now TRANSPARENT (alpha-keyed) so the
      // full-screen flubber BackgroundField shows through behind the orb
      // across the whole top section. Previously this wrote an opaque bg,
      // which painted a solid black rectangle over the background — the
      // "black top" bug. Only the orb's own green halo bleeds over the field.
      float glow = exp(-minD * 5.5) * (0.5 + uIntensity * 0.9);
      vec3 glowColor = mix(uColorBase, uColorBright, uIntensity);
      gl_FragColor = vec4(glowColor, clamp(glow * 0.6, 0.0, 1.0));
      return;
    }

    vec3 n = calcNormal(p);
    vec3 viewDir = -rd;

    vec3 lightDir = normalize(vec3(0.45, 0.65, 0.35));
    float diff = max(dot(n, lightDir), 0.0);
    float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 2.2);
    float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 5.0);

    // Glossier/wetter response: a sharp tight highlight (wet specular point)
    // layered on top of a softer broad sheen, plus a fresnel-driven clearcoat
    // tint standing in for a cheap fake environment reflection.
    float specTight = pow(max(dot(reflect(-lightDir, n), viewDir), 0.0), 140.0);
    float specBroad = pow(max(dot(reflect(-lightDir, n), viewDir), 0.0), 20.0);

    vec3 baseColor = mix(uColorBase, uColorBright, uIntensity);
    float glowPulse = 0.75 + 0.25 * sin(uTime * (1.2 + uIntensity * 2.5));
    float impact = abs(uSquashAmount); // brief extra life while a bounce is active

    vec3 col = baseColor * (0.14 + diff * 0.4);
    col += baseColor * rim * (0.85 + uIntensity * 1.5 + impact * 0.8) * glowPulse;
    col += mix(uColorBg, vec3(1.0), 0.2) * fresnel * 0.3;
    col += vec3(1.0) * specBroad * (0.22 + uIntensity * 0.3);
    col += vec3(1.0) * specTight * (0.55 + uIntensity * 0.35 + impact * 0.5);

    // atmospheric falloff toward background at distance
    float fog = smoothstep(0.0, MAX_DIST * 0.7, t);
    col = mix(col, bg, fog * 0.35);

    // Boot-cinematic "engulfing" flash -- a bright green-white blowout that
    // washes over the orb itself (not a full-screen DOM overlay), matching
    // the reference material's light engulfing the blob before the reveal.
    col = mix(col, vec3(1.35, 1.6, 1.4), uFlash);

    gl_FragColor = vec4(col, 1.0);
  }
`;

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

// Boot camera cinematic — four stops, matching the researched OG Xbox boot
// structure (blob forms/pulses/moves -> flash engulfs it -> camera zooms
// OUT to reveal -> settles): far start, a violent close-in chaos peak, a
// pulled-back "reveal" distance, then the final resting dock. Docked value
// must match the resting uCamDist used everywhere else (parallax math, etc).
const CAM_DIST_BOOT_START = 9.5;
const CAM_DIST_CHAOS_PEAK = 2.6;
const CAM_DIST_REVEAL = 4.6;
const CAM_DIST_DOCKED = 3.4;

// How much extra wander amplitude/frequency the boot-chaos phase adds on top
// of the normal idle jiggle -- this is what makes the blob "form and pulse
// and keep moving" wildly during boot instead of just calmly drifting in.
const BOOT_CHAOS_AMP_MULT = 5.5;
const BOOT_CHAOS_FREQ_MULT = 2.2;

export default function Core3D({
  intensity = 0,
  audioEnergy = 0,
  pulseSignal,
  pulseStrength,
  onBootEvent,
  className,
}: Core3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const intensityTargetRef = useRef(intensity);
  const audioEnergyTargetRef = useRef(audioEnergy);
  const pulseStrengthRef = useRef(pulseStrength ?? 1);
  const pulseFnRef = useRef<((strength: number) => void) | null>(null);
  const prevPulseSignalRef = useRef(pulseSignal);
  const onBootEventRef = useRef(onBootEvent);

  useEffect(() => {
    onBootEventRef.current = onBootEvent;
  }, [onBootEvent]);

  useEffect(() => {
    intensityTargetRef.current = clamp01(intensity);
  }, [intensity]);

  useEffect(() => {
    audioEnergyTargetRef.current = clamp01(audioEnergy);
  }, [audioEnergy]);

  useEffect(() => {
    pulseStrengthRef.current = pulseStrength ?? 1;
  }, [pulseStrength]);

  useEffect(() => {
    if (pulseSignal !== undefined && pulseSignal !== prevPulseSignalRef.current) {
      pulseFnRef.current?.(pulseStrengthRef.current);
    }
    prevPulseSignalRef.current = pulseSignal;
  }, [pulseSignal]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const prefersReducedMotion = window.matchMedia(REDUCED_MOTION_QUERY).matches;

    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: true, // LOAD-BEARING: transparent canvas so the full-screen flubber
      premultipliedAlpha: false, // background shows through behind the orb (kills the "black top" bug)
      powerPreference: 'high-performance',
    });
    renderer.setClearColor(0x000000, 0); // fully transparent clear
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const [baseR, baseG, baseB] = oklchToRGB(COLOR_BASE.l, COLOR_BASE.c, COLOR_BASE.h);
    const [brightR, brightG, brightB] = oklchToRGB(COLOR_BRIGHT.l, COLOR_BRIGHT.c, COLOR_BRIGHT.h);
    const [bgR, bgG, bgB] = oklchToRGB(COLOR_BG.l, COLOR_BG.c, COLOR_BG.h);

    // ---- idle mass-spring centers ----
    const centers = REST_POSITIONS.map(([x, y, z]) => ({
      rest: new THREE.Vector3(x, y, z),
      pos: new THREE.Vector3(x, y, z),
      vel: new THREE.Vector3(0, 0, 0),
      wanderSeed: Math.random() * Math.PI * 2,
    }));
    // uniform value array holds the SAME Vector3 refs as `centers[i].pos` —
    // mutating pos.x/y/z in the tick loop updates the uniform with no copy.
    const centerUniformValues = centers.map((c) => c.pos);

    // ---- squash/stretch impulse spring ----
    const squashState = { value: 0, velocity: 0 };

    // Boot-cinematic chaos amount -- 0 normally, driven to 1 and back down by
    // the boot GSAP timeline below. Multiplies wander amplitude/frequency in
    // the tick loop so the blob visibly "forms and pulses and keeps moving"
    // during boot, distinct from (and much bigger than) the calm idle jiggle.
    const chaosState = { value: 0 };
    const squashAxisCurrent = new THREE.Vector3(0, 1, 0);
    const squashAxisTarget = new THREE.Vector3(0, 1, 0);
    let lastPulseWallTime = -Infinity;
    let comboCount = 0;

    const uniforms = {
      uResolution: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uIntensity: { value: Math.max(intensityTargetRef.current, audioEnergyTargetRef.current * AUDIO_INTENSITY_WEIGHT) },
      uCamDist: { value: prefersReducedMotion ? CAM_DIST_DOCKED : CAM_DIST_BOOT_START },
      uParallax: { value: 0 },
      uColorBase: { value: new THREE.Vector3(baseR, baseG, baseB) },
      uColorBright: { value: new THREE.Vector3(brightR, brightG, brightB) },
      uColorBg: { value: new THREE.Vector3(bgR, bgG, bgB) },
      uCenters: { value: centerUniformValues },
      uFlash: { value: 0 },
      uAudioPump: { value: 0 },
      uCursorOffset: { value: new THREE.Vector2(0, 0) },
      uSquashAxis: { value: squashAxisCurrent },
      uSquashAmount: { value: 0 },
    };

    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms,
      transparent: true, // so the miss-branch alpha lets the background through
      depthTest: false,
      depthWrite: false,
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    scene.add(quad);

    const resize = () => {
      const width = container.clientWidth || 1;
      const height = container.clientHeight || 1;
      renderer.setSize(width, height, false);
      uniforms.uResolution.value.set(width, height);
    };
    resize();

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    // ---- cursor interactivity: lean toward cursor, poke on click, GRAB AND
    // DRAG to stretch it (the Mario 64 title-screen face reference) ----
    const cursorTarget = { x: 0, y: 0 };
    const toNormalized = (clientX: number, clientY: number) => {
      const rect = container.getBoundingClientRect();
      return {
        x: ((clientX - rect.left) / rect.width) * 2 - 1,
        y: ((clientY - rect.top) / rect.height) * 2 - 1,
      };
    };

    // Grab state: dragStart is where the pointer went down (normalized
    // -1..1); grabTarget is how far it's been dragged since, in world-ish
    // units (see GRAB_PULL_STRENGTH). grabCurrent (used in the tick loop) is
    // a SEPARATE smoothed value with two different lerp speeds -- fast while
    // actively dragging (the blob feels stuck to the cursor), slower while
    // easing back to 0 after release (the visible spring-back glide, on top
    // of which the per-center mass-spring below adds its own natural
    // overshoot/jiggle -- two layers of "give" stacked, not one).
    let isDragging = false;
    const dragStart = { x: 0, y: 0 };
    const grabTarget = { x: 0, y: 0 };

    const handlePointerMove = (event: PointerEvent) => {
      const n = toNormalized(event.clientX, event.clientY);
      cursorTarget.x = n.x;
      cursorTarget.y = n.y;
      if (isDragging) {
        const dx = n.x - dragStart.x;
        const dy = n.y - dragStart.y;
        const mag = Math.hypot(dx, dy);
        const clampedMag = Math.min(mag, GRAB_PULL_MAX / GRAB_PULL_STRENGTH);
        const scale = mag > 0 ? clampedMag / mag : 0;
        grabTarget.x = dx * scale * GRAB_PULL_STRENGTH;
        grabTarget.y = -dy * scale * GRAB_PULL_STRENGTH;
      }
    };
    const handlePointerLeave = () => {
      if (!isDragging) {
        cursorTarget.x = 0;
        cursorTarget.y = 0;
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      // A tap gets the existing quick poke reaction immediately...
      firePulse(1.1);
      // ...and also starts a potential drag -- if the pointer moves while
      // still down, handlePointerMove above starts feeding grabTarget.
      isDragging = true;
      const n = toNormalized(event.clientX, event.clientY);
      dragStart.x = n.x;
      dragStart.y = n.y;
      container.setPointerCapture(event.pointerId);
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (!isDragging) return;
      isDragging = false;
      container.releasePointerCapture(event.pointerId);
      // Release strength scales with how far it was stretched -- a small tap
      // barely bounces, a big pull snaps back hard, same "increasing energy"
      // read as the rest of the squash system.
      const pullMag = Math.hypot(grabTarget.x, grabTarget.y);
      firePulse(1 + Math.min(pullMag * 2.2, 2.5));
      grabTarget.x = 0;
      grabTarget.y = 0;
    };
    if (!prefersReducedMotion) {
      container.addEventListener('pointermove', handlePointerMove);
      container.addEventListener('pointerleave', handlePointerLeave);
    }
    container.addEventListener('pointerdown', handlePointerDown);
    container.addEventListener('pointerup', handlePointerUp);
    container.addEventListener('pointercancel', handlePointerUp);

    // Smoothed grab offset actually applied to the metaball centers in the
    // tick loop -- separate from grabTarget so engaging vs releasing can
    // ease at different speeds (see comment above).
    const grabCurrent = { x: 0, y: 0 };

    // Fires a one-shot squash impulse. Repeated calls inside COMBO_WINDOW_SECONDS
    // chain and amplify each other (the "increasing energy" bounce read from
    // the Blubber reference); the combo resets once events stop for a beat.
    const firePulse = (strengthInput: number) => {
      const wallNow = performance.now() / 1000;
      const sinceLast = wallNow - lastPulseWallTime;
      comboCount = sinceLast < COMBO_WINDOW_SECONDS ? Math.min(comboCount + 1, COMBO_MAX_STACKS) : 0;
      lastPulseWallTime = wallNow;

      const comboMultiplier = 1 + comboCount * COMBO_STEP;
      const clampedStrength = Math.max(0.15, Math.min(strengthInput, 3));
      // Under reduced motion the impulse still registers (real events still
      // get a visible acknowledgment) but at a fraction of the motion so it
      // doesn't perform decorative bouncing.
      const motionScale = prefersReducedMotion ? 0.12 : 1;
      const kick = Math.min(clampedStrength * comboMultiplier * IMPULSE_KICK_UNIT, MAX_KICK) * motionScale;

      // Kick is negative first: the orb squashes on impact, then the
      // restoring spring force carries it through zero into a stretch
      // overshoot before it settles — "squashes then rebounds".
      squashState.velocity -= kick;

      // Mostly-vertical axis with a little per-event jitter so repeated
      // pulses don't all bounce along the exact same line.
      squashAxisTarget.set((Math.random() - 0.5) * 0.6, 1, (Math.random() - 0.5) * 0.6).normalize();

      if (!prefersReducedMotion) {
        // Tiny per-center kicks on top of the main squash — reads as more
        // organic than a perfectly uniform blob deformation.
        centers.forEach((c) => {
          c.vel.x += (Math.random() - 0.5) * 0.05 * kick;
          c.vel.y += (Math.random() - 0.5) * 0.05 * kick;
          c.vel.z += (Math.random() - 0.5) * 0.05 * kick;
        });
      }
    };
    pulseFnRef.current = firePulse;

    // ---- boot sequence: GSAP camera push-in, docks once, Observer can skip it ----
    let bootTimeline: gsap.core.Timeline | null = null;
    let skipObserver: Observer | null = null;
    let dockScrollTrigger: ScrollTrigger | null = null;

    const setupParallax = () => {
      dockScrollTrigger = ScrollTrigger.create({
        trigger: container,
        start: 'top top',
        end: 'bottom top',
        scrub: 1,
        onUpdate: (self) => {
          uniforms.uParallax.value = prefersReducedMotion ? 0 : self.progress * 1.4;
        },
      });
    };

    if (prefersReducedMotion) {
      uniforms.uCamDist.value = CAM_DIST_DOCKED;
      setupParallax();
    } else {
      // Four-phase cinematic modeled directly on the researched OG Xbox boot
      // structure: (1) chaos -- the blob forms, pulses, keeps moving, camera
      // rushes in close; (2) flash -- a green-white light engulfs it at the
      // peak; (3) reveal -- camera zooms back OUT (not further in) as the
      // chaos settles, "and a sharp green X is seen"; (4) dock -- settles
      // into the normal standing position. onBootEvent fires at each phase
      // so page.tsx's DOM wordmark/flash overlay can stay in lockstep without
      // duplicating these timing constants.
      bootTimeline = gsap.timeline({
        onComplete: () => {
          setupParallax();
          onBootEventRef.current?.('docked');
        },
      });

      bootTimeline
        .call(() => onBootEventRef.current?.('chaos-start'), undefined, 0)
        .to(chaosState, { value: 1, duration: 0.25, ease: 'power2.out' }, 0)
        .to(uniforms.uCamDist, { value: CAM_DIST_CHAOS_PEAK, duration: 1.05, ease: 'power2.inOut' }, 0)
        .call(() => onBootEventRef.current?.('flash'), undefined, 1.0)
        .to(uniforms.uFlash, { value: 1, duration: 0.12, ease: 'power1.in' }, 1.0)
        .to(uniforms.uFlash, { value: 0, duration: 0.45, ease: 'power2.out' }, 1.12)
        .call(() => onBootEventRef.current?.('reveal'), undefined, 1.05)
        .to(uniforms.uCamDist, { value: CAM_DIST_REVEAL, duration: 0.75, ease: 'power3.out' }, 1.05)
        .to(chaosState, { value: 0.15, duration: 0.75, ease: 'power2.out' }, 1.05)
        .to(uniforms.uCamDist, { value: CAM_DIST_DOCKED, duration: 0.85, ease: 'power2.inOut' }, 1.75)
        .to(chaosState, { value: 0, duration: 0.85, ease: 'power2.inOut' }, 1.75);

      // First real user gesture (scroll/click/key) fast-forwards straight to docked.
      // `once` isn't in this GSAP version's ObserverVars type, so the
      // one-shot behavior is done manually: fast-forward, then kill self.
      const skipToDocked = () => {
        bootTimeline?.progress(1);
        skipObserver?.kill();
        skipObserver = null;
      };
      skipObserver = Observer.create({
        target: window,
        type: 'wheel,touch,pointer',
        onChangeY: skipToDocked,
        onPress: skipToDocked,
      });
    }

    // ---- render loop ----
    let rafId = 0;
    let lastFrame = performance.now();

    const tick = (now: number) => {
      rafId = requestAnimationFrame(tick);
      const dt = Math.min((now - lastFrame) / 1000, 0.1);
      lastFrame = now;

      const timeScale = prefersReducedMotion ? 0.05 : 1;
      uniforms.uTime.value += dt * timeScale;

      // smooth combined (usage + audio) intensity toward the latest targets
      // so live-usage deltas and music beats don't pop
      const combinedTarget = Math.max(
        intensityTargetRef.current,
        audioEnergyTargetRef.current * AUDIO_INTENSITY_WEIGHT
      );
      uniforms.uIntensity.value += (combinedTarget - uniforms.uIntensity.value) * Math.min(dt * 3, 1);

      // ---- audio pump: the orb physically swells with music loudness ----
      // Driven straight off the raw audio energy (NOT the max-blended
      // intensity) so it only inflates when music is actually playing, and
      // eases back to rest quickly when it stops.
      const pumpTarget = audioEnergyTargetRef.current;
      uniforms.uAudioPump.value += (pumpTarget - uniforms.uAudioPump.value) * Math.min(dt * 6, 1);

      // ---- idle mass-spring wobble on the metaball centers ----
      const time = uniforms.uTime.value;
      const energyForWander = uniforms.uIntensity.value;
      const chaosMult = 1 + chaosState.value * BOOT_CHAOS_AMP_MULT;
      const chaosFreqMult = 1 + chaosState.value * BOOT_CHAOS_FREQ_MULT;
      const wanderAmp = (WANDER_BASE_AMP + energyForWander * WANDER_INTENSITY_AMP) * chaosMult;
      const wanderFreq = (WANDER_FREQ_BASE + energyForWander * WANDER_FREQ_INTENSITY) * chaosFreqMult;

      // ---- grab-and-drag: smoothed toward grabTarget, fast while dragging,
      // slower easing back after release (see constants + handlers above) ----
      const grabLerpRate = isDragging ? GRAB_LERP_ENGAGE : GRAB_LERP_RELEASE;
      grabCurrent.x += (grabTarget.x - grabCurrent.x) * Math.min(dt * grabLerpRate, 1);
      grabCurrent.y += (grabTarget.y - grabCurrent.y) * Math.min(dt * grabLerpRate, 1);

      centers.forEach((c) => {
        const tx = c.rest.x + Math.sin(time * wanderFreq + c.wanderSeed) * wanderAmp + grabCurrent.x;
        const ty = c.rest.y + Math.cos(time * wanderFreq * 0.82 + c.wanderSeed * 1.3) * wanderAmp * 0.85 + grabCurrent.y;
        const tz = c.rest.z + Math.sin(time * wanderFreq * 0.63 + c.wanderSeed * 2.1) * wanderAmp * 0.9;

        const ax = SPRING_K * (tx - c.pos.x) - SPRING_C * c.vel.x;
        const ay = SPRING_K * (ty - c.pos.y) - SPRING_C * c.vel.y;
        const az = SPRING_K * (tz - c.pos.z) - SPRING_C * c.vel.z;

        c.vel.x += ax * dt;
        c.vel.y += ay * dt;
        c.vel.z += az * dt;
        c.pos.x += c.vel.x * dt;
        c.pos.y += c.vel.y * dt;
        c.pos.z += c.vel.z * dt;
      });

      // ---- squash/stretch impulse spring-damper ----
      squashAxisCurrent.lerp(squashAxisTarget, Math.min(dt * 6, 1));

      const squashAccel = -SQUASH_SPRING_K * squashState.value - SQUASH_SPRING_C * squashState.velocity;
      squashState.velocity += squashAccel * dt;
      squashState.value += squashState.velocity * dt;
      squashState.value = Math.max(SQUASH_CLAMP_MIN, Math.min(squashState.value, SQUASH_CLAMP_MAX));
      uniforms.uSquashAmount.value = squashState.value;

      // ---- cursor lean: smoothed toward the latest pointer position ----
      uniforms.uCursorOffset.value.x += (cursorTarget.x - uniforms.uCursorOffset.value.x) * Math.min(dt * 4, 1);
      uniforms.uCursorOffset.value.y += (cursorTarget.y - uniforms.uCursorOffset.value.y) * Math.min(dt * 4, 1);

      renderer.render(scene, camera);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      container.removeEventListener('pointermove', handlePointerMove);
      container.removeEventListener('pointerleave', handlePointerLeave);
      container.removeEventListener('pointerdown', handlePointerDown);
      container.removeEventListener('pointerup', handlePointerUp);
      container.removeEventListener('pointercancel', handlePointerUp);
      bootTimeline?.kill();
      skipObserver?.kill();
      dockScrollTrigger?.kill();
      pulseFnRef.current = null;
      quad.geometry.dispose();
      material.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%' }} />;
}
