import * as THREE from 'three';

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const ease = (t: number) => t * t * (3 - 2 * t);
export const smooth = (a: number, b: number, x: number) => ease(clamp((x - a) / (b - a), 0, 1));
export const coarsePointer = () => matchMedia('(pointer: coarse)').matches;
export const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// where the generated data lives: web/public/data, or another folder next to it with ?data=<name> (e.g. the
// Warsaw sample, served in dev from web/data-warsaw by vite.config.js)
const dataParam = new URLSearchParams(location.search).get('data');
export const DATA = dataParam && /^[\w-]+$/.test(dataParam) ? dataParam : 'data';
export const dataUrl = (path: string) => new URL(`${DATA}/${path}`, location.href).href;

export async function fetchGzip(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${res.status} ${url}`);
  return new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json() as Promise<T>;
}

export function dataTexture(data: Uint8Array, w: number, h: number, format: THREE.PixelFormat) {
  const t = new THREE.DataTexture(data, w, h, format, THREE.UnsignedByteType);
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, html = '', parent: HTMLElement = document.body) {
  const e = document.createElement(tag);
  e.className = className;
  e.innerHTML = html;
  parent.appendChild(e);
  return e;
}

export function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const e = root.querySelector<T>(sel);
  if (!e) throw new Error(`missing ${sel}`);
  return e;
}
