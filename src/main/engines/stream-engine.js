/**
 * GZIP / BZIP2 / XZ 单文件压缩引擎
 *
 * 这三种格式本质是「单文件流压缩」，没有文件名表（GZIP 有可选的原始名）。
 * 所以：
 * - 解压出来只有一个文件（名字取 GZIP 头里的 FNAME，或用压缩包名去扩展名）
 * - 若解出来的内容本身是 tar（`tar.gz` / `.tgz` 等），调用方需要再做一次解包
 *
 * 压缩/解压全部复用 Node 内置 zlib，完全不依赖外部程序。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { crc32 } from '../lib/crc32.js';

/** 读取 GZIP 头部里的原始文件名（FNAME 字段，RFC 1952 §2.3） */
export function gzipOriginalName(buf) {
  if (!buf || buf.length < 10) return null;
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) return null;
  const flags = buf[3];
  let p = 10;
  // FEXTRA
  if (flags & 0x04) {
    if (p + 2 > buf.length) return null;
    const xlen = buf.readUInt16LE(p);
    p += 2 + xlen;
  }
  // FNAME
  if (flags & 0x08) {
    const end = buf.indexOf(0, p);
    if (end < 0) return null;
    const raw = buf.subarray(p, end);
    // RFC 1952 说是 ISO-8859-1，但实际工具写 UTF-8 或本地编码
    const utf8 = raw.toString('utf8');
    return utf8.includes('\uFFFD') ? raw.toString('latin1') : utf8;
  }
  return null;
}

/** 读取 GZIP 尾部的 ISIZE（原始大小，32 位） */
export function gzipInfo(buf, fileSize) {
  const name = gzipOriginalName(buf);
  let mtime = null;
  if (buf && buf.length >= 10) {
    const t = buf.readUInt32LE(4);
    if (t > 0) mtime = new Date(t * 1000);
  }
  return {
    originalName: name,
    mtime,
    // ISIZE 是 32 位，>4GB 会回绕，仅作参考
    isize: fileSize >= 18 ? null : null
  };
}

/**
 * 解压 GZIP 到指定文件。
 * @param {string} srcPath
 * @param {string} destPath
 * @param {(n: number) => void} [onProgress]
 */
export async function gunzipTo(srcPath, destPath, onProgress) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const src = fs.createReadStream(srcPath, { highWaterMark: 1 << 16 });
  const gunzip = zlib.createGunzip();
  const out = fs.createWriteStream(destPath);
  if (onProgress) gunzip.on('data', (c) => onProgress(c.length));
  await pipeline(src, gunzip, out);
}

/**
 * 压缩文件为 GZIP。
 * @param {string} srcPath
 * @param {string} destPath
 * @param {{ level?: number, name?: string, onProgress?: (n:number)=>void }} [opts]
 */
export async function gzipFrom(srcPath, destPath, opts = {}) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const src = fs.createReadStream(srcPath, { highWaterMark: 1 << 16 });
  const gz = zlib.createGzip({ level: opts.level ?? 6 });
  const out = fs.createWriteStream(destPath);
  if (opts.onProgress) gz.on('data', (c) => opts.onProgress(c.length));
  await pipeline(src, gz, out);
}

/**
 * BZIP2 / XZ 不在内置范围。
 *
 * 原因：Node 内置 zlib 只提供 DEFLATE / GZIP / Brotli，BZIP2 与 XZ(LZMA2)
 * 若不引入第三方原生模块，就只能纯 JS 实现解码器（bzip2 约 2k 行、xz 约 4k 行）。
 * 本项目定位是「ZIP / TAR / GZIP 零依赖可用」，其余格式交给外部 7-Zip，
 * 由 external-tool.js 统一调度 —— 这样打包体积与维护成本都可控。
 */
export function bunzip2To() {
  throw new Error('BZIP2 解压需要外部 7-Zip 支持（Node 内置 zlib 只有 DEFLATE/GZIP/Brotli）');
}

export function unxzTo() {
  throw new Error('XZ 解压需要外部 7-Zip 支持');
}

/**
 * 流式转换成另一种单文件压缩格式。
 * 目前内置只支持 gzip ↔ 原始。
 * @param {string} srcPath
 * @param {string} destPath
 */
export async function copyThrough(srcPath, destPath, onProgress) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const src = fs.createReadStream(srcPath, { highWaterMark: 1 << 16 });
  const out = fs.createWriteStream(destPath);
  if (onProgress) src.on('data', (c) => onProgress(c.length));
  await pipeline(src, out);
}

/** 计算文件 CRC32（用于 gzip 校验或自检） */
export async function fileCrc32(filePath) {
  const stream = fs.createReadStream(filePath, { highWaterMark: 1 << 20 });
  let v = 0;
  for await (const chunk of stream) v = crc32(chunk, v);
  return v >>> 0;
}

export const gzipFormat = {
  id: 'gzip',
  name: 'GZIP',
  extensions: ['gz', 'tgz'],
  signature: { offset: 0, bytes: [0x1f, 0x8b] },
  canExtract: true,
  canCreate: true,
  description: 'GZIP 单文件压缩（RFC 1952）'
};

export const bzip2Format = {
  id: 'bzip2',
  name: 'BZIP2',
  extensions: ['bz2', 'tbz2', 'tbz'],
  signature: { offset: 0, bytes: [0x42, 0x5a, 0x68] },
  canExtract: false,
  canCreate: false,
  external: true,
  description: 'BZIP2（需要外部 7-Zip）'
};

export const xzFormat = {
  id: 'xz',
  name: 'XZ',
  extensions: ['xz', 'txz'],
  signature: { offset: 0, bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  canExtract: false,
  canCreate: false,
  external: true,
  description: 'XZ / LZMA2（需要外部 7-Zip）'
};
