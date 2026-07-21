/**
 * flubber3d/motion — the procedural locomotion + gesture brain for a single
 * live Blubber body. Phase 1 of the flubber-core upgrade.
 *
 * The rigged goo body has no legs, so "walking" is a waddle: as it roams inside
 * its slot's scene bounds it rocks side to side (weight-shift), bobs vertically
 * between footfalls, squashes on each footfall, and banks slightly into the
 * direction of travel while keeping its face toward camera. Standing still it
 * breathes with a springy idle and hops occasionally. On top of all that sit
 * one-shot gestures (hop, bounce, wave, eat, shower, petted, celebrate) and
 * pointer reactions.
 *
 * Design constraints (from the host architecture — many scenes blitted per
 * frame at 60fps):
 *   - ZERO per-frame allocations. sample() mutates and returns ONE reused
 *     output object; every intermediate is a scalar.
 *   - Pure math, no three.js objects. The instance reads the scalar output and
 *     writes it onto its root transform, composing with the squash spring and
 *     the workstation lean it already owns.
 *   - Reads the global runtime config each frame so energyLevel/movementAmount
 *     from /api/brain steer every body at once, while an explicit setMovement()
 *     overrides per-slot.
 *   - prefers-reduced-motion: wander is disabled and gestures collapse to their
 *     expression swap (no procedural transforms).
 */

import { getFlubberRuntime } from './runtime';

export type GestureName =
  | 'hop'
  | 'bounce'
  | 'wave'
  | 'eat'
  | 'shower'
  | 'petted'
  | 'celebrate';

/** Internal gesture set — the public 7 plus the two pointer micro-reactions. */
type InternalGesture = GestureName | 'perk' | 'poke';

export interface MovementConfig {
  /** Roam inside the scene bounds with idle pauses and direction changes. */
  wander: boolean;
  /** 0..1 — scales squash/stretch amplitude everywhere (idle breathing too). */
  bounciness: number;
  /** 0..1 — scales gait/roam speed. */
  speed: number;
}

export interface MotionControllerOptions {
  bodyWidth: number;
  bodyHeight: number;
  bodyDepth: number;
  prefersReducedMotion: boolean;
  /** false for the centred hero (protects its circular blit mask) and for
   * seated workstation agents. Breathing + gestures still apply; roaming does
   * not. */
  wanderAllowed: boolean;
  random: () => number;
}

/** One frame of procedural motion, relative to the body's rest transform.
 * Reused across frames — never retained by the caller. */
export interface MotionSample {
  posX: number;
  posY: number;
  posZ: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  /** Additive squash on the spring channel (negative = squashed). */
  squashAdd: number;
  /** Multiplicative scale factors layered on top of the spring scale. */
  scaleY: number;
  scaleXZ: number;
  /** True for the single frame a spring-kicking gesture begins. */
  pulseRequested: boolean;
}

export interface MotionController {
  setMovement(cfg: MovementConfig | null): void;
  playGesture(name: GestureName): void;
  reactToPointer(kind: 'hover' | 'click'): void;
  /** Advance and return the (reused) sample for this frame. */
  sample(dt: number, nowS: number): MotionSample;
  /** Expression the active gesture wants shown, or null to defer to the brain. */
  readonly gestureExpression: string | null;
}

// ── tuning constants (body-relative fractions where noted) ───────────────────
const TWO_PI = Math.PI * 2;

// The host blits each scene into a canvas cropped tight to the framed body
// (~8-10% margin per side). Translation/hop amplitudes stay well inside that
// margin so a roaming body never clips at the canvas edge; the "walking" read
// is carried by the waddle (rock + bob + footfall squash) and the turn-to-face,
// not by large travel.
const WANDER_RANGE_X_FRAC = 0.06; // ± of body widths the body may roam sideways
const WANDER_RANGE_Z_FRAC = 0.32; // ± of body depths in/out (subtle, perspective)
const WALK_SPEED_FRAC = 0.14; // body widths / sec at speed=1 (short, ambling)
const STRIDE_FRAC = 0.12; // body widths advanced per gait half-cycle
const PAUSE_MIN_S = 1.0;
const PAUSE_MAX_S = 2.8;
const WALK_MIN_S = 0.7; // guards against zero-length walks
const MOVE_EASE_RATE = 6; // how fast moveIntensity ramps in/out
const YAW_EASE_RATE = 7;

const ROCK_AMP = 0.075; // rad — side-to-side weight shift while walking
const BOB_AMP_FRAC = 0.022; // body heights — vertical waddle bob
const GAIT_SQUASH = 0.14; // footfall squash depth (scale, edge-safe)
const FACE_YAW = 4.0; // how much the body turns toward travel (radians/unit)
const MAX_YAW = 0.42; // cap so the face stays toward camera
const BANK = 0.12; // rad — lean into the turn

const BREATHE_RATE = 1.6; // rad/sec base idle breathing
const BREATHE_AMP = 0.035; // idle breathing scale amplitude at bounciness=1
const IDLE_SWAY_AMP = 0.016; // rad — springy idle sway

const IDLE_HOP_MIN_S = 5;
const IDLE_HOP_MAX_S = 12;

const HOP_HEIGHT_FRAC = 0.06; // body heights — one-shot hop apex (edge-safe)
const CELEBRATE_HEIGHT_FRAC = 0.075;

const GESTURE_DURATION: Record<InternalGesture, number> = {
  hop: 0.62,
  bounce: 0.95,
  wave: 1.5,
  eat: 1.05,
  shower: 1.6,
  petted: 1.2,
  celebrate: 1.15,
  perk: 0.45,
  poke: 0.6,
};

const GESTURE_EXPRESSION: Partial<Record<InternalGesture, string>> = {
  wave: 'waving',
  eat: 'happy',
  shower: 'happy',
  petted: 'heart-eyes',
  celebrate: 'celebrating',
  poke: 'excited',
};

// Gestures that should also kick the instance's squash spring on start.
const GESTURE_PULSES: Partial<Record<InternalGesture, true>> = {
  hop: true,
  bounce: true,
  celebrate: true,
  poke: true,
};

export function createMotionController(options: MotionControllerOptions): MotionController {
  const { bodyWidth, bodyHeight, bodyDepth, prefersReducedMotion, wanderAllowed, random } = options;

  const rangeX = bodyWidth * WANDER_RANGE_X_FRAC;
  const rangeZ = bodyDepth * WANDER_RANGE_Z_FRAC;
  const stride = Math.max(bodyWidth * STRIDE_FRAC, 0.0001);

  let explicitMovement: MovementConfig | null = null;

  // wander state
  let walking = false;
  let modeTimer = PAUSE_MIN_S + random() * (PAUSE_MAX_S - PAUSE_MIN_S);
  let curX = 0;
  let curZ = 0;
  let tgtX = 0;
  let tgtZ = 0;
  let gaitPhase = random() * TWO_PI;
  let moveIntensity = 0;
  let yaw = 0;
  let idleHopTimer = IDLE_HOP_MIN_S + random() * (IDLE_HOP_MAX_S - IDLE_HOP_MIN_S);

  // gesture state
  let gesture: InternalGesture | null = null;
  let gestureT = 0;
  let gestureExpr: string | null = null;

  const out: MotionSample = {
    posX: 0, posY: 0, posZ: 0,
    rotX: 0, rotY: 0, rotZ: 0,
    squashAdd: 0, scaleY: 1, scaleXZ: 1,
    pulseRequested: false,
  };

  const startGesture = (name: InternalGesture) => {
    gesture = name;
    gestureT = 0;
    gestureExpr = GESTURE_EXPRESSION[name] ?? null;
  };

  const pickWanderTarget = () => {
    // Bias toward a target a real distance away so walks are worth taking.
    let nx = (random() * 2 - 1) * rangeX;
    let nz = (random() * 2 - 1) * rangeZ;
    if (Math.abs(nx - curX) < rangeX * 0.4) nx = -nx;
    if (Math.abs(nz - curZ) < rangeZ * 0.4) nz = -nz;
    tgtX = nx;
    tgtZ = nz;
  };

  // Advance the roam state machine and the waddle gait. Returns nothing —
  // mutates curX/curZ/gaitPhase/moveIntensity/yaw and writes into `out`.
  const stepWander = (dt: number, speed: number, bounciness: number, energy: number) => {
    const wanderActive = wanderAllowed && !prefersReducedMotion &&
      (explicitMovement ? explicitMovement.wander : getFlubberRuntime().movement > 0.12);

    if (wanderActive) {
      modeTimer -= dt;
      if (walking) {
        const dx = tgtX - curX;
        const dz = tgtZ - curZ;
        const dist = Math.hypot(dx, dz);
        const stepLen = bodyWidth * WALK_SPEED_FRAC * speed * dt;
        if (dist <= stepLen || modeTimer <= 0) {
          curX = tgtX;
          curZ = tgtZ;
          walking = false;
          const pauseScale = 1.3 - 0.6 * energy; // more energy → shorter pauses
          modeTimer = (PAUSE_MIN_S + random() * (PAUSE_MAX_S - PAUSE_MIN_S)) * pauseScale;
        } else {
          const inv = 1 / dist;
          curX += dx * inv * stepLen;
          curZ += dz * inv * stepLen;
          // Footfalls track distance covered, so the waddle syncs to travel.
          gaitPhase += (stepLen / stride) * Math.PI;
          // Turn toward travel (capped so the face stays toward camera).
          const targetYaw = clamp(-(dx * inv) * FACE_YAW, -MAX_YAW, MAX_YAW);
          yaw += (targetYaw - yaw) * (1 - Math.exp(-YAW_EASE_RATE * dt));
        }
      } else {
        // paused — occasional idle hop keeps a resting body alive
        idleHopTimer -= dt;
        if (idleHopTimer <= 0 && gesture === null) {
          startGesture('hop');
          idleHopTimer = (IDLE_HOP_MIN_S + random() * (IDLE_HOP_MAX_S - IDLE_HOP_MIN_S)) / (0.5 + energy);
        }
        if (modeTimer <= 0) {
          pickWanderTarget();
          walking = true;
          modeTimer = WALK_MIN_S + random() * 2;
        }
        yaw += (0 - yaw) * (1 - Math.exp(-YAW_EASE_RATE * dt));
      }
    } else {
      // roaming disabled — ease everything home so the body doesn't freeze mid-step
      walking = false;
      curX += (0 - curX) * (1 - Math.exp(-4 * dt));
      curZ += (0 - curZ) * (1 - Math.exp(-4 * dt));
      yaw += (0 - yaw) * (1 - Math.exp(-YAW_EASE_RATE * dt));
    }

    const targetIntensity = walking ? 1 : 0;
    moveIntensity += (targetIntensity - moveIntensity) * (1 - Math.exp(-MOVE_EASE_RATE * dt));

    // Waddle: rock (weight shift) + vertical bob + footfall squash, all faded by
    // moveIntensity and scaled by bounciness. bob & squash share -cos(2φ): low +
    // squashed at footfall (φ = kπ), high + stretched mid-stride.
    const gait = moveIntensity * bounciness;
    const footCos = Math.cos(gaitPhase * 2);
    out.posX = curX;
    out.posZ = curZ;
    out.posY = -footCos * BOB_AMP_FRAC * bodyHeight * gait;
    out.rotZ = Math.sin(gaitPhase) * ROCK_AMP * gait - yaw * BANK;
    out.rotY = yaw;
    out.squashAdd = -footCos * GAIT_SQUASH * gait;
  };

  const stepIdle = (nowS: number, bounciness: number, energy: number) => {
    if (prefersReducedMotion) return;
    const rest = 1 - moveIntensity; // only breathe while (mostly) still
    if (rest <= 0.001) return;
    const breathe = Math.sin(nowS * BREATHE_RATE * (0.8 + 0.4 * energy)) * BREATHE_AMP * bounciness;
    out.scaleY *= 1 + breathe * rest;
    out.scaleXZ *= 1 - breathe * 0.5 * rest;
    out.posY += Math.max(0, breathe) * bodyHeight * 0.4 * rest;
    out.rotZ += Math.sin(nowS * 0.7) * IDLE_SWAY_AMP * bounciness * rest;
  };

  // Apply the active one-shot gesture on top of everything else.
  const stepGesture = (dt: number, nowS: number, bounciness: number) => {
    if (gesture === null) return;
    const dur = GESTURE_DURATION[gesture];
    // pulse fires on the very first frame of the gesture (gestureT still 0)
    if (gestureT === 0 && GESTURE_PULSES[gesture]) out.pulseRequested = true;
    gestureT += dt;
    const p = Math.min(gestureT / dur, 1);

    if (!prefersReducedMotion) {
      applyGesture(gesture, p, nowS, bounciness, bodyHeight, out);
    }

    if (gestureT >= dur) {
      gesture = null;
      gestureExpr = null;
    }
  };

  return {
    setMovement(cfg) {
      explicitMovement = cfg;
    },
    playGesture(name) {
      startGesture(name);
    },
    reactToPointer(kind) {
      startGesture(kind === 'hover' ? 'perk' : 'poke');
    },
    sample(dt, nowS) {
      // reset accumulator
      out.posX = 0; out.posY = 0; out.posZ = 0;
      out.rotX = 0; out.rotY = 0; out.rotZ = 0;
      out.squashAdd = 0; out.scaleY = 1; out.scaleXZ = 1;
      out.pulseRequested = false;

      const rt = getFlubberRuntime();
      const bounciness = explicitMovement
        ? clamp(explicitMovement.bounciness, 0, 1)
        : clamp(rt.energy, 0.15, 1);
      const speed = explicitMovement
        ? clamp(explicitMovement.speed, 0, 1)
        : clamp(rt.movement, 0.1, 1);
      const energy = rt.energy;

      stepWander(dt, speed, bounciness, energy);
      stepIdle(nowS, bounciness, energy);
      stepGesture(dt, nowS, bounciness);
      return out;
    },
    get gestureExpression() {
      return gestureExpr;
    },
  };
}

// ── per-gesture procedural shapes (all additive into `out`) ──────────────────
function applyGesture(
  name: InternalGesture,
  p: number,
  nowS: number,
  bounciness: number,
  bodyHeight: number,
  out: MotionSample,
): void {
  switch (name) {
    case 'hop': {
      const arc = 4 * p * (1 - p); // 0→1→0 parabola
      out.posY += arc * HOP_HEIGHT_FRAC * bodyHeight * bounciness;
      out.scaleY *= 1 + Math.sin(Math.PI * p) * 0.1 * bounciness; // stretch mid-air
      if (p > 0.86) out.squashAdd += -0.35 * bounciness; // splat on land
      break;
    }
    case 'bounce': {
      // three decaying bounces
      const env = 1 - p;
      const arc = Math.abs(Math.sin(Math.PI * 3 * p)) * env;
      out.posY += arc * HOP_HEIGHT_FRAC * bodyHeight * bounciness;
      out.squashAdd += -Math.cos(Math.PI * 6 * p) * 0.12 * env * bounciness;
      break;
    }
    case 'wave': {
      // Wave clip drives the body; add a warm rock that eases out.
      const env = Math.sin(Math.PI * p);
      out.rotZ += Math.sin(nowS * 9) * 0.11 * env * bounciness;
      out.posY += env * bodyHeight * 0.02;
      break;
    }
    case 'eat': {
      if (p < 0.28) {
        // reach up to catch
        const q = p / 0.28;
        out.posY += q * bodyHeight * 0.05;
        out.scaleY *= 1 + q * 0.08 * bounciness;
      } else if (p < 0.55) {
        // chomp down — big belly squash
        const q = (p - 0.28) / 0.27;
        out.squashAdd += -Math.sin(Math.PI * q) * 0.34 * bounciness;
      } else {
        // gulp — a couple of settling oscillations
        const q = (p - 0.55) / 0.45;
        out.squashAdd += Math.sin(q * Math.PI * 3) * 0.1 * (1 - q) * bounciness;
      }
      break;
    }
    case 'shower': {
      if (p < 0.55) {
        // shiver — cold, high-frequency micro tremor
        const env = Math.sin(Math.PI * (p / 0.55));
        out.rotZ += Math.sin(nowS * 42) * 0.045 * env * bounciness;
        out.posX += Math.sin(nowS * 47) * bodyHeight * 0.008 * env;
      } else {
        // shake-off — fast decaying yaw wag
        const q = (p - 0.55) / 0.45;
        const env = 1 - q;
        out.rotY += Math.sin(q * Math.PI * 10) * 0.26 * env * bounciness;
        out.squashAdd += -Math.abs(Math.sin(q * Math.PI * 5)) * 0.1 * env * bounciness;
      }
      break;
    }
    case 'petted': {
      // lean into the touch — gentle squish toward camera + nuzzle
      const env = Math.sin(Math.PI * p);
      out.posZ += env * bodyHeight * 0.05;
      out.squashAdd += -env * 0.16 * bounciness;
      out.rotZ += Math.sin(nowS * 6) * 0.05 * env * bounciness;
      break;
    }
    case 'celebrate': {
      const arc = 4 * p * (1 - p);
      out.posY += arc * CELEBRATE_HEIGHT_FRAC * bodyHeight * bounciness;
      out.rotY += easeInOut(p) * TWO_PI; // one full spin
      out.scaleY *= 1 + Math.sin(Math.PI * p) * 0.12 * bounciness;
      if (p > 0.9) out.squashAdd += -0.3 * bounciness;
      break;
    }
    case 'perk': {
      // hover: quick springy lift + brief stretch
      const env = Math.sin(Math.PI * p);
      out.posY += env * bodyHeight * 0.05 * bounciness;
      out.scaleY *= 1 + env * 0.07 * bounciness;
      out.scaleXZ *= 1 - env * 0.03 * bounciness;
      break;
    }
    case 'poke': {
      // click: a small hop + a quick turn-and-back wiggle
      const arc = 4 * p * (1 - p);
      out.posY += arc * HOP_HEIGHT_FRAC * 0.7 * bodyHeight * bounciness;
      out.rotY += Math.sin(p * Math.PI * 2) * 0.18 * (1 - p) * bounciness;
      break;
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
