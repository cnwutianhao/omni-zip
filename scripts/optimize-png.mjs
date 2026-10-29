/**
 * 优化文档与图标用的 PNG
 *
 * 做法（按收益排序）：
 * 1. **缩放**：Retina 截图（2x）在 README 里显示宽度一般 800~900 CSS px，
 *    保留 2160 宽纯属浪费。默认缩到 1600 宽，文字仍清晰。
 * 2. **去掉不透明 alpha**：RGBA → RGB，原始数据少 25%（截图通常全不透明）。
 * 3. **自适应行过滤**：逐行取最优 filter。原图用固定 filter 0（None），
 *    这是体积最大的选择。
 * 4. **多种 deflate 策略取最小**：DEFAULT / FILTERED / RLE 各试一遍。
 *
 * 用法：
 *   node scripts/optimize-png.mjs                        # 优化 docs/screenshot.png
 *   node scripts/optimize-png.mjs in.png out.png 1600    # 指定输入/输出/最大宽度
 *   node scripts/optimize-png.mjs in.png out.png 0       # 0 = 不缩放，只重编码
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng, boxResize, dropOpaqueAlpha } from './lib/png.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = process.argv[2] || path.join(__dirname, '../docs/screenshot.png');
const OUT = process.argv[3] || SRC;
const MAX_W = process.argv[4] !== undefined ? Number(process.argv[4]) : 1600;

if (!fs.existsSync(SRC)) {
  console.error(`❌ 文件不存在：${SRC}`);
  process.exit(1);
}

const before = fs.statSync(SRC).size;
const img = decodePng(fs.readFileSync(SRC));

let pixels = img.pixels;
let channels = img.channels;
let width = img.width;
let height = img.height;

console.log(`输入  ${path.basename(SRC)}  ${width}×${height}  ${channels === 4 ? 'RGBA' : 'RGB'}  ${(before / 1024).toFixed(1)} KB`);

// 1) 缩放（只在超过阈值时）
if (MAX_W > 0 && width > MAX_W) {
  const ratio = MAX_W / width;
  const nw = MAX_W;
  const nh = Math.max(1, Math.round(height * ratio));
  pixels = boxResize(pixels, width, height, nw, nh, channels);
  console.log(`缩放  ${width}×${height} → ${nw}×${nh}`);
  width = nw;
  height = nh;
}

// 2) 去掉全不透明的 alpha
if (channels === 4) {
  const rgb = dropOpaqueAlpha(pixels, width, height);
  if (rgb) {
    pixels = rgb;
    channels = 3;
    console.log('通道  RGBA → RGB（无透明像素）');
  }
}

// 3) + 4) 自适应过滤 + 多策略压缩
const out = encodePng(pixels, width, height, { channels, adaptiveFilter: true, level: 9 });
fs.writeFileSync(OUT, out);

const after = out.length;
const saved = ((1 - after / before) * 100).toFixed(1);
console.log(`输出  ${path.basename(OUT)}  ${width}×${height}  ${channels === 4 ? 'RGBA' : 'RGB'}  ${(after / 1024).toFixed(1)} KB`);
console.log(`节省  ${saved}%  （${(before / 1024).toFixed(1)} KB → ${(after / 1024).toFixed(1)} KB）`);
