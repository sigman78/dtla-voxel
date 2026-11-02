import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Bar } from './bar';
import { Caption } from './caption';
import { installCity } from './city';
import { Daylight } from './daylight';
import { Hud } from './hud';
import { Labels } from './labels';
import { Nav } from './nav';
import { makePost } from './post';
import type { SearchItem } from './search';
import { TileStreamer } from './stream';
import { dateOf, dayOfYear, hourAt, solarNoon } from './sun';
import type { Facts, Label, Meta, View } from './types';
import { $, coarsePointer, dataUrl, ease, el, fetchJson } from './util';
import { makeUniforms, makeVoxelMaterial } from './voxelMaterial';
import './style.css';

declare global {
  interface Window { __ready?: boolean; __three?: object; __city?: { complete: boolean } }
}

const RAD = Math.PI / 180;
const TODAY = dayOfYear(new Date());
const DAYS = { midsummer: 172, midwinter: 355, today: TODAY };

const qs = new URLSearchParams(location.search);
const renderer = makeRenderer();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, innerWidth / innerHeight, 0.5, 9000);
const controls = makeControls();
const post = makePost(renderer, scene, camera);
const daylight = new Daylight(renderer, scene);
const nav = new Nav(camera, controls, renderer.domElement, (v) => flyTo(v));
const bar = new Bar({ days: DAYS, onDay: (d) => { setDay(d); share(); }, onHour: (h) => { setHour(h); share(); } });
const map = new THREE.Box3();
const tiltShift = qs.get('tilt') !== '0' && (innerWidth >= 600 || qs.get('tilt') === '1');
let labels: Labels | null = null, hud: Hud | null = null;
let world: TileStreamer['world'] | null = null, streamer: TileStreamer | null = null;
let city: Awaited<ReturnType<typeof installCity>> | null = null;
let uniforms: ReturnType<typeof makeUniforms> | null = null, views: Record<string, View> = {};
let fly: ((now: number) => void) | null = null;
let barRect: DOMRect | null = null;
let roam = 1500; // how far the camera may stray beyond the map's edge

nav.cancelFly = () => { fly = null; };
new ResizeObserver(() => { barRect = null; }).observe(bar.el);
el('div', '', `<div>Viewer adapted from <a href="https://github.com/stared/warsaw-vibe-voxel" target="_blank" rel="noopener">warsaw-vibe-voxel</a> by Piotr Migdał (MIT)</div>
  <div>Map data <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a></div>`).id = 'credits';
if (qs.get('ui') === '0') document.body.classList.add('noui');
addEventListener('resize', onResize);
addEventListener('keydown', (e) => {
  if (e.key === '/' && !(e.metaKey || e.ctrlKey || e.altKey) && !(e.target as Element).closest?.('input')) { bar.search.input.focus(); e.preventDefault(); }
});
tamePinch(renderer.domElement);
boot().catch((e) => { $('#loading-text').textContent = `Could not load the map data (${e instanceof Error ? e.message : e})`; throw e; });

function makeRenderer() {
  const r = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
  r.setPixelRatio(Math.min(devicePixelRatio, 2));
  r.setSize(innerWidth, innerHeight);
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFShadowMap;
  r.toneMapping = THREE.NoToneMapping;
  r.outputColorSpace = THREE.SRGBColorSpace;
  $('#app').appendChild(r.domElement);
  return r;
}

function makeControls() {
  const c = new OrbitControls(camera, renderer.domElement);
  Object.assign(c, { enableDamping: true, dampingFactor: 0.16, rotateSpeed: 0.3, minDistance: 4, maxDistance: 7000, screenSpacePanning: false, zoomToCursor: true, zoomSpeed: 2.0 });
  if (coarsePointer()) Object.assign(c, { panSpeed: 1.6, zoomSpeed: 1 }); // the map moves and scales with the fingers
  return c;
}

// the tile level to show: 1 m, or coarser on phones (the whole city at 1 m needs ~1 GB of GPU memory); ?lod=1|2|4|8
function pickLevel(meta: Meta) {
  const have = meta.tiles.levels.map((l) => l.s), asked = Number(qs.get('lod'));
  if (have.includes(asked)) return asked;
  const phone = coarsePointer() && Math.min(screen.width, screen.height) < 600;
  return phone ? have.filter((s) => s <= 4).sort((a, b) => b - a)[0] ?? 1 : 1;
}

// a trackpad pinch arrives as Ctrl+wheel, which OrbitControls amplifies 10x: re-sent as a plain wheel at ~3x
function tamePinch(dom: HTMLElement) {
  dom.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !e.isTrusted) return;
    e.stopImmediatePropagation(); e.preventDefault();
    dom.dispatchEvent(new WheelEvent('wheel', { deltaY: e.deltaY * 3, deltaMode: e.deltaMode, clientX: e.clientX, clientY: e.clientY, bubbles: true, cancelable: true }));
  }, { capture: true, passive: false });
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  post.composer.setSize(innerWidth, innerHeight);
  barRect = null;
}

function setHour(h: number) {
  daylight.apply(h);
  bar.setHour(h);
}

// the marks on the hour slider for a day of the year
const timesOf = (d: number) => ({ morning: Math.max(7.5, hourAt(d, 6, false)), midday: solarNoon(d), 'golden hour': hourAt(d, 10, true),
  sunset: hourAt(d, -0.83, true), 'blue hour': hourAt(d, -7, true), night: Math.min(23.5, Math.max(22, hourAt(d, -14, true))) });

// a new day keeps the time of day it was at (golden hour stays golden hour), else the clock time
function setDay(d: number) {
  const times = timesOf(daylight.day), was = Object.entries(times).find(([, h]) => Math.abs(h - daylight.hour) < 1 / 3)?.[0] as keyof typeof times | undefined;
  daylight.day = d;
  const now = timesOf(d);
  bar.setDay(d, now);
  setHour(was ? now[was] : daylight.hour);
}

let shareT = 0;
function share() {
  clearTimeout(shareT);
  shareT = setTimeout(() => {
    const d = dateOf(daylight.day);
    qs.set('date', `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    qs.set('hour', daylight.hour.toFixed(2));
    history.replaceState(null, '', `?${qs}`);
  }, 400);
}

function flyTo(v: Pick<View, 'pos' | 'target' | 'ms'>) {
  const p0 = camera.position.clone(), q0 = controls.target.clone(), t0 = performance.now();
  const p1 = new THREE.Vector3(...v.pos), q1 = new THREE.Vector3(...v.target);
  fly = (now) => {
    const t = Math.min(1, (now - t0) / (v.ms ?? 1600)), e = ease(t);
    camera.position.lerpVectors(p0, p1, e);
    controls.target.lerpVectors(q0, q1, e);
    if (t >= 1) fly = null;
  };
}

// the whole map from the south-west (compass, not grid), 35° down, as close as fits the screen
function frameAll(meta: Meta): View {
  const { W, D } = meta, top = Math.min(meta.H, 200), target = new THREE.Vector3(W / 2, 20, D / 2);
  const dir = daylight.skyDir(225 * RAD, 35 * RAD), cam = camera.clone(), p = new THREE.Vector3();
  cam.far = 1e6;
  cam.updateProjectionMatrix();
  const corners = [0, W].flatMap((x) => [0, D].flatMap((z) => [0, top].map((y) => new THREE.Vector3(x, y, z))));
  const fits = (dist: number) => {
    cam.position.copy(target).addScaledVector(dir, dist);
    cam.lookAt(target);
    cam.updateMatrixWorld();
    return corners.every((c) => { p.copy(c).project(cam); return Math.abs(p.x) < 0.94 && Math.abs(p.y) < 0.9 && p.z < 1; });
  };
  let lo = 100, hi = 40000;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (fits(m)) hi = m; else lo = m; }
  return { label: 'Whole map', pos: target.clone().addScaledVector(dir, hi).toArray(), target: target.toArray() };
}

// frame a place from the current compass direction, ~30° down, with a label on it
function goPlace(x: number, y: number, size: number, pin: Facts | null) {
  if (!world) return;
  const g = world.groundAt(x, y), top = world.top(Math.floor(x), Math.floor(y)), h = Math.max(0, top - g);
  labels?.pin(pin && { ...pin, x, y, z: Math.max(top, g + 2) });
  const t = new THREE.Vector3(x + 0.5, g + Math.min(h * 0.5, 60), y + 0.5);
  const dist = Math.min(800, Math.max(170, size * 1.6 + h * 1.8));
  const az = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z), el = 0.52;
  const pos = t.clone().add(new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(dist));
  flyTo({ pos: pos.toArray(), target: t.toArray() });
}

function goView(v: View) {
  labels?.pin(null);
  flyTo(v);
}

function onLabel(l: Label) {
  const v = Object.values(views).find((w) => w.label === l.name);
  if (v) goView(v);
  else goPlace(l.x, l.y, 60, null);
}

function searchItems(meta: Meta): SearchItem[] {
  return [
    ...Object.values(views).map((v) => ({ name: v.label, kind: 'viewpoint', featured: true, go: () => goView(v) })),
    ...(meta.labels ?? []).map((l) => ({ name: l.name, alt: [l.en, l.alt].join(' '), kind: l.kind, go: () => goPlace(l.x, l.y, Math.max(40, (l.R ?? 20) * 1.4), null) })),
  ];
}

// keep the focus over the city and the camera within `roam` of it
function keepInside() {
  if (map.isEmpty() || nav.turning) return;
  const t = controls.target, p = camera.position, m = 60, M = roam;
  const cx = THREE.MathUtils.clamp(t.x, map.min.x + m, map.max.x - m), cz = THREE.MathUtils.clamp(t.z, map.min.z + m, map.max.z - m);
  if (cx !== t.x || cz !== t.z) { const d = new THREE.Vector3(cx - t.x, 0, cz - t.z); t.add(d); p.add(d); }
  p.x = THREE.MathUtils.clamp(p.x, map.min.x - M, map.max.x + M);
  p.z = THREE.MathUtils.clamp(p.z, map.min.z - M, map.max.z + M);
}

async function boot() {
  const meta = await fetchJson<Meta>(dataUrl('meta.json'));
  uniforms = makeUniforms(meta);
  streamer = new TileStreamer(meta, makeVoxelMaterial(uniforms), scene);
  world = nav.world = streamer.world;
  map.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(meta.W, meta.H, meta.D));
  daylight.uniforms = uniforms;
  daylight.bloom = post.bloom;
  daylight.theta = (meta.theta_deg || 0) * RAD;

  const overview = frameAll(meta), reach = new THREE.Vector3(...overview.pos).distanceTo(new THREE.Vector3(...overview.target));
  views = { ...meta.views, ...(meta.views?.default ? {} : { default: overview }) };
  camera.far = Math.max(9000, reach * 2.2);
  camera.updateProjectionMatrix();
  controls.maxDistance = Math.max(7000, reach * 1.3);
  roam = Math.max(1500, reach);
  const v0 = views[qs.get('view') ?? ''] ?? views.default, cam = qs.get('cam')?.split(',').map(Number);
  camera.position.set(...(cam?.length === 6 ? [cam[0], cam[1], cam[2]] as const : v0.pos));
  controls.target.set(...(cam?.length === 6 ? [cam[3], cam[4], cam[5]] as const : v0.target));

  const md = qs.get('date')?.split('-').map(Number);
  setDay(md?.length === 2 ? dayOfYear(new Date(new Date().getFullYear(), md[0] - 1, md[1])) : TODAY);
  setHour(qs.get('hour') ? +qs.get('hour')! : timesOf(daylight.day)['golden hour']);

  city = await installCity({ streamer, uniforms, meta, scene, focus: () => controls.target, camera, caption: new Caption(), level: pickLevel(meta) });
  labels = new Labels(meta.labels ?? [], onLabel);
  labels.gate = city.gate;
  hud = new Hud(renderer.domElement);
  bar.search.setItems(searchItems(meta));
  $('#loading').classList.add('hidden');
  window.__city = city;
  window.__ready = true;
}

let lastT = performance.now();
const t0 = lastT;
renderer.setAnimationLoop((now) => {
  fly?.(now);
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  nav.update(dt);
  controls.update(); nav.clamp(); keepInside();
  const above = camera.position.y - (world ? world.groundAt(camera.position.x, camera.position.z) : 18) + 3;
  const viewDist = camera.position.distanceTo(controls.target);
  post.setHeight(above, tiltShift, viewDist);
  daylight.setFogFrom(viewDist);
  if (uniforms) uniforms.uTime.value = (performance.now() - t0) / 1000;
  if (city?.complete) document.body.classList.remove('loading');
  daylight.sky.mesh.position.copy(camera.position);
  streamer?.update(camera);
  daylight.fitShadow(controls.target, camera, viewDist, map);
  post.composer.render();
  barRect ??= bar.rect;
  labels?.update(camera, world, barRect, hud?.rects ?? []);
});

window.__three = { camera, controls, nav, bar, scene, renderer, flyTo, setHour, setDay, map, daylight, post, frameAll };
