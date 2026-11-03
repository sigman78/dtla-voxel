// Package the already-built static site using cf's v0 Build Output format.
// Validated with cf 0.15.0. `cf deploy --prebuilt --dry-run` checks the package.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../cloudflare.config.ts';
import { versionData } from './version-data.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = path.join(root, 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('Run npm run build first');
const output = path.resolve(root, '.cloudflare/output');
if (!output.startsWith(root + path.sep)) throw new Error('Build output must stay inside the project');
fs.rmSync(output, { recursive: true, force: true });
const version = path.join(output, 'v0'), worker = path.join(version, 'workers/default');
fs.mkdirSync(worker, { recursive: true });
fs.cpSync(dist, path.join(worker, 'assets'), { recursive: true });
if (!process.argv.includes('--no-immutable-cache')) {
  versionData(path.join(worker, 'assets/data'));
  fs.copyFileSync(new URL('./cloudflare-headers', import.meta.url), path.join(worker, 'assets/_headers'));
}
fs.writeFileSync(path.join(worker, 'worker.config.json'), JSON.stringify(config.worker));
fs.writeFileSync(path.join(version, 'config.json'), JSON.stringify({ accountId: config.accountId, buildContext: { isPreview: false } }));
console.log('Packaged static assets for ' + config.worker.domains.join(', '));
