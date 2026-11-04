import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import * as THREE from 'three';
const source=fs.readFileSync('src/daylight.ts','utf8');
const ctx=vm.createContext({THREE,clamp:(x,a,b)=>Math.min(b,Math.max(a,x))});
vm.runInContext(stripTypeScriptTypes('class Fit {\n'+source.slice(source.indexOf('  fitShadow(')))+'\nglobalThis.Fit=Fit;',ctx);
let redraws=0;
const fit=new ctx.Fit();Object.assign(fit,{
  sun:new THREE.DirectionalLight(),lightDir:new THREE.Vector3(.5,1,.5).normalize(),sunY:.8,
  shadowX:NaN,shadowZ:NaN,shadowRadius:NaN,shadowMapSize:0,shadowHeight:NaN,
  shadowCenter:new THREE.Vector3(),shadowUp:new THREE.Vector3(0,1,0),shadowInverse:new THREE.Matrix4(),
  shadowCorner:new THREE.Vector3(),shadowBounds:new THREE.Box3(),invalidateShadow:()=>redraws++,
});
fit.sun.shadow.mapSize.set(8192,8192);
const camera=new THREE.PerspectiveCamera(),focus=new THREE.Vector3(2100,0,1800);
const map=new THREE.Box3(new THREE.Vector3(),new THREE.Vector3(4200,364,3600));
camera.position.set(2500,523,1800);
const update=()=>fit.fitShadow(focus,camera,camera.position.distanceTo(focus),map);
update();assert.equal(redraws,1);
for(let i=0;i<200;i++){
  const a=i*.01;camera.position.set(2100+Math.cos(a)*400,523,1800+Math.sin(a)*400);focus.x=2100+Math.sin(i)*.2;update();
}
assert.equal(redraws,1,'orbit and sub-metre damping must reuse world-space shadows');
focus.x+=fit.shadowRadius*2;camera.position.x+=fit.shadowRadius*2;update();assert.equal(redraws,2,'escaping coverage refits immediately');
fit.shadowRadius=NaN;update();assert.equal(redraws,3,'sun direction changes invalidate fit');
fit.sun.shadow.mapSize.set(4096,4096);update();assert.equal(redraws,4,'shadow resolution changes refit');
camera.position.copy(focus).add(new THREE.Vector3(0,100,100));update();assert.equal(redraws,5,'substantial zoom restores shadow resolution');
update();assert.equal(redraws,5);
// Low sun must not amplify receiver bias into a detached ground shadow, even
// with a wide fit or a smaller map on a constrained GPU.
for(const size of [2048,4096,8192])for(const elevation of [.05,.1,.25,.8,1]){
  fit.sun.shadow.mapSize.set(size,size);
  fit.sunY=elevation;fit.lightDir.set(Math.sqrt(1-elevation*elevation),elevation,0);
  camera.position.copy(focus).add(new THREE.Vector3(0,1800,1800));
  fit.shadowRadius=NaN;update();
  const sh=fit.sun.shadow;
  const normalGap=sh.normalBias*Math.sqrt(1-elevation*elevation)/elevation;
  const depthGap=Math.abs(sh.bias)*(sh.camera.far-sh.camera.near)/elevation;
  assert(normalGap+depthGap<=.400001,'bias-induced ground gap must stay below 40 cm');
  assert(sh.normalBias>0&&sh.bias<0,'retain acne protection');
}
console.log('Passed: 200 orbit/damping frames reuse shadows; coverage escape, sunlight, resolution and zoom still refit');
console.log('Passed: bounded contact offset across sunlight elevations and 2K/4K/8K shadow maps');
