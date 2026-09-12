/* 生成应用图标：build/icon.png 与多尺寸 build/icon.ico（不依赖任何第三方库） */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BASE = 256;
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SAMPLES = 4;

function crcTable() {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
}

const CRC = crcTable();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = (crc >>> 8) ^ CRC[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([body, data])), 0);
  return Buffer.concat([length, body, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function insideRoundedRect(x, y, left, top, width, height, radius) {
  if (x < left || y < top || x > left + width || y > top + height) return false;
  const cx = Math.min(Math.max(x, left + radius), left + width - radius);
  const cy = Math.min(Math.max(y, top + radius), top + height - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function insideEllipse(x, y, cx, cy, rx, ry, angle) {
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const px = x - cx;
  const py = y - cy;
  const lx = px * cos - py * sin;
  const ly = px * sin + py * cos;
  return (lx * lx) / (rx * rx) + (ly * ly) / (ry * ry) <= 1;
}

/* 图标：圆角红底 + 白色音量波形（完全对称，小尺寸自动减少条数以免糊在一起） */
/* 竖条布局：按尺寸自适应条数，整组严格水平居中、垂直居中 */
function waveBars(size) {
  const compact = size <= 32;
  const count = compact ? 3 : 5;
  const width = compact ? 30 : 24;
  const gap = compact ? 16 : 12;
  const heights = compact ? [96, 168, 96] : [76, 132, 176, 132, 76];
  const total = count * width + (count - 1) * gap;
  const start = (BASE - total) / 2;
  return heights.map((height, index) => [start + index * (width + gap), height]);
}

function sampleWave(x, y, size) {
  const width = size <= 32 ? 30 : 24;
  for (const [left, height] of waveBars(size)) {
    if (insideRoundedRect(x, y, left, BASE / 2 - height / 2, width, height, width / 2)) return true;
  }
  return false;
}
function sampleColor(x, y, size) {
  if (!insideRoundedRect(x, y, 0, 0, BASE, BASE, 60)) return [0, 0, 0, 0];
  const t = Math.min(1, Math.max(0, (x * 0.7 + y * 0.3) / BASE));
  let r = Math.round(255 + (210 - 255) * t);
  let g = Math.round(95 + (43 - 95) * t);
  let b = Math.round(79 + (34 - 79) * t);
  const glow = Math.max(0, 1 - Math.hypot(x - 60, y - 40) / 300) * 26;
  r = Math.min(255, r + glow); g = Math.min(255, g + glow); b = Math.min(255, b + glow);
  if (sampleWave(x, y, size)) return [255, 255, 255, 255];
  return [r, g, b, 255];
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = BASE / size;
  const step = 1 / SAMPLES;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = (px + (sx + 0.5) * step) * scale;
          const y = (py + (sy + 0.5) * step) * scale;
          const [cr, cg, cb, ca] = sampleColor(x, y, size);
          const alpha = ca / 255;
          r += cr * alpha;
          g += cg * alpha;
          b += cb * alpha;
          a += alpha;
        }
      }
      const total = SAMPLES * SAMPLES;
      const index = (py * size + px) * 4;
      if (a > 0) {
        rgba[index] = Math.round(r / a);
        rgba[index + 1] = Math.round(g / a);
        rgba[index + 2] = Math.round(b / a);
      }
      rgba[index + 3] = Math.round((a / total) * 255);
    }
  }
  return rgba;
}

function icoImage(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4, 20);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const from = ((size - 1 - y) * size + x) * 4;
      const to = (y * size + x) * 4;
      pixels[to] = rgba[from + 2];
      pixels[to + 1] = rgba[from + 1];
      pixels[to + 2] = rgba[from];
      pixels[to + 3] = rgba[from + 3];
    }
  }
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  return Buffer.concat([header, pixels, mask]);
}

function encodeIco(images) {
  const directory = Buffer.alloc(6 + images.length * 16);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  images.forEach((image, index) => {
    const base = 6 + index * 16;
    directory[base] = image.size >= 256 ? 0 : image.size;
    directory[base + 1] = image.size >= 256 ? 0 : image.size;
    directory.writeUInt16LE(1, base + 4);
    directory.writeUInt16LE(32, base + 6);
    directory.writeUInt32LE(image.data.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += image.data.length;
  });
  return Buffer.concat([directory, ...images.map((image) => image.data)]);
}

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const images = SIZES.map((size) => ({ size, data: icoImage(render(size), size) }));
fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeIco(images));
fs.writeFileSync(path.join(outDir, 'icon.png'), encodePng(BASE, BASE, render(BASE)));
process.stdout.write(`icon.ico (${SIZES.join('/')}) 与 icon.png (${BASE}) 已生成\n`);
