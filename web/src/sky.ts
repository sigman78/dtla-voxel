import * as THREE from 'three';
import { clamp } from './util';
import horizonUrl from './assets/horizon.bin?url';

const VERT = `varying vec3 vDir;
void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); gl_Position.z = gl_Position.w * 0.99999; }`;

// A basin sky: pale cyan-blue overhead, warm cream at the horizon under a low amber-pink haze band (the marine
// layer and the smog); the afterglow over the set sun, a purple-pink belt at dusk, the city's orange glow at night,
// a few streaks of cirrus and hardly any stars.
const FRAG = `
uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uHorizon; uniform vec3 uWarm; uniform float uGolden; uniform vec3 uGround; uniform vec3 uHaze;
uniform vec3 uSunDir; uniform vec3 uTrueSun; uniform vec3 uSunCol; uniform float uNight; uniform float uDeep;
uniform vec3 uAfterglow; uniform vec3 uDusk; uniform vec3 uCityGlow; uniform vec3 uCloudLit; uniform vec3 uCloudDark;
uniform sampler2D uRidge; uniform float uMountains; uniform float uNorth; uniform float uEye;
varying vec3 vDir;
float hash(vec3 p) { p = fract(p * 0.3183099 + .1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float a = 0.5, s = 0.; for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 3.1; a *= 0.5; } return s; }
void main() {
  vec3 d = normalize(vDir);
  float h = d.y, hp = max(h, 0.);
  vec2 sh = normalize(uSunDir.xz + 1e-5), dh = normalize(d.xz + 1e-5);
  float toward = pow(max(dot(sh, dh), 0.), 2.0);
  // cream at the horizon, through a pale cyan band (not the grey of peach mixed with blue) to the blue overhead
  vec3 col = mix(mix(uHorizon, uWarm, uGolden * (0.3 + 0.7 * toward)), uMid, smoothstep(0.0, 0.2, h));
  col = mix(col, uTop, smoothstep(0.12, 0.75, h));
  col = mix(col, uHaze, exp(-hp * 12.0) * 0.6);
  float tw = pow(max(dot(normalize(uTrueSun.xz + 1e-5), dh), 0.), 3.0);
  col += uAfterglow * tw * exp(-hp * 10.0);
  col += uDusk * exp(-abs(h - 0.14) * 7.0) * (0.45 + 0.55 * tw);
  col += uCityGlow * exp(-hp * 16.0);
  col = mix(col, uGround, smoothstep(0.0, -0.25, h));
  // Real distant terrain, sampled clockwise from true north. Half a texel puts
  // bearing zero at the first sample; RepeatWrapping interpolates across north.
  float mountain = 0.;
  float ridgeAA = max(fwidth(h), 0.00015);
  vec3 atmosphere = col;
  if (uMountains > 0. && h > -0.08 && h < 0.18) {
    float bearing = atan(d.x, -d.z) - uNorth;
    float row = (clamp(uEye / 500., 0., 7.) + 0.5) / 8.;
    vec4 ridge = texture2D(uRidge, vec2(bearing / 6.28318530718 + 0.5 / 2048., row));
    float elevation = dot(ridge.ba, vec2(256., 1.)) / 257. * 4095.;
    float slope = dot(ridge.rg, vec2(256., 1.)) / 257. * 0.4 - 0.25;
    float top = slope / sqrt(1. + slope * slope);
    // A readable crest with its base lost in basin haze, including elevated views.
    // A shared haze floor avoids vertical bands where the winning peak's
    // distance changes abruptly between adjacent bearings.
    float base = -uEye / 40000.;
    mountain = (1. - smoothstep(top - ridgeAA, top + ridgeAA, h))
      * smoothstep(base - 0.012, base + 0.025, h)
      * smoothstep(-0.08, -0.06, h)
      * (1. - smoothstep(3000., 3500., uEye))
      * smoothstep(150., 650., elevation) * uMountains;
    vec3 tint = mix(vec3(0.19, 0.25, 0.33), vec3(0.23, 0.17, 0.25), uGolden);
    tint = mix(tint, vec3(0.025, 0.025, 0.055), uNight);
    float contrast = mix(0.19, 0.24, uGolden) * mix(1., 0.55, uDeep);
    col = mix(col, mix(atmosphere, tint, contrast), mountain);
  }
  float s = max(dot(d, uSunDir), 0.);
  col += uSunCol * (pow(s, 600.) * 6. * (1. - mountain) + pow(s, 12.) * 0.4 + pow(s, 3.) * 0.14) * (1. - uNight);
  if (h > 0.02) {
    vec2 uv = d.xz / (h + 0.12) * 1.4;
    float f = fbm(uv * vec2(0.55, 2.4) + vec2(3.7, 1.2));
    float cov = smoothstep(0.6, 0.86, f) * smoothstep(0.04, 0.3, h) * 0.6;
    float under = 1. - smoothstep(0.02, 0.5, h);
    vec3 cl = mix(uCloudDark, uCloudLit, clamp(0.35 + 0.65 * under, 0., 1.)) + uAfterglow * tw * 0.8 + uDusk * 0.5;
    col = mix(col, cl, cov * (1. - mountain));
    if (uDeep > 0.01) col += vec3(step(0.998, hash(floor(d * 380.)))) * uDeep * 0.12 * smoothstep(0.15, 0.5, h) * (1. - cov) * (1. - mountain);
  }
  gl_FragColor = vec4(col, 1.);
  #include <colorspace_fragment>
}`;

const C = (h: number) => new THREE.Color(h);
const mixC = (a: THREE.Color, b: THREE.Color, t: number) => a.clone().lerp(b, clamp(t, 0, 1));

export interface SkyState {
  elDeg: number;
  sunDir: THREE.Vector3;
  trueSun: THREE.Vector3;
  golden: number;
  night: number;
  deep: number;
}

export class Sky {
  readonly horizon = C(0xf2e6d6);
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly u = {
    uTop: { value: C(0x7db4dc) }, uMid: { value: C(0xb4dce8) }, uHorizon: { value: C(0xf2e6d6) }, uGround: { value: C(0xcdbfa8) }, uHaze: { value: C(0xf0d2bc) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uTrueSun: { value: new THREE.Vector3(0, 1, 0) },
    uWarm: { value: C(0xffa070) }, uGolden: { value: 0 }, uSunCol: { value: C(0xfff0d0) }, uNight: { value: 0 },
    uDeep: { value: 0 }, uAfterglow: { value: C(0x000000) }, uDusk: { value: C(0x000000) }, uCityGlow: { value: C(0x000000) },
    uCloudLit: { value: C(0xffffff) }, uCloudDark: { value: C(0xe8e2dc) },
    uRidge: { value: new THREE.DataTexture(new Uint8Array(2048 * 8 * 4), 2048, 8) },
    uMountains: { value: 0 }, uNorth: { value: 0 }, uEye: { value: 100 },
  };
  private env: THREE.Scene | null = null;

  constructor() {
    const ridge = this.u.uRidge.value;
    ridge.wrapS = THREE.RepeatWrapping;
    ridge.minFilter = ridge.magFilter = THREE.LinearFilter;
    ridge.generateMipmaps = false;
    ridge.needsUpdate = true;
    this.material = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.u, side: THREE.BackSide, depthWrite: false, fog: false });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(6000, 48, 24), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
  }

  async loadHorizon(enabled: boolean) {
    if (!enabled) return;
    try {
      const response = await fetch(horizonUrl, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Horizon HTTP ${response.status}`);
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.length !== 2048 * 8 * 4) throw new Error('Invalid horizon profile');
      this.u.uRidge.value.image.data = data;
      this.u.uRidge.value.needsUpdate = true;
      this.u.uMountains.value = 1;
    } catch (error) { console.warn('Distant mountains unavailable', error); }
  }

  set north(value: number) { this.u.uNorth.value = value; }
  set eyeElevation(value: number) { this.u.uEye.value = value; }

  // golden: 0 high sun .. 1 low sun; night: 0 by day .. 1 after sunset; deep: 0 at blue hour .. 1 in full night
  set({ elDeg, sunDir, trueSun, golden, night, deep }: SkyState) {
    const u = this.u;
    const nightTop = mixC(C(0x1a1c52), C(0x0a0c2c), deep), nightHor = mixC(C(0x5a4a78), C(0x2a2a4c), deep);
    u.uTop.value.copy(mixC(mixC(C(0x7db4dc), C(0x8aa6d2), golden * 0.6), nightTop, night));
    u.uMid.value.copy(mixC(mixC(C(0xb4dce8), C(0xd8c8d0), golden * 0.8), mixC(C(0x3a3466), C(0x16142e), deep), night));
    u.uHorizon.value.copy(mixC(mixC(C(0xf2e6d6), C(0xffd2b0), golden * 0.7), nightHor, night));
    u.uHaze.value.copy(mixC(mixC(C(0xeee2d2), C(0xffb898), golden), mixC(C(0x8a5a7a), C(0x2c2a48), deep), night));
    u.uWarm.value.copy(mixC(C(0xffaa78), mixC(C(0x8a5a7a), C(0x2c2a48), deep), night));
    u.uGolden.value = golden;
    u.uGround.value.copy(mixC(mixC(C(0xd6cdbd), C(0xd8b49a), golden), C(0x14142a), night));
    u.uSunDir.value.copy(sunDir);
    u.uTrueSun.value.copy(trueSun);
    u.uSunCol.value.copy(mixC(C(0xfff0d0), C(0xff9248), golden));
    u.uNight.value = night;
    u.uDeep.value = deep;
    // after sunset: orange-pink over where the sun went, a purple-pink belt above it, fading out in the dark
    const afterglow = Math.max(0, 1 - Math.abs(elDeg + 2.5) / 10) * (elDeg < 3 ? 1 : 0);
    const dusk = Math.max(0, 1 - Math.abs(elDeg + 5) / 7);
    u.uAfterglow.value.copy(C(0xff8470)).multiplyScalar(0.45 * afterglow);
    u.uDusk.value.copy(C(0xa868c0)).multiplyScalar(0.3 * dusk);
    u.uCityGlow.value.copy(C(0xffa04a)).multiplyScalar(0.07 * night * (0.4 + 0.6 * deep));
    u.uCloudLit.value.copy(mixC(mixC(C(0xfff8f0), C(0xffc8a0), golden), mixC(C(0x6a5a80), C(0x2a2028), deep), night));
    u.uCloudDark.value.copy(mixC(mixC(C(0xe8e2dc), C(0xd8a8a0), golden), mixC(C(0x3a3456), C(0x14121c), deep), night));
    // by day a light cream-blue haze (the basin's smog is mostly gone); at golden hour it turns amber-pink
    this.horizon.copy(u.uHorizon.value).lerp(u.uMid.value, 0.18 * (1 - golden) * (1 - night)).lerp(u.uHaze.value, 0.35 + 0.15 * golden).lerp(u.uWarm.value, golden * 0.3 * (1 - night));
  }

  // a small copy of the sky to bake reflections from
  envScene() {
    if (!this.env) {
      this.env = new THREE.Scene();
      this.env.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), this.material));
    }
    return this.env;
  }
}
