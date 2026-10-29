/**
 * 从 build/icon.png 生成 Windows 多尺寸 build/icon.ico
 *
 * Windows 的标题栏 / 任务栏 / 资源管理器 / 桌面分别取不同尺寸，
 * ICO 缺尺寸时系统会缩放导致发糊。这里输出 16/24/32/48/64/128/256 七种。
 *
 * 纯 Node 实现（PNG 编解码见 scripts/lib/png.mjs），三平台都能跑，无需安装依赖。
 * 256 尺寸用 PNG 压缩条目（Windows Vista+ 支持），其余用传统 BMP 条目（兼容性最好）。
 *
 * 用法：node scripts/gen-icon-ico.mjs [源png] [输出ico]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng, boxResize } from './lib/png.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2] || path.join(__dirname, '../build/icon.png');
const OUT = process.argv[3] || path.join(__dirname, '../build/icon.ico');

const SIZES = [16, 24, 32, 48, 64, 128, 256];

// ---------------------------------------------------------------- ICO 条目

/**
 * 构造 BMP 类型的 ICO 条目（BITMAPINFOHEADER + BGRA 像素 + AND 掩码）。
 *
 * 两个容易写错的点：
 * 1. 头部 height 要写 **2 倍**（XOR 图 + AND 掩码图各占一倍）
 * 2. 像素是**自底向上**、**BGRA** 顺序（与 PNG 的 top-down RGBA 相反）
 *
 * @param {Buffer} rgba 尺寸为 size×size 的 RGBA 像素
 * @param {number} size
 */
function bmpEntry(rgba, size) {
  const headerSize = 40;
  const xorSize = size * size * 4;
  // AND mask：每行按 32 位（4 字节）对齐
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const andSize = maskRowBytes * size;

  const buf = Buffer.alloc(headerSize + xorSize + andSize);

  buf.writeUInt32LE(headerSize, 0);
  buf.writeInt32LE(size, 4); // width
  buf.writeInt32LE(size * 2, 8); // height ×2
  buf.writeUInt16LE(1, 12); // planes
  buf.writeUInt16LE(32, 14); // bit count
  buf.writeUInt32LE(0, 16); // compression: BI_RGB
  buf.writeUInt32LE(xorSize + andSize, 20); // image size

  // XOR 图：自底向上、BGRA
  let p = headerSize;
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      buf[p++] = rgba[i + 2]; // B
      buf[p++] = rgba[i + 1]; // G
      buf[p++] = rgba[i]; // R
      buf[p++] = rgba[i + 3]; // A
    }
  }

  // AND 掩码：alpha=0 的像素置 1（透明）。
  // 32 位 ICO 里系统主要看 alpha 通道，但掩码仍要写对，
  // 否则某些老版本 Shell 会在黑色背景上画出白边。
  const maskStart = headerSize + xorSize;
  for (let y = 0; y < size; y++) {
    const rowStart = maskStart + (size - 1 - y) * maskRowBytes;
    for (let x = 0; x < size; x++) {
      if (rgba[(y * size + x) * 4 + 3] === 0) {
        buf[rowStart + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }

  return buf;
}

/**
 * 256×256 用内嵌 PNG 条目（体积比 BMP 小一个数量级，Windows Vista+ 支持）。
 */
function pngEntryFor(rgba, size) {
  return encodePng(rgba, size, size, { channels: 4, adaptiveFilter: false, level: 9 });
}

// ---------------------------------------------------------------- 主流程

if (!fs.existsSync(SRC)) {
  console.error(`❌ 源文件不存在：${SRC}`);
  console.error('   先跑 node scripts/gen-icon.mjs 生成 build/icon.png');
  process.exit(1);
}

const src = decodePng(fs.readFileSync(SRC));
console.log(`读取 ${SRC} (${src.width}×${src.height})`);

if (src.channels !== 4) {
  // ICO 的 BMP 条目要求 32 位 BGRA；源图若是 RGB，补一个全不透明 alpha
  const n = src.width * src.height;
  const rgba = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    rgba[i * 4] = src.pixels[i * 3];
    rgba[i * 4 + 1] = src.pixels[i * 3 + 1];
    rgba[i * 4 + 2] = src.pixels[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  src.pixels = rgba;
  src.channels = 4;
  console.log('通道  RGB → RGBA（补全不透明 alpha）');
}

const images = SIZES.map((size) => {
  const rgba = boxResize(src.pixels, src.width, src.height, size, size, 4);
  const data = size === 256 ? pngEntryFor(rgba, size) : bmpEntry(rgba, size);
  return { size, data };
});

// ICO 目录：6 字节头 + 每项 16 字节
const dirSize = 6 + images.length * 16;
const header = Buffer.alloc(dirSize);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: 1 = icon
header.writeUInt16LE(images.length, 4);

let offset = dirSize;
images.forEach((img, i) => {
  const p = 6 + i * 16;
  // ICO 目录里 256 用 0 表示（因为字段只有 1 字节）
  header[p] = img.size >= 256 ? 0 : img.size;
  header[p + 1] = img.size >= 256 ? 0 : img.size;
  header[p + 2] = 0; // 调色板颜色数（0 = 真彩）
  header[p + 3] = 0; // reserved
  header.writeUInt16LE(1, p + 4); // planes
  header.writeUInt16LE(32, p + 6); // bit count
  header.writeUInt32LE(img.data.length, p + 8);
  header.writeUInt32LE(offset, p + 12);
  offset += img.data.length;
});

const ico = Buffer.concat([header, ...images.map((i) => i.data)]);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, ico);
console.log(
  `✅ 生成 ${OUT} (${(ico.length / 1024).toFixed(1)} KB, ${SIZES.length} 种尺寸: ${SIZES.join('/')})`
);
