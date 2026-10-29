/**
 * TAR 引擎 —— 读取与写入
 *
 * TAR 没有压缩，只是"把文件首尾相接并加 512 字节头"的格式。它的历史包袱很多：
 * - **ustar**：POSIX 标准，name 100 字节、prefix 155 字节（拼起来 256）
 * - **GNU**：name 100 字节不够时，用 `././@LongLink` 伪条目存完整路径
 * - **PAX**：用 key=value 扩展头存任意长度路径与高精度时间
 * - 大小字段是**八进制 ASCII**，且尾部用空格或 NUL 补齐
 * - base-256 编码：超大文件（>8GB）用二进制大端表示，首字节高位为 1
 *
 * 本实现三种都支持（读取），写入固定用 ustar + GNU LongLink 兜底，
 * 这样解压方无论是 GNU tar、bsdtar 还是 7-Zip 都能读懂。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const BLOCK = 512;

/** 条目类型 */
const TYPE = {
  file: '0',
  hardlink: '1',
  symlink: '2',
  charDevice: '3',
  blockDevice: '4',
  directory: '5',
  fifo: '6',
  contiguous: '7', // 与 file 相同，只是要求物理连续
  paxGlobal: 'g',
  paxExtended: 'x',
  gnuLongName: 'L',
  gnuLongLink: 'K'
};

/** 读 NUL/空格结尾的字符串 */
function readString(buf, off, len) {
  const slice = buf.subarray(off, off + len);
  let end = slice.length;
  for (let i = 0; i < slice.length; i++) {
    if (slice[i] === 0) {
      end = i;
      break;
    }
  }
  return slice.subarray(0, end).toString('utf8');
}

/**
 * 解析数字字段。
 * 普通情况是八进制；若首字节 & 0x80 则为 base-256（GNU 用于超大值）。
 */
function readNumber(buf, off, len) {
  if (len === 0) return 0;
  const first = buf[off];
  if (first & 0x80) {
    // base-256：首字节去掉标志位，其余按大端累加
    let val = first & 0x7f;
    for (let i = 1; i < len; i++) val = val * 256 + buf[off + i];
    return val;
  }
  const s = readString(buf, off, len).trim();
  if (!s) return 0;
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

/** 写八进制数字字段 */
function writeNumber(buf, off, len, value) {
  // len-1 位八进制 + NUL（len 含结尾 NUL）
  const s = value.toString(8).padStart(len - 1, '0').slice(-(len - 1));
  buf.write(s, off, len - 1, 'ascii');
  buf[off + len - 1] = 0;
}

/** 计算 TAR 头的校验和（把 checksum 字段当成 8 个空格） */
function checksum(header) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  return sum;
}

/** 解析 PAX 扩展头（`LEN key=value\n` 重复） */
function parsePax(buf) {
  const out = {};
  let p = 0;
  while (p < buf.length) {
    const sp = buf.indexOf(0x20, p); // 找长度后的空格
    if (sp < 0) break;
    const len = parseInt(buf.subarray(p, sp).toString('ascii'), 10);
    if (!Number.isFinite(len) || len <= 0 || p + len > buf.length) break;
    const record = buf.subarray(sp + 1, p + len - 1).toString('utf8'); // 去掉结尾 \n
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    p += len;
  }
  return out;
}

export class TarReader {
  constructor(filePath) {
    this.filePath = filePath;
    this.fd = null;
    this.entries = [];
    this.truncated = false;
  }

  /**
   * @param {string} filePath
   * @param {{ offset?: number }} [opts] offset 用于「tar.gz 解压后的临时 tar」
   */
  static async open(filePath, opts = {}) {
    const r = new TarReader(filePath);
    await r._open(opts.offset || 0);
    return r;
  }

  async _open(startOffset) {
    this.fd = await fsp.open(this.filePath, 'r');
    const st = await this.fd.stat();
    this.size = st.size;
    await this._scan(startOffset);
  }

  /** 顺序扫描所有头 */
  async _scan(startOffset) {
    let pos = startOffset;
    const buf = Buffer.alloc(BLOCK);
    let pax = {};
    let longName = null;
    let longLink = null;
    let globalPax = {};

    while (pos + BLOCK <= this.size) {
      const { bytesRead } = await this.fd.read(buf, 0, BLOCK, pos);
      if (bytesRead < BLOCK) break;

      // 全零块 = 归档结束（最多连续两个）
      if (buf.every((b) => b === 0)) break;

      // 校验和验证：合法头部必须能被正确解析
      const storedSum = readNumber(buf, 148, 8);
      const calcSum = checksum(buf);
      if (storedSum !== calcSum) {
        // 有些生成器用有符号累加，允许差异
        if (storedSum !== signedChecksum(buf)) {
          this.truncated = true;
          break; // 头部损坏，停止解析（已解析的仍可用）
        }
      }

      const type = String.fromCharCode(buf[156] || 0x30);
      const size = readNumber(buf, 124, 12);
      const mode = readNumber(buf, 100, 8);
      const mtime = readNumber(buf, 136, 12);
      const dataStart = pos + BLOCK;
      // 数据区按 512 对齐
      const padded = Math.ceil(size / BLOCK) * BLOCK;

      if (type === TYPE.gnuLongName) {
        // GNU LongLink 的数据体是**字符串**（可能不以 NUL 结尾，但多数会带一个）
        longName = (await this._readData(dataStart, size)).toString('utf8').replace(/\0+$/, '');
        pos = dataStart + padded;
        continue;
      }
      if (type === TYPE.gnuLongLink) {
        longLink = (await this._readData(dataStart, size)).toString('utf8').replace(/\0+$/, '');
        pos = dataStart + padded;
        continue;
      }
      if (type === TYPE.paxExtended) {
        const raw = await this._readData(dataStart, size);
        pax = parsePax(raw);
        pos = dataStart + padded;
        continue;
      }
      if (type === TYPE.paxGlobal) {
        const raw = await this._readData(dataStart, size);
        globalPax = { ...globalPax, ...parsePax(raw) };
        pos = dataStart + padded;
        continue;
      }

      // 普通条目
      let name = readString(buf, 0, 100);
      const prefix = readString(buf, 345, 155);
      const magic = readString(buf, 257, 6);
      if (magic.startsWith('ustar') && prefix) {
        name = `${prefix}/${name}`;
      }
      // GNU LongLink 优先于 ustar name
      if (longName) {
        name = longName;
        longName = null;
      }
      const linkName = longLink || readString(buf, 157, 100);
      longLink = null;

      // PAX 覆盖（最后应用，优先级最高）
      const effName = pax.path || globalPax.path || name;
      const effSize = pax.size !== undefined ? parseInt(pax.size, 10) : size;
      const effMtime = pax.mtime !== undefined ? parseFloat(pax.mtime) : mtime;

      const isDir = type === TYPE.directory || effName.endsWith('/');
      const isSymlink = type === TYPE.symlink;
      const isHardlink = type === TYPE.hardlink;

      this.entries.push({
        name: effName,
        isDir,
        isSymlink,
        isHardlink,
        linkName: isSymlink || isHardlink ? linkName : null,
        size: isDir ? 0 : effSize,
        mode: mode & 0o7777,
        mtime: effMtime ? new Date(effMtime * 1000) : null,
        type,
        dataOffset: dataStart
      });

      // 重新计算 padded（PAX 覆盖了 size）
      const realPadded = Math.ceil(effSize / BLOCK) * BLOCK;
      pos = dataStart + realPadded;
      pax = {};
    }
  }

  async _readData(offset, size) {
    const buf = Buffer.alloc(size);
    if (size > 0) await this.fd.read(buf, 0, size, offset);
    return buf;
  }

  list() {
    return this.entries.map((e) => ({
      name: e.name,
      isDir: e.isDir,
      isSymlink: e.isSymlink,
      isHardlink: e.isHardlink,
      linkName: e.linkName,
      size: e.size,
      mtime: e.mtime ? e.mtime.toISOString() : null,
      mode: e.mode
    }));
  }

  /**
   * 流式解压到文件。
   * @param {object} entry
   * @param {string} destPath
   * @param {(n: number) => void} [onProgress]
   */
  async extractEntryTo(entry, destPath, onProgress) {
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    if (entry.size === 0) {
      await fsp.writeFile(destPath, Buffer.alloc(0));
      return;
    }
    const src = this.fd.createReadStream({
      start: entry.dataOffset,
      end: entry.dataOffset + entry.size - 1,
      autoClose: false,
      highWaterMark: 1 << 16
    });
    const out = fs.createWriteStream(destPath);
    await new Promise((resolve, reject) => {
      src.on('error', reject);
      out.on('error', reject);
      if (onProgress) src.on('data', (c) => onProgress(c.length));
      out.on('finish', resolve);
      src.pipe(out);
    });
  }

  /** 读入内存（仅用于小文件/文本预览） */
  async readEntry(entry) {
    return this._readData(entry.dataOffset, entry.size);
  }

  async close() {
    if (this.fd) {
      await this.fd.close().catch(() => {});
      this.fd = null;
    }
  }
}

/** 有符号字节累加（部分老 tar 生成器这么算） */
function signedChecksum(header) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    if (i >= 148 && i < 156) {
      sum += 0x20;
    } else {
      const b = header[i];
      sum += b < 128 ? b : b - 256;
    }
  }
  return sum;
}

/** 构造一个 TAR 头块 */
function buildHeader({ name, size, mode, mtime, type, linkName }) {
  const buf = Buffer.alloc(BLOCK);
  const nameBuf = Buffer.from(name, 'utf8');

  // ustar 允许 prefix(155) + name(100)；这里简单起见只写 name，
  // 超长路径由 _writeLongName 用 GNU LongLink 兜底
  nameBuf.copy(buf, 0, 0, Math.min(nameBuf.length, 100));

  writeNumber(buf, 100, 8, mode & 0o7777);
  writeNumber(buf, 108, 8, 0); // uid
  writeNumber(buf, 116, 8, 0); // gid
  writeNumber(buf, 124, 12, size);
  writeNumber(buf, 136, 12, Math.floor((mtime || new Date()).getTime() / 1000));
  buf[156] = type.charCodeAt(0);
  if (linkName) {
    Buffer.from(linkName, 'utf8').copy(buf, 157, 0, 100);
  }
  buf.write('ustar', 257, 5, 'ascii');
  buf[262] = 0x30; // version "00"
  buf[263] = 0x30;

  // 校验和先填空格，算完后写入
  buf.fill(0x20, 148, 156);
  const sum = checksum(buf);
  // 规范写法：6 位八进制 + NUL + 空格
  const s = sum.toString(8).padStart(6, '0').slice(-6);
  buf.write(s, 148, 6, 'ascii');
  buf[154] = 0;
  buf[155] = 0x20;
  return buf;
}

/** GNU LongLink 伪条目 */
function buildLongEntry(type, value) {
  const data = Buffer.from(value, 'utf8');
  const header = buildHeader({
    name: '././@LongLink',
    size: data.length,
    mode: 0o644,
    mtime: new Date(),
    type
  });
  return Buffer.concat([header, data, Buffer.alloc(padTo512(data.length))]);
}

function padTo512(n) {
  const rem = n % BLOCK;
  return rem === 0 ? 0 : BLOCK - rem;
}

/**
 * TAR 写入器。
 */
export class TarWriter {
  /**
   * @param {string} filePath
   * @param {{ maxNameBytes?: number }} [opts]
   */
  constructor(filePath, opts = {}) {
    this.filePath = filePath;
    this.maxNameBytes = opts.maxNameBytes ?? 100;
    this.fd = null;
    this.offset = 0;
    this.closed = false;
    this.entries = 0;
  }

  async open() {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    this.fd = await fsp.open(this.filePath, 'w');
    this.offset = 0;
    return this;
  }

  async _write(buf) {
    let done = 0;
    while (done < buf.length) {
      const { bytesWritten } = await this.fd.write(buf, done, buf.length - done, this.offset + done);
      if (bytesWritten <= 0) throw new Error('写入 TAR 失败');
      done += bytesWritten;
    }
    this.offset += buf.length;
  }

  /** 名字超过 100 字节时补一个 GNU LongLink */
  async _maybeLongName(name, type) {
    if (Buffer.byteLength(name, 'utf8') > this.maxNameBytes) {
      await this._write(buildLongEntry(type, name));
    }
  }

  /**
   * 添加文件。
   * @param {string} srcPath
   * @param {string} entryName
   * @param {{ mtime?: Date, mode?: number }} [meta]
   */
  async addFile(srcPath, entryName, meta = {}) {
    const st = await fsp.stat(srcPath);
    const name = entryName.replace(/\\/g, '/');
    await this._maybeLongName(name, TYPE.gnuLongName);

    const header = buildHeader({
      name,
      size: st.size,
      mode: meta.mode ?? st.mode & 0o7777,
      mtime: meta.mtime || st.mtime,
      type: TYPE.file
    });
    await this._write(header);

    const src = fs.createReadStream(srcPath, { highWaterMark: 1 << 16 });
    await new Promise((resolve, reject) => {
      src.on('error', reject);
      src.on('data', async (chunk) => {
        src.pause();
        try {
          await this._write(chunk);
          src.resume();
        } catch (err) {
          reject(err);
        }
      });
      src.on('end', resolve);
    });

    const pad = padTo512(st.size);
    if (pad) await this._write(Buffer.alloc(pad));
    this.entries++;
    return { name, size: st.size };
  }

  /**
   * 添加内存数据。
   * @param {Buffer} buf
   * @param {string} entryName
   * @param {{ mtime?: Date, mode?: number }} [meta]
   */
  async addBuffer(buf, entryName, meta = {}) {
    const name = entryName.replace(/\\/g, '/');
    await this._maybeLongName(name, TYPE.gnuLongName);
    const header = buildHeader({
      name,
      size: buf.length,
      mode: meta.mode ?? 0o644,
      mtime: meta.mtime || new Date(),
      type: TYPE.file
    });
    await this._write(header);
    await this._write(buf);
    const pad = padTo512(buf.length);
    if (pad) await this._write(Buffer.alloc(pad));
    this.entries++;
    return { name, size: buf.length };
  }

  /**
   * 添加目录。
   * @param {string} entryName
   * @param {{ mtime?: Date, mode?: number }} [meta]
   */
  async addDirectory(entryName, meta = {}) {
    const name = entryName.endsWith('/') ? entryName : entryName + '/';
    await this._maybeLongName(name, TYPE.gnuLongName);
    const header = buildHeader({
      name,
      size: 0,
      mode: meta.mode ?? 0o755,
      mtime: meta.mtime || new Date(),
      type: TYPE.directory
    });
    await this._write(header);
    this.entries++;
    return { name, size: 0 };
  }

  /**
   * 写符号链接（保留而不是跟随，重要：跟随会复制目标内容，可能泄露文件）。
   */
  async addSymlink(entryName, target, meta = {}) {
    const name = entryName.replace(/\\/g, '/');
    await this._maybeLongName(name, TYPE.gnuLongName);
    if (Buffer.byteLength(target, 'utf8') > 100) {
      await this._write(buildLongEntry(TYPE.gnuLongLink, target));
    }
    const header = buildHeader({
      name,
      size: 0,
      mode: meta.mode ?? 0o777,
      mtime: meta.mtime || new Date(),
      type: TYPE.symlink,
      linkName: target
    });
    await this._write(header);
    this.entries++;
    return { name, size: 0 };
  }

  /** 写两个全零块收尾 */
  async close() {
    if (this.closed) return { entries: this.entries, size: this.offset };
    this.closed = true;
    await this._write(Buffer.alloc(BLOCK * 2));
    // 归档大小补齐到 10240 字节的整数倍（传统 tar 记录长度），兼容性最好
    const rem = this.offset % 10240;
    if (rem) await this._write(Buffer.alloc(10240 - rem));
    await this.fd.sync().catch(() => {});
    await this.fd.close();
    this.fd = null;
    return { entries: this.entries, size: this.offset };
  }

  async abort() {
    this.closed = true;
    if (this.fd) {
      await this.fd.close().catch(() => {});
      this.fd = null;
    }
    await fsp.rm(this.filePath, { force: true }).catch(() => {});
  }
}

/** 供注册表使用 */
export const tarFormat = {
  id: 'tar',
  name: 'TAR',
  extensions: ['tar'],
  // TAR 的签名在 offset 257 处的 "ustar"
  signature: { offset: 257, bytes: [0x75, 0x73, 0x74, 0x61, 0x72] },
  canExtract: true,
  canCreate: true,
  description: 'POSIX TAR 归档（ustar / GNU LongLink / PAX）'
};
