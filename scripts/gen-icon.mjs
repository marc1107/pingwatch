// Generates the 1024x1024 source icon (latency pulse on a dark tile) as a raw
// PNG without any image-library dependency. Platform icon formats are derived
// from the output via `tauri icon`.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const S = 1024;
const px = new Float64Array(S * S * 4);

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function roundedRectDist(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function segDist(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  const t = clamp01(((x - x1) * dx + (y - y1) * dy) / len2);
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

// Latency trace: calm baseline, one dramatic spike, recovery.
const base = 620;
const pts = [
  [120, base + 8], [220, base - 10], [300, base + 14], [380, base - 6],
  [450, base + 10], [520, base - 4], [575, 300], [630, base + 6],
  [700, base - 12], [780, base + 8], [860, base - 6], [904, base + 4],
];

function traceDist(x, y) {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    d = Math.min(d, segDist(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  }
  return d;
}

const peak = [575, 300];

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    let r = 0, g = 0, b = 0, a = 0;

    // Tile: rounded square with vertical navy->indigo gradient.
    const dTile = roundedRectDist(x, y, S / 2, S / 2, 448, 448, 200);
    const tileA = clamp01(0.5 - dTile);
    if (tileA > 0) {
      const t = y / S;
      r = lerp(9, 30, t); g = lerp(14, 27, t); b = lerp(31, 75, t);
      // Subtle radial glow behind the spike peak.
      const glow = Math.exp(-(((x - peak[0]) ** 2 + (y - peak[1]) ** 2)) / (2 * 260 ** 2));
      r += 20 * glow; g += 60 * glow; b += 80 * glow;
      // Faint horizontal grid lines.
      const grid = Math.abs(((y % 148) + 148) % 148 - 74) < 1.4 ? 0.05 : 0;
      r += 255 * grid * 0.3; g += 255 * grid * 0.5; b += 255 * grid * 0.6;
      a = tileA;
    }

    // Pulse line with cyan glow.
    const dLine = traceDist(x, y);
    const core = clamp01(1.6 - Math.max(0, dLine - 13) * 0.5);
    const halo = Math.exp(-Math.max(0, dLine - 13) / 46) * 0.42;
    if (tileA > 0 && (core > 0 || halo > 0)) {
      const lr = 34, lg = 211, lb = 238;
      r = lerp(r, lr, Math.min(1, core + halo * 0.6));
      g = lerp(g, lg, Math.min(1, core + halo * 0.6));
      b = lerp(b, lb, Math.min(1, core + halo * 0.6));
    }

    // White-hot dot at the spike peak.
    const dDot = Math.hypot(x - peak[0], y - peak[1]);
    const dot = clamp01(1.5 - Math.max(0, dDot - 26) * 0.4);
    if (tileA > 0 && dot > 0) {
      r = lerp(r, 255, dot); g = lerp(g, 255, dot); b = lerp(b, 255, dot);
    }

    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a * 255;
  }
}

// Encode PNG (RGBA8, no filter).
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  const row = y * (S * 4 + 1);
  raw[row] = 0;
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const o = row + 1 + x * 4;
    raw[o] = Math.round(clamp01(px[i] / 255) * 255);
    raw[o + 1] = Math.round(clamp01(px[i + 1] / 255) * 255);
    raw[o + 2] = Math.round(clamp01(px[i + 2] / 255) * 255);
    raw[o + 3] = Math.round(clamp01(px[i + 3] / 255) * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = process.argv[2] ?? "src-tauri/icon-source.png";
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
