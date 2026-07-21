/**
 * flubber3d/workstation — a low-poly procedural "workstation" that composes
 * into a mid-tier Blubber's scene: a desk, a hinged laptop, floating
 * holographic code screens, and a glowing pedestal ring. Each active agent
 * gets its own little 3D room (see the game-dev design in the Agents rebuild).
 *
 * Shared geometry/material singletons keep 5 workstations near the GPU-upload
 * cost of one. Geometry is authored in UNIT body space (body height = 1, feet
 * at y=0) then scaled per-instance to the measured bodyBox, so all workstations
 * share ONE geometry upload. ~124 tris + 3 draw calls per workstation, no
 * texture fetches (holo screens animate off uTime). Never built for micro tier.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createHoloMaterial, createPedestalRingMaterial } from './materials';

// ── shared singletons (built once, reused by every workstation) ──────────────
let furnitureGeo: THREE.BufferGeometry | null = null;
let holoGeo: THREE.BufferGeometry | null = null;
let ringGeo: THREE.RingGeometry | null = null;

function ensureFurnitureGeo(): THREE.BufferGeometry {
  if (furnitureGeo) return furnitureGeo;
  const parts: THREE.BufferGeometry[] = [];

  const desk = new THREE.BoxGeometry(1.5, 0.06, 0.7);
  desk.translate(0, 0.34, 0.85);
  parts.push(desk);

  const base = new THREE.BoxGeometry(0.5, 0.03, 0.34);
  base.translate(0, 0.375, 0.86);
  parts.push(base);

  const lid = new THREE.BoxGeometry(0.5, 0.32, 0.025);
  lid.rotateX(-0.42);
  lid.translate(0, 0.53, 0.72);
  parts.push(lid);

  furnitureGeo = mergeGeometries(parts, false)!;
  parts.forEach((g) => g.dispose());
  return furnitureGeo;
}

function ensureHoloGeo(): THREE.BufferGeometry {
  if (holoGeo) return holoGeo;
  const parts: THREE.BufferGeometry[] = [];
  const specs: { w: number; h: number; pos: [number, number, number]; rotY: number; panel: number }[] = [
    { w: 0.62, h: 0.42, pos: [-0.95, 0.95, 0.15], rotY: 0.5, panel: 0 },
    { w: 0.7, h: 0.5, pos: [0.0, 1.18, -0.2], rotY: 0.0, panel: 1 },
    { w: 0.62, h: 0.42, pos: [0.95, 0.95, 0.15], rotY: -0.5, panel: 2 },
    { w: 0.46, h: 0.3, pos: [0.0, 0.55, 0.71], rotY: 0.0, panel: 3 },
  ];
  for (const s of specs) {
    const q = new THREE.PlaneGeometry(s.w, s.h);
    q.rotateY(s.rotY);
    q.translate(s.pos[0], s.pos[1], s.pos[2]);
    const n = q.attributes.position.count;
    q.setAttribute('aPanel', new THREE.BufferAttribute(new Float32Array(n).fill(s.panel), 1));
    parts.push(q);
  }
  holoGeo = mergeGeometries(parts, false)!;
  parts.forEach((g) => g.dispose());
  return holoGeo;
}

function furnitureMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x0a140d,
    roughness: 0.5,
    metalness: 0.4,
    emissive: 0x0c3a18,
    emissiveIntensity: 0.25,
  });
}

export interface Workstation {
  group: THREE.Group;
  update(dt: number, nowS: number, working: boolean): void;
  /** 0 = not spawned (invisible), 1 = fully materialized. */
  setMaterialize(m: number): void;
  /** 0..1 fills the holo progress bar. */
  setProgress(p: number): void;
  dispose(): void;
}

export function buildWorkstation(bodyBox: THREE.Box3): Workstation {
  const size = bodyBox.getSize(new THREE.Vector3());
  const center = bodyBox.getCenter(new THREE.Vector3());
  const h = size.y;

  const group = new THREE.Group();
  group.scale.setScalar(h);
  group.position.set(center.x, bodyBox.min.y, center.z);

  const furnitureMat = furnitureMaterial();
  const furniture = new THREE.Mesh(ensureFurnitureGeo(), furnitureMat);

  const holoMat = createHoloMaterial();
  const holo = new THREE.Mesh(ensureHoloGeo(), holoMat);
  holo.renderOrder = 3;

  if (!ringGeo) ringGeo = new THREE.RingGeometry(0.55, 0.72, 40);
  const ringMat = createPedestalRingMaterial();
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;

  group.add(furniture, holo, ring);

  const setMaterialize = (m: number) => {
    const mat = THREE.MathUtils.clamp(m, 0, 1);
    const s = 0.001 + mat;
    furniture.scale.setScalar(s);
    ring.scale.setScalar(THREE.MathUtils.lerp(0.2, 1, mat));
    holoMat.uniforms.uMaterialize.value = mat;
    group.visible = mat > 0.001;
  };
  setMaterialize(0);

  return {
    group,
    update(_dt, nowS, working) {
      holoMat.uniforms.uTime.value = nowS;
      holoMat.uniforms.uWorking.value = working ? 1 : 0;
      ringMat.uniforms.uTime.value = nowS;
    },
    setMaterialize,
    setProgress: (p) => {
      holoMat.uniforms.uProgress.value = THREE.MathUtils.clamp(p, 0, 1);
    },
    dispose() {
      holoMat.dispose();
      ringMat.dispose();
      furnitureMat.dispose();
      // shared geometry singletons are NOT disposed (reused across instances).
    },
  };
}
