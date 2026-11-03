// npm run build:cf && node tools/check-delivery-cache.mjs
// URL=https://dtla.ioupg.com/ IMMUTABLE_HEADERS=1 checks a deployed build instead.
// Local server deliberately requires revalidation, like a host without _headers support.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { chromium } from 'playwright-core';
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex').slice(0,32);
let server,base=process.env.URL;
if(!base){
  const dist=path.resolve('.cloudflare/output/v0/workers/default/assets');
  server=http.createServer((req,res)=>{
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const file=path.resolve(dist,'.'+(pathname==='/'?'/index.html':pathname));
    if(!file.startsWith(dist+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
    const bytes=fs.readFileSync(file),etag='"'+hash(bytes)+'"';
    const type=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':file.endsWith('.json')?'application/json':'application/octet-stream';
    res.setHeader('Cache-Control','public, must-revalidate, max-age=0');res.setHeader('ETag',etag);res.setHeader('Content-Type',type);
    if(req.headers['if-none-match']===etag){res.writeHead(304).end();return;}
    res.setHeader('Content-Length',bytes.length);res.end(bytes);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port+'/';
}
const root=path.join(os.homedir(),'AppData/Local/ms-playwright');
const executablePath=process.env.CHROME || fs.readdirSync(root).filter(n=>/^chromium-\d+$/.test(n)).sort((a,b)=>+b.split('-')[1]-+a.split('-')[1])
  .map(n=>path.join(root,n,'chrome-win64/chrome.exe')).find(p=>fs.existsSync(p));
const browser=await chromium.launch({executablePath,headless:true,args:['--enable-gpu','--ignore-gpu-blocklist']});
const report={base,visits:[],errors:[]};
try{
  const context=await browser.newContext({viewport:{width:1200,height:800}});
  for(const visit of ['cold','warm']){
    const page=await context.newPage();
    page.on('pageerror',error=>report.errors.push(String(error)));
    page.on('response',response=>{if(response.url().startsWith(base)&&response.status()>=400)report.errors.push(response.status()+' '+response.url());});
    const start=performance.now();
    await page.goto(base+'?view=civic&hour=13&date=11-03',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.__city?.complete,null,{timeout:180000});
    const seconds=(performance.now()-start)/1000;
    const entries=(await Promise.all(page.workers().map(w=>w.evaluate(()=>performance.getEntriesByType('resource')
      .filter(e=>/\/immutable\/[a-f0-9]{32}\.bin/.test(e.name)).map(e=>({url:e.name,transfer:e.transferSize,body:e.encodedBodySize})))))).flat();
    assert(entries.length>300,'Expected worker Resource Timing coverage for the loaded Civic view');
    if(visit==='warm')assert(entries.every(e=>e.transfer===0),'Immutable tiles must not revalidate on a warm visit');
    const state=await page.evaluate(()=>({gl:window.__three.renderer.getContext().getError(),
      metadata:performance.getEntriesByType('resource').filter(e=>e.name.includes('/data/meta.json')).map(e=>e.transferSize)}));
    assert.equal(state.gl,0);assert(state.metadata.some(n=>n>0),'Metadata must check for updates');
    report.visits.push({visit,seconds,tileResponsesObserved:entries.length,networkResponses:entries.filter(e=>e.transfer>0).length,
      tileTransferBytes:entries.reduce((n,e)=>n+e.transfer,0),metadataTransferBytes:state.metadata});
    await page.close();
  }
  const metadata=await context.request.get(new URL('data/meta.json',base).href);assert.equal(metadata.status(),200);
  const meta=await metadata.json();assert(Object.keys(meta.assets).length>2000);
  for(const logical of ['terrain.bin','tiles/1/10_10.bin','tiles/1f/10_10.bin']){
    const response=await context.request.get(new URL('data/immutable/'+meta.assets[logical]+'.bin',base).href);
    assert.equal(response.status(),200);assert.equal(hash(await response.body()),meta.assets[logical]);
    if(process.env.IMMUTABLE_HEADERS==='1')assert.match(response.headers()['cache-control'],/immutable/);
    const legacy=await context.request.get(new URL('data/'+logical,base).href);
    assert.equal(legacy.status(),200);assert.equal(hash(await legacy.body()),meta.assets[logical]);
  }
  assert.deepEqual(report.errors,[]);console.log(JSON.stringify(report));
  await context.close();
}finally{await browser.close();server?.close();}
