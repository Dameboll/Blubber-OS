'use client';

/**
 * FlubberMesh — loads the real 3D Blubber (public/models/flubber.glb, built in
 * blender/build_flubber_v2.py) and renders it with Three.js. Third
 * FlubberCharacter mode alongside "character" (PNG sprite) and "orb" (Core3D
 * shader).
 *
 * v2 pipeline (replaces the metaball + live-PBR-lighting build):
 *   - Geometry: a sculpted, armatured, single skinned body mesh (7 bones:
 *     Root/Spine/Head/Arm.L.Upper/Arm.L.Lower/Arm.R.Upper/Arm.R.Lower) with
 *     four named, loopable animation clips (Idle/Wave/Celebrate/Worried)
 *     baked in Blender and driven here by THREE.AnimationMixer.
 *   - Look: three rounds of live Three.js PBR tuning never matched the
 *     Blender Cycles renders of the identical geometry, so the look is no
 *     longer re-derived from lights at all. The Cycles jelly shader is baked
 *     into a matcap texture (public/models/flubber-matcap.png, plus a
 *     separate glossy-black bake for the eyes) and rendered unlit with
 *     THREE.MeshMatcapMaterial — no lights, no environment, no tone mapping,
 *     view-independent, identical to the Blender reference by construction.
 *
 * Node names baked into the GLB:
 *   Blubber_Body            — the single skinned body mesh (material FlubberSkinV2)
 *   Face_happy_*  / Face_worried_*  — eye / eye-highlight / mouth sets, rigid-
 *     parented to the Head bone so they ride head motion; visibility-swapped
 *     the same way the old node-swap system worked (no shape-key morphing).
 *   Animations: "Idle" | "Wave" | "Celebrate" | "Worried" — all loopable.
 *   The event-driven squash pulse (pulseKey prop, same contract as Core3D's
 *   pulseSignal) is separate from the mixer: a spring-damper applied live to
 *   the whole root group's scale.
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import {
  REDUCED_MOTION_QUERY,
  cloneBlubber,
  loadMatcaps,
  loadModel,
} from '../lib/flubber3d/assets';
import {
  ALL_CLIP_NAMES,
  BLINK_CLOSED_Y_FULL,
  BLINK_CLOSED_Y_REDUCED,
  BLINK_DOUBLE_CHANCE,
  BLINK_DOUBLE_GAP_S,
  BLINK_HOLD_S,
  BLINK_MAX_INTERVAL_S,
  BLINK_MIN_INTERVAL_S,
  CROSSFADE_SECONDS,
  GAZE_AUTO_LOOK_AMPLITUDE,
  GAZE_AUTO_LOOK_MAX_S,
  GAZE_AUTO_LOOK_MIN_S,
  GAZE_IDLE_TIMEOUT_S,
  GAZE_LERP_RATE,
  GAZE_MAX_PITCH_RAD,
  GAZE_MAX_YAW_RAD,
  GAZE_NON_IDLE_CLIP_DAMP,
  SQUASH_KICK,
  SQUASH_SPRING_C,
  SQUASH_SPRING_K,
  buildEyePivotGroup,
  buildLocalPivotGroup,
  createHeartGeometry,
  createSeededRandom,
  easeOutQuad,
  resolveClipName,
  resolveFaceRecipe,
  wantsWorriedFace,
  type ClipName,
  type EyeExpressionRig,
  type FaceState,
  type MouthExpressionRig,
} from '../lib/flubber3d/face';
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
  GOO_DPR_CAP,
  GOO_MODE,
  GOO_THICKNESS_FRACTION,
  GOO_TONE_MAPPING_EXPOSURE,
  HERO_BACKDROP_SCALE,
  HERO_FRAME_CENTER_Y_FRACTION,
  HERO_FRAME_HEIGHT_FRACTION,
  HERO_FRAME_WIDTH_FRACTION,
  HOP_AIR_S,
  HOP_ANTICIPATION_S,
  HOP_ANTICIPATION_SCALE_XZ,
  HOP_ANTICIPATION_SCALE_Y,
  HOP_HEIGHT_FRACTION,
  HOP_MAX_INTERVAL_S,
  HOP_MIN_INTERVAL_S,
  HOP_SPLAT_SQUASH_VALUE,
  HOP_STRETCH_XZ,
  HOP_STRETCH_Y,
  MICRO_BUBBLE_COUNT,
  SHADOW_AIRBORNE_FADE,
  SHADOW_AIRBORNE_SHRINK,
  SHADOW_BASE_OPACITY,
  SHADOW_REACT_DAMP,
  SHADOW_SPLAT_DARKEN,
  WOBBLE_BASE_AMP_FRACTION,
  WOBBLE_IMPACT_MAX,
  WOBBLE_IMPACT_VELOCITY_FACTOR,
  WOBBLE_REDUCED_MOTION_FACTOR,
  applyUniformVertexColor,
  createBubbleCavityMaterial,
  createGooBackdropTexture,
  createGooMaterial,
  createPedestalBaseMaterial,
  createPedestalRingMaterial,
  createShadowTexture,
  createStudioEnvironment,
  createWobbleUniforms,
  upgradeMaterials,
  type WobbleUniforms,
} from '../lib/flubber3d/materials';

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

type HopPhase = 'none' | 'anticipation' | 'air';

interface Droplet {
  mesh: THREE.Mesh;
  phase: number;
  angularSpeed: number;
  orbitRadiusX: number;
  orbitRadiusZ: number;
  bobAmplitude: number;
  bobFreq: number;
  bobPhase: number;
  centerX: number;
  centerY: number;
  centerZ: number;
}

export interface FlubberMeshProps {
  /** Drives which clip plays + which face node set is visible. Unknown values fall back to idle+happy. */
  expression?: string;
  /** Increment to fire a one-shot squash-then-rebound pulse — same contract as Core3D's pulseSignal. */
  pulseKey?: number;
  /** Verification-only neutral pose. Product callers leave this false. */
  debugStatic?: boolean;
  className?: string;
}

export default function FlubberMesh({
  expression = 'waving',
  pulseKey,
  debugStatic = false,
  className,
}: FlubberMeshProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const expressionRef = useRef(expression);
  const prevPulseKeyRef = useRef(pulseKey);
  const firePulseRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    expressionRef.current = expression;
  }, [expression]);

  useEffect(() => {
    if (pulseKey !== undefined && pulseKey !== prevPulseKeyRef.current) {
      firePulseRef.current?.();
    }
    prevPulseKeyRef.current = pulseKey;
  }, [pulseKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    const prefersReducedMotion = window.matchMedia(REDUCED_MOTION_QUERY).matches;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    renderer.setClearColor(0x000000, 0);
    // CGI-1 PERFORMANCE GUARD: transmission adds a render pass (three renders
    // the scene behind the transmissive object into a texture every frame),
    // so the DPR cap is a named constant here instead of the old inline `2` --
    // dropping GOO_DPR_CAP is the first knob to turn if Stage 5's FPS
    // measurement comes in low.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, debugStatic ? 1 : GOO_DPR_CAP));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    if (GOO_MODE) {
      // ACES only affects materials with toneMapped !== false -- every face
      // part (eyes/mouth) opts out in upgradeMaterials() above, so this only
      // touches the new goo material's response to the IBL below.
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = GOO_TONE_MAPPING_EXPOSURE;
    }
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
    camera.position.set(0, 1, 4);
    camera.lookAt(0, 1, 0);

    let modelBodyBox: THREE.Box3 | null = null;
    const frameCameraFromBodyBox = (box: THREE.Box3) => {
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

    const root = new THREE.Group();
    scene.add(root);

    // V3.1 studio lights: small real emitters create localized wet highlights
    // instead of the long flat bands produced by an environment map alone.
    // The rear green light also gives the refractive rim a dimensional kick.
    if (GOO_MODE) {
      const softFill = new THREE.HemisphereLight(0x8dff91, 0x031909, 0.65);
      const heroKey = new THREE.PointLight(0xe8ffdf, 5, 9, 2);
      heroKey.position.set(-2.4, 3.4, 3.3);
      const faceFill = new THREE.PointLight(0x7dff82, 1, 7, 2);
      faceFill.position.set(2.2, 1.6, 3.2);
      const gelRim = new THREE.PointLight(0x3cff59, 10, 8, 2);
      gelRim.position.set(2.6, 2.5, -2.4);
      scene.add(softFill, heroKey, faceFill, gelRim);
    }

    // V3.2 authored PMREM cards replace RoomEnvironment's generic bands.
    let envMapTexture: THREE.Texture | null = null;
    if (GOO_MODE) {
      envMapTexture = createStudioEnvironment(renderer);
      scene.environment = envMapTexture;
    }

    const nodes: Record<string, THREE.Object3D> = {};
    let mixer: THREE.AnimationMixer | null = null;
    const actions: Partial<Record<ClipName, THREE.AnimationAction>> = {};
    let currentClip: ClipName | null = null;

    // AL-1 ALIVE state -- populated once the model loads (tick() guards on
    // null/empty since the render loop starts running before the async load
    // resolves). gazeEuler/gazeQuat are allocated once here and mutated every
    // frame -- no per-frame allocations in the new code paths.
    const eyeBlinkGroups: THREE.Group[] = [];
    const eyeExpressionRigs: EyeExpressionRig[] = [];
    const mouthExpressionRigs: MouthExpressionRig[] = [];
    const expressionGeometries: THREE.BufferGeometry[] = [];
    let browMaterial: THREE.MeshPhysicalMaterial | null = null;
    let heartMaterial: THREE.MeshPhysicalMaterial | null = null;
    let headBone: THREE.Object3D | null = null;
    let shadowMesh: THREE.Mesh | null = null;
    let shadowMaterial: THREE.MeshBasicMaterial | null = null;
    let shadowTexture: THREE.CanvasTexture | null = null;
    // CGI-1: dropletMaterial is a THREE.Material union now -- under GOO_MODE it's
    // literally the SAME instance as gooMaterial (see the droplet-material
    // assignment below), not a clone, per the plan's "share the goo material
    // instance" rule. Only falls back to a distinct MeshMatcapMaterial when
    // GOO_MODE is off.
    let dropletMaterial: THREE.Material | null = null;
    let gooMaterial: THREE.MeshPhysicalMaterial | null = null;
    let backdropMesh: THREE.Mesh | null = null;
    let backdropMaterial: THREE.MeshBasicMaterial | null = null;
    let backdropTexture: THREE.CanvasTexture | null = null;
    let pedestalGroup: THREE.Group | null = null;
    let pedestalRingGeometry: THREE.RingGeometry | null = null;
    let pedestalRingMaterial: THREE.ShaderMaterial | null = null;
    let pedestalDiscGeometry: THREE.CircleGeometry | null = null;
    let pedestalDiscMaterial: THREE.MeshBasicMaterial | null = null;
    let pedestalConeGeometry: THREE.CylinderGeometry | null = null;
    let pedestalConeMaterial: THREE.MeshPhysicalMaterial | null = null;
    // CGI-2 -- shared with every compiled variant of the goo material (see
    // WobbleUniforms doc). uGooWobbleAmp starts 0 (no wobble until the body
    // is measured); the real amplitude is set from bodyBox after load.
    const wobbleUniforms: WobbleUniforms = createWobbleUniforms();
    const droplets: Droplet[] = [];
    // CGI-3 -- interior air bubbles (goo-mode only; see the Bubble constants'
    // comment for why these have their own opaque material).
    const bubbles: Bubble[] = [];
    let bubbleMesh: THREE.InstancedMesh | null = null;
    let bubbleGeometry: THREE.IcosahedronGeometry | null = null;
    let bubbleMaterial: THREE.ShaderMaterial | null = null;
    let microBubbleMesh: THREE.InstancedMesh | null = null;
    let microBubbleGeometry: THREE.IcosahedronGeometry | null = null;
    let microBubbleMaterial: THREE.ShaderMaterial | null = null;
    const gazeEuler = new THREE.Euler();
    const gazeQuat = new THREE.Quaternion();
    // The Head bone's clean, gaze-free pose. CRITICAL (caught live via
    // alive1_gaze_left.png showing a ~35deg runaway swing): the Idle clip
    // keyframes only Root/Spine/Arm.*.Upper (see build_action_idle() in
    // build_flubber_v2.py) -- it never writes Head. AnimationMixer only
    // resets properties it has tracks for, so during Idle a naive
    // quaternion.multiply(gazeQuat) each frame COMPOUNDS into a spin.
    // Pattern: restore the clean pose BEFORE mixer.update() (undoing last
    // frame's gaze), snapshot whatever the mixer leaves (fresh clip pose if
    // the active clip writes Head, the restored clean pose if not), then
    // apply this frame's gaze on top. Correct in both cases, no allocations.
    const headCleanQuat = new THREE.Quaternion();

    const applyFaceVisibility = () => {
      const worried = wantsWorriedFace(expressionRef.current);
      Object.entries(nodes).forEach(([name, obj]) => {
        if (!name.startsWith('Face_')) return;
        obj.visible = worried ? name.startsWith('Face_worried') : name.startsWith('Face_happy');
      });
    };

    const applyClip = (immediate: boolean) => {
      const nextName = resolveClipName(expressionRef.current);
      if (nextName === currentClip) return;
      const nextAction = actions[nextName];
      if (!nextAction) return;
      const prevAction = currentClip ? actions[currentClip] : null;
      currentClip = nextName;
      container.dataset.flubberClip = nextName;

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

    Promise.all([loadModel(), loadMatcaps()]).then(([{ scene: gltfScene, animations }, matcaps]) => {
      if (disposed) return;
      // A recursive Object3D clone duplicates bones but leaves each
      // SkinnedMesh's Skeleton bound to the source scene. Rebind the cloned
      // mesh to its cloned bones so mixer-driven body motion stays visible.
      const instance = cloneBlubber(gltfScene);
      // CGI-1: gooMaterial is built once here and threaded through -- it's the
      // SAME instance used for the body, the droplets (below), and (Stage 3)
      // the interior bubbles, so wobble/impact uniforms added in later stages
      // only ever need to be set in one place.
      gooMaterial = GOO_MODE ? createGooMaterial(wobbleUniforms) : null;
      const skinMaterial: THREE.Material = gooMaterial ?? new THREE.MeshMatcapMaterial({ matcap: matcaps.skin });
      upgradeMaterials(instance, skinMaterial);
      root.add(instance);
      instance.traverse((obj) => {
        nodes[obj.name] = obj;
      });

      mixer = new THREE.AnimationMixer(instance);
      animations.forEach((clip) => {
        if (clip.name in ALL_CLIP_NAMES) {
          actions[clip.name as ClipName] = mixer!.clipAction(clip);
          actions[clip.name as ClipName]!.setLoop(THREE.LoopRepeat, Infinity);
        }
      });

      applyFaceVisibility();
      applyClip(true);

      headBone = nodes['Head'] ?? null;
      if (headBone) headCleanQuat.copy(headBone.quaternion);

      // Group each eye's parts (ball + rim + 2 highlights) into one pivot
      // Group per Face-state per side (happy/worried x L/R -- both face
      // states exist in the scene simultaneously, only .visible toggles, so
      // both get a blink group and the invisible one's motion just never
      // renders). See buildEyePivotGroup() for why a shared pivot beats
      // scaling each part around its own origin.
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
      browMaterial = new THREE.MeshPhysicalMaterial({
        color: 0x071107,
        roughness: 0.22,
        clearcoat: 0.45,
        clearcoatRoughness: 0.1,
      });
      heartMaterial = new THREE.MeshPhysicalMaterial({
        color: 0xffe58a,
        emissive: 0x8f5b18,
        emissiveIntensity: 0.22,
        roughness: 0.18,
        clearcoat: 0.8,
        clearcoatRoughness: 0.06,
        side: THREE.DoubleSide,
      });

      Object.entries(eyeMembersByGroup).forEach(([key, members]) => {
        const parent = members[0].parent;
        if (!parent) return;
        const group = buildEyePivotGroup(parent, members);
        if (!group) return;
        eyeBlinkGroups.push(group);

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
        expressionGeometries.push(browGeometry);
        const brow = new THREE.Mesh(browGeometry, browMaterial!);
        brow.name = `ExpressionBrow_${face}_${side}`;
        brow.position.copy(group.position);
        brow.position.y += eyeSize.y * 0.61;
        brow.position.z += eyeSize.z * 0.62;
        brow.visible = false;
        brow.renderOrder = 4;
        parent.add(brow);

        const heartGeometry = createHeartGeometry(eyeSize.x, eyeSize.y);
        expressionGeometries.push(heartGeometry);
        const heart = new THREE.Mesh(heartGeometry, heartMaterial!);
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

      // GROUNDING SHADOW -- soft radial-alpha ellipse at the body's own
      // measured foot height (a Box3 read off the loaded mesh, not a guessed
      // constant), reacting to the squash spring instead of a light (the
      // matcap pipeline has no lights and stays that way).
      // Round 2 (2026-07-12, caught reading alive1_squash.png): the first
      // pass laid the plane flat on the ground (rotation.x = -PI/2), but the
      // camera here looks almost perfectly horizontally (y 1.02 -> target
      // 0.95, ~1 degree of pitch), so a ground plane renders EDGE-ON and
      // compresses to an invisible sliver. The camera never moves, so the
      // fix is a camera-facing ellipse (default PlaneGeometry orientation,
      // squashed vertically) at foot level, z at the body's midline:
      // depth-testing lets the body occlude its upper half, and the soft
      // dark rim that shows below/around the feet silhouette is exactly the
      // contact-shadow read. depthWrite stays false so it never punches a
      // hole in anything drawn after it.
      const bodyBox = new THREE.Box3().setFromObject(instance);
      modelBodyBox = bodyBox.clone();
      frameCameraFromBodyBox(bodyBox);
      const bodySize = bodyBox.getSize(new THREE.Vector3());
      const bodyWidth = bodySize.x;
      const bodyHeight = bodySize.y;
      const bodyDepth = bodySize.z;

      // CGI-1: thickness/attenuationDistance are authored as fractions of the
      // body's own measured height (see createGooMaterial's doc comment) --
      // now that bodyBox exists, rescale off the neutral placeholder values.
      if (gooMaterial) {
        const gooBodyHeight = bodyHeight;
        gooMaterial.thickness = gooBodyHeight * GOO_THICKNESS_FRACTION;
        gooMaterial.attenuationDistance = gooBodyHeight * GOO_ATTENUATION_DISTANCE_FRACTION;

        // CGI-2: wobble amplitude keys off the measured body height too.
        // Setting it here (not at uniform creation) doubles as the "don't
        // wobble until the mesh actually exists" gate.
        wobbleUniforms.uGooWobbleAmp.value =
          gooBodyHeight * WOBBLE_BASE_AMP_FRACTION * (prefersReducedMotion ? WOBBLE_REDUCED_MOTION_FACTOR : 1);

        // CGI-1 GOO BACKDROP -- see the GOO_BACKDROP_* constants' comment for
        // why this exists: transmission needs real light behind the body to
        // bend/tint, and this scene had none. A soft green radial glow,
        // placed further from the camera than the body (more negative z) so
        // it reads as bending THROUGH the translucent goo rather than
        // floating in front of it.
        const bodyCenter = bodyBox.getCenter(new THREE.Vector3());
        const backdropZ = bodyCenter.z - gooBodyHeight * GOO_BACKDROP_DISTANCE_FRACTION;
        // Phase 2 containment: the glow belongs to this hero, not the canvas.
        // Size it from the measured model instead of filling the camera
        // frustum, so its fade-to-zero edge remains visibly inside the stage.
        const backdropSize = Math.max(bodyWidth, bodyHeight) * HERO_BACKDROP_SCALE * GOO_BACKDROP_FILL_FACTOR;
        backdropTexture = createGooBackdropTexture();
        backdropMaterial = new THREE.MeshBasicMaterial({
          map: backdropTexture,
          transparent: true,
          depthWrite: false,
          toneMapped: false,
        });
        backdropMesh = new THREE.Mesh(new THREE.PlaneGeometry(backdropSize, backdropSize), backdropMaterial);
        backdropMesh.position.set(bodyCenter.x, bodyCenter.y, backdropZ);
        scene.add(backdropMesh);
      }

      // Canonical hero platform: a solid near-black metal puck with three
      // restrained inset lime rings and concentrated underlight. It lives in
      // scene space so the hop and squash never distort the hardware.
      const bodyCenter = bodyBox.getCenter(new THREE.Vector3());
      pedestalGroup = new THREE.Group();
      pedestalRingGeometry = new THREE.RingGeometry(bodyWidth * 0.52, bodyWidth * 0.66, 96);
      pedestalRingMaterial = createPedestalRingMaterial();
      const pedestalRingPosition = new THREE.Vector3(
        bodyCenter.x,
        bodyBox.min.y - bodyHeight * 0.07,
        bodyCenter.z - bodyDepth * 0.14,
      );
      [1, 0.72, 0.46].forEach((ringScale) => {
        const ring = new THREE.Mesh(pedestalRingGeometry!, pedestalRingMaterial!);
        ring.scale.set(ringScale, ringScale * 0.15, 1);
        ring.position.copy(pedestalRingPosition);
        ring.position.z += (1 - ringScale) * 0.003;
        pedestalGroup!.add(ring);
      });

      pedestalDiscGeometry = new THREE.CircleGeometry(bodyWidth * 0.64, 96);
      pedestalDiscMaterial = new THREE.MeshBasicMaterial({
        color: 0x20ff45,
        transparent: true,
        opacity: 0.065,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const pedestalDisc = new THREE.Mesh(pedestalDiscGeometry, pedestalDiscMaterial);
      pedestalDisc.scale.y = 0.15;
      pedestalDisc.position.copy(pedestalRingPosition);
      pedestalDisc.position.z -= 0.002;
      pedestalGroup.add(pedestalDisc);

      pedestalConeGeometry = new THREE.CylinderGeometry(
        bodyWidth * 0.63,
        bodyWidth * 0.67,
        bodyHeight * 0.07,
        96,
        1,
        false,
      );
      pedestalConeMaterial = createPedestalBaseMaterial();
      const pedestalCone = new THREE.Mesh(pedestalConeGeometry, pedestalConeMaterial);
      pedestalCone.position.set(
        bodyCenter.x,
        bodyBox.min.y - bodyHeight * 0.06,
        bodyCenter.z - bodyDepth * 0.15,
      );
      pedestalGroup.add(pedestalCone);
      scene.add(pedestalGroup);

      const shadowFootY = bodyBox.min.y;
      const footprint = Math.max(bodyBox.max.x - bodyBox.min.x, bodyBox.max.z - bodyBox.min.z);
      const shadowGeometry = new THREE.PlaneGeometry(footprint * 1.35, footprint * 0.42);
      shadowTexture = createShadowTexture();
      shadowMaterial = new THREE.MeshBasicMaterial({
        map: shadowTexture,
        transparent: true,
        depthWrite: false,
        opacity: SHADOW_BASE_OPACITY, // CGI-5 -- headroom for splat darkening, see constant
      });
      shadowMesh = new THREE.Mesh(shadowGeometry, shadowMaterial);
      // PlaneGeometry is authored in XY.  Rotate it onto the ground XZ plane
      // and keep it just below the feet.  The previous upright +z placement
      // was literally in front of the translucent belly and rendered as the
      // large dark gray oval caught by the visual gate.
      shadowMesh.rotation.x = -Math.PI / 2;
      shadowMesh.position.set(bodyCenter.x, shadowFootY - bodyHeight * 0.012, bodyCenter.z);
      scene.add(shadowMesh);

      // GOO DROPLETS -- small orbiting/bobbing spheres sharing the skin
      // material (CGI-1: the actual gooMaterial instance under GOO_MODE, the
      // matcap as a fallback) so they read as the same jelly, not a separate
      // FX layer. Added to `scene` (not `root`) so they don't inherit the
      // body's own squash distortion.
      const bodyCenterY = (bodyBox.min.y + bodyBox.max.y) / 2;
      // CGI-4: arms the hop system (0 until now = "body not loaded yet").
      hopHeightWorld = bodyHeight * HOP_HEIGHT_FRACTION;
      dropletMaterial = gooMaterial ?? new THREE.MeshMatcapMaterial({ matcap: matcaps.skin });
      const dropletRandom = createSeededRandom(0xd10f1e7);
      for (let i = 0; i < DROPLET_COUNT; i += 1) {
        const radiusFraction =
          DROPLET_RADIUS_MIN_FRACTION
          + dropletRandom() * (DROPLET_RADIUS_MAX_FRACTION - DROPLET_RADIUS_MIN_FRACTION);
        const geometry = new THREE.SphereGeometry(bodyHeight * radiusFraction, 14, 12);
        // RS5: gooMaterial now reads vertex colors -- see DROPLET_BASE_VERTEX_COLOR.
        if (GOO_MODE) applyUniformVertexColor(geometry, DROPLET_BASE_VERTEX_COLOR);
        const mesh = new THREE.Mesh(geometry, dropletMaterial);
        const droplet: Droplet = {
          mesh,
          phase: (i / DROPLET_COUNT) * Math.PI * 2 + dropletRandom() * 0.5,
          angularSpeed: 0.15 + dropletRandom() * 0.12,
          orbitRadiusX: bodyHeight * DROPLET_ORBIT_RADIUS_FRACTION * (0.8 + dropletRandom() * 0.4),
          orbitRadiusZ: bodyHeight * DROPLET_ORBIT_RADIUS_FRACTION * 0.35 * (0.8 + dropletRandom() * 0.4),
          bobAmplitude: bodyHeight * DROPLET_BOB_AMPLITUDE_FRACTION * (0.7 + dropletRandom() * 0.6),
          bobFreq: 0.6 + dropletRandom() * 0.5,
          bobPhase: dropletRandom() * Math.PI * 2,
          centerX: 0,
          centerY: bodyCenterY,
          centerZ: 0.15,
        };
        // Placed immediately so reduced-motion (which skips the per-frame
        // orbit update entirely) still renders them at a valid, static pose.
        droplet.mesh.position.set(
          droplet.centerX + Math.cos(droplet.phase) * droplet.orbitRadiusX,
          droplet.centerY + Math.sin(droplet.phase * droplet.bobFreq + droplet.bobPhase) * droplet.bobAmplitude,
          droplet.centerZ + Math.sin(droplet.phase) * droplet.orbitRadiusZ,
        );
        scene.add(mesh);
        droplets.push(droplet);
      }

      // CGI-3 AIR BUBBLES -- see the Bubble constants' comment block for the
      // full rationale (opaque + emissive because the transmission pass can't
      // see transmissive objects; torso-ellipsoid placement; squash-root
      // parenting). Added to `root` (NOT `scene` like the droplets) so they
      // inherit the squash spring's scale and stay inside the body when he
      // squashes.
      if (GOO_MODE) {
        const bubbleRandom = createSeededRandom(0xf1abb32);
        const bodyCenterX = (bodyBox.min.x + bodyBox.max.x) / 2;
        const bodyCenterZ = (bodyBox.min.z + bodyBox.max.z) / 2;
        const bellyCenterY = bodyBox.min.y + bodyHeight * BUBBLE_BELLY_CENTER_Y_FRACTION;
        const bubbleDummy = new THREE.Object3D();
        bubbleGeometry = new THREE.IcosahedronGeometry(1, 2);
        bubbleMaterial = createBubbleCavityMaterial();
        bubbleMesh = new THREE.InstancedMesh(bubbleGeometry, bubbleMaterial, BUBBLE_COUNT);
        bubbleMesh.name = 'FlubberHeroCavities';
        bubbleMesh.renderOrder = 2;
        const heroPocketLayout: ReadonlyArray<readonly [number, number, number]> = [
          [-0.62, 0.19, 1.00], [-0.90, 0.03, 0.80], [0.88, -0.03, 1.10],
          [0.71, -0.06, 0.70], [-0.65, -0.23, 0.65], [-0.75, -0.35, 1.00],
          [0.70, -0.37, 0.80], [-0.26, -0.44, 0.80], [-0.75, -0.55, 1.10],
          [0.47, -0.70, 1.00], [-0.41, -0.77, 0.90], [-0.23, -0.82, 0.90],
          [0.54, 0.41, 0.90], [0.80, 0.20, 0.70], [-0.85, 0.35, 0.70],
          [-0.50, 0.45, 0.60], [0.00, 0.25, 0.60], [0.30, 0.15, 0.70],
          [-0.45, -0.10, 0.60], [0.25, -0.25, 0.50], [0.00, -0.55, 0.50],
          [0.85, -0.55, 0.70], [0.15, -0.75, 0.50], [0.65, -0.80, 0.70],
        ];
        for (let i = 0; i < BUBBLE_COUNT; i += 1) {
          // Lower-belly-biased optical pockets: large enough to survive the
          // actual hero framing, with a dark core and razor-thin lime edge.
          const radiusFraction =
            BUBBLE_RADIUS_MIN_FRACTION +
            Math.pow(bubbleRandom(), 1.45) * (BUBBLE_RADIUS_MAX_FRACTION - BUBBLE_RADIUS_MIN_FRACTION);
          const [layoutX, layoutY, layoutScale] = heroPocketLayout[i];
          const scale = bodyHeight * radiusFraction * layoutScale;
          const baseY = bellyCenterY + layoutY * bodyHeight * BUBBLE_SPREAD_Y_FRACTION;
          const x = bodyCenterX + layoutX * bodyWidth * BUBBLE_SPREAD_X_FRACTION;
          const z = bodyCenterZ
            + bodyDepth * BUBBLE_FORWARD_Z_FRACTION
            + (bubbleRandom() * 2 - 1) * bodyDepth * BUBBLE_SPREAD_Z_FRACTION;
          bubbleDummy.position.set(x, baseY, z);
          bubbleDummy.scale.setScalar(scale);
          bubbleDummy.updateMatrix();
          bubbleMesh.setMatrixAt(i, bubbleDummy.matrix);
          bubbles.push({
            index: i,
            x,
            z,
            scale,
            baseY,
            bobAmplitude: bodyHeight * BUBBLE_BOB_AMPLITUDE_FRACTION * (0.6 + bubbleRandom() * 0.8),
            bobFreq: BUBBLE_BOB_FREQ_MIN + bubbleRandom() * (BUBBLE_BOB_FREQ_MAX - BUBBLE_BOB_FREQ_MIN),
            bobPhase: bubbleRandom() * Math.PI * 2,
          });
        }
        bubbleMesh.instanceMatrix.needsUpdate = true;
        root.add(bubbleMesh);

        // A second one-draw-call layer supplies fine suspended structure. The
        // placement is authored into safe interior zones: lower belly plus a
        // forehead band above the eyes, so it cannot paste glitter over face
        // controls or escape the silhouette.
        microBubbleGeometry = new THREE.IcosahedronGeometry(1, 0);
        microBubbleMaterial = createBubbleCavityMaterial(true);
        microBubbleMesh = new THREE.InstancedMesh(
          microBubbleGeometry,
          microBubbleMaterial,
          MICRO_BUBBLE_COUNT,
        );
        microBubbleMesh.name = 'FlubberMicroCavities';
        microBubbleMesh.renderOrder = 2;
        const microCenterY = bodyBox.min.y + bodyHeight * 0.36;
        for (let i = 0; i < MICRO_BUBBLE_COUNT; i += 1) {
          const u = bubbleRandom() * 2 - 1;
          const theta = bubbleRandom() * Math.PI * 2;
          const rr = Math.cbrt(bubbleRandom()) * 0.92;
          const radial = Math.sqrt(1 - u * u);
          const microScale = bodyHeight * (0.0022 + bubbleRandom() * 0.0028);
          if (i < 32) {
            bubbleDummy.position.set(
              bodyCenterX + (bubbleRandom() * 2 - 1) * bodyHeight * 0.13,
              bodyBox.min.y + bodyHeight * (0.78 + bubbleRandom() * 0.08),
              bodyCenterZ + bodyDepth * (0.01 + (bubbleRandom() * 2 - 1) * 0.05),
            );
          } else {
            bubbleDummy.position.set(
              bodyCenterX + rr * radial * Math.cos(theta) * bodyWidth * 0.34,
              microCenterY + rr * u * bodyHeight * 0.25,
              bodyCenterZ + bodyDepth * 0.01 + rr * radial * Math.sin(theta) * bodyDepth * 0.075,
            );
          }
          bubbleDummy.scale.setScalar(microScale);
          bubbleDummy.updateMatrix();
          microBubbleMesh.setMatrixAt(i, bubbleDummy.matrix);
        }
        microBubbleMesh.instanceMatrix.needsUpdate = true;
        root.add(microBubbleMesh);
      }

      // Deterministic "model is actually on screen" signal for Playwright
      // gate captures. AL-1 finding: this dev server can take 10s+ to serve
      // the GLB when loaded down (observed /api/live responses in the
      // 100-800s range), so fixed-delay screenshots race the model load and
      // capture an empty glow. Tests wait for [data-flubber-loaded="1"]
      // instead of guessing a delay.
      container.dataset.flubberLoaded = '1';
      container.dataset.flubberHopPhase = 'none';
      container.dataset.flubberHopY = '0';
    }).catch((err) => {
      // RS5 diagnostic: previously any failure in the load/setup chain left
      // the component in silent permanent limbo (no data-flubber-loaded, no
      // console output) -- surfacing it explicitly so a real break is
      // distinguishable from "still loading."
      // eslint-disable-next-line no-console
      console.error('FlubberMesh load/setup failed:', err);
    });

    const squash = { value: 0, velocity: 0 };

    // CGI-4 hop state -- see the HOP_* constants' comment block. hopHeightWorld
    // stays 0 until the GLB is measured (no hopping before a body exists).
    const hop: { phase: HopPhase; t: number } = { phase: 'none', t: 0 };
    let hopHeightWorld = 0;
    let nextHopAt =
      performance.now() + (HOP_MIN_INTERVAL_S + Math.random() * (HOP_MAX_INTERVAL_S - HOP_MIN_INTERVAL_S)) * 1000;

    firePulseRef.current = () => {
      // CGI-4: a click now triggers the full hop cycle (click -> hop ->
      // splat) when he's idle and grounded. Reduced motion, non-Idle clips
      // (don't fight Wave/Celebrate), an in-flight hop, or a not-yet-loaded
      // body all fall back to the original gentle squash pulse.
      if (!prefersReducedMotion && hopHeightWorld > 0 && currentClip === 'Idle' && hop.phase === 'none') {
        hop.phase = 'anticipation';
        hop.t = 0;
        container.dataset.flubberHopPhase = hop.phase;
        return;
      }
      squash.velocity -= prefersReducedMotion ? 1.1 : SQUASH_KICK;
    };

    // GAZE -- pointer tracked over the WHOLE viewport (not just the canvas),
    // mapped to yaw/pitch targets. Reduced motion halves the amplitude at
    // the source so every downstream clamp/lerp/auto-look number stays
    // proportionally consistent instead of needing its own reduced variant.
    const gazeMaxYaw = GAZE_MAX_YAW_RAD * (prefersReducedMotion ? 0.5 : 1);
    const gazeMaxPitch = GAZE_MAX_PITCH_RAD * (prefersReducedMotion ? 0.5 : 1);
    let pointerTargetYaw = 0;
    let pointerTargetPitch = 0;
    let gazeYaw = 0;
    let gazePitch = 0;
    let autoLookYaw = 0;
    let autoLookPitch = 0;
    let lastPointerMoveAt = performance.now();
    let nextAutoLookAt =
      performance.now() + (GAZE_AUTO_LOOK_MIN_S + Math.random() * (GAZE_AUTO_LOOK_MAX_S - GAZE_AUTO_LOOK_MIN_S)) * 1000;

    const onPointerMove = (event: PointerEvent) => {
      const nx = (event.clientX / window.innerWidth) * 2 - 1;
      const ny = (event.clientY / window.innerHeight) * 2 - 1;
      pointerTargetYaw = THREE.MathUtils.clamp(-nx * gazeMaxYaw, -gazeMaxYaw, gazeMaxYaw);
      pointerTargetPitch = THREE.MathUtils.clamp(-ny * gazeMaxPitch, -gazeMaxPitch, gazeMaxPitch);
      lastPointerMoveAt = performance.now();
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });

    // BLINKS -- state machine timed in seconds. Runs (subtly) even under
    // reduced motion: "a blink is character, not decoration."
    const blink = {
      phase: 'idle' as 'idle' | 'closing' | 'holding' | 'opening',
      timer: BLINK_MIN_INTERVAL_S + Math.random() * (BLINK_MAX_INTERVAL_S - BLINK_MIN_INTERVAL_S),
      scaleY: 1,
      closeDuration: 0.08,
      openDuration: 0.125,
      queuedDouble: false,
    };

    const resize = () => {
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      // updateStyle must stay true (the default) here: it's what makes Three.js
      // set canvas.style.width/height to the CSS container size while the canvas'
      // backing-store attributes go to w*pixelRatio. With it forced false, the
      // canvas had no CSS size of its own and fell back to rendering at its raw
      // attribute pixel size — correct at devicePixelRatio 1 by coincidence, but
      // ~2x oversized and clipped by the hero panel's overflow:hidden on any
      // HiDPI (retina, DPR>=2) display.
      renderer.setSize(w, h);
      camera.aspect = w / h;
      if (modelBodyBox) frameCameraFromBodyBox(modelBodyBox);
      camera.updateProjectionMatrix();
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    let rafId = 0;
    let lastFrame = performance.now();
    let lastExpression = expressionRef.current;

    const tick = (now: number) => {
      rafId = requestAnimationFrame(tick);
      const dt = Math.min((now - lastFrame) / 1000, 0.1);
      lastFrame = now;

      if (expressionRef.current !== lastExpression) {
        lastExpression = expressionRef.current;
        applyFaceVisibility();
        applyClip(false);
      }
      const activeFaceRecipe = resolveFaceRecipe(expressionRef.current);

      // Undo last frame's gaze before the mixer runs -- see headCleanQuat's
      // declaration comment for why (Idle has no Head track; without this
      // restore the additive gaze compounds into a runaway spin).
      if (headBone) headBone.quaternion.copy(headCleanQuat);

      mixer?.update(debugStatic ? 0 : prefersReducedMotion ? dt * 0.05 : dt);

      // GAZE + BLINKS apply AFTER mixer.update() -- the mixer writes fresh
      // bone/node transforms every call (for properties it has tracks for),
      // so anything layered on top has to happen post-update or the next
      // clip tick stomps it. Gaze multiplies an offset quaternion onto the
      // Head bone's clean pose; blink groups aren't animated by any clip at
      // all (they're runtime-only Groups), so order doesn't matter for
      // them, but they're kept in the same block for readability.
      const gazeIdle = now - lastPointerMoveAt > GAZE_IDLE_TIMEOUT_S * 1000;
      if (!debugStatic && gazeIdle && now >= nextAutoLookAt) {
        autoLookYaw = (Math.random() * 2 - 1) * gazeMaxYaw * GAZE_AUTO_LOOK_AMPLITUDE;
        autoLookPitch = (Math.random() * 2 - 1) * gazeMaxPitch * GAZE_AUTO_LOOK_AMPLITUDE;
        nextAutoLookAt =
          now + (GAZE_AUTO_LOOK_MIN_S + Math.random() * (GAZE_AUTO_LOOK_MAX_S - GAZE_AUTO_LOOK_MIN_S)) * 1000;
      }
      const gazeTargetYaw = debugStatic ? 0 : gazeIdle ? autoLookYaw : pointerTargetYaw;
      const gazeTargetPitch = debugStatic ? 0 : gazeIdle ? autoLookPitch : pointerTargetPitch;
      const gazeLerp = 1 - Math.exp(-GAZE_LERP_RATE * dt);
      gazeYaw += (gazeTargetYaw - gazeYaw) * gazeLerp;
      gazePitch += (gazeTargetPitch - gazePitch) * gazeLerp;

      if (headBone) {
        // Snapshot the mixer's output (or the restored clean pose when the
        // active clip has no Head track) BEFORE layering gaze on top.
        headCleanQuat.copy(headBone.quaternion);
        // Guard: don't fight Wave/Celebrate visibly -- cut gaze influence to
        // 30% while a non-Idle clip is playing.
        const clipDamp = activeFaceRecipe.gaze *
          (currentClip === null || currentClip === 'Idle' ? 1 : GAZE_NON_IDLE_CLIP_DAMP);
        gazeEuler.set(gazePitch * clipDamp, gazeYaw * clipDamp, 0);
        gazeQuat.setFromEuler(gazeEuler);
        headBone.quaternion.multiply(gazeQuat);
      }

      const blinkClosedY = prefersReducedMotion ? BLINK_CLOSED_Y_REDUCED : BLINK_CLOSED_Y_FULL;
      if (debugStatic) {
        blink.phase = 'idle';
        blink.scaleY = 1;
      } else switch (blink.phase) {
        case 'idle':
          blink.timer -= dt;
          if (blink.timer <= 0) {
            blink.phase = 'closing';
            blink.closeDuration = 0.07 + Math.random() * 0.02;
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
            blink.openDuration = 0.11 + Math.random() * 0.03;
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
            if (!blink.queuedDouble && Math.random() < BLINK_DOUBLE_CHANCE) {
              blink.queuedDouble = true;
              blink.timer = BLINK_DOUBLE_GAP_S;
            } else {
              blink.queuedDouble = false;
              blink.timer = BLINK_MIN_INTERVAL_S + Math.random() * (BLINK_MAX_INTERVAL_S - BLINK_MIN_INTERVAL_S);
            }
          }
          break;
        }
      }
      // V3.3 facial layer. Each recipe blends independently over the active
      // skeletal clip, while blink remains multiplicative so a squinted,
      // surprised or sleeping eye can still animate naturally.
      const faceBlend = debugStatic ? 1 : 1 - Math.exp(-13 * dt);
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
        rig.heart.rotation.z = (rig.side === 'L' ? -1 : 1) * 0.08
          + (debugStatic ? 0 : Math.sin(now * 0.004) * 0.025);
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

      // CGI-4 hop state machine -- runs BEFORE the squash spring on purpose:
      // the landing splat hands the spring a deep compression, and the spring
      // update just below turns that into the rebound + settle jiggle (and,
      // via |velocity| -> uGooImpact further down, the landing ripple).
      let hopScaleXZ = 1;
      let hopScaleY = 1;
      let hopPosY = 0;
      if (hop.phase === 'anticipation') {
        hop.t += dt;
        const p = Math.min(hop.t / HOP_ANTICIPATION_S, 1);
        const e = easeOutQuad(p);
        hopScaleY = 1 + (HOP_ANTICIPATION_SCALE_Y - 1) * e;
        hopScaleXZ = 1 + (HOP_ANTICIPATION_SCALE_XZ - 1) * e;
        if (p >= 1) {
          hop.phase = 'air';
          hop.t = 0;
          container.dataset.flubberHopPhase = hop.phase;
        }
      } else if (hop.phase === 'air') {
        hop.t += dt;
        const airT = Math.min(hop.t, HOP_AIR_S);
        // Parabola with apex at T/2: v0 = 4h/T, g = 8h/T^2.
        const v0 = (4 * hopHeightWorld) / HOP_AIR_S;
        const g = (8 * hopHeightWorld) / (HOP_AIR_S * HOP_AIR_S);
        hopPosY = Math.max(v0 * airT - 0.5 * g * airT * airT, 0);
        // Classical squash-and-stretch: stretch follows SPEED -- max at
        // launch/land, none at the apex.
        const speedNorm = Math.min(Math.abs(v0 - g * airT) / v0, 1);
        hopScaleY = 1 + HOP_STRETCH_Y * speedNorm;
        hopScaleXZ = 1 - HOP_STRETCH_XZ * speedNorm;
        if (hop.t >= HOP_AIR_S) {
          // LANDING SPLAT -- hand off to the spring (see block comment).
          hop.phase = 'none';
          hopPosY = 0;
          hopScaleY = 1;
          hopScaleXZ = 1;
          container.dataset.flubberHopPhase = hop.phase;
          squash.value = HOP_SPLAT_SQUASH_VALUE;
          squash.velocity = 0;
          nextHopAt = now + (HOP_MIN_INTERVAL_S + Math.random() * (HOP_MAX_INTERVAL_S - HOP_MIN_INTERVAL_S)) * 1000;
        }
      } else if (!debugStatic && !prefersReducedMotion && hopHeightWorld > 0 && currentClip === 'Idle' && now >= nextHopAt) {
        // Scheduled idle hop -- suppressed while Wave/Celebrate/Worried play
        // (the check re-arms automatically once Idle returns).
        hop.phase = 'anticipation';
        hop.t = 0;
        container.dataset.flubberHopPhase = hop.phase;
      }

      const accel = -SQUASH_SPRING_K * squash.value - SQUASH_SPRING_C * squash.velocity;
      squash.velocity += accel * dt;
      squash.value += squash.velocity * dt;
      const s = squash.value;
      root.scale.set((1 - s * 0.35) * hopScaleXZ, (1 + s * 0.5) * hopScaleY, (1 - s * 0.35) * hopScaleXZ);
      root.position.y = hopPosY;
      if (hop.phase === 'air') container.dataset.flubberHopY = hopPosY.toFixed(6);
      else if (hop.phase === 'none') container.dataset.flubberHopY = '0';

      // CGI-2 -- drive the liquid wobble. Time advances every frame (the
      // wobble literally never stops; reduced motion is handled at the
      // AMPLITUDE, already scaled to 25% where uGooWobbleAmp is set).
      // Impact rides the squash spring's |velocity|: a click kicks the
      // spring, the spring rings down over ~1.5s, and the wobble amplitude
      // rings down with it -- ripples through the body on every impact.
      wobbleUniforms.uGooTime.value = debugStatic ? 0 : now / 1000;
      wobbleUniforms.uGooImpact.value = Math.min(
        Math.abs(squash.velocity) * WOBBLE_IMPACT_VELOCITY_FACTOR,
        WOBBLE_IMPACT_MAX,
      );

      // GROUNDING SHADOW -- spreads horizontally (less dramatically than the
      // body itself) when squashed down; vertical (screen) extent stays put,
      // a real contact shadow widens rather than deepens under squash.
      if (shadowMesh) {
        // CGI-5: hop-aware. Airborne fraction shrinks + fades the pool
        // (contact broken); the splat's xz overspread (root.scale.x > 1)
        // widens it via shadowSpread AND darkens it toward full texture
        // alpha. Grounded idle = base look, exactly as before the hop pass.
        const airborneNorm = hopHeightWorld > 0 ? Math.min(hopPosY / hopHeightWorld, 1) : 0;
        const shadowSpread = (1 + (root.scale.x - 1) * SHADOW_REACT_DAMP) * (1 - SHADOW_AIRBORNE_SHRINK * airborneNorm);
        shadowMesh.scale.set(shadowSpread, 1, 1);
        if (shadowMaterial) {
          const splatBoost = Math.max(root.scale.x - 1, 0) * SHADOW_SPLAT_DARKEN;
          shadowMaterial.opacity = Math.min(
            SHADOW_BASE_OPACITY * (1 - SHADOW_AIRBORNE_FADE * airborneNorm) + splatBoost,
            1,
          );
        }
      }

      // GOO DROPLETS -- paused (left at their static placed pose) under
      // reduced motion instead of stepping the orbit/bob each frame.
      if (!debugStatic && !prefersReducedMotion) {
        for (let i = 0; i < droplets.length; i += 1) {
          const d = droplets[i];
          d.phase += dt * d.angularSpeed;
          d.mesh.position.set(
            d.centerX + Math.cos(d.phase) * d.orbitRadiusX,
            d.centerY + Math.sin(d.phase * d.bobFreq + d.bobPhase) * d.bobAmplitude,
            d.centerZ + Math.sin(d.phase) * d.orbitRadiusZ,
          );
        }
      }

      // CGI-3 AIR BUBBLES -- very slow vertical drift only (they're
      // suspended in goo, not orbiting). Static under reduced motion, same
      // policy as the droplets.
      if (!debugStatic && !prefersReducedMotion) {
        const bubbleT = now / 1000;
        const bubbleDummy = new THREE.Object3D();
        for (let i = 0; i < bubbles.length; i += 1) {
          const b = bubbles[i];
          bubbleDummy.position.set(
            b.x,
            b.baseY + Math.sin(bubbleT * b.bobFreq * Math.PI * 2 + b.bobPhase) * b.bobAmplitude,
            b.z,
          );
          bubbleDummy.scale.setScalar(b.scale);
          bubbleDummy.updateMatrix();
          bubbleMesh?.setMatrixAt(b.index, bubbleDummy.matrix);
        }
        if (bubbleMesh) bubbleMesh.instanceMatrix.needsUpdate = true;
        if (microBubbleMesh) {
          microBubbleMesh.rotation.y = Math.sin(bubbleT * 0.16) * 0.025;
        }
      }

      if (pedestalRingMaterial && pedestalGroup) {
        const stageTime = debugStatic ? 0 : now / 1000;
        pedestalRingMaterial.uniforms.uTime.value = stageTime;
        pedestalGroup.scale.setScalar(debugStatic ? 1 : 1 + Math.sin(stageTime * 1.6) * 0.012);
      }

      renderer.render(scene, camera);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
      firePulseRef.current = null;
      mixer?.stopAllAction();
      shadowMesh?.geometry.dispose();
      shadowMaterial?.dispose();
      shadowTexture?.dispose();
      dropletMaterial?.dispose(); // same instance as gooMaterial under GOO_MODE -- one dispose covers both
      envMapTexture?.dispose();
      backdropMesh?.geometry.dispose();
      backdropMaterial?.dispose();
      backdropTexture?.dispose();
      pedestalRingGeometry?.dispose();
      pedestalRingMaterial?.dispose();
      pedestalDiscGeometry?.dispose();
      pedestalDiscMaterial?.dispose();
      pedestalConeGeometry?.dispose();
      pedestalConeMaterial?.dispose();
      droplets.forEach((d) => d.mesh.geometry.dispose());
      bubbleGeometry?.dispose();
      bubbleMaterial?.dispose();
      microBubbleGeometry?.dispose();
      microBubbleMaterial?.dispose();
      expressionGeometries.forEach((geometry) => geometry.dispose());
      browMaterial?.dispose();
      heartMaterial?.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debugStatic]);

  return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%' }} />;
}
