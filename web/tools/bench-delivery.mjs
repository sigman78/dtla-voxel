// Controlled browser experiment, not a Cloudflare/CDN benchmark.
// Run in web/: node tools/bench-delivery.mjs
// SOURCE_ROOT points to a CLEAN web checkout; OUTPUT is local/ignored. REPEATS defaults to 2.
// PROFILES=near,latency; VARIANTS=current,immutable,batch,both; PHASES=cold,away,return,warm.
// Optional PROFILES=bandwidth tests 80ms / 256 KiB/s. External fonts are removed;
// app assets are served without transport compression, equally across variants.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http2 from 'node:http2';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { build } from 'vite';
import { chromium } from 'playwright-core';
import { broker, worker, instrumentation } from './delivery-runtime.mjs';

const source=path.resolve(process.env.SOURCE_ROOT || '.'), output=path.resolve(process.env.OUTPUT || '../artifacts/profiling/delivery.json');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'dtla-delivery-')), dist=path.join(scratch,'dist');
const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim();
assert.equal(execFileSync('git',['status','--porcelain','--untracked-files=no','--','src','public'],{cwd:source,encoding:'utf8'}).trim(),'','Use a clean source/data checkout');
const transform={name:'delivery-experiment',enforce:'pre',transform(code,id){
  if(id.endsWith('/src/main.ts'))return code+instrumentation;
  if(id.endsWith('/src/stream.ts'))return broker+code
    .replace('worker.onmessage = (e: MessageEvent<MeshReply>) => {',"worker.onmessage = (e: MessageEvent<MeshReply>) => { if(e.data.type==='delivery-fetch'){void deliveryServe(worker,e.data);return;}")
    .replace('id: n.id,',"delivery: new URLSearchParams(location.search).get('delivery'), id: n.id,")
    .replace('dataUrl(\x60tiles/',`dataUrl(\x60v/${revision}/tiles/`);
  if(id.endsWith('/src/mesher.worker.ts'))return worker+code
    .replace("if ('cancel' in e.data)","if(e.data.type==='delivery-bytes')return; if ('cancel' in e.data)")
    .replace('fetchGzip(url: string, signal: AbortSignal)','fetchGzip(url: string, signal: AbortSignal, delivery?: string)')
    .replace('const res = await fetch(url, { signal });',"const res = delivery==='batch' ? new Response(await deliveryRead(url,signal)) : await fetch(url, {signal});")
    .replaceAll('fetchGzip(m.url, controller.signal)','fetchGzip(m.url, controller.signal, m.delivery)')
    .replaceAll('fetchGzip(m.under, controller.signal)','fetchGzip(m.under, controller.signal, m.delivery)');
}};
await build({root:source,configFile:false,base:'./',plugins:[transform],worker:{format:'es',plugins:()=>[transform]},
  build:{outDir:dist,emptyOutDir:true,chunkSizeWarningLimit:2000},logLevel:'error'});
const files=new Map(), packs=new Map();
files.set('/probe.html',{bytes:Buffer.from('<!doctype html><title>Cache probe</title>'),etag:'"probe"'});
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else{
  const key='/'+path.relative(dist,file).split(path.sep).join('/');let bytes=fs.readFileSync(file);
  // Remove third-party font latency/noise equally in all four cases.
  if(key==='/index.html')bytes=Buffer.from(bytes.toString().replace(/<link[^>]*https:\/\/fonts\.[^>]*>/g,''));
  files.set(key,{bytes,etag:'"'+crypto.createHash('sha256').update(bytes).digest('hex')+'"'});
}}}walk(dist);
for(const [key,file] of files){const match=/^\/data\/tiles\/([^/]+)\/(\d+)_(\d+)\.bin$/.exec(key);if(!match)continue;
  const [,level,xs,ys]=match,x=+xs,y=+ys,g=(level==='1'||level==='1f')?4:2;
  const name=`/data/packs/${level}/${Math.floor(x/g)}_${Math.floor(y/g)}.bin`;
  if(!packs.has(name))packs.set(name,{g,tiles:Array(g*g).fill(null)});
  packs.get(name).tiles[(y%g)*g+x%g]=file.bytes;
}
for(const [name,{g,tiles}] of packs){const header=Buffer.alloc(4+4*g*g);header.writeUInt32LE(g,0);
  tiles.forEach((bytes,i)=>header.writeUInt32LE(bytes?.length||0,4+i*4));
  const bytes=Buffer.concat([header,...tiles.filter(Boolean)]);let offset=header.length;
  for(const tile of tiles)if(tile){assert(bytes.subarray(offset,offset+tile.length).equals(tile));offset+=tile.length;}
  files.set(name,{bytes,etag:'"'+crypto.createHash('sha256').update(bytes).digest('hex')+'"'});
}
execFileSync(process.env.OPENSSL || 'openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(scratch,'key.pem'),'-out',path.join(scratch,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
const profiles={near:{latency:10,bytesPerSecond:10*1024*1024},latency:{latency:80,bytesPerSecond:2.5*1024*1024},bandwidth:{latency:80,bytesPerSecond:256*1024}};
let profile=profiles.latency, wire=[],outgoing=[];
const server=http2.createSecureServer({key:fs.readFileSync(path.join(scratch,'key.pem')),cert:fs.readFileSync(path.join(scratch,'cert.pem'))});
server.on('stream',(stream,headers)=>{
  stream.on('error',()=>{});
  const full=new URL(headers[':path'],'https://localhost'), parts=full.pathname.split('/');
  const variant=parts[1];let key='/'+parts.slice(2).join('/');if(key==='/')key='/index.html';
  key=key.replace(`/data/v/${revision}/`,'/data/');
  const file=files.get(key),tile=/\/data\/(tiles|packs)\//.test(key), immutable=['immutable','both'].includes(variant);
  const entry={path:key,tile,status:404,bytes:0,cancelled:false};wire.push(entry);
  stream.on('aborted',()=>entry.cancelled=true);
  setTimeout(()=>{
    if(stream.destroyed)return;
    if(!file){stream.respond({':status':404});stream.end();return;}
    const cache=tile&&immutable?'public, max-age=31536000, immutable':'public, must-revalidate, max-age=0';
    entry.validator=headers['if-none-match'];entry.requestCache=headers['cache-control'];
    entry.status=headers['if-none-match']===file.etag?304:200;
    const type=key.endsWith('.html')?'text/html':key.endsWith('.js')?'text/javascript':key.endsWith('.css')?'text/css':key.endsWith('.json')?'application/json':'application/octet-stream';
    stream.respond({':status':entry.status,'content-type':type,'cache-control':cache,etag:file.etag,...(entry.status===200?{'content-length':file.bytes.length}:{})});
    if(entry.status===304){stream.end();return;}
    outgoing.push({stream,bytes:file.bytes,offset:0,entry});
  },profile.latency);
});
// Shared server-side bandwidth cap applies to main-frame AND worker requests, including 304 latency.
const sendTimer=setInterval(()=>{
  let budget=profile.bytesPerSecond/100;
  while(budget>=1&&outgoing.length){const item=outgoing.shift();if(item.stream.destroyed)continue;
    const n=Math.min(16384,Math.floor(budget),item.bytes.length-item.offset);if(n===0)break;
    item.stream.write(item.bytes.subarray(item.offset,item.offset+n));item.offset+=n;item.entry.bytes+=n;budget-=n;
    if(item.offset===item.bytes.length)item.stream.end();else outgoing.push(item);
  }
},10);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
const chromeRoot=path.join(os.homedir(),'AppData/Local/ms-playwright');
const executablePath=process.env.CHROME || fs.readdirSync(chromeRoot).filter(n=>/^chromium-\d+$/.test(n)).sort((a,b)=>+b.split('-')[1]-+a.split('-')[1]).map(n=>path.join(chromeRoot,n,'chrome-win64/chrome.exe')).find(p=>fs.existsSync(p));
// Blanket certificate-error ignoring bypassed Chromium's cache in the smoke test.
// Pin only this ephemeral localhost key, then verify a real cache hit before timing.
const spki=crypto.createHash('sha256').update(new crypto.X509Certificate(fs.readFileSync(path.join(scratch,'cert.pem'))).publicKey.export({type:'spki',format:'der'})).digest('base64');
const browser=await chromium.launch({executablePath,headless:true,args:['--enable-gpu','--ignore-gpu-blocklist','--ignore-certificate-errors-spki-list='+spki]});
try {
  const context=await browser.newContext(),page=await context.newPage();
  await page.goto(`https://localhost:${port}/both/probe.html`);wire=[];
  for(let i=0;i<2;i++)await page.evaluate(async url=>{const r=await fetch(url);await r.arrayBuffer()},`/both/data/v/${revision}/tiles/8/0_0.bin`);
  console.log('Cache probe: '+wire.filter(x=>x.tile).length+' network response for two immutable fetches');await context.close();
  assert.equal(wire.filter(x=>x.tile).length,1,'Immutable browser caching must work before measuring');wire=[];
}catch(error){await browser.close();clearInterval(sendTimer);server.close();throw error;}
const report={revision,browser:browser.version(),method:'Local HTTPS/HTTP2, server-side latency and shared bandwidth; no browser routing/cache interception. Four mesh workers. Shader/CPU/GPU unchanged. Desktop GPU, no CPU throttling. External fonts removed equally. Warm means a NEW page in the same browser context. Full-pack broker has 4 MiB LRU and in-flight dedup; shared fetches finish even if a tile cancels. Readiness/coverage/90% milestones sampled at 100ms; complete measured from navigation start. Tile bytes exclude protocol overhead.',packs:packs.size,profiles,results:[]};
const variants=(process.env.VARIANTS||'current,immutable,batch,both').split(','), repeats=+(process.env.REPEATS||2);
const save=()=>{fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');};
function network(){const tiles=wire.filter(x=>x.tile);return {requests:wire.length,tileRequests:tiles.length,tile200:tiles.filter(x=>x.status===200).length,tile304:tiles.filter(x=>x.status===304).length,tileBytes:tiles.reduce((n,x)=>n+x.bytes,0),allBytes:wire.reduce((n,x)=>n+x.bytes,0),cancelled:tiles.filter(x=>x.cancelled).length,missing:wire.filter(x=>x.status===404)};}
try {
  for(const profileName of (process.env.PROFILES||'near,latency').split(','))for(let repeat=0;repeat<repeats;repeat++){
    profile=profiles[profileName];
    // Reverse paired runs to limit systematic shader/GPU warm-up bias.
    const order=repeat%2?[...variants].reverse():variants;
    for(const variant of order){
      const context=await browser.newContext({viewport:{width:1200,height:800}});
      let page=await context.newPage();const errors=[];
      const observe=p=>p.on('pageerror',error=>errors.push(String(error)));observe(page);
      const url=`https://localhost:${port}/${variant}/?view=civic&hour=13&date=11-03&delivery=${variant==='batch'||variant==='both'?'batch':'individual'}`;
      try {
        for(const phase of (process.env.PHASES||'cold,away,return,warm').split(',')){
          wire=[];let start=performance.now();
          if(phase==='warm'){await page.close();page=await context.newPage();observe(page);}
          if(phase==='cold'||phase==='warm')await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
          else {await page.evaluate(view=>{window.__deliveryTest.view(view);window.__deliveryTest.reset()},phase==='away'?'viaduct':'civic');}
          await page.waitForFunction(()=>window.__deliveryTest && window.__ready,null,{timeout:120000});
          // Selection updates at 10Hz; avoid accepting the previous view's complete flag.
          if(phase==='away'||phase==='return')await page.waitForTimeout(200);
          await page.waitForFunction(()=>window.__city?.complete,null,{timeout:180000});
          const completeMs=performance.now()-start;
          const snapshot=await page.evaluate(()=>window.__deliveryTest.snapshot());
          if(phase==='cold'||phase==='warm')for(const key of ['readyMs','coverageMs','detail90Ms'])if(snapshot[key]!==null)snapshot[key]+=snapshot.startOffsetMs;
          delete snapshot.startOffsetMs;
          const frames=snapshot.frames.sort((a,b)=>a-b);delete snapshot.frames;
          assert.equal(snapshot.gl,0);assert.equal(snapshot.stats.failed,0);assert.deepEqual(errors,[]);
          const net=network();assert.deepEqual(net.missing,[]);
          report.results.push({profile:profileName,repeat,variant,phase,completeMs,frameP95:frames[Math.floor(frames.length*.95)]||0,longFrames:frames.filter(x=>x>50).length,...net,...snapshot});
          save();console.log(JSON.stringify({profile:profileName,repeat,variant,phase,seconds:+(completeMs/1000).toFixed(2),requests:net.tileRequests,kb:Math.round(net.tileBytes/1024)}));
          // Let non-visible tile eviction finish before the next navigation phase.
          await page.waitForTimeout(2500);
        }
      }catch(error){report.failure={error:String(error),errors,network:network()};throw error;}finally{await context.close();}
    }
  }
}finally{save();await browser.close();clearInterval(sendTimer);server.close();}
console.log('Report: '+output);
