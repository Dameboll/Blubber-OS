/**
 * flubber3d/assets — the single source for loading + cloning the Blubber GLB
 * and its baked matcap textures. Extracted from FlubberMesh.tsx (Phase 1 of
 * docs/plans/flubber-3d-everywhere.md) so every consumer (FlubberMesh hero,
 * the FlubberHost instances, verify pages) shares ONE module-level cache:
 * the GLB is fetched/parsed once per session no matter how many Flubbers
 * mount, and each caller gets an independent skeleton-correct clone.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';

export const GLB_URL = '/models/flubber.glb';
export const SKIN_MATCAP_URL = '/models/flubber-matcap.png';
export const EYE_MATCAP_URL = '/models/flubber-matcap-eye.png';
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export interface LoadedModel {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

let cachedGltfPromise: Promise<LoadedModel> | null = null;

export function loadModel(): Promise<LoadedModel> {
  if (!cachedGltfPromise) {
    const loader = new GLTFLoader();
    cachedGltfPromise = loader.loadAsync(GLB_URL).then((gltf) => ({
      scene: gltf.scene,
      animations: gltf.animations,
    }));
  }
  return cachedGltfPromise;
}

export interface MatcapTextures {
  skin: THREE.Texture;
  eye: THREE.Texture;
}

let cachedMatcapPromise: Promise<MatcapTextures> | null = null;

function loadTexture(loader: THREE.TextureLoader, url: string): Promise<THREE.Texture> {
  return loader.loadAsync(url).then((texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  });
}

export function loadMatcaps(): Promise<MatcapTextures> {
  if (!cachedMatcapPromise) {
    const loader = new THREE.TextureLoader();
    cachedMatcapPromise = Promise.all([
      loadTexture(loader, SKIN_MATCAP_URL),
      loadTexture(loader, EYE_MATCAP_URL),
    ]).then(([skin, eye]) => ({ skin, eye }));
  }
  return cachedMatcapPromise;
}

/**
 * A recursive Object3D clone duplicates bones but leaves each SkinnedMesh's
 * Skeleton bound to the source scene — SkeletonUtils.clone rebinds the cloned
 * mesh to its cloned bones so mixer-driven body motion stays visible.
 */
export function cloneBlubber(source: THREE.Group): THREE.Object3D {
  return cloneSkeleton(source);
}
