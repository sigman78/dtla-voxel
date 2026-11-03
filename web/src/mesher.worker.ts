// Fetches, unzips and greedy-meshes one tile (the pipeline's tiles.py format), with baked ambient occlusion.
// Data coordinates: x east, y south, z up. Positions go out in three.js axes (x, z, y), metres.
// A tile is N x N cells of s metres plus a 1-cell apron.

import { decodeTile as decode, compactColumns, type Columns, type RawColumns, type QueryColumns } from './tileData';
export type { Columns, RawColumns } from './tileData';

export interface MeshRequest {
  id: number;
  key: string;
  url: string;
  under?: QueryColumns | string;
  N: number;
  s: number;
  keep: boolean;
}

export type MeshReply =
  | {
      type: 'node';
      id: number;
      key: string;
      data: QueryColumns | null;
      records: Uint16Array;
      bounds: number[];
      quads: number;
    }
  | { type: 'error'; id: number; key: string; error: string };

const post = (msg: MeshReply, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(m: MeshReply, t: Transferable[]): void }).postMessage(msg, transfer);
const controllers = new Map<number, AbortController>();
async function fetchGzip(url: string, signal: AbortSignal) {
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${url}`);
  return new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}
self.onmessage = async (e: MessageEvent<MeshRequest | { cancel: number }>) => {
  if ('cancel' in e.data) {
    controllers.get(e.data.cancel)?.abort();
    return;
  }
  const m = e.data,
    controller = new AbortController();
  controllers.set(m.id, controller);
  try {
    const c = decode(await fetchGzip(m.url, controller.signal), m.N);
    const keep = m.keep ? compactColumns(c) : null;
    const under =
      typeof m.under === 'string'
        ? compactColumns(decode(await fetchGzip(m.under, controller.signal), m.N))
        : (m.under ?? null);
    const out = meshTile(m.N, m.s, 0, 0, c, c.detail, under);
    const transfer: Transferable[] = [out.records.buffer];
    if (keep) transfer.push(keep.off.buffer, keep.ground.buffer, keep.runs.buffer);
    post({ type: 'node', id: m.id, key: m.key, data: keep, ...out }, transfer);
  } catch (err) {
    post({ type: 'error', id: m.id, key: m.key, error: String(err) });
  } finally {
    controllers.delete(m.id);
  }
};

// corner order per quad so that the one shared index pattern (0 1 2, 0 2 3) gives its winding and AO diagonal,
// by [AO diagonal flipped][facing +]
const QUAD_ORDER = [
  [1, 2, 3, 0],
  [1, 0, 3, 2],
  [0, 1, 2, 3],
  [0, 3, 2, 1],
];
const SOLID_BELOW = 65535;
const OCC = 65534; // the base tile under a foliage tile: solid for culling and AO, never meshed

class QuadBuffer {
  private cap = 4096;
  records = new Uint16Array(this.cap * 8);
  count = 0;
  bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];

  quad(
    base: number[],
    s: number,
    x0: number,
    y0: number,
    w: number,
    h: number,
    normal: number,
    ground: number,
    palette: number,
    aos: number[],
    order: number[],
  ) {
    if (this.count / 4 === this.cap) {
      this.cap *= 2;
      const next = new Uint16Array(this.cap * 8);
      next.set(this.records);
      this.records = next;
    }
    const lo = [base[0] * s + x0, base[2] * s, base[1] * s + y0],
      axes = [0, 2, 1],
      d = (normal & 7) >> 1,
      u = axes[(d + 1) % 3],
      v = axes[(d + 2) % 3];
    const width = w * s,
      height = h * s,
      k = this.count * 2;
    let packedAO = 0,
      packedOrder = 0;
    for (let i = 0; i < 4; i++) {
      const c = order[i];
      packedAO |= aos[c] << (i * 2);
      packedOrder |= [0, 1, 3, 2][c] << (i * 2);
    }
    for (let j = 0; j < 3; j++) {
      const hi = lo[j] + (j === u ? width : 0) + (j === v ? height : 0);
      if (lo[j] < 0 || hi > 65535) throw new Error('Quad coordinate overflow');
      this.bounds[j] = Math.min(this.bounds[j], lo[j]);
      this.bounds[j + 3] = Math.max(this.bounds[j + 3], hi);
    }
    this.records.set([...lo, width, height, palette, normal | (ground << 8), packedAO | (packedOrder << 8)], k);
    this.count += 4;
  }
}

function offsetsOf(counts: Uint16Array, n: number) {
  const off = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) off[i + 1] = off[i] + counts[i];
  return off;
}

function topOf(c: RawColumns, off: Uint32Array, n: number) {
  let zmax = 0;
  for (let i = 0; i < n; i++) {
    const k = c.counts[i];
    if (k) {
      const r = (off[i] + k - 1) * 3;
      zmax = Math.max(zmax, c.runs[r] + c.runs[r + 1]);
    }
  }
  return zmax;
}

function meshTile(
  N: number,
  s: number,
  x0: number,
  y0: number,
  cols: Columns,
  detail: Uint16Array,
  under: QueryColumns | null,
) {
  const S = N + 2,
    SS = S * S,
    { ground } = cols;
  const off = offsetsOf(cols.counts, SS);
  let underTop = 0;
  if (under)
    for (let i = 0; i < under.runs.length; i += 2) underTop = Math.max(underTop, under.runs[i] + under.runs[i + 1]);
  const zmax = Math.max(topOf(cols, off, SS), underTop);
  const sz = zmax + 2,
    vol = new Uint16Array(SS * sz);
  const fill = (c: RawColumns, o: Uint32Array, value: (v: number) => number) => {
    for (let i = 0; i < SS; i++)
      for (let k = o[i], e = o[i] + c.counts[i]; k < e; k++) {
        const z0 = c.runs[k * 3],
          len = c.runs[k * 3 + 1],
          v = value(c.runs[k * 3 + 2]);
        for (let z = z0; z < z0 + len; z++) vol[i + SS * (z + 1)] = v;
      }
  };
  if (under)
    for (let i = 0; i < SS; i++)
      for (let k = under.off[i]; k < under.off[i + 1]; k++) {
        const start = under.runs[k * 2],
          end = start + under.runs[k * 2 + 1];
        for (let z = start; z < end; z++) vol[i + SS * (z + 1)] = OCC;
      }
  for (let i = 0; i < SS; i++) vol[i] = SOLID_BELOW; // z = -1 is solid, so the slab's bottom is never meshed
  fill(cols, off, (v) => v);
  const out = new QuadBuffer();
  meshFaces(N, s, x0, y0, vol, sz, ground, out);
  if (detail.length) meshDetail(N, s, x0, y0, detail, ground, out);
  const n = out.count;
  return { records: out.records.slice(0, n * 2), bounds: n ? out.bounds : [0, 0, 0, 0, 0, 0], quads: n / 4 };
}

function meshFaces(
  N: number,
  s: number,
  x0: number,
  y0: number,
  vol: Uint16Array,
  sz: number,
  ground: Uint8Array,
  out: QuadBuffer,
) {
  const S = N + 2,
    sx = S,
    sy = S;
  const dims = [N, N, sz - 2];
  // the tallest column in each row and each column of the slab: slices are scanned only up to it
  const ST = [1, sx, sx * sy],
    colTop = new Uint16Array(S * S);
  for (let c = 0; c < S * S; c++) {
    let z = sz - 1;
    while (z > 0 && vol[c + sx * sy * z] === 0) z--;
    colTop[c] = z;
  }
  const topX = new Uint16Array(S),
    topY = new Uint16Array(S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const t = colTop[x + S * y];
      if (t > topX[x]) topX[x] = t;
      if (t > topY[y]) topY[y] = t;
    }
  const cell = (X: number, Y: number, z: number) => vol[X + 1 + sx * (Y + 1 + sy * (z + 1))];
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3,
      v = (d + 2) % 3,
      nu = dims[u],
      nv = dims[v];
    const mask = new Float64Array(nu * nv);
    const sd = ST[d],
      su = ST[u],
      sv = ST[v];
    for (const dir of [-1, 1]) {
      const normalIdx = d * 2 + (dir > 0 ? 1 : 0);
      for (let sl = 0; sl < dims[d]; sl++) {
        let any = false;
        // faces out through the tile's border are always emitted: the neighbour may not be loaded yet
        const border = d < 2 && ((dir < 0 && sl === 0) || (dir > 0 && sl === N - 1));
        const zt =
          d === 0
            ? Math.max(topX[sl + 1], topX[sl + 1 + dir])
            : d === 1
              ? Math.max(topY[sl + 1], topY[sl + 1 + dir])
              : nv;
        const jn = v === 2 ? Math.min(nv, zt) : nv,
          in_ = u === 2 ? Math.min(nu, zt) : nu;
        if (d === 2) mask.fill(0);
        else for (let j = 0; j < nv; j++) for (let i = j < jn ? in_ : 0; i < nu; i++) mask[i + j * nu] = 0;
        for (let j = 0; j < jn; j++) {
          if (d === 2 && topY[j + 1] <= sl) continue;
          for (let i = 0; i < in_; i++) {
            const idx = (sl + 1) * sd + (i + 1) * su + (j + 1) * sv,
              a = vol[idx];
            let key = 0;
            if (a !== 0 && a !== SOLID_BELOW && a !== OCC) {
              const ni = idx + dir * sd,
                nb = vol[ni];
              if (nb === 0 || (border && nb !== SOLID_BELOW && nb !== OCC)) {
                const px = d === 0 ? sl : u === 0 ? i : j,
                  py = d === 1 ? sl : u === 1 ? i : j;
                const gm = ground[px + 1 + S * (py + 1)];
                const ang = d < 2 && nb === 0 ? wallAngle(N, px, py, d === 0 ? j : i, d, dir, cell) : 0;
                const aob = nb === 0 ? faceAO(vol, ni, su, sv, ang ? d : -1) : 255;
                // < 2^53: ang < 25, palette < 4096
                key = ((ang * 4096 + a) * 256 + aob) * 256 + gm + 1;
                any = true;
              }
            }
            mask[i + j * nu] = key;
          }
        }
        if (any) emitMerged(mask, nu, nv, d, u, v, dir, normalIdx, sl, s, x0, y0, out);
      }
    }
  }
}

// A wall at an angle to the grid is a staircase of x- and y-facing faces; it is lit as the plane it stands for. Its
// direction in plan comes from the occupied cells around it (24 steps of 15°; 0 = the face's own).
function wallAngle(
  N: number,
  px: number,
  py: number,
  cz: number,
  d: number,
  dir: number,
  cell: (x: number, y: number, z: number) => number,
) {
  let gx = 0,
    gy = 0;
  for (let dy = -2; dy <= 2; dy++) {
    const Y = py + dy;
    if (Y < -1 || Y > N) continue;
    for (let dx = -2; dx <= 2; dx++) {
      const X = px + dx;
      if (X < -1 || X > N || (dx === 0 && dy === 0)) continue;
      const o = cell(X, Y, cz);
      if (o !== 0 && o !== OCC) {
        gx -= dx;
        gy -= dy;
      }
    }
  }
  const ax = d === 0 ? dir : 0,
    ay = d === 1 ? dir : 0;
  // a step of a staircase is short both ways along the wall; beside the corner of a straight wall there is a long run
  for (const sgn of [-1, 1]) {
    let k = 1;
    for (; k <= 4; k++) {
      const X = px + (d === 1 ? sgn * k : 0),
        Y = py + (d === 0 ? sgn * k : 0);
      if (X < -1 || X > N || Y < -1 || Y > N) break;
      const o = cell(X, Y, cz);
      if (o === 0 || o === OCC || cell(X + ax, Y + ay, cz) !== 0) break;
    }
    if (k > 4) return 0;
  }
  const gl = Math.hypot(gx, gy);
  return gl >= 3 && (gx * ax + gy * ay) / gl > 0.05
    ? 1 + ((Math.round(Math.atan2(gy, gx) / (Math.PI / 12)) + 24) % 24)
    : 0;
}

// per-corner occlusion, 2 bits each; on a staircase wall (stairAxis >= 0) only what is above or below darkens it
function faceAO(vol: Uint16Array, ni: number, su: number, sv: number, stairAxis: number) {
  const o = (k: number) => (vol[k] !== 0 ? 1 : 0);
  let s10 = o(ni - su),
    s12 = o(ni + su),
    s01 = o(ni - sv),
    s21 = o(ni + sv);
  let c00 = o(ni - su - sv),
    c20 = o(ni + su - sv),
    c22 = o(ni + su + sv),
    c02 = o(ni - su + sv);
  if (stairAxis === 0) {
    s10 = s12 = 0;
    c00 = c20 = c22 = c02 = 0;
  } else if (stairAxis === 1) {
    s01 = s21 = 0;
    c00 = c20 = c22 = c02 = 0;
  }
  const ao = (a1: number, a2: number, c: number) => (a1 && a2 ? 0 : 3 - (a1 + a2 + c));
  return ao(s10, s01, c00) | (ao(s12, s01, c20) << 2) | (ao(s12, s21, c22) << 4) | (ao(s10, s21, c02) << 6);
}

function emitMerged(
  mask: Float64Array,
  nu: number,
  nv: number,
  d: number,
  u: number,
  v: number,
  dir: number,
  normalIdx: number,
  sl: number,
  s: number,
  x0: number,
  y0: number,
  out: QuadBuffer,
) {
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu;) {
      const key = mask[i + j * nu];
      if (!key) {
        i++;
        continue;
      }
      let w = 1;
      while (i + w < nu && mask[i + w + j * nu] === key) w++;
      let h = 1;
      outer: while (j + h < nv) {
        for (let k = 0; k < w; k++) if (mask[i + k + (j + h) * nu] !== key) break outer;
        h++;
      }
      for (let jj = 0; jj < h; jj++) for (let ii = 0; ii < w; ii++) mask[i + ii + (j + jj) * nu] = 0;
      const k1 = key - 1;
      const gm = k1 % 256,
        aoBits = Math.floor(k1 / 256) % 256,
        palIdx = Math.floor(k1 / 65536) % 4096,
        ang = Math.floor(k1 / (65536 * 4096));
      const aos = aoBits === 255 ? [3, 3, 3, 3] : [aoBits & 3, (aoBits >> 2) & 3, (aoBits >> 4) & 3, (aoBits >> 6) & 3];
      const base = [0, 0, 0];
      base[d] = sl + (dir > 0 ? 1 : 0);
      base[u] = i;
      base[v] = j;
      const ord = QUAD_ORDER[(aos[0] + aos[2] < aos[1] + aos[3] ? 2 : 0) + (dir > 0 ? 1 : 0)];
      out.quad(base, s, x0, y0, w, h, normalIdx + 8 * ang, gm, palIdx, aos, ord);
      i += w;
    }
  }
}

// thin structures at true size: vertical runs of one colour become boxes; faces against another detail voxel are culled
function meshDetail(
  N: number,
  s: number,
  x0: number,
  y0: number,
  detail: Uint16Array,
  ground: Uint8Array,
  out: QuadBuffer,
) {
  const S = N + 2;
  const key = (x: number, y: number, z: number) => (z * 2048 + y) * 2048 + x;
  const have = new Set<number>(),
    order: number[] = [];
  for (let k = 0; k < detail.length; k += 4) {
    have.add(key(detail[k], detail[k + 1], detail[k + 2]));
    order.push(k);
  }
  order.sort((a, b) => detail[a] - detail[b] || detail[a + 1] - detail[b + 1] || detail[a + 2] - detail[b + 2]);
  const quad = (d: number, dir: number, base: number[], w: number, h: number, palIdx: number, gm: number) => {
    out.quad(base, 1, x0, y0, w, h, d * 2 + (dir > 0 ? 1 : 0), gm, palIdx, [3, 3, 3, 3], QUAD_ORDER[dir > 0 ? 1 : 0]);
  };
  for (let i = 0; i < order.length;) {
    const k = order[i],
      x = detail[k],
      y = detail[k + 1],
      z0 = detail[k + 2],
      p = detail[k + 3];
    let j = i + 1;
    while (
      j < order.length &&
      detail[order[j]] === x &&
      detail[order[j] + 1] === y &&
      detail[order[j] + 2] === z0 + (j - i) &&
      detail[order[j] + 3] === p
    )
      j++;
    const h = j - i;
    i = j;
    const gm = ground[Math.floor(x / s) + 1 + S * (Math.floor(y / s) + 1)];
    for (const [dx, dy, d, dir] of [
      [-1, 0, 0, -1],
      [1, 0, 0, 1],
      [0, -1, 1, -1],
      [0, 1, 1, 1],
    ]) {
      let covered = true;
      for (let z = z0; z < z0 + h && covered; z++) covered = have.has(key(x + dx, y + dy, z));
      if (covered) continue;
      const base = [x + (dir > 0 && d === 0 ? 1 : 0), y + (dir > 0 && d === 1 ? 1 : 0), z0];
      if (d === 0) quad(0, dir, base, 1, h, p, gm);
      else quad(1, dir, base, h, 1, p, gm);
    }
    if (!have.has(key(x, y, z0 - 1))) quad(2, -1, [x, y, z0], 1, 1, p, gm);
    if (!have.has(key(x, y, z0 + h))) quad(2, 1, [x, y, z0 + h], 1, 1, p, gm);
  }
}
