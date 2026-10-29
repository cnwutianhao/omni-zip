/**
 * 生成应用主图标 build/icon.png（默认 1024px，8-bit RGBA）
 *
 * 为什么纯 Node 手写：
 * 用 macOS 的 osascript + Cocoa 画图只能跑在 Mac 上，在 Windows / Linux 上改图标
 * 就没法重新生成。这里只依赖内置 zlib（PNG 编解码见 scripts/lib/png.mjs），
 * 三平台都能跑，也不引入任何绘图依赖。
 *
 * 用法：node scripts/gen-icon.mjs [尺寸=1024] [输出=build/icon.png]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './lib/png.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIZE = Number(process.argv[2]) || 1024;
const OUT = process.argv[3] || path.join(__dirname, '../build/icon.png');

// ---------------------------------------------------------------- 绘图

/**
 * 极简画布：只需要圆角矩形、渐变填充、抗锯齿。
 * 采用「超采样」而不是精确解析几何：每个像素取 3x3 子样本求平均，
 * 这样边缘足够平滑，代码量也小得多。
 */
function createCanvas(size) {
  const data = Buffer.alloc(size * size * 4);

  /** 在 [px,py] 处按 (r,g,b,a) 混合一个像素（a: 0..1，标准 source-over） */
  function blend(px, py, r, g, b, a) {
    if (a <= 0) return;
    const i = (py * size + px) * 4;
    const dstA = data[i + 3] / 255;
    const outA = a + dstA * (1 - a);
    if (outA <= 0) return;
    data[i] = Math.round((r * a + data[i] * dstA * (1 - a)) / outA);
    data[i + 1] = Math.round((g * a + data[i + 1] * dstA * (1 - a)) / outA);
    data[i + 2] = Math.round((b * a + data[i + 2] * dstA * (1 - a)) / outA);
    data[i + 3] = Math.round(outA * 255);
  }

  return { data, size, blend };
}

/**
 * 抗锯齿填充：用 SS×SS 子样本求覆盖率，再按覆盖率做一次 source-over。
 *
 * 为什么不在 blend 里累加颜色：那样算出来的是"所有命中的子样本的平均颜色 × 覆盖率"，
 * 覆盖率与颜色会互相污染。正确做法是先算覆盖率（几何量），再用形状本身的颜色混合一次。
 *
 * @param {(x:number,y:number)=>(number[]|null)} shape 返回 [r,g,b,a] 或 null
 */
function fillAA(cv, shape, SS = 3) {
  const { size, blend } = cv;
  const total = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shape(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
          if (c) {
            hits++;
            r += c[0];
            g += c[1];
            b += c[2];
            a += c[3];
          }
        }
      }
      if (!hits) continue;
      blend(x, y, r / hits, g / hits, b / hits, (a / hits) * (hits / total));
    }
  }
}

/** 圆角矩形内部判定 */
function inRoundRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const rx = Math.min(Math.max(x, left + radius), right - radius);
  const ry = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - rx;
  const dy = y - ry;
  return dx * dx + dy * dy <= radius * radius;
}

/** 线性渐变求色 */
function lerpColor(c1, c2, t) {
  return [
    c1[0] + (c2[0] - c1[0]) * t,
    c1[1] + (c2[1] - c1[1]) * t,
    c1[2] + (c2[2] - c1[2]) * t
  ];
}

// ---------------------------------------------------------------- 图标设计
//
// 视觉：深色圆角方块 + 蓝紫渐变 + 白色「压缩包」图形（一个带拉链 / 箭头的盒子）
// 与 OmniDown 的视觉语言保持同一家族（圆角 + 渐变 + 深色背景）

function drawIcon(size) {
  const cv = createCanvas(size);
  const s = size / 1024; // 按 1024 设计，按比例缩放

  const pad = 96 * s;
  const r = 200 * s;
  const left = pad;
  const top = pad;
  const right = size - pad;
  const bottom = size - pad;

  // 1) 外层圆角方块：左上到右下渐变（蓝 → 紫）
  //    不透明底：直接写像素，不走 blend（避免 alpha 合成分量取整导致偏色）
  const c1 = [74, 168, 255]; // --accent
  const c2 = [139, 92, 246]; // --accent-2
  const data = cv.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inRoundRect(x + 0.5, y + 0.5, left, top, right, bottom, r)) continue;
      // 对角方向：t 从左上 0 到右下 1
      const tx = (x - left) / (right - left);
      const ty = (y - top) / (bottom - top);
      const t = Math.min(1, Math.max(0, tx * 0.55 + ty * 0.45));
      const c = lerpColor(c1, c2, t);
      const i = (y * size + x) * 4;
      data[i] = Math.round(Math.min(255, c[0]));
      data[i + 1] = Math.round(Math.min(255, c[1]));
      data[i + 2] = Math.round(Math.min(255, c[2]));
      data[i + 3] = 255;
    }
  }

  // 2) 盒身：白色半透明圆角矩形（"压缩包"的下半部分）
  const bodyLeft = 300 * s;
  const bodyTop = 430 * s;
  const bodyRight = size - 300 * s;
  const bodyBottom = size - 300 * s;
  const bodyR = 56 * s;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inRoundRect(x + 0.5, y + 0.5, bodyLeft, bodyTop, bodyRight, bodyBottom, bodyR)) continue;
      cv.blend(x, y, 255, 255, 255, 0.96);
    }
  }

  // 3) 盒盖：比盒身略窄的圆角矩形，中间留一条缝（拉开拉链的观感）
  const lidLeft = 340 * s;
  const lidTop = 268 * s;
  const lidRight = size - 340 * s;
  const lidBottom = 400 * s;
  const lidR = 40 * s;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inRoundRect(x + 0.5, y + 0.5, lidLeft, lidTop, lidRight, lidBottom, lidR)) continue;
      cv.blend(x, y, 255, 255, 255, 0.88);
    }
  }

  // 4) 中间拉链缝（用背景色切一道）
  const seamTop = 400 * s;
  const seamBottom = 430 * s;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (y + 0.5 < seamTop || y + 0.5 > seamBottom) continue;
      if (x + 0.5 < lidLeft + 20 * s || x + 0.5 > lidRight - 20 * s) continue;
      // 用渐变底色覆盖，形成"切开"的效果
      const t = (x - left) / (right - left) * 0.65 + (y - top) / (bottom - top) * 0.35;
      const c = lerpColor(c1, c2, Math.min(1, Math.max(0, t)));
      cv.blend(x, y, c[0] * 0.55, c[1] * 0.55, c[2] * 0.55, 1);
    }
  }

  // 5) 盒身上的"下箭头"（解压/输出语义）
  const cx = size / 2;
  const arrowTop = 500 * s;
  const arrowBottom = 690 * s;
  const shaftHalf = 34 * s;
  const headHalf = 88 * s;
  const headTop = 600 * s;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      // 竖杆
      let inside = Math.abs(px - cx) <= shaftHalf && py >= arrowTop && py <= headTop + shaftHalf;
      // 三角头
      if (!inside && py >= headTop && py <= arrowBottom) {
        const halfAtY = headHalf * (1 - (py - headTop) / (arrowBottom - headTop));
        inside = Math.abs(px - cx) <= halfAtY;
      }
      if (!inside) continue;
      const c = lerpColor(c1, c2, 0.5);
      cv.blend(x, y, c[0], c[1], c[2], 1);
    }
  }

  return cv;
}

// ---------------------------------------------------------------- 主流程

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const canvas = drawIcon(SIZE);
// 图标有透明圆角，必须显式用 RGBA(4)。
// 注意：图标是大面积纯色 + 平滑渐变，自适应行过滤反而会让体积变大
// （过滤后的残差噪声更难压缩），所以这里关掉它、只保留多种 deflate 策略择优。
const png = encodePng(canvas.data, SIZE, SIZE, {
  channels: 4,
  adaptiveFilter: false,
  level: 9
});
fs.writeFileSync(OUT, png);
console.log(`✅ 生成 ${OUT} (${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(1)} KB)`);
