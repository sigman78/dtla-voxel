import type * as THREE from 'three';
import type { ColumnData, Meta } from './types';

export interface ColumnSource {
  N: number;
  levels: number[];
  version: number;
  columns(key: string): ColumnData | undefined;
}

type Point = { x: number; y: number; z: number };

// Voxel queries over whatever is loaded, each cell answered by the finest loaded tile covering it.
// Arguments are data coordinates: x east, r (row) south, z up, in metres; three.js has them as (x, z, r).
export class World {
  readonly W: number;
  readonly D: number;
  hitAxis = 0;
  private readonly ceil: number;
  private readonly cache: (ColumnData | null | undefined)[];
  private readonly cacheSize: number;
  private readonly cacheWidth: number;
  private columnIndex = 0;
  private cacheVersion = -1;

  constructor(private readonly src: ColumnSource, meta: Meta) {
    this.W = meta.W;
    this.D = meta.D;
    this.ceil = meta.H + 1; // nothing solid above the volume's height
    this.cacheSize = src.N * src.levels[src.levels.length - 1];
    this.cacheWidth = Math.ceil(meta.W / this.cacheSize);
    this.cache = new Array(this.cacheWidth * Math.ceil(meta.D / this.cacheSize));
  }

  inside(x: number, r: number) { return x >= 0 && r >= 0 && x < this.W && r < this.D; }

  private node(x: number, r: number): ColumnData | null {
    const { src } = this;
    if (this.cacheVersion !== src.version) {
      this.cache.fill(undefined);
      this.cacheVersion = src.version;
    }
    // Cache by the finest tile footprint, so coarse results cannot mask a neighboring
    // fine tile. Version changes invalidate missing tiles as well as resident data.
    const index = Math.floor(x / this.cacheSize) + this.cacheWidth * Math.floor(r / this.cacheSize);
    const cached = this.cache[index];
    if (cached !== undefined) return cached;
    for (let i = src.levels.length - 1; i >= 0; i--) {
      const s = src.levels[i], L = src.N * s, d = src.columns(`${s}/${Math.floor(x / L)}_${Math.floor(r / L)}`);
      if (d) { this.cache[index] = d; return d; }
    }
    this.cache[index] = null;
    return null;
  }

  private column(x: number, r: number): ColumnData | null {
    if (!this.inside(x, r)) return null;
    const n = this.node(x, r);
    if (n) this.columnIndex = Math.floor((x - n.x0) / n.s) + 1 + n.S * (Math.floor((r - n.y0) / n.s) + 1);
    return n;
  }

  groundAt(x: number, r: number) {
    const c = this.column(x, r);
    return c ? c.ground[this.columnIndex] : 0;
  }

  solid(x: number, r: number, z: number) {
    const c = this.column(x, r);
    if (!c) return z < 0;
    const n = c, i = this.columnIndex, zc = Math.floor(z / n.s), R = n.runs;
    if (zc < 0) return true;
    for (let k = n.off[i], e = n.off[i + 1]; k < e; k++) {
      const z0 = R[k * 2];
      if (zc < z0) return false;
      if (zc < z0 + R[k * 2 + 1]) return true;
    }
    return false;
  }

  top(x: number, r: number) {
    const c = this.column(x, r);
    if (!c) return 0;
    const n = c, i = this.columnIndex, k = n.off[i + 1] - 1;
    return k < n.off[i] ? n.ground[i] : (n.runs[k * 2] + n.runs[k * 2 + 1]) * n.s;
  }

  // distance along d (unit, three.js axes) to the first solid voxel; sets hitAxis
  raycast(o: Point | THREE.Vector3, d: Point | THREE.Vector3, maxDist = 4000) {
    let x = Math.floor(o.x), y = Math.floor(o.y), z = Math.floor(o.z);
    const sx = Math.sign(d.x), sy = Math.sign(d.y), sz = Math.sign(d.z);
    const tdx = sx ? Math.abs(1 / d.x) : Infinity, tdy = sy ? Math.abs(1 / d.y) : Infinity, tdz = sz ? Math.abs(1 / d.z) : Infinity;
    let tx = sx ? (sx > 0 ? x + 1 - o.x : o.x - x) * tdx : Infinity;
    let ty = sy ? (sy > 0 ? y + 1 - o.y : o.y - y) * tdy : Infinity;
    let tz = sz ? (sz > 0 ? z + 1 - o.z : o.z - z) * tdz : Infinity;
    let t = 0;
    for (let i = 0; i < 20000 && t < maxDist; i++) {
      if (y < 0) { this.hitAxis = 1; return t; }
      if (y < this.ceil && this.solid(x, z, y)) return t;
      if (y > this.ceil && sy >= 0) return Infinity;
      if (tx < ty && tx < tz) { t = tx; x += sx; tx += tdx; this.hitAxis = 0; }
      else if (ty < tz) { t = ty; y += sy; ty += tdy; this.hitAxis = 1; }
      else { t = tz; z += sz; tz += tdz; this.hitAxis = 2; }
    }
    return Infinity;
  }
}
