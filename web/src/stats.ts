import * as THREE from 'three';
import type { TileStreamer } from './stream';
import { el } from './util';

const mib = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`;
const number = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 });

// Diagnostic work is suspended while hidden; no synchronous GPU queries/readbacks.
export class Stats {
  private readonly box = el('aside', 'perf-stats');
  private readonly title = el('div', 'perf-title', 'Performance · F3 to hide', this.box);
  private readonly canvas = el('canvas', '', '', this.box);
  private readonly values = el('pre', '', '', this.box);
  private readonly context: CanvasRenderingContext2D;
  private readonly samples = new Float32Array(120);
  private readonly frustum = new THREE.Frustum();
  private readonly matrix = new THREE.Matrix4();
  private cursor = 0;
  private count = 0;
  private previous = 0;
  private refreshed = 0;

  constructor() {
    this.box.hidden = true;
    this.box.setAttribute('aria-label', 'Performance statistics');
    this.canvas.width = 280;
    this.canvas.height = 64;
    this.canvas.setAttribute('aria-label', 'Recent frame rate graph');
    this.context = this.canvas.getContext('2d')!;
    el('div', 'perf-note', 'Voxels: occupied cells at selected LODs, including buried cells. Frustum totals count whole intersecting tiles, not visible pixels. GPU geometry excludes textures, render targets and driver overhead. JS heap excludes workers. CPU payload includes geometry, queries and pending results.', this.box);
    addEventListener('keydown', (event) => {
      if (event.code !== 'F3' || event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      this.box.hidden = !this.box.hidden;
      this.previous = this.refreshed = this.cursor = this.count = 0;
    });
    document.addEventListener('visibilitychange', () => { this.previous = 0; });
  }

  update(now: number, streamer: TileStreamer | null, camera: THREE.Camera) {
    if (this.box.hidden) return;
    if (this.previous) {
      this.samples[this.cursor] = now - this.previous;
      this.cursor = (this.cursor + 1) % this.samples.length;
      this.count = Math.min(this.samples.length, this.count + 1);
    }
    this.previous = now;
    if (now - this.refreshed < 250 || !this.count) return;
    this.refreshed = now;
    let elapsed = 0, peak = 120;
    for (let i = 0; i < this.count; i++) {
      elapsed += this.samples[i];
      peak = Math.max(peak, 1000 / Math.max(.01, this.samples[i]));
    }
    const ceiling = Math.ceil(peak / 60) * 60;
    const ms = elapsed / this.count;
    this.title.textContent = `${(1000 / ms).toFixed(0)} FPS · ${ms.toFixed(1)} ms · F3 to hide`;
    const ctx = this.context, w = this.canvas.width, h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = '#ffffff30';
    const referenceY = h - 60 / ceiling * h;
    ctx.beginPath(); ctx.moveTo(0, referenceY); ctx.lineTo(w, referenceY); ctx.stroke();
    ctx.fillStyle = '#b9c6d4'; ctx.font = '10px monospace'; ctx.fillText('60 FPS', 3, referenceY - 4);
    ctx.strokeStyle = '#78e4b0'; ctx.beginPath();
    for (let i = 0; i < this.count; i++) {
      const index = (this.cursor - this.count + i + this.samples.length) % this.samples.length;
      const x = (this.samples.length - this.count + i) * w / (this.samples.length - 1);
      const y = h - (1000 / Math.max(.01, this.samples[index])) / ceiling * h;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
    this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.matrix);
    let base = 0, foliage = 0, resident = 0, active = 0;
    let activeVoxels = 0, frustumVoxels = 0;
    if (streamer) for (const node of streamer.nodes.values()) {
      if (!node.mesh) continue;
      resident++;
      if (!node.mesh.visible || !streamer.group.visible) continue;
      active++;
      activeVoxels += node.voxels;
      if (node.mesh.frustumCulled && !this.frustum.intersectsObject(node.mesh)) continue;
      frustumVoxels += node.voxels;
      if (node.foliage) foliage++; else base++;
    }
    const memory = streamer?.memory;
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    this.values.textContent = [
      `Frustum tiles    ${base + foliage} (${base} base + ${foliage} foliage)`,
      `Active/resident ${active} / ${resident}`,
      `Voxels active ~ ${number.format(activeVoxels)}`,
      `Voxels frustum ~ ${number.format(frustumVoxels)}`,
      `CPU tile payload ${mib(memory?.total ?? 0)}`,
      `  Query / pending ${mib(memory?.query ?? 0)} / ${mib(memory?.pending ?? 0)}`,
      `GPU geometry ~  ${mib(memory?.geometry ?? 0)}`,
      `JS heap         ${heap ? mib(heap.usedJSHeapSize) : 'unavailable'}`,
      'Total VRAM      unavailable in WebGL',
    ].join('\n');
  }
}
