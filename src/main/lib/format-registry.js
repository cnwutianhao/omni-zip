/**
 * 格式注册表 —— 全项目唯一的「支持哪些格式」的事实源。
 *
 * 设计直接借鉴 7-Zip 的 REGISTER_ARC_* 思路，但用 JS 的方式表达：
 * - 每个引擎模块导出自己的 handler 描述符（signature + extensions + factory）
 * - 这里按「签名优先、扩展名兜底」的规则匹配（对应 7-Zip 的 kFindSignature 标志）
 * - UI 只从 describeFormats() 拿能力清单，不硬编码格式名
 *
 * 与 7-Zip 的差异：7-Zip 用 CArcInfo 结构体 + 静态对象构造注册；
 * JS 没有可靠的模块级"自动注册"顺序，所以改为**显式数组**，
 * 好处是可以一眼看完所有格式，坏处是加格式要记得来这里登记（这是有意的取舍）。
 */

/** @typedef {{
 *   id: string,
 *   name: string,
 *   extensions: string[],
 *   signature?: { offset?: number, bytes: number[], mask?: number[] },
 *   canExtract: boolean,
 *   canCreate: boolean,
 *   multiVolume?: boolean,
 *   description: string,
 *   createHandler?: () => object,
 *   createWriter?: () => object,
 *   external?: boolean,   // 依赖外部可执行文件
 * }} FormatDescriptor */

/** @type {FormatDescriptor[]} 注册顺序 = 匹配顺序（签名越独特越靠前） */
const registry = [];

/**
 * 注册一个格式。
 * @param {FormatDescriptor} desc
 */
export function registerFormat(desc) {
  if (registry.some((f) => f.id === desc.id)) {
    throw new Error(`格式重复注册：${desc.id}`);
  }
  registry.push(desc);
}

/** 全部格式描述（只读副本，避免调用方改到注册表） */
export function describeFormats() {
  return registry.map((f) => ({
    id: f.id,
    name: f.name,
    extensions: [...f.extensions],
    canExtract: !!f.canExtract,
    canCreate: !!f.canCreate,
    description: f.description,
    external: !!f.external
  }));
}

/**
 * 按扩展名查找格式（用于「新建压缩包」时的格式选择，以及打开时的初筛）。
 * 复合扩展名（tar.gz）优先于单层（gz）。
 *
 * @param {string} filePath
 * @returns {FormatDescriptor|null}
 */
export function findByExtension(filePath) {
  const lower = filePath.toLowerCase();
  // 按扩展名字符串长度倒序，保证 .tar.gz 先于 .gz 命中
  const candidates = [];
  for (const f of registry) {
    for (const ext of f.extensions) {
      if (lower.endsWith('.' + ext)) candidates.push({ f, len: ext.length });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.len - a.len);
  return candidates[0].f;
}

/**
 * 按文件头字节识别格式。
 *
 * @param {Buffer} head 文件开头（建议至少 512 字节；不足也能工作）
 * @returns {FormatDescriptor|null}
 */
export function findBySignature(head) {
  if (!head || !head.length) return null;
  for (const f of registry) {
    const sig = f.signature;
    if (!sig) continue;
    const off = sig.offset || 0;
    if (head.length < off + sig.bytes.length) continue;
    let ok = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      const expect = sig.mask ? sig.bytes[i] & sig.mask[i] : sig.bytes[i];
      const actual = sig.mask ? head[off + i] & sig.mask[i] : head[off + i];
      if (expect !== actual) {
        ok = false;
        break;
      }
    }
    if (ok) return f;
  }
  return null;
}

/**
 * 组合探测：先看签名（更可靠），签名不认识再看扩展名。
 *
 * 为什么不反过来：把一个 .txt 改名成 .zip 时，扩展名会说谎，
 * 而签名不会。反过来把 .zip 改名成 .dat 时，签名仍能救回来。
 *
 * @param {string} filePath
 * @param {Buffer} head
 * @returns {FormatDescriptor|null}
 */
export function detectFormat(filePath, head) {
  return findBySignature(head) || findByExtension(filePath);
}

/** 清空注册表（仅供测试重载用） */
export function _resetRegistry() {
  registry.length = 0;
}
