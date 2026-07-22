/**
 * flubber3d/materials — every material Blubber wears, per quality tier
 * (Phase 1 of docs/plans/flubber-3d-everywhere.md):
 *
 *   HERO  — createGooMaterial(): the full CGI goo (transmission + wobble +
 *           baked-spot reshade + rim), extracted verbatim from FlubberMesh.tsx
 *           with its complete tuning history preserved in the comments.
 *   MID   — createClearcoatGooMaterial(): the same green jelly READ without
 *           the transmission render pass — clearcoat + emissive + vertex-color
 *           spots + the same wobble vertex displacement. One compile, no
 *           per-frame background render. For 64–159px slots.
 *   MICRO — createMicroSkinMaterial(): the baked Cycles matcap — unlit,
 *           lightless, one texture fetch. For <64px slots where transmission
 *           and clearcoat physics read as noise anyway.
 *
 * Face parts (eyes/mouth) are upgraded by upgradeMaterials() the same way at
 * every tier — the face must stay readable at 26px more than anywhere else.
 */

import * as THREE from 'three';
import { createSeededRandom } from './face';
import type { MatcapTextures } from './assets';

// ---------------------------------------------------------------------------
// CGI-1 (2026-07-12) — goo material pass. ILM reference is TRANSLUCENT green
// goo — background refracts through the body — not paint on a rigid mesh.
// GOO_MODE is the PERFORMANCE GUARD: flip false and the body reverts to the
// exact pre-CGI matcap material.
// ---------------------------------------------------------------------------
export const GOO_MODE = true;
export const GOO_TRANSMISSION = 0.76;
export const GOO_IOR = 1.4;
export const GOO_ROUGHNESS = 0.05;
// RS5: attenuation hue fixed to the locked-palette dominant green (#4CAF1E
// family) — the old 0x1f9c3d blue channel is what read as "washed gray-jade".
// Glow-up pass (2026-07-21): lifted toward lime so light passing THROUGH the
// body reads bright/juicy like the reference render, not murky forest green.
export const GOO_ATTENUATION_COLOR = 0x36d41a;
export const GOO_SPOT_ATTENUATION_COLOR = 0x8dff4a; // locked-palette brightest lime
export const GOO_SPOT_LUMINANCE_LOW = 0.35;
export const GOO_SPOT_LUMINANCE_HIGH = 0.55;
// RS6: spot self-lift fed as faint emissive AFTER the transmission mix, where
// it actually survives — attenuation alone is too weak at transmission 0.76+.
export const GOO_SPOT_EMISSIVE_COLOR = 0x8dff4a;
// Glow-up pass: 0.08 → 0.14 — the baked spots should read as bright freckles
// lit from inside (reference has luminous speckle), not faint tints.
export const GOO_SPOT_EMISSIVE_STRENGTH = 0.14;
export const GOO_CLEARCOAT = 0.96;
export const GOO_CLEARCOAT_ROUGHNESS = 0.035;
// thickness/attenuationDistance are authored as fractions of the body's own
// measured height (bodyBox, computed once the GLB loads).
export const GOO_THICKNESS_FRACTION = 0.62;
export const GOO_ATTENUATION_DISTANCE_FRACTION = 0.58;
export const GOO_BASE_COLOR = 0x1d8a12;
// Lane D (2026-07-19) — hero presence: the HERO body is the product's focal
// point and reads dimmer/flatter than the review wanted. GOO_ENV_MAP_INTENSITY
// is consumed ONLY by createGooMaterial() below (MID hardcodes its own 1.05
// directly), so raising it brightens HERO's reflections/highlights alone —
// MID/MICRO are untouched. No new color, just more of the existing env light.
// Glow-up pass: 1.3 → 1.6 — bigger/brighter wet blooms off the studio cards.
export const GOO_ENV_MAP_INTENSITY = 1.6;
export const GOO_TONE_MAPPING_EXPOSURE = 1.25;
export const GOO_RIM_COLOR = 0x8cff54;
// Base rim strength — what MID's clearcoat jelly uses. Glow-up: 0.32 → 0.44.
export const GOO_RIM_STRENGTH = 0.44;
// Lane D — HERO-only rim strength, brighter than MID's GOO_RIM_STRENGTH. The
// rim fragment chunk is now built per-material via buildGooRimFragmentChunk()
// (see below) so HERO and MID can each bake in their own coefficient instead
// of sharing one literal. Glow-up: 0.44 → 0.7 for harder separation from the
// dark room, matching the reference render's rim.
export const GOO_HERO_RIM_STRENGTH = 0.7;
// Glow-up pass — "lit from within" core: an additive lime lift where the
// surface faces the camera, falling off toward the silhouette (the inverse of
// the fresnel rim). This is what makes the reference body read as glowing goo
// instead of painted jelly. Baked into the rim chunk per tier — HERO glows
// harder than MID (small MID bodies over-glow into neon fast).
export const GOO_HERO_CORE_GLOW = 0.26;
export const GOO_MID_CORE_GLOW = 0.13;
export const GOO_DPR_CAP = 0.9; // keeps the transmissive hero smooth under load
// RS5 droplets: geometry sharing the goo material needs SOME color attribute
// once vertexColors is on, or it binds to (0,0,0) and multiplies to black.
export const DROPLET_BASE_VERTEX_COLOR = 0x4caf1e;

// Backdrop: transmission bends whatever is drawn BEHIND the mesh IN the WebGL
// scene — a real green-lit backdrop plane inside the scene is load-bearing,
// not decorative.
export const GOO_BACKDROP_COLOR = 0x0c6f0e;
export const GOO_BACKDROP_DISTANCE_FRACTION = 1.6;
export const GOO_BACKDROP_MAX_ALPHA = 0.47;
export const GOO_BACKDROP_FILL_FACTOR = 1.5;

// ---------------------------------------------------------------------------
// CGI-2 (2026-07-12) — liquid wobble. Layered periodic waves along the skinned
// normal with an exact analytic-derivative normal perturbation, injected AFTER
// #include <skinning_vertex> so displacement rides the skinned pose.
// ---------------------------------------------------------------------------
export const WOBBLE_BASE_AMP_FRACTION = 0.018;
export const WOBBLE_REDUCED_MOTION_FACTOR = 0.25;
export const WOBBLE_IMPACT_VELOCITY_FACTOR = 0.35;
export const WOBBLE_IMPACT_MAX = 2.5;

export const WOBBLE_VERTEX_CHUNK = `
#include <skinning_vertex>
{
  float wT = uGooTime;
  vec3 wP = transformed;
  float wob = sin(wP.y * 3.0 + wT * 3.1) * 0.6
            + sin(wP.x * 4.0 - wT * 2.3) * 0.25
            + sin((wP.x + wP.z) * 6.0 + wT * 7.5) * 0.15;
  // Fade wobble as normals turn away from the camera-facing z axis — the
  // broad front jiggles while the silhouette stays clean.
  float wFacing = smoothstep(0.28, 0.82, abs(objectNormal.z));
  float wAmp = uGooWobbleAmp * (1.0 + uGooImpact) * wFacing;
  transformed += objectNormal * (wob * wAmp);
  vec3 wGrad = vec3(
    cos(wP.x * 4.0 - wT * 2.3) * 1.0 + cos((wP.x + wP.z) * 6.0 + wT * 7.5) * 0.9,
    cos(wP.y * 3.0 + wT * 3.1) * 1.8,
    cos((wP.x + wP.z) * 6.0 + wT * 7.5) * 0.9
  );
  vec3 wTan = wGrad - dot(wGrad, objectNormal) * objectNormal;
  vec3 wN = normalize(objectNormal - wTan * wAmp);
  #ifndef FLAT_SHADED
  vNormal = normalize(normalMatrix * wN);
  #endif
}
`;

export const WOBBLE_UNIFORM_DECLARATIONS = `
uniform float uGooTime;
uniform float uGooWobbleAmp;
uniform float uGooImpact;
`;

export const SPOT_UNIFORM_DECLARATIONS = `
uniform vec3 uGooSpotAttenuationColor;
uniform vec3 uGooSpotEmissive;
uniform vec3 uGooRimColor;
`;

export const SPOT_ATTENUATION_FRAGMENT_CHUNK = `
{
  float gooLum = dot( vColor, vec3( 0.299, 0.587, 0.114 ) );
  float gooSpotT = smoothstep( ${GOO_SPOT_LUMINANCE_LOW.toFixed(3)}, ${GOO_SPOT_LUMINANCE_HIGH.toFixed(3)}, gooLum );
  material.attenuationColor = mix( attenuationColor, uGooSpotAttenuationColor, gooSpotT );
}
`;

export const SPOT_EMISSIVE_FRAGMENT_CHUNK = `
#include <emissivemap_fragment>
{
  float gooEmitLum = dot( vColor, vec3( 0.299, 0.587, 0.114 ) );
  float gooEmitT = smoothstep( ${GOO_SPOT_LUMINANCE_LOW.toFixed(3)}, ${GOO_SPOT_LUMINANCE_HIGH.toFixed(3)}, gooEmitLum );
  totalEmissiveRadiance += uGooSpotEmissive * gooEmitT;
}
`;

// Cheap view-space Fresnel lift: bright thin perimeter + darker optical core,
// the "expensive jelly" separation from the reference.
// Lane D — parametrized by rimStrength so HERO can run a brighter rim
// (GOO_HERO_RIM_STRENGTH) than MID's read (GOO_RIM_STRENGTH) without a shared
// constant forcing them to match; everything else in the chunk is identical
// for both tiers.
// Glow-up pass (2026-07-21) — second param coreGlowStrength: additive lime
// core glow on camera-facing surface (inverse fresnel), the reference's
// "bright luminous center falling off to deep saturated edges". The old core
// DARKENING floor is eased 0.74 → 0.84 — the ref's core is the BRIGHT part;
// the deep-green band lives in the mid-annulus between core glow and rim.
function buildGooRimFragmentChunk(rimStrength: number, coreGlowStrength: number): string {
  return `
{
  float gooPeak = max( outgoingLight.r, max( outgoingLight.g, outgoingLight.b ) );
  float gooWhiteGlint = smoothstep( 0.55, 0.90, gooPeak );
  vec3 gooSaturatedBody = outgoingLight * vec3( 0.92, 1.0, 0.56 );
  outgoingLight = mix( gooSaturatedBody, outgoingLight, gooWhiteGlint );
  float gooNdV = clamp( dot( normalize( normal ), normalize( vViewPosition ) ), 0.0, 1.0 );
  float gooFresnel = pow( 1.0 - gooNdV, 5.2 );
  float gooCoreDepth = mix( 0.8, 1.0, smoothstep( 0.01, 0.42, gooFresnel ) );
  gooCoreDepth = mix( gooCoreDepth, 1.0, gooWhiteGlint );
  outgoingLight *= gooCoreDepth;
  outgoingLight += vec3( 0.025, 0.047, 0.0038 ) * ( 1.0 - gooWhiteGlint );
  // Lit-from-within: lime radiance strongest where the surface faces the
  // camera, dying off before the silhouette so the deep-green annulus and the
  // fresnel rim both survive. Tightened falloff (^2.4) keeps the glow a CORE
  // instead of a full-body wash; hue biased green (R low) so the body stays
  // green→lime, never yellow. Glint mask keeps white speculars white.
  float gooCoreGlow = pow( gooNdV, 2.4 ) * ${coreGlowStrength.toFixed(3)};
  outgoingLight += vec3( 0.26, 0.95, 0.08 ) * gooCoreGlow * ( 1.0 - gooWhiteGlint * 0.6 );
  vec3 gooN = normalize( normal );
  float gooUnderGlow = pow( max( -gooN.y, 0.0 ), 2.0 );
  // Glow-up: 0.52 → 0.62 — the reference's stage light kicks harder up into
  // the underside of the body.
  outgoingLight += vec3( 0.12, 0.72, 0.055 ) * gooUnderGlow * 0.62;
  outgoingLight += uGooRimColor * gooFresnel * ${rimStrength.toFixed(3)};
}
#include <opaque_fragment>
`;
}

// CGI-3 bubbles
export const BUBBLE_COUNT = 20;
export const BUBBLE_RADIUS_MIN_FRACTION = 0.006;
export const BUBBLE_RADIUS_MAX_FRACTION = 0.032;
export const MICRO_BUBBLE_COUNT = 150;
export const BUBBLE_SPREAD_X_FRACTION = 0.32;
export const BUBBLE_SPREAD_Z_FRACTION = 0.07;
export const BUBBLE_FORWARD_Z_FRACTION = 0.17;
export const BUBBLE_BELLY_CENTER_Y_FRACTION = 0.36;
export const BUBBLE_SPREAD_Y_FRACTION = 0.32;
export const BUBBLE_BOB_AMPLITUDE_FRACTION = 0.006;
export const BUBBLE_BOB_FREQ_MIN = 0.08;
export const BUBBLE_BOB_FREQ_MAX = 0.2;
export const BUBBLE_COLOR = 0x0c5116;
export const BUBBLE_EMISSIVE = 0xc9ff87;
export const BUBBLE_EMISSIVE_INTENSITY = 0.28;

// CGI-4 hop
export const HOP_MIN_INTERVAL_S = 8;
export const HOP_MAX_INTERVAL_S = 15;
export const HOP_ANTICIPATION_S = 0.12;
export const HOP_AIR_S = 0.5;
export const HOP_HEIGHT_FRACTION = 0.09;
export const HOP_ANTICIPATION_SCALE_Y = 0.85;
export const HOP_ANTICIPATION_SCALE_XZ = 1.1;
export const HOP_STRETCH_Y = 0.15;
export const HOP_STRETCH_XZ = 0.08;
export const HOP_SPLAT_SQUASH_VALUE = -0.56;

// GROUNDING SHADOW
export const SHADOW_TEXTURE_SIZE = 128;
export const SHADOW_CORE_ALPHA = 0.55;
export const SHADOW_REACT_DAMP = 0.6;
export const SHADOW_BASE_OPACITY = 0.82;
export const SHADOW_AIRBORNE_SHRINK = 0.3;
export const SHADOW_AIRBORNE_FADE = 0.45;
export const SHADOW_SPLAT_DARKEN = 1.4;

// GOO DROPLETS
export const DROPLET_COUNT = 6;
export const DROPLET_RADIUS_MIN_FRACTION = 0.02;
export const DROPLET_RADIUS_MAX_FRACTION = 0.05;
export const DROPLET_ORBIT_RADIUS_FRACTION = 0.42;
export const DROPLET_BOB_AMPLITUDE_FRACTION = 0.14;

// Hero staging
export const HERO_FRAME_HEIGHT_FRACTION = 0.835;
export const HERO_FRAME_WIDTH_FRACTION = 0.9;
export const HERO_BACKDROP_SCALE = 1.85;
export const HERO_FRAME_CENTER_Y_FRACTION = -0.04;

/** CGI-2 — the wobble uniforms shared between the TS render loop (which
 * writes .value each frame) and every compiled program variant of the goo
 * material (skinned body + non-skinned droplets/bubbles compile separately;
 * onBeforeCompile runs per-variant and each gets THESE SAME objects). */
export interface WobbleUniforms {
  uGooTime: { value: number };
  uGooWobbleAmp: { value: number };
  uGooImpact: { value: number };
}

export function createWobbleUniforms(): WobbleUniforms {
  return {
    uGooTime: { value: 0 },
    uGooWobbleAmp: { value: 0 },
    uGooImpact: { value: 0 },
  };
}

/** Purpose-built reflection cards matching the concept's highlight layout.
 * Generated once into PMREM; the live frame pays only the normal env lookup. */
export function createStudioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const studio = new THREE.Scene();
  studio.background = new THREE.Color(0x071d09);
  const addCard = (
    width: number,
    height: number,
    color: number,
    position: THREE.Vector3,
    intensity = 1,
    round = false,
    roll = 0,
  ) => {
    const mesh = new THREE.Mesh(
      round ? new THREE.CircleGeometry(1, 64) : new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(color).multiplyScalar(intensity),
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    if (round) mesh.scale.set(width * 0.5, height * 0.5, 1);
    mesh.position.copy(position);
    mesh.lookAt(0, 0, 0);
    mesh.rotateZ(roll);
    studio.add(mesh);
  };
  // Glow-up pass (2026-07-21): key cards brightened (the reference's big wet
  // blooms) and the upper-front glint card pushed harder — combined with the
  // wider PMREM blur below this reads as large SOFT highlight blooms instead
  // of small hard glints. One-time bake, zero per-frame cost.
  addCard(15.0, 3.2, 0xffffff, new THREE.Vector3(-2.0, 12.0, -6.0), 11.0, true, Math.PI / 2);
  addCard(2.2, 1.8, 0xf5ffed, new THREE.Vector3(-6.0, 9.0, 3.1), 7.0, true);
  addCard(4.0, 2.0, 0xeaffdf, new THREE.Vector3(3.5, -8.0, 1.0), 7.5, true);
  addCard(1.15, 0.75, 0xffffff, new THREE.Vector3(5.2, 4.0, 3.8), 4.5, true);
  addCard(3.0, 1.1, 0x44ff35, new THREE.Vector3(2.5, 2.2, -4.0), 2.2);

  const pmrem = new THREE.PMREMGenerator(renderer);
  // Sigma 0.015 → 0.05: pre-blurs the studio cards so speculars bloom soft
  // and wide like the reference render's wet highlights.
  const texture = pmrem.fromScene(studio, 0.05).texture;
  pmrem.dispose();
  studio.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => material.dispose());
  });
  return texture;
}

/** CGI-1 — the HERO jelly material. thickness/attenuationDistance start at a
 * neutral 1.0 and get rescaled to the body's own measured height after the
 * GLB loads. customProgramCacheKey is mandatory: three caches compiled
 * programs by material type + flags, and without a distinct key our patched
 * shader could be replaced by a cached UNPATCHED MeshPhysicalMaterial program. */
export function createGooMaterial(wobble: WobbleUniforms): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(GOO_BASE_COLOR),
    transmission: GOO_TRANSMISSION,
    thickness: 1,
    ior: GOO_IOR,
    roughness: GOO_ROUGHNESS,
    metalness: 0,
    clearcoat: GOO_CLEARCOAT,
    clearcoatRoughness: GOO_CLEARCOAT_ROUGHNESS,
    attenuationColor: new THREE.Color(GOO_ATTENUATION_COLOR),
    attenuationDistance: 1,
    envMapIntensity: GOO_ENV_MAP_INTENSITY,
    // Glow-up pass: 0x0f9b17 @ 0.14 → 0x17b013 @ 0.17 — the whole-body ambient
    // radiance under the core-glow term; keeps shadow side from going dead.
    // (0.2 in round 1 washed the deep-green annulus toward uniform chartreuse —
    // the ref keeps rich dark green between core glow and rim.)
    emissive: new THREE.Color(0x17b013),
    emissiveIntensity: 0.17,
    vertexColors: true,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGooTime = wobble.uGooTime;
    shader.uniforms.uGooWobbleAmp = wobble.uGooWobbleAmp;
    shader.uniforms.uGooImpact = wobble.uGooImpact;
    shader.uniforms.uGooSpotAttenuationColor = { value: new THREE.Color(GOO_SPOT_ATTENUATION_COLOR) };
    shader.uniforms.uGooSpotEmissive = {
      value: new THREE.Color(GOO_SPOT_EMISSIVE_COLOR).multiplyScalar(GOO_SPOT_EMISSIVE_STRENGTH),
    };
    shader.uniforms.uGooRimColor = { value: new THREE.Color(GOO_RIM_COLOR) };
    shader.vertexShader = WOBBLE_UNIFORM_DECLARATIONS + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <skinning_vertex>', WOBBLE_VERTEX_CHUNK);
    shader.fragmentShader = SPOT_UNIFORM_DECLARATIONS + shader.fragmentShader;
    // RS6: replace the transmission_fragment INCLUDE DIRECTIVE with the real
    // chunk body (version-accurate, from THREE.ShaderChunk) carrying the
    // attenuation reshade — replacing the chunk's inner line directly is a
    // no-op because includes aren't expanded yet here.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <transmission_fragment>',
      THREE.ShaderChunk.transmission_fragment.replace(
        'material.attenuationColor = attenuationColor;',
        SPOT_ATTENUATION_FRAGMENT_CHUNK,
      ),
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      SPOT_EMISSIVE_FRAGMENT_CHUNK,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      buildGooRimFragmentChunk(GOO_HERO_RIM_STRENGTH, GOO_HERO_CORE_GLOW),
    );
  };
  // Glow-up pass changed rim strength + added the baked core-glow term — new
  // cache key so three.js never serves a program compiled under the old
  // constants from its internal program cache.
  material.customProgramCacheKey = () => 'flubber-goo-nextgen-v40';
  return material;
}

/** MID tier — same jelly READ, no transmission render pass. Clearcoat +
 * emissive floor + baked-spot vertex colors + the same wobble displacement.
 * The transmission look is approximated by a brighter base color + emissive
 * (there is no background pass to refract at 64–159px, and nobody can tell). */
export function createClearcoatGooMaterial(wobble: WobbleUniforms): THREE.MeshPhysicalMaterial {
  // Owner note (Item 9): spawned minis read "old / solid / matte". Pull the MID
  // material toward the hero's wet-gloss — hero roughness/clearcoatRoughness,
  // full env reflections, a brighter base + a touch more emissive floor so the
  // jelly looks lit and shiny instead of flat-painted.
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0x37b41f),
    roughness: GOO_ROUGHNESS,
    metalness: 0,
    clearcoat: GOO_CLEARCOAT,
    clearcoatRoughness: GOO_CLEARCOAT_ROUGHNESS,
    // Glow-up pass: 1.05 → 1.2 env so MID picks up the same bigger wet blooms
    // the hero got; emissive nudged limeward to track the hero's inner glow.
    envMapIntensity: 1.2,
    emissive: new THREE.Color(0x24a816),
    emissiveIntensity: 0.4,
    vertexColors: true,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGooTime = wobble.uGooTime;
    shader.uniforms.uGooWobbleAmp = wobble.uGooWobbleAmp;
    shader.uniforms.uGooImpact = wobble.uGooImpact;
    shader.uniforms.uGooRimColor = { value: new THREE.Color(GOO_RIM_COLOR) };
    shader.vertexShader = WOBBLE_UNIFORM_DECLARATIONS + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <skinning_vertex>', WOBBLE_VERTEX_CHUNK);
    shader.fragmentShader = 'uniform vec3 uGooRimColor;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      buildGooRimFragmentChunk(GOO_RIM_STRENGTH, GOO_MID_CORE_GLOW),
    );
  };
  material.customProgramCacheKey = () => 'flubber-goo-clearcoat-mid-v4';
  return material;
}

/** MICRO tier — the baked Cycles matcap: unlit, lightless, view-independent,
 * one texture fetch. At 26–56px this reads identically to the goo and costs
 * nearly nothing. */
export function createMicroSkinMaterial(matcaps: MatcapTextures): THREE.MeshMatcapMaterial {
  // toneMapped false: the shared host renderer runs ACES for the goo tiers;
  // the matcap is a finished Cycles bake and must not be re-graded.
  const material = new THREE.MeshMatcapMaterial({ matcap: matcaps.skin });
  material.toneMapped = false;
  return material;
}

/** RS5 — stamps a flat, uniform vertex color onto a geometry that has no
 * baked "Spots" attribute of its own. Required once a shared material turns
 * vertexColors on — a missing color attribute binds to (0,0,0) and multiplies
 * diffuse to black. */
export function applyUniformVertexColor(geometry: THREE.BufferGeometry, colorHex: number): void {
  const color = new THREE.Color(colorHex);
  const vertexCount = geometry.attributes.position.count;
  const colors = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i += 1) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/**
 * glTF material names carry the shader intent from the Blender build
 * (FlubberSkinV2 / FlubberEyeBlackV2 / FlubberEyeWhiteV2 / FlubberEyeRimV2 /
 * FlubberMouthV2 / FlubberMouthWarmV2). Matched by substring so this survives
 * V2/V3 suffix bumps. Skin gets the tier material; eye-white, eye rim, and
 * both mouth surfaces are flat unlit colors (baking them into the skin would
 * smear them across camera angles). MouthWarm MUST be checked before the
 * generic Mouth branch (GD-5).
 */
export function upgradeMaterials(instance: THREE.Object3D, skinMaterial: THREE.Material) {
  instance.traverse((obj) => {
    if (obj instanceof THREE.SkinnedMesh) {
      // Bind-pose bounds don't account for animated deformation — an arm
      // raised can push the mesh outside its bind-pose bounding sphere and
      // get incorrectly frustum-culled at screen edges.
      obj.frustumCulled = false;
    }
    if (!(obj instanceof THREE.Mesh)) return;
    const sourceMat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    const name = sourceMat?.name ?? '';
    if (name.includes('Skin')) {
      obj.material = skinMaterial;
    } else if (name.includes('EyeBlack')) {
      obj.material = new THREE.MeshPhysicalMaterial({
        color: 0x010c05,
        roughness: 0.075,
        metalness: 0,
        clearcoat: 1,
        clearcoatRoughness: 0.018,
        envMapIntensity: 1,
        emissive: 0x062b14,
        emissiveIntensity: 0.12,
      });
    } else if (name.includes('EyeWhite')) {
      obj.material = new THREE.MeshBasicMaterial({ color: 0xbfffe8, toneMapped: false });
    } else if (name.includes('EyeRim')) {
      obj.material = new THREE.MeshPhysicalMaterial({
        color: 0x0b7c3a,
        roughness: 0.16,
        clearcoat: 0.75,
        clearcoatRoughness: 0.08,
        envMapIntensity: 0.35,
      });
    } else if (name.includes('MouthWarm')) {
      obj.material = new THREE.MeshBasicMaterial({ color: 0x789522, toneMapped: false });
    } else if (name.includes('Mouth')) {
      obj.material = new THREE.MeshBasicMaterial({ color: 0x050805, toneMapped: false });
    }
  });
}

/** MICRO-tier face upgrade — eye-black keeps its matcap bake (unlit, no
 * lights in a micro scene would leave MeshPhysicalMaterial black). */
export function upgradeMaterialsMicro(instance: THREE.Object3D, matcaps: MatcapTextures, skinMaterial: THREE.Material) {
  instance.traverse((obj) => {
    if (obj instanceof THREE.SkinnedMesh) obj.frustumCulled = false;
    if (!(obj instanceof THREE.Mesh)) return;
    const sourceMat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    const name = sourceMat?.name ?? '';
    if (name.includes('Skin')) {
      obj.material = skinMaterial;
    } else if (name.includes('EyeBlack')) {
      const eyeMaterial = new THREE.MeshMatcapMaterial({ matcap: matcaps.eye });
      eyeMaterial.toneMapped = false;
      obj.material = eyeMaterial;
    } else if (name.includes('EyeWhite')) {
      obj.material = new THREE.MeshBasicMaterial({ color: 0xbfffe8, toneMapped: false });
    } else if (name.includes('EyeRim')) {
      obj.material = new THREE.MeshBasicMaterial({ color: 0x0b7c3a, toneMapped: false });
    } else if (name.includes('MouthWarm')) {
      obj.material = new THREE.MeshBasicMaterial({ color: 0x789522, toneMapped: false });
    } else if (name.includes('Mouth')) {
      obj.material = new THREE.MeshBasicMaterial({ color: 0x050805, toneMapped: false });
    }
  });
}

export function createBubbleCavityMaterial(micro = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCore: { value: new THREE.Color(micro ? 0x78d94a : 0x63c53c) },
      uRim: { value: new THREE.Color(micro ? 0xe6ffae : 0xc9ff87) },
      uGlow: {
        value: new THREE.Color(BUBBLE_EMISSIVE).multiplyScalar(
          micro ? BUBBLE_EMISSIVE_INTENSITY * 0.45 : BUBBLE_EMISSIVE_INTENSITY,
        ),
      },
      uOpacity: { value: micro ? 0.68 : 0.95 },
    },
    vertexShader: `
      varying vec3 vBubbleNormal;
      varying vec3 vBubbleView;
      void main() {
        vec4 localPosition = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          localPosition = instanceMatrix * localPosition;
          vBubbleNormal = normalize(normalMatrix * mat3(instanceMatrix) * normal);
        #else
          vBubbleNormal = normalize(normalMatrix * normal);
        #endif
        vec4 mvPosition = modelViewMatrix * localPosition;
        vBubbleView = -mvPosition.xyz;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uCore;
      uniform vec3 uRim;
      uniform vec3 uGlow;
      uniform float uOpacity;
      varying vec3 vBubbleNormal;
      varying vec3 vBubbleView;
      void main() {
        vec3 n = normalize(vBubbleNormal);
        vec3 v = normalize(vBubbleView);
        float edge = 1.0 - abs(dot(n, v));
        float ring = smoothstep(0.48, 0.84, edge);
        float glint = pow(max(dot(n, normalize(vec3(-0.48, 0.74, 0.46))), 0.0), 32.0);
        vec3 color = mix(uCore, uRim, ring) + uGlow + vec3(0.72, 1.0, 0.68) * glint * 0.35;
        float alpha = uOpacity * (0.06 + ring * 0.68 + glint * 0.35);
        gl_FragColor = vec4(color, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
}

/** Radial-alpha soft shadow — a CanvasTexture, not a light + ShadowMaterial. */
export function createShadowTexture(): THREE.CanvasTexture {
  const size = SHADOW_TEXTURE_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, `rgba(0, 0, 0, ${SHADOW_CORE_ALPHA})`);
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  return new THREE.CanvasTexture(canvas);
}

/** CGI-1 goo backdrop — soft radial green glow placed BEHIND the body so the
 * transmission material has real light to bend/tint. Fades all the way to 0
 * at the edge (canvas radial gradients repeat the final stop beyond the
 * radius — a non-zero final stop renders the plane's square corners). */
export function createGooBackdropTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const [r, g, b] = [
      (GOO_BACKDROP_COLOR >> 16) & 0xff,
      (GOO_BACKDROP_COLOR >> 8) & 0xff,
      GOO_BACKDROP_COLOR & 0xff,
    ];
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${GOO_BACKDROP_MAX_ALPHA})`);
    gradient.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, ${(GOO_BACKDROP_MAX_ALPHA * 0.55).toFixed(3)})`);
    gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    // One-time procedural studio depth: faint defocused panels and scanlines.
    const backdropRandom = createSeededRandom(0x51ad10);
    ctx.globalCompositeOperation = 'screen';
    for (let index = 0; index < 18; index += 1) {
      const x = backdropRandom() * size;
      const y = size * (0.18 + backdropRandom() * 0.66);
      const width = 1 + backdropRandom() * 8;
      const height = 8 + backdropRandom() * 46;
      const alpha = 0.006 + backdropRandom() * 0.018;
      ctx.fillStyle = `rgba(70, 255, 92, ${alpha.toFixed(3)})`;
      ctx.fillRect(x, y, width, height);
    }
    ctx.strokeStyle = 'rgba(78, 255, 98, 0.012)';
    ctx.lineWidth = 1;
    for (let y = size * 0.28; y < size * 0.86; y += 19) {
      ctx.beginPath();
      ctx.moveTo(size * 0.05, y);
      ctx.lineTo(size * 0.95, y);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  return new THREE.CanvasTexture(canvas);
}

export function createPedestalRingMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime;
      void main() {
        float sweep = 0.72 + 0.28 * sin(uTime * 2.4 + vUv.x * 18.8496);
        gl_FragColor = vec4(0.34, 1.0, 0.34, sweep * 0.48);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

/**
 * Holographic "code screen" material for agent workstations — procedural
 * scrolling code lines + faint grid + an in-3D progress bar, additive, no
 * texture fetches (all animated off uTime). Per-panel variation via an aPanel
 * vertex attribute so 3+1 screens stay ONE draw call. Palette-locked lime.
 */
export function createHoloMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uWorking: { value: 0 },
      uMaterialize: { value: 0 },
      uProgress: { value: 0 },
      uColor: { value: new THREE.Color(0x8dff4a) },
    },
    vertexShader: `
      attribute float aPanel;
      varying vec2 vUv;
      varying float vPanel;
      void main() {
        vUv = uv; vPanel = aPanel;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision mediump float;
      uniform float uTime, uWorking, uMaterialize, uProgress;
      uniform vec3 uColor;
      varying vec2 vUv;
      varying float vPanel;
      float hash(float n){ return fract(sin(n) * 43758.5453123); }
      void main() {
        vec2 uv = vUv;
        float panelPhase = vPanel * 7.13;
        float speed = mix(0.35, 1.1, uWorking);
        float rows = 14.0;
        float scroll = uTime * speed + panelPhase;
        float ry = floor(uv.y * rows + scroll);
        float lineOn = step(0.35, hash(ry));
        float lineW = 0.35 + 0.5 * hash(ry * 1.7);
        float ink = lineOn * step(uv.x, lineW) * step(fract(uv.y * rows + scroll), 0.55);
        vec2 g = abs(fract(uv * vec2(10.0, 14.0)) - 0.5);
        float grid = smoothstep(0.48, 0.5, max(g.x, g.y)) * 0.12;
        float barZone = step(uv.y, 0.08) * step(0.05, uv.y);
        float barFill = step(uv.x, uProgress) * barZone;
        float barTrack = barZone * 0.15;
        float edge = smoothstep(0.0, 0.12, uv.x) * smoothstep(1.0, 0.88, uv.x)
                   * smoothstep(0.0, 0.12, uv.y) * smoothstep(1.0, 0.88, uv.y);
        float glow = ink * 0.9 + grid + barTrack + barFill * 1.4;
        glow += 0.06 * sin(uv.y * 60.0 - uTime * 6.0);
        vec3 col = uColor * glow;
        float alpha = glow * edge * uMaterialize;
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

export function createPedestalBaseMaterial(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0x050b07,
    roughness: 0.3,
    metalness: 0.62,
    clearcoat: 0.5,
    clearcoatRoughness: 0.18,
    envMapIntensity: 0.32,
  });
}
