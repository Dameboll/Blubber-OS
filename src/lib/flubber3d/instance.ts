/**
 * flubber3d/instance — createFlubberInstance(tier): one live 3D Blubber as a
 * pure three.js object (scene + camera + mixer + face rigs + squash spring),
 * no React, no renderer of its own. The FlubberHost renders many of these
 * with ONE shared WebGLRenderer (see host.ts). Phase 1 of
 * docs/plans/flubber-3d-everywhere.md.
 *
 * Tiers:
 *   hero  — full goo (transmission) + backdrop glow + droplets + interior
 *           bubbles + studio lights + authored PMREM env. ≥160px slots.
 *   mid   — clearcoat jelly (no transmission pass), lights + env, no
 *           bubbles/droplets/backdrop. 64–159px slots.
 *   micro — baked matcap, unlit, no lights, no env. <64px slots, updated at
 *           ~20fps by the host's tier clock.
 *
 * All tiers share the SAME face recipes, clips, blink machine and squash
 * spring from face.ts — a micro Blubber celebrating is the same celebration,
 * just cheaper to draw.
 */

import * as THREE from 'three';
import {
  loadModel,
  loadMatcaps,
  cloneBlubber,
  type MatcapTextures,
} from './assets';
import {
  BLINK_CLOSED_Y_FULL,
  BLINK_CLOSED_Y_REDUCED,
  BLINK_DOUBLE_CHANCE,
  BLINK_DOUBLE_GAP_S,
  BLINK_HOLD_S,
  BLINK_MAX_INTERVAL_S,
  BLINK_MIN_INTERVAL_S,
  CROSSFADE_SECONDS,
  SQUASH_KICK,
  SQUASH_SPRING_C,
  SQUASH_SPRING_K,
  buildEyePivotGroup,
  buildLocalPivotGroup,
  createHeartGeometry,
  easeOutQuad,
  createSeededRandom,
  resolveClipName,
  resolveFaceRecipe,
  wantsWorriedFace,
  ALL_CLIP_NAMES,
  type ClipName,
  type EyeExpressionRig,
  type FaceState,
  type MouthExpressionRig,
} from './face';
import {
  BUBBLE_BELLY_CENTER_Y_FRACTION,
  BUBBLE_BOB_AMPLITUDE_FRACTION,
  BUBBLE_BOB_FREQ_MAX,
  BUBBLE_BOB_FREQ_MIN,
  BUBBLE_COUNT,
  BUBBLE_FORWARD_Z_FRACTION,
  BUBBLE_RADIUS_MAX_FRACTION,
  BUBBLE_RADIUS_MIN_FRACTION,
  BUBBLE_SPREAD_X_FRACTION,
  BUBBLE_SPREAD_Y_FRACTION,
  BUBBLE_SPREAD_Z_FRACTION,
  DROPLET_BASE_VERTEX_COLOR,
  DROPLET_BOB_AMPLITUDE_FRACTION,
  DROPLET_COUNT,
  DROPLET_ORBIT_RADIUS_FRACTION,
  DROPLET_RADIUS_MAX_FRACTION,
  DROPLET_RADIUS_MIN_FRACTION,
  GOO_ATTENUATION_DISTANCE_FRACTION,
  GOO_BACKDROP_DISTANCE_FRACTION,
  GOO_BACKDROP_FILL_FACTOR,
  GOO_THICKNESS_FRACTION,
  HERO_BACKDROP_SCALE,
  HERO_FRAME_CENTER_Y_FRACTION,
  HERO_FRAME_HEIGHT_FRACTION,
  HERO_FRAME_WIDTH_FRACTION,
  WOBBLE_BASE_AMP_FRACTION,
  WOBBLE_IMPACT_MAX,
  WOBBLE_IMPACT_VELOCITY_FACTOR,
  WOBBLE_REDUCED_MOTION_FACTOR,
  applyUniformVertexColor,
  createBubbleCavityMaterial,
  createClearcoatGooMaterial,
  createGooBackdropTexture,
  createGooMaterial,
  createMicroSkinMaterial,
  createWobbleUniforms,
  upgradeMaterials,
  upgradeMaterialsMicro,
  type WobbleUniforms,
} from './materials';
import { buildWorkstation, type Workstation } from './workstation';
import {
  createMotionController,
  type GestureName,
  type MotionController,
  type MovementConfig,
} from './motion';

export type FlubberTier = 'hero' | 'mid' | 'micro';

/** Optional scene variant a slot renders in. 'workstation' adds a desk +
 * laptop + holo screens + ring (mid tier only) — the agent's little 3D room. */
export type FlubberScene = 'plain' | 'workstation';

/** A worn accessory parented to the Head bone so it tracks all head motion
 * (clip animation, squash, rotation) — currently just the DJ's headphones. */
export type FlubberAccessory = 'dj-headphones';

export interface FlubberInstanceOptions {
  tier: FlubberTier;
  expression?: string;
  /** Shared PMREM env texture (hero/mid). Host supplies it once per renderer. */
  environment?: THREE.Texture | null;
  prefersReducedMotion?: boolean;
  /** Seed so a grid of micros doesn't blink in unison. */
  seed?: number;
  /** Scene variant. 'workstation' only builds at hero/mid, ignored at micro. */
  scene?: FlubberScene;
  /** Worn accessory attached to the Head bone. Ignored at micro tier. */
  accessory?: FlubberAccessory;
}

/** Imperative workstation state — driven by the spawn choreography at 60fps
 * without React re-renders. */
export interface WorkstationState {
  materialize?: number;
  progress?: number;
}

interface Droplet {
  mesh: THREE.Mesh;
  phase: number;
  angularSpeed: number;
  orbitRadiusX: number;
  orbitRadiusZ: number;
  bobAmplitude: number;
  bobFreq: number;
  bobPhase: number;
  centerY: number;
  centerZ: number;
}

interface Bubble {
  index: number;
  x: number;
  z: number;
  scale: number;
  baseY: number;
  bobAmplitude: number;
  bobFreq: number;
  bobPhase: number;
}

export interface FlubberInstance {
  readonly tier: FlubberTier;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** true once the GLB clone is mounted and the camera framed. */
  readonly ready: boolean;
  /** Current clip name (mirrors data-flubber-clip on the slot). */
  readonly currentClip: ClipName | null;
  setExpression(expression: string): void;
  /** One-shot squash-then-rebound pulse. */
  pulse(): void;
  /** Drive the workstation's spawn-in / progress imperatively (no-op if this
   * instance has no workstation). */
  setWorkstation(state: WorkstationState): void;
  /** Configure procedural locomotion. Pass null to fall back to the global
   * runtime config (energyLevel/movementAmount from /api/brain). */
  setMovement(cfg: MovementConfig | null): void;
  /** Play a one-shot readable gesture on the body. */
  playGesture(name: GestureName): void;
  /** Quick reaction to a pointer entering ('hover') or clicking ('click') the
   * slot. */
  reactToPointer(kind: 'hover' | 'click'): void;
  /** Advance animation by dt seconds at absolute time nowS (seconds). */
  update(dt: number, nowS: number): void;
  dispose(): void;
}

/** Builds procedural DJ headphones and parents them to the Head bone so they
 * ride every head motion — the clip animation, the root squash, and head
 * rotation. Replaces the old 2D SVG overlay that detached the moment the DJ
 * Blubber danced. Sized from the body box (a skinned rig's bones carry no
 * geometry, so the head bone's own box is unreliable), positioned at the head
 * centre in the anchor's local frame, and counter-scaled so world-sized
 * geometry renders correctly under any bone scale. */
function buildDjHeadphones(
  anchor: THREE.Object3D,
  bodyBox: THREE.Box3,
  ownedGeometries: THREE.BufferGeometry[],
  ownedMaterials: THREE.Material[],
): void {
  anchor.updateWorldMatrix(true, false);
  const size = bodyBox.getSize(new THREE.Vector3());
  const center = bodyBox.getCenter(new THREE.Vector3());
  const r = size.x * 0.5;
  const headCentreWorld = new THREE.Vector3(center.x, bodyBox.min.y + size.y * 0.66, center.z);

  const material = new THREE.MeshPhysicalMaterial({
    color: 0x0b1a11,
    roughness: 0.26,
    metalness: 0.12,
    clearcoat: 0.7,
    clearcoatRoughness: 0.16,
    emissive: 0x2fe07a,
    emissiveIntensity: 0.32,
  });
  ownedMaterials.push(material);

  const group = new THREE.Group();
  group.name = 'DjHeadphones';

  // headband — a half-torus arcing ear-to-ear over the crown
  const bandGeo = new THREE.TorusGeometry(r * 0.98, r * 0.1, 14, 44, Math.PI);
  ownedGeometries.push(bandGeo);
  const band = new THREE.Mesh(bandGeo, material);
  band.renderOrder = 6;
  group.add(band);

  // two ear cups — cylinders lying on their side at the ear line
  const cupGeo = new THREE.CylinderGeometry(r * 0.3, r * 0.3, r * 0.22, 24);
  ownedGeometries.push(cupGeo);
  for (const sx of [-1, 1] as const) {
    const cup = new THREE.Mesh(cupGeo, material);
    cup.renderOrder = 6;
    cup.rotation.z = Math.PI / 2;
    cup.position.set(sx * r * 0.98, 0, size.z * 0.08);
    group.add(cup);
  }

  anchor.add(group);
  group.position.copy(anchor.worldToLocal(headCentreWorld.clone()));
  const anchorScale = new THREE.Vector3();
  anchor.getWorldScale(anchorScale);
  const inv = anchorScale.x !== 0 ? 1 / anchorScale.x : 1;
  group.scale.setScalar(inv);
}

export function createFlubberInstance(options: FlubberInstanceOptions): FlubberInstance {
  const { tier, environment = null, seed = 1 } = options;
  const prefersReducedMotion = options.prefersReducedMotion ?? false;
  const random = createSeededRandom(0xf10bb37 ^ (seed * 2654435761));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  camera.position.set(0, 1, 4);
  camera.lookAt(0, 1, 0);

  const root = new THREE.Group();
  scene.add(root);

  if (tier !== 'micro') {
    // Studio lights (same rig as the FlubberMesh hero) — physical materials
    // need real emitters for localized wet highlights.
    const softFill = new THREE.HemisphereLight(0x8dff91, 0x031909, 0.65);
    const heroKey = new THREE.PointLight(0xe8ffdf, 5, 9, 2);
    heroKey.position.set(-2.4, 3.4, 3.3);
    const faceFill = new THREE.PointLight(0x7dff82, 1, 7, 2);
    faceFill.position.set(2.2, 1.6, 3.2);
    const gelRim = new THREE.PointLight(0x3cff59, 10, 8, 2);
    gelRim.position.set(2.6, 2.5, -2.4);
    scene.add(softFill, heroKey, faceFill, gelRim);
    if (environment) scene.environment = environment;
  }

  const wobbleUniforms: WobbleUniforms = createWobbleUniforms();

  let disposed = false;
  let ready = false;
  // The externally-requested expression (setExpression / brain mood).
  let expression = options.expression ?? 'idle';
  // What's actually rendered right now — a gesture can override `expression`
  // for its duration, then hand control back.
  let effectiveExpression = expression;
  let renderedExpression: string | null = null;
  let currentClip: ClipName | null = null;
  let mixer: THREE.AnimationMixer | null = null;
  const actions: Partial<Record<ClipName, THREE.AnimationAction>> = {};
  const nodes: Record<string, THREE.Object3D> = {};
  const eyeExpressionRigs: EyeExpressionRig[] = [];
  const mouthExpressionRigs: MouthExpressionRig[] = [];
  const ownedGeometries: THREE.BufferGeometry[] = [];
  const ownedMaterials: THREE.Material[] = [];
  let skinMaterial: THREE.Material | null = null;
  let backdropMesh: THREE.Mesh | null = null;
  const droplets: Droplet[] = [];
  const bubbles: Bubble[] = [];
  let bubbleMesh: THREE.InstancedMesh | null = null;
  let microBubbleDummy: THREE.Object3D | null = null;

  const squash = { value: 0, velocity: 0 };
  // Workstation (agent's 3D room) — built at mid/hero when opts.scene requests it.
  const wantsWorkstation = options.scene === 'workstation' && tier !== 'micro';
  // Worn accessory (DJ headphones) — parented to the Head bone after the GLB
  // loads so it rides the clip animation, squash, and head rotation.
  const wantsAccessory = options.accessory != null && tier !== 'micro';
  let workstation: Workstation | null = null;
  // Pending workstation state — setWorkstation() can be called before the GLB
  // (and thus the workstation) exists; store the values and apply on build.
  // Default materialize = 1 so a workstation shows immediately unless the spawn
  // choreography explicitly hides it (it sets materialize:0 then animates in).
  let pendingMaterialize = 1;
  let pendingProgress = 0;
  // Forward "leaning into the laptop, hands going" body language while working.
  const lean = { value: 0, target: 0 };
  // Procedural locomotion + gestures — built once the body is measured (needs
  // its box). Movement/gesture calls before then are buffered like the
  // workstation state, so a slot can be driven the instant it registers.
  let motion: MotionController | null = null;
  let pendingMovement: MovementConfig | null | undefined;
  let pendingGesture: GestureName | null = null;
  let pendingPointer: 'hover' | 'click' | null = null;

  const blink = {
    phase: 'idle' as 'idle' | 'closing' | 'holding' | 'opening',
    timer: BLINK_MIN_INTERVAL_S + random() * (BLINK_MAX_INTERVAL_S - BLINK_MIN_INTERVAL_S),
    scaleY: 1,
    closeDuration: 0.08,
    openDuration: 0.125,
    queuedDouble: false,
  };

  const applyFaceVisibility = () => {
    const worried = wantsWorriedFace(effectiveExpression);
    Object.entries(nodes).forEach(([name, obj]) => {
      if (!name.startsWith('Face_')) return;
      obj.visible = worried ? name.startsWith('Face_worried') : name.startsWith('Face_happy');
    });
  };

  const applyClip = (immediate: boolean) => {
    const nextName = resolveClipName(effectiveExpression);
    if (nextName === currentClip) return;
    const nextAction = actions[nextName];
    if (!nextAction) return;
    const prevAction = currentClip ? actions[currentClip] : null;
    currentClip = nextName;

    nextAction.reset();
    nextAction.enabled = true;
    nextAction.setEffectiveWeight(1);
    nextAction.setEffectiveTimeScale(prefersReducedMotion ? 0.05 : 1);
    nextAction.play();

    if (prevAction && prevAction !== nextAction) {
      if (immediate || prefersReducedMotion) {
        prevAction.stop();
      } else {
        prevAction.crossFadeTo(nextAction, CROSSFADE_SECONDS, true);
      }
    }
  };

  const frameCamera = (box: THREE.Box3) => {
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const verticalFov = THREE.MathUtils.degToRad(camera.fov);
    const framedHeight = Math.max(
      size.y / HERO_FRAME_HEIGHT_FRACTION,
      size.x / Math.max(camera.aspect * HERO_FRAME_WIDTH_FRACTION, 0.01),
    );
    const distance = framedHeight / (2 * Math.tan(verticalFov / 2));
    camera.position.set(center.x, center.y + size.y * HERO_FRAME_CENTER_Y_FRACTION, center.z + distance);
    camera.near = Math.max(0.01, distance - size.z * 3);
    camera.far = distance + size.z * 5;
    camera.lookAt(center.x, center.y + size.y * HERO_FRAME_CENTER_Y_FRACTION, center.z);
    camera.updateProjectionMatrix();
  };

  Promise.all([loadModel(), loadMatcaps()]).then(([{ scene: gltfScene, animations }, matcaps]) => {
    if (disposed) return;
    const instanceRoot = cloneBlubber(gltfScene);

    if (tier === 'hero') {
      skinMaterial = createGooMaterial(wobbleUniforms);
      upgradeMaterials(instanceRoot, skinMaterial);
    } else if (tier === 'mid') {
      skinMaterial = createClearcoatGooMaterial(wobbleUniforms);
      upgradeMaterials(instanceRoot, skinMaterial);
    } else {
      skinMaterial = createMicroSkinMaterial(matcaps);
      upgradeMaterialsMicro(instanceRoot, matcaps, skinMaterial);
    }
    ownedMaterials.push(skinMaterial);
    // upgradeMaterials creates fresh per-mesh face materials — collect them
    // for dispose.
    instanceRoot.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.material !== skinMaterial) {
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        materials.forEach((material) => ownedMaterials.push(material));
      }
    });

    root.add(instanceRoot);
    instanceRoot.traverse((obj) => {
      nodes[obj.name] = obj;
    });

    mixer = new THREE.AnimationMixer(instanceRoot);
    animations.forEach((clip) => {
      if (clip.name in ALL_CLIP_NAMES) {
        actions[clip.name as ClipName] = mixer!.clipAction(clip);
        actions[clip.name as ClipName]!.setLoop(THREE.LoopRepeat, Infinity);
      }
    });

    applyFaceVisibility();
    applyClip(true);
    renderedExpression = effectiveExpression;
    // Desync looped clips across a grid of instances.
    const active = currentClip ? actions[currentClip] : null;
    if (active?.getClip()) active.time = random() * active.getClip().duration;

    // --- face rigs (eye pivot groups + brows + hearts + mouth groups) ---
    const eyeMembersByGroup: Record<string, THREE.Object3D[]> = {};
    Object.entries(nodes).forEach(([name, obj]) => {
      if (!name.includes('Eye')) return;
      const faceState = name.startsWith('Face_happy_') ? 'happy' : name.startsWith('Face_worried_') ? 'worried' : null;
      const side = name.endsWith('_L') ? 'L' : name.endsWith('_R') ? 'R' : null;
      if (!faceState || !side) return;
      const key = `${faceState}_${side}`;
      if (!eyeMembersByGroup[key]) eyeMembersByGroup[key] = [];
      eyeMembersByGroup[key].push(obj);
    });
    const browMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x071107,
      roughness: 0.22,
      clearcoat: 0.45,
      clearcoatRoughness: 0.1,
    });
    const heartMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xffe58a,
      emissive: 0x8f5b18,
      emissiveIntensity: 0.22,
      roughness: 0.18,
      clearcoat: 0.8,
      clearcoatRoughness: 0.06,
      side: THREE.DoubleSide,
    });
    ownedMaterials.push(browMaterial, heartMaterial);

    Object.entries(eyeMembersByGroup).forEach(([key, members]) => {
      const parent = members[0].parent;
      if (!parent) return;
      const group = buildEyePivotGroup(parent, members);
      if (!group) return;

      const [face, side] = key.split('_') as [FaceState, 'L' | 'R'];
      group.updateWorldMatrix(true, true);
      const eyeSize = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
      const browGeometry = new THREE.CapsuleGeometry(
        Math.max(eyeSize.y * 0.03, 0.006),
        Math.max(eyeSize.x * 0.42, 0.055),
        4,
        10,
      );
      browGeometry.rotateZ(Math.PI / 2);
      ownedGeometries.push(browGeometry);
      const brow = new THREE.Mesh(browGeometry, browMaterial);
      brow.name = `ExpressionBrow_${face}_${side}`;
      brow.position.copy(group.position);
      brow.position.y += eyeSize.y * 0.61;
      brow.position.z += eyeSize.z * 0.62;
      brow.visible = false;
      brow.renderOrder = 4;
      parent.add(brow);

      const heartGeometry = createHeartGeometry(eyeSize.x, eyeSize.y);
      ownedGeometries.push(heartGeometry);
      const heart = new THREE.Mesh(heartGeometry, heartMaterial);
      heart.name = `ExpressionHeart_${face}_${side}`;
      heart.position.z = eyeSize.z * 0.72;
      heart.visible = false;
      heart.renderOrder = 5;
      group.add(heart);

      eyeExpressionRigs.push({
        group,
        face,
        side,
        brow,
        heart,
        browBaseY: brow.position.y,
        expressionX: 1,
        expressionY: 1,
        expressionTilt: 0,
        expressionBrowTilt: 0,
        expressionBrowLift: 0,
      });
    });

    const mouthMembersByFace: Record<FaceState, THREE.Object3D[]> = { happy: [], worried: [] };
    Object.entries(nodes).forEach(([name, obj]) => {
      if (!name.includes('Mouth')) return;
      if (name.startsWith('Face_happy_')) mouthMembersByFace.happy.push(obj);
      if (name.startsWith('Face_worried_')) mouthMembersByFace.worried.push(obj);
    });
    (Object.entries(mouthMembersByFace) as [FaceState, THREE.Object3D[]][]).forEach(([face, members]) => {
      const parent = members[0]?.parent;
      if (!parent) return;
      const group = buildLocalPivotGroup(parent, members);
      if (!group) return;
      mouthExpressionRigs.push({
        group,
        face,
        baseY: group.position.y,
        expressionX: 1,
        expressionY: 1,
        expressionTilt: 0,
        expressionLift: 0,
      });
    });

    // --- measure + frame ---
    const bodyBox = new THREE.Box3().setFromObject(instanceRoot);
    // Build the workstation (agent's 3D room) BEFORE framing so its desk +
    // holo panels are included in the shot. Scene-space, like the pedestal.
    const framingBox = bodyBox.clone();
    if (wantsWorkstation) {
      workstation = buildWorkstation(bodyBox);
      scene.add(workstation.group);
      framingBox.expandByObject(workstation.group);
      // Apply any state that arrived before the workstation existed.
      workstation.setMaterialize(pendingMaterialize);
      workstation.setProgress(pendingProgress);
    }
    frameCamera(framingBox);
    const bodySize = bodyBox.getSize(new THREE.Vector3());
    const bodyWidth = bodySize.x;
    const bodyHeight = bodySize.y;
    const bodyDepth = bodySize.z;
    const bodyCenter = bodyBox.getCenter(new THREE.Vector3());

    if (wantsAccessory && options.accessory === 'dj-headphones') {
      buildDjHeadphones(nodes['Head'] ?? instanceRoot, bodyBox, ownedGeometries, ownedMaterials);
    }

    // Procedural locomotion. The centred hero must stay put (its circular blit
    // mask assumes a centred body) and seated workstation agents don't roam;
    // both still breathe and can play gestures.
    motion = createMotionController({
      bodyWidth,
      bodyHeight,
      bodyDepth,
      prefersReducedMotion,
      wanderAllowed: tier !== 'hero' && !wantsWorkstation,
      random,
    });
    if (pendingMovement !== undefined) motion.setMovement(pendingMovement);
    if (pendingGesture) { motion.playGesture(pendingGesture); pendingGesture = null; }
    if (pendingPointer) { motion.reactToPointer(pendingPointer); pendingPointer = null; }

    if (tier === 'hero' && skinMaterial instanceof THREE.MeshPhysicalMaterial) {
      skinMaterial.thickness = bodyHeight * GOO_THICKNESS_FRACTION;
      skinMaterial.attenuationDistance = bodyHeight * GOO_ATTENUATION_DISTANCE_FRACTION;
    }
    if (tier !== 'micro') {
      wobbleUniforms.uGooWobbleAmp.value =
        bodyHeight * WOBBLE_BASE_AMP_FRACTION * (prefersReducedMotion ? WOBBLE_REDUCED_MOTION_FACTOR : 1);
    }

    if (tier === 'hero') {
      // Backdrop glow — load-bearing for transmission.
      const backdropZ = bodyCenter.z - bodyHeight * GOO_BACKDROP_DISTANCE_FRACTION;
      const backdropSize = Math.max(bodyWidth, bodyHeight) * HERO_BACKDROP_SCALE * GOO_BACKDROP_FILL_FACTOR;
      const backdropTexture = createGooBackdropTexture();
      const backdropMaterial = new THREE.MeshBasicMaterial({
        map: backdropTexture,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      });
      ownedMaterials.push(backdropMaterial);
      const backdropGeometry = new THREE.PlaneGeometry(backdropSize, backdropSize);
      ownedGeometries.push(backdropGeometry);
      backdropMesh = new THREE.Mesh(backdropGeometry, backdropMaterial);
      backdropMesh.position.set(bodyCenter.x, bodyCenter.y, backdropZ);
      scene.add(backdropMesh);

      // Droplets — orbiting jelly beads sharing the goo material instance.
      const bodyCenterY = (bodyBox.min.y + bodyBox.max.y) / 2;
      for (let i = 0; i < DROPLET_COUNT; i += 1) {
        const radiusFraction =
          DROPLET_RADIUS_MIN_FRACTION + random() * (DROPLET_RADIUS_MAX_FRACTION - DROPLET_RADIUS_MIN_FRACTION);
        const geometry = new THREE.SphereGeometry(bodyHeight * radiusFraction, 14, 12);
        applyUniformVertexColor(geometry, DROPLET_BASE_VERTEX_COLOR);
        ownedGeometries.push(geometry);
        const mesh = new THREE.Mesh(geometry, skinMaterial!);
        const droplet: Droplet = {
          mesh,
          phase: (i / DROPLET_COUNT) * Math.PI * 2 + random() * 0.5,
          angularSpeed: 0.15 + random() * 0.12,
          orbitRadiusX: bodyHeight * DROPLET_ORBIT_RADIUS_FRACTION * (0.8 + random() * 0.4),
          orbitRadiusZ: bodyHeight * DROPLET_ORBIT_RADIUS_FRACTION * 0.35 * (0.8 + random() * 0.4),
          bobAmplitude: bodyHeight * DROPLET_BOB_AMPLITUDE_FRACTION * (0.7 + random() * 0.6),
          bobFreq: 0.6 + random() * 0.5,
          bobPhase: random() * Math.PI * 2,
          centerY: bodyCenterY,
          centerZ: 0.15,
        };
        droplet.mesh.position.set(
          Math.cos(droplet.phase) * droplet.orbitRadiusX,
          droplet.centerY + Math.sin(droplet.phase * droplet.bobFreq + droplet.bobPhase) * droplet.bobAmplitude,
          droplet.centerZ + Math.sin(droplet.phase) * droplet.orbitRadiusZ,
        );
        scene.add(mesh);
        droplets.push(droplet);
      }

      // Interior air pockets.
      const bellyCenterY = bodyBox.min.y + bodyHeight * BUBBLE_BELLY_CENTER_Y_FRACTION;
      microBubbleDummy = new THREE.Object3D();
      const bubbleGeometry = new THREE.IcosahedronGeometry(1, 2);
      ownedGeometries.push(bubbleGeometry);
      const bubbleMaterial = createBubbleCavityMaterial();
      ownedMaterials.push(bubbleMaterial);
      bubbleMesh = new THREE.InstancedMesh(bubbleGeometry, bubbleMaterial, BUBBLE_COUNT);
      bubbleMesh.renderOrder = 2;
      for (let i = 0; i < BUBBLE_COUNT; i += 1) {
        const radiusFraction =
          BUBBLE_RADIUS_MIN_FRACTION +
          Math.pow(random(), 1.45) * (BUBBLE_RADIUS_MAX_FRACTION - BUBBLE_RADIUS_MIN_FRACTION);
        const scale = bodyHeight * radiusFraction;
        const baseY = bellyCenterY + (random() * 2 - 1) * bodyHeight * BUBBLE_SPREAD_Y_FRACTION;
        const x = bodyCenter.x + (random() * 2 - 1) * bodyWidth * BUBBLE_SPREAD_X_FRACTION;
        const z = bodyCenter.z
          + bodyDepth * BUBBLE_FORWARD_Z_FRACTION
          + (random() * 2 - 1) * bodyDepth * BUBBLE_SPREAD_Z_FRACTION;
        microBubbleDummy.position.set(x, baseY, z);
        microBubbleDummy.scale.setScalar(scale);
        microBubbleDummy.updateMatrix();
        bubbleMesh.setMatrixAt(i, microBubbleDummy.matrix);
        bubbles.push({
          index: i,
          x,
          z,
          scale,
          baseY,
          bobAmplitude: bodyHeight * BUBBLE_BOB_AMPLITUDE_FRACTION * (0.6 + random() * 0.8),
          bobFreq: BUBBLE_BOB_FREQ_MIN + random() * (BUBBLE_BOB_FREQ_MAX - BUBBLE_BOB_FREQ_MIN),
          bobPhase: random() * Math.PI * 2,
        });
      }
      bubbleMesh.instanceMatrix.needsUpdate = true;
      root.add(bubbleMesh);
    }

    ready = true;
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('FlubberInstance load failed:', err);
  });

  const update = (dt: number, nowS: number) => {
    if (!ready) return;

    // A running gesture can commandeer the face/clip; otherwise the externally
    // requested expression wins. Re-apply only when the effective value flips.
    const gestureExpression = motion ? motion.gestureExpression : null;
    effectiveExpression = gestureExpression ?? expression;
    if (effectiveExpression !== renderedExpression) {
      renderedExpression = effectiveExpression;
      applyFaceVisibility();
      applyClip(false);
    }
    const activeFaceRecipe = resolveFaceRecipe(effectiveExpression);

    mixer?.update(prefersReducedMotion ? dt * 0.05 : dt);

    // blink
    const blinkClosedY = prefersReducedMotion ? BLINK_CLOSED_Y_REDUCED : BLINK_CLOSED_Y_FULL;
    switch (blink.phase) {
      case 'idle':
        blink.timer -= dt;
        if (blink.timer <= 0) {
          blink.phase = 'closing';
          blink.closeDuration = 0.07 + random() * 0.02;
          blink.timer = blink.closeDuration;
        }
        break;
      case 'closing': {
        blink.timer -= dt;
        const t = Math.min(1 - Math.max(blink.timer, 0) / blink.closeDuration, 1);
        blink.scaleY = 1 + (blinkClosedY - 1) * easeOutQuad(t);
        if (blink.timer <= 0) {
          blink.phase = 'holding';
          blink.timer = BLINK_HOLD_S;
          blink.scaleY = blinkClosedY;
        }
        break;
      }
      case 'holding':
        blink.timer -= dt;
        blink.scaleY = blinkClosedY;
        if (blink.timer <= 0) {
          blink.phase = 'opening';
          blink.openDuration = 0.11 + random() * 0.03;
          blink.timer = blink.openDuration;
        }
        break;
      case 'opening': {
        blink.timer -= dt;
        const t = Math.min(1 - Math.max(blink.timer, 0) / blink.openDuration, 1);
        blink.scaleY = blinkClosedY + (1 - blinkClosedY) * easeOutQuad(t);
        if (blink.timer <= 0) {
          blink.phase = 'idle';
          blink.scaleY = 1;
          if (!blink.queuedDouble && random() < BLINK_DOUBLE_CHANCE) {
            blink.queuedDouble = true;
            blink.timer = BLINK_DOUBLE_GAP_S;
          } else {
            blink.queuedDouble = false;
            blink.timer = BLINK_MIN_INTERVAL_S + random() * (BLINK_MAX_INTERVAL_S - BLINK_MIN_INTERVAL_S);
          }
        }
        break;
      }
    }

    // facial layer — recipes blend independently over the active clip; blink
    // stays multiplicative.
    const faceBlend = 1 - Math.exp(-13 * dt);
    for (const rig of eyeExpressionRigs) {
      const sideIndex = rig.side === 'L' ? 0 : 1;
      rig.expressionX += (activeFaceRecipe.eyeX[sideIndex] - rig.expressionX) * faceBlend;
      rig.expressionY += (activeFaceRecipe.eyeY[sideIndex] - rig.expressionY) * faceBlend;
      rig.expressionTilt += (activeFaceRecipe.eyeTilt[sideIndex] - rig.expressionTilt) * faceBlend;
      rig.expressionBrowTilt += (activeFaceRecipe.browTilt[sideIndex] - rig.expressionBrowTilt) * faceBlend;
      rig.expressionBrowLift += (activeFaceRecipe.browLift[sideIndex] - rig.expressionBrowLift) * faceBlend;

      rig.group.scale.x = rig.expressionX;
      rig.group.scale.y = rig.expressionY * blink.scaleY;
      rig.group.rotation.z = rig.expressionTilt;

      const faceActive = rig.face === activeFaceRecipe.face;
      rig.brow.visible = faceActive && activeFaceRecipe.brow;
      rig.brow.rotation.z = rig.expressionBrowTilt;
      rig.brow.position.y = rig.browBaseY + rig.expressionBrowLift;
      rig.heart.visible = faceActive && activeFaceRecipe.hearts;
      rig.heart.rotation.z = (rig.side === 'L' ? -1 : 1) * 0.08 + Math.sin(nowS * 4) * 0.025;
    }

    for (const rig of mouthExpressionRigs) {
      rig.expressionX += (activeFaceRecipe.mouthX - rig.expressionX) * faceBlend;
      rig.expressionY += (activeFaceRecipe.mouthY - rig.expressionY) * faceBlend;
      rig.expressionTilt += (activeFaceRecipe.mouthTilt - rig.expressionTilt) * faceBlend;
      rig.expressionLift += (activeFaceRecipe.mouthLift - rig.expressionLift) * faceBlend;
      rig.group.scale.x = rig.expressionX;
      rig.group.scale.y = rig.expressionY;
      rig.group.rotation.z = rig.expressionTilt;
      rig.group.position.y = rig.baseY + rig.expressionLift;
    }

    // squash spring — integrate the impulse channel (pulse()/gesture kicks)
    const accel = -SQUASH_SPRING_K * squash.value - SQUASH_SPRING_C * squash.velocity;
    squash.velocity += accel * dt;
    squash.value += squash.velocity * dt;

    // procedural motion (waddle locomotion + one-shot gestures)
    const m = motion ? motion.sample(dt, nowS) : null;
    if (m && m.pulseRequested) {
      // A gesture footfall kicks the same spring pulse() uses (softer).
      squash.velocity -= (prefersReducedMotion ? 0.8 : SQUASH_KICK * 0.7);
    }

    // workstation: holo shimmer + working lean (forward tilt + micro-tremor)
    let leanRotX = 0;
    if (workstation) {
      const isWorking =
        effectiveExpression === 'working' || effectiveExpression === 'focused' || effectiveExpression === 'determined';
      workstation.update(dt, nowS, isWorking);
      lean.target = isWorking && !prefersReducedMotion ? 0.14 : 0;
      lean.value += (lean.target - lean.value) * (1 - Math.exp(-6 * dt));
      const tremor = isWorking && !prefersReducedMotion ? Math.sin(nowS * 8.5) * 0.012 : 0;
      leanRotX = lean.value + tremor;
    }

    // compose the root transform: squash spring + gesture squash, layered with
    // the motion sample's breathing/gait scale, position, and rotation.
    const s = squash.value + (m ? m.squashAdd : 0);
    const scaleXZ = (1 - s * 0.35) * (m ? m.scaleXZ : 1);
    const scaleY = (1 + s * 0.5) * (m ? m.scaleY : 1);
    root.scale.set(scaleXZ, scaleY, scaleXZ);
    root.position.set(m ? m.posX : 0, m ? m.posY : 0, m ? m.posZ : 0);
    root.rotation.set(leanRotX + (m ? m.rotX : 0), m ? m.rotY : 0, m ? m.rotZ : 0);

    if (tier !== 'micro') {
      wobbleUniforms.uGooTime.value = nowS;
      wobbleUniforms.uGooImpact.value = Math.min(
        Math.abs(squash.velocity) * WOBBLE_IMPACT_VELOCITY_FACTOR,
        WOBBLE_IMPACT_MAX,
      );
    }

    if (tier === 'hero' && !prefersReducedMotion) {
      for (let i = 0; i < droplets.length; i += 1) {
        const d = droplets[i];
        d.phase += dt * d.angularSpeed;
        d.mesh.position.set(
          Math.cos(d.phase) * d.orbitRadiusX,
          d.centerY + Math.sin(d.phase * d.bobFreq + d.bobPhase) * d.bobAmplitude,
          d.centerZ + Math.sin(d.phase) * d.orbitRadiusZ,
        );
      }
      if (bubbleMesh && microBubbleDummy) {
        for (let i = 0; i < bubbles.length; i += 1) {
          const b = bubbles[i];
          microBubbleDummy.position.set(
            b.x,
            b.baseY + Math.sin(nowS * b.bobFreq * Math.PI * 2 + b.bobPhase) * b.bobAmplitude,
            b.z,
          );
          microBubbleDummy.scale.setScalar(b.scale);
          microBubbleDummy.updateMatrix();
          bubbleMesh.setMatrixAt(b.index, microBubbleDummy.matrix);
        }
        bubbleMesh.instanceMatrix.needsUpdate = true;
      }
    }
  };

  return {
    tier,
    scene,
    camera,
    get ready() {
      return ready;
    },
    get currentClip() {
      return currentClip;
    },
    setExpression(next: string) {
      expression = next;
    },
    pulse() {
      squash.velocity -= prefersReducedMotion ? 1.1 : SQUASH_KICK;
    },
    setWorkstation(state: WorkstationState) {
      if (state.materialize !== undefined) pendingMaterialize = state.materialize;
      if (state.progress !== undefined) pendingProgress = state.progress;
      if (!workstation) return;
      if (state.materialize !== undefined) workstation.setMaterialize(state.materialize);
      if (state.progress !== undefined) workstation.setProgress(state.progress);
    },
    setMovement(cfg: MovementConfig | null) {
      if (motion) motion.setMovement(cfg);
      else pendingMovement = cfg;
    },
    playGesture(name: GestureName) {
      if (motion) motion.playGesture(name);
      else pendingGesture = name;
    },
    reactToPointer(kind: 'hover' | 'click') {
      if (motion) motion.reactToPointer(kind);
      else pendingPointer = kind;
    },
    update,
    dispose() {
      disposed = true;
      mixer?.stopAllAction();
      droplets.forEach((d) => d.mesh.geometry.dispose());
      ownedGeometries.forEach((geometry) => geometry.dispose());
      ownedMaterials.forEach((material) => material.dispose());
      workstation?.dispose();
      scene.clear();
    },
  };
}
