// Touch-screen policy and production-bundle smoke check; this is not a mobile GPU benchmark.
// Run Vite preview on localhost:5176, then node tools/check-mobile.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root=path.join(os.homedir(),'AppData/Local/ms-playwright');
const executablePath=process.env.CHROME || fs.readdirSync(root).filter(n=>/^chromium-\d+$/.test(n)).sort((a,b)=>+b.split('-')[1]-+a.split('-')[1])
  .map(n=>path.join(root,n,'chrome-win64/chrome.exe')).find(p=>fs.existsSync(p));
const browser=await chromium.launch({executablePath,headless:true,args:['--enable-gpu','--ignore-gpu-blocklist']});
const report={date:new Date().toISOString(),browser:browser.version(),errors:[],samples:[]};
try {
  for(const mobile of [true,false]) {
    const page=await browser.newPage(mobile?{viewport:{width:390,height:844},screen:{width:390,height:844},deviceScaleFactor:2,hasTouch:true,isMobile:true}:{viewport:{width:1200,height:800}});
    page.on('pageerror',e=>report.errors.push(String(e)));
    page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text());});
    await page.goto(`${process.env.URL || 'http://localhost:5176/'}?view=civic&hour=13&date=11-02`);
    await page.waitForFunction(()=>window.__city?.complete,null,{timeout:180000});
    const result=await page.evaluate(()=>({leaves:window.__city.selection.leaves,coarse:matchMedia('(pointer: coarse)').matches,
      width:screen.width,height:screen.height,pixelRatio:window.__three.renderer.getPixelRatio(),glError:window.__three.renderer.getContext().getError()}));
    if(mobile){assert(result.coarse);assert(result.leaves.every(k=>+k.split('/')[0]>=4));}
    else assert(result.leaves.some(k=>k.startsWith('1/')));
    assert.equal(result.glError,0);report.samples.push({mobile,...result});
    if(mobile)await page.screenshot({path:'../artifacts/profiling/mobile-policy.png'});
    await page.close();
  }
  assert.deepEqual(report.errors,[]);console.log('Production desktop/touch policy passed');
} finally {
  fs.writeFileSync('../artifacts/profiling/voxel-production-smoke.json',JSON.stringify(report,null,2)+'\n');await browser.close();
}
