// Refresh README images from a running viewer. All tiles must finish loading.
// URL defaults to http://127.0.0.1:5175/. JPEG output is directly from Chromium.
import { chromium } from 'playwright-core';
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-gpu','--ignore-gpu-blocklist']});
const shots=[
  ['hero-civic','view=civic&hour=10.5',1600,1000],
  ['bunker-hill','view=bunkerhill&hour=15.8',960,600],
  ['skyline-sunset','cam=4052,647,2285,2007,196,744&hour=16.4',960,600],
  ['broadway','view=historic&hour=13',960,600],
  ['night','view=bunkerhill&hour=19.5',960,600],
  ['mountain-horizon','cam=900,350,2500,2400,180,1400&hour=16.5&tilt=0',1600,1000],
];
try {
  for(const [name,query,width,height] of shots){
    const page=await browser.newPage({viewport:{width,height}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    await page.goto(`${process.env.URL||'http://127.0.0.1:5175/'}?${query}&date=11-03&ui=0`);
    await page.waitForFunction(()=>window.__ready && window.__city?.complete,null,{timeout:300000});
    await page.waitForTimeout(2500);
    if(errors.length)throw new Error(`${name}: ${errors.join('\n')}`);
    await page.screenshot({path:`../docs/img/${name}.jpg`,type:'jpeg',quality:90});
    console.log('Refreshed',name);await page.close();
  }
} finally {await browser.close();}
