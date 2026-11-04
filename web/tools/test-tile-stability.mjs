import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import * as THREE from 'three';

const source = fs.readFileSync('src/tileSelection.ts', 'utf8');
const ctx = vm.createContext({ THREE });
vm.runInContext(stripTypeScriptTypes(source).replace(/^import[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '') +
  '\nglobalThis.create = createTileSelector;', ctx);
const meta = JSON.parse(fs.readFileSync('public/data/meta.json', 'utf8'));
const camera = new THREE.PerspectiveCamera(28, 1.6, .5, 30000);
let comparisons = 0;
for (const view of Object.values(meta.views)) {
  const select = ctx.create(meta);
  camera.position.fromArray(view.pos);
  camera.lookAt(new THREE.Vector3(...view.target));
  const light = new THREE.Vector3(.5, 1, .5).normalize();
  let previous = new Set();
  for (let i = 0; i < 3; i++) previous = select(camera, 1000, light, previous, () => 350000).split;
  for (let i = 0; i < 20; i++) {
    camera.position.x = view.pos[0] + Math.sin(i) * .5;
    light.x = .4 + Math.sin(i) * .001;
    const result = select(camera, 1000, light, previous, () => 350000);
    const lost = [...previous].filter(key => !result.split.has(key));
    assert.ok(lost.length <= 2, `small motion lost ${lost.length} refinements`);
    assert.ok(result.leaves.length <= 384);
    assert.ok(result.estimatedBytes <= 128 * 1024 ** 2);
    previous = result.split;
    comparisons++;
  }
}
console.log(`${comparisons} small-motion selections remain stable within tile/memory budgets`);

// Controlled projected sizes and timestamps: transient demand must not cause
// requests, but a stationary view must eventually refine after its dwell.
const small = {W:256,D:256,H:100,tiles:{N:128,levels:[{s:2,nx:1,ny:1},{s:1,nx:2,ny:2}]}};
const testCamera = new THREE.PerspectiveCamera(60, 1, .5, 30000);
testCamera.position.set(128,50,1256);
testCamera.lookAt(128,50,128);
const select = ctx.create(small);
let prev = new Set();
const step = (height, now, maxLeaves=4) => {
  const result = select(testCamera,height,new THREE.Vector3(0,-1,0),prev,()=>100,maxLeaves,1000,now);
  prev = result.split;
  return result;
};
assert.equal(step(1000,0).leaves.length,1);
assert.equal(step(1400,100).pendingRefinement,true);
assert.equal(step(1400,499).leaves.length,1);
assert.equal(step(1000,500).pendingRefinement,false,'leaving entry threshold cancels pending upgrade');
assert.equal(step(1400,600).leaves.length,1);
assert.equal(step(1400,999).leaves.length,1,'a new attempt needs a full dwell');
assert.equal(step(1400,1000).leaves.length,4,'stationary demand upgrades at 400ms');
assert.equal(step(1100,1100).leaves.length,4,'separate exit threshold retains upgraded detail');
assert.equal(step(800,1200).leaves.length,1,'crossing exit threshold permits downgrade');
assert.equal(step(1400,1300,1).pendingRefinement,false,'budget-blocked demand does not poll forever');
assert.equal(step(1400,2000).leaves.length,1,'budget relief starts a fresh dwell');
assert.equal(step(1400,2400).leaves.length,4);
const first = ctx.create(small)(testCamera,1400,new THREE.Vector3(0,-1,0),new Set(),()=>100,4,1000,0);
assert.equal(first.leaves.length,4,'startup is immediate');
step(800,2500);
testCamera.position.z=300;
assert.equal(step(1400,2600).leaves.length,4,'near-camera data is immediate');
console.log('Passed: upgrade dwell, cancellation/reset, stationary completion, exit hysteresis, budget limits, startup and proximity');
