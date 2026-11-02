import * as THREE from 'three';
import type { Caption } from './caption';
import type { TileStreamer } from './stream';
import type { Meta } from './types';
import { dataTexture, dataUrl, fetchGzip } from './util';
import { makeVoxelMaterial, type VoxelUniforms } from './voxelMaterial';

const T = 128;

// The city at one tile level (1 m on desktops, coarser on phones), shown as it arrives:
//   1. terrain: the bare ground, one small file
//   2. the tiles, those in view first, then nearest to the focus; each one shows (and the terrain under it goes)
//      as soon as it is meshed
//   3. at 1 m, trees and grass, their own tiles (tiles/1f); coarser levels already hold them
export async function installCity({ streamer: S, uniforms, meta, scene, focus, camera, caption, level }: {
  streamer: TileStreamer;
  uniforms: VoxelUniforms;
  meta: Meta;
  scene: THREE.Scene;
  focus: () => THREE.Vector3;
  camera: THREE.Camera;
  caption: Caption;
  level: number;
}) {
  const d = S.dims[level], d1 = S.dims[1], total = d.nx * d.ny, L = T * level, index = (tx: number, ty: number) => ty * d.nx + tx;
  const foliage = level === 1, steps = foliage ? 2 * total : total;
  caption.show('Terrain', 0, steps);
  const terrain = await loadTerrain(meta, scene, d1.nx, d1.ny).catch((e) => { console.warn('terrain', e); return null; });
  document.querySelector('#loading')?.classList.add('hidden');

  const seen = new Uint8Array(total), frustum = new THREE.Frustum(), box = new THREE.Box3(), pm = new THREE.Matrix4();
  const look = () => {
    camera.updateMatrixWorld();
    frustum.setFromProjectionMatrix(pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    for (let ty = 0; ty < d.ny; ty++) for (let tx = 0; tx < d.nx; tx++) {
      box.min.set(tx * L, 0, ty * L); box.max.set((tx + 1) * L, meta.H, (ty + 1) * L);
      seen[index(tx, ty)] = frustum.intersectsBox(box) ? 1 : 0;
    }
  };
  const away = (i: number, f: THREE.Vector3) => Math.hypot((i % d.nx + 0.5) * L - f.x, (Math.floor(i / d.nx) + 0.5) * L - f.z);
  const prio = (i: number, f: THREE.Vector3) => (seen[i] ? 1e5 : 0) - away(i, f);
  look();
  for (let ty = 0; ty < d.ny; ty++) for (let tx = 0; tx < d.nx; tx++) S.request(level, tx, ty, prio(index(tx, ty), focus()), true);
  S.pump();

  const folMat = makeVoxelMaterial(uniforms);
  folMat.polygonOffset = true; folMat.polygonOffsetFactor = -1; folMat.polygonOffsetUnits = -2; // grass wins over the base's bare earth
  const inTile = new Uint8Array(total), counted = new Set<string>();
  let tilesIn = 0, folIn = 0, stage = 1, last = 0;
  const covered = (px: number, py: number) => inTile[index(Math.floor(px / level), Math.floor(py / level))] === 1;

  S.update = () => {
    if (performance.now() - last < 100) return;
    last = performance.now();
    S.retire();
    const f = focus();
    look();
    S.reprioritize((n) => prio(index(n.tx, n.ty), f));
    let fresh = false;
    for (const n of S.nodes.values()) {
      if (n.state !== 'ready' || counted.has(n.key)) continue;
      counted.add(n.key);
      if (n.mesh) n.mesh.visible = true;
      if (n.foliage) { folIn++; if (n.mesh) n.mesh.material = folMat; continue; }
      inTile[index(n.tx, n.ty)] = 1; tilesIn++; fresh = true;
    }
    if (fresh) terrain?.dropUnder(covered);
    if (stage === 1 && tilesIn === total) {
      terrain?.dispose();
      stage = foliage ? 2 : 3;
      if (foliage) for (let ty = 0; ty < d.ny; ty++) for (let tx = 0; tx < d.nx; tx++) S.requestFoliage(tx, ty, prio(index(tx, ty), f));
    }
    if (stage === 2 && folIn === total) stage = 3;
    if (stage === 3) caption.finish(foliage ? 'Trees and grass' : 'City', steps);
    else caption.show(stage === 2 ? 'Trees and grass' : 'City', tilesIn + folIn, steps);
    S.pump();
  };

  return {
    // a label shows once the tile under it is in
    gate: (x: number, z: number) => inTile[index(Math.min(d.nx - 1, Math.floor(x / L)), Math.min(d.ny - 1, Math.floor(z / L)))] === 1,
    get complete() { return stage === 3; },
  };
}

// one terrain piece per 128 m tile (heights every 4 m, ground colours every 2 m), each dropped once the tiles over it
// are in: under the real ground it would flicker through
// terrain.bin, gzip of: uint16[ceil(W/4) * ceil(D/4)] heights in decimetres, then uint8[floor(W/2) * floor(D/2) * 3] sRGB
async function loadTerrain(meta: Meta, scene: THREE.Scene, nx: number, ny: number) {
  const { W, D } = meta, buf = await fetchGzip(dataUrl('terrain.bin'));
  const tw = Math.ceil(W / 4), th = Math.ceil(D / 4), hd = new Uint16Array(buf, 0, tw * th), C = T / 4;
  const cw = Math.floor(W / 2), ch = Math.floor(D / 2), rgb = new Uint8Array(buf, tw * th * 2, cw * ch * 3), rgba = new Uint8Array(cw * ch * 4);
  for (let i = 0; i < cw * ch; i++) { rgba.set(rgb.subarray(3 * i, 3 * i + 3), 4 * i); rgba[4 * i + 3] = 255; }
  const tex = dataTexture(rgba, cw, ch, THREE.RGBAFormat);
  Object.assign(tex, { colorSpace: THREE.SRGBColorSpace, magFilter: THREE.NearestFilter, minFilter: THREE.LinearMipmapLinearFilter, generateMipmaps: true, anisotropy: 8 });
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 });
  const pieces: (THREE.Mesh | null)[] = new Array(nx * ny).fill(null);
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
    const c0 = tx * C, r0 = ty * C, nc = Math.min(C, tw - 1 - c0) + 1, nr = Math.min(C, th - 1 - r0) + 1;
    if (nc < 2 || nr < 2) continue;
    const pos = new Float32Array(nc * nr * 3), uv = new Float32Array(nc * nr * 2), idx = new Uint16Array((nc - 1) * (nr - 1) * 6);
    for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
      const k = r * nc + c;
      pos.set([(c0 + c) * 4, hd[(r0 + r) * tw + c0 + c] / 10, (r0 + r) * 4], k * 3);
      uv.set([(c0 + c) * 2 / cw, (r0 + r) * 2 / ch], k * 2);
    }
    for (let r = 0, k = 0; r < nr - 1; r++) for (let c = 0; c < nc - 1; c++, k += 6) { const i = r * nc + c; idx.set([i, i + nc, i + 1, i + 1, i + nc, i + nc + 1], k); }
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
      pieces.forEach((m, i) => { if (m && covered(i % nx, Math.floor(i / nx))) { scene.remove(m); m.geometry.dispose(); pieces[i] = null; } });
    },
    dispose() { if (tex.image.data) { tex.dispose(); tex.image.data = null as unknown as Uint8Array; } },
  };
}
