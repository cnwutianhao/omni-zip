/**
 * ZIP 引擎 —— 读取与写入
 *
 * 实现范围（对齐 7-Zip 的 zip handler 的常用子集）：
 * - 读取：以**中央目录**为准枚举条目（本地头不可靠，SFX/流式 ZIP 里长度字段可能是 0）
 * - 方法：STORE(0) / DEFLATE(8)；其余方法（BZIP2/LZMA/PPMd/AES）交给外部 7-Zip
 * - ZIP64：EOCD locator + EOCD64 + extra field 0x0001
 * - 加密：检测 general purpose bit 0，标记为加密但不尝试破解（无密码时直接报错）
 * - 目录条目：名字以 / 结尾，或外部属性高 16 位含 S_IFDIR
 * - Unix 权限：外部属性的高 16 位即 st_mode，解压后可还原
 *
 * 为什么自己实现而不调 7-Zip：
 * ZIP 是最需要"零依赖可用"的格式（用户下载完就能解压），
 * 而 7-Zip 二进制体积大、分发受平台限制。DEFLATE 直接复用 Node 内置 zlib。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { crc32 } from '../lib/crc32.js';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** EOCD 最小 22 字节，注释最长 65535 */
const EOCD_MIN = 22;
const EOCD_MAX_SCAN = EOCD_MIN + 0xffff;

/** 从 extra field 里找指定 tag 的数据（ZIP64 用 0x0001） */
function findExtra(extra, tag) {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const size = extra.readUInt16LE(p + 2);
    if (p + 4 + size > extra.length) return null;
    if (id === tag) return extra.subarray(p + 4, p + 4 + size);
    p += 4 + size;
  }
  return null;
}

/** MS-DOS 日期时间 → JS Date（ZIP 用本地时间，无时区信息） */
function dosToDate(dosTime, dosDate) {
  const year = ((dosDate >> 9) & 0x7f) + 1980;
  const month = ((dosDate >> 5) & 0x0f) - 1;
  const day = dosDate & 0x1f;
  const hour = (dosTime >> 11) & 0x1f;
  const min = (dosTime >> 5) & 0x3f;
  const sec = (dosTime & 0x1f) * 2;
  // 部分打包工具写 0，构造出来是 1979 之类的非法值 → 回退到"未知"
  if (year < 1980 || month < 0 || day < 1) return null;
  const d = new Date(year, month, day, hour, min, sec);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** JS Date → MS-DOS 日期时间 */
function dateToDos(d) {
  const year = Math.max(1980, d.getFullYear());
  const dosDate = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { dosDate, dosTime };
}

/** 判断条目是否为目录 */
function isDirEntry(entry) {
  if (entry.name.endsWith('/') || entry.name.endsWith('\\')) return true;
  // 外部属性：高 16 位是 Unix st_mode；S_IFDIR = 0o040000
  const mode = (entry.externalAttrs >>> 16) & 0xffff;
  return (mode & 0o170000) === 0o040000;
}

/** 取出 Unix 权限位（无则返回 null） */
function unixMode(entry) {
  const mode = (entry.externalAttrs >>> 16) & 0xffff;
  if (!mode) return null;
  const perms = mode & 0o7777;
  return perms || null;
}

export class ZipReader {
  /** @param {string} filePath */
  constructor(filePath) {
    this.filePath = filePath;
    this.fd = null;
    this.size = 0;
    /** @type {Array<object>} */
    this.entries = [];
    this.comment = '';
    /** 是否检测到 ZIP64 结构（仅用于展示） */
    this.zip64 = false;
  }

  /**
   * 打开并解析中央目录。
   * @param {string} filePath
   * @returns {Promise<ZipReader>}
   */
  static async open(filePath) {
    const r = new ZipReader(filePath);
    await r._open();
    return r;
  }

  async _open() {
    this.fd = await fsp.open(this.filePath, 'r');
    const st = await this.fd.stat();
    this.size = st.size;
    await this._readEocd();
    await this._readCentralDirectory();
  }

  /** 读文件尾部并定位 EOCD */
  async _readEocd() {
    if (this.size < EOCD_MIN) throw new Error('不是有效的 ZIP 文件（文件过小）');

    const scanSize = Math.min(this.size, EOCD_MAX_SCAN);
    const buf = Buffer.alloc(scanSize);
    await this.fd.read(buf, 0, scanSize, this.size - scanSize);

    // 从尾部往前找 EOCD 签名（注释长度可变，必须扫描）
    let eocdPos = -1;
    for (let i = scanSize - EOCD_MIN; i >= 0; i--) {
      if (buf.readUInt32LE(i) === SIG_EOCD) {
        // 校验注释长度是否与剩余字节吻合，避免把注释里的伪签名当真的
        const commentLen = buf.readUInt16LE(i + 20);
        if (i + EOCD_MIN + commentLen <= scanSize) {
          eocdPos = i;
          break;
        }
      }
    }
    if (eocdPos < 0) throw new Error('不是有效的 ZIP 文件（找不到中央目录结尾）');

    let centralCount = buf.readUInt16LE(eocdPos + 10);
    let centralSize = buf.readUInt32LE(eocdPos + 12);
    let centralOffset = buf.readUInt32LE(eocdPos + 16);
    const commentLen = buf.readUInt16LE(eocdPos + 20);
    if (commentLen > 0) {
      this.comment = buf.subarray(eocdPos + 22, eocdPos + 22 + commentLen).toString('utf8');
    }

    this.eocdAbs = this.size - scanSize + eocdPos;

    // ZIP64：EOCD 里字段为 0xFFFF/0xFFFFFFFF 时，真实值在 EOCD64 里
    const needZip64 =
      centralCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff;

    if (needZip64 || this.eocdAbs >= 20) {
      const loc = Buffer.alloc(20);
      const locPos = this.eocdAbs - 20;
      if (locPos >= 0) {
        await this.fd.read(loc, 0, 20, locPos);
        if (loc.readUInt32LE(0) === SIG_EOCD64_LOCATOR) {
          const eocd64Offset = Number(loc.readBigUInt64LE(8));
          const hdr = Buffer.alloc(56);
          await this.fd.read(hdr, 0, 56, eocd64Offset);
          if (hdr.readUInt32LE(0) === SIG_EOCD64) {
            this.zip64 = true;
            centralCount = Number(hdr.readBigUInt64LE(32));
            centralSize = Number(hdr.readBigUInt64LE(40));
            centralOffset = Number(hdr.readBigUInt64LE(48));
          }
        }
      }
    }

    if (centralOffset + centralSize > this.size) {
      throw new Error('ZIP 中央目录越界（文件可能已损坏或被截断）');
    }

    this.centralCount = centralCount;
    this.centralSize = centralSize;
    this.centralOffset = centralOffset;
  }

  /** 解析中央目录中的每一条记录 */
  async _readCentralDirectory() {
    const buf = Buffer.alloc(this.centralSize);
    if (this.centralSize > 0) {
      await this.fd.read(buf, 0, this.centralSize, this.centralOffset);
    }

    let p = 0;
    for (let i = 0; i < this.centralCount; i++) {
      if (p + 46 > buf.length) break;
      if (buf.readUInt32LE(p) !== SIG_CENTRAL) {
        // 中央目录损坏：已解析的部分仍然可用，剩下的放弃
        this.truncated = true;
        break;
      }

      const flags = buf.readUInt16LE(p + 8);
      const method = buf.readUInt16LE(p + 10);
      const dosTime = buf.readUInt16LE(p + 12);
      const dosDate = buf.readUInt16LE(p + 14);
      let crc = buf.readUInt32LE(p + 16);
      let compSize = buf.readUInt32LE(p + 20);
      let uncompSize = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const externalAttrs = buf.readUInt32LE(p + 38);
      let localOffset = buf.readUInt32LE(p + 42);

      const nameRaw = buf.subarray(p + 46, p + 46 + nameLen);
      const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      const entryComment = buf.subarray(
        p + 46 + nameLen + extraLen,
        p + 46 + nameLen + extraLen + commentLen
      );

      p += 46 + nameLen + extraLen + commentLen;

      // ZIP64 extra：字段顺序固定为 uncomp, comp, offset（缺哪个补哪个）
      if (uncompSize === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
        const z64 = findExtra(extra, 0x0001);
        if (z64) {
          let q = 0;
          if (uncompSize === 0xffffffff && q + 8 <= z64.length) {
            uncompSize = Number(z64.readBigUInt64LE(q));
            q += 8;
          }
          if (compSize === 0xffffffff && q + 8 <= z64.length) {
            compSize = Number(z64.readBigUInt64LE(q));
            q += 8;
          }
          if (localOffset === 0xffffffff && q + 8 <= z64.length) {
            localOffset = Number(z64.readBigUInt64LE(q));
          }
        }
      }

      // bit 11 = UTF-8 文件名；否则按 CP437，但绝大多数中文包实际是 GBK/UTF-8
      let name;
      if (flags & 0x800) {
        name = nameRaw.toString('utf8');
      } else {
        // 先按 UTF-8 试解；出现替换字符说明不是 UTF-8，退回 latin1 保留原始字节
        const utf8 = nameRaw.toString('utf8');
        name = utf8.includes('\uFFFD') ? nameRaw.toString('latin1') : utf8;
      }

      const isDir = isDirEntry({ name, externalAttrs });

      this.entries.push({
        name,
        rawName: nameRaw,
        isDir,
        method,
        flags,
        encrypted: (flags & 0x1) !== 0,
        crc,
        size: uncompSize,
        compressedSize: compSize,
        localOffset,
        externalAttrs,
        unixMode: unixMode({ externalAttrs }),
        mtime: dosToDate(dosTime, dosDate),
        comment: entryComment.length ? entryComment.toString('utf8') : ''
      });
    }

    this.truncated = !!this.truncated;
  }

  get isEncrypted() {
    return this.entries.some((e) => e.encrypted);
  }

  /** 文件列表（给 UI 用，剔除目录条目后可单独取） */
  list() {
    return this.entries.map((e) => ({
      name: e.name,
      isDir: e.isDir,
      size: e.size,
      compressedSize: e.compressedSize,
      method: e.method,
      encrypted: e.encrypted,
      mtime: e.mtime ? e.mtime.toISOString() : null,
      unixMode: e.unixMode
    }));
  }

  /**
   * 解压单条目到内存（只适合小文件；大文件请用 extractEntryTo）。
   * @param {object} entry
   * @returns {Promise<Buffer>}
   */
  async readEntry(entry) {
    if (entry.encrypted) throw new Error('条目已加密，需要 7-Zip 与密码支持');
    if (entry.isDir) return Buffer.alloc(0);

    const data = await this._readRawData(entry);

    if (entry.method === METHOD_STORE) return data;

    if (entry.method === METHOD_DEFLATE) {
      const out = zlib.inflateRawSync(data);
      if (entry.crc !== 0 && crc32(out) !== entry.crc) {
        throw new Error(`CRC 校验失败：${entry.name}`);
      }
      return out;
    }

    throw new Error(`不支持的压缩方法 ${entry.method}：${entry.name}（请安装 7-Zip 扩展支持）`);
  }

  /**
   * 流式解压到文件，避免大文件占用内存。
   * @param {object} entry
   * @param {string} destPath
   * @param {(n: number) => void} [onProgress] 每写入一块回调（字节数）
   */
  async extractEntryTo(entry, destPath, onProgress) {
    if (entry.encrypted) throw new Error('条目已加密，需要 7-Zip 与密码支持');

    await fsp.mkdir(path.dirname(destPath), { recursive: true });

    if (entry.method === METHOD_STORE) {
      await this._streamRaw(entry, destPath, onProgress);
      return;
    }

    if (entry.method !== METHOD_DEFLATE) {
      throw new Error(`不支持的压缩方法 ${entry.method}（请安装 7-Zip 扩展支持）`);
    }

    // 从本地头之后的偏移开始，用流式 inflate
    const dataStart = await this._dataOffset(entry);
    const src = this.fd.createReadStream({
      start: dataStart,
      end: dataStart + entry.compressedSize - 1,
      autoClose: false,
      highWaterMark: 1 << 16
    });
    const inflate = zlib.createInflateRaw();
    const out = fs.createWriteStream(destPath);
    const hasher = new CrcAccumulator();

    await new Promise((resolve, reject) => {
      let written = 0;
      src.on('error', reject);
      inflate.on('error', reject);
      out.on('error', reject);
      inflate.on('data', (chunk) => {
        hasher.update(chunk);
        written += chunk.length;
        if (onProgress) onProgress(chunk.length);
      });
      out.on('finish', () => {
        if (entry.crc !== 0 && hasher.digest() !== entry.crc) {
          reject(new Error(`CRC 校验失败：${entry.name}`));
          return;
        }
        resolve();
      });
      src.pipe(inflate).pipe(out);
    }).catch(async (err) => {
      await fsp.rm(destPath, { force: true }).catch(() => {});
      throw err;
    });
  }

  /** 读取条目的原始（压缩后）数据 */
  async _readRawData(entry) {
    const start = await this._dataOffset(entry);
    const buf = Buffer.alloc(entry.compressedSize);
    if (entry.compressedSize > 0) {
      await this.fd.read(buf, 0, entry.compressedSize, start);
    }
    return buf;
  }

  /** 原始数据不走内存：直接按区间拷贝（STORE 方法） */
  async _streamRaw(entry, destPath, onProgress) {
    const start = await this._dataOffset(entry);
    const src = this.fd.createReadStream({
      start,
      end: start + entry.compressedSize - 1,
      autoClose: false,
      highWaterMark: 1 << 16
    });
    const out = fs.createWriteStream(destPath);
    const hasher = new CrcAccumulator();
    await new Promise((resolve, reject) => {
      src.on('error', reject);
      out.on('error', reject);
      src.on('data', (chunk) => {
        hasher.update(chunk);
        if (onProgress) onProgress(chunk.length);
      });
      out.on('finish', () => {
        if (entry.crc !== 0 && hasher.digest() !== entry.crc) {
          reject(new Error(`CRC 校验失败：${entry.name}`));
          return;
        }
        resolve();
      });
      src.pipe(out);
    }).catch(async (err) => {
      await fsp.rm(destPath, { force: true }).catch(() => {});
      throw err;
    });
  }

  /**
   * 计算条目的真实数据偏移。
   *
   * 不能直接用 central directory 里记的 localOffset + 固定 30 字节：
   * 本地头里的 name/extra 长度与中央目录里的**可能不同**（很多工具会写
   * 不同的 extra field），必须真读本地头。
   */
  async _dataOffset(entry) {
    const hdr = Buffer.alloc(30);
    await this.fd.read(hdr, 0, 30, entry.localOffset);
    if (hdr.readUInt32LE(0) !== SIG_LOCAL) {
      throw new Error(`本地文件头损坏：${entry.name}`);
    }
    const nameLen = hdr.readUInt16LE(26);
    const extraLen = hdr.readUInt16LE(28);
    return entry.localOffset + 30 + nameLen + extraLen;
  }

  async close() {
    if (this.fd) {
      await this.fd.close().catch(() => {});
      this.fd = null;
    }
  }
}

/** 小工具：把 crc32 包成流式累加器 */
class CrcAccumulator {
  constructor() {
    this.value = 0;
  }
  update(chunk) {
    this.value = crc32(chunk, this.value);
  }
  digest() {
    return this.value >>> 0;
  }
}

/**
 * ZIP 写入器。
 *
 * 采用「先写数据、再写中央目录」的标准流式布局，边写边算 CRC，
 * 内存占用恒定（不缓存已压缩内容）。
 */
export class ZipWriter {
  /**
   * @param {string} filePath
   * @param {{ compress?: boolean, level?: number }} [opts]
   *   compress=false 时全部 STORE（适合已压缩过的媒体文件）
   */
  constructor(filePath, opts = {}) {
    this.filePath = filePath;
    this.compress = opts.compress !== false;
    this.level = Number.isInteger(opts.level) ? opts.level : 6;
    this.fd = null;
    this.offset = 0;
    /** @type {Array<object>} */
    this.records = [];
    this.closed = false;
  }

  async open() {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    this.fd = await fsp.open(this.filePath, 'w');
    this.offset = 0;
    return this;
  }

  /**
   * 添加一个文件。
   * @param {string} srcPath 磁盘上的源文件
   * @param {string} entryName 包内路径（用 / 分隔）
   * @param {{ mtime?: Date, mode?: number }} [meta]
   */
  async addFile(srcPath, entryName, meta = {}) {
    const st = await fsp.stat(srcPath);
    const mtime = meta.mtime || st.mtime || new Date();
    const mode = meta.mode ?? st.mode & 0o7777;
    return this._addFromStream(
      fs.createReadStream(srcPath),
      entryName,
      st.size,
      mtime,
      mode,
      false
    );
  }

  /**
   * 添加内存中的数据。
   * @param {Buffer} buf
   * @param {string} entryName
   * @param {{ mtime?: Date, mode?: number }} [meta]
   */
  async addBuffer(buf, entryName, meta = {}) {
    const { Readable } = await import('node:stream');
    return this._addFromStream(
      Readable.from([buf]),
      entryName,
      buf.length,
      meta.mtime || new Date(),
      meta.mode ?? 0o644,
      false
    );
  }

  /**
   * 添加空目录条目（名字以 / 结尾）。
   * @param {string} entryName
   * @param {{ mtime?: Date, mode?: number }} [meta]
   */
  async addDirectory(entryName, meta = {}) {
    const name = entryName.endsWith('/') ? entryName : entryName + '/';
    const mtime = meta.mtime || new Date();
    const mode = (meta.mode ?? 0o755) | 0o040000; // 带上 S_IFDIR
    return this._addFromStream(null, name, 0, mtime, mode, true);
  }

  /**
   * 核心写入流程：
   * 1. 预留本地头（先写占位，末尾回填 CRC 与大小）
   * 2. 流式压缩写入数据区，同时更新 CRC 与计数
   * 3. 回填本地头
   */
  async _addFromStream(stream, entryName, declaredSize, mtime, mode, isDir) {
    if (this.closed) throw new Error('ZIP 已关闭');
    // ZIP 规范要求 / 分隔；Windows 传入 \ 时统一
    const nameBuf = Buffer.from(entryName.replace(/\\/g, '/'), 'utf8');
    const needZip64 = declaredSize > 0xffffffff;
    const method = isDir || !this.compress ? METHOD_STORE : METHOD_DEFLATE;

    const { dosDate, dosTime } = dateToDos(mtime);

    // --- 本地头占位 ---
    const extraLocal = needZip64 ? this._buildZip64Extra(0, 0, 0, 'local') : Buffer.alloc(0);
    const localHeaderSize = 30 + nameBuf.length + extraLocal.length;
    const localOffset = this.offset;

    await this._write(this._buildLocalHeader({
      flags: 0x800, // 文件名是 UTF-8
      method,
      dosTime,
      dosDate,
      crc: 0,
      compSize: 0,
      uncompSize: 0,
      nameLen: nameBuf.length,
      extraLen: extraLocal.length
    }));
    await this._write(nameBuf);
    if (extraLocal.length) await this._write(extraLocal);

    // --- 数据区 ---
    const dataStart = this.offset;
    let crc = 0;
    let uncompSize = 0;
    let compSize = 0;

    if (isDir || !stream) {
      // 目录条目无数据
    } else if (method === METHOD_STORE) {
      await new Promise((resolve, reject) => {
        stream.on('data', async (chunk) => {
          stream.pause();
          try {
            crc = crc32(chunk, crc);
            uncompSize += chunk.length;
            await this._write(chunk);
            compSize += chunk.length;
            stream.resume();
          } catch (err) {
            reject(err);
          }
        });
        stream.on('end', resolve);
        stream.on('error', reject);
      });
    } else {
      // DEFLATE：用 zlib 流，边压边写
      const deflate = zlib.createDeflateRaw({ level: this.level });
      await new Promise((resolve, reject) => {
        stream.on('error', reject);
        deflate.on('error', reject);
        deflate.on('data', async (chunk) => {
          deflate.pause();
          try {
            await this._write(chunk);
            compSize += chunk.length;
            deflate.resume();
          } catch (err) {
            reject(err);
          }
        });
        deflate.on('end', resolve);
        // 在 source 上算 CRC/原始大小，避免解压后再算一遍
        stream.on('data', (chunk) => {
          crc = crc32(chunk, crc);
          uncompSize += chunk.length;
        });
        stream.pipe(deflate);
      });
    }

    if (!isDir && uncompSize === 0 && declaredSize > 0) {
      throw new Error(`读取源数据失败（期望 ${declaredSize} 字节）：${entryName}`);
    }

    // --- 回填本地头 ---
    const extra = needZip64
      ? this._buildZip64Extra(uncompSize, compSize, localOffset, 'local')
      : Buffer.alloc(0);
    const header = this._buildLocalHeader({
      flags: 0x800,
      method,
      dosTime,
      dosDate,
      crc,
      compSize: needZip64 ? 0xffffffff : compSize,
      uncompSize: needZip64 ? 0xffffffff : uncompSize,
      nameLen: nameBuf.length,
      extraLen: extra.length
    });
    // 本地头长度必须与占位时一致（ZIP64 extra 在 local 里是固定长度）
    if (header.length + nameBuf.length + extra.length !== localHeaderSize) {
      // 长度变化只可能出现在 ZIP64 从无到有；本实现一开始就按 needZip64 预留，不会发生
      throw new Error(`内部错误：本地头长度不一致（${entryName}）`);
    }
    const pos = await this.fd.write(header, 0, header.length, localOffset);
    if (pos.bytesWritten !== header.length) throw new Error('回填本地头失败');
    if (extra.length) {
      await this.fd.write(extra, 0, extra.length, localOffset + 30 + nameBuf.length);
    }

    this.records.push({
      nameBuf,
      name: entryName,
      flags: 0x800,
      method,
      dosTime,
      dosDate,
      crc,
      compSize,
      uncompSize,
      localOffset,
      externalAttrs: ((mode & 0xffff) << 16) | (isDir ? 0x10 : 0),
      isDir,
      needZip64
    });

    return { name: entryName, size: uncompSize, compressedSize: compSize, crc };
  }

  _buildLocalHeader(f) {
    const b = Buffer.alloc(30);
    b.writeUInt32LE(SIG_LOCAL, 0);
    b.writeUInt16LE(20, 4); // version needed
    b.writeUInt16LE(f.flags, 6);
    b.writeUInt16LE(f.method, 8);
    b.writeUInt16LE(f.dosTime, 10);
    b.writeUInt16LE(f.dosDate, 12);
    b.writeUInt32LE(f.crc >>> 0, 14);
    b.writeUInt32LE(f.compSize, 18);
    b.writeUInt32LE(f.uncompSize, 22);
    b.writeUInt16LE(f.nameLen, 26);
    b.writeUInt16LE(f.extraLen, 28);
    return b;
  }

  /**
   * ZIP64 扩展字段。
   * 规范要求 local 与 central 里的 ZIP64 extra **大小可以不同**：
   * local 必须是 16 字节（uncomp+comp），central 是 24 字节（+offset）。
   * 这里统一按 24 字节写，两处都能被解析器接受（多余字段被忽略）。
   */
  _buildZip64Extra(uncompSize, compSize, localOffset, where) {
    const b = Buffer.alloc(4 + 24);
    b.writeUInt16LE(0x0001, 0); // tag
    b.writeUInt16LE(24, 2); // size
    b.writeBigUInt64LE(BigInt(uncompSize), 4);
    b.writeBigUInt64LE(BigInt(compSize), 12);
    b.writeBigUInt64LE(BigInt(localOffset), 20);
    return b;
  }

  /** 顺序写入并维护 offset */
  async _write(buf) {
    let done = 0;
    while (done < buf.length) {
      const { bytesWritten } = await this.fd.write(buf, done, buf.length - done, this.offset + done);
      if (bytesWritten <= 0) throw new Error('写入压缩包失败');
      done += bytesWritten;
    }
    this.offset += buf.length;
  }

  /**
   * 写中央目录并收尾。
   * @returns {Promise<{entries: number, size: number}>}
   */
  async close() {
    if (this.closed) return { entries: this.records.length, size: this.offset };
    this.closed = true;

    const centralStart = this.offset;
    for (const r of this.records) {
      const extra = r.needZip64
        ? this._buildZip64Extra(r.uncompSize, r.compSize, r.localOffset, 'central')
        : Buffer.alloc(0);
      const b = Buffer.alloc(46 + r.nameBuf.length + extra.length);
      b.writeUInt32LE(SIG_CENTRAL, 0);
      b.writeUInt16LE(0x031e, 4); // version made by: UNIX(3) + 3.0
      b.writeUInt16LE(20, 6); // version needed
      b.writeUInt16LE(r.flags, 8);
      b.writeUInt16LE(r.method, 10);
      b.writeUInt16LE(r.dosTime, 12);
      b.writeUInt16LE(r.dosDate, 14);
      b.writeUInt32LE(r.crc >>> 0, 16);
      b.writeUInt32LE(r.needZip64 ? 0xffffffff : r.compSize, 20);
      b.writeUInt32LE(r.needZip64 ? 0xffffffff : r.uncompSize, 24);
      b.writeUInt16LE(r.nameBuf.length, 28);
      b.writeUInt16LE(extra.length, 30);
      b.writeUInt16LE(0, 32); // comment len
      b.writeUInt16LE(0, 34); // disk start
      b.writeUInt16LE(0, 36); // internal attrs
      b.writeUInt32LE(r.externalAttrs >>> 0, 38);
      b.writeUInt32LE(r.needZip64 ? 0xffffffff : r.localOffset, 42);
      r.nameBuf.copy(b, 46);
      if (extra.length) extra.copy(b, 46 + r.nameBuf.length);
      await this._write(b);
    }

    const centralSize = this.offset - centralStart;
    const needZip64 = this.records.length > 0xfffe || centralSize > 0xffffffff || centralStart > 0xffffffff;

    if (needZip64) {
      // EOCD64
      const e64 = Buffer.alloc(56);
      e64.writeUInt32LE(SIG_EOCD64, 0);
      e64.writeBigUInt64LE(44n, 4); // size of remaining record
      e64.writeUInt16LE(0x031e, 12);
      e64.writeUInt16LE(45, 14);
      e64.writeUInt32LE(0, 16); // this disk
      e64.writeUInt32LE(0, 20); // disk with central
      e64.writeBigUInt64LE(BigInt(this.records.length), 24);
      e64.writeBigUInt64LE(BigInt(this.records.length), 32);
      e64.writeBigUInt64LE(BigInt(centralSize), 40);
      e64.writeBigUInt64LE(BigInt(centralStart), 48);
      const e64Offset = this.offset;
      await this._write(e64);

      // EOCD64 locator
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(SIG_EOCD64_LOCATOR, 0);
      loc.writeUInt32LE(0, 4);
      loc.writeBigUInt64LE(BigInt(e64Offset), 8);
      loc.writeUInt32LE(1, 16);
      await this._write(loc);
    }

    // EOCD
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(needZip64 ? 0xffff : this.records.length, 8);
    eocd.writeUInt16LE(needZip64 ? 0xffff : this.records.length, 10);
    eocd.writeUInt32LE(needZip64 ? 0xffffffff : centralSize, 12);
    eocd.writeUInt32LE(needZip64 ? 0xffffffff : centralStart, 16);
    eocd.writeUInt16LE(0, 20);
    await this._write(eocd);

    await this.fd.sync().catch(() => {});
    await this.fd.close();
    this.fd = null;

    return { entries: this.records.length, size: this.offset };
  }

  /** 出错时清理半成品文件 */
  async abort() {
    this.closed = true;
    if (this.fd) {
      await this.fd.close().catch(() => {});
      this.fd = null;
    }
    await fsp.rm(this.filePath, { force: true }).catch(() => {});
  }
}

/** 供 format-registry 使用的格式描述 */
export const zipFormat = {
  id: 'zip',
  name: 'ZIP',
  extensions: ['zip', 'zipx', 'jar', 'apk', 'docx', 'xlsx', 'pptx', 'epub', 'odt', 'ods', 'odp', 'xpi', 'vsix', 'ipa'],
  // ZIP 签名在文件尾（EOCD），这里用本地头签名做初步识别
  signature: { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
  canExtract: true,
  canCreate: true,
  description: 'ZIP 归档，支持 STORE/DEFLATE、ZIP64、Unix 权限与目录'
};
