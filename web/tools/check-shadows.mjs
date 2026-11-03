// Integration check against forced redraws. Run with the local Vite server on port 5175.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = path.join(os.homedir(), 'AppData/Local/ms-playwright');
const executablePath = process.env.CHROME || (fs.existsSync(root) && fs.readdirSync(root)
  .filter(n => /^chromium-\d+$/.test(n)).sort((a,b) => +b.split('-')[1] - +a.split('-')[1])
  .map(n => path.join(root,n,'chrome-win64/chrome.exe')).find(p => fs.existsSync(p)));
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }),
  headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [], report = { loading: null, cases: [], errors };
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()) + `
window.__shadowCheck = { frames: 0, draws: 0, baseBatches: 0, foliageBatches: 0, missed: [], previousBase: 0, previousFoliage: 0 };
const check = window.__shadowCheck;
const originalShadowRender = renderer.shadowMap.render;
renderer.shadowMap.render = function (...args) {
  const before = renderer.info.render.calls;
  const result = originalShadowRender.apply(this, args);
  check.draws += renderer.info.render.calls - before;
  return result;
};
const originalComposerRender = post.composer.render;
post.composer.render = function (...args) {
  const nodes = streamer ? [...streamer.nodes.values()] : [];
  const base = nodes.filter(n => n.mesh?.visible && !n.foliage).length;
  const foliage = nodes.filter(n => n.mesh?.visible && n.foliage).length;
  const changed = base > check.previousBase || foliage > check.previousFoliage;
  if (base > check.previousBase) check.baseBatches++;
  if (foliage > check.previousFoliage) check.foliageBatches++;
  const dirty = daylight.sun.shadow.needsUpdate;
  check.draws = 0;
  const result = originalComposerRender.apply(this, args);
  if (changed && (!dirty || !check.draws)) check.missed.push({ base, foliage, dirty, draws: check.draws });
  check.previousBase = base; check.previousFoliage = foliage; check.frames++;
  return result;
};` });
  });
  await page.goto(`${process.env.URL || 'http://127.0.0.1:5175/'}?view=civic&date=11-02&hour=13&lod=${process.env.LOD ?? 1}`);
  await page.waitForFunction(() => window.__city?.complete, null, { timeout: 300000 });
  await page.waitForTimeout(1500);
  report.loading = await page.evaluate(() => ({ ...window.__shadowCheck }));
  assert(report.loading.baseBatches > 0 && report.loading.foliageBatches > 0, 'Both loading stages must be exercised');
  assert.deepEqual(report.loading.missed, [], 'New visible casters must invalidate shadows in the same frame');
  report.cases = await page.evaluate(() => {
    const { renderer, post, daylight, camera, controls, map, setHour, setDay, scene } = window.__three;
    renderer.setAnimationLoop(null);
    const check = window.__shadowCheck, sun = daylight.sun;
    const gl = renderer.getContext();
    const pixels = () => {
      const a = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, a);
      return a;
    };
    const fit = () => { camera.updateMatrixWorld(); daylight.fitShadow(controls.target, camera, camera.position.distanceTo(controls.target), map); };
    const results = [];
    function compare(name, change, mustRefresh) {
      change(); fit();
      const dirty = sun.shadow.needsUpdate;
      post.composer.render();
      const updateDraws = check.draws, firstFrame = pixels();
      post.composer.render();
      const settledDraws = check.draws, actual = pixels();
      renderer.setRenderTarget(null); renderer.render(scene,camera);
      const rawActual = pixels();
      renderer.shadowMap.autoUpdate = true;
      post.composer.render();
      const forcedDraws = check.draws, referenceFirst = pixels();
      post.composer.render();
      const expected = pixels();
      renderer.setRenderTarget(null); renderer.render(scene,camera);
      const rawExpected = pixels();
      renderer.shadowMap.autoUpdate = false;
      let different = 0, maxDifference = 0, totalDifference = 0, firstFrameMax = 0, firstFrameTotal = 0, referenceMax = 0, referenceTotal = 0, rawMax = 0, rawTotal = 0;
      let over8 = 0, firstOver8 = 0, rawOver8 = 0;
      for (let i=0; i<actual.length; i++) {
        const delta = Math.abs(actual[i]-expected[i]);
        if (delta) different++;
        if (delta > 8) over8++;
        maxDifference = Math.max(maxDifference,delta); totalDifference += delta;
        const firstDelta = Math.abs(firstFrame[i]-referenceFirst[i]);
        firstFrameMax = Math.max(firstFrameMax,firstDelta); firstFrameTotal += firstDelta;
        if (firstDelta > 8) firstOver8++;
        const referenceDelta = Math.abs(referenceFirst[i]-expected[i]);
        referenceMax = Math.max(referenceMax,referenceDelta); referenceTotal += referenceDelta;
        const rawDelta = Math.abs(rawActual[i]-rawExpected[i]); rawMax = Math.max(rawMax,rawDelta); rawTotal += rawDelta;
        if (rawDelta > 8) rawOver8++;
      }
      results.push({ name, mustRefresh, dirty, updateDraws, settledDraws, forcedDraws,
        differentChannels: different, maxDifference, meanDifference: totalDifference/actual.length,
        firstFrameMax, firstFrameMean: firstFrameTotal/actual.length, referenceMax, referenceMean: referenceTotal/actual.length, rawMax, rawMean: rawTotal/actual.length,
        fractionOver8: over8/actual.length, firstFractionOver8: firstOver8/actual.length, rawFractionOver8: rawOver8/actual.length });
    }
    compare('settled', () => {}, false);
    compare('pan', () => { camera.position.x += 180; controls.target.x += 180; }, true);
    compare('zoom', () => { camera.position.sub(controls.target).multiplyScalar(.65).add(controls.target); }, true);
    compare('orbit with unchanged shadow fit', () => {
      const x=camera.position.x-controls.target.x, z=camera.position.z-controls.target.z;
      camera.position.x=controls.target.x+z; camera.position.z=controls.target.z-x; camera.lookAt(controls.target);
    }, true);
    compare('hour', () => setHour(16), true);
    compare('date', () => setDay(172), true);
    compare('night', () => setHour(22), true);
    compare('resize', () => {
      renderer.setSize(1000,700); post.composer.setSize(1000,700); camera.aspect=1000/700; camera.updateProjectionMatrix();
    }, true);
    return results;
  });
  for (const c of report.cases) {
    assert(c.forcedDraws > 0, `${c.name}: reference must render shadows`);
    assert.equal(c.settledDraws, 0, `${c.name}: settled frames must reuse shadows`);
    if (c.mustRefresh) assert(c.dirty && c.updateDraws > 0, `${c.name}: transition must refresh shadows`);
    else assert.equal(c.updateDraws, 0, `${c.name}: unchanged shadow fit must be reused`);
    // Tight image tolerance for localized raster differences, including roof/foliage edges.
    // Mean difference < 0.2/255 and at least 99.9% of channels within 8/255.
    assert(c.meanDifference < .2 && c.fractionOver8 < .001, `${c.name}: cached result differs from forced redraw`);
    assert(c.firstFrameMean < .2 && c.firstFractionOver8 < .001, `${c.name}: transition frame differs from forced redraw`);
    assert(c.rawMean < .2 && c.rawFractionOver8 < .001, `${c.name}: scene without postprocessing differs from forced redraw`);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(report,null,2));
} finally {
  const output = process.argv[2] || '../artifacts/profiling/shadow-check.json';
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output,JSON.stringify(report,null,2));
  await browser.close();
}
