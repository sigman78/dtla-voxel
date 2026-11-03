// Content changes must produce new URLs; unchanged files must keep their URLs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { versionData } from './version-data.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dtla-cache-test-'));
try {
  fs.mkdirSync(path.join(root,'tiles/1'),{recursive:true});
  fs.writeFileSync(path.join(root,'meta.json'),JSON.stringify({W:128}));
  fs.writeFileSync(path.join(root,'terrain.bin'),Buffer.from([1,2,3]));
  fs.writeFileSync(path.join(root,'tiles/1/0_0.bin'),Buffer.from([4,5,6]));
  const first=versionData(root),second=versionData(root);assert.deepEqual(second,first);
  fs.writeFileSync(path.join(root,'tiles/1/0_0.bin'),Buffer.from([7,8,9]));
  const third=versionData(root);
  assert.equal(first['terrain.bin'],third['terrain.bin']);
  assert.notEqual(first['tiles/1/0_0.bin'],third['tiles/1/0_0.bin']);
  assert.deepEqual(fs.readFileSync(path.join(root,'immutable',third['tiles/1/0_0.bin']+'.bin')),Buffer.from([7,8,9]));
  assert.deepEqual(fs.readFileSync(path.join(root,'tiles/1/0_0.bin')),Buffer.from([7,8,9]));
  const clean=file=>stripTypeScriptTypes(fs.readFileSync(new URL('../src/'+file,import.meta.url),'utf8')).replace(/^import .*;$/gm,'').replace(/^export /gm,'');
  const requests=[],context=vm.createContext({URL,URLSearchParams,location:{href:'https://example.com/dtla/?data=data-alt',search:'?data=data-alt'},fetch:(url,options)=>{requests.push({url,options});return Promise.resolve({ok:true,json:()=>({})});}});
  vm.runInContext(clean('assetCache.ts')+'\n'+clean('util.ts')+'\nglobalThis.api={dataUrl,setDataAssets,fetchAsset,fetchJson};',context);
  const api=context.api;
  assert.equal(api.dataUrl('terrain.bin'),'https://example.com/dtla/data-alt/terrain.bin');
  api.setDataAssets(third);const hashed=api.dataUrl('terrain.bin');
  assert.equal(hashed,'https://example.com/dtla/data-alt/immutable/'+third['terrain.bin']+'.bin');
  const signal={};await api.fetchAsset(hashed,signal);assert.equal(requests.at(-1).options.cache,'force-cache');assert.equal(requests.at(-1).options.signal,signal);
  await api.fetchAsset('https://example.com/data/tiles/1/0_0.bin');assert.equal(requests.at(-1).options.cache,'default');
  await api.fetchJson(api.dataUrl('meta.json'));assert.equal(requests.at(-1).options.cache,'no-cache');
  api.setDataAssets();assert.equal(api.dataUrl('terrain.bin'),'https://example.com/dtla/data-alt/terrain.bin');
  console.log('Passed: stable content URLs, changed-file invalidation, legacy files, subpaths/alternate data, cache policy and abort signal');
} finally {
  const resolved=path.resolve(root),temp=path.resolve(os.tmpdir())+path.sep;
  assert(resolved.startsWith(temp)&&path.basename(resolved).startsWith('dtla-cache-test-'));
  fs.rmSync(resolved,{recursive:true,force:true});
}
