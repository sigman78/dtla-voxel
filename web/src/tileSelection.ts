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
type Candidate = SelectedTile & { order: number; options: Candidate[] };
const NO_CHILDREN: SelectedTile[] = [];

// Bounded by the metadata's tile count; descriptors never retain voxel/GPU payloads.
function selectionWorkspace(meta: Meta, minimumLevel: number, makeKey = tileKey) {
  const levels = meta.tiles.levels.map(l => l.s).filter(s => s >= minimumLevel).sort((a,b) => b-a);
  const dims = new Map(meta.tiles.levels.map(l => [l.s,l]));
  const grids = new Map<number,Candidate[]>(), nodes: Candidate[] = [];
  for (const s of levels) {
    const d = dims.get(s)!, grid: Candidate[] = [];
    for (let ty=0;ty<d.ny;ty++) for (let tx=0;tx<d.nx;tx++) {
      const n: Candidate = {s,tx,ty,key:makeKey(s,tx,ty),children:NO_CHILDREN,options:[],score:0,order:0};
      grid.push(n); nodes.push(n);
    }
    grids.set(s,grid);
  }
  for (let i=0;i<levels.length-1;i++) {
    const s=levels[i], next=levels[i+1], ratio=s/next, d=dims.get(next)!, grid=grids.get(next)!;
    for (const n of grids.get(s)!) for (let y=0;y<ratio;y++) for (let x=0;x<ratio;x++) {
      const tx=n.tx*ratio+x, ty=n.ty*ratio+y;
      if(tx<d.nx && ty<d.ny) n.options.push(grid[ty*d.nx+tx]);
    }
  }
  return {levels,nodes,roots:grids.get(levels[0])!,leaves:[] as Candidate[],heap:[] as Candidate[],
    frustum:new THREE.Frustum(),matrix:new THREE.Matrix4(),box:new THREE.Box3(),shadowBox:new THREE.Box3(),nearest:new THREE.Vector3()};
}

// The returned selection/tree is borrowed until the next call. Split sets remain
// independent so the preceding result can supply hysteresis without copying it.
export function createTileSelector(meta: Meta, minimumLevel = 1, makeKey = tileKey) {
  const workspace = selectionWorkspace(meta,minimumLevel,makeKey);
  return (camera: THREE.PerspectiveCamera, height: number, light: THREE.Vector3, previous: Set<string>,
    cost: (key:string,s:number)=>number, maxLeaves=384, maxBytes=128*1024*1024) =>
    selectTiles(meta,camera,height,light,previous,cost,maxLeaves,maxBytes,minimumLevel,workspace);
}
const higher = (a: Candidate, b: Candidate) => a.score > b.score || (a.score === b.score && a.order < b.order);
function pushCandidate(heap: Candidate[], node: Candidate) {
  let i = heap.length;
  heap.push(node);
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (!higher(node, heap[parent])) break;
    heap[i] = heap[parent]; i = parent;
  }
  heap[i] = node;
}
function popCandidate(heap: Candidate[]) {
  const first = heap[0], last = heap.pop()!;
  if (heap.length) {
    let i = 0;
    while (i * 2 + 1 < heap.length) {
      let child = i * 2 + 1;
      if (child + 1 < heap.length && higher(heap[child + 1], heap[child])) child++;
      if (!higher(heap[child], last)) break;
      heap[i] = heap[child]; i = child;
    }
    heap[i] = last;
  }
  return first;
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
  workspace = selectionWorkspace(meta, minimumLevel),
): Selection {
  const {levels, roots, frustum, matrix, box, shadowBox, nearest} = workspace, N = meta.tiles.N;
  for (const n of workspace.nodes) n.children = NO_CHILDREN;
  camera.updateMatrixWorld();
  frustum.setFromProjectionMatrix(matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const focal = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  let order = 0;
  for (const n of roots) n.order = order++;
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
  const leaves = workspace.leaves;
  for (let i=0;i<roots.length;i++) leaves[i]=roots[i];
  leaves.length=roots.length;
  let bytes = leaves.reduce((sum, n) => sum + cost(n.key, n.s), 0);
  const split = new Set<string>(),
    candidates = workspace.heap;
  candidates.length=0;
  for (const n of roots) { n.score = score(n); pushCandidate(candidates, n); }
  while (candidates.length) {
    // The heap preserves insertion order for ties without repeated sort scratch arrays.
    const n = popCandidate(candidates),
      next = levels[levels.indexOf(n.s) + 1];
    if (!next || n.score <= (previous.has(n.key) ? 1.5 : 2)) continue;
    const children = n.options;
    for (const c of children) c.order = order++;
    const delta = children.reduce((sum, c) => sum + cost(c.key, c.s), 0) - cost(n.key, n.s);
    if (leaves.length + children.length - 1 > maxLeaves || bytes + delta > maxBytes) continue;
    for (const c of children) c.score = score(c);
    n.children = children;
    split.add(n.key);
    bytes += delta;
    const index = leaves.indexOf(n);
    for (let i = index + 1; i < leaves.length; i++) leaves[i - 1] = leaves[i];
    leaves.length--;
    leaves.push(...children);
    for (const child of children) pushCandidate(candidates, child);
  }
  return { roots, leaves, split, estimatedBytes: bytes };
}
