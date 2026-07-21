/**
 * flubber3d/pool-behaviors — the procedural life of the dormant-agent pool.
 *
 * The Agents screen, when idle (ON-BREAK, see LAW 1 in
 * docs/plans/idle-life-and-wiring.md), shows a glass slime pool full of
 * sleeping (and awake, and horsing around) Flubbers. A dead grid of idle
 * mascots reads as broken, so this scheduler gives the pool REAL AMBIENT LIFE
 * — they are their own little flubbers living, not decoration:
 *   - solo wander + nap (unchanged from the original build)
 *   - a rotating cast of group vignettes: a slime-ball toss (thrower/catcher,
 *     with a miss chance that ends in a "splat" wobble), a keep-away chase, a
 *     three-way pile-up that stacks then topples, and the original bump.
 *   - an occasional independent "peek" — something reaches into the pool
 *     (the tractor beam, reused from the real spawn-pull) and lifts one
 *     resident up for a quick juggle/inspect before setting it back down.
 *     The view fires an event when this (or any vignette) starts so a caller
 *     can have the HERO visibly react (a gesture + a speech line) — real
 *     horseplay tied to a real scheduler event, never a canned animation loop.
 *
 * WORK CLOCK (LAW 1): the Agents screen is a WORK SURFACE. When a real task is
 * running the view calls setWorkMode(true) and the pool CLOCKS IN — no new
 * horseplay vignettes, no naps, no peeks start; residents just hold a calm,
 * on-the-clock roam (in-flight vignettes finish naturally). On BREAK the view
 * calls setWorkMode(false) and the goofing resumes. See idle-life-and-wiring.md.
 *
 * BREAK-ONLY POINTER PLAY (LANE R): on break the view lets the user grab a resident
 * (grab/release — freezes its brain like the pull/peek paths already do), fling
 * one out of the pool (remove), add one (add), or clear the pool (setCount 0).
 * grab/release/add/remove are all REFERENTIALLY STABLE via resident id (below),
 * so a removal never corrupts an in-flight vignette's participants.
 *
 * This module is the pure BRAIN of that world — no React, no three.js, no DOM.
 * Each resident carries a STABLE id (never reused, never index-derived) so the
 * view can key its DOM node / WebGL slot to it and grab/despawn a specific one
 * without shifting anyone else. Every internal reference — vignette
 * participants, the queued peek, the real pull — is by id, not array position,
 * so splicing a resident out mid-frame can never make another reference point
 * at the wrong flubber. The view reads `residents`/`ball` every frame and
 * writes transforms; step() mutates preallocated resident structs in place — no
 * per-frame allocation. Vignette *starts* (rare) may allocate a small array;
 * that's fine, nowhere near the hot path.
 *
 * Coordinate space: x,y are normalized 0..1 over the dome box. Residents live
 * inside an ellipse on the lower half (the pool "floor"); `scale` is a cheap
 * depth cue (nearer the front of the pool → larger). `lift`/`tilt` are extra
 * pile-up-only offsets the view adds on top of the normal position/scale.
 */

import type { GestureName, MovementConfig } from './motion';

/** One resident's live state — read by the view every frame, mutated in place
 * by step(). Never retained or copied by the caller. */
export interface PoolResident {
  /** Stable identity — never reused, never index-derived. The view keys its
   * DOM node + WebGL slot to this so a specific resident can be grabbed,
   * despawned, or added without disturbing the others. */
  readonly id: number;
  /** Normalized pool position (0..1 over the dome box). */
  x: number;
  y: number;
  /** Depth scale (front of pool larger). ~0.74..1.14. */
  scale: number;
  /** True while sleeping — the view shows a sleeping face + drifting z glyphs. */
  napping: boolean;
  /** Extra upward offset (fraction of dome height) while stacked in a pile-up. */
  lift: number;
  /** Extra z-rotation (radians) while stacked/toppling in a pile-up. */
  tilt: number;
  /** True for a brief window right after a missed toss catch — view shows a
   * wobble/splat class. */
  splatted: boolean;
  /** Seed for the view's slot so blinks/clips desync across the pool. */
  readonly seed: number;
}

/** The shared slime ball's live position during a toss vignette. */
export interface PoolBall {
  active: boolean;
  x: number;
  y: number;
}

/** A pool "event" the view can react to — e.g. cueing the hero to glance over
 * and throw out a line. One at a time; drained via takeEvent(). */
export type PoolEventKind = 'bump' | 'toss' | 'chase' | 'pileup' | 'peek';

export interface PoolScheduler {
  /** Live residents (length === current live count). Order is not stable —
   * always read a resident's `id` to identify it, never its array index. */
  readonly residents: readonly PoolResident[];
  /** The shared toss ball. Inactive (opacity 0) when no toss is in flight. */
  readonly ball: PoolBall;
  /** Grow/shrink the live population (the view caps this at MAX_LIVE). Appends
   * fresh residents / truncates from the end — used to sync to the real dormant
   * count. For break-time play the view uses add()/remove() instead. */
  setCount(n: number): void;
  /** Ambient energy 0..1 from real activity — scales nap frequency, roam speed,
   * and how often residents socialise. 0 = sleepy pool, 1 = lively. */
  setEnergy(energy: number): void;
  /** WORK CLOCK (LAW 1). true = clocked in: no new vignettes/naps/peeks start
   * (in-flight ones finish); residents hold a calm on-the-clock roam. false =
   * on break: horseplay resumes. */
  setWorkMode(on: boolean): void;
  /** Advance the world by dt seconds at absolute nowS (seconds). */
  step(dt: number, nowS: number): void;
  /** Pull one resident out of the world for a REAL spawn: it's chosen (a
   * roaming one preferred), frozen (step() no longer touches it so the view's
   * pull GSAP owns its node), and its id returned, or -1 if the pool is
   * empty. */
  beginPull(): number;
  /** Resume a pulled resident (pull was cancelled before it exited). */
  releasePull(id: number): void;
  /** BREAK-ONLY: the user grabbed this resident with the pointer — freeze its brain
   * (step() no longer touches it) so the view's drag owns its node. */
  grab(id: number): void;
  /** Release a grabbed resident back into the pool, optionally dropped at a new
   * normalized (x,y) so it continues from where the pointer let go. */
  release(id: number, x?: number, y?: number): void;
  /** BREAK-ONLY: append one fresh resident; returns its new id. */
  add(): number;
  /** BREAK-ONLY: remove one resident by id (the user flung it out / handed it up).
   * Referentially safe — never disturbs another resident's vignette. */
  remove(id: number): void;
  /** Resolve a resident by id (or undefined if it's gone). */
  residentById(id: number): PoolResident | undefined;
  /** True when this resident is free to be grabbed by the pointer — it exists
   * and isn't already owned by a vignette, a real pull, a peek, or a drag. */
  isGrabbable(id: number): boolean;
  /** Drain the queued one-shot gesture for a resident (null if none). */
  takeGesture(id: number): GestureName | null;
  /** Drain a queued "peek" request: the view should run the beam-lift
   * vignette on this resident id (a cosmetic tuck-in-and-out, distinct from
   * the real beginPull/releasePull spawn flow). Returns null if none. */
  takePeekRequest(): number | null;
  /** Tell the scheduler the view's peek vignette for this resident finished —
   * resumes its normal wander. */
  endPeek(id: number): void;
  /** Drain the queued "something happened" event (null if none this frame). */
  takeEvent(): PoolEventKind | null;
  /** The movement config a roaming (awake) resident should run. */
  readonly roamMovement: MovementConfig;
  /** The movement config a napping resident should run (still, no wander). */
  readonly napMovement: MovementConfig;
  /** The movement config an on-the-clock (work-mode) resident should run —
   * a calmer, slower roam than the goofing break roam. */
  readonly workMovement: MovementConfig;
}

// ── pool geometry (normalized) ───────────────────────────────────────────────
// Residents roam an ellipse on the lower-middle of the dome — the "floor" of
// the slime pool. Kept off the very edges so a slot never clips the glass.
const FLOOR_CX = 0.5;
const FLOOR_CY = 0.62;
const FLOOR_RX = 0.33;
const FLOOR_RY = 0.19;

// depth scale range mapped from front(1)→back(0) of the floor ellipse
const SCALE_NEAR = 1.14;
const SCALE_FAR = 0.74;

// ── behavior timing (seconds; scaled by energy at runtime) ───────────────────
const PAUSE_MIN = 1.4;
const PAUSE_MAX = 3.6;
const WALK_TIMEOUT = 6; // safety: never "walk" toward a target forever
const NAP_BEFORE_MIN = 7; // roam time before a nap becomes possible
const NAP_BEFORE_MAX = 16;
const NAP_DUR_MIN = 5;
const NAP_DUR_MAX = 10;
const NAP_CHANCE = 0.55; // when the nap timer fires, odds it actually naps
const VIGNETTE_MIN = 3.5;
const VIGNETTE_MAX = 8;
const IDLE_WAVE_MIN = 6;
const IDLE_WAVE_MAX = 14;

const ARRIVE_DIST = 0.012; // reached the target
const BUMP_DIST = 0.06; // close enough to bump during the "bump" vignette
const EASE_BASE = 1.3; // position ease rate (per sec) at energy 0
const EASE_ENERGY = 1.4; // + this * energy

// group vignette tuning
const TOSS_CATCH_CHANCE = 0.78;
const TOSS_DUR_MIN = 0.5;
const TOSS_DUR_MAX = 0.75;
const SPLAT_DUR = 0.6;
const CHASE_MIN = 3.2;
const CHASE_MAX = 5.6;
const CHASE_RETARGET_S = 0.42;
const CHASE_FLEE_STEP = 0.11;
const PILE_CONVERGE_TIMEOUT = 4;
const PILE_STACK_MIN = 1.0;
const PILE_STACK_MAX = 1.5;
const PILE_TOPPLE_DUR = 0.7;
const PILE_LIFT_STEP = 0.045;
const PILE_TILT_STEP = 0.12;
const PEEK_MIN = 9;
const PEEK_MAX = 18;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** A uniformly-random point inside the floor ellipse. */
function pickFloorPoint(out: { x: number; y: number }): void {
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random());
  out.x = FLOOR_CX + Math.cos(a) * FLOOR_RX * r;
  out.y = FLOOR_CY + Math.sin(a) * FLOOR_RY * r;
}

function clampFloorX(x: number): number {
  return Math.min(FLOOR_CX + FLOOR_RX, Math.max(FLOOR_CX - FLOOR_RX, x));
}
function clampFloorY(y: number): number {
  return Math.min(FLOOR_CY + FLOOR_RY, Math.max(FLOOR_CY - FLOOR_RY, y));
}

function scaleFor(y: number): number {
  // y at back of ellipse → SCALE_FAR, front → SCALE_NEAR
  const t = (y - (FLOOR_CY - FLOOR_RY)) / (2 * FLOOR_RY);
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return SCALE_FAR + (SCALE_NEAR - SCALE_FAR) * clamped;
}

/** Vignette a resident is currently locked into. null = free to wander/nap. */
type Vignette = 'bump' | 'toss' | 'chase' | 'pileup' | null;

/** Internal resident record — extends the public shape with hidden state. */
interface Resident extends PoolResident {
  x: number;
  y: number;
  scale: number;
  napping: boolean;
  lift: number;
  tilt: number;
  splatted: boolean;
  tgtX: number;
  tgtY: number;
  modeTimer: number; // pause/walk countdown
  napBefore: number; // countdown until a nap is considered
  napLeft: number; // remaining nap time
  waveTimer: number; // idle wave/hop countdown
  splatTimer: number;
  busy: boolean; // locked into a group vignette (skips nap/idle-wave)
  pulled: boolean; // owned by a REAL spawn pull
  peeking: boolean; // owned by a cosmetic peek vignette
  held: boolean; // owned by a break-time pointer drag (the user is holding it)
  vignette: Vignette;
  gesture: GestureName | null;
}

interface TossState {
  a: number; // resident id
  b: number; // resident id
  t: number;
  dur: number;
}
interface ChaseState {
  chaser: number; // resident id
  flee: number; // resident id
  timer: number;
  retarget: number;
}
interface PileupState {
  members: number[]; // resident ids
  phase: 'converge' | 'stack' | 'topple';
  timer: number;
}

export function createPoolScheduler(): PoolScheduler {
  const residents: Resident[] = [];
  const byId = new Map<number, Resident>();
  let nextId = 1;
  let energy = 0.35;
  let workMode = false;
  let vignetteTimer = rand(VIGNETTE_MIN, VIGNETTE_MAX);
  let peekTimer = rand(PEEK_MIN, PEEK_MAX);
  let pendingPeek: number | null = null; // resident id
  let pendingEvent: PoolEventKind | null = null;
  let toss: TossState | null = null;
  let chase: ChaseState | null = null;
  let pileup: PileupState | null = null;
  const ball: PoolBall = { active: false, x: 0, y: 0 };
  // Scratch point reused by pickFloorPoint — one allocation total, never per-frame.
  const scratch = { x: 0, y: 0 };

  const roamMovement: MovementConfig = { wander: true, bounciness: 0.7, speed: 0.85 };
  const napMovement: MovementConfig = { wander: false, bounciness: 0.35, speed: 0 };
  const workMovement: MovementConfig = { wander: true, bounciness: 0.4, speed: 0.4 };

  const makeResident = (): Resident => {
    const id = nextId;
    nextId += 1;
    pickFloorPoint(scratch);
    return {
      id,
      seed: id,
      x: scratch.x,
      y: scratch.y,
      scale: scaleFor(scratch.y),
      napping: false,
      lift: 0,
      tilt: 0,
      splatted: false,
      tgtX: scratch.x,
      tgtY: scratch.y,
      modeTimer: rand(PAUSE_MIN, PAUSE_MAX),
      napBefore: rand(NAP_BEFORE_MIN, NAP_BEFORE_MAX),
      napLeft: 0,
      waveTimer: rand(IDLE_WAVE_MIN, IDLE_WAVE_MAX),
      splatTimer: 0,
      busy: false,
      pulled: false,
      peeking: false,
      held: false,
      vignette: null,
      gesture: null,
    };
  };

  const releaseToWander = (r: Resident): void => {
    r.busy = false;
    r.vignette = null;
    r.lift = 0;
    r.tilt = 0;
    r.modeTimer = rand(PAUSE_MIN, PAUSE_MAX);
    r.napBefore = rand(NAP_BEFORE_MIN, NAP_BEFORE_MAX);
    pickFloorPoint(scratch);
    r.tgtX = scratch.x;
    r.tgtY = scratch.y;
  };

  /** Abort any in-flight vignette / queued reference to `r`, releasing the
   * other participants cleanly. Called before a resident is removed (fling /
   * truncation) so a departing flubber never leaves partners frozen or a
   * dangling id in a vignette struct. */
  const forgetVignette = (r: Resident): void => {
    const id = r.id;
    if (toss && (toss.a === id || toss.b === id)) {
      ball.active = false;
      const otherId = toss.a === id ? toss.b : toss.a;
      const other = byId.get(otherId);
      if (other) releaseToWander(other);
      toss = null;
    }
    if (chase && (chase.chaser === id || chase.flee === id)) {
      const otherId = chase.chaser === id ? chase.flee : chase.chaser;
      const other = byId.get(otherId);
      if (other) releaseToWander(other);
      chase = null;
    }
    if (pileup && pileup.members.includes(id)) {
      pileup.members.forEach((m) => {
        if (m === id) return;
        const rm = byId.get(m);
        if (rm) releaseToWander(rm);
      });
      pileup = null;
    }
    if (pendingPeek === id) pendingPeek = null;
  };

  const setCount = (n: number): void => {
    const next = Math.max(0, Math.floor(n));
    while (residents.length < next) {
      const r = makeResident();
      residents.push(r);
      byId.set(r.id, r);
    }
    while (residents.length > next) {
      const r = residents.pop();
      if (r) {
        forgetVignette(r);
        byId.delete(r.id);
      }
    }
  };

  const add = (): number => {
    const r = makeResident();
    residents.push(r);
    byId.set(r.id, r);
    return r.id;
  };

  const remove = (id: number): void => {
    const r = byId.get(id);
    if (!r) return;
    forgetVignette(r);
    byId.delete(id);
    const idx = residents.findIndex((x) => x.id === id);
    if (idx !== -1) residents.splice(idx, 1);
  };

  const grab = (id: number): void => {
    const r = byId.get(id);
    if (!r) return;
    // Grabbing an eligible resident (the view only grabs eligible ones), but
    // clear any state defensively so the drag fully owns it.
    forgetVignette(r);
    r.held = true;
    r.napping = false;
    r.busy = false;
    r.peeking = false;
    r.vignette = null;
    r.lift = 0;
    r.tilt = 0;
    r.gesture = null;
  };

  const release = (id: number, x?: number, y?: number): void => {
    const r = byId.get(id);
    if (!r) return;
    r.held = false;
    if (x !== undefined && y !== undefined) {
      r.x = clampFloorX(x);
      r.y = clampFloorY(y);
      r.scale = scaleFor(r.y);
    }
    r.modeTimer = rand(PAUSE_MIN, PAUSE_MAX);
    r.napBefore = rand(NAP_BEFORE_MIN, NAP_BEFORE_MAX);
    pickFloorPoint(scratch);
    r.tgtX = scratch.x;
    r.tgtY = scratch.y;
  };

  // Energy shortens pauses/nap frequency and quickens roaming — a busy pool is
  // more awake and restless, a quiet one drifts to sleep.
  const energyPace = (): number => 1.4 - 0.7 * energy; // >1 slower, <1 faster
  const easeRate = (): number => EASE_BASE + EASE_ENERGY * energy;

  const enterNap = (r: Resident): void => {
    r.napping = true;
    r.napLeft = rand(NAP_DUR_MIN, NAP_DUR_MAX) * (1.2 - 0.5 * energy);
  };
  const wake = (r: Resident): void => {
    r.napping = false;
    r.napBefore = rand(NAP_BEFORE_MIN, NAP_BEFORE_MAX) * energyPace();
    r.modeTimer = rand(PAUSE_MIN, PAUSE_MAX) * energyPace();
    r.gesture = 'bounce'; // stretch on waking
  };

  const isEligible = (r: Resident): boolean =>
    !r.napping && !r.busy && !r.pulled && !r.peeking && !r.held;

  /** Ids of every resident free to be recruited into a vignette. */
  const freeIds = (): number[] => {
    const out: number[] = [];
    for (const r of residents) if (isEligible(r)) out.push(r.id);
    return out;
  };

  /** Random distinct n-sample from `pool` (Fisher-Yates partial shuffle). */
  const sample = (pool: number[], n: number): number[] => {
    const copy = pool.slice();
    const picked: number[] = [];
    for (let k = 0; k < n && copy.length > 0; k += 1) {
      const idx = Math.floor(Math.random() * copy.length);
      picked.push(copy[idx]);
      copy.splice(idx, 1);
    }
    return picked;
  };

  // ── group vignette starters ────────────────────────────────────────────────
  const startBump = (free: number[]): void => {
    const [aId, bId] = sample(free, 2);
    if (aId === undefined || bId === undefined) return;
    const ra = byId.get(aId);
    const rb = byId.get(bId);
    if (!ra || !rb) return;
    ra.busy = true;
    rb.busy = true;
    ra.vignette = 'bump';
    rb.vignette = 'bump';
    const midX = (ra.x + rb.x) / 2;
    const midY = (ra.y + rb.y) / 2;
    ra.tgtX = midX + (ra.x - midX) * 0.28;
    ra.tgtY = midY + (ra.y - midY) * 0.28;
    rb.tgtX = midX + (rb.x - midX) * 0.28;
    rb.tgtY = midY + (rb.y - midY) * 0.28;
    ra.modeTimer = WALK_TIMEOUT;
    rb.modeTimer = WALK_TIMEOUT;
    pendingEvent = 'bump';
  };

  const startToss = (free: number[]): void => {
    const [aId, bId] = sample(free, 2);
    if (aId === undefined || bId === undefined) return;
    const ra = byId.get(aId);
    const rb = byId.get(bId);
    if (!ra || !rb) return;
    ra.busy = true;
    rb.busy = true;
    ra.vignette = 'toss';
    rb.vignette = 'toss';
    ra.gesture = 'wave';
    toss = { a: aId, b: bId, t: 0, dur: rand(TOSS_DUR_MIN, TOSS_DUR_MAX) };
    ball.active = true;
    ball.x = ra.x;
    ball.y = ra.y;
    pendingEvent = 'toss';
  };

  const startChase = (free: number[]): void => {
    const [chaserId, fleeId] = sample(free, 2);
    if (chaserId === undefined || fleeId === undefined) return;
    const rc = byId.get(chaserId);
    const rf = byId.get(fleeId);
    if (!rc || !rf) return;
    rc.busy = true;
    rf.busy = true;
    rc.vignette = 'chase';
    rf.vignette = 'chase';
    rf.gesture = 'hop';
    chase = { chaser: chaserId, flee: fleeId, timer: rand(CHASE_MIN, CHASE_MAX), retarget: 0 };
    pendingEvent = 'chase';
  };

  const startPileup = (free: number[]): void => {
    const members = sample(free, 3);
    if (members.length < 3) return;
    let cx = 0;
    let cy = 0;
    const recs: Resident[] = [];
    for (const id of members) {
      const r = byId.get(id);
      if (!r) return;
      recs.push(r);
      cx += r.x;
      cy += r.y;
    }
    cx /= recs.length;
    cy /= recs.length;
    recs.forEach((r, idx) => {
      r.busy = true;
      r.vignette = 'pileup';
      r.tgtX = clampFloorX(cx + (idx - 1) * 0.012);
      r.tgtY = clampFloorY(cy);
    });
    pileup = { members, phase: 'converge', timer: PILE_CONVERGE_TIMEOUT };
    pendingEvent = 'pileup';
  };

  const startVignette = (): void => {
    const free = freeIds();
    if (free.length < 2) return;
    const canPileup = free.length >= 3;
    const roll = Math.random();
    if (canPileup && roll < 0.12) startPileup(free);
    else if (roll < 0.4) startChase(free);
    else if (roll < 0.7) startToss(free);
    else startBump(free);
  };

  // ── per-frame vignette drivers ─────────────────────────────────────────────
  const stepToss = (dt: number): void => {
    if (!toss) return;
    const ra = byId.get(toss.a);
    const rb = byId.get(toss.b);
    if (!ra || !rb) {
      ball.active = false;
      toss = null;
      return;
    }
    toss.t += dt;
    const p = Math.min(toss.t / toss.dur, 1);
    const lx = ra.x + (rb.x - ra.x) * p;
    const ly = ra.y + (rb.y - ra.y) * p;
    // a little perpendicular bulge sells the arc of a thrown ball.
    const dx = rb.x - ra.x;
    const dy = rb.y - ra.y;
    const len = Math.hypot(dx, dy) || 1;
    const bulge = Math.sin(Math.PI * p) * 0.035;
    ball.x = lx + (-dy / len) * bulge;
    ball.y = ly + (dx / len) * bulge;

    if (p >= 1) {
      ball.active = false;
      const caught = Math.random() < TOSS_CATCH_CHANCE;
      if (caught) {
        rb.gesture = 'bounce';
      } else {
        rb.splatted = true;
        rb.splatTimer = SPLAT_DUR;
        rb.gesture = 'hop';
      }
      ra.gesture = null;
      releaseToWander(ra);
      releaseToWander(rb);
      toss = null;
    }
  };

  const stepChase = (dt: number): void => {
    if (!chase) return;
    const rc = byId.get(chase.chaser);
    const rf = byId.get(chase.flee);
    if (!rc || !rf) {
      chase = null;
      return;
    }
    chase.timer -= dt;
    chase.retarget -= dt;
    if (chase.retarget <= 0) {
      chase.retarget = CHASE_RETARGET_S;
      let dx = rf.x - rc.x;
      let dy = rf.y - rc.y;
      const len = Math.hypot(dx, dy) || 0.001;
      dx /= len;
      dy /= len;
      rf.tgtX = clampFloorX(rf.x + dx * CHASE_FLEE_STEP);
      rf.tgtY = clampFloorY(rf.y + dy * CHASE_FLEE_STEP * 0.6);
      rc.tgtX = rf.x;
      rc.tgtY = rf.y;
    }
    if (chase.timer <= 0) {
      const caught = Math.hypot(rf.x - rc.x, rf.y - rc.y) < BUMP_DIST * 1.6;
      rc.gesture = caught ? 'celebrate' : 'bounce';
      rf.gesture = caught ? 'petted' : 'wave';
      releaseToWander(rc);
      releaseToWander(rf);
      chase = null;
    }
  };

  const stepPileup = (dt: number): void => {
    if (!pileup) return;
    pileup.timer -= dt;
    const members = pileup.members;
    const recs = members.map((id) => byId.get(id)).filter((r): r is Resident => !!r);
    if (recs.length < members.length) {
      // A member vanished (removed) — abort cleanly, release survivors.
      recs.forEach((r) => releaseToWander(r));
      pileup = null;
      return;
    }
    if (pileup.phase === 'converge') {
      const allClose = recs.every((r) => Math.hypot(r.x - r.tgtX, r.y - r.tgtY) < 0.022);
      if (allClose || pileup.timer <= 0) {
        pileup.phase = 'stack';
        pileup.timer = rand(PILE_STACK_MIN, PILE_STACK_MAX);
        recs.forEach((r, idx) => {
          r.lift = idx * PILE_LIFT_STEP;
          r.tilt = (idx - 1) * PILE_TILT_STEP;
          if (idx === recs.length - 1) r.gesture = 'bounce';
        });
      }
      return;
    }
    if (pileup.phase === 'stack') {
      if (pileup.timer <= 0) {
        pileup.phase = 'topple';
        pileup.timer = PILE_TOPPLE_DUR;
        recs.forEach((r, idx) => {
          r.gesture = 'bounce';
          const dir = idx % 2 === 0 ? -1 : 1;
          r.tgtX = clampFloorX(r.x + dir * 0.09);
          r.tgtY = clampFloorY(r.y + 0.05);
        });
      }
      return;
    }
    // topple: decay lift/tilt back to rest while residents scatter outward.
    const decay = Math.min(1, dt * 6);
    recs.forEach((r) => {
      r.lift += (0 - r.lift) * decay;
      r.tilt += (0 - r.tilt) * decay;
    });
    if (pileup.timer <= 0) {
      recs.forEach((r) => releaseToWander(r));
      pileup = null;
    }
  };

  const stepPeek = (dt: number): void => {
    if (pendingPeek !== null) return; // already queued, waiting on the view to drain it
    peekTimer -= dt;
    if (peekTimer > 0) return;
    peekTimer = rand(PEEK_MIN, PEEK_MAX) * energyPace();
    const free = freeIds();
    if (free.length === 0) return;
    const id = free[Math.floor(Math.random() * free.length)];
    const r = byId.get(id);
    if (!r) return;
    r.busy = true;
    r.peeking = true;
    pendingPeek = id;
    pendingEvent = 'peek';
    // "the pool reacts" — a nearby free resident notices.
    const onlookers = free.filter((i) => i !== id);
    if (onlookers.length > 0) {
      const onlooker = byId.get(onlookers[Math.floor(Math.random() * onlookers.length)]);
      if (onlooker) onlooker.gesture = 'wave';
    }
  };

  const step = (dt: number, _nowS: number): void => {
    // WORK CLOCK (LAW 1): on the clock, no NEW horseplay starts (in-flight
    // vignettes below still finish so nothing freezes mid-toss).
    if (!workMode) {
      vignetteTimer -= dt;
      if (vignetteTimer <= 0) {
        startVignette();
        vignetteTimer = rand(VIGNETTE_MIN, VIGNETTE_MAX) * energyPace();
      }
      stepPeek(dt);
    }
    stepToss(dt);
    stepChase(dt);
    stepPileup(dt);

    const ease = 1 - Math.exp(-easeRate() * dt);

    for (let i = 0; i < residents.length; i += 1) {
      const r = residents[i];
      if (r.pulled || r.peeking || r.held) continue; // owned entirely by the view

      if (r.splatted) {
        r.splatTimer -= dt;
        if (r.splatTimer <= 0) {
          r.splatted = false;
          r.splatTimer = 0;
        }
      }

      if (r.napping) {
        r.napLeft -= dt;
        r.scale += (scaleFor(r.y) - r.scale) * ease;
        if (r.napLeft <= 0) wake(r);
        continue;
      }

      if (r.vignette === 'toss') {
        // frozen in place, waiting on the ball — just settle depth scale.
        r.scale += (scaleFor(r.y) - r.scale) * ease;
        continue;
      }

      if (!r.busy && !workMode) {
        // ── awake, free, on break: consider napping ─────────────────────────
        r.napBefore -= dt;
        if (r.napBefore <= 0) {
          if (Math.random() < NAP_CHANCE) {
            enterNap(r);
            continue;
          }
          r.napBefore = rand(NAP_BEFORE_MIN, NAP_BEFORE_MAX) * energyPace();
        }
        // ── idle wave/hop ───────────────────────────────────────────────────
        r.waveTimer -= dt;
        if (r.waveTimer <= 0) {
          r.gesture = Math.random() < 0.5 ? 'wave' : 'hop';
          r.waveTimer = rand(IDLE_WAVE_MIN, IDLE_WAVE_MAX) * energyPace();
        }
      }

      // ── travel toward target ────────────────────────────────────────────
      const dx = r.tgtX - r.x;
      const dy = r.tgtY - r.y;
      const dist = Math.hypot(dx, dy);
      r.modeTimer -= dt;

      if (r.vignette === 'bump') {
        if (dist <= BUMP_DIST) {
          r.gesture = 'bounce';
          releaseToWander(r);
        } else {
          r.x += dx * ease;
          r.y += dy * ease;
        }
      } else if (r.vignette === 'chase' || r.vignette === 'pileup') {
        // fully driven by stepChase/stepPileup's own phase machine — just move.
        r.x += dx * ease;
        r.y += dy * ease;
      } else if (dist > ARRIVE_DIST && r.modeTimer > 0) {
        r.x += dx * ease;
        r.y += dy * ease;
      } else if (r.modeTimer <= 0) {
        pickFloorPoint(scratch);
        r.tgtX = scratch.x;
        r.tgtY = scratch.y;
        r.modeTimer = rand(PAUSE_MIN, PAUSE_MAX) * energyPace();
      }

      r.scale += (scaleFor(r.y) - r.scale) * ease;
    }
  };

  const beginPull = (): number => {
    if (residents.length === 0) return -1;
    // Prefer a free, awake resident nearest the pool centre — a clean subject
    // for the tractor-beam lift. `busy`/`peeking`/`held` are a HARD exclusion,
    // not a penalty: a resident mid-vignette or in the user's hand is owned
    // elsewhere and a real spawn pull must never grab it out from under that.
    let best: Resident | null = null;
    let bestScore = Infinity;
    for (const r of residents) {
      if (r.pulled || r.peeking || r.busy || r.held) continue;
      const centred = Math.hypot(r.x - FLOOR_CX, r.y - FLOOR_CY);
      const penalty = r.napping ? 0.5 : 0;
      const score = centred + penalty;
      if (score < bestScore) {
        bestScore = score;
        best = r;
      }
    }
    if (!best) {
      // Everyone free is exhausted — a real spawn must still succeed, so fall
      // back to any not-already-pulled resident rather than fail the spawn.
      for (const r of residents) {
        if (!r.pulled) {
          best = r;
          break;
        }
      }
    }
    if (!best) return -1; // every resident is already mid-real-pull
    best.pulled = true;
    best.napping = false;
    best.busy = false;
    best.peeking = false;
    best.held = false;
    best.vignette = null;
    return best.id;
  };

  const releasePull = (id: number): void => {
    const r = byId.get(id);
    if (!r) return;
    r.pulled = false;
    r.modeTimer = rand(PAUSE_MIN, PAUSE_MAX);
    r.napBefore = rand(NAP_BEFORE_MIN, NAP_BEFORE_MAX);
  };

  const takeGesture = (id: number): GestureName | null => {
    const r = byId.get(id);
    if (!r || r.gesture === null) return null;
    const g = r.gesture;
    r.gesture = null;
    return g;
  };

  const takePeekRequest = (): number | null => {
    if (pendingPeek === null) return null;
    const id = pendingPeek;
    pendingPeek = null;
    return id;
  };

  const endPeek = (id: number): void => {
    const r = byId.get(id);
    if (!r) return;
    r.peeking = false;
    r.busy = false;
    r.modeTimer = rand(PAUSE_MIN, PAUSE_MAX);
    r.napBefore = rand(NAP_BEFORE_MIN, NAP_BEFORE_MAX);
  };

  const takeEvent = (): PoolEventKind | null => {
    if (pendingEvent === null) return null;
    const ev = pendingEvent;
    pendingEvent = null;
    return ev;
  };

  return {
    residents,
    ball,
    setCount,
    setEnergy: (e: number) => {
      energy = e < 0 ? 0 : e > 1 ? 1 : e;
    },
    setWorkMode: (on: boolean) => {
      workMode = on;
    },
    step,
    beginPull,
    releasePull,
    grab,
    release,
    add,
    remove,
    residentById: (id: number) => byId.get(id),
    isGrabbable: (id: number) => {
      const r = byId.get(id);
      return !!r && !r.busy && !r.pulled && !r.peeking && !r.held;
    },
    takeGesture,
    takePeekRequest,
    endPeek,
    takeEvent,
    roamMovement,
    napMovement,
    workMovement,
  };
}
