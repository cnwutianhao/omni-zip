/**
 * 归档任务引擎
 *
 * 与 omni-down 的 HttpEngine 同构：EventEmitter + 任务表 + 500ms tick 广播 +
 * 原子持久化 + `_run` 轮次代号防竞态。差别在于任务类型不是"下载"而是
 * "解压 / 压缩"，且真正干活的分派逻辑要跨三种后端：
 *
 *   1. 内置流式后端（zip / tar / tar.gz）：逐条写盘、可精确报进度、可中断
 *   2. 单一流后端（gz 解出的单文件）：一次 pipeline
 *   3. 外部进程后端（7z / rar / bz2 / xz）：只能拿到粗糙百分比，暂停 = kill 进程
 *
 * 关键取舍：**任务不可"暂停续传"**（解压不像下载有天然断点），
 * 所以 pause 的语义是"中止并保留已完成的部分"，resume 是"从头重跑"。
 * 这一点必须在 UI 文案上说清，否则用户会以为能接着解。
 */
import EventEmitter from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

import { ZipReader, ZipWriter, AbortError } from './zip-engine.js';
import { TarReader, TarWriter } from './tar-engine.js';
import { gunzipTo, gzipFrom, gzipInfo } from './stream-engine.js';
import { sanitizeEntryName, safeJoin, uniqueName, defaultExtractDir } from '../lib/paths.js';
import { detectFormat, findByExtension, findBySignature } from '../lib/format-registry.js';
import {
  detectTools,
  pickTool,
  extractWithTool,
  createWithSevenZip,
  listWithSevenZip,
  listWithBsdtar
} from '../lib/external-tool.js';

const TICK_MS = 500;
const SAVE_DEBOUNCE = 800;
/** 同时运行的任务数（解压是 IO 密集，3 个足够打满普通磁盘） */
const MAX_ACTIVE = 3;

/**
 * 状态文件临时名的自增序号（进程内）。
 * 配合 process.pid 保证「每写一次都是不同的 tmp 文件」，
 * 从而让 rename 的原子性真正成立（详见 _saveState 里的说明）。
 */
let SAVE_SEQ = 0;

/** 读文件头用于签名探测 */
async function readHead(filePath, size = 1024) {
  let fh = null;
  try {
    fh = await fsp.open(filePath, 'r');
    const buf = Buffer.alloc(size);
    const { bytesRead } = await fh.read(buf, 0, size, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/** 从 GZIP 流只解压前 maxBytes 字节，用于嗅探内层是否为 TAR */
function peekGunzipHead(filePath, maxBytes = 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const src = fs.createReadStream(filePath, { highWaterMark: 4096 });
    const gunzip = zlib.createGunzip();
    const finish = () => {
      if (settled) return;
      settled = true;
      src.destroy();
      gunzip.destroy();
      resolve(Buffer.concat(chunks).subarray(0, maxBytes));
    };
    gunzip.on('data', (c) => {
      chunks.push(c);
      total += c.length;
      if (total >= maxBytes) finish();
    });
    gunzip.on('end', finish);
    gunzip.on('error', finish);
    src.on('error', finish);
    src.pipe(gunzip);
  });
}

/** 递归收集目录下的所有条目（用于压缩，携带文件大小避免二次 stat） */
async function walkDir(rootDir, followSymlinks = false) {
  const out = [];
  async function walk(absDir, relDir) {
    const items = await fsp.readdir(absDir, { withFileTypes: true });
    // 排序保证输出稳定（同一目录下先文件后目录、名字升序）
    items.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    for (const item of items) {
      const abs = path.join(absDir, item.name);
      const rel = relDir ? `${relDir}/${item.name}` : item.name;
      if (item.isSymbolicLink()) {
        // 符号链接：默认记录链接本身，不跟随（跟随会复制目标内容，可能意外打包大量文件）
        const target = await fsp.readlink(abs).catch(() => null);
        if (target !== null) out.push({ type: 'symlink', abs, rel, target });
        if (followSymlinks) {
          const st = await fsp.stat(abs).catch(() => null);
          if (st?.isDirectory()) await walk(abs, rel);
        }
      } else if (item.isDirectory()) {
        out.push({ type: 'dir', abs, rel });
        await walk(abs, rel);
      } else if (item.isFile()) {
        const st = await fsp.stat(abs).catch(() => null);
        if (st) out.push({ type: 'file', abs, rel, size: st.size, mtime: st.mtime, mode: st.mode });
      }
      // 其它类型（socket / fifo / 设备）跳过
    }
  }
  await walk(rootDir, '');
  return out;
}

/** 收集一组源路径的所有条目与总字节数 */
async function collectSources(sourcePaths) {
  const collected = [];
  let totalBytes = 0;
  let totalFiles = 0;
  for (const src of sourcePaths) {
    const st = await fsp.lstat(src);
    if (st.isSymbolicLink()) {
      const target = await fsp.readlink(src);
      collected.push({ type: 'symlink', abs: src, rel: path.basename(src), target });
    } else if (st.isDirectory()) {
      const base = path.basename(src);
      collected.push({ type: 'dir', abs: src, rel: base });
      const children = await walkDir(src);
      for (const c of children) {
        collected.push({ ...c, rel: `${base}/${c.rel}` });
        if (c.type === 'file') {
          totalBytes += c.size || 0;
          totalFiles++;
        }
      }
    } else if (st.isFile()) {
      collected.push({
        type: 'file',
        abs: src,
        rel: path.basename(src),
        size: st.size,
        mtime: st.mtime,
        mode: st.mode
      });
      totalBytes += st.size;
      totalFiles++;
    }
  }
  return { collected, totalBytes, totalFiles };
}

export class ArchiveEngine extends EventEmitter {
  constructor({ downloadDir, stateFile, userDataDir }) {
    super();
    this.workDir = downloadDir;
    this.stateFile = stateFile;
    this.userDataDir = userDataDir || path.dirname(stateFile);
    /** id -> task */
    this.tasks = new Map();
    this.started = false;
    this.timer = null;
    this.tools = detectTools();
    this._saveTimer = null;
    this._dirty = false;
    /**
     * 保存队列的队尾 promise。
     * 连续的 _saveState() 会串成一条链，保证「同一时刻只有一个 writeFile 在跑」
     * 且「后来者一定在前一个完成之后才写」（否则 stop() 的落盘保证会失效）。
     */
    this._saveChain = Promise.resolve();
    /** 运行中的外部进程句柄：taskId -> { cancel } */
    this._running = new Map();
  }

  // ------------------------------------------------------------- 生命周期

  async start() {
    if (this.started) return;
    this.started = true;
    fs.mkdirSync(this.workDir, { recursive: true });

    const saved = await this._loadState();
    this.tasks.clear();
    for (const s of saved) {
      const task = {
        ...s,
        // 上次退出时未完成的任务：状态归为 paused（解压无法续传，需重跑）
        status: s.status === 'running' ? 'paused' : s.status,
        speed: 0,
        _run: 0,
        _pauseRequested: false,
        _removeRequested: false,
        _started: false
      };
      this.tasks.set(task.id, task);
    }
    this.timer = setInterval(() => this._tick(), TICK_MS);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const task of this.tasks.values()) {
      task._pauseRequested = true;
      task._started = false;
      this._cancelRunning(task.id);
    }
    await this._saveState();
    this.started = false;
  }

  /** 重新探测外部工具（用户可能刚装了 7-Zip） */
  refreshTools() {
    this.tools = detectTools();
    this._broadcast();
    return this.tools;
  }

  // ------------------------------------------------------------- 公开操作

  /**
   * 添加解压任务。
   * @param {string} archivePath
   * @param {{ destDir?: string }} [opts]
   * @returns {Promise<string>} 任务 id
   */
  async addExtract(archivePath, opts = {}) {
    const abs = path.resolve(String(archivePath));
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || !st.isFile()) throw new Error(`文件不存在：${abs}`);

    const head = await readHead(abs);
    const format = detectFormat(abs, head);

    const dest = opts.destDir
      ? path.resolve(opts.destDir)
      : defaultExtractDir(abs, path.dirname(abs));

    const id = crypto.randomUUID();
    const isTarGz = format?.id === 'gzip' && /\.(tar\.gz|tgz)$/i.test(abs);
    const task = {
      id,
      kind: 'extract',
      archivePath: abs,
      archiveName: path.basename(abs),
      archiveSize: st.size,
      destDir: dest,
      formatId: format?.id || 'unknown',
      formatName: isTarGz ? 'TAR.GZ' : format?.name || '未知格式',
      backend: this._pickBackendForExtract(format),
      status: 'queued', // queued | running | paused | done | error
      progress: 0,
      speed: 0,
      itemsDone: 0,
      itemsTotal: 0,
      bytesDone: 0,
      bytesTotal: st.size,
      error: null,
      warnings: [],
      createdAt: Date.now(),
      startedAt: 0,
      finishedAt: 0,
      _run: 0,
      _pauseRequested: false,
      _removeRequested: false,
      _started: false,
      _bytesThisTick: 0
    };
    // 不支持的格式在添加时就报错，而不是等任务跑起来才失败
    if (!format) {
      task.status = 'error';
      task.error = '无法识别的归档格式（可通过「设置 → 外部工具」安装 7-Zip 扩展支持）';
    } else if (!this._canHandle(format)) {
      task.status = 'error';
      task.error = `${format.name} 需要外部 7-Zip 支持，当前未检测到可用工具`;
    }

    this.tasks.set(id, task);
    this._broadcast();
    this._saveStateSoon(true);
    if (task.status !== 'error') this._schedule(id);
    return id;
  }

  /**
   * 添加压缩任务。
   * @param {string[]} sourcePaths 要压缩的文件/目录（绝对路径）
   * @param {{ archivePath: string, formatId?: string, level?: number, password?: string }} opts
   * @returns {Promise<string>}
   */
  async addCreate(sourcePaths, opts) {
    const items = (sourcePaths || []).map((p) => path.resolve(String(p)));
    if (!items.length) throw new Error('请先选择要压缩的文件');

    for (const p of items) {
      const st = await fsp.lstat(p).catch(() => null);
      if (!st) throw new Error(`路径不存在：${p}`);
    }

    const archivePath = path.resolve(String(opts.archivePath || ''));
    if (!archivePath) throw new Error('请指定输出压缩包路径');

    const format = opts.formatId
      ? this._formatById(opts.formatId)
      : findByExtension(archivePath);
    if (!format) throw new Error('无法确定输出格式（请给出 .zip / .tar / .tar.gz 等扩展名）');
    if (!format.canCreate) throw new Error(`${format.name} 不支持创建`);

    // 父目录不存在就建出来（用户可能手打了深层路径）
    await fsp.mkdir(path.dirname(archivePath), { recursive: true });

    const id = crypto.randomUUID();
    const { totalBytes, totalFiles } = await collectSources(items);
    const isTarGz = format.id === 'gzip' && /\.(tar\.gz|tgz)$/i.test(archivePath);
    const task = {
      id,
      kind: 'create',
      archivePath,
      archiveName: path.basename(archivePath),
      archiveSize: 0,
      sourcePaths: items,
      destDir: path.dirname(archivePath),
      formatId: format.id,
      formatName: isTarGz ? 'TAR.GZ' : format.name,
      backend: ['zip', 'tar', 'gzip'].includes(format.id) ? 'builtin' : 'external',
      level: Number.isInteger(opts.level) ? opts.level : 6,
      hasPassword: !!opts.password,
      _password: opts.password || null,
      status: 'queued',
      progress: 0,
      speed: 0,
      itemsDone: 0,
      itemsTotal: totalFiles,
      bytesDone: 0,
      bytesTotal: totalBytes,
      error: null,
      warnings: [],
      createdAt: Date.now(),
      startedAt: 0,
      finishedAt: 0,
      _run: 0,
      _pauseRequested: false,
      _removeRequested: false,
      _started: false,
      _bytesThisTick: 0
    };

    this.tasks.set(id, task);
    this._broadcast();
    this._saveStateSoon(true);
    this._schedule(id);
    return id;
  }

  /**
   * 修改解压任务的目标目录（仅非 running 状态可改）。
   * 供主进程 IPC 调用，避免外部直接操作内部字段与私有方法。
   */
  setTaskDest(id, dir) {
    const task = this.tasks.get(String(id));
    if (!task) return { ok: false, error: '任务不存在' };
    if (task.status === 'running') return { ok: false, error: '任务运行中，无法修改目录' };
    const next = String(dir || '').trim();
    if (!next) return { ok: false, error: '目录为空' };
    task.destDir = path.resolve(next);
    this._broadcast();
    this._saveStateSoon(true);
    return { ok: true, dir: task.destDir };
  }

  pause(id) {
    const task = this.tasks.get(String(id));
    if (!task) return false;
    if (!['queued', 'running'].includes(task.status)) return false;
    task._pauseRequested = true;
    task._started = false; // 立即释放并发名额
    task._run = (task._run || 0) + 1; // 作废当前轮次
    this._cancelRunning(task.id);
    task.status = 'paused';
    task.speed = 0;
    this._broadcast();
    this._saveStateSoon(true);
    this._promoteQueue();
    return true;
  }

  resume(id) {
    const task = this.tasks.get(String(id));
    if (!task) return false;
    if (!['paused', 'error'].includes(task.status)) return false;
    task._pauseRequested = false;
    task._removeRequested = false;
    task.error = null;
    task.progress = 0;
    task.bytesDone = 0;
    task.itemsDone = 0;
    task.status = 'queued';
    this._broadcast();
    this._schedule(id);
    return true;
  }

  async remove(id, deleteOutput = false) {
    const task = this.tasks.get(String(id));
    if (!task) return false;
    task._removeRequested = true;
    task._pauseRequested = true;
    task._run = (task._run || 0) + 1;
    this._cancelRunning(task.id);
    this.tasks.delete(String(id));

    if (deleteOutput) {
      if (task.kind === 'extract') {
        // 只删「本次新建的目标目录」，如果目录里原本就有别的东西则不动
        if (task._createdDestDir) {
          await fsp.rm(task.destDir, { recursive: true, force: true }).catch(() => {});
        }
      } else if (task.kind === 'create') {
        await fsp.rm(task.archivePath, { force: true }).catch(() => {});
        await fsp.rm(task.archivePath + '.omnizip-part', { force: true }).catch(() => {});
      }
    }

    this._broadcast();
    this._saveStateSoon(true);
    this._promoteQueue();
    return true;
  }

  /** 列出某个归档的内容（供 UI 预览，不写盘） */
  async listArchive(archivePath, password) {
    const abs = path.resolve(String(archivePath));
    const head = await readHead(abs);
    const format = detectFormat(abs, head);
    if (!format) throw new Error('无法识别的归档格式');

    if (format.id === 'zip') {
      const r = await ZipReader.open(abs);
      try {
        return { formatId: 'zip', formatName: 'ZIP', entries: r.list(), encrypted: r.isEncrypted };
      } finally {
        await r.close();
      }
    }
    if (format.id === 'tar') {
      const r = await TarReader.open(abs);
      try {
        return { formatId: 'tar', formatName: 'TAR', entries: r.list(), encrypted: false };
      } finally {
        await r.close();
      }
    }
    if (format.id === 'gzip') {
      return this._listGzip(abs);
    }

    // 外部工具
    const picked = pickTool(this.tools, format.id);
    if (!picked) throw new Error(`${format.name} 需要外部 7-Zip 支持`);
    if (picked.id === 'bsdtar') {
      return { formatId: format.id, formatName: format.name, entries: await listWithBsdtar(picked.path, abs), encrypted: false };
    }
    const entries = await listWithSevenZip(picked.path, abs, password);
    return { formatId: format.id, formatName: format.name, entries, encrypted: entries.some((e) => e.encrypted) };
  }

  /**
   * 预览 GZIP / TAR.GZ 内容。
   * 若内层是 TAR（通过嗅探前 1024 字节或扩展名判断），先解压到临时 tar 再读取完整条目列表。
   */
  async _listGzip(abs) {
    const st = await fsp.stat(abs);
    const headBuf = await readHead(abs, 4096);
    const info = gzipInfo(headBuf);
    const innerHead = await peekGunzipHead(abs, 1024);
    const innerIsTar =
      findBySignature(innerHead)?.id === 'tar' ||
      /\.(tar\.gz|tgz)$/i.test(abs) ||
      /\.tar$/i.test(info.originalName || '');

    if (innerIsTar) {
      const tmpTar = path.join(os.tmpdir(), `omnizip-list-${process.pid}-${++SAVE_SEQ}.tar`);
      try {
        await gunzipTo(abs, tmpTar);
        const r = await TarReader.open(tmpTar);
        try {
          return { formatId: 'gzip', formatName: 'TAR.GZ', entries: r.list(), encrypted: false };
        } finally {
          await r.close();
        }
      } finally {
        await fsp.rm(tmpTar, { force: true }).catch(() => {});
      }
    }

    const name = info.originalName || path.basename(abs).replace(/\.(gz|tgz)$/i, '');
    return {
      formatId: 'gzip',
      formatName: 'GZIP',
      entries: [
        {
          name,
          isDir: false,
          size: innerHead.length < 1024 ? innerHead.length : 0,
          compressedSize: st.size,
          encrypted: false,
          method: 'gzip',
          mtime: info.mtime ? info.mtime.toISOString() : null
        }
      ],
      encrypted: false
    };
  }

  /** 供 UI 的能力清单 */
  capabilities() {
    return {
      tools: this.tools.tools,
      hasSevenZip: !!this.tools.sevenZip,
      hasUnrar: !!this.tools.unrar,
      hasBsdtar: !!this.tools.bsdtar
    };
  }

  // ------------------------------------------------------------- 调度

  _pickBackendForExtract(format) {
    if (!format) return 'none';
    if (['zip', 'tar', 'gzip'].includes(format.id)) return 'builtin';
    return this.tools.sevenZip || this.tools.unrar || this.tools.bsdtar ? 'external' : 'none';
  }

  _canHandle(format) {
    if (!format) return false;
    if (['zip', 'tar', 'gzip'].includes(format.id)) return true;
    return !!(this.tools.sevenZip || this.tools.unrar || this.tools.bsdtar);
  }

  _formatById(id) {
    // 仅用于 create：内置三种 + 外部 7z 系
    const builtin = { zip: 'zip', tar: 'tar', gzip: 'gzip', 'tar.gz': 'gzip' };
    if (builtin[id]) return { id: builtin[id], name: id.toUpperCase(), canCreate: true };
    if (this.tools.sevenZip) return { id, name: id.toUpperCase(), canCreate: true };
    return null;
  }

  /**
   * 队列感知启动（与 omni-down 的 _schedule 同一套机制）。
   * 名额在这里**同步预留**（_started），否则批量添加时并发数会突破 MAX_ACTIVE。
   */
  _schedule(id, delay = 0) {
    const task = this.tasks.get(id);
    if (!task || task._started) return;
    const active = [...this.tasks.values()].filter(
      (t) => t.status === 'running' || t._started
    ).length;
    if (active >= MAX_ACTIVE) {
      task.status = 'queued';
      this._broadcast();
      return;
    }
    task._started = true;
    setTimeout(() => {
      const t = this.tasks.get(id);
      if (!t) return;
      t._started = false;
      if (t._removeRequested || t._pauseRequested) {
        this._promoteQueue();
        return;
      }
      this._run(t).catch(() => {});
    }, delay);
  }

  /**
   * 有空位时提升队首任务。
   * 只挑 queued：paused 是用户显式暂停，不能被队列自动拉起来。
   */
  _promoteQueue() {
    const next = [...this.tasks.values()].find((t) => t.status === 'queued' && !t._started);
    if (next) this._schedule(next.id, 100);
  }

  // ------------------------------------------------------------- 执行分派

  async _run(task) {
    if (task._pauseRequested || task._removeRequested) return;
    const run = (task._run = (task._run || 0) + 1);
    task.status = 'running';
    task.error = null;
    task.startedAt = Date.now();
    task._bytesThisTick = 0;
    // 每轮开始清零计数器：上一轮可能被中止在中途，残留的 itemsDone / bytesDone
    // 会让新一轮从非零开始，最终出现 itemsDone > itemsTotal（压测已复现）。
    task.itemsDone = 0;
    task.bytesDone = 0;
    task.warnings = [];
    this._broadcast();

    try {
      if (task.kind === 'extract') {
        await this._doExtract(task, run);
      } else {
        await this._doCreate(task, run);
      }
      if (task._run !== run) return;
      task.status = 'done';
      task.progress = 1;
      task.speed = 0;
      task.finishedAt = Date.now();
      this.emit('notice', {
        type: 'success',
        text: `${task.kind === 'extract' ? '解压' : '压缩'}完成：${task.archiveName}`
      });
    } catch (err) {
      // 三种情况都静默退出：
      // 1) 轮次已过期（pause/remove 递增了 _run）
      // 2) 用户请求暂停/删除
      // 3) 主动中止（AbortError）—— 这是暂停的正常路径，不是失败
      if (
        task._run !== run ||
        task._pauseRequested ||
        task._removeRequested ||
        err instanceof AbortError ||
        err?.aborted
      ) {
        return;
      }
      task.status = 'error';
      task.error = err.message || String(err);
      task.speed = 0;
      this.emit('notice', { type: 'error', text: `失败：${task.archiveName} — ${task.error}` });
    } finally {
      // 只有当前轮次才做清理，避免关掉/覆盖新一轮的状态
      if (task._run === run) {
        this._running.delete(task.id);
        this._broadcast();
        this._saveStateSoon(true);
        this._promoteQueue();
      }
    }
  }

  /** 判断当前轮次是否应立刻中止 */
  _shouldAbort(task, run) {
    return () => task._run !== run || task._pauseRequested || task._removeRequested;
  }

  // ------------------------------------------------------------- 解压

  async _doExtract(task, run) {
    const dest = task.destDir;
    // 记录「目标目录是否由本次创建」，用于 remove(deleteOutput) 时安全删除
    if (!fs.existsSync(dest)) {
      await fsp.mkdir(dest, { recursive: true });
      task._createdDestDir = true;
    }

    const head = await readHead(task.archivePath);
    const format = detectFormat(task.archivePath, head);
    if (!format) throw new Error('无法识别的归档格式');

    if (format.id === 'zip') return this._extractZip(task, run, dest);
    if (format.id === 'tar') return this._extractTar(task, run, dest);
    if (format.id === 'gzip') return this._extractGzip(task, run, dest);

    return this._extractExternal(task, run, dest, format);
  }

  async _extractZip(task, run, dest) {
    const reader = await ZipReader.open(task.archivePath);
    try {
      const entries = reader.entries.filter((e) => !e.isDir);
      task.itemsTotal = entries.length;
      task.bytesTotal = entries.reduce((a, e) => a + e.size, 0) || task.archiveSize;
      this._broadcast();

      // 本轮独立的计数器：绝不直接读写 task.itemsDone / task.bytesDone。
      // 原因（压测复现过）：pause 后立刻 resume 会开启新一轮并清零 task 上的计数，
      // 而旧一轮可能正处在 await 之后、准备 itemsDone++ 的位置——它会把新一轮
      // 刚清零的值再 +1，最终出现 itemsDone(4) > itemsTotal(3)。
      // 用局部变量后，旧轮次怎么改都只影响自己的副本，写回 task 时再校验 _run。
      const counter = { items: 0, bytes: 0 };
      const shouldAbort = this._shouldAbort(task, run);

      // 目录条目先建（保证空目录也被还原）
      for (const e of reader.entries) {
        if (shouldAbort()) throw new AbortError();
        if (!e.isDir) continue;
        const rel = sanitizeEntryName(e.name);
        if (!rel) continue;
        const abs = safeJoin(dest, rel);
        if (abs) await fsp.mkdir(abs, { recursive: true });
      }

      const taken = new Set();
      for (const entry of entries) {
        if (shouldAbort()) throw new AbortError();
        const rel = sanitizeEntryName(entry.name);
        if (!rel) {
          task.warnings.push(`跳过不安全的条目：${entry.name}`);
          continue;
        }
        // 名字冲突（同一包里两个同名文件 / 磁盘上已存在）→ 自动加后缀
        const finalRel = uniqueName(dest, rel, taken);
        const abs = safeJoin(dest, finalRel);
        if (!abs) {
          task.warnings.push(`跳过越界路径：${entry.name}`);
          continue;
        }

        await reader.extractEntryTo(
          entry,
          abs,
          (n) => {
            counter.bytes += n;
            task._bytesThisTick += n;
          },
          { shouldAbort }
        );
        if (shouldAbort()) throw new AbortError();

        // 还原 Unix 权限（Windows 上无效，忽略错误）
        if (entry.unixMode) {
          await fsp.chmod(abs, entry.unixMode).catch(() => {});
        }
        if (entry.mtime) {
          await fsp.utimes(abs, entry.mtime, entry.mtime).catch(() => {});
        }

        counter.items++;
        // 写回共享字段前再确认一次轮次：这一步是检查与写入之间唯一的同步窗口
        if (shouldAbort()) throw new AbortError();
        task.itemsDone = counter.items;
        task.bytesDone = counter.bytes;
        task.progress = task.itemsTotal ? counter.items / task.itemsTotal : 0;
        this._dirty = true;
      }
    } finally {
      await reader.close();
    }
  }

  /**
   * 解压 TAR（或 TAR.GZ 解出后的内层临时 tar）。
   * @param {string} [tarFile] 默认 task.archivePath；tar.gz 场景传入临时 tar 路径
   * @param {{ progressBase?: number, progressSpan?: number }} [range]
   */
  async _extractTar(task, run, dest, tarFile = task.archivePath, range = {}) {
    const progressBase = range.progressBase ?? 0;
    const progressSpan = range.progressSpan ?? 1;
    const shouldAbort = this._shouldAbort(task, run);

    const reader = await TarReader.open(tarFile);
    try {
      const files = reader.entries.filter((e) => !e.isDir && !e.isSymlink && !e.isHardlink);
      task.itemsTotal = files.length;
      task.bytesTotal = files.reduce((a, e) => a + e.size, 0) || task.archiveSize;
      this._broadcast();

      const taken = new Set();

      // 第一遍：目录 + 符号链接（链接要在目标存在前也能建，所以先建链接）
      for (const e of reader.entries) {
        if (shouldAbort()) throw new AbortError();
        if (!e.isDir && !e.isSymlink && !e.isHardlink) continue;
        const rel = sanitizeEntryName(e.name);
        if (!rel) continue;

        if (e.isDir) {
          const abs = safeJoin(dest, rel);
          if (abs) await fsp.mkdir(abs, { recursive: true });
          continue;
        }

        if (e.isSymlink) {
          const abs = safeJoin(dest, rel);
          if (!abs) continue;
          // 只在该路径尚不存在时创建链接，避免覆盖真实文件
          if (!fs.existsSync(abs) && !this._isLink(abs)) {
            await fsp.mkdir(path.dirname(abs), { recursive: true });
            // 链接目标本身不做净化：符号链接允许指向任意地方是 Unix 语义，
            // 但我们会**不跟随**它去写文件，所以不会造成穿越
            await fsp.symlink(e.linkName, abs).catch((err) => {
              task.warnings.push(`符号链接创建失败 ${rel}：${err.message}`);
            });
          }
        }
      }

      // 第二遍：普通文件（用本轮独立的计数器，不直接自增 task 上的共享字段）
      const counter = { items: 0, bytes: 0 };
      for (const e of reader.entries) {
        if (shouldAbort()) throw new AbortError();
        if (e.isDir || e.isSymlink || e.isHardlink) continue;
        const rel = sanitizeEntryName(e.name);
        if (!rel) {
          task.warnings.push(`跳过不安全的条目：${e.name}`);
          continue;
        }
        const finalRel = uniqueName(dest, rel, taken);
        const abs = safeJoin(dest, finalRel);
        if (!abs) {
          task.warnings.push(`跳过越界路径：${e.name}`);
          continue;
        }
        await reader.extractEntryTo(
          e,
          abs,
          (n) => {
            counter.bytes += n;
            task._bytesThisTick += n;
          },
          { shouldAbort }
        );
        if (shouldAbort()) throw new AbortError();
        if (e.mode) await fsp.chmod(abs, e.mode).catch(() => {});
        if (e.mtime) await fsp.utimes(abs, e.mtime, e.mtime).catch(() => {});
        counter.items++;
        if (shouldAbort()) throw new AbortError();
        task.itemsDone = counter.items;
        task.bytesDone = counter.bytes;
        const ratio = task.itemsTotal ? counter.items / task.itemsTotal : 1;
        task.progress = progressBase + ratio * progressSpan;
        this._dirty = true;
      }

      // 第三遍：硬链接（目标已存在）
      for (const e of reader.entries) {
        if (shouldAbort()) throw new AbortError();
        if (!e.isHardlink || !e.linkName) continue;
        const rel = sanitizeEntryName(e.name);
        const targetRel = sanitizeEntryName(e.linkName);
        if (!rel || !targetRel) continue;
        const abs = safeJoin(dest, uniqueName(dest, rel, new Set()));
        const targetAbs = safeJoin(dest, targetRel);
        if (!abs || !targetAbs || !fs.existsSync(targetAbs)) continue;
        if (!fs.existsSync(abs)) {
          await fsp.mkdir(path.dirname(abs), { recursive: true });
          await fsp.link(targetAbs, abs).catch(() => {});
        }
      }
    } finally {
      await reader.close();
    }
  }

  /** 判断路径是否已是符号链接/链接 */
  _isLink(p) {
    try {
      return fs.lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  }

  /**
   * 解压 GZIP / TAR.GZ。
   * - 先 gunzip 到目标文件
   * - 探测解压出的文件头：若是 TAR（或源包是 .tar.gz / .tgz），继续解开内层 tar 并删除中间 tar 文件
   */
  async _extractGzip(task, run, dest) {
    const shouldAbort = this._shouldAbort(task, run);
    const head = await readHead(task.archivePath, 4096);
    const info = gzipInfo(head);
    const isCompoundExt = /\.(tar\.gz|tgz)$/i.test(task.archiveName);

    let name = info.originalName || task.archiveName.replace(/\.(gz|tgz)$/i, '');
    name = sanitizeEntryName(name) || 'unnamed';
    const finalRel = uniqueName(dest, name, new Set());
    const abs = safeJoin(dest, finalRel);
    if (!abs) throw new Error('输出路径不安全');

    task.itemsTotal = 1;
    task.bytesTotal = task.archiveSize;
    task.bytesDone = 0;
    this._broadcast();

    const counter = { bytes: 0 };
    await gunzipTo(
      task.archivePath,
      abs,
      (n) => {
        if (shouldAbort()) return;
        counter.bytes += n;
        task.bytesDone = counter.bytes;
        task._bytesThisTick += n;
        const cap = isCompoundExt ? 0.5 : 0.99;
        task.progress = Math.min(cap, (counter.bytes / Math.max(1, task.archiveSize)) * cap);
      },
      { shouldAbort }
    );

    if (shouldAbort()) {
      await fsp.rm(abs, { force: true }).catch(() => {});
      throw new AbortError();
    }

    // 检查解出的文件本身是不是 TAR（处理 .tar.gz / .tgz 或内层带 ustar 签名的归档）
    const innerHead = await readHead(abs, 600);
    const innerIsTar =
      findBySignature(innerHead)?.id === 'tar' || isCompoundExt || /\.tar$/i.test(name);

    if (innerIsTar) {
      task.formatName = 'TAR.GZ';
      try {
        await this._extractTar(task, run, dest, abs, { progressBase: 0.5, progressSpan: 0.5 });
      } finally {
        await fsp.rm(abs, { force: true }).catch(() => {});
      }
      task.progress = 1;
      return;
    }

    if (info.mtime) await fsp.utimes(abs, info.mtime, info.mtime).catch(() => {});
    task.itemsDone = 1;
    task.progress = 1;
  }

  async _extractExternal(task, run, dest, format) {
    const picked = pickTool(this.tools, format.id);
    if (!picked) throw new Error(`${format.name} 需要外部 7-Zip / unrar / bsdtar 支持`);

    task.itemsTotal = 0;
    task.bytesTotal = task.archiveSize;
    this._broadcast();

    const handle = extractWithTool({
      toolId: picked.id,
      tool: picked.path,
      archive: task.archivePath,
      destDir: dest,
      password: task._password || undefined,
      onProgress: (pct) => {
        if (task._run !== run) return;
        task.progress = Math.max(0, Math.min(1, pct / 100));
      }
    });

    this._running.set(task.id, handle);
    try {
      const res = await handle.promise;
      if (res.warnings?.length) task.warnings.push(...res.warnings);
      task.progress = 1;
    } finally {
      this._running.delete(task.id);
    }
  }

  // ------------------------------------------------------------- 压缩

  async _doCreate(task, run) {
    const format = this._formatById(task.formatId) || findByExtension(task.archivePath);
    // 所有后端统一先写 .omnizip-part，成功后一次性 rename：
    // 这样中途失败/取消绝不会留下一个"看起来完好"的坏包
    const tmpPath = task.archivePath + '.omnizip-part';

    const { collected, totalBytes, totalFiles } = await collectSources(task.sourcePaths);
    task.itemsTotal = totalFiles;
    task.bytesTotal = totalBytes;
    task.progress = 0;
    this._broadcast();

    try {
      if (format.id === 'zip') {
        await this._createZip(task, run, tmpPath, collected);
      } else if (format.id === 'tar') {
        await this._createTar(task, run, tmpPath, collected);
      } else if (format.id === 'gzip') {
        await this._createGzip(task, run, tmpPath, collected);
      } else {
        await this._createExternal(task, run, format, tmpPath, collected);
      }

      if (task._run !== run) throw new AbortError();

      // 收尾：临时文件 → 正式文件名
      await fsp.rename(tmpPath, task.archivePath);
      const st = await fsp.stat(task.archivePath).catch(() => null);
      task.archiveSize = st ? st.size : 0;
      task.progress = 1;
    } catch (err) {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  async _createZip(task, run, outPath, collected) {
    const w = new ZipWriter(outPath, { compress: true, level: task.level });
    await w.open();
    // 本轮独立计数器（理由见 _extractZip）
    const counter = { items: 0, bytes: 0 };
    const shouldAbort = this._shouldAbort(task, run);
    try {
      for (const item of collected) {
        if (shouldAbort()) throw new AbortError();
        if (item.type === 'dir') {
          await w.addDirectory(item.rel + '/', { mode: 0o755 });
          continue;
        }
        if (item.type === 'symlink') {
          // ZIP 存符号链接需要 Unix extra field，多数工具不认；
          // 更安全的是跳过并告警（避免打包出不完整的链接）
          task.warnings.push(`ZIP 不支持符号链接，已跳过：${item.rel}`);
          continue;
        }
        await w.addFile(item.abs, item.rel, {
          mode: (item.mode ?? 0o644) & 0o7777,
          mtime: item.mtime,
          shouldAbort,
          onProgress: (n) => {
            counter.bytes += n;
            task._bytesThisTick += n;
          }
        });
        counter.items++;
        if (shouldAbort()) throw new AbortError();
        task.itemsDone = counter.items;
        task.bytesDone = counter.bytes;
        task.progress = task.itemsTotal ? counter.items / task.itemsTotal : 0;
        this._dirty = true;
      }
      await w.close();
    } catch (err) {
      await w.abort();
      throw err;
    }
  }

  async _createTar(task, run, outPath, collected, range = {}) {
    const progressBase = range.progressBase ?? 0;
    const progressSpan = range.progressSpan ?? 1;
    const w = new TarWriter(outPath);
    await w.open();
    // 本轮独立计数器（理由见 _extractZip）
    const counter = { items: 0, bytes: 0 };
    const shouldAbort = this._shouldAbort(task, run);
    try {
      for (const item of collected) {
        if (shouldAbort()) throw new AbortError();
        if (item.type === 'dir') {
          await w.addDirectory(item.rel + '/', { mode: 0o755 });
          continue;
        }
        if (item.type === 'symlink') {
          await w.addSymlink(item.rel, item.target);
          continue;
        }
        await w.addFile(item.abs, item.rel, {
          mode: (item.mode ?? 0o644) & 0o7777,
          mtime: item.mtime,
          shouldAbort
        });
        counter.bytes += item.size || 0;
        task._bytesThisTick += item.size || 0;
        counter.items++;
        if (shouldAbort()) throw new AbortError();
        task.itemsDone = counter.items;
        task.bytesDone = counter.bytes;
        const ratio = task.itemsTotal ? counter.items / task.itemsTotal : 1;
        task.progress = progressBase + ratio * progressSpan;
        this._dirty = true;
      }
      await w.close();
    } catch (err) {
      await w.abort();
      throw err;
    }
  }

  /**
   * GZIP 与 tar.gz。
   * - `.gz`：单文件压缩，只允许一个源文件
   * - `.tar.gz` / `.tgz`：先打 tar 到临时文件，再 gzip 压掉
   *
   * 注意 outPath 始终是 .omnizip-part，格式由 task.archivePath 的扩展名决定。
   */
  async _createGzip(task, run, outPath, collected) {
    const shouldAbort = this._shouldAbort(task, run);
    const isTarGz = /\.(tar\.gz|tgz)$/i.test(task.archivePath);
    if (!isTarGz) {
      const files = collected.filter((c) => c.type === 'file');
      if (files.length !== 1) throw new Error('GZIP 只能压缩单个文件，多文件请选 TAR.GZ 或 ZIP');
      const counter = { bytes: 0 };
      await gzipFrom(files[0].abs, outPath, {
        level: task.level,
        shouldAbort,
        onProgress: (n) => {
          if (shouldAbort()) return;
          counter.bytes += n;
          task.bytesDone = counter.bytes;
          task._bytesThisTick += n;
          task.progress = Math.min(0.99, counter.bytes / Math.max(1, task.bytesTotal));
        }
      });
      if (shouldAbort()) throw new AbortError();
      task.itemsDone = 1;
      task.progress = 1;
      return;
    }

    // tar.gz：先 tar 到临时文件（占 0..0.5），再 gzip（占 0.5..1.0）。
    const tarTmp = outPath + '.tar';
    try {
      await this._createTar(task, run, tarTmp, collected, { progressBase: 0, progressSpan: 0.5 });
      if (shouldAbort()) throw new AbortError();
      const tarStat = await fsp.stat(tarTmp);
      let gzBytes = 0;
      await gzipFrom(tarTmp, outPath, {
        level: task.level,
        shouldAbort,
        onProgress: (n) => {
          if (shouldAbort()) return;
          gzBytes += n;
          task._bytesThisTick += n;
          task.progress = Math.min(0.99, 0.5 + (gzBytes / Math.max(1, tarStat.size)) * 0.5);
        }
      });
      if (shouldAbort()) throw new AbortError();
      task.progress = 1;
    } finally {
      await fsp.rm(tarTmp, { force: true }).catch(() => {});
    }
  }

  async _createExternal(task, run, format, outPath, collected) {
    const tool = this.tools.sevenZip;
    if (!tool) throw new Error(`${format.name} 需要外部 7-Zip 支持`);

    // 7-Zip 用 cwd + 相对路径，避免命令行过长与转义问题：
    // 把公共父目录作为 cwd，条目使用相对路径
    const relatives = collected.map((c) => c.rel);
    const cwd = this._commonRoot(collected);

    const handle = createWithSevenZip({
      tool,
      archive: outPath,
      cwd,
      items: relatives,
      level: levelToSevenZip(task.level),
      password: task._password || undefined,
      onProgress: (pct) => {
        if (task._run !== run) return;
        task.progress = Math.max(0, Math.min(1, pct / 100));
      }
    });

    this._running.set(task.id, handle);
    try {
      await handle.promise;
      task.itemsDone = task.itemsTotal;
      task.progress = 1;
    } finally {
      this._running.delete(task.id);
    }
  }

  /** 收集项的公共父目录，作为 7-Zip 的 cwd */
  _commonRoot(collected) {
    if (!collected.length) return this.workDir;
    const first = collected[0].abs;
    let root = path.dirname(first);
    for (const c of collected) {
      while (!c.abs.startsWith(root + path.sep) && root !== path.dirname(root)) {
        root = path.dirname(root);
      }
    }
    return root;
  }

  _cancelRunning(id) {
    const h = this._running.get(id);
    if (h?.cancel) {
      try {
        h.cancel();
      } catch {
        /* ignore */
      }
    }
    this._running.delete(id);
  }

  // ------------------------------------------------------------- 周期与广播

  _tick() {
    for (const t of this.tasks.values()) {
      if (t.status === 'running') {
        const rate = ((t._bytesThisTick || 0) * 1000) / TICK_MS;
        // 平滑：与上次速度做指数加权，避免数字剧烈跳动
        t.speed = Math.round((t.speed || 0) * 0.6 + rate * 0.4);
      } else {
        t.speed = 0;
      }
      t._bytesThisTick = 0;
    }
    this._broadcast();
    if (this._dirty) {
      this._dirty = false;
      this._saveStateSoon();
    }
  }

  _broadcast() {
    this.emit('update', { tasks: this.serializeAll(), stats: this.stats() });
  }

  // ------------------------------------------------------------- 序列化

  serialize(task) {
    return {
      id: task.id,
      kind: task.kind,
      name: task.archiveName,
      archivePath: task.archivePath,
      archiveSize: task.archiveSize,
      destDir: task.destDir,
      formatId: task.formatId,
      formatName: task.formatName,
      backend: task.backend,
      status: task.status,
      progress: task.status === 'done' ? 1 : Math.max(0, Math.min(1, task.progress || 0)),
      speed: task.speed || 0,
      itemsDone: task.itemsDone || 0,
      itemsTotal: task.itemsTotal || 0,
      bytesDone: task.bytesDone || 0,
      bytesTotal: task.bytesTotal || 0,
      error: task.error,
      warnings: task.warnings || [],
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      paused: task.status === 'paused',
      done: task.status === 'done',
      queued: task.status === 'queued'
    };
  }

  serializeAll() {
    // 新任务在前
    return [...this.tasks.values()]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map((t) => this.serialize(t));
  }

  stats() {
    const list = [...this.tasks.values()];
    return {
      count: list.length,
      active: list.filter((t) => t.status === 'running').length,
      queued: list.filter((t) => t.status === 'queued').length,
      done: list.filter((t) => t.status === 'done').length,
      error: list.filter((t) => t.status === 'error').length,
      paused: list.filter((t) => t.status === 'paused').length
    };
  }

  // ------------------------------------------------------------- 持久化

  _saveStateSoon(immediate = false) {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(
      () => {
        this._saveTimer = null;
        this._saveState();
      },
      immediate ? 0 : SAVE_DEBOUNCE
    );
  }

  /**
   * 读取状态。
   *
   * 文件损坏时不直接返回空（那等于静默丢光用户的任务），
   * 而是先把它重命名成 `.corrupt-<时间戳>` 留证，再尝试从 .bak 恢复。
   */
  async _loadState() {
    const parse = async (file) => {
      const raw = await fsp.readFile(file, 'utf8');
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    };

    try {
      return await parse(this.stateFile);
    } catch (err) {
      if (err.code === 'ENOENT') return []; // 首次运行，正常

      // 内容损坏：留档，避免下次启动又踩同一个坑
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const bad = `${this.stateFile}.corrupt-${stamp}`;
      await fsp.rename(this.stateFile, bad).catch(() => {});
      this.emit('notice', {
        type: 'warn',
        text: `任务状态文件损坏，已备份为 ${path.basename(bad)}，任务列表已重置`
      });

      // 尝试上一次成功保存的备份
      try {
        return await parse(this.stateFile + '.bak');
      } catch {
        return [];
      }
    }
  }

  /**
   * 落盘状态。
   *
   * 并发语义（很重要，压测踩过两次坑）：
   * - **不能**在已有保存进行时直接 return。`stop()` 里 `await _saveState()`
   *   就是要保证「返回时磁盘已是最新」，直接 return 会让它以为存好了，
   *   实际写下的还是更早的快照 → 重启后任务数对不上（压测复现 1 次）。
   * - 正确做法是**串行排队**：后到的保存等前一个完成，然后再写一次。
   *   多写一次是无害的（内容更全），少写一次才会丢数据。
   *
   * @returns {Promise<void>}
   */
  async _saveState() {
    // 串到上一轮保存之后
    const prev = this._saveChain || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => this._writeStateFile());
    this._saveChain = next;
    return next;
  }

  /** 真正写文件（同一时刻只会有一个在执行，由 _saveState 排队保证） */
  async _writeStateFile() {
    this._dirty = false;

    const data = [...this.tasks.values()].map((t) => ({
      id: t.id,
      kind: t.kind,
      archivePath: t.archivePath,
      archiveName: t.archiveName,
      archiveSize: t.archiveSize,
      sourcePaths: t.sourcePaths,
      destDir: t.destDir,
      formatId: t.formatId,
      formatName: t.formatName,
      backend: t.backend,
      level: t.level,
      hasPassword: t.hasPassword,
      status: t.status === 'running' ? 'paused' : t.status,
      progress: t.progress,
      itemsDone: t.itemsDone,
      itemsTotal: t.itemsTotal,
      bytesDone: t.bytesDone,
      bytesTotal: t.bytesTotal,
      error: t.error,
      warnings: t.warnings,
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      _createdDestDir: t._createdDestDir
    }));

    try {
      await fsp.mkdir(path.dirname(this.stateFile), { recursive: true });
      // 原子写：先写 tmp 再 rename，写到一半崩溃也不会留下坏 JSON。
      //
      // tmp 文件名必须**每个写入者唯一**，不能固定成 `${stateFile}.tmp`：
      // 曾经固定过，结果两个引擎实例（stop() 后立刻 new 一个新的、
      // 或旧实例的防抖保存还没跑完）会同时写同一个 tmp，
      // 后一个 writeFile 截断前一个的内容，先完成的一方 rename 走半截数据，
      // 状态文件就变成了非法 JSON（压测 1200 轮复现 4 次）。
      const tmp = `${this.stateFile}.${process.pid}.${++SAVE_SEQ}.tmp`;
      try {
        const json = JSON.stringify(data, null, 2);
        await fsp.writeFile(tmp, json, 'utf8');
        // 保留上一版为 .bak：主文件被外部弄坏（断电、编辑器、别的进程）时，
        // _loadState 还能从这里恢复。用 copyFile 而不是 rename，
        // 因为主文件要留在原地，rename 会把它挪走留下空档。
        await fsp.copyFile(this.stateFile, this.stateFile + '.bak').catch(() => {});
        await fsp.rename(tmp, this.stateFile);
      } catch {
        // 失败时清掉自己的 tmp，避免反复失败堆积垃圾文件
        await fsp.rm(tmp, { force: true }).catch(() => {});
      }
    } catch {
      /* 落盘失败不影响当前运行 */
    }
  }
}

/** 压缩级别（0-9）映射到 7-Zip 的 -mx 档位 */
function levelToSevenZip(level) {
  if (level <= 0) return '0';
  if (level <= 2) return '1';
  if (level <= 5) return '5';
  if (level <= 7) return '7';
  return '9';
}
