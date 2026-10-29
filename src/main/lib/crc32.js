/**
 * CRC-32 (IEEE 802.3 / ZIP 标准多项式 0xEDB88320)
 *
 * 为什么不用 zlib.crc32：它对大块数据走原生实现确实更快，但 Node 20.15 才加入，
 * 而本项目的 engines 是 >= 22 —— 用得上。这里仍保留纯 JS 表实现作为兜底，
 * 因为打包用的 Electron 内置 Node 版本可能低于 package.json 声明（Electron 33 → Node 20.18），
 * 而 Node 20.18 的 zlib 已带 crc32，所以两条路都通。
 */
import zlib from 'node:zlib';

/** 预生成 256 项查表（懒加载，避免模块 import 时就算） */
let TABLE = null;

function table() {
  if (TABLE) return TABLE;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  TABLE = t;
  return t;
}

/**
 * 增量计算 CRC32。
 * @param {Buffer} buf
 * @param {number} [prev] 上一段的 CRC（首段不传或传 0）
 * @returns {number} 32 位无符号 CRC
 */
export function crc32(buf, prev = 0) {
  if (typeof zlib.crc32 === 'function') {
    return zlib.crc32(buf, prev) >>> 0;
  }
  const t = table();
  let c = (prev ^ -1) >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ t[(c ^ buf[i]) & 0xff];
  }
  return (c ^ -1) >>> 0;
}

/** 流式 CRC 累加器：避免把整个文件读进内存 */
export class Crc32Stream {
  constructor() {
    this.value = 0;
  }
  update(buf) {
    this.value = crc32(buf, this.value);
    return this;
  }
  digest() {
    return this.value >>> 0;
  }
}
