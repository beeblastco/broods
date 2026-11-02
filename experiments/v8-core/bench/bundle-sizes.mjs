/**
 * Bytes per source package in a bundle, from its source map: each generated
 * segment counts toward the source it maps to, up to the next segment.
 * node bundle-sizes.mjs <bundle.js.map> <bundle.js>  (prints JSON)
 */
import { readFileSync } from "node:fs";
const [mapPath, jsPath] = process.argv.slice(2);
const map = JSON.parse(readFileSync(mapPath, "utf8"));
const js = readFileSync(jsPath, "utf8");
const lines = js.split("\n");
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const val = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i++) val[B64.charCodeAt(i)] = i;
const bytes = new Float64Array(map.sources.length);
let unmapped = 0;
let src = 0;
const mlines = map.mappings.split(";");
for (let li = 0; li < mlines.length; li++) {
  const line = lines[li] ?? "";
  const segs = [];
  let col = 0,
    i = 0;
  const s = mlines[li];
  while (i < s.length) {
    const fields = [];
    while (i < s.length && s[i] !== ",") {
      let shift = 0,
        value = 0,
        c;
      do {
        c = val[s.charCodeAt(i++)];
        value += (c & 31) << shift;
        shift += 5;
      } while (c & 32);
      fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
    }
    i++;
    col += fields[0];
    // Only the source index matters here; its delta runs across lines.
    if (fields.length > 1) {
      src += fields[1];
      segs.push([col, src]);
    } else segs.push([col, -1]);
  }
  if (segs.length === 0) {
    unmapped += line.length + 1;
    continue;
  }
  unmapped += segs[0][0];
  for (let k = 0; k < segs.length; k++) {
    const end = k + 1 < segs.length ? segs[k + 1][0] : line.length + 1;
    const n = end - segs[k][0];
    if (segs[k][1] >= 0) bytes[segs[k][1]] += n;
    else unmapped += n;
  }
}
const groups = new Map();
for (let i = 0; i < map.sources.length; i++) {
  const p = map.sources[i];
  let key;
  const m =
    p.match(/node_modules\/\.bun\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)/) ||
    p.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (m) key = "npm:" + m[1];
  else {
    const w = p.match(
      /home\/user\/broods\/((?:apps|packages)\/[^/]+(?:\/src\/[^/]+)?)/,
    );
    key = w ? w[1] : p.replace(/^(\.\.\/)+/, "");
  }
  groups.set(key, (groups.get(key) ?? 0) + bytes[i]);
}
const total = bytes.reduce((a, b) => a + b, 0) + unmapped;
const rows = [...groups].sort((a, b) => b[1] - a[1]);
console.log(
  JSON.stringify({
    total: total,
    unmapped: unmapped,
    sources: map.sources.length,
    rows: rows,
  }),
);
