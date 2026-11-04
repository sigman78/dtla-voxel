import { BALANCED_PROFILE } from './performanceProfile';
import * as THREE from 'three';
import type { TileStreamer } from './stream';
import type { SelectedTile } from './tileSelection';
import type { Meta } from './types';

// Shadow meshes share the streamer's buffers. They enter traversal only inside
// the shadow pass: layers alone cannot do this because Three uses the viewing
// camera's layer mask for both the color and shadow passes.
export class ShadowTiles {
  readonly group = new THREE.Group();
  private readonly proxies = new Map<string, THREE.Mesh>();
  private readonly next = new Set<string>();
  private readonly box = new THREE.Box3();
  private readonly nearest = new THREE.Vector3();
  private readonly refined = new Set<string>();
  private readonly nextRefined = new Set<string>();

  constructor(
    private readonly streamer: TileStreamer,
    private readonly meta: Meta,
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    readonly minimumLevel = BALANCED_PROFILE.shadows.minimumLevel,
    private readonly profile = BALANCED_PROFILE.shadows,
  ) {
    this.group.name = 'Shadow tile proxies';
    this.group.visible = false;
    scene.add(this.group);
    const install = () => {
      const render = renderer.shadowMap.render.bind(renderer.shadowMap);
      renderer.shadowMap.render = (...args) => {
        this.group.visible = streamer.group.visible;
        try { return render(...args); }
        finally { this.group.visible = false; }
      };
    };
    install();
    // Three replaces its shadow renderer after a WebGL context restoration.
    renderer.domElement.addEventListener('webglcontextrestored', install);
  }

  update(roots: SelectedTile[], camera: THREE.Camera) {
    const S = this.streamer, next = this.next;
    next.clear();
    this.nextRefined.clear();
    const ready = (n: SelectedTile) => S.nodes.get(n.key)?.state === 'ready'
      && (n.s !== 1 || S.nodes.get(S.foliageKey(n.tx, n.ty))?.state === 'ready');
    const covered = (n: SelectedTile): boolean => ready(n) || (n.children.length > 0 && n.children.every(covered));
    const visit = (n: SelectedTile) => {
      const [x0, z0, x1, z1] = S.bounds(n.s, n.tx, n.ty);
      this.box.min.set(x0, 0, z0); this.box.max.set(x1, this.meta.H, z1);
      const distance = this.box.clampPoint(camera.position, this.nearest).distanceTo(camera.position);
      // Keep exact nearby silhouettes; use a wider exit band to avoid toggling
      // shadow detail as the camera crosses the proximity boundary.
      const near = distance < (this.refined.has(n.key) ? this.profile.nearExitDistance : this.profile.nearEnterDistance);
      const refine = n.s > this.minimumLevel || near;
      if (n.children.length && n.children.every(covered) && (refine || !ready(n))) {
        this.nextRefined.add(n.key);
        for (const child of n.children) visit(child);
      } else if (ready(n)) next.add(n.key);
    };
    for (const root of roots) visit(root);
    this.refined.clear();
    for (const key of this.nextRefined) this.refined.add(key);

    let changed = next.size !== S.shadowKeys.size;
    for (const key of next) if (!S.shadowKeys.has(key)) changed = true;
    for (const [key, mesh] of this.proxies) if (!next.has(key)) {
      this.group.remove(mesh);
      this.proxies.delete(key); // Buffer ownership stays with the streamer.
    }
    for (const key of next) {
      const source = S.nodes.get(key)?.mesh;
      if (!source) continue; // Empty tiles still count as coverage.
      let proxy = this.proxies.get(key);
      if (!proxy) {
        proxy = source.clone(false);
        // Object3D.clone does not copy these hooks; packed quads need them to
        // reconstruct real vertices instead of casting their four dummy ones.
        proxy.customDepthMaterial = source.customDepthMaterial;
        proxy.customDistanceMaterial = source.customDistanceMaterial;
        proxy.name = `Shadow ${key}`;
        proxy.visible = proxy.castShadow = true;
        proxy.receiveShadow = false;
        this.group.add(proxy);
        this.proxies.set(key, proxy);
      }
      proxy.material = source.material;
    }
    // Pin source buffers independently of visible tiles until proxies change.
    S.shadowKeys.clear();
    for (const key of next) S.shadowKeys.add(key);
    return changed;
  }
}
