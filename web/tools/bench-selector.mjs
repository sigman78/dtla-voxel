// Isolated selector allocation/CPU comparison. Not a renderer/FPS benchmark.
// node --expose-gc tools/bench-selector.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import { Session } from 'node:inspector/promises';
import { stripTypeScriptTypes } from 'node:module';
import { execFileSync } from 'node:child_process';
import * as THREE from 'three';
const meta = JSON.parse(fs.readFileSync('public/data/meta.json','utf8'));
const report = {baseline:'98283fe',iterations:1000,samplingInterval:4096,
  note:'Node/V8 component microbenchmark. Includes collected allocations. Descriptor-pool construction excluded from hot-loop measurement; no FPS claim.',
  descriptorBound:meta.tiles.levels.reduce((n,l)=>n+l.nx*l.ny,0),results:[]};
const session = new Session(); session.connect();
try {
  for (const before of [true,false]) {
    const source = before ? execFileSync('git',['show','98283fe:web/src/tileSelection.ts'],{encoding:'utf8'}) : fs.readFileSync('src/tileSelection.ts','utf8');
    const ctx = vm.createContext({THREE});
    vm.runInContext(stripTypeScriptTypes(source).replace(/^import[\s\S]*?;\s*$/gm,'').replace(/^export /gm,'')+
      `\nglobalThis.select=${before?'selectTiles':'createTileSelector'};`,ctx);
    const select = before ? (...args)=>ctx.select(meta,...args) : ctx.select(meta);
    const camera = new THREE.PerspectiveCamera(28,1.6,.5,30000);
    camera.position.fromArray(meta.views.civic.pos);camera.lookAt(new THREE.Vector3(...meta.views.civic.target));camera.updateMatrixWorld();
    const light = new THREE.Vector3(.5,1,.5).normalize(), cost=()=>350000;
    let previous = new Set();
    for(let i=0;i<100;i++)previous=select(camera,1000,light,previous,cost).split;
    global.gc?.();
    await session.post('HeapProfiler.startSampling',{samplingInterval:4096,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
    const start = performance.now();
    for(let i=0;i<report.iterations;i++)previous=select(camera,1000,light,previous,cost).split;
    const elapsed = performance.now()-start;
    const {profile} = await session.post('HeapProfiler.stopSampling');
    let bytes=0;
    function sum(n){bytes+=n.selfSize;n.children.forEach(sum);}sum(profile.head);
    report.results.push({before,msPerSelection:elapsed/report.iterations,sampledBytesPerSelection:bytes/report.iterations});
  }
}finally{session.disconnect();}
fs.writeFileSync('../artifacts/profiling/gc-selector-followup.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
