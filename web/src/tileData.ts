export interface RawColumns {
  counts: Uint16Array;
  runs: Uint16Array;
}
export interface Columns extends RawColumns {
  ground: Uint8Array;
}
export interface QueryColumns {
  off: Uint32Array;
  ground: Uint8Array;
  runs: Uint16Array;
}

export function decodeTile(buf: ArrayBuffer, N: number) {
  const cells = (N + 2) ** 2;
  if (buf.byteLength < cells * 3 || cells % 2) throw new Error('Invalid tile header/alignment');
  const counts = new Uint16Array(buf, 0, cells),
    ground = new Uint8Array(buf, cells * 2, cells);
  let n = 0;
  for (const count of counts) n += count;
  const start = cells * 3,
    end = start + n * 6;
  if (end > buf.byteLength || (buf.byteLength - end) % 8) throw new Error('Invalid tile runs/detail');
  return { counts, ground, runs: new Uint16Array(buf, start, n * 3), detail: new Uint16Array(buf, end) };
}

// Adjacent occupied runs can differ in palette but are identical to collision/raycast queries.
export function compactColumns(c: Columns): QueryColumns {
  const off = new Uint32Array(c.counts.length + 1);
  let source = 0,
    n = 0;
  for (let i = 0; i < c.counts.length; i++) {
    let end = -1;
    for (let j = 0; j < c.counts[i]; j++, source += 3) {
      if (c.runs[source] !== end) n++;
      end = c.runs[source] + c.runs[source + 1];
    }
    off[i + 1] = n;
  }
  const runs = new Uint16Array(n * 2);
  source = 0;
  n = 0;
  for (let i = 0; i < c.counts.length; i++) {
    let end = -1;
    for (let j = 0; j < c.counts[i]; j++, source += 3) {
      const start = c.runs[source],
        length = c.runs[source + 1];
      if (start === end) runs[(n - 1) * 2 + 1] += length;
      else {
        runs[n * 2] = start;
        runs[n * 2 + 1] = length;
        n++;
      }
      end = start + length;
    }
  }
  return { off, ground: c.ground.slice(), runs };
}

// Eight ushort fields: local XYZ, UV extents, palette, normal|ground<<8, AO|cornerOrder<<8.
export function expandQuads(records: Uint16Array) {
  const quads = records.length / 8;
  const pos = new Uint16Array(quads * 12),
    attr = new Uint8Array(quads * 12),
    pal = new Uint16Array(quads * 4);
  const axes = [0, 2, 1];
  for (let q = 0; q < quads; q++) {
    const k = q * 8,
      normal = records[k + 6] & 255,
      d = (normal & 7) >> 1;
    const u = axes[(d + 1) % 3],
      v = axes[(d + 2) % 3];
    for (let i = 0; i < 4; i++) {
      const p = (q * 4 + i) * 3,
        corner = (records[k + 7] >> (8 + i * 2)) & 3;
      pos.set(records.subarray(k, k + 3), p);
      if (corner & 1) pos[p + u] += records[k + 3];
      if (corner & 2) pos[p + v] += records[k + 4];
      attr[p] = normal;
      attr[p + 1] = (records[k + 7] >> (i * 2)) & 3;
      attr[p + 2] = records[k + 6] >> 8;
      pal[q * 4 + i] = records[k + 5];
    }
  }
  return { pos, attr, pal };
}
