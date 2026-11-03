import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import { versionedData } from './tools/version-data.mjs';

// Dev only: test data sets kept outside public/ (so they never land in dist), e.g. web/data-warsaw, a junction to
// warsaw-vibe-voxel's web/public/data. Served raw at /data-<name>/...; open the viewer with ?data=data-<name>.
function testData() {
  return {
    name: 'test-data',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/(data-[\w-]+)\/(.+)$/.exec(decodeURIComponent((req.url ?? '').split('?')[0]));
        if (!m) return next();
        const root = path.resolve(import.meta.dirname, m[1]), file = path.resolve(root, m[2]);
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
        res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [testData(), versionedData()],
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 2000 },
});
