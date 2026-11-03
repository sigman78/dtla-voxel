import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = path.join(os.homedir(), 'AppData/Local/ms-playwright');
const executablePath =
  process.env.CHROME ||
  fs
    .readdirSync(root)
    .filter((n) => /^chromium-\d+$/.test(n))
    .sort((a, b) => +b.split('-')[1] - +a.split('-')[1])
    .map((n) => path.join(root, n, 'chrome-win64/chrome.exe'))
    .find((p) => fs.existsSync(p));
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist'],
});
const report = {
  date: new Date().toISOString(),
  browser: browser.version(),
  errors: [],
  comparisons: [],
  navigation: [],
};
const out = process.argv[2] || '../artifacts/profiling/voxel-validation.json';
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on('pageerror', (e) => report.errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('503')) report.errors.push(m.text());
});
await page.route('**/src/main.ts*', async (route) => {
  const response = await route.fetch();
  await route.fulfill({
    response,
    body:
      (await response.text()) +
      '\nwindow.__check={get streamer(){return streamer},get uniforms(){return uniforms},get city(){return city},get lights(){return obstructionLights},views:()=>views};',
  });
});
const base = process.env.URL || 'http://localhost:5173/';
const settle = async () => {
  await page.waitForFunction(() => window.__city?.complete, null, { timeout: 180000 });
  await page.waitForTimeout(1000);
};
try {
  if (process.env.NAVIGATION_ONLY !== '1') {
  await page.goto(base + '?view=civic&date=11-02&hour=13&lod=1');
  await settle();
  report.comparisons = await page.evaluate(async () => {
    const { makeQuadGeometry } = await import('/src/quadGeometry.ts');
    const { makeVoxelMaterial } = await import('/src/voxelMaterial.ts');
    const { streamer, uniforms, lights, city } = window.__check;
    const { renderer, scene, camera, controls, daylight, post, setHour, map } = window.__three;
    renderer.setAnimationLoop(null);
    uniforms.uTime.value = 1;
    const gl = renderer.getContext();
    const mats = [makeVoxelMaterial(uniforms, false), makeVoxelMaterial(uniforms, false)];
    mats[1].polygonOffset = true;
    mats[1].polygonOffsetFactor = -1;
    mats[1].polygonOffsetUnits = -2;
    const entries = [...streamer.nodes.values()]
      .filter((n) => n.mesh)
      .map((n) => {
        const m = n.mesh,
          g = m.geometry,
          b = g.boundingBox;
        return {
          m,
          geometry: g,
          material: m.material,
          depth: m.customDepthMaterial,
          distance: m.customDistanceMaterial,
          expanded: makeQuadGeometry(g.attributes.qOrigin.data.array, [...b.min.toArray(), ...b.max.toArray()], false),
          foliage: n.foliage,
        };
      });
    const pixels = () => {
      const a = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, a);
      return a;
    };
    const render = (raw) => {
      daylight.invalidateShadow();
      renderer.shadowMap.autoUpdate = true;
      if (raw) {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
      } else for (let i = 0; i < 5; i++) post.composer.render();
      return pixels();
    };
    const mode = (packed) => {
      for (const e of entries) {
        e.m.geometry = packed ? e.geometry : e.expanded;
        e.m.material = packed ? e.material : mats[+e.foliage];
        e.m.customDepthMaterial = packed ? e.depth : undefined;
        e.m.customDistanceMaterial = packed ? e.distance : undefined;
      }
    };
    const results = [];
    for (const hour of [13, 19.5]) {
      setHour(hour);
      daylight.fitShadow(controls.target, camera, camera.position.distanceTo(controls.target), map);
      lights.update(1, daylight.night, renderer.getPixelRatio(), city.gate, city.levelAt);
      for (const raw of [true, false]) {
        mode(true);
        const packed = render(raw);
        mode(false);
        const expanded = render(raw);
        let total = 0,
          over8 = 0,
          max = 0;
        for (let i = 0; i < packed.length; i++) {
          const delta = Math.abs(packed[i] - expanded[i]);
          total += delta;
          over8 += delta > 8;
          max = Math.max(max, delta);
        }
        results.push({ hour, raw, mean: total / packed.length, fractionOver8: over8 / packed.length, max });
      }
    }
    mode(true);
    entries.forEach((e) => e.expanded.dispose());
    mats.forEach((m) => m.dispose());
    renderer.shadowMap.autoUpdate = false;
    return results;
  });
  for (const c of report.comparisons) {
    assert(c.mean < 0.3, JSON.stringify(c));
    assert(c.fractionOver8 < 0.002, JSON.stringify(c));
  }
  console.log('Packed/expanded comparisons', JSON.stringify(report.comparisons));
  }

  if (process.env.GEOMETRY_ONLY !== '1') {
  let failed = false;
  await page.route('**/data/tiles/4/3_1.bin', async (route) => {
    if (!failed) {
      failed = true;
      await route.fulfill({ status: 503, body: 'injected transient failure' });
    } else await route.continue();
  });
  await page.goto(base + '?view=default&date=11-02&hour=13');
  await settle();
  await page.evaluate(() => {
    window.__coverage = { samples: 0, failures: [], peakBytes: 0 };
    window.__coverageTimer = setInterval(() => {
      const s = window.__check.streamer,
        c = window.__check.city,
        grid = new Uint8Array(33 * 29);
      for (const key of c.selection.active) {
        const n = s.nodes.get(key);
        if (!n || n.foliage) continue;
        for (let y = n.ty * n.s; y < Math.min((n.ty + 1) * n.s, 29); y++)
          for (let x = n.tx * n.s; x < Math.min((n.tx + 1) * n.s, 33); x++) grid[y * 33 + x]++;
      }
      const r = window.__coverage;
      r.samples++;
      r.peakBytes = Math.max(r.peakBytes, s.memory.total);
      if (grid.some((n) => n !== 1) && r.failures.length < 10)
        r.failures.push({ uncovered: grid.filter((n) => n === 0).length, overlap: grid.filter((n) => n > 1).length });
    }, 100);
  });
  const snapshot = () =>
    page.evaluate(() => {
      const s = window.__check.streamer,
        c = window.__check.city,
        selection = c.selection;
      let uncovered = 0,
        overlap = 0;
      // Sample each finest tile center; active base tiles must partition the whole city.
      for (let y = 64; y < 3600; y += 128)
        for (let x = 64; x < 4200; x += 128) {
          let hits = 0;
          for (const key of selection.active) {
            const n = s.nodes.get(key);
            if (n && !n.foliage) {
              const L = n.s * 128;
              if (x >= n.tx * L && x < (n.tx + 1) * L && y >= n.ty * L && y < (n.ty + 1) * L) hits++;
            }
          }
          uncovered += hits === 0;
          overlap += hits > 1;
        }
      return {
        camera: window.__three.camera.position.toArray(),
        memory: s.memory,
        stats: { ...s.stats },
        nodes: s.nodes.size,
        leaves: selection.leaves.length,
        queue: s.queue.length,
        inflight: s.inflight,
        workers: s.pool.length,
        uncovered,
        overlap,
        complete: c.complete,
        glError: window.__three.renderer.getContext().getError(),
      };
    });
  report.navigation.push(await snapshot());
  for (const view of ['civic', 'bunkerhill', 'viaduct', 'historic', 'default']) {
    await page.evaluate((name) => {
      const v = window.__check.views()[name],
        { camera, controls } = window.__three;
      camera.position.fromArray(v.pos);
      controls.target.fromArray(v.target);
      controls.update();
      // Force the next selection tick, rather than waiting on stale completion state.
    }, view);
    await page.waitForTimeout(350);
    await settle();
    await page.waitForTimeout(2200);
    report.navigation.push({ view, ...(await snapshot()) });
  }
  // Repeated rapid changes while requests are in progress exercise cancellation and stale identities.
  for (const view of ['civic', 'viaduct', 'lalive', 'bunkerhill', 'historic']) {
    await page.evaluate((name) => {
      const v = window.__check.views()[name],
        { camera, controls } = window.__three;
      camera.position.fromArray(v.pos);
      controls.target.fromArray(v.target);
      controls.update();
    }, view);
    await page.waitForTimeout(180);
  }
  await settle();
  await page.waitForTimeout(2500);
  report.navigation.push({ view: 'rapid-turns', ...(await snapshot()) });
  for (const n of report.navigation) {
    assert.equal(n.uncovered, 0);
    assert.equal(n.overlap, 0);
    assert.equal(n.glError, 0);
    assert(n.memory.total < 220 * 1024 ** 2);
    assert(n.workers <= 4);
    assert(n.leaves <= 384);
  }
  assert(report.navigation.at(-1).stats.evicted > 0, 'Navigation must exercise eviction');
  report.injectedFailure = failed;
  assert(failed, 'Failure injection must be exercised');
  assert(
    report.navigation.some((n) => n.stats.failed > 0),
    'Failed job must be counted',
  );
  report.coverage = await page.evaluate(() => {
    clearInterval(window.__coverageTimer);
    return window.__coverage;
  });
  assert.deepEqual(report.coverage.failures, []);
  await page.evaluate(() => {
    const r = window.__three.renderer;
    r.domElement.addEventListener('webglcontextrestored', () => (window.__restored = true), { once: true });
    r.forceContextLoss();
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__three.renderer.forceContextRestore());
  await page.waitForFunction(() => window.__restored, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  report.contextRestored = await snapshot();
  assert.equal(report.contextRestored.glError, 0);
  await page.evaluate(() => {
    const v = window.__check.views().default,
      { camera, controls } = window.__three;
    camera.position.fromArray(v.pos);
    controls.target.fromArray(v.target);
    controls.update();
  });
  await page.waitForTimeout(350);
  await settle();
  await page.waitForTimeout(2500);
  report.afterRestoreEviction = await snapshot();
  assert.equal(report.afterRestoreEviction.glError, 0);
  await page.screenshot({ path: '../artifacts/profiling/adaptive-validated.png' });
  assert.deepEqual(report.errors, []);
  console.log(
    'Streaming/restore checks passed',
    JSON.stringify(report.navigation.map((n) => ({ view: n.view, MiB: n.memory.total / 2 ** 20, stats: n.stats }))),
  );
  }
} finally {
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
