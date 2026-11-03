import * as THREE from 'three';
import { expandQuads } from './tileData';

export const QUAD_PARS = `
attribute vec3 qOrigin; attribute vec2 qSize; attribute float qPal; attribute vec2 qFlags;
vec3 quadPosition() {
  uint axis = (uint(qFlags.x) & 7u) >> 1u;
  uint corner = (uint(qFlags.y) >> (8u + uint(position.x) * 2u)) & 3u;
  vec2 uv = vec2(float(corner & 1u), float(corner >> 1u)) * qSize;
  return qOrigin + (axis == 0u ? vec3(0.0, uv.y, uv.x) : axis == 1u ? vec3(uv.y, uv.x, 0.0) : vec3(uv.x, 0.0, uv.y));
}
`;

export function makeQuadGeometry(records: Uint16Array, bounds: number[], packed: boolean) {
  const geo = packed ? new THREE.InstancedBufferGeometry() : new THREE.BufferGeometry();
  const quads = records.length / 8;
  if (geo instanceof THREE.InstancedBufferGeometry) {
    geo.instanceCount = quads;
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0], 3));
    const buffer = new THREE.InstancedInterleavedBuffer(records, 8, 1);
    geo.setAttribute('qOrigin', new THREE.InterleavedBufferAttribute(buffer, 3, 0));
    geo.setAttribute('qSize', new THREE.InterleavedBufferAttribute(buffer, 2, 3));
    geo.setAttribute('qPal', new THREE.InterleavedBufferAttribute(buffer, 1, 5));
    geo.setAttribute('qFlags', new THREE.InterleavedBufferAttribute(buffer, 2, 6));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
  } else {
    const { pos, attr, pal } = expandQuads(records);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('vattr', new THREE.BufferAttribute(attr, 3));
    geo.setAttribute('vpal', new THREE.BufferAttribute(pal, 1));
    const index = quads * 4 <= 65535 ? new Uint16Array(quads * 6) : new Uint32Array(quads * 6);
    for (let q = 0; q < quads; q++) index.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
    geo.setIndex(new THREE.BufferAttribute(index, 1));
  }
  geo.boundingBox = new THREE.Box3(new THREE.Vector3(...bounds.slice(0, 3)), new THREE.Vector3(...bounds.slice(3, 6)));
  geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
  return geo;
}

export function makeQuadDepthMaterial(distance = false) {
  const mat = distance
    ? new THREE.MeshDistanceMaterial()
    : new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + QUAD_PARS)
      .replace('#include <begin_vertex>', 'vec3 transformed = quadPosition();');
  };
  mat.customProgramCacheKey = () => 'voxel-quad-depth-v1';
  return mat;
}

export function geometryBytes(geo: THREE.BufferGeometry) {
  const buffers = new Set<ArrayBufferLike>();
  for (const a of Object.values(geo.attributes))
    buffers.add(a instanceof THREE.InterleavedBufferAttribute ? a.data.array.buffer : a.array.buffer);
  if (geo.index) buffers.add(geo.index.array.buffer);
  return [...buffers].reduce((sum, b) => sum + b.byteLength, 0);
}
