import * as THREE from 'three';
import type { Meta } from './types';

// Model-derived rooftop markers, not surveyed fixture locations. One draw call;
// depth testing keeps lights behind buildings hidden, including through the halo.
export class ObstructionLights {
  private readonly points: THREE.Points;
  private readonly visibility: THREE.BufferAttribute;
  private readonly uniforms = { uNight: { value: 0 }, uTime: { value: 0 }, uPixelRatio: { value: 1 } };
  private readonly lights: NonNullable<Meta['obstructionLights']>;

  constructor(scene: THREE.Scene, meta: Meta, level: number) {
    this.lights = (meta.obstructionLights ?? []).filter(l => l.position.length === 3 && l.position.every(Number.isFinite));
    const positions: number[] = [], kinds: number[] = [], phases: number[] = [];
    for (const light of this.lights) {
      const [x, y, z] = light.position;
      // Coarse tiles can round their roof upward; keep the fixture above that roof.
      positions.push(x, Math.ceil(y / level) * level + 0.35, z);
      kinds.push(light.kind === 'beacon' ? 1 : 0);
      phases.push(light.phase);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('kind', new THREE.Float32BufferAttribute(kinds, 1));
    geometry.setAttribute('phase', new THREE.Float32BufferAttribute(phases, 1));
    this.visibility = new THREE.BufferAttribute(new Float32Array(this.lights.length), 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('enabled', this.visibility);
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthTest: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute float kind, phase, enabled;
        uniform float uNight, uTime, uPixelRatio;
        varying float vStrength;
        void main() {
          vec4 view = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * view;
          gl_PointSize = clamp(2400.0 / max(-view.z, 1.0), 3.0, 9.0) * uPixelRatio;
          // A gentle 30-flash/minute beacon; roof edge markers remain steady.
          float cycle = fract(uTime * 0.5 + phase);
          float pulse = smoothstep(0.0, 0.08, cycle) * (1.0 - smoothstep(0.28, 0.42, cycle));
          vStrength = uNight * enabled * mix(0.55, pulse, kind);
        }`,
      fragmentShader: `
        varying float vStrength;
        void main() {
          float radius = length(gl_PointCoord - vec2(0.5)) * 2.0;
          if (radius > 1.0 || vStrength < 0.001) discard;
          float core = 1.0 - smoothstep(0.1, 0.45, radius);
          float halo = 0.18 * pow(1.0 - radius, 2.0);
          gl_FragColor = vec4(vec3(3.0, 0.025, 0.005), (core + halo) * vStrength);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(geometry, material);
    this.points.name = 'Aviation obstruction lights';
    this.points.visible = false;
    scene.add(this.points);
  }

  update(seconds: number, night: number, pixelRatio: number, gate: (x: number, z: number) => boolean) {
    this.points.visible = night > 0.001 && this.lights.length > 0;
    if (!this.points.visible) return;
    this.uniforms.uNight.value = night;
    this.uniforms.uTime.value = seconds;
    this.uniforms.uPixelRatio.value = pixelRatio;
    let changed = false;
    this.lights.forEach((light, i) => {
      const value = gate(light.position[0], light.position[2]) ? 1 : 0;
      if (this.visibility.getX(i) !== value) { this.visibility.setX(i, value); changed = true; }
    });
    if (changed) this.visibility.needsUpdate = true;
  }
}
