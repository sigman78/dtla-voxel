// Differential correctness checks against the pre-feature mesher and query implementation.
// Run from web/: node tools/test-voxel.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import * as THREE from 'three';

const baseline = 'c043114ea9a266e383f61f7ae45611ca365e3919';
const old = (file) => execFileSync('git', ['show', `${baseline}:web/src/${file}`], { encoding: 'utf8' });
const current = (file) => fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const clean = (source) =>
  stripTypeScriptTypes(
    source.replace(
      'constructor(private readonly src: ColumnSource, meta: Meta) {',
      'constructor(src: ColumnSource, meta: Meta) { this.src = src;',
    ),
  )
    .replace(/^import[\s\S]*?;\s*$/gm, '')
    .replace(/^export \{.*?\};?\s*$/gm, '')
    .replace(/^export /gm, '');
const context = vm.createContext({ self: {}, console, AbortController });
vm.runInContext(
  clean(current('tileData.ts')) +
    '\n' +
    clean(current('mesher.worker.ts')) +
    '\nglobalThis.api={decodeTile,compactColumns,expandQuads,meshTile};',
  context,
);
const { decodeTile, compactColumns, expandQuads, meshTile } = context.api;
const reference = vm.createContext({ self: {}, console });
vm.runInContext(clean(old('mesher.worker.ts')) + '\nglobalThis.api={decode,meshTile};', reference);
const dataRoot = new URL('../public/data/', import.meta.url);
const meta = JSON.parse(fs.readFileSync(new URL('meta.json', dataRoot)));
const read = (level, file) => {
  const b = gunzipSync(fs.readFileSync(new URL(`tiles/${level}/${file}`, dataRoot)));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const bytes = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
let intervals = 0,
  tiles = 0;
for (const level of [1, 2, 4, 8]) {
  for (const file of fs.readdirSync(new URL(`tiles/${level}/`, dataRoot))) {
    const buf = read(level, file),
      c = decodeTile(buf, meta.tiles.N),
      q = compactColumns(c);
    assert.equal(c.runs.buffer, buf);
    assert.equal(c.detail.buffer, buf);
    // Reconstruct occupied lengths and gaps independently from original palette runs.
    let source = 0;
    for (let col = 0; col < c.counts.length; col++) {
      let occupied = 0;
      for (let j = 0; j < c.counts[col]; j++, source += 3) {
        const start = c.runs[source],
          end = start + c.runs[source + 1];
        occupied += end - start;
        let k = q.off[col];
        while (k < q.off[col + 1] && q.runs[k * 2] + q.runs[k * 2 + 1] <= start) k++;
        assert(k < q.off[col + 1] && q.runs[k * 2] <= start && q.runs[k * 2] + q.runs[k * 2 + 1] >= end);
      }
      let compactLength = 0;
      for (let k = q.off[col]; k < q.off[col + 1]; k++) {
        compactLength += q.runs[k * 2 + 1];
        if (k > q.off[col]) assert(q.runs[(k - 1) * 2] + q.runs[(k - 1) * 2 + 1] < q.runs[k * 2]);
      }
      assert.equal(compactLength, occupied);
    }
    intervals += q.runs.length / 2;
    tiles++;
  }
}
const samples = JSON.parse(
  fs.readFileSync(new URL('../../artifacts/profiling/voxel-data-audit.json', import.meta.url)),
).samples;
let quads = 0;
for (const sample of samples) {
  const { level, file } = sample,
    s = level === '1f' ? 1 : +level,
    buf = read(level, file);
  const c = decodeTile(buf, 128),
    r = reference.api.decode(buf, 128);
  const base = level === '1f' ? decodeTile(read('1', file), 128) : null;
  const expected = reference.api.meshTile(128, s, 0, 0, r, r.detail, base);
  const result = meshTile(128, s, 0, 0, c, c.detail, base && compactColumns(base));
  const occupancy = compactColumns(c);
  let voxelCount = c.detail.length / 4;
  for (let y = 1; y <= 128; y++) for (let x = 1; x <= 128; x++) {
    const column = y * 130 + x;
    for (let k = occupancy.off[column]; k < occupancy.off[column + 1]; k++) voxelCount += occupancy.runs[k * 2 + 1];
  }
  assert.equal(result.voxels, voxelCount, `Occupied voxel estimate: ${level}/${file}`);
  const expanded = expandQuads(result.records);
  assert.equal(result.quads, expected.quads);
  assert.equal(result.records.byteLength, result.quads * 16);
  assert.deepEqual(bytes(expanded.pos), bytes(expected.pos));
  assert.deepEqual(bytes(expanded.pal), bytes(expected.pal));
  for (let i = 0; i < expected.quads * 4; i++)
    for (let j = 0; j < 3; j++) assert.equal(expanded.attr[i * 3 + j], expected.attr[i * 4 + j]);
  quads += result.quads;
}
const worldContext = vm.createContext({});
vm.runInContext(clean(current('world.ts')) + '\nglobalThis.World=World;', worldContext);
const refWorld = vm.createContext({});
vm.runInContext(clean(old('world.ts')) + '\nglobalThis.World=World;', refWorld);
const columns = new Map(),
  original = new Map();
for (const [tx, ty] of [
  [15, 5],
  [15, 6],
  [14, 5],
  [14, 6],
]) {
  const c = decodeTile(read(1, `${tx}_${ty}.bin`), 128),
    q = compactColumns(c),
    off = new Uint32Array(c.counts.length + 1);
  for (let i = 0; i < c.counts.length; i++) off[i + 1] = off[i] + c.counts[i];
  const common = { s: 1, x0: tx * 128, y0: ty * 128, S: 130 };
  columns.set(`1/${tx}_${ty}`, { ...q, ...common });
  original.set(`1/${tx}_${ty}`, { ...c, off, ...common });
}
const source = (map) => ({ N: 128, levels: [8, 4, 2, 1], version: 0, columns: (key) => map.get(key) });
const world = new worldContext.World(source(columns), meta),
  before = new refWorld.World(source(original), meta);
let seed = 123456;
const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
for (let i = 0; i < 20000; i++) {
  const x = 1792 + rand() * 256,
    z = 640 + rand() * 256,
    y = rand() * 364;
  assert.equal(world.solid(x, z, y), before.solid(x, z, y));
  assert.equal(world.top(x, z), before.top(x, z));
  assert.equal(world.groundAt(x, z), before.groundAt(x, z));
  if (i < 100) {
    const d = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
    assert.equal(world.raycast({ x, y, z }, d, 500), before.raycast({ x, y, z }, d, 500));
  }
}
// Coarse cache must not mask finer data already present elsewhere inside it.
const fine = columns.get('1/15_5'),
  coarse = { ...fine, s: 8, x0: 1024, y0: 0, ground: new Uint8Array(130 ** 2).fill(250) };
const mixed = source(
  new Map([
    ['8/1_0', coarse],
    ['1/15_5', fine],
  ]),
);
const w = new worldContext.World(mixed, meta);
assert.equal(w.groundAt(1100, 100), 250);
assert.equal(w.groundAt(1921, 641), world.groundAt(1921, 641));
mixed.version++;
mixed.columns = (key) => (key === '8/1_0' ? coarse : undefined);
assert.equal(w.groundAt(1921, 641), 250);
// Repeated queries in a coarse or missing finest-cell footprint must not rebuild keys.
let lookups = 0;
const lookup = mixed.columns;
mixed.columns = key => { lookups++; return lookup(key); };
mixed.version++;
w.groundAt(1100,100);w.groundAt(4100,3500);
const warmed = lookups;
for(let i=0;i<1000;i++){w.groundAt(1100,100);w.solid(4100,3500,30);}
assert.equal(lookups,warmed);
mixed.columns = key => key === '1/15_5' ? fine : undefined;
mixed.version++;
assert.equal(w.groundAt(1921,641),world.groundAt(1921,641));

const selectorContext = vm.createContext({ THREE });
vm.runInContext(clean(current('tileSelection.ts')) + '\nglobalThis.select=selectTiles;', selectorContext);
const camera = new THREE.PerspectiveCamera(28, 1.6, 0.5, 30000);
let previous = new Set();
for (const view of Object.values(meta.views)) {
  camera.position.fromArray(view.pos);
  camera.lookAt(new THREE.Vector3(...view.target));
  camera.updateMatrixWorld();
  const selected = selectorContext.select(
    meta,
    camera,
    1000,
    new THREE.Vector3(0.5, 1, 0.5).normalize(),
    previous,
    () => 350000,
    200,
    64 * 1024 ** 2,
  );
  assert(selected.leaves.length <= 200);
  assert(selected.estimatedBytes <= 64 * 1024 ** 2);
  for (let y = 0; y < meta.D; y += 128)
    for (let x = 0; x < meta.W; x += 128) {
      assert.equal(
        selected.leaves.filter(
          (n) =>
            x >= n.tx * n.s * 128 && x < (n.tx + 1) * n.s * 128 && y >= n.ty * n.s * 128 && y < (n.ty + 1) * n.s * 128,
        ).length,
        1,
      );
    }
  previous = selected.split;
}
console.log(
  JSON.stringify({
    tiles,
    intervals,
    quads,
    queryPoints: 20000,
    rays: 100,
    selectorViews: Object.keys(meta.views).length,
    passed: true,
  }),
);
