import * as THREE from 'three';
import type { Meta } from './types';

export interface SelectedTile {
  key: string;
  s: number;
  tx: number;
  ty: number;
  children: SelectedTile[];
  score: number;
}
export const tileKey = (s: number, tx: number, ty: number) => `${s}/${tx}_${ty}`;
export interface Selection {
  roots: SelectedTile[];
  leaves: SelectedTile[];
  split: Set<string>;
  estimatedBytes: number;
}

// This is a projected voxel-size heuristic, not a certified geometric-error bound.
export function selectTiles(
  meta: Meta,
  camera: THREE.PerspectiveCamera,
  height: number,
  light: THREE.Vector3,
  previous: Set<string>,
  cost: (key: string, s: number) => number,
  maxLeaves = 384,
  maxBytes = 128 * 1024 * 1024,
  minimumLevel = 1,
): Selection {
  const levels = meta.tiles.levels.map((l) => l.s).filter(s=>s>=minimumLevel).sort((a, b) => b - a),
    N = meta.tiles.N;
  const dims = new Map(meta.tiles.levels.map((l) => [l.s, l]));
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  const box = new THREE.Box3(),
    shadowBox = new THREE.Box3(),
    nearest = new THREE.Vector3();
  const focal = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  const node = (s: number, tx: number, ty: number): SelectedTile => ({
    s,
    tx,
    ty,
    key: tileKey(s, tx, ty),
    children: [],
    score: 0,
  });
  const rootLevel = dims.get(levels[0])!,
    roots: SelectedTile[] = [];
  for (let ty = 0; ty < rootLevel.ny; ty++)
    for (let tx = 0; tx < rootLevel.nx; tx++) roots.push(node(levels[0], tx, ty));
  const score = (n: SelectedTile) => {
    const L = N * n.s;
    box.min.set(n.tx * L, 0, n.ty * L);
    box.max.set(Math.min((n.tx + 1) * L, meta.W), meta.H, Math.min((n.ty + 1) * L, meta.D));
    const distance = Math.max(1, box.clampPoint(camera.position, nearest).distanceTo(camera.position));
    // Keep exact data around the camera even when looking away from it.
    if (distance < 192) return 1e6 / n.s;
    let relevant = frustum.intersectsBox(box),
      shadowDistance = Infinity;
    if (light.y > 0.02) {
      const dx = (-light.x / light.y) * meta.H,
        dz = (-light.z / light.y) * meta.H;
      shadowBox.copy(box);
      shadowBox.min.x += Math.min(0, dx);
      shadowBox.max.x += Math.max(0, dx);
      shadowBox.min.z += Math.min(0, dz);
      shadowBox.max.z += Math.max(0, dz);
      if (frustum.intersectsBox(shadowBox)) {
        relevant = true;
        shadowDistance = shadowBox.clampPoint(camera.position, nearest).distanceTo(camera.position);
      }
    }
    if (!relevant) return 0;
    // Shadow footprint can be closer than the caster; keep refinement conservative.
    return (n.s * focal) / Math.max(1, Math.min(distance, shadowDistance));
  };
  let leaves = [...roots],
    bytes = leaves.reduce((sum, n) => sum + cost(n.key, n.s), 0);
  const split = new Set<string>(),
    candidates = [...roots];
  for (const n of candidates) n.score = score(n);
  while (candidates.length) {
    candidates.sort((a, b) => b.score - a.score);
    const n = candidates.shift()!,
      next = levels[levels.indexOf(n.s) + 1];
    if (!next || n.score <= (previous.has(n.key) ? 1.5 : 2)) continue;
    const d = dims.get(next)!,
      ratio = n.s / next,
      children: SelectedTile[] = [];
    for (let y = 0; y < ratio; y++)
      for (let x = 0; x < ratio; x++) {
        const tx = n.tx * ratio + x,
          ty = n.ty * ratio + y;
        if (tx < d.nx && ty < d.ny) children.push(node(next, tx, ty));
      }
    const delta = children.reduce((sum, c) => sum + cost(c.key, c.s), 0) - cost(n.key, n.s);
    if (leaves.length + children.length - 1 > maxLeaves || bytes + delta > maxBytes) continue;
    for (const c of children) c.score = score(c);
    n.children = children;
    split.add(n.key);
    bytes += delta;
    leaves = leaves.filter((l) => l !== n);
    leaves.push(...children);
    candidates.push(...children);
  }
  return { roots, leaves, split, estimatedBytes: bytes };
}
