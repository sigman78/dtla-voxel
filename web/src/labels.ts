import * as THREE from 'three';
import type { Rect } from './hud';
import type { Facts, Label } from './types';
import { $, el, esc } from './util';
import type { World } from './world';

interface Pin {
  el: HTMLElement;
  txt: HTMLElement;
  p: THREE.Vector3;
  base: THREE.Vector3;
  R: number;
  occluded: boolean;
  w: number;
  h: number;
  far: number;
  level: number;
  dims: [number, number][];
  shift: number;
  on: boolean;
  side: 'r' | 'l' | 's';
  since: number;
  screenX: number;
  screenY: number;
}
export interface Placed extends Facts { x: number; y: number; z: number }

const details = (f: Facts) => [f.en && f.kind, f.height && `${f.height} m`, f.year, f.by].filter(Boolean);
const levelAt = (d: number, far: number) => d < Math.max(250, Math.min(far * 0.3, 900)) ? 2 : 0;

const STEM = 20, TOP = 8, MAX = 12, SETTLE = 150;
const overlap = (r: Rect, q: Rect) => r.x0 < q.x1 + 6 && r.x1 + 6 > q.x0 && r.y0 < q.y1 + 2 && r.y1 + 2 > q.y0;
const rect = (): Rect => ({ x0: 0, x1: 0, y0: 0, y1: 0 });
const SIDES = ['r', 'l', 's'] as const;
function free(r: Rect, placed: Rect[], count: number) {
  if (r.x0 < 4 || r.x1 > innerWidth - 4 || r.y0 < 4 || r.y1 > innerHeight - 4) return false;
  for (let i = 0; i < count; i++) if (overlap(r, placed[i])) return false;
  return true;
}

// Map pins: a dot on the roof, a hairline stem, the name above. Hidden when something else is in the way (a voxel
// ray) or when a more important label is there; the MAX most important ones in view, however far. The major ones
// first, then the shown ones keep their place before newcomers are fitted, and a newcomer fades in only after holding a free spot for SETTLE ms.
export class Labels {
  gate: (x: number, z: number) => boolean = () => true;
  private readonly host = $('#labels');
  private readonly pins: Pin[] = [];
  private picked: Pin | null = null;
  private frame = 0;
  private readonly projected = new THREE.Vector3();
  private readonly rayDirection = new THREE.Vector3();
  private readonly ordered: Pin[] = [];
  private readonly placed: Rect[] = [];
  private readonly barRect = rect();
  private readonly candidates = { r: rect(), l: rect(), s: rect() };
  private readonly accepted = Array.from({ length: MAX }, rect);
  private readonly cameraWorld = new THREE.Matrix4();
  private readonly cameraProjection = new THREE.Matrix4();
  private lastWorld: World | null = null;
  private worldVersion = -1;
  private visibilityVersion = -1;
  private lastBar: DOMRect | null = null;
  private lastObstacles: Rect[] | null = null;
  private lastGate = this.gate;
  private width = 0;
  private height = 0;
  private dirty = true;
  private settling = false;
  private occlusionRemaining = 0;

  constructor(labels: Label[], onClick: (l: Label) => void) {
    labels.forEach((l) => {
      const pin = this.add(`label${(l.far ?? 0) >= 9000 ? ' major' : ''}`, l,
        new THREE.Vector3(l.x + 0.5, l.z + 1, l.y + 0.5), new THREE.Vector3(l.x + 0.5, (l.g ?? Math.max(0, l.z - (l.height ?? l.z))) + 2, l.y + 0.5), (l.R ?? 30) + 6);
      pin.txt.addEventListener('click', () => onClick(l));
      this.pins.push(pin);
    });
    document.fonts?.ready.then(() => { for (const p of this.pins) p.dims = []; this.dirty = true; });
  }

  private add(cls: string, f: Facts, p: THREE.Vector3, base: THREE.Vector3, R: number): Pin {
    const facts = details(f).map((d) => `<span>${esc(d)}</span>`).join('');
    const e = el('div', cls, `<i class="dot"></i><i class="stem"></i><div class="txt"><b>${esc(f.name)}</b><span>${esc(f.en ?? f.kind)}</span>${facts ? `<p>${facts}</p>` : ''}</div>`, this.host);
    return { el: e, txt: $('.txt', e), p, base, R, occluded: false, w: 0, h: 0, far: f.far ?? 1300, level: -1, dims: [], shift: 0, on: false, side: 'r', since: -1, screenX: NaN, screenY: NaN };
  }

  // a temporary label on a searched place
  pin(p: Placed | null) {
    this.dirty = true;
    if (this.picked) { this.picked.el.remove(); this.pins.splice(this.pins.indexOf(this.picked), 1); this.picked = null; }
    if (!p) return;
    this.picked = this.add('label pick', { ...p, far: 1e9 }, new THREE.Vector3(p.x + 0.5, p.z + 1, p.y + 0.5), new THREE.Vector3(p.x + 0.5, p.z, p.y + 0.5), 40);
    this.pins.unshift(this.picked);
  }

  update(camera: THREE.Camera, world: World | null, bar: DOMRect, obstacles: Rect[], visibilityVersion = 0) {
    const version = world?.version ?? 0;
    const changed = this.dirty || !this.cameraWorld.equals(camera.matrixWorld) || !this.cameraProjection.equals(camera.projectionMatrix)
      || world !== this.lastWorld || version !== this.worldVersion || visibilityVersion !== this.visibilityVersion
      || bar !== this.lastBar || obstacles !== this.lastObstacles || this.gate !== this.lastGate
      || innerWidth !== this.width || innerHeight !== this.height;
    if (changed) {
      this.cameraWorld.copy(camera.matrixWorld); this.cameraProjection.copy(camera.projectionMatrix);
      this.lastWorld = world; this.worldVersion = version; this.visibilityVersion = visibilityVersion;
      this.lastBar = bar; this.lastObstacles = obstacles; this.lastGate = this.gate;
      this.width = innerWidth; this.height = innerHeight; this.dirty = false;
      this.occlusionRemaining = world ? this.pins.length : 0;
    } else if (!this.settling && this.occlusionRemaining === 0) {
      // Preserve round-robin phase without repeating identical ray queries.
      if (world && this.pins.length) this.frame += 4;
      return;
    }
    this.settling = false;
    if (world && this.occlusionRemaining > 0) {
      this.checkOcclusion(camera, world);
      this.occlusionRemaining = Math.max(0, this.occlusionRemaining - 4);
    } else if (world && this.pins.length) this.frame += 4;
    const placed = this.placed;
    let placedCount = 0;
    if (bar.width) {
      const r = this.barRect;
      r.x0 = bar.left - 8; r.x1 = bar.right; r.y0 = bar.top; r.y1 = bar.bottom + 8;
      placed[placedCount++] = r;
    }
    for (const r of obstacles) placed[placedCount++] = r;
    const v = this.projected, now = performance.now();
    let shown = 0;
    // Four stable priority buckets, captured before visibility changes during placement.
    let orderedCount = 0;
    for (let rank = 0; rank < 4; rank++) for (const p of this.pins) {
      if ((p.far >= 9000 ? 0 : 2) + (p.on ? 0 : 1) === rank) this.ordered[orderedCount++] = p;
    }
    this.ordered.length = orderedCount;
    for (const L of this.ordered) {
      v.copy(L.p).project(camera);
      const inFront = v.z < 1, d = camera.position.distanceTo(L.p);
      let x = (v.x * 0.5 + 0.5) * innerWidth, y = (-v.y * 0.5 + 0.5) * innerHeight;
      const under = bar.width > 0 && x > bar.left - 8 && x - 4 < bar.right;
      this.setLevel(L, levelAt(d, L.far));
      [L.w, L.h] = L.dims[L.level];
      let fits = false, side = L.side, pinned = false;
      if (shown < MAX && !L.occluded && inFront && x > -20 && x < innerWidth + 20 && this.gate(L.p.x, L.p.z)) {
        // the roof above the screen but the building in view: the label pinned to the top edge
        if (y < TOP + STEM + L.h && y > -innerHeight * 0.8) {
          v.copy(L.base).project(camera);
          if (v.z < 1 && (-v.y * 0.5 + 0.5) * innerHeight > TOP + STEM + L.h + 30) {
            y = TOP + L.h + 4; pinned = true;
            if (under) y = Math.max(y, bar.bottom + 20 + L.h);
          }
        }
        if (under && y - STEM - L.h < bar.bottom + 12 && y > bar.top) { y = Math.max(y, bar.bottom + 20 + L.h); pinned = true; }
        if (y <= innerHeight + 4) {
          const st = pinned ? 4 : STEM, y0 = y - st - L.h, y1 = y + 4;
          const sx = Math.min(Math.max(x - L.w / 2, 4), innerWidth - L.w - 4);
          const rects = this.candidates;
          rects.r.x0 = x - 4; rects.r.x1 = x + L.w;
          rects.l.x0 = x - L.w; rects.l.x1 = x + 4;
          rects.s.x0 = sx; rects.s.x1 = sx + L.w;
          for (const k of SIDES) { rects[k].y0 = y0; rects[k].y1 = y1; }
          let pick: Pin['side'] | undefined;
          for (let i = L.on ? -1 : 0; i < SIDES.length; i++) {
            const k = i < 0 ? L.side : SIDES[i];
            if ((k !== 's' || L.w < innerWidth - 8) && free(rects[k], placed, placedCount)) { pick = k; break; }
          }
          if (pick) {
            fits = true; side = pick;
            const r = this.accepted[shown], candidate = rects[pick];
            r.x0 = candidate.x0; r.x1 = candidate.x1; r.y0 = y0; r.y1 = y1;
            placed[placedCount++] = r;
            if (pick === 's') L.shift = sx - x;
          }
        }
      }
      if (fits) { shown++; if (L.since < 0) L.since = now; } else L.since = -1;
      const vis = fits && (L.on || now - L.since >= SETTLE);
      if ((fits && !vis) || vis !== L.on) this.settling = true;
      if (vis) { L.side = side; L.el.classList.toggle('left', side === 'l'); L.el.classList.toggle('pinned', pinned); L.txt.style.left = side === 's' ? `${L.shift.toFixed(0)}px` : ''; }
      L.on = vis;
      L.el.classList.toggle('off', !vis);
      if (inFront && (x !== L.screenX || y !== L.screenY)) {
        L.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
        L.screenX = x; L.screenY = y;
      }
    }
  }

  private setLevel(L: Pin, level: number) {
    if (L.level === level && L.dims[level]) return;
    L.level = level;
    L.el.classList.toggle('near', level === 2);
    L.dims[level] ??= [L.txt.offsetWidth || 160, L.txt.offsetHeight || 30];
  }

  // a few labels per frame: hidden by something other than the labelled building itself
  private checkOcclusion(camera: THREE.Camera, world: World) {
    const dir = this.rayDirection;
    for (let k = 0; k < 4 && this.pins.length; k++) {
      const L = this.pins[this.frame++ % this.pins.length];
      dir.subVectors(L.p, camera.position);
      const dist = dir.length();
      dir.divideScalar(dist);
      const t = world.raycast(camera.position, dir, dist);
      const hx = camera.position.x + dir.x * t - L.p.x, hz = camera.position.z + dir.z * t - L.p.z;
      L.occluded = t < dist - 3 && hx * hx + hz * hz > L.R * L.R;
    }
  }
}
