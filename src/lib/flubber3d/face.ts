/**
 * flubber3d/face — the expression contract: face recipes (eye/brow/mouth
 * scaling per expression), the expression→clip map, the dev-mode invariant
 * that keeps the two key sets in lockstep, the pivot-group builders used to
 * blink/squash whole eyes around their own centers, and the blink/gaze
 * timing constants. Extracted verbatim from FlubberMesh.tsx (Phase 1 of
 * docs/plans/flubber-3d-everywhere.md) — every tier of Blubber (hero, MID,
 * MICRO) reads the SAME recipes so a "celebrating" micro avatar and the
 * dashboard hero always agree on what celebrating looks like.
 */

import * as THREE from 'three';

export type ClipName =
  | 'Idle'
  | 'Wave'
  | 'Celebrate'
  | 'Worried'
  | 'Focus'
  | 'Think'
  | 'Surprise'
  | 'Sleepy'
  | 'Mischief'
  | 'Groove';

export const ALL_CLIP_NAMES: Record<ClipName, 1> = {
  Idle: 1, Wave: 1, Celebrate: 1, Worried: 1, Focus: 1,
  Think: 1, Surprise: 1, Sleepy: 1, Mischief: 1, Groove: 1,
};

export type FaceState = 'happy' | 'worried';
export type Pair = readonly [number, number];

export interface FaceRecipe {
  face: FaceState;
  eyeX: Pair;
  eyeY: Pair;
  eyeTilt: Pair;
  browTilt: Pair;
  browLift: Pair;
  brow: boolean;
  mouthX: number;
  mouthY: number;
  mouthTilt: number;
  mouthLift: number;
  hearts: boolean;
  gaze: number;
}

const faceRecipe = (overrides: Partial<FaceRecipe> = {}): FaceRecipe => ({
  face: 'happy',
  eyeX: [1, 1],
  eyeY: [1, 1],
  eyeTilt: [0, 0],
  browTilt: [0, 0],
  browLift: [0, 0],
  brow: false,
  mouthX: 1,
  mouthY: 1,
  mouthTilt: 0,
  mouthLift: 0,
  hearts: false,
  gaze: 1,
  ...overrides,
});

// V3.3 expression recipes mirror the 2D pose library without requiring
// twenty heavyweight full-body clips. Body motion, eyes, brows, mouth,
// blink and gaze are independently layerable and crossfade together.
export const FACE_RECIPES: Record<string, FaceRecipe> = {
  idle: faceRecipe(),
  happy: faceRecipe({ mouthX: 1.12, mouthY: 1.12 }),
  waving: faceRecipe({ mouthX: 0.92, mouthY: 0.86, gaze: 0.35 }),
  working: faceRecipe({ eyeY: [0.94, 0.94], mouthX: 0.78, mouthY: 0.65, gaze: 0.55 }),
  excited: faceRecipe({ eyeX: [1.06, 1.06], eyeY: [1.08, 1.08], mouthX: 1.15, mouthY: 1.65, gaze: 0.45 }),
  focused: faceRecipe({ eyeY: [0.78, 0.78], eyeTilt: [-0.08, 0.08], brow: true, browTilt: [-0.34, 0.34], browLift: [-0.015, -0.015], mouthX: 0.72, mouthY: 0.48, gaze: 0.3 }),
  thinking: faceRecipe({ face: 'worried', eyeY: [0.92, 0.78], eyeTilt: [0.02, -0.12], brow: true, browTilt: [0.22, -0.12], browLift: [0.02, 0.055], mouthX: 0.72, mouthY: 0.72, mouthTilt: -0.08, gaze: 0.45 }),
  confused: faceRecipe({ face: 'worried', eyeY: [0.96, 0.88], eyeTilt: [0.08, -0.08], brow: true, browTilt: [0.26, 0.02], browLift: [0.055, 0.015], mouthX: 0.82, mouthY: 0.78, mouthTilt: 0.08, gaze: 0.55 }),
  tired: faceRecipe({ face: 'worried', eyeY: [0.35, 0.35], eyeTilt: [0.03, -0.03], brow: true, browTilt: [0.12, -0.12], browLift: [-0.025, -0.025], mouthX: 0.8, mouthY: 0.72, gaze: 0.15 }),
  surprised: faceRecipe({ eyeX: [0.94, 0.94], eyeY: [1.14, 1.14], mouthX: 0.72, mouthY: 2.05, gaze: 0.25 }),
  celebrating: faceRecipe({ eyeY: [0.35, 0.35], eyeTilt: [-0.08, 0.08], mouthX: 1.18, mouthY: 1.55, gaze: 0.2 }),
  sleeping: faceRecipe({ face: 'worried', eyeY: [0.08, 0.08], eyeTilt: [0.06, -0.06], mouthX: 0.78, mouthY: 0.62, mouthTilt: -0.06, gaze: 0 }),
  mischievous: faceRecipe({ eyeY: [0.72, 0.9], eyeTilt: [-0.14, 0.08], brow: true, browTilt: [-0.4, 0.3], browLift: [-0.02, 0.01], mouthX: 0.92, mouthY: 0.62, mouthTilt: -0.18, gaze: 0.25 }),
  determined: faceRecipe({ face: 'worried', eyeY: [0.76, 0.76], eyeTilt: [-0.1, 0.1], brow: true, browTilt: [-0.38, 0.38], browLift: [-0.02, -0.02], mouthX: 0.86, mouthY: 0.68, gaze: 0.2 }),
  overjoyed: faceRecipe({ eyeX: [1.05, 1.05], eyeY: [1.05, 1.05], mouthX: 1.32, mouthY: 1.68, gaze: 0.25 }),
  plotting: faceRecipe({ eyeY: [0.86, 0.98], eyeTilt: [-0.08, 0.06], mouthX: 0.7, mouthY: 0.55, mouthTilt: -0.12, gaze: 0.25 }),
  'heart-eyes': faceRecipe({ eyeX: [1.04, 1.04], eyeY: [1.04, 1.04], mouthX: 1.12, mouthY: 1.5, hearts: true, gaze: 0.15 }),
  worried: faceRecipe({ face: 'worried', eyeY: [0.94, 0.94], eyeTilt: [0.03, -0.03], brow: true, browTilt: [0.24, -0.24], browLift: [0.045, 0.045], mouthX: 0.82, mouthY: 0.78, gaze: 0.25 }),
  disappointed: faceRecipe({ face: 'worried', eyeY: [0.62, 0.62], eyeTilt: [0.08, -0.08], brow: true, browTilt: [0.3, -0.3], browLift: [-0.015, -0.015], mouthX: 0.9, mouthY: 0.82, gaze: 0.2 }),
  'dj-mode': faceRecipe({ eyeX: [1.04, 1.04], eyeY: [0.9, 1.05], eyeTilt: [-0.1, 0.08], mouthX: 1.05, mouthY: 1.42, mouthTilt: 0.08, gaze: 0.15 }),
};

export const EXPRESSION_CLIPS: Record<string, ClipName> = {
  idle: 'Idle', happy: 'Idle', waving: 'Wave', working: 'Focus', focused: 'Focus',
  determined: 'Focus', thinking: 'Think', confused: 'Think', plotting: 'Mischief',
  worried: 'Worried', disappointed: 'Worried', tired: 'Sleepy', sleeping: 'Sleepy',
  surprised: 'Surprise', excited: 'Surprise', celebrating: 'Celebrate',
  overjoyed: 'Celebrate', 'heart-eyes': 'Celebrate', mischievous: 'Mischief',
  'dj-mode': 'Groove',
};

if (process.env.NODE_ENV !== 'production') {
  const faceKeys = Object.keys(FACE_RECIPES).sort().join('|');
  const clipKeys = Object.keys(EXPRESSION_CLIPS).sort().join('|');
  if (faceKeys !== clipKeys) {
    throw new Error(`Blubber expression contract mismatch: faces=${faceKeys}; clips=${clipKeys}`);
  }
}

export function resolveClipName(expression: string): ClipName {
  return EXPRESSION_CLIPS[expression] ?? 'Idle';
}

export function resolveFaceRecipe(expression: string): FaceRecipe {
  return FACE_RECIPES[expression] ?? FACE_RECIPES.idle;
}

export function wantsWorriedFace(expression: string): boolean {
  return resolveFaceRecipe(expression).face === 'worried';
}

export const CROSSFADE_SECONDS = 0.35;

// squash/stretch spring — critically-underdamped, tuned for a mesh scale
export const SQUASH_SPRING_K = 55;
export const SQUASH_SPRING_C = 8.5;
export const SQUASH_KICK = 7;

// BLINKS
export const BLINK_MIN_INTERVAL_S = 2.5;
export const BLINK_MAX_INTERVAL_S = 6;
export const BLINK_DOUBLE_CHANCE = 0.15;
export const BLINK_DOUBLE_GAP_S = 0.13;
export const BLINK_HOLD_S = 0.04;
export const BLINK_CLOSED_Y_FULL = 0.08;
export const BLINK_CLOSED_Y_REDUCED = 0.5;

// GAZE
export const GAZE_MAX_YAW_RAD = 0.12;
export const GAZE_MAX_PITCH_RAD = 0.08;
export const GAZE_LERP_RATE = 9;
export const GAZE_IDLE_TIMEOUT_S = 4;
export const GAZE_NON_IDLE_CLIP_DAMP = 0.3;
export const GAZE_AUTO_LOOK_MIN_S = 5;
export const GAZE_AUTO_LOOK_MAX_S = 9;
export const GAZE_AUTO_LOOK_AMPLITUDE = 0.6;

export function easeOutQuad(t: number): number {
  return t * (2 - t);
}

export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reparents `members` (all direct children of `parent` — e.g. one eye's
 * ball + rim + 2 highlights, all rigid bone-parented to Head) into a fresh
 * pivot Group centered on their combined local-position average. Scaling the
 * returned Group squashes the whole eye around THAT point, instead of each
 * part squashing around its own (which would visibly drift the rim/
 * highlights off the eyeball mid-blink). */
export function buildLocalPivotGroup(parent: THREE.Object3D, members: THREE.Object3D[]): THREE.Group | null {
  if (members.length === 0) return null;
  const center = new THREE.Vector3();
  members.forEach((member) => center.add(member.position));
  center.divideScalar(members.length);

  const group = new THREE.Group();
  group.position.copy(center);
  parent.add(group);

  members.forEach((member) => {
    const localPos = member.position.clone().sub(center);
    group.add(member);
    member.position.copy(localPos);
  });

  return group;
}

export function buildEyePivotGroup(parent: THREE.Object3D, members: THREE.Object3D[]): THREE.Group | null {
  return buildLocalPivotGroup(parent, members);
}

export interface EyeExpressionRig {
  group: THREE.Group;
  face: FaceState;
  side: 'L' | 'R';
  brow: THREE.Mesh;
  heart: THREE.Mesh;
  browBaseY: number;
  expressionX: number;
  expressionY: number;
  expressionTilt: number;
  expressionBrowTilt: number;
  expressionBrowLift: number;
}

export interface MouthExpressionRig {
  group: THREE.Group;
  face: FaceState;
  baseY: number;
  expressionX: number;
  expressionY: number;
  expressionTilt: number;
  expressionLift: number;
}

export function createHeartGeometry(width: number, height: number): THREE.ShapeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, -0.78);
  shape.bezierCurveTo(-0.22, -0.46, -0.92, -0.05, -0.92, 0.45);
  shape.bezierCurveTo(-0.92, 0.96, -0.28, 1.12, 0, 0.62);
  shape.bezierCurveTo(0.28, 1.12, 0.92, 0.96, 0.92, 0.45);
  shape.bezierCurveTo(0.92, -0.05, 0.22, -0.46, 0, -0.78);
  const geometry = new THREE.ShapeGeometry(shape, 12);
  geometry.scale(width * 0.34, height * 0.34, 1);
  return geometry;
}
