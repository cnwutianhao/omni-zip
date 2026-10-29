/**
 * PNG 编解码与缩放（纯 Node，只用内置 zlib）
 *
 * 为什么自己写：本项目零运行时依赖，图标与文档截图的小工具也不该为了
 * 「压缩一张 PNG」去装 sharp / pngjs（都是几十 MB 的原生或大体积依赖）。
 *
 * 支持范围（够用即止，不做通用实现）：
 * - 8-bit、非隔行、colorType 2(RGB) / 6(RGBA)
 * - 解码支持全部 5 种行过滤
 * - 编码用**自适应行过滤**（逐行试 5 种，取绝对值和最小的），这是截图类
 *   图像体积能降一半以上的关键；固定用 filter 0 会把体积做大 2~4 倍
 */
import zlib from 'node:zlib';

// ---------------------------------------------------------------- CRC

let CRC_TABLE = null;

function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  CRC_TABLE = t;
  return t;
}

function crc32(buf) {
  const t = crcTable();
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ t[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// ---------------------------------------------------------------- 解码

/**
 * 解码 PNG。
 * @param {Buffer} buf
 * @returns {{ width:number, height:number, channels:3|4, pixels:Buffer, hasAlpha:boolean }}
 */
export function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件');

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }

  if (bitDepth !== 8) throw new Error(`只支持 8-bit PNG，当前 ${bitDepth} bit`);
  if (interlace !== 0) throw new Error('不支持隔行（Adam7）PNG');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`只支持 RGB/RGBA，当前 colorType=${colorType}`);

  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);

  let p = 0;
  for (let y = 0; y < height; y++) {
    if (p >= inflated.length) throw new Error('PNG 数据被截断');
    const filter = inflated[p++];
    inflated.copy(cur, 0, p, p + stride);
    p += stride;

    // 反滤波（PNG 规范 9.2）
    switch (filter) {
      case 0:
        break;
      case 1:
        for (let i = bpp; i < stride; i++) cur[i] = (cur[i] + cur[i - bpp]) & 0xff;
        break;
      case 2:
        for (let i = 0; i < stride; i++) cur[i] = (cur[i] + prev[i]) & 0xff;
        break;
      case 3:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? cur[i - bpp] : 0;
          cur[i] = (cur[i] + ((a + prev[i]) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? cur[i - bpp] : 0;
          const b = prev[i];
          const c = i >= bpp ? prev[i - bpp] : 0;
          cur[i] = (cur[i] + paeth(a, b, c)) & 0xff;
        }
        break;
      default:
        throw new Error(`未知的行过滤类型 ${filter}`);
    }

    cur.copy(out, y * stride);
    cur.copy(prev);
  }

  return { width, height, channels, pixels: out, hasAlpha: channels === 4 };
}

/** PNG 规范的 Paeth 预测器 */
function paeth(a, b, c) {
  const pa = Math.abs(b - c);
  const pb = Math.abs(a - c);
  const pc = Math.abs(a + b - 2 * c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// ---------------------------------------------------------------- 编码

/**
 * 应用某一种行过滤，返回该行的过滤数据。
 * @param {number} type 0..4
 */
function applyFilter(type, cur, prev, bpp, stride, out) {
  switch (type) {
    case 0:
      cur.copy(out);
      break;
    case 1:
      for (let i = 0; i < stride; i++) out[i] = (cur[i] - (i >= bpp ? cur[i - bpp] : 0)) & 0xff;
      break;
    case 2:
      for (let i = 0; i < stride; i++) out[i] = (cur[i] - prev[i]) & 0xff;
      break;
    case 3:
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        out[i] = (cur[i] - ((a + prev[i]) >> 1)) & 0xff;
      }
      break;
    case 4:
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        out[i] = (cur[i] - paeth(a, b, c)) & 0xff;
      }
      break;
    default:
      throw new Error(`未知的过滤类型 ${type}`);
  }
}

/**
 * 打分：把字节当作有符号数取绝对值和。
 * 这是 libpng 的启发式，实践上足够好（比熵估算便宜得多）。
 */
function filterScore(buf, len) {
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const v = buf[i];
    sum += v < 128 ? v : 256 - v;
  }
  return sum;
}

/**
 * 编码 PNG。
 *
 * @param {Buffer} pixels  RGB 或 RGBA 连续像素
 * @param {number} width
 * @param {number} height
 * @param {{ channels?: 3|4, adaptiveFilter?: boolean, level?: number, strategies?: boolean }} [opts]
 *   channels 省略时按 pixels.length / (width*height) 推断
 * @returns {Buffer}
 */
export function encodePng(pixels, width, height, opts = {}) {
  const channels = opts.channels || (pixels.length === width * height * 3 ? 3 : 4);
  if (pixels.length !== width * height * channels) {
    throw new Error(`像素数据长度不符：期望 ${width * height * channels}，实际 ${pixels.length}`);
  }

  const adaptive = opts.adaptiveFilter !== false;
  const bpp = channels;
  const stride = width * bpp;
  const rowLen = stride;

  const raw = Buffer.alloc((rowLen + 1) * height);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  const scratch = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    pixels.copy(cur, 0, y * stride, (y + 1) * stride);

    let bestType = 0;
    let bestScore = Infinity;
    let bestBuf = null;

    // 逐行试所有过滤，取最优。首行没有 prev，Up/Paeth 退化成 Sub/None，
    // 但照样参与比较——它们是无害的。
    const candidates = adaptive ? [0, 1, 2, 3, 4] : [0];
    for (const t of candidates) {
      applyFilter(t, cur, prev, bpp, stride, scratch);
      const score = filterScore(scratch, stride);
      if (score < bestScore) {
        bestScore = score;
        bestType = t;
        if (!bestBuf) bestBuf = Buffer.alloc(stride);
        scratch.copy(bestBuf);
      }
    }

    const off = y * (rowLen + 1);
    raw[off] = bestType;
    bestBuf.copy(raw, off + 1);

    cur.copy(prev);
  }

  // 多种 deflate 策略各试一遍，取最小（差别有时能到 10%）
  const level = opts.level ?? 9;
  const tries = opts.strategies === false
    ? [{ level }]
    : [
        { level, memLevel: 9, strategy: zlib.constants.Z_DEFAULT_STRATEGY },
        { level, memLevel: 9, strategy: zlib.constants.Z_FILTERED },
        { level, memLevel: 9, strategy: zlib.constants.Z_RLE }
      ];

  let idat = null;
  for (const opt of tries) {
    const d = zlib.deflateSync(raw, opt);
    if (!idat || d.length < idat.length) idat = d;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // color type
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** 去掉全不透明的 alpha 通道（RGBA → RGB，原始数据直接少 25%） */
export function dropOpaqueAlpha(pixels, width, height) {
  const n = width * height;
  for (let i = 0; i < n; i++) {
    if (pixels[i * 4 + 3] !== 255) return null;
  }
  const out = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = pixels[i * 4];
    out[i * 3 + 1] = pixels[i * 4 + 1];
    out[i * 3 + 2] = pixels[i * 4 + 2];
  }
  return out;
}

// ---------------------------------------------------------------- 缩放

/**
 * 面积平均（box filter）缩放。
 *
 * 缩小截图用这个比双线性更好：双线性只采样 2×2，细小的 UI 文字会走样；
 * box 会把该区域所有像素都平均进去，边缘更稳。放大时退化成最近邻的平滑版本。
 *
 * @param {Buffer} pixels
 * @param {number} sw 源宽
 * @param {number} sh 源高
 * @param {number} dw 目标宽
 * @param {number} dh 目标高
 * @param {3|4} channels
 * @returns {Buffer}
 */
export function boxResize(pixels, sw, sh, dw, dh, channels = 3) {
  if (sw === dw && sh === dh) return Buffer.from(pixels);

  const out = Buffer.alloc(dw * dh * channels);
  const xRatio = sw / dw;
  const yRatio = sh / dh;

  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.min(sh, Math.max(y0 + 1, Math.ceil((y + 1) * yRatio)));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.min(sw, Math.max(x0 + 1, Math.ceil((x + 1) * xRatio)));

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      let n = 0;

      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * sw + sx) * channels;
          if (channels === 4) {
            // 按 alpha 加权，避免透明像素把边缘拉黑
            const a = pixels[i + 3] / 255;
            sumR += pixels[i] * a;
            sumG += pixels[i + 1] * a;
            sumB += pixels[i + 2] * a;
            sumA += a;
          } else {
            sumR += pixels[i];
            sumG += pixels[i + 1];
            sumB += pixels[i + 2];
          }
          n++;
        }
      }

      const o = (y * dw + x) * channels;
      if (channels === 4) {
        if (sumA > 0) {
          out[o] = Math.round(sumR / sumA);
          out[o + 1] = Math.round(sumG / sumA);
          out[o + 2] = Math.round(sumB / sumA);
          out[o + 3] = Math.round((sumA / n) * 255);
        }
      } else if (n > 0) {
        out[o] = Math.round(sumR / n);
        out[o + 1] = Math.round(sumG / n);
        out[o + 2] = Math.round(sumB / n);
      }
    }
  }
  return out;
}
