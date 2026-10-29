/**
 * 路径安全与文件名工具
 *
 * 解压类工具最重要的一条安全边界：**绝不能把压缩包里的条目写到目标目录之外**。
 * 恶意压缩包会用 `../../.ssh/authorized_keys`、`/etc/passwd`、`C:\Windows\...` 之类的
 * 路径穿越（zip-slip / tar-slip）。这里的 safeJoin 是唯一的写盘入口，
 * 其他模块一律不许自己拼 path.join。
 */
import path from 'node:path';
import fs from 'node:fs';

/** 各平台文件名非法字符（Windows 最严格，统一按最严的来，保证跨平台可解） */
const ILLEGAL_CHARS = /[<>:"|?*\u0000-\u001f]/g;

/**
 * 把压缩包内的条目名规范成安全的相对路径。
 *
 * 处理内容：
 * - 反斜杠统一成正斜杠（ZIP 规范要求 /，但 Windows 打包工具常写 \）
 * - 去掉 Windows 盘符（C:、D:）
 * - 去掉开头的 / 与 \\（绝对路径）
 * - 去掉 `.` 与所有 `..` 段（不做"回退一级"，直接丢弃，避免嵌套穿越）
 * - 去掉每个分量的非法字符
 * - 空结果返回 null（调用方跳过该条目）
 *
 * @param {string} entryName 压缩包内原始条目名
 * @returns {string|null} 安全的相对路径（用 / 分隔），或 null 表示必须跳过
 */
export function sanitizeEntryName(entryName) {
  if (typeof entryName !== 'string') return null;

  let s = entryName.replace(/\\/g, '/');

  // Windows 盘符（C:/xxx）与 UNC（//server/share）都要去掉绝对性
  s = s.replace(/^[a-zA-Z]:/, '');
  s = s.replace(/^\/+/, '');

  const parts = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') continue; // 直接丢弃：不向上跳，所以不可能逃出目标目录
    // 分量级清理：非法字符、结尾的点与空格（Windows 会静默截断）
    let clean = seg.replace(ILLEGAL_CHARS, '_').replace(/[. ]+$/, '');
    if (!clean) continue;
    parts.push(clean);
  }

  if (!parts.length) return null;
  const out = parts.join('/');
  // 最终防线：规范化后若仍含 .. 或变成绝对路径，一律拒绝
  if (out.split('/').some((p) => p === '..')) return null;
  return out;
}

/**
 * 把「已净化的相对路径」拼到根目录下，并二次校验结果确实在根目录内。
 *
 * 二次校验不是多余：sanitizeEntryName 已过滤 `..`，但 Windows 上还有
 * 8.3 短名、保留设备名（CON/PRN/AUX/NUL/COM1..9/LPT1..9）这类边角情况。
 * 这里用 path.resolve 后再比较前缀，能挡住所有路径拼接类的逃逸。
 *
 * @param {string} rootDir 解压目标根目录（调用方应已 fs.realpathSync 解析过符号链接）
 * @param {string} safeRel 已净化的相对路径
 * @returns {string|null} 绝对路径，或 null 表示不安全
 */
export function safeJoin(rootDir, safeRel) {
  if (!safeRel) return null;
  const root = path.resolve(rootDir);
  const target = path.resolve(root, safeRel);
  if (target === root) return null;
  // 必须严格位于 root 之下（加分隔符避免 /tmp/foo 匹配到 /tmp/foobar）
  if (!target.startsWith(root + path.sep)) return null;
  return target;
}

/**
 * Windows 保留设备名。这类名字在 Windows 上无法创建普通文件，
 * 解压时会失败或被重定向到设备，需要在跨平台输出时改名。
 */
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 给单段文件名做可移植性修正（Windows 保留名 → 加下划线）。
 * @param {string} name
 * @returns {string}
 */
export function portableName(name) {
  if (!name) return name;
  return WIN_RESERVED.test(name) ? `_${name}` : name;
}

/**
 * 分配不冲突的输出路径：`a.txt` → `a (1).txt` → `a (2).txt` …
 *
 * 与 omni-down 的 _uniquePath 同一思路，但这里额外处理「目录」：
 * 目录重名时同样加后缀，且要去重时同时比较大小写（macOS/Windows 文件系统
 * 默认大小写不敏感，`A.txt` 和 `a.txt` 视为同一个文件）。
 *
 * @param {string} dir 目标目录
 * @param {string} name 期望的文件/目录名（可含子目录）
 * @param {Set<string>} taken 本次任务内已占用的相对路径（小写）
 * @returns {string} 可用的相对路径
 */
export function uniqueName(dir, name, taken) {
  const norm = name.replace(/\\/g, '/');
  const slash = norm.lastIndexOf('/');
  const parent = slash >= 0 ? norm.slice(0, slash + 1) : '';
  const base = portableName(slash >= 0 ? norm.slice(slash + 1) : norm);
  const ext = path.posix.extname(base);
  const stem = base.slice(0, base.length - ext.length);

  const free = (n) => {
    const key = n.toLowerCase();
    if (taken.has(key)) return false;
    // 已存在磁盘上的同名项也不行（用户可能已经解过一次）
    try {
      fs.lstatSync(path.join(dir, n));
      return false;
    } catch {
      return true;
    }
  };

  const first = parent + base;
  if (free(first)) {
    taken.add(first.toLowerCase());
    return first;
  }
  for (let i = 1; i < 10000; i++) {
    const candidate = `${parent}${stem} (${i})${ext}`;
    if (free(candidate)) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
  // 极端情况兜底：时间戳保证唯一
  const fallback = `${parent}${stem}-${Date.now()}${ext}`;
  taken.add(fallback.toLowerCase());
  return fallback;
}

/**
 * 计算解压到的默认根目录：压缩包所在目录 / 去扩展名的包名。
 *
 * @param {string} archivePath 压缩包绝对路径
 * @param {string} baseDir 默认为压缩包所在目录
 * @returns {string} 目标目录绝对路径（可能已存在同名 → 由调用方再跑 uniqueName）
 */
export function defaultExtractDir(archivePath, baseDir) {
  const dir = baseDir || path.dirname(archivePath);
  let stem = path.basename(archivePath);
  // 复合扩展名：.tar.gz / .tar.bz2 / .tar.xz / .tgz / .tbz2 / .txz
  stem = stem.replace(/\.(tar\.(gz|bz2|xz|zst)|tgz|tbz2?|txz|tzst)$/i, '');
  // 单层扩展名
  stem = stem.replace(/\.[^./\\]+$/, '');
  if (!stem) stem = path.basename(archivePath) || 'archive';
  return path.join(dir, stem);
}
