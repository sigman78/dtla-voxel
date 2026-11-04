import * as THREE from 'three';

// Tile bounds come from actual emitted faces (including thin detail), not the
// packed geometry's dummy vertices. A box is tighter than the default sphere
// for broad, flat tiles and tall buildings. Each pass supplies its own frustum,
// so off-camera buildings can still cast shadows into the visible scene.
export class TileMesh extends THREE.Mesh {
  private readonly cullingBox = new THREE.Box3();

  override intersectsFrustum(frustum: THREE.Frustum) {
    const bounds = this.geometry.boundingBox;
    return bounds
      ? frustum.intersectsBox(this.cullingBox.copy(bounds).applyMatrix4(this.matrixWorld))
      : super.intersectsFrustum(frustum);
  }
}
