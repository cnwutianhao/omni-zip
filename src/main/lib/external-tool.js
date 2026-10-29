/**
 * 外部解压工具适配器
 *
 * 定位：内置引擎负责 ZIP / TAR / GZIP（零依赖、全平台、可控进度），
 * 其余格式（7z / RAR / BZIP2 / XZ / ZSTD / ISO / WIM…）和加密包交给外部程序。
 *
 * 支持三类工具，按优先级尝试：
 *   1. 7zz / 7z / 7za / 7zr   —— 官方 7-Zip（最强，能读几乎所有格式）
 *   2. unrar / unar           —— RAR 专用（7-Zip 也支持 RAR，但 unrar 更完整）
 *   3. bsdtar                 —— macOS 自带（libarchive 后端，支持 zip/tar/7z 子集）
 *
 * 设计约束：
 * - **不下载、不捆绑任何二进制**：用户自己装，我们只负责发现与调用
 * - 所有命令用 spawn + 参数数组，绝不拼 shell 字符串（避免路径里的空格与注入）
 * - 解析 stdout 拿到真实进度（7-Zip 的 `-bsp1` 会输出百分比）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** 可能出现在 PATH 里的 7-Zip 家族可执行文件名，按能力从强到弱 */
const SEVENZIP_NAMES = ['7zz', '7z', '7za', '7zr'];

/** 各平台常见的安装路径（PATH 里找不到时兜底） */
const SEVENZIP_PATHS = {
  win32: [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    'C:\\Program Files\\NanaZip\\NanaZip.exe'
  ],
  darwin: ['/opt/homebrew/bin/7zz', '/usr/local/bin/7zz', '/opt/homebrew/bin/7z', '/usr/local/bin/7z'],
  linux: ['/usr/bin/7zz', '/usr/bin/7z', '/usr/local/bin/7zz', '/usr/local/bin/7z', '/snap/bin/7z']
};

/** 在 PATH 里找可执行文件 */
function whichSync(cmd) {
  const isWin = process.platform === 'win32';
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = (process.env.PATH || '').split(isWin ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        const st = fs.statSync(full);
        if (st.isFile()) {
          // Unix 上还要检查可执行位
          if (isWin || (st.mode & 0o111) !== 0) return full;
        }
      } catch {
        /* 继续找 */
      }
    }
  }
  return null;
}

/**
 * 探测外部工具的可用情况。
 * @returns {{ sevenZip: string|null, unrar: string|null, bsdtar: string|null, tools: object[] }}
 */
export function detectTools() {
  const found = { sevenZip: null, unrar: null, bsdtar: null };

  for (const name of SEVENZIP_NAMES) {
    const p = whichSync(name);
    if (p) {
      found.sevenZip = p;
      break;
    }
  }
  if (!found.sevenZip) {
    for (const p of SEVENZIP_PATHS[process.platform] || []) {
      try {
        if (fs.statSync(p).isFile()) {
          found.sevenZip = p;
          break;
        }
      } catch {
        /* ignore */
      }
    }
  }

  found.unrar = whichSync('unrar') || whichSync('unar');
  found.bsdtar = whichSync('bsdtar');

  const tools = [];
  if (found.sevenZip) {
    tools.push({ id: '7zip', name: '7-Zip', path: found.sevenZip, capabilities: '7z rar zip tar gz bz2 xz zstd iso wim aes' });
  }
  if (found.unrar) {
    tools.push({ id: 'unrar', name: path.basename(found.unrar), path: found.unrar, capabilities: 'rar' });
  }
  if (found.bsdtar) {
    tools.push({ id: 'bsdtar', name: 'bsdtar (libarchive)', path: found.bsdtar, capabilities: 'zip tar gz bz2 xz 7z cpio' });
  }
  return { ...found, tools };
}

/**
 * 跑一个子进程并收集输出。
 *
 * 为什么不封装成 Promise 就完事：解压是长任务，必须能中断（用户点取消），
 * 所以返回 { promise, child }，让调用方保留 child 句柄。
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ onStdout?: (line: string) => void, onStderr?: (line: string) => void, cwd?: string }} [opts]
 * @returns {{ promise: Promise<{code:number, stdout:string, stderr:string}>, child: import('node:child_process').ChildProcess }}
 */
function runProcess(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  let bufOut = '';
  let bufErr = '';

  const flush = (text, cb, setBuf) => {
    const parts = text.replace(/\r/g, '\n').split('\n');
    const rest = parts.pop();
    for (const line of parts) if (line && cb) cb(line);
    setBuf(rest);
  };

  child.stdout.on('data', (chunk) => {
    const s = chunk.toString('utf8');
    stdout += s;
    bufOut += s;
    flush(bufOut, opts.onStdout, (r) => (bufOut = r));
  });
  child.stderr.on('data', (chunk) => {
    const s = chunk.toString('utf8');
    stderr += s;
    bufErr += s;
    flush(bufErr, opts.onStderr, (r) => (bufErr = r));
  });

  const promise = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (bufOut && opts.onStdout) opts.onStdout(bufOut);
      if (bufErr && opts.onStderr) opts.onStderr(bufErr);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

  return { promise, child };
}

/**
 * 把 7-Zip 的 `-bsp1` 百分比输出解析成进度回调。
 * 7-Zip 输出形如：
 *   `  5% 12 - file.txt`
 *   ` 45%\b\b\b...`（会带退格符，这里统一清掉）
 */
export function parseSevenZipProgress(line) {
  const clean = line.replace(/[\b\r]/g, '');
  const m = /^\s*(\d{1,3})%/.exec(clean);
  if (!m) return null;
  const pct = Number(m[1]);
  return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : null;
}

export class ExternalToolError extends Error {
  constructor(message, { code, tool, stderr } = {}) {
    super(message);
    this.name = 'ExternalToolError';
    this.code = code;
    this.tool = tool;
    this.stderr = stderr;
  }
}

/**
 * 用外部 7-Zip 解压。
 *
 * @param {object} p
 * @param {string} p.tool 7-Zip 可执行文件路径
 * @param {string} p.archive 压缩包路径
 * @param {string} p.destDir 目标目录
 * @param {string} [p.password]
 * @param {(pct: number, file?: string) => void} [p.onProgress]
 * @returns {{ promise: Promise<object>, cancel: () => void }}
 */
export function extractWithSevenZip({ tool, archive, destDir, password, onProgress }) {
  const args = ['x', archive, `-o${destDir}`, '-y', '-bsp1', '-bso1', '-bse2'];
  if (password) args.push(`-p${password}`);

  let lastPct = -1;
  const { promise, child } = runProcess(tool, args, {
    onStdout: (line) => {
      const pct = parseSevenZipProgress(line);
      if (pct !== null && pct !== lastPct) {
        lastPct = pct;
        onProgress?.(pct, line.replace(/^\s*\d+%\s*/, '').trim() || undefined);
      }
    }
  });

  return {
    promise: promise.then(({ code, stdout, stderr }) => {
      // 7-Zip 退出码：0 成功、1 警告、2 致命错误、7 命令行错误、8 内存不足、255 用户中断
      if (code === 0) return { ok: true, code, warnings: [] };
      if (code === 1) {
        // 警告（例如部分文件无法打开）：视为成功但带警告
        return { ok: true, code, warnings: [stderr.trim() || stdout.trim()].filter(Boolean) };
      }
      if (code === 255) throw new ExternalToolError('已取消', { code, tool, stderr });
      const msg = stderr.trim() || stdout.trim() || `7-Zip 退出码 ${code}`;
      throw new ExternalToolError(msg, { code, tool, stderr });
    }),
    cancel: () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
  };
}

/**
 * 用外部 7-Zip 创建压缩包。
 *
 * @param {object} p
 * @param {string} p.tool
 * @param {string} p.archive 输出路径（扩展名决定格式）
 * @param {string} p.cwd 工作目录（7-Zip 的 -spf 之外都相对它）
 * @param {string[]} p.items 要加入的条目（相对 cwd）
 * @param {string} [p.level] 0/1/3/5/7/9
 * @param {string} [p.password]
 * @param {(pct:number)=>void} [p.onProgress]
 * @returns {{ promise: Promise<object>, cancel: () => void }}
 */
export function createWithSevenZip({ tool, archive, cwd, items, level = '5', password, onProgress }) {
  const args = ['a', archive, ...items, `-mx=${level}`, '-y', '-bsp1', '-bso1', '-bse2'];
  if (password) args.push(`-p${password}`);

  let lastPct = -1;
  const { promise, child } = runProcess(tool, args, {
    cwd,
    onStdout: (line) => {
      const pct = parseSevenZipProgress(line);
      if (pct !== null && pct !== lastPct) {
        lastPct = pct;
        onProgress?.(pct);
      }
    }
  });

  return {
    promise: promise.then(({ code, stdout, stderr }) => {
      if (code === 0 || code === 1) return { ok: true, code };
      if (code === 255) throw new ExternalToolError('已取消', { code, tool, stderr });
      throw new ExternalToolError(
        stderr.trim() || stdout.trim() || `7-Zip 退出码 ${code}`,
        { code, tool, stderr }
      );
    }),
    cancel: () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
  };
}

/**
 * 用外部 7-Zip 列出内容（解析 `-slt` 的机器可读格式）。
 * @param {string} tool
 * @param {string} archive
 * @param {string} [password]
 * @returns {Promise<Array<object>>}
 */
export async function listWithSevenZip(tool, archive, password) {
  const args = ['l', archive, '-slt', '-bso1', '-bse2'];
  if (password) args.push(`-p${password}`);
  const { promise } = runProcess(tool, args);
  const { code, stdout, stderr } = await promise;
  if (code !== 0 && code !== 1) {
    throw new ExternalToolError(stderr.trim() || `7-Zip 退出码 ${code}`, { code, tool, stderr });
  }

  const out = [];
  let cur = null;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) {
      // 空行是条目分隔符
      if (cur && cur.Path) out.push(cur);
      cur = null;
      continue;
    }
    const eq = line.indexOf(' = ');
    if (eq < 0) continue;
    // 7-Zip 的键名里带空格（"Packed Size" / "Physical Size"），
    // 用空格归一成驼峰，调用方读 PackedSize 才不会被坑
    const rawKey = line.slice(0, eq);
    const key = rawKey.trim().replace(/\s+(\w)/g, (_, c) => c.toUpperCase());
    const value = line.slice(eq + 3);
    if (!cur) cur = {};
    cur[key] = value;
  }
  if (cur && cur.Path) out.push(cur);

  // 7-Zip 的 `l` 输出第一段是归档自身的信息（Path=<归档路径>），
  // 用「有 Folder 或 Size 或 Attributes」来区分真实条目
  return out
    .filter((e) => e.Path && e.Path !== archive)
    .filter((e) => e.Folder !== undefined || e.Size !== undefined || e.Attributes !== undefined)
    .map((e) => ({
      name: e.Path,
      isDir: e.Folder === '+',
      size: Number(e.Size || 0),
      compressedSize: Number(e.PackedSize || 0),
      encrypted: e.Encrypted === '+',
      method: e.Method || '',
      mtime: e.Modified || null
    }));
}

/** 用 bsdtar 列出（进度无法解析，只用于 fallback 场景） */
export async function listWithBsdtar(tool, archive) {
  const { promise } = runProcess(tool, ['-tf', archive]);
  const { code, stdout, stderr } = await promise;
  if (code !== 0) throw new ExternalToolError(stderr.trim() || `bsdtar 退出码 ${code}`, { code, tool, stderr });
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((name) => ({ name, isDir: name.endsWith('/'), size: 0, compressedSize: 0, encrypted: false, method: '' }));
}

/** 用 bsdtar 解压 */
export function extractWithBsdtar({ tool, archive, destDir, onProgress }) {
  const { promise, child } = runProcess(tool, ['-xf', archive, '-C', destDir]);
  return {
    promise: promise.then(({ code, stderr }) => {
      if (code === 0) return { ok: true, code, warnings: [] };
      throw new ExternalToolError(stderr.trim() || `bsdtar 退出码 ${code}`, { code, tool, stderr });
    }),
    cancel: () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
  };
}

/** 用 unrar 解压 */
export function extractWithUnrar({ tool, archive, destDir, password, onProgress }) {
  const args = ['x', '-y'];
  if (password) args.push(`-p${password}`);
  else args.push('-p-'); // 显式无密码，避免交互式等待
  args.push(archive, destDir + (destDir.endsWith(path.sep) ? '' : path.sep));

  let lastPct = -1;
  const { promise, child } = runProcess(tool, args, {
    onStdout: (line) => {
      const m = /(\d{1,3})%/.exec(line);
      if (m) {
        const pct = Number(m[1]);
        if (pct !== lastPct) {
          lastPct = pct;
          onProgress?.(pct);
        }
      }
    }
  });

  return {
    promise: promise.then(({ code, stdout, stderr }) => {
      // unrar: 0 成功、1 警告、3 CRC 错误、10 无文件
      if (code === 0) return { ok: true, code, warnings: [] };
      if (code === 1) return { ok: true, code, warnings: [stderr.trim()].filter(Boolean) };
      throw new ExternalToolError(stderr.trim() || stdout.trim() || `unrar 退出码 ${code}`, {
        code,
        tool,
        stderr
      });
    }),
    cancel: () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
  };
}

/**
 * 选出最适合处理该格式的外部工具。
 * @param {object} tools detectTools() 的结果
 * @param {string} formatId
 */
export function pickTool(tools, formatId) {
  if (formatId === 'rar' && tools.unrar) return { id: 'unrar', path: tools.unrar };
  if (tools.sevenZip) return { id: '7zip', path: tools.sevenZip };
  if (formatId === 'rar' && tools.bsdtar) return { id: 'bsdtar', path: tools.bsdtar };
  if (tools.bsdtar) return { id: 'bsdtar', path: tools.bsdtar };
  return null;
}

/**
 * 统一解压入口：按工具 id 分派。
 * @returns {{ promise: Promise<object>, cancel: () => void }}
 */
export function extractWithTool(p) {
  switch (p.toolId) {
    case 'unrar':
      return extractWithUnrar(p);
    case 'bsdtar':
      return extractWithBsdtar(p);
    case '7zip':
    default:
      return extractWithSevenZip(p);
  }
}
