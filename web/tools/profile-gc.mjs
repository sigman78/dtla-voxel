// Main-thread allocation sampling, including short-lived objects collected during capture.
// node tools/profile-gc.mjs ../artifacts/profiling/gc-before.json
// Start Vite on localhost:5176. URL, SAMPLE_MS, VIEWS, MODES, LOD override defaults.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
const root = path.join(os.homedir(), 'AppData/Local/ms-playwright');
const executablePath = process.env.CHROME || fs.readdirSync(root).filter(n => /^chromium-\d+$/.test(n))
  .sort((a,b) => +b.split('-')[1] - +a.split('-')[1]).map(n => path.join(root,n,'chrome-win64/chrome.exe')).find(p => fs.existsSync(p));
const browser = await chromium.launch({ executablePath, headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
const report = { date: new Date().toISOString(), browser: browser.version(), samplingInterval: 16384,
  note: 'Sampled main-thread bytes include collected objects; not peak or retained heap. Frame times include profiler overhead. Worker heaps excluded.', samples: [] };
try {
  for (const view of (process.env.VIEWS || 'default,civic').split(',')) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`${process.env.URL || 'http://localhost:5176/'}?view=${view}&hour=13&date=11-03&lod=${process.env.LOD || 0}`);
    await page.waitForFunction(() => window.__city?.complete, null, { timeout: 180000 });
    await page.waitForTimeout(3500);
    const cdp = await page.context().newCDPSession(page);
    for (const moving of (process.env.MODES || 'stationary,moving').split(',')) {
      await cdp.send('HeapProfiler.collectGarbage');
      const sceneSnapshot = () => page.evaluate(() => {
        let tiles=0, triangles=0;
        window.__three.scene.traverse(o=>{
          if(!o.isMesh || !o.visible || !(o.geometry.attributes.qOrigin || o.geometry.attributes.vattr))return;
          tiles++;triangles+=o.geometry.isInstancedBufferGeometry?o.geometry.instanceCount*2:o.geometry.index.count/3;
        });
        return {tiles,triangles};
      });
      const sceneBefore = await sceneSnapshot();
      const events = [];
      const receive = ({value}) => { for (const e of value) if ((e.name === 'MinorGC' || e.name === 'MajorGC') && e.ph === 'X') events.push({name:e.name,us:e.dur}); };
      cdp.on('Tracing.dataCollected', receive);
      await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8', transferMode: 'ReportEvents' });
      await cdp.send('HeapProfiler.startSampling', { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      const frame = await page.evaluate(({ moving, duration }) => new Promise(resolve => {
        const times = new Float64Array(20000), t = window.__three, camera = t.camera, target = t.controls.target;
        const x = camera.position.x - target.x, z = camera.position.z - target.z, y = camera.position.y;
        let last = 0, count = 0, start = 0;
        const tick = now => {
          if (!start) start = now;
          if (last && count < times.length) times[count++] = now - last;
          last = now;
          if (moving === 'moving') {
            const a = Math.sin((now-start)/2400) * .12;
            camera.position.set(target.x + x*Math.cos(a) + z*Math.sin(a), y, target.z + z*Math.cos(a) - x*Math.sin(a));
            t.controls.update();
          }
          if (now-start < duration) requestAnimationFrame(tick);
          else {
            camera.position.set(target.x+x,y,target.z+z);t.controls.update();
            resolve({ms:Array.from(times.subarray(0,count)),duration:now-start});
          }
        };requestAnimationFrame(tick);
      }), { moving, duration: +(process.env.SAMPLE_MS || 8000) });
      const {profile} = await cdp.send('HeapProfiler.stopSampling');
      const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
      await cdp.send('Tracing.end');await complete;cdp.off('Tracing.dataCollected',receive);
      let total = 0; const sites = [];
      function walk(n, parent = '') {
        total += n.selfSize;
        const f = n.callFrame, name = `${f.functionName || '(anonymous)'} ${f.url}:${f.lineNumber+1}`;
        if (n.selfSize) sites.push({site:name,caller:parent,bytes:n.selfSize});
        n.children.forEach(c => walk(c,name));
      }walk(profile.head);
      sites.sort((a,b)=>b.bytes-a.bytes);frame.ms.sort((a,b)=>a-b);
      report.samples.push({view,mode:moving,lod:+(process.env.LOD || 0),sceneBefore,sceneAfter:await sceneSnapshot(),frames:frame.ms.length,duration:frame.duration,
        meanMs:frame.ms.reduce((a,b)=>a+b,0)/frame.ms.length,p95Ms:frame.ms[Math.floor(frame.ms.length*.95)],
        sampledBytes:total,bytesPerFrame:total/frame.ms.length,bytesPerSecond:total/(frame.duration/1000),
        gcEvents:events,gcMs:events.reduce((sum,e)=>sum+e.us,0)/1000,sites:sites.slice(0,40),errors});
      console.log(JSON.stringify({...report.samples.at(-1),gcEvents:events.length,sites:sites.slice(0,5)}));
      await page.waitForFunction(() => window.__city?.complete, null, { timeout: 180000 });await page.waitForTimeout(1000);
    }
    await page.close();
  }
} finally {
  fs.writeFileSync(process.argv[2] || '../artifacts/profiling/gc-profile.json',JSON.stringify(report,null,2)+'\n');
  await browser.close();
}
