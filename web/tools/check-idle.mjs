// Browser regression for stationary draw suppression and wake-up. Captures stay local.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
const root=path.join(os.homedir(),'AppData/Local/ms-playwright');
const executablePath=process.env.CHROME || fs.readdirSync(root).filter(n=>/^chromium-\d+$/.test(n)).sort((a,b)=>+b.split('-')[1]-+a.split('-')[1])
  .map(n=>path.join(root,n,'chrome-win64/chrome.exe')).find(p=>fs.existsSync(p));
const browser=await chromium.launch({executablePath,headless:true,args:['--enable-gpu','--ignore-gpu-blocklist']});
const report={errors:[],cases:[]};
try {
  const page=await browser.newPage({viewport:{width:1200,height:800}});
  page.on('pageerror',e=>report.errors.push(String(e)));
  await page.route('**/src/main.ts*',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:(await response.text()).replace('const continuous =', 'let continuous =')+`
let testDraws=0;
const originalRender=post.composer.render.bind(post.composer);
post.composer.render=(...args)=>{testDraws++;return originalRender(...args)};
window.__idle={get draws(){return testDraws},get water(){return animatedWater},get remaining(){return settleFrames},
 setContinuous(value){continuous=value},force(){renderDirty=true}};`});
  });
  await page.goto(`${process.env.URL || 'http://localhost:5176/'}?view=civic&hour=13&date=11-03`);
  await page.waitForFunction(()=>window.__city?.complete,null,{timeout:180000});
  // A close downward view in the city excludes river tiles conservatively.
  await page.evaluate(()=>{
    const {camera,controls}=window.__three;
    camera.position.set(controls.target.x,controls.target.y+250,controls.target.z+30);controls.update();
  });
  const draws=()=>page.evaluate(()=>window.__idle.draws);
  const idle=async()=>{
    await page.waitForTimeout(1500);
    await page.waitForFunction(()=>window.__city?.complete && !window.__idle.water && window.__idle.remaining===0,null,{timeout:180000});
    const before=await draws();await page.waitForTimeout(500);assert.equal(await draws(),before,'settled view must not redraw');
  };
  await idle();report.cases.push('daytime idle');
  if (process.env.PROFILE === '1') {
    const cdp=await page.context().newCDPSession(page);report.allocations=[];
    for(const continuous of [true,false]) {
      await page.evaluate(value=>window.__idle.setContinuous(value),continuous);await page.waitForTimeout(2000);
      const startDraws=await draws();
      await cdp.send('HeapProfiler.startSampling',{samplingInterval:4096,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
      await page.waitForTimeout(5000);
      const {profile}=await cdp.send('HeapProfiler.stopSampling');
      let bytes=0;function sum(n){bytes+=n.selfSize;n.children.forEach(sum)}sum(profile.head);
      report.allocations.push({continuous,sampledBytes:bytes,seconds:5,draws:(await draws())-startDraws});
    }
    await cdp.detach();
  }
  const canvas=page.locator('#app canvas');
  const before=await canvas.screenshot();
  await page.evaluate(()=>window.__idle.force());await idle();
  assert(before.equals(await canvas.screenshot()),'forced unchanged redraw must match sleeping image');
  report.cases.push('forced redraw pixel equality');
  await page.keyboard.press('F3');await page.waitForTimeout(300);
  assert.match(await page.locator('.perf-title').textContent(),/Idle/);
  assert.match(await page.locator('.perf-stats pre').textContent(),/Voxels active/);
  await page.keyboard.press('F3');report.cases.push('idle statistics');
  for (const action of ['camera','hour','date','resize','F4']) {
    const start=await draws();
    if(action==='camera')await page.evaluate(()=>{window.__three.camera.position.x+=10;window.__three.controls.target.x+=10;window.__three.controls.update()});
    if(action==='hour')await page.evaluate(()=>window.__three.setHour(14));
    if(action==='date')await page.evaluate(()=>window.__three.setDay(180));
    if(action==='resize')await page.setViewportSize({width:1000,height:750});
    if(action==='F4')await page.keyboard.press('F4');
    await page.waitForFunction(start=>window.__idle.draws>start,start);
    await idle();report.cases.push(`${action} wakes and settles`);
  }
  await page.keyboard.press('F4');await idle();
  await page.evaluate(()=>window.__three.setHour(23));
  await page.waitForTimeout(300);const night=await draws();await page.waitForTimeout(500);
  assert((await draws())>night+3,'night beacons must keep drawing');report.cases.push('night animation');
  await page.evaluate(()=>window.__three.setHour(13));await idle();
  await page.keyboard.down('w');const moving=await draws();await page.waitForTimeout(300);await page.keyboard.up('w');
  assert((await draws())>moving,'keyboard navigation wakes renderer');await idle();report.cases.push('keyboard navigation');
  await page.goto(`${process.env.URL || 'http://localhost:5176/'}?view=viaduct&hour=13&date=11-03`);
  await page.waitForFunction(()=>window.__city?.complete && window.__idle.water,null,{timeout:180000});
  const water=await draws();await page.waitForTimeout(500);
  assert((await draws())>water+3,'visible river water must keep drawing');report.cases.push('water animation');
  await page.keyboard.press('F4');await page.waitForTimeout(300);
  const tintedWater=await draws();await page.waitForTimeout(500);
  assert((await draws())>tintedWater+3,'tint overlays must preserve water animation');report.cases.push('tinted water animation');
  assert.deepEqual(report.errors,[]);console.log(JSON.stringify(report));
} finally {await browser.close();}
