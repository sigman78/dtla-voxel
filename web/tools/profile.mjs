// Local Vite profiling; runtime instrumentation only, no viewer source changes.
// node tools/profile.mjs [output.json]
// URL, CHROME, VIEWS (comma-separated), HOUR, SAMPLE_MS, ROUNDS, VARIANTS override defaults.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const out = process.argv[2] || 'profile.json';
const root = path.join(os.homedir(), 'AppData/Local/ms-playwright');
const executablePath = process.env.CHROME || (fs.existsSync(root) && fs.readdirSync(root)
  .filter(n => /^chromium-\d+$/.test(n)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1])
  .map(n => path.join(root, n, 'chrome-win64/chrome.exe')).find(p => fs.existsSync(p)));
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }),
  headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
const browserCdp = await browser.newBrowserCDPSession();
let messageId = 0;
const replies = new Map();
browserCdp.on('Target.receivedMessageFromTarget', ({ message }) => {
  const m = JSON.parse(message); replies.get(m.id)?.(m);
});
async function workerHeaps() {
  const { targetInfos } = await browserCdp.send('Target.getTargets');
  return Promise.all(targetInfos.filter(t => t.type === 'worker').map(async target => {
    let sessionId;
    try {
      ({ sessionId } = await browserCdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false }));
      const id = ++messageId;
      let timer;
      const response = new Promise(resolve => {
        replies.set(id, resolve);
        timer = setTimeout(() => resolve({ error: 'worker busy: heap sampling timed out' }), 1500);
      });
      await browserCdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method: 'Runtime.getHeapUsage' }) });
      const result = await response; clearTimeout(timer); replies.delete(id);
      return { targetId: target.targetId, ...result };
    } catch (e) { return { targetId: target.targetId, error: String(e) }; }
    finally { if (sessionId) await browserCdp.send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
  }));
}
const report = { date: new Date().toISOString(), browser: browser.version(), viewport: { width: 1600, height: 1000 },
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), cpu: os.cpus()[0]?.model,
  worktreeDirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
  hour: +(process.env.HOUR || 13), sampleMs: +(process.env.SAMPLE_MS || 6000), rounds: +(process.env.ROUNDS || 2), runs: [] };
const save = () => { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2)); };
try {
  for (const view of (process.env.VIEWS || 'civic,bunkerhill').split(',')) {
    const context = await browser.newContext({ viewport: report.viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
    // Expose lexical instances in the served module only; files on disk stay untouched.
    await page.route('**/src/main.ts*', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()) + '\nwindow.__profileTargets = { get streamer() { return streamer; }, get labels() { return labels; } };' });
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const started = Date.now();
    await page.goto(`${process.env.URL || 'http://127.0.0.1:5175/'}?view=${view}&hour=${report.hour}&date=11-02&lod=1`);
    const loading = [];
    while (Date.now() - started < 300000) {
      const sample = await page.evaluate(() => {
        const s = window.__profileTargets?.streamer;
        return { at: performance.now(), ready: !!window.__ready, complete: !!window.__city?.complete,
          workers: s?.pool.length ?? 0, queued: s?.queue.length ?? 0, inflight: s?.inflight ?? 0,
          readyTiles: s ? [...s.nodes.values()].filter(n => n.state === 'ready').length : 0,
          heap: performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null };
      });
      loading.push(sample);
      if (loading.length % 4 === 0 && sample.workers) sample.workerHeaps = await workerHeaps();
      if (loading.length % 20 === 0) console.log(view, 'loading', sample.readyTiles, 'tiles;', sample.workers, 'workers;', sample.queued, 'queued');
      if (sample.complete) break;
      await page.waitForTimeout(500);
    }
    if (!loading.at(-1)?.complete) throw new Error('Tile loading timed out');
    const run = { view, loadMs: Date.now() - started, loading, errors, measurements: [] };
    report.runs.push(run); save();
    console.log(view, 'loaded', run.loadMs, 'ms; peak workers', Math.max(...loading.map(s => s.workers)));
    await page.waitForTimeout(5000);
    run.environment = await page.evaluate(() => {
      const { renderer, post, daylight } = window.__three;
      const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        gpuTimers: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'), hardwareConcurrency: navigator.hardwareConcurrency,
        pixelRatio: renderer.getPixelRatio(), shadowSize: daylight.sun.shadow.mapSize.toArray(),
        passes: post.composer.passes.map(p => ({ name: p.name, effects: p.effects?.map(e => e.name) })),
        workersAfterIdle: window.__profileTargets.streamer.pool.length };
    });
    run.idleWorkerHeaps = await workerHeaps();
    console.log(JSON.stringify(run.environment));
    await page.evaluate(() => {
      const { renderer, post, daylight, controls } = window.__three;
      const { streamer, labels } = window.__profileTargets;
      controls.saveState();
      const shadowAutoUpdate = renderer.shadowMap.autoUpdate;
      const gl = renderer.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const p = window.__prof = { data: {}, active: false, pending: [], epoch: 0, last: 0, effects: [...post.composer.passes.at(-1).effects] };
      const record = (key, value) => { if (p.active) (p.data[key] ??= []).push(value); };
      const wrap = (obj, key, name) => {
        const fn = obj[key];
        obj[key] = function (...args) { const t = performance.now(); const result = fn.apply(this, args); record(name, performance.now() - t); return result; };
      };
      wrap(daylight, 'fitShadow', 'shadowFitCpuMs');
      const labelUpdate = labels.update;
      labels.update = function (...args) { if (p.noLabels) return; const t = performance.now(); const v = labelUpdate.apply(this, args); record('labelsCpuMs', performance.now() - t); return v; };
      wrap(streamer, 'update', 'streamUpdateCpuMs');
      const shadowRender = renderer.shadowMap.render;
      renderer.shadowMap.render = function (...args) {
        const before = renderer.info.render.calls;
        const t = performance.now(), v = shadowRender.apply(this, args);
        record('shadowSubmitCpuMs', performance.now() - t); record('shadowDrawCalls', renderer.info.render.calls - before); return v;
      };
      for (const [i, pass] of post.composer.passes.entries()) {
        const fn = pass.render;
        pass.render = function (...args) {
          const q = ext && p.active ? gl.createQuery() : null;
          if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
          const t = performance.now(); const v = fn.apply(this, args);
          record(`pass${i}CpuMs`, performance.now() - t);
          if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); p.pending.push({ q, i, epoch: p.epoch }); }
          return v;
        };
      }
      const render = post.composer.render;
      renderer.info.autoReset = false;
      post.composer.render = function (...args) {
        const now = performance.now();
        if (p.last) record('frameIntervalMs', now - p.last);
        p.last = now;
        if (ext) {
          const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
          p.pending = p.pending.filter(entry => {
            if (disjoint || gl.getQueryParameter(entry.q, gl.QUERY_RESULT_AVAILABLE)) {
              if (!disjoint && entry.epoch === p.epoch) record(`pass${entry.i}GpuMs`, gl.getQueryParameter(entry.q, gl.QUERY_RESULT) / 1e6);
              gl.deleteQuery(entry.q); return false;
            }
            return true;
          });
        }
        renderer.info.reset();
        const t = performance.now(), v = render.apply(this, args);
        record('composerCpuMs', performance.now() - t);
        record('drawCalls', renderer.info.render.calls); record('triangles', renderer.info.render.triangles);
        return v;
      };
      p.configure = variant => {
        p.active = false;
        controls.autoRotate = false; controls.reset();
        renderer.shadowMap.autoUpdate = variant === 'always-shadows' ? true : variant === 'frozen-shadows' ? false : shadowAutoUpdate;
        renderer.shadowMap.needsUpdate = true;
        daylight.sun.shadow.needsUpdate = true;
        post.n8.enabled = variant !== 'no-ao';
        post.composer.passes[2].enabled = variant !== 'no-bloom';
        p.noLabels = variant === 'no-labels';
        const height = post.setHeightOriginal ??= post.setHeight;
        post.setHeight = (...args) => { height(...args); if (variant === 'no-blur') post.composer.passes[3].enabled = false; };
        const final = post.composer.passes.at(-1);
        final.setEffects(variant === 'no-aa' ? p.effects.filter(e => e.name !== 'SMAAEffect') : p.effects);
        final.recompile();
        controls.autoRotate = variant === 'moving'; controls.autoRotateSpeed = 0.5;
      };
      p.snapshot = () => {
        const stats = {};
        for (const [key, values] of Object.entries(p.data)) {
          const a = [...values].sort((a,b) => a-b);
          stats[key] = { n: a.length, mean: a.reduce((s,v) => s+v,0)/a.length, p50: a[Math.floor(a.length*.5)], p95: a[Math.min(a.length-1,Math.floor(a.length*.95))] };
        }
        const buffers = new Set(), indices = new Set(); let columnBytes = 0, geometryBufferBytes = 0;
        for (const n of streamer.nodes.values()) {
          if (n.data) for (const a of Object.values(n.data)) if (ArrayBuffer.isView(a) && !buffers.has(a.buffer)) { buffers.add(a.buffer); columnBytes += a.buffer.byteLength; }
          // Attribute arrays are released after upload; use the formats in stream.makeMesh.
          if (n.mesh) {
            for (const [name, a] of Object.entries(n.mesh.geometry.attributes)) geometryBufferBytes += a.count * a.itemSize * (name === 'vattr' ? 1 : 2);
            const index = n.mesh.geometry.index;
            if (index && !indices.has(index)) { indices.add(index); geometryBufferBytes += index.count * 4; }
          }
        }
        return { stats, memory: { columnBytes, geometryBufferBytes, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures,
          workers: streamer.pool.length, nodes: streamer.nodes.size, meshes: [...streamer.nodes.values()].filter(n=>n.mesh).length },
          camera: window.__three.camera.position.toArray() };
      };
    });
    const variants = (process.env.VARIANTS || 'baseline,frozen-shadows,no-ao,no-bloom,no-blur,no-aa,no-labels').split(',');
    for (let round = 0; round < report.rounds; round++) {
      for (const variant of round % 2 ? [...variants].reverse() : variants) {
        await page.evaluate(v => window.__prof.configure(v), variant);
        await page.waitForTimeout(1500);
        await page.evaluate(() => { const p = window.__prof; p.data = {}; p.last = 0; p.epoch++; p.active = true; });
        await page.waitForTimeout(report.sampleMs);
        const result = await page.evaluate(() => { const p = window.__prof; p.active = false; return p.snapshot(); });
        run.measurements.push({ variant, round, ...result }); save();
        console.log(view, round, variant, 'frame', result.stats.frameIntervalMs?.mean.toFixed(2), 'ms; composer', result.stats.composerCpuMs?.mean.toFixed(2), 'ms');
      }
    }
    run.pageHeap = await cdp.send('Runtime.getHeapUsage');
    run.performance = (await cdp.send('Performance.getMetrics')).metrics;
    save();
    await context.close();
  }
} finally { save(); await browser.close(); }
