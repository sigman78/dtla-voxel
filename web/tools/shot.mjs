// Headless screenshot of the running viewer, with its console errors.
// usage: node tools/shot.mjs out.png [query] [width] [height]
//   URL=http://localhost:5173/ (default)  CHROME=<path to chrome.exe> (default: Chrome, else a Playwright Chromium)
//   WAIT=complete|ready (default complete: every tile in)  TMO=<ms>  SETTLE=<ms>  EVAL=<js run before the shot>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const [out = 'shot.png', q = '', w = 1600, h = 1000] = process.argv.slice(2);

function findChromium() {
  if (process.env.CHROME) return process.env.CHROME;
  const roots = [path.join(os.homedir(), 'AppData/Local/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
      for (const exe of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
        const p = path.join(root, dir, exe);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

const executablePath = findChromium();
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }), headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.type(), m.text().slice(0, 300)); });
page.on('requestfailed', (r) => console.log('[reqfail]', r.url(), r.failure()?.errorText));
page.on('response', (r) => { if (r.status() >= 400) console.log('[http]', r.status(), r.url()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const t0 = Date.now();
await page.goto(`${process.env.URL || 'http://localhost:5173/'}?${q}`);
const tmo = +(process.env.TMO || 300000);
await page.waitForFunction(() => window.__ready === true, null, { timeout: tmo });
if ((process.env.WAIT || 'complete') === 'complete') await page.waitForFunction(() => window.__city?.complete === true, null, { timeout: tmo, polling: 500 });
console.log('loaded in', Date.now() - t0, 'ms');
if (process.env.EVAL) console.log('eval:', JSON.stringify(await page.evaluate(process.env.EVAL)));
await page.waitForTimeout(+(process.env.SETTLE || 2500));
await page.screenshot({ path: out });
await browser.close();
