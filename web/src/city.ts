import * as THREE from 'three';
import type { Caption } from './caption';
import type { TileStreamer } from './stream';
import type { Meta } from './types';
import { dataTexture, dataUrl, fetchGzip } from './util';
import { makeVoxelMaterial, type VoxelUniforms } from './voxelMaterial';
import { selectTiles, type SelectedTile, type Selection } from './tileSelection';

const T = 128;
export async function installCity({
  streamer: S,
  uniforms,
  meta,
  scene,
  focus,
  camera,
  caption,
  level,
  onCastersChanged,
  light,
  height,
  minimumLevel = 1,
}: {
  streamer: TileStreamer;
  uniforms: VoxelUniforms;
  meta: Meta;
  scene: THREE.Scene;
  focus: () => THREE.Vector3;
  camera: THREE.PerspectiveCamera;
  caption: Caption;
  level: number;
  onCastersChanged: () => void;
  light: () => THREE.Vector3;
  height: () => number;
  minimumLevel?: number;
}) {
  const d1 = S.dims[1];
  caption.show('Terrain', 0, 1);
  const terrain = await loadTerrain(meta, scene, d1.nx, d1.ny).catch((e) => {
    console.warn('terrain', e);
    return null;
  });
  document.querySelector('#loading')?.classList.add('hidden');
  const foliageMaterial = makeVoxelMaterial(uniforms, S.packed);
  foliageMaterial.polygonOffset = true;
  foliageMaterial.polygonOffsetFactor = -1;
  foliageMaterial.polygonOffsetUnits = -2;
  S.setFoliageMaterial(foliageMaterial);
  let selection: Selection,
    previous = new Set<string>(),
    active = new Set<string>();
  let last = 0,
    lastRevision = -1,
    complete = false,
    terrainGone = false;
  const view = new THREE.Matrix4(),
    projection = new THREE.Matrix4();
  let lastHeight = 0,
    lastLight = new THREE.Vector3(),
    pressure = 1;
  const cost = (key: string, s: number) => {
    const n = S.nodes.get(key),
      f = s === 1 ? S.nodes.get(key.replace('1/', 'f/')) : null;
    return n?.state === 'ready' ? n.meshBytes + n.queryBytes + (s === 1 ? (f?.meshBytes ?? 80000) : 0) : 350000;
  };
  const desired = new Set<string>();
  const keep = new Set<string>();
  let nextActive = new Set<string>();
  // One byte per finest-grid cell for label/light gating, avoiding key strings every frame.
  const rootScale = S.levels[0], cellSize = S.N * S.levels[S.levels.length - 1];
  const levelWidth = S.dims[rootScale].nx * rootScale * S.N / cellSize;
  const levelHeight = S.dims[rootScale].ny * rootScale * S.N / cellSize;
  const activeLevels = new Uint8Array(levelWidth * levelHeight);
  const fixed = () => {
    const d = S.dims[level],
      roots: SelectedTile[] = [];
    for (let ty = 0; ty < d.ny; ty++)
      for (let tx = 0; tx < d.nx; tx++)
        roots.push({ s: level, tx, ty, key: S.key(level, tx, ty), children: [], score: 0 });
    return { roots, leaves: roots, split: new Set<string>(), estimatedBytes: 0 };
  };
  const ready = (n: SelectedTile) =>
    S.nodes.get(n.key)?.state === 'ready' && (n.s !== 1 || S.nodes.get(`f/${n.tx}_${n.ty}`)?.state === 'ready');
  const covered = (n: SelectedTile): boolean => (n.children.length ? n.children.every(covered) || ready(n) : ready(n));
  const choose = (n: SelectedTile, out: Set<string>) => {
    if (n.children.length && n.children.every(covered)) for (const c of n.children) choose(c, out);
    else if (ready(n)) {
      out.add(n.key);
      if (n.s === 1) out.add(`f/${n.tx}_${n.ty}`);
    }
  };
  S.update = () => {
    const now = performance.now();
    if (now - last < 100) return;
    last = now;
    S.retire();
    camera.updateMatrixWorld();
    const direction = light(),
      h = height();
    const changed =
      !view.equals(camera.matrixWorld) ||
      !projection.equals(camera.projectionMatrix) ||
      h !== lastHeight ||
      direction.distanceToSquared(lastLight) > 1e-8;
    const budget = (minimumLevel > 1 ? 96 : 192) * 1024 * 1024;
    const overBudget = !level && S.memory.total > budget;
    if (overBudget) pressure = Math.min(4, pressure * 1.15);
    if (!selection || changed || overBudget) {
      selection = level ? fixed() : selectTiles(meta, camera, h / pressure, direction, previous, cost,
        minimumLevel > 1 ? 192 : 384, (minimumLevel > 1 ? 64 : 128) * 1024 * 1024, minimumLevel);
      previous = selection.split;
      view.copy(camera.matrixWorld);
      projection.copy(camera.projectionMatrix);
      lastHeight = h;
      lastLight.copy(direction);
      desired.clear();
      const mark = (n: SelectedTile) => {
        desired.add(n.key);
        if (n.s === 1) desired.add(`f/${n.tx}_${n.ty}`);
        n.children.forEach(mark);
      };
      selection.roots.forEach(mark);
      lastRevision = -1;
    }
    // Failed desired requests are retried with the streamer's bounded backoff.
    let retry = false;
    for (const k of desired) {
      const n = S.nodes.get(k);
      if (n?.state === 'failed' && now >= n.retryAt) { retry = true; break; }
    }
    if (lastRevision === S.revision && !changed && !retry && complete) {
      if (!level) S.trim(desired);
      return;
    }
    const f = focus();
    const request = (n: SelectedTile, depth: number) => {
      const L = n.s * S.N,
        dist = Math.hypot((n.tx + 0.5) * L - f.x, (n.ty + 0.5) * L - f.z);
      S.request(n.s, n.tx, n.ty, 1e6 - depth * 1e5 - dist, true);
      if (n.s === 1 && S.nodes.get(n.key)?.state === 'ready')
        S.requestFoliage(n.tx, n.ty, 1e6 - depth * 1e5 - dist + 1);
      n.children.forEach((c) => request(c, depth + 1));
    };
    selection.roots.forEach((n) => request(n, 0));
    const next = nextActive;
    next.clear();
    selection.roots.forEach((n) => choose(n, next));
    let visibilityChanged = false;
    for (const n of S.nodes.values())
      if (n.mesh) {
        const show = next.has(n.key);
        if (n.mesh.visible !== show) {
          n.mesh.visible = show;
          visibilityChanged = true;
        }
      }
    nextActive = active;
    active = next;
    activeLevels.fill(0);
    for (const key of active) {
      const n = S.nodes.get(key)!;
      if (n.foliage) continue;
      const span = n.s * S.N / cellSize, x0 = n.tx * span, y0 = n.ty * span;
      for (let y = y0; y < y0 + span; y++) activeLevels.fill(n.s, y * levelWidth + x0, y * levelWidth + x0 + span);
    }
    if (visibilityChanged) onCastersChanged();
    if (!terrainGone) {
      terrain?.dropUnder((tx, ty) => {
        for (const key of active) {
          const n = S.nodes.get(key)!;
          if (!n.foliage && tx >= n.tx * n.s && tx < (n.tx + 1) * n.s && ty >= n.ty * n.s && ty < (n.ty + 1) * n.s) return true;
        }
        return false;
      });
      if (selection.roots.every(covered)) {
        terrain?.dispose();
        terrainGone = true;
      }
    }
    complete = selection.leaves.every(ready);
    let done = 0;
    for (const leaf of selection.leaves) if (ready(leaf)) done++;
    if (complete) caption.finish('Current view', selection.leaves.length);
    else caption.show('City', done, selection.leaves.length);
    if (!level) {
      keep.clear();
      for (const key of desired) keep.add(key);
      for (const key of active) keep.add(key);
      S.trim(keep, budget);
    }
    S.pump();
    lastRevision = S.revision;
  };
  S.update(camera);
  const levelAt = (x: number, z: number) => {
    const tx = Math.floor(x / cellSize), ty = Math.floor(z / cellSize);
    return tx >= 0 && ty >= 0 && tx < levelWidth && ty < levelHeight ? activeLevels[ty * levelWidth + tx] : 0;
  };
  return {
    gate: (x: number, z: number) => levelAt(x, z) > 0,
    levelAt,
    get complete() {
      return complete;
    },
    get selection() {
      return {
        leaves: selection.leaves.map((n) => n.key),
        active: [...active],
        estimatedBytes: selection.estimatedBytes,
        pressure,
      };
    },
  };
}

// one terrain piece per 128 m tile (heights every 4 m, ground colours every 2 m), each dropped once the tiles over it
// are in: under the real ground it would flicker through
// terrain.bin, gzip of: uint16[ceil(W/4) * ceil(D/4)] heights in decimetres, then uint8[floor(W/2) * floor(D/2) * 3] sRGB
async function loadTerrain(meta: Meta, scene: THREE.Scene, nx: number, ny: number) {
  const { W, D } = meta,
    buf = await fetchGzip(dataUrl('terrain.bin'));
  const tw = Math.ceil(W / 4),
    th = Math.ceil(D / 4),
    hd = new Uint16Array(buf, 0, tw * th),
    C = T / 4;
  const cw = Math.floor(W / 2),
    ch = Math.floor(D / 2),
    rgb = new Uint8Array(buf, tw * th * 2, cw * ch * 3),
    rgba = new Uint8Array(cw * ch * 4);
  for (let i = 0; i < cw * ch; i++) {
    rgba.set(rgb.subarray(3 * i, 3 * i + 3), 4 * i);
    rgba[4 * i + 3] = 255;
  }
  const tex = dataTexture(rgba, cw, ch, THREE.RGBAFormat);
  Object.assign(tex, {
    colorSpace: THREE.SRGBColorSpace,
    magFilter: THREE.NearestFilter,
    minFilter: THREE.LinearMipmapLinearFilter,
    generateMipmaps: true,
    anisotropy: 8,
  });
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 });
  const pieces: (THREE.Mesh | null)[] = new Array(nx * ny).fill(null);
  for (let ty = 0; ty < ny; ty++)
    for (let tx = 0; tx < nx; tx++) {
      const c0 = tx * C,
        r0 = ty * C,
        nc = Math.min(C, tw - 1 - c0) + 1,
        nr = Math.min(C, th - 1 - r0) + 1;
      if (nc < 2 || nr < 2) continue;
      const pos = new Float32Array(nc * nr * 3),
        uv = new Float32Array(nc * nr * 2),
        idx = new Uint16Array((nc - 1) * (nr - 1) * 6);
      for (let r = 0; r < nr; r++)
        for (let c = 0; c < nc; c++) {
          const k = r * nc + c;
          pos.set([(c0 + c) * 4, hd[(r0 + r) * tw + c0 + c] / 10, (r0 + r) * 4], k * 3);
          uv.set([((c0 + c) * 2) / cw, ((r0 + r) * 2) / ch], k * 2);
        }
      for (let r = 0, k = 0; r < nr - 1; r++)
        for (let c = 0; c < nc - 1; c++, k += 6) {
          const i = r * nc + c;
          idx.set([i, i + nc, i + 1, i + 1, i + nc, i + nc + 1], k);
        }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      scene.add(m);
      pieces[ty * nx + tx] = m;
    }
  return {
    dropUnder(covered: (tx: number, ty: number) => boolean) {
      pieces.forEach((m, i) => {
        if (m && covered(i % nx, Math.floor(i / nx))) {
          scene.remove(m);
          m.geometry.dispose();
          pieces[i] = null;
        }
      });
    },
    dispose() {
      if (tex.image.data) {
        tex.dispose();
        tex.image.data = null as unknown as Uint8Array;
      }
    },
  };
}
