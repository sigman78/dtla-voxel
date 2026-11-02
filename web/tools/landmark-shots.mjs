// Repeatable landmark review: node tools/landmark-shots.mjs <output-dir> [lod=1] [hours=10.5,15.8,19.5]
// Uses the running viewer at URL (default localhost:5173). Artifacts belong in DTLA_CACHE/shots.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const [output, lod = '1', hours = '10.5,15.8,19.5'] = process.argv.slice(2);
if (!output) throw new Error('Supply an output directory.');
fs.mkdirSync(output, { recursive: true });
const base = process.env.URL || 'http://localhost:5173/';
const meta = await (await fetch(new URL('data/meta.json', base))).json();
// Reuse a baseline's cameras when metadata/label anchors have changed.
const reference = process.env.REFERENCE ? JSON.parse(fs.readFileSync(process.env.REFERENCE, 'utf8')).shots : [];
const landmarks = [
  ['city-hall', 'Los Angeles City Hall', 420],
  ['broad', 'The Broad', 230],
  ['disney', 'Walt Disney Concert Hall', 310],
  ['union-station', 'Union Station', 330],
  ['us-bank', 'U.S. Bank Tower', 710],
  ['wilshire', 'Wilshire Grand Center', 760],
];
function executable() {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  if (fs.existsSync(root)) for (const dir of fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()) {
    for (const suffix of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) {
      const p = path.join(root, dir, suffix);
      if (fs.existsSync(p)) return p;
    }
  }
}
const exe = executable();
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : { channel: 'chrome' }), headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const errors = [], shots = [];
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1050 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('requestfailed', r => errors.push(`${r.url()}: ${r.failure()?.errorText}`));
  page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  await page.goto(`${base}?view=civic&date=11-02&hour=10.5&ui=0&tilt=0&lod=${lod}`);
  await page.waitForFunction(() => window.__city?.complete === true, null, { timeout: 300000, polling: 500 });
  for (const [key, name, distance] of landmarks) {
    const label = meta.labels.find(l => l.name === name);
    if (!label) throw new Error(`Missing landmark label: ${name}`);
    for (const hour of hours.split(',').map(Number)) {
      const fixed = reference.find(s => s.key === key)?.camera;
      const camera = await page.evaluate(({ label, distance, hour, fixed }) => {
        const { camera, controls, setHour } = window.__three;
        const ground = label.g ?? 20;
        const height = Math.max(10, label.z - ground);
        controls.target.set(label.x, ground + height * 0.48, label.y);
        // Across the street grid: see two elevations and the roof without hiding behind the building.
        camera.position.set(label.x - distance * 0.72, controls.target.y + distance * 0.52, label.y + distance * 0.70);
        if (fixed) {
          controls.target.fromArray(fixed.target);
          camera.position.fromArray(fixed.pos);
        }
        controls.update();
        setHour(hour);
        return { pos: camera.position.toArray(), target: controls.target.toArray() };
      }, { label, distance, hour, fixed });
      await page.waitForTimeout(800);
      const filename = `${key}-${hour}.png`;
      await page.screenshot({ path: path.join(output, filename) });
      const stats = await page.evaluate(() => {
        const { renderer, scene, daylight } = window.__three;
        const lights = scene.getObjectByName('Aviation obstruction lights');
        if (lights && lights.visible !== (daylight.night > 0.001 && lights.geometry.getAttribute('position').count > 0)) {
          throw new Error('Obstruction lights do not match daylight state');
        }
        // Postprocessing resets render counters between passes; memory counts remain meaningful.
        return { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures,
          obstructionLights: lights ? { visible: lights.visible, count: lights.geometry.getAttribute('position').count,
            loaded: Array.from(lights.geometry.getAttribute('enabled').array).filter(Boolean).length } : null };
      });
      shots.push({ key, name, hour, lod: +lod, filename, camera, stats });
      console.log(filename);
    }
  }
} finally {
  await browser.close();
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ shots, errors }, null, 2));
}
if (errors.length) throw new Error(errors.join('\n'));
