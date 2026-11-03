import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Runs on build output only. Source data stays untouched. Legacy paths remain for
// older open tabs; content-addressed aliases let unchanged files survive code/data updates in browser cache.
export function versionData(directory) {
  const metaFile = path.join(directory, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const assets = {}, immutable = path.join(directory, 'immutable');
  fs.mkdirSync(immutable, { recursive: true });
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (file === immutable) continue;
      if (entry.isDirectory()) { visit(file); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.bin')) continue;
      const bytes = fs.readFileSync(file);
      const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32);
      const target = path.join(immutable, `${hash}.bin`);
      if (fs.existsSync(target)) {
        if (!fs.readFileSync(target).equals(bytes)) throw new Error('Content-hash collision');
      } else fs.writeFileSync(target, bytes);
      assets[path.relative(directory, file).split(path.sep).join('/')] = hash;
    }
  }
  visit(directory);
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, assets }) + '\n');
  return assets;
}
