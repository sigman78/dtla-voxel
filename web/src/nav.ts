import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { View } from './types';
import { clamp } from './util';
import type { World } from './world';

// Orbiting the diorama, with one set of keys as in games (W/S fly along the view, A/D turn, Q/E nose up and down,
// Shift faster; arrows alike) and one gesture language for mouse, trackpad and touch: drag moves the map,
// right-drag (or Shift-drag, or two fingers) turns and tilts, the wheel zooms at the cursor, double-click flies there.
type Action = 'f' | 'b' | 'tl' | 'tr' | 'tu' | 'td';
const KEYMAP: Record<string, Action> = {
  KeyW: 'f', KeyS: 'b', KeyA: 'tl', KeyD: 'tr', KeyQ: 'tu', KeyE: 'td',
  ArrowUp: 'f', ArrowDown: 'b', ArrowLeft: 'tl', ArrowRight: 'tr',
};
const TILT = Math.PI * 0.48;

export class Nav {
  world: World | null = null;
  cancelFly: () => void = () => {};
  private readonly keys = new Set<Action>();
  private shift = false;
  private turned = false;

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly controls: OrbitControls, private readonly dom: HTMLElement,
    private readonly flyTo: (v: Pick<View, 'pos' | 'target'>) => void) {
    controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    controls.maxPolarAngle = TILT;
    dom.style.cursor = 'grab';
    this.bindKeys();
    this.bindPointer();
  }

  // turning in place with the keys: the focus is off on its own, put back on release
  get turning() { return this.turned; }

  private axis(pos: Action, neg: Action) { return (this.keys.has(pos) ? 1 : 0) - (this.keys.has(neg) ? 1 : 0); }

  private bindKeys() {
    addEventListener('keydown', (e) => {
      if ((e.target as Element).closest?.('input:not([type=range]), textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
      this.shift = e.shiftKey;
      const k = KEYMAP[e.code];
      if (!k) return;
      this.keys.add(k);
      this.cancelFly();
      e.preventDefault();
    });
    addEventListener('keyup', (e) => {
      this.shift = e.shiftKey;
      const k = KEYMAP[e.code];
      if (k) this.keys.delete(k);
      if (this.turned && ![...this.keys].some((a) => a[0] === 't')) { this.turned = false; this.retarget(); }
    });
    addEventListener('blur', () => this.keys.clear());
  }

  private bindPointer() {
    const dom = this.dom, ptrs = new Map<number, { x: number; y: number }>();
    let twist: number | null = null;
    const two = () => [...ptrs.values()];
    dom.addEventListener('pointerdown', (e) => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (e.button === 2 || (e.button === 0 && (e.shiftKey || e.ctrlKey || e.metaKey)) || ptrs.size === 2) this.pivotAt(e.clientX, e.clientY);
      if (ptrs.size === 2) { const [a, b] = two(); twist = Math.atan2(b.y - a.y, b.x - a.x); }
      dom.style.cursor = 'grabbing';
      this.cancelFly();
    });
    dom.addEventListener('pointermove', (e) => {
      const p = ptrs.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX; p.y = e.clientY;
      if (ptrs.size === 2 && twist !== null) { // two-finger twist turns the map
        const [a, b] = two(), ang = Math.atan2(b.y - a.y, b.x - a.x);
        this.orbitBy(Math.atan2(Math.sin(ang - twist), Math.cos(ang - twist)));
        twist = ang;
      }
    });
    const up = (e: PointerEvent) => {
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) twist = null;
      dom.style.cursor = 'grab';
    };
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointercancel', up);
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('dblclick', (e) => this.diveTo(e.clientX, e.clientY));
  }

  // rotating pivots on the axis of view at the depth of what is under the cursor, so nothing jumps
  private pivotAt(cx: number, cy: number) {
    const hit = this.hitAt(cx, cy);
    if (!hit) return;
    const v = this.camera.getWorldDirection(new THREE.Vector3()), dd = hit.p.clone().sub(this.camera.position).dot(v);
    if (dd > 5 && dd < 2500) this.controls.target.copy(this.camera.position).addScaledVector(v, dd);
  }

  private diveTo(cx: number, cy: number) {
    if (!this.world) return;
    const hit = this.hitAt(cx, cy);
    if (!hit) return;
    const dist = this.camera.position.distanceTo(hit.p);
    const pos = hit.p.clone().addScaledVector(hit.dir, -Math.max(25, dist * 0.4));
    pos.y = Math.max(pos.y, this.world.groundAt(pos.x, pos.z) + 2);
    this.flyTo({ pos: pos.toArray(), target: hit.p.toArray() });
  }

  private hitAt(cx: number, cy: number, maxDist = 4000) {
    if (!this.world) return null;
    const r = new THREE.Raycaster();
    r.setFromCamera(new THREE.Vector2(cx / innerWidth * 2 - 1, -(cy / innerHeight) * 2 + 1), this.camera);
    const t = this.world.raycast(r.ray.origin, r.ray.direction, maxDist);
    if (!isFinite(t)) return null;
    return { p: r.ray.origin.clone().addScaledVector(r.ray.direction, t), dir: r.ray.direction };
  }

  private dir() { return new THREE.Vector3().subVectors(this.controls.target, this.camera.position); }

  // the nose moves, the camera stays (A/D, Q/E). Above level too: OrbitControls' tilt limit follows the keys, so it
  // never swings the camera to get the focus back below it; clamp() restores it once you look down again.
  private turnInPlace(dyaw: number, dpitch: number) {
    const d = this.dir(), len = d.length() || 1;
    const yaw = Math.atan2(d.x, d.z) + dyaw, pitch = clamp(Math.asin(clamp(d.y / len, -1, 1)) + dpitch, -1.5, 1.2);
    this.controls.maxPolarAngle = Math.max(TILT, Math.PI / 2 + pitch + 0.02);
    const c = this.camera.position;
    this.controls.target.set(c.x + len * Math.sin(yaw) * Math.cos(pitch), c.y + len * Math.sin(pitch), c.z + len * Math.cos(yaw) * Math.cos(pitch));
  }

  private orbitBy(dyaw: number) {
    const t = this.controls.target, off = this.camera.position.clone().sub(t), s = new THREE.Spherical().setFromVector3(off);
    s.theta += dyaw;
    s.phi = clamp(s.phi, 0.05, this.controls.maxPolarAngle);
    this.camera.position.copy(t).add(off.setFromSpherical(s));
  }

  // the focus goes onto what is in the middle of the screen (kept on the map), so turning pivots on it
  private retarget() {
    const w = this.world;
    if (!w) return;
    const c = this.camera.position, d = this.dir().normalize(), t = w.raycast(c, d, 3000);
    let len = isFinite(t) ? Math.max(5, t) : Math.min(this.dir().length(), 800);
    const onMap = (L: number) => { const x = c.x + d.x * L, z = c.z + d.z * L; return w.inside(x - 61, z - 61) && w.inside(x + 61, z + 61); };
    while (len > 5 && !onMap(len)) len *= 0.85;
    this.controls.target.copy(c).addScaledVector(d, len);
  }

  // A/D/Q/E turn in place; W/S fly along the view, faster higher up, stopping short of what is ahead
  update(dt: number) {
    dt = Math.min(dt, 0.1);
    const tr = this.axis('tr', 'tl'), tp = this.axis('tu', 'td');
    if (tr || tp) { this.turnInPlace(-tr * (this.shift ? 2.4 : 1.2) * dt, tp * 0.8 * dt); this.turned = true; }
    const go = this.axis('f', 'b'), w = this.world;
    if (!go || !w) return;
    const cam = this.camera.position, len0 = this.dir().length(), look = this.dir().normalize();
    const h = Math.max(3, cam.y - w.groundAt(cam.x, cam.z));
    let step = go * (this.shift ? 3 : 1) * Math.min(400, 8 + h * 0.9) * dt;
    const ahead = w.raycast(cam, look, 4000);
    if (go > 0) step = Math.min(step, Math.max(0, ahead - 8));
    if (step * look.y > 0 && h + step * look.y > 3600) return;
    cam.addScaledVector(look, step);
    this.controls.target.copy(cam).addScaledVector(look, isFinite(ahead) ? Math.max(5, ahead - step) : len0);
  }

  // after OrbitControls: above the ground, and the tilt limit back once you look down
  clamp() {
    const w = this.world;
    if (!w) return;
    if (this.controls.maxPolarAngle > TILT && !this.turned && this.controls.getPolarAngle() <= TILT) this.controls.maxPolarAngle = TILT;
    const p = this.camera.position, g = w.groundAt(p.x, p.z) + 1.2;
    if (p.y < g) { p.y = g; this.camera.lookAt(this.controls.target); }
  }
}
