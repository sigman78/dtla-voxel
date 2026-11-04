import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import * as THREE from 'three';
const ctx=vm.createContext({THREE});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync('src/tileMesh.ts','utf8')).replace(/^import.*;$/gm,'').replace(/^export /gm,'')+'\nglobalThis.TileMesh=TileMesh;',ctx);
const frustum=new THREE.Frustum(...[
  [1,0,0,10],[-1,0,0,10],[0,1,0,10],[0,-1,0,10],[0,0,1,10],[0,0,-1,10],
].map(([x,y,z,d])=>new THREE.Plane(new THREE.Vector3(x,y,z),d)));
const geometry=new THREE.BoxGeometry(2,2,400);geometry.computeBoundingBox();geometry.computeBoundingSphere();
const mesh=new ctx.TileMesh(geometry,new THREE.MeshBasicMaterial());
mesh.position.x=100;mesh.updateMatrixWorld();
assert(THREE.Mesh.prototype.intersectsFrustum.call(mesh,frustum),'loose sphere includes offscreen tile');
assert.equal(mesh.intersectsFrustum(frustum),false,'tight box excludes it');
mesh.position.x=11;mesh.updateMatrixWorld();assert(mesh.intersectsFrustum(frustum),'touching the boundary is retained');
mesh.position.x=12;mesh.updateMatrixWorld();assert.equal(mesh.intersectsFrustum(frustum),false);
mesh.rotation.y=Math.PI/2;mesh.updateMatrixWorld();assert(mesh.intersectsFrustum(frustum),'bounds respect world rotation');
const clone=mesh.clone(false);clone.updateMatrixWorld();assert(clone instanceof ctx.TileMesh);assert(clone.intersectsFrustum(frustum));
clone.rotation.y=0;clone.position.x=100;clone.updateMatrixWorld();assert.equal(clone.intersectsFrustum(frustum),false);
assert(mesh.intersectsFrustum(frustum),'clone culling scratch is independent');
const lightFrustum=frustum.clone();lightFrustum.planes[0].constant=-90;lightFrustum.planes[1].constant=110;
assert(clone.intersectsFrustum(lightFrustum),'offscreen casters remain in the light frustum');
console.log('Passed: tighter bounds, edge inclusion, world transforms, cloned proxies and independent light frustum');
