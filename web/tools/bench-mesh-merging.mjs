// Offline diagnostic only: how much do surface attributes limit greedy merging?
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const clean=s=>stripTypeScriptTypes(s).replace(/^import[\s\S]*?;\s*$/gm,'').replace(/^export /gm,'');
const data=fs.readFileSync('src/tileData.ts','utf8'),worker=fs.readFileSync('src/mesher.worker.ts','utf8');
const key='((ang * 4096 + a) * 256 + aob) * 256 + gm + 1';
const variants={original:key,noAO:'((ang * 4096 + a) * 256 + 255) * 256 + gm + 1',shadowOnly:'255 * 256 + 1'};
const api={};
for(const [name,value] of Object.entries(variants)){
  const ctx=vm.createContext({self:{},console,AbortController});
  vm.runInContext(clean(data)+'\n'+clean(worker.replace(key,value))+'\nglobalThis.api={decodeTile,compactColumns,meshTile};',ctx);
  api[name]=ctx.api;
}
const read=(level,file)=>{const b=gunzipSync(fs.readFileSync(`public/data/tiles/${level}/${file}`));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
// Canonical oriented face coverage, independent of rectangle partition, palette
// and AO diagonal. Merge row intervals to verify no surfaces were removed.
const coverage=records=>{
  const rows=new Map(),axes=[0,2,1];
  for(let i=0;i<records.length;i+=8){
    const normal=records[i+6]&7,d=normal>>1,u=axes[(d+1)%3],v=axes[(d+2)%3];
    for(let row=records[i+v];row<records[i+v]+records[i+4];row++){
      const key=`${normal}/${records[i+axes[d]]}/${row}`;
      if(!rows.has(key))rows.set(key,[]);
      rows.get(key).push([records[i+u],records[i+u]+records[i+3]]);
    }
  }
  const hash=createHash('sha256');
  for(const key of [...rows.keys()].sort()){
    const intervals=rows.get(key).sort((a,b)=>a[0]-b[0]);const merged=[];
    for(const [a,b] of intervals){const last=merged.at(-1);if(last&&a<=last[1])last[1]=Math.max(last[1],b);else merged.push([a,b]);}
    hash.update(key+JSON.stringify(merged));
  }
  return hash.digest('hex');
};
const report={note:'Offline sample, not whole-scene/FPS estimates. noAO changes appearance; shadowOnly drops shading attributes but keeps occupied surfaces.',samples:[]};
for(const level of ['1','1f','2']) {
  const dir=`public/data/tiles/${level}`;
  const files=fs.readdirSync(dir).filter(f=>f.endsWith('.bin')).sort((a,b)=>fs.statSync(`${dir}/${b}`).size-fs.statSync(`${dir}/${a}`).size).slice(0,2);
  for(const file of files){
    const raw=read(level,file),results={};
    for(const [name,a] of Object.entries(api)){
      const c=a.decodeTile(raw,128),under=level==='1f'?a.compactColumns(a.decodeTile(read('1',file),128)):null;
      const start=performance.now(),out=a.meshTile(128,parseInt(level),0,0,c,c.detail,under);
      results[name]={quads:out.quads,ms:performance.now()-start,coverage:coverage(out.records)};
      if(name!=='original')assert.equal(results[name].coverage,results.original.coverage,`${level}/${file}: changed face coverage`);
    }
    report.samples.push({level,file,...results});console.log(level,file,JSON.stringify(results));
  }
}
fs.writeFileSync('../artifacts/profiling/mesh-merging-sample.json',JSON.stringify(report,null,2)+'\n');
