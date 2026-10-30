/**
 * GZIP / BZIP2 / XZ 单文件压缩引擎
 *
 * 这三种格式本质是「单文件流压缩」，没有文件名表（GZIP 有可选的原始名）。
 * 所以：
 * - 解压出来只有一个文件（名字取 GZIP 头里的 FNAME，或用压缩包名去扩展名）
 * - 若解出来的内容本身是 tar（`tar.gz` / `.tgz` 等），调用方会继续按 tar 解包
 *
 * 压缩/解压全部复用 Node 内置 zlib，完全不依赖外部程序。
 * BZIP2 与 XZ 不在内置范围（Node 内置 zlib 只提供 DEFLATE / GZIP / Brotli），
 * 这里仅导出格式描述，解压/压缩由 external-tool.js 统一调度外部 7-Zip。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { AbortError } from './zip-engine.js';

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

/** 读取 GZIP 头部元信息（原始文件名与修改时间） */
export function gzipInfo(buf) {
  const name = gzipOriginalName(buf);
  let mtime = null;
  if (buf && buf.length >= 10) {
    const t = buf.readUInt32LE(4);
    if (t > 0) mtime = new Date(t * 1000);
  }
  return { originalName: name, mtime };
}

/**
 * 解压 GZIP 到指定文件。
 * @param {string} srcPath
 * @param {string} destPath
 * @param {(n: number) => void} [onProgress]
 * @param {{ shouldAbort?: () => boolean }} [opts]
 */
export async function gunzipTo(srcPath, destPath, onProgress, opts = {}) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const src = fs.createReadStream(srcPath, { highWaterMark: 1 << 16 });
  const gunzip = zlib.createGunzip();
  const out = fs.createWriteStream(destPath);
  gunzip.on('data', (c) => {
    if (opts.shouldAbort && opts.shouldAbort()) {
      gunzip.destroy(new AbortError());
      return;
    }
    if (onProgress) onProgress(c.length);
  });
  try {
    await pipeline(src, gunzip, out);
  } catch (err) {
    await fsp.rm(destPath, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * 压缩文件为 GZIP。
 * @param {string} srcPath
 * @param {string} destPath
 * @param {{ level?: number, onProgress?: (n:number)=>void, shouldAbort?: () => boolean }} [opts]
 */
export async function gzipFrom(srcPath, destPath, opts = {}) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const src = fs.createReadStream(srcPath, { highWaterMark: 1 << 16 });
  const gz = zlib.createGzip({ level: opts.level ?? 6 });
  const out = fs.createWriteStream(destPath);
  src.on('data', (c) => {
    if (opts.shouldAbort && opts.shouldAbort()) {
      src.destroy(new AbortError());
      return;
    }
    if (opts.onProgress) opts.onProgress(c.length);
  });
  try {
    await pipeline(src, gz, out);
  } catch (err) {
    await fsp.rm(destPath, { force: true }).catch(() => {});
    throw err;
  }
}

export const gzipFormat = {
  id: 'gzip',
  name: 'GZIP',
  extensions: ['gz', 'tgz'],
  signature: { offset: 0, bytes: [0x1f, 0x8b] },
  canExtract: true,
  canCreate: true,
  description: 'GZIP / TAR.GZ 压缩（RFC 1952）'
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
