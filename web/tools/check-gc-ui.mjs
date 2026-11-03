// Integration checks for allocation-free tile gating and the existing debug overlays.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
const root=path.join(os.homedir(),'AppData/Local/ms-playwright');
const executablePath=process.env.CHROME || fs.readdirSync(root).filter(n=>/^chromium-\d+$/.test(n)).sort((a,b)=>+b.split('-')[1]-+a.split('-')[1])
  .map(n=>path.join(root,n,'chrome-win64/chrome.exe')).find(p=>fs.existsSync(p));
const browser=await chromium.launch({executablePath,headless:true,args:['--enable-gpu','--ignore-gpu-blocklist']});
const report={errors:[],views:[]};
try {
  const page=await browser.newPage({viewport:{width:1200,height:800}});
  page.on('pageerror',e=>report.errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text());});
  await page.route('**/src/main.ts*',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:await response.text()+'\nwindow.__gcCheck={get streamer(){return streamer},get city(){return city}};'});
  });
  for(const view of ['default','civic']) {
    await page.goto(`${process.env.URL || 'http://localhost:5176/'}?view=${view}&date=11-03&hour=19.5`);
    await page.waitForFunction(()=>window.__city?.complete,null,{timeout:180000});
    const result=await page.evaluate(()=>{
      const {streamer:s,city:c}=window.__gcCheck;
      const active=new Set(c.selection.active);let points=0,mismatches=0;
      const scale=s.levels[0],nx=s.dims[scale].nx*scale,ny=s.dims[scale].ny*scale;
      // Check centers and exact boundaries, including padded coarse-tile coverage.
      for(let y=-1;y<=ny;y++)for(let x=-1;x<=nx;x++)for(const offset of [0,64]) {
        const px=x*s.N+offset,pz=y*s.N+offset;
        let expected=0;
        for(const level of s.levels)if(active.has(s.key(level,Math.floor(px/(level*s.N)),Math.floor(pz/(level*s.N))))){expected=level;break;}
        if(c.levelAt(px,pz)!==expected || c.gate(px,pz)!==(expected>0))mismatches++;
        points++;
      }
      return {points,mismatches,gl:window.__three.renderer.getContext().getError()};
    });
    assert.equal(result.mismatches,0);assert.equal(result.gl,0);report.views.push({view,...result});
    await page.keyboard.press('F3');await page.waitForFunction(()=>document.querySelector('.perf-stats pre').textContent.includes('Voxels active'));
    assert(!((await page.locator('.perf-stats pre').textContent()).includes('NaN')));
    await page.keyboard.press('F4');assert(await page.locator('.lod-legend').isVisible());
    await page.keyboard.press('F4');await page.keyboard.press('F3');
    assert(await page.locator('.perf-stats').isHidden());assert(await page.locator('.lod-legend').isHidden());
  }
  assert.deepEqual(report.errors,[]);console.log(JSON.stringify(report));
}finally{await browser.close();}
