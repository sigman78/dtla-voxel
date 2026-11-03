import * as THREE from 'three';
import { Sky } from './sky';
import { beam, sunAt } from './sun';
import { clamp, lerp, smooth } from './util';
import type { VoxelUniforms } from './voxelMaterial';

// Share of windows lit after dark: up to ~45 % in the evening (whenever dusk falls), down to ~20 % at 2 am and
// ~12 % before dawn; next to nothing by day (night: 0 by day .. 1 after dusk)
export function litShare(hour: number, night: number) {
  const h = ((hour % 24) + 24) % 24;
  const curve = h >= 12 ? (h < 22 ? 0.45 : lerp(0.45, 0.2, (h - 22) / 4))
    : h < 2 ? lerp(0.325, 0.2, h / 2) : h < 5 ? lerp(0.2, 0.12, (h - 2) / 3) : lerp(0.12, 0.25, smooth(5, 6.5, h));
  return curve * (0.06 + 0.94 * night);
}

export class Daylight {
  hour = 0;
  exposure = 1.15;
  day = 306;
  night = 0;
  readonly sky = new Sky();
  uniforms: VoxelUniforms | null = null;
  bloom: { intensity: number } | null = null;
  private readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  private readonly hemi = new THREE.HemisphereLight(0xbfd6ff, 0x6b5a48, 0.6);
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly lightDir = new THREE.Vector3(0, 1, 0);
  private env: THREE.WebGLRenderTarget | null = null;
  private envKey = '';
  private shadowKey = '';
  private readonly shadowView = new THREE.Matrix4();
  private readonly shadowProjection = new THREE.Matrix4();
  private northTheta = 0;
  private sunY = 1;

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly scene: THREE.Scene) {
    const sun = this.sun, size = Math.min(8192, renderer.capabilities.maxTextureSize);
    sun.castShadow = true;
    renderer.shadowMap.autoUpdate = false;
    this.invalidateShadow();
    sun.shadow.mapSize.set(size, size);
    sun.shadow.bias = -0.0004;
    sun.shadow.radius = 3;
    scene.add(sun, sun.target, this.hemi, this.sky.mesh);
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

  // Both gates must be opened: the renderer skips the shadow pass while the scene is unchanged.
  invalidateShadow() { this.renderer.shadowMap.needsUpdate = this.sun.shadow.needsUpdate = true; }

  // the grid is turned (meta.theta_deg): compass bearings turn by theta in the scene
  set theta(t: number) { this.northTheta = t; this.apply(this.hour); }

  // a compass bearing (0 north, clockwise) and elevation as a direction in the scene
  skyDir(az: number, el: number) {
    const a = az + this.northTheta;
    return new THREE.Vector3(Math.sin(a) * Math.cos(el), Math.sin(el), -Math.cos(a) * Math.cos(el));
  }

  apply(hour: number) {
    this.hour = hour;
    const { el, az } = sunAt(this.day, hour), elDeg = el * 180 / Math.PI;
    const night = this.night = 1 - smooth(-7, 1, elDeg), day = 1 - night;
    const deep = smooth(-9, -17, elDeg), golden = 1 - smooth(8, 34, elDeg);
    const dir = elDeg > -2 ? this.skyDir(az, Math.max(el, 2.5 * Math.PI / 180)) : new THREE.Vector3(0.45, 0.75, 0.5).normalize(); // the moon, high in the SE
    const sun = this.sun, hemi = this.hemi;
    const T = beam(elDeg), lumT = T[0] * 0.2126 + T[1] * 0.7152 + T[2] * 0.0722, sinEl = Math.max(0, Math.sin(el));
    const sky = Math.max(0.22 * sinEl * (1 - lumT), 0.025 * smooth(-7, 2, elDeg)), sunH = lumT * sinEl;
    const adapt = clamp((0.62 / (sunH + sky)) ** 0.72, 1, 8);
    // a touch warmer than the beam alone: the dry, dusty light of the basin
    sun.color.setRGB(1, T[1] / T[0] * 0.97, T[2] / T[0] * 0.9).lerp(new THREE.Color(0xa8acd0), night);
    sun.intensity = lerp(5.9 * lumT * adapt, 0.5, night) * (elDeg > -2 ? smooth(-2, 1, elDeg) * day + night : night);
    this.sunY = dir.y; // shadow biases are sized in fitShadow, from the shadow map's texel
    const skyRel = sky / 0.075 * adapt;
    hemi.color.setRGB(0.68, 0.8, 0.98).lerp(new THREE.Color(1, 0.78, 0.62), golden * 0.5)
      .lerp(new THREE.Color(0x4a447e).lerp(new THREE.Color(0x3e3648), deep), night);
    hemi.groundColor.copy(sun.color).multiplyScalar(0.42).lerp(new THREE.Color(0x4e3a2a), night);
    hemi.intensity = lerp(0.14 * skyRel, lerp(0.95, 0.5, deep), night);
    this.sky.set({ elDeg, sunDir: dir, trueSun: this.skyDir(az, el), golden, night, deep });
    this.lightDir.copy(dir);
    this.shadowKey = '';
    if (this.uniforms) {
      this.uniforms.uNight.value = night;
      this.uniforms.uLit.value = litShare(hour, night);
      this.uniforms.uHorizon.value.copy(this.sky.horizon);
    }
    if (this.bloom) this.bloom.intensity = lerp(0.18, 0.95, night);
    this.scene.fog = new THREE.Fog(this.sky.horizon.clone(), 2400, 9000);
    const key = (elDeg / 0.6).toFixed(0);
    if (key !== this.envKey) {
      this.env?.dispose();
      this.env = this.pmrem.fromScene(this.sky.envScene(), 0, 1, 10000);
      this.scene.environment = this.env.texture;
      this.envKey = key;
    }
    this.scene.environmentIntensity = lerp(0.38 * Math.min(skyRel, 2), lerp(0.55, 0.3, deep), night);
    const e = lerp(this.exposure, 1, night);
    sun.intensity *= e; hemi.intensity *= e; this.scene.environmentIntensity *= e;
  }

  // haze: thicker than Warsaw's, starting nearer, but never on what the camera looks at
  setFogFrom(dist: number) {
    const fog = this.scene.fog as THREE.Fog | null;
    if (!fog) return;
    fog.near = Math.max(2400, dist);
    fog.far = fog.near + 6500;
  }

  fitShadow(focus: THREE.Vector3, camera: THREE.Camera, viewDist: number, map: THREE.Box3) {
    if (map.isEmpty()) return;
    // Refresh during navigation even when the snapped light fit stays the same.
    camera.updateMatrixWorld();
    if (!this.shadowView.equals(camera.matrixWorld) || !this.shadowProjection.equals(camera.projectionMatrix)) {
      this.shadowView.copy(camera.matrixWorld);
      this.shadowProjection.copy(camera.projectionMatrix);
      this.invalidateShadow();
    }
    const sun = this.sun, f = focus;
    const dist = viewDist + Math.max(0, camera.position.y - (map.min.y + 80));
    const R = clamp(dist * 1.15, 300, Math.max(map.max.x, map.max.z) * 0.75), texel = (2 * R) / sun.shadow.mapSize.x;
    const L = this.lightDir;
    const key = `${Math.round(f.x / (texel * 8))},${Math.round(f.z / (texel * 8))},${R.toFixed(0)},${L.x.toFixed(4)},${L.y.toFixed(4)}`;
    if (key === this.shadowKey) return;
    this.shadowKey = key;
    const c = new THREE.Vector3(f.x, 0, f.z);
    sun.target.position.copy(c);
    sun.position.copy(c).addScaledVector(L, 2500);
    sun.updateMatrixWorld(); sun.target.updateMatrixWorld();
    const inv = new THREE.Matrix4().lookAt(sun.position, c, new THREE.Vector3(0, 1, 0)).invert(), pts = [];
    for (const x of [f.x - R, f.x + R]) for (const z of [f.z - R, f.z + R]) for (const y of [0, map.max.y]) pts.push(new THREE.Vector3(x, y, z).sub(sun.position).applyMatrix4(inv));
    const b = new THREE.Box3().setFromPoints(pts), snap = (v: number) => Math.floor(v / texel) * texel, cam = sun.shadow.camera;
    cam.left = snap(b.min.x); cam.right = cam.left + Math.ceil((b.max.x - b.min.x) / texel) * texel;
    cam.bottom = snap(b.min.y); cam.top = cam.bottom + Math.ceil((b.max.y - b.min.y) / texel) * texel;
    cam.near = Math.max(1, -b.max.z - 700); // towers outside the square still cast into it
    cam.far = -b.min.z + 10;
    cam.updateProjectionMatrix();
    // biases as world distances of about a texel: fixed values (0.5-3 m normal offset, a 0.0004 depth bias over a
    // ~2 km depth range) detached close-up shadows from their casters by most of a voxel
    const slope = Math.sqrt(clamp(1 / Math.max(this.sunY, 0.1), 1, 6));
    sun.shadow.normalBias = clamp(texel * 1.2 * slope, 0.04, 2.5);
    sun.shadow.bias = -clamp(texel * 1.5 * slope, 0.03, 2) / (cam.far - cam.near);
    this.invalidateShadow();
  }
}
