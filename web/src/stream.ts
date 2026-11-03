import * as THREE from 'three';
import type { ColumnData, Meta, TileLevel } from './types';
import type { MeshRequest, MeshReply } from './mesher.worker';
import { dataUrl } from './util';
import { World, type ColumnSource } from './world';
import { geometryBytes, makeQuadDepthMaterial, makeQuadGeometry } from './quadGeometry';
import { MAT } from './voxelMaterial';

export interface TileNode {
  key: string;
  s: number;
  tx: number;
  ty: number;
  foliage: boolean;
  state: 'queued' | 'loading' | 'ready' | 'failed';
  mesh?: THREE.Mesh;
  data?: ColumnData;
  empty?: boolean;
  ready: Promise<void>;
  resolve: () => void;
  id: number;
  prio: number;
  touched: number;
  retryAt: number;
  attempts: number;
  meshBytes: number;
  queryBytes: number;
  voxels: number;
  waterBounds?: THREE.Box3;
}
interface Pooled {
  worker: Worker;
  busy: number;
  idle: number;
}

export class TileStreamer implements ColumnSource {
  readonly N: number;
  readonly levels: number[];
  readonly dims: Record<number, TileLevel>;
  readonly nodes = new Map<string, TileNode>();
  readonly group = new THREE.Group();
  readonly world: World;
  readonly packed: boolean;
  version = 0;
  revision = 0;
  update: (camera: THREE.Camera) => void = () => {};
  private queue: TileNode[] = [];
  private inflight = 0;
  private debugMaterials: Map<number, THREE.Material> | null = null;
  private foliageMaterial: THREE.Material | null = null;
  private debugFoliageMaterial: THREE.Material | null = null;
  private nextId = 1;
  private readonly trimCandidates: TileNode[] = [];
  private readonly tileKeys: Record<number, string[]> = {};
  private readonly foliageKeys: string[] = [];
  private readonly maxWorkers = Math.min(Math.max(1, (navigator.hardwareConcurrency || 4) - 2), 4);
  private readonly pool: Pooled[] = [];
  private replies: MeshReply[] = [];
  private replyBytes = 0;
  private readonly depth = makeQuadDepthMaterial();
  private readonly distance = makeQuadDepthMaterial(true);
  readonly stats = { cancelled: 0, stale: 0, evicted: 0, failed: 0, admittedBytes: 0 };

  constructor(
    private readonly meta: Meta,
    private readonly material: THREE.Material,
    scene: THREE.Scene,
    packed = true,
  ) {
    this.packed = packed;
    this.N = meta.tiles.N;
    this.levels = meta.tiles.levels.map((l) => l.s).sort((a, b) => b - a);
    this.dims = Object.fromEntries(meta.tiles.levels.map((l) => [l.s, l]));
    for (const d of meta.tiles.levels) this.tileKeys[d.s] = [];
    scene.add(this.group);
    this.world = new World(this, meta);
  }
  columns(key: string) {
    return this.nodes.get(key)?.data;
  }
  setDebugMaterials(materials: Map<number, THREE.Material> | null, foliage: THREE.Material | null = null) {
    this.debugMaterials = materials;
    this.debugFoliageMaterial = foliage;
    this.refreshMaterials();
  }
  setFoliageMaterial(material: THREE.Material) {
    this.foliageMaterial = material;
    this.refreshMaterials();
  }
  private materialFor(node: TileNode) {
    if (node.foliage) return this.debugFoliageMaterial ?? this.foliageMaterial ?? this.material;
    return this.debugMaterials?.get(node.s) ?? this.material;
  }
  private refreshMaterials() {
    if (this.debugFoliageMaterial && this.foliageMaterial) {
      this.debugFoliageMaterial.polygonOffset = this.foliageMaterial.polygonOffset;
      this.debugFoliageMaterial.polygonOffsetFactor = this.foliageMaterial.polygonOffsetFactor;
      this.debugFoliageMaterial.polygonOffsetUnits = this.foliageMaterial.polygonOffsetUnits;
    }
    for (const node of this.nodes.values()) {
      if (node.mesh) node.mesh.material = this.materialFor(node);
    }
  }
  key(s: number, tx: number, ty: number) {
    const d = this.dims[s];
    if (d && tx >= 0 && ty >= 0 && tx < d.nx && ty < d.ny)
      return this.tileKeys[s][ty * d.nx + tx] ??= `${s}/${tx}_${ty}`;
    return `${s}/${tx}_${ty}`;
  }
  foliageKey(tx: number, ty: number) {
    const d = this.dims[1];
    if (d && tx >= 0 && ty >= 0 && tx < d.nx && ty < d.ny)
      return this.foliageKeys[ty * d.nx + tx] ??= `f/${tx}_${ty}`;
    return `f/${tx}_${ty}`;
  }
  bounds(s: number, tx: number, ty: number) {
    const L = this.N * s;
    return [tx * L, ty * L, Math.min((tx + 1) * L, this.meta.W), Math.min((ty + 1) * L, this.meta.D)];
  }
  request(s: number, tx: number, ty: number, prio: number, _keep = true) {
    return this.enqueue(this.key(s, tx, ty), s, tx, ty, false, prio);
  }
  requestFoliage(tx: number, ty: number, prio: number) {
    return this.enqueue(this.foliageKey(tx, ty), 1, tx, ty, true, prio);
  }
  private enqueue(key: string, s: number, tx: number, ty: number, foliage: boolean, prio: number) {
    let n = this.nodes.get(key);
    if (n) {
      n.prio = prio;
      n.touched = performance.now();
      if (n.state !== 'failed' || performance.now() < n.retryAt) return n.ready;
      this.nodes.delete(key);
    }
    let resolve = () => {};
    const ready = new Promise<void>((r) => {
      resolve = r;
    });
    n = {
      key,
      s,
      tx,
      ty,
      foliage,
      prio,
      ready,
      resolve,
      id: this.nextId++,
      state: 'queued',
      touched: performance.now(),
      retryAt: 0,
      attempts: (n?.attempts ?? 0) + 1,
      meshBytes: 0,
      queryBytes: 0,
      voxels: 0,
    };
    this.nodes.set(key, n);
    this.queue.push(n);
    this.revision++;
    return ready;
  }
  reprioritize(prio: (n: TileNode) => number) {
    for (const n of this.queue) n.prio = prio(n);
  }
  retire() {
    const now = performance.now();
    for (let i=0;i<this.pool.length;) {
      const p=this.pool[i];
      if (!p.busy && now - p.idle > 4000 && this.pool.length > 1) {
        p.worker.terminate();
        this.pool.splice(i, 1);
      } else i++;
    }
  }
  private spawn() {
    const worker = new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' });
    const p: Pooled = { worker, busy: 0, idle: performance.now() };
    worker.onmessage = (e: MessageEvent<MeshReply>) => {
      p.busy = 0;
      this.inflight--;
      p.idle = performance.now();
      const m = e.data;
      if (this.nodes.get(m.key)?.id !== m.id) this.stats.stale++;
      else {
        this.replies.push(m);
        this.replyBytes += this.bytesOf(m);
      }
      this.pump();
    };
    worker.onerror = () => {
      const n = [...this.nodes.values()].find((n) => n.id === p.busy);
      if (n) {
        n.state = 'failed';
        n.retryAt = performance.now() + 3000;
        n.resolve();
        this.stats.failed++;
        this.revision++;
      }
      if (p.busy) this.inflight--;
      worker.terminate();
      this.pool.splice(this.pool.indexOf(p), 1);
      this.pump();
    };
    this.pool.push(p);
  }
  private bytesOf(m: MeshReply) {
    return m.type === 'node'
      ? m.records.byteLength + (m.data ? m.data.runs.byteLength + m.data.off.byteLength + m.data.ground.byteLength : 0)
      : 0;
  }
  pump() {
    if (!this.queue.length || this.replyBytes > 4 * 1024 * 1024) return;
    this.queue.sort((a, b) => b.prio - a.prio);
    while (this.pool.length < Math.min(this.maxWorkers, this.queue.length + this.inflight)) this.spawn();
    for (const p of this.pool) {
      if (p.busy || !this.queue.length) continue;
      const n = this.queue.shift()!;
      if (this.nodes.get(n.key) !== n) continue;
      n.state = 'loading';
      p.busy = n.id;
      this.inflight++;
      const file = (key: string) => dataUrl(`tiles/${key}.bin`);
      const msg: MeshRequest = {
        id: n.id,
        key: n.key,
        N: this.N,
        s: n.s,
        url: file(n.foliage ? `1f/${n.tx}_${n.ty}` : n.key),
        keep: !n.foliage,
      };
      const transfer: Transferable[] = [];
      if (n.foliage) {
        const data = this.nodes.get(this.key(1, n.tx, n.ty))?.data;
        if (data) {
          // Foliage uses occupancy only; no material-rich columns need to survive meshing.
          msg.under = { off: data.off.slice(), runs: data.runs.slice(), ground: new Uint8Array() };
          transfer.push(msg.under.off.buffer, msg.under.runs.buffer, msg.under.ground.buffer);
        } else msg.under = file(`1/${n.tx}_${n.ty}`);
      }
      p.worker.postMessage(msg, transfer);
    }
  }
  // Admit bounded output per frame. A single larger tile must still make progress.
  flush(maxBytes = 2 * 1024 * 1024, prepare?: (mesh: THREE.Mesh) => void) {
    let used = 0;
    while (this.replies.length && used < maxBytes) {
      const m = this.replies.shift()!,
        bytes = this.bytesOf(m);
      this.replyBytes -= bytes;
      used += bytes;
      const n = this.nodes.get(m.key);
      if (!n || n.id !== m.id) {
        this.stats.stale++;
        continue;
      }
      if (m.type === 'error') {
        n.state = 'failed';
        n.retryAt = performance.now() + Math.min(30000, 1000 * 2 ** Math.min(n.attempts, 5));
        this.stats.failed++;
        console.warn(m.error);
      } else {
        n.voxels = m.voxels;
        // Inspect emitted faces once, before records are released. Only water uses time.
        n.waterBounds = undefined;
        for (let i = 0; i < m.records.length; i += 8) {
          const r = m.records;
          if (this.meta.palette[r[i + 5]]?.[3] !== MAT.WATER) continue;
          const box = n.waterBounds ??= new THREE.Box3(), axis = (r[i + 6] & 7) >> 1;
          const x = r[i], y = r[i + 1], z = r[i + 2], w = r[i + 3], h = r[i + 4];
          box.min.x = Math.min(box.min.x, x); box.min.y = Math.min(box.min.y, y); box.min.z = Math.min(box.min.z, z);
          box.max.x = Math.max(box.max.x, x + (axis === 0 ? 0 : axis === 1 ? h : w));
          box.max.y = Math.max(box.max.y, y + (axis === 0 ? h : axis === 1 ? w : 0));
          box.max.z = Math.max(box.max.z, z + (axis === 0 ? w : axis === 1 ? 0 : h));
        }
        if (m.quads) {
          const geo = makeQuadGeometry(m.records, m.bounds, this.packed);
          const mesh = new THREE.Mesh(geo, this.materialFor(n));
          mesh.position.set(n.tx * this.N * n.s, 0, n.ty * this.N * n.s);
          n.waterBounds?.translate(mesh.position);
          mesh.updateMatrix();
          mesh.matrixAutoUpdate = false;
          mesh.visible = false;
          mesh.castShadow = mesh.receiveShadow = true;
          if (this.packed) {
            mesh.customDepthMaterial = this.depth;
            mesh.customDistanceMaterial = this.distance;
          }
          prepare?.(mesh);
          this.group.add(mesh);
          n.mesh = mesh;
          n.meshBytes = geometryBytes(geo);
          this.stats.admittedBytes += n.meshBytes;
        }
        if (m.data) {
          n.data = { ...m.data, s: n.s, x0: n.tx * this.N * n.s, y0: n.ty * this.N * n.s, S: this.N + 2 };
          n.queryBytes = m.data.runs.byteLength + m.data.off.byteLength + m.data.ground.byteLength;
          this.version++;
        }
        n.empty = !m.quads;
        n.state = 'ready';
      }
      n.resolve();
      this.revision++;
    }
    this.pump();
  }
  trim(keep: Set<string>, maxBytes = 256 * 1024 * 1024, graceMs = 2000) {
    const now = performance.now();
    let bytes = this.memory.total;
    const candidates = this.trimCandidates;
    candidates.length = 0;
    for (const n of this.nodes.values()) if (!keep.has(n.key) && !n.mesh?.visible) candidates.push(n);
    candidates.sort((a, b) => a.touched - b.touched);
    for (const n of candidates) {
      if (n.state === 'ready' && bytes <= maxBytes && now - n.touched < graceMs) continue;
      if (n.mesh?.visible) continue;
      this.nodes.delete(n.key);
      let write = 0;
      for (const job of this.queue) if (job !== n) this.queue[write++] = job;
      this.queue.length = write;
      const p = this.pool.find((p) => p.busy === n.id);
      if (p) {
        p.worker.postMessage({ cancel: n.id });
        this.stats.cancelled++;
      }
      if (n.mesh) {
        this.group.remove(n.mesh);
        n.mesh.geometry.dispose();
        this.stats.evicted++;
      }
      if (n.data) this.version++;
      bytes -= n.meshBytes + n.queryBytes;
      n.resolve();
      this.revision++;
    }
    // Do not let already-completed obsolete results hold large buffers until a later frame.
    candidates.length = 0; // Do not retain evicted tile data through scratch storage.
    let write = 0;
    this.replyBytes = 0;
    for (const reply of this.replies) if (this.nodes.get(reply.key)?.id === reply.id) {
      this.replies[write++] = reply;
      this.replyBytes += this.bytesOf(reply);
    }
    this.replies.length = write;
  }
  get memory() {
    let geometry = 0,
      query = 0;
    for (const n of this.nodes.values()) {
      geometry += n.meshBytes;
      query += n.queryBytes;
    }
    return { geometry, query, pending: this.replyBytes, total: geometry + query + this.replyBytes };
  }
}
