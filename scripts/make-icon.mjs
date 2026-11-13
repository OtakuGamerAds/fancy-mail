// Draws Fancy Mail's icons into apps/desktop/build/ (no image tools needed):
//
//   icon.png         512×512, the app icon: a blue envelope on a black rounded square
//   icon.ico         16…256 px, for the .exe, the installer and the taskbar
//   icon.icns        16…1024 px, for the Mac app: the same square on Apple's icon grid (it
//                    fills 824 of 1024 px, centered, like every Mac app icon)
//   icon-256.png     the window and notification icon (embedded into main.cjs)
//   tray-<n>.png     16, 20, 24, 32, 40, 48 px: the envelope alone, for the notification area
//                    at 100 %…300 % display scaling (embedded into main.cjs)
//
// The blue is T3 Code's primary, oklch(0.571 0.21 264), shading to #3b5bdb at the bottom.
// Run: node scripts/make-icon.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const OUT = path.join(import.meta.dirname, "..", "apps", "desktop", "build");

// ── Colors ──────────────────────────────────────────────────────────────────────────────────

/** OKLCH → sRGB bytes (clamped). */
function oklch(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((c) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  });
}
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

const BLUE_TOP = oklch(0.571, 0.21, 264);
const BLUE_BOTTOM = hex("#3b5bdb");
const BG_TOP = hex("#18181b");
const BG_BOTTOM = hex("#050506");

// ── Shapes (on a 32-unit grid; x, y in units) ───────────────────────────────────────────────

/** Signed distance to a rounded rectangle (negative inside). */
function roundedRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

/** Distance to the segment a→b. */
function segment(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/**
 * The envelope: a rounded body with the flap's "V" cut into it. `e` is its box in units:
 * { cx, cy, hw, hh, r, line } (line: half the width of the V).
 */
function envelope(x, y, e) {
  const body = roundedRect(x, y, e.cx, e.cy, e.hw, e.hh, e.r) <= 0;
  if (!body) return false;
  const top = e.cy - e.hh;
  const inset = e.r * 0.75;
  const left = [e.cx - e.hw + inset, top + inset * 0.9];
  const right = [e.cx + e.hw - inset, top + inset * 0.9];
  const tip = [e.cx, e.cy + e.hh * 0.12];
  const v = Math.min(segment(x, y, ...left, ...tip), segment(x, y, ...tip, ...right));
  return v > e.line;
}

// ── Rendering (4×4 supersampling per pixel) ─────────────────────────────────────────────────

const SS = 4;

/** Apple's icon grid: the rounded square is 824 px of a 1024 px canvas, centered. */
const MAC_ICON_SCALE = 824 / 1024;

/**
 * The app icon: black rounded square, hairline edge, blue envelope. `scale` is how much of the
 * canvas the square fills (1 on Windows; less on a Mac, which leaves a margin around icons).
 */
function drawApp(size, scale = 1) {
  const rgba = Buffer.alloc(size * size * 4);
  const u = 32 / size / scale; // units per pixel
  const offset = 16 - 16 / scale; // the square stays centered
  const env = { cx: 16, cy: 16.4, hw: 9.6, hh: 6.9, r: 2.3, line: 0.8 };
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgCover = 0;
      let edgeCover = 0;
      let envCover = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * u + offset;
          const y = (py + (sy + 0.5) / SS) * u + offset;
          const d = roundedRect(x, y, 16, 16, 16, 16, 7);
          if (d <= 0) {
            bgCover++;
            // A hairline just inside the edge (about one pixel at 32 px) keeps the square
            // visible on a black taskbar.
            if (d > -Math.max(0.3, u)) edgeCover++;
            if (envelope(x, y, env)) envCover++;
          }
        }
      }
      const n = SS * SS;
      const t = Math.min(1, Math.max(0, (py * u + offset) / 32));
      let color = mix(BG_TOP, BG_BOTTOM, scale === 1 ? py / (size - 1) : t);
      color = mix(color, [255, 255, 255], (edgeCover / n) * 0.09);
      const blue = mix(BLUE_TOP, BLUE_BOTTOM, Math.min(1, Math.max(0, (py * u + offset - 9.5) / 14)));
      const envT = bgCover ? envCover / bgCover : 0;
      color = mix(color, blue, envT);
      const i = (py * size + px) * 4;
      rgba[i] = Math.round(color[0]);
      rgba[i + 1] = Math.round(color[1]);
      rgba[i + 2] = Math.round(color[2]);
      rgba[i + 3] = Math.round((255 * bgCover) / n);
    }
  }
  return rgba;
}

/** The tray icon: the envelope alone, filling the square (the V is see-through). */
function drawTray(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const u = 32 / size;
  const env = { cx: 16, cy: 16, hw: 14.5, hh: 10.5, r: 3.2, line: size <= 16 ? 1.45 : 1.25 };
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let cover = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * u;
          const y = (py + (sy + 0.5) / SS) * u;
          if (envelope(x, y, env)) cover++;
        }
      }
      const color = mix(BLUE_TOP, BLUE_BOTTOM, py / (size - 1));
      const i = (py * size + px) * 4;
      rgba[i] = Math.round(color[0]);
      rgba[i + 1] = Math.round(color[1]);
      rgba[i + 2] = Math.round(color[2]);
      rgba[i + 3] = Math.round((255 * cover) / (SS * SS));
    }
  }
  return rgba;
}

// ── Encoders ────────────────────────────────────────────────────────────────────────────────

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA → PNG (8-bit RGBA, filter 0 on every row). */
function png(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** RGBA → a 32-bit BMP image as stored in an .ico (bottom-up BGRA + a 1-bit AND mask). */
function icoBitmap(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND masks
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = ((size - 1 - y) * size + x) * 4;
      pixels[dst] = rgba[src + 2];
      pixels[dst + 1] = rgba[src + 1];
      pixels[dst + 2] = rgba[src];
      pixels[dst + 3] = rgba[src + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size); // all zero: alpha decides
  return Buffer.concat([header, pixels, mask]);
}

/** Several sizes → .ico: bitmaps up to 64 px (every tool reads them), PNG for 256 px. */
function ico(images) {
  const dir = Buffer.alloc(6 + images.length * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  const blobs = images.map(({ size, rgba }, index) => {
    const blob = size >= 256 ? png(rgba, size) : icoBitmap(rgba, size);
    const at = 6 + index * 16;
    dir[at] = size >= 256 ? 0 : size;
    dir[at + 1] = size >= 256 ? 0 : size;
    dir[at + 2] = 0;
    dir[at + 3] = 0;
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(blob.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += blob.length;
    return blob;
  });
  return Buffer.concat([dir, ...blobs]);
}

/**
 * PNGs → .icns (what a Mac app bundle uses). Each entry is an OSType and a PNG; every macOS
 * since 10.7 reads PNG entries.
 */
function icns(entries) {
  const blobs = entries.map(([type, data]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(blobs);
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/** The .icns sizes: OSType → pixels (the @2x ones are the next size up). */
const ICNS_TYPES = [
  ["icp4", 16],
  ["icp5", 32],
  ["ic11", 32],
  ["ic12", 64],
  ["ic07", 128],
  ["ic13", 256],
  ["ic08", 256],
  ["ic14", 512],
  ["ic09", 512],
  ["ic10", 1024],
];

// ── Output ──────────────────────────────────────────────────────────────────────────────────

fs.mkdirSync(OUT, { recursive: true });
const write = (name, data) => {
  fs.writeFileSync(path.join(OUT, name), data);
  console.log(`wrote apps/desktop/build/${name} (${data.length} bytes)`);
};

write("icon.png", png(drawApp(512), 512));
write("icon-256.png", png(drawApp(256), 256));
write("icon.ico", ico([16, 20, 24, 32, 40, 48, 64, 256].map((size) => ({ size, rgba: drawApp(size) }))));
for (const size of [16, 20, 24, 32, 40, 48]) write(`tray-${size}.png`, png(drawTray(size), size));
const macPngs = new Map([16, 32, 64, 128, 256, 512, 1024].map((size) => [size, png(drawApp(size, MAC_ICON_SCALE), size)]));
write("icon.icns", icns(ICNS_TYPES.map(([type, size]) => [type, macPngs.get(size)])));
