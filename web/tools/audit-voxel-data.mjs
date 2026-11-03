// Read-only inventory and deterministic sample meshing of the current exported dataset.
// From web/: node tools/audit-voxel-data.mjs [output.json]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../public/data');
const meta = JSON.parse(fs.readFileSync(path.join(root, 'meta.json')));
// Preserve the research comparison after the production worker switches to compact quads.
const mesherRevision = 'c043114ea9a266e383f61f7ae45611ca365e3919';
const source = execFileSync('git', ['show', `${mesherRevision}:web/src/mesher.worker.ts`], { encoding: 'utf8' });
const context = vm.createContext({ self: {}, console });
vm.runInContext(stripTypeScriptTypes(source).replace(/^export /gm, '') + '\nglobalThis.audit = { decode, meshTile };', context);
const { decode, meshTile } = context.audit;
const hash = createHash('sha256');
const report = { date: new Date().toISOString(), revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  mesherRevision, node: process.version, dimensions: [meta.W, meta.D, meta.H], N: meta.tiles.N, levels: {}, samples: [],
  note: 'Current working-tree data; Node CPU timings are descriptive, not browser/GPU benchmarks. gzip mesh uses three concatenated attribute arrays, no indices.' };
const S = meta.tiles.N + 2, cells = S * S;
const data = new Map();
for (const level of ['1', '1f', '2', '4', '8']) {
  const dir = path.join(root, 'tiles', level);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.bin')).sort();
  const sum = { files: files.length, gzipBytes: 0, rawBytes: 0, runs: 0, detailVoxels: 0, retainedBytes: 0, occupancyMergedRuns: 0, emptyFiles: 0, maxZCells: 0 };
  const rows = [];
  for (const file of files) {
    const packed = fs.readFileSync(path.join(dir, file));
    hash.update(level + '/' + file); hash.update(packed);
    const raw = gunzipSync(packed);
    const c = decode(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), meta.tiles.N);
    let merged = 0, k = 0, zmax = 0;
    for (const count of c.counts) {
      let end = -1;
      for (let j = 0; j < count; j++, k++) {
        const z = c.runs[k * 3], len = c.runs[k * 3 + 1];
        if (z !== end) merged++;
        end = z + len; zmax = Math.max(zmax, end);
      }
    }
    sum.gzipBytes += packed.length; sum.rawBytes += raw.length; sum.runs += k;
    sum.detailVoxels += c.detail.length / 4; sum.occupancyMergedRuns += merged;
    sum.retainedBytes += cells * 3 + c.runs.byteLength + (cells + 1) * 4;
    if (!k && !c.detail.length) sum.emptyFiles++;
    sum.maxZCells = Math.max(sum.maxZCells, zmax);
    rows.push({ file, bytes: packed.length, zmax });
  }
  sum.occupancyOnlyBytes = (cells + 1) * 4 * files.length + cells * files.length + sum.occupancyMergedRuns * 4;
  report.levels[level] = sum;
  data.set(level, rows);
}
report.datasetSha256 = hash.digest('hex');
const read = (level, file) => {
  const raw = gunzipSync(fs.readFileSync(path.join(root, 'tiles', level, file)));
  return decode(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), meta.tiles.N);
};
const top = c => { let z = 0; for (let i = 0; i < c.runs.length; i += 3) z = Math.max(z, c.runs[i] + c.runs[i+1]); return z; };
// Experimental 16-byte quad codec; verify every reconstructed position and used attribute.
// The unused per-vertex scale byte is intentionally omitted. No runtime codec is installed.
function quadRecords(mesh, origin) {
  const buf = Buffer.alloc(mesh.quads * 16), axis = [0, 2, 1];
  for (let q = 0; q < mesh.quads; q++) {
    const b = q * 16, vertex = q * 4, normal = mesh.attr[vertex * 4];
    const d = Math.floor((normal % 8) / 2), u = axis[(d + 1) % 3], v = axis[(d + 2) % 3];
    const points = Array.from({length:4}, (_,i) => Array.from(mesh.pos.subarray((vertex+i)*3,(vertex+i+1)*3), (p,j) => p-origin[j]));
    const lo = [0,1,2].map(j=>Math.min(...points.map(p=>p[j])));
    const hi = [0,1,2].map(j=>Math.max(...points.map(p=>p[j])));
    [...lo,hi[u]-lo[u],hi[v]-lo[v],mesh.pal[vertex]].forEach((n,i)=>buf.writeUInt16LE(n,b+i*2));
    buf[b+12]=normal; buf[b+13]=mesh.attr[vertex*4+2];
    for (let i=0;i<4;i++) {
      const corner = (points[i][v]===hi[v] ? 2 : 0) + (points[i][u]===hi[u] ? 1 : 0);
      buf[b+14] |= mesh.attr[(vertex+i)*4+1] << (i*2);
      buf[b+15] |= corner << (i*2);
    }
    for (let i=0;i<4;i++) {
      const corner=(buf[b+15]>>(i*2))&3;
      const point=[0,1,2].map(j=>buf.readUInt16LE(b+j*2));
      point[u] += (corner&1) ? buf.readUInt16LE(b+6) : 0;
      point[v] += (corner&2) ? buf.readUInt16LE(b+8) : 0;
      const valid=point.every((p,j)=>p+origin[j]===mesh.pos[(vertex+i)*3+j])
        && buf[b+12]===mesh.attr[(vertex+i)*4]
        && ((buf[b+14]>>(i*2))&3)===mesh.attr[(vertex+i)*4+1]
        && buf[b+13]===mesh.attr[(vertex+i)*4+2]
        && buf.readUInt16LE(b+10)===mesh.pal[vertex+i];
      if (!valid) throw new Error(`Quad round-trip failed at ${q}/${i}`);
    }
  }
  return buf;
}
for (const [level, rows] of data) {
  rows.sort((a,b) => a.bytes-b.bytes);
  // Include largest compressed tile, median, and tallest; deduplicate.
  const chosen = new Map([rows[Math.floor(rows.length / 2)], rows.at(-1), [...rows].sort((a,b)=>b.zmax-a.zmax)[0]].map(r=>[r.file,r]));
  for (const row of chosen.values()) {
    const s = level === '1f' ? 1 : +level;
    const [tx,ty] = row.file.replace('.bin','').split('_').map(Number);
    const c = read(level, row.file), under = level === '1f' ? read('1',row.file) : null;
    const start = performance.now();
    const mesh = meshTile(meta.tiles.N,s,tx*meta.tiles.N*s,ty*meta.tiles.N*s,c,c.detail,under);
    const ms = performance.now()-start;
    const packed = Buffer.concat([mesh.pos,mesh.attr,mesh.pal].map(a=>Buffer.from(a.buffer,a.byteOffset,a.byteLength)));
    const records = quadRecords(mesh, [tx*meta.tiles.N*s,0,ty*meta.tiles.N*s]);
    report.samples.push({ level, file:row.file, inputGzipBytes:row.bytes, quads:mesh.quads, meshBytes:packed.length,
      meshGzipBytes:gzipSync(packed,{level:9}).length, meshMs:ms,
      quadRecordBytes:records.length, quadRecordGzipBytes:gzipSync(records,{level:9}).length, quadRoundTripPassed:true,
      denseVolumeBytes:cells*(Math.max(row.zmax,under ? top(under) : 0)+2)*2 });
  }
}
const out = path.resolve(process.argv[2] || '../artifacts/profiling/voxel-data-audit.json');
fs.mkdirSync(path.dirname(out), {recursive:true}); fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
