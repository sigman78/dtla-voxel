// Differential hot-path behavior against main before allocation work.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { execFileSync } from 'node:child_process';
import * as THREE from 'three';
const baseline = 'cf1c7e1';
const source = (file, old) => old ? execFileSync('git', ['show', `${baseline}:web/src/${file}`], {encoding:'utf8'}) : fs.readFileSync(`src/${file}`,'utf8');
function load(file, name, old, globals = {}) {
  const input = source(file,old).replace(/constructor\(([\s\S]*?)\) \{/g, (_, params) => {
    const fields = [...params.matchAll(/private readonly (\w+)/g)].map(m=>m[1]);
    return `constructor(${params.replace(/private readonly /g,'')}) {${fields.map(f=>`this.${f}=${f};`).join('')}`;
  });
  const code = stripTypeScriptTypes(input).replace(/^import[\s\S]*?;\s*$/gm,'').replace(/^export /gm,'');
  const context = vm.createContext({THREE,...globals});
  vm.runInContext(`${code}\nglobalThis.result=${name};`,context);
  return {Class:context.result,context};
}
const meta = JSON.parse(fs.readFileSync('public/data/meta.json','utf8'));
const selector = [true,false].map(old=>load('tileSelection.ts','selectTiles',old).Class);
const pooled = load('tileSelection.ts','createTileSelector',false).Class(meta);
const camera = new THREE.PerspectiveCamera(28,1.6,.5,30000);
let previous = new Set();
for (const view of Object.values(meta.views)) for (const maxLeaves of [64,200,384]) {
  camera.position.fromArray(view.pos);camera.lookAt(new THREE.Vector3(...view.target));camera.updateMatrixWorld();
  const args = [meta,camera,1000,new THREE.Vector3(.5,1,.5).normalize(),previous,()=>350000,maxLeaves,128*1024**2];
  const [a,b] = selector.map(select=>select(...args));
  const snapshot = s=>JSON.stringify({leaves:s.leaves.map(n=>n.key),split:[...s.split],bytes:s.estimatedBytes});
  assert.equal(snapshot(a),snapshot(b));previous=b.split;
}
let pooledPrevious = new Set();
const identities = new Map();
for(let pass=0;pass<4;pass++) for(const view of Object.values(meta.views)) {
  camera.position.fromArray(view.pos); camera.lookAt(new THREE.Vector3(...view.target)); camera.updateMatrixWorld();
  const args=[camera,900,new THREE.Vector3(.5,1,.5).normalize(),pooledPrevious,(_key,s)=>s===1?600000:350000,pass%2?80:384,64*1024**2];
  const expected=selector[0](meta,...args), actual=pooled(...args);
  const snapshot=s=>JSON.stringify({leaves:s.leaves.map(n=>n.key),split:[...s.split],bytes:s.estimatedBytes});
  assert.equal(snapshot(actual),snapshot(expected),'reused selector must preserve tree/hysteresis/budgets');
  function visit(n) {
    if(identities.has(n.key))assert.equal(n,identities.get(n.key),'descriptor identity must be reused');
    else identities.set(n.key,n);
    n.children.forEach(visit);
  }actual.roots.forEach(visit);
  pooledPrevious=actual.split;
}

function element(cls='') {
  const classes = new Set(cls.split(' ').filter(Boolean));
  return {style:{},offsetWidth:160,offsetHeight:30,addEventListener(){},remove(){},
    classList:{toggle(c,on){if(on)classes.add(c);else classes.delete(c);}},classes};
}
let clock = 0;
const labelRuns = [true,false].map(old=>{
  const {Class,context}=load('labels.ts','Labels',old,{document:{},performance:{now:()=>clock},innerWidth:1200,innerHeight:800,
    $:()=>element(),el:(_tag,cls)=>element(cls),esc:String});
  return {labels:new Class(meta.labels,()=>{}),context};
});
const bar={width:340,left:14,right:354,top:14,bottom:112};
const obstacles=[{x0:10,x1:330,y0:700,y1:790}];
const world={raycast:(p,d,dist)=>d.x>.2?dist*.4:Infinity};
for (let i=0;i<240;i++) {
  clock=i*20;
  const view=Object.values(meta.views)[Math.floor(i/30)%Object.keys(meta.views).length];
  camera.position.fromArray(view.pos);camera.position.x+=Math.sin(i*.2)*80;
  camera.lookAt(new THREE.Vector3(...view.target));camera.updateMatrixWorld();
  for (const run of labelRuns) {
    if (i===70)run.labels.pin({name:'Picked place',kind:'test',x:2000,y:800,z:90});
    if (i===140)run.labels.pin(null);
    run.labels.update(camera,world,bar,obstacles);
  }
  const snapshot=labels=>JSON.stringify(labels.pins.map(p=>({on:p.on,side:p.side,since:p.since,shift:p.shift,occluded:p.occluded,
    transform:p.el.style.transform,left:p.txt.style.left,classes:[...p.el.classes].sort()})));
  assert.equal(snapshot(labelRuns[0].labels),snapshot(labelRuns[1].labels),`labels frame ${i}`);
}
const rays=[0,0];
let unobstructed=false;
const worlds=rays.map((_,i)=>({version:0,raycast:(p,d,dist)=>{rays[i]++;return !unobstructed && d.x>.2?dist*.4:Infinity;}}));
const labelSnapshot=labels=>JSON.stringify(labels.pins.map(p=>({on:p.on,side:p.side,since:p.since,occluded:p.occluded,transform:p.el.style.transform,classes:[...p.el.classes].sort()})));
let visibilityVersion=0;
function staticFrames(count, controlBar=bar) {
  for(let i=0;i<count;i++) {
    clock+=20;
    labelRuns.forEach((run,j)=>run.labels.update(camera,worlds[j],controlBar,obstacles,visibilityVersion));
    assert.equal(labelSnapshot(labelRuns[0].labels),labelSnapshot(labelRuns[1].labels),'settled labels and invalidation');
  }
}
staticFrames(150);
const settledRays=rays[1];
staticFrames(50);
assert.equal(rays[1],settledRays,'settled labels must stop raycasting');
assert(rays[0]>rays[1]);
unobstructed=true;worlds.forEach(w=>w.version++);staticFrames(100);
assert(rays[1]>settledRays,'new query data must restart occlusion checks');
labelRuns.forEach(run=>{run.labels.gate=()=>false;});visibilityVersion++;staticFrames(30);
labelRuns.forEach(run=>{run.labels.gate=()=>true;});visibilityVersion++;staticFrames(100);
staticFrames(100,{...bar,bottom:200});

const navRuns=[true,false].map(old=>{
  const {Class}=load('nav.ts','Nav',old,{addEventListener(){},document:{},clamp:(x,a,b)=>Math.min(b,Math.max(a,x))});
  const camera=new THREE.PerspectiveCamera();camera.position.set(2000,400,1500);
  const controls={target:new THREE.Vector3(2000,40,2000),getPolarAngle:()=>1};
  const nav=new Class(camera,controls,element(),()=>{});
  nav.world={groundAt:()=>20,raycast:()=>Infinity,inside:()=>true};
  return {nav,camera,controls};
});
for(let i=0;i<120;i++) {
  for(const {nav} of navRuns) {
    nav.keys.clear();nav.keys.add(i<60?'f':'b');if(i%3===0)nav.keys.add('tl');
    nav.update(1/60);nav.clamp();
    if(i%20===0)nav.retarget();if(i%10===0)nav.orbitBy(.03);
  }
  assert.deepEqual(navRuns[0].camera.position.toArray(),navRuns[1].camera.position.toArray());
  assert.deepEqual(navRuns[0].controls.target.toArray(),navRuns[1].controls.target.toArray());
}
console.log('Passed: exact selector order/budgets, 32 pooled-selector transitions, 770 label frames including settled/invalidation, 120 navigation frames');
