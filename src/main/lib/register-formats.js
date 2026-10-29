/**
 * 格式注册入口
 *
 * 所有格式描述在这里汇总注册，**必须在使用前 import 一次**。
 * archive-engine.js 与 main.js 都从这里取，避免"谁先 import 谁生效"的隐式顺序依赖。
 *
 * 为什么用显式注册而不是各模块自注册：
 * JS 的模块副作用顺序在打包/裁剪时不可预测，显式列表能保证「加载了这个文件 = 格式表已完整」，
 * 而且阅读者一眼就能看到全部支持范围（测试里也靠这个断言）。
 */
import {
  registerFormat,
  describeFormats,
  findByExtension,
  findBySignature,
  detectFormat,
  _resetRegistry
} from './format-registry.js';
import { zipFormat } from '../engines/zip-engine.js';
import { tarFormat } from '../engines/tar-engine.js';
import { gzipFormat, bzip2Format, xzFormat } from '../engines/stream-engine.js';

/**
 * 只能由外部工具处理的格式。
 * canExtract 标 true 表示"装了 7-Zip 就能解"，具体能不能用由 detectTools() 决定。
 */
const EXTERNAL_FORMATS = [
  {
    id: '7z',
    name: '7Z',
    extensions: ['7z'],
    signature: { offset: 0, bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
    canExtract: true,
    canCreate: true,
    external: true,
    description: '7-Zip 原生格式（LZMA/LZMA2/PPMd/BCJ2，支持 AES-256）'
  },
  {
    id: 'rar',
    name: 'RAR',
    extensions: ['rar', 'r00', 'r01'],
    signature: { offset: 0, bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] },
    canExtract: true,
    canCreate: false,
    external: true,
    description: 'RAR / RAR5 归档（需 unrar 或 7-Zip）'
  },
  {
    id: 'zstd',
    name: 'ZSTD',
    extensions: ['zst', 'tzst'],
    signature: { offset: 0, bytes: [0x28, 0xb5, 0x2f, 0xfd] },
    canExtract: true,
    canCreate: true,
    external: true,
    description: 'Zstandard 单文件压缩（需 7-Zip）'
  },
  {
    id: 'lzma',
    name: 'LZMA',
    extensions: ['lzma'],
    signature: { offset: 0, bytes: [0x5d, 0x00, 0x00] },
    canExtract: true,
    canCreate: false,
    external: true,
    description: 'LZMA 裸流（需 7-Zip）'
  },
  {
    id: 'iso',
    name: 'ISO',
    extensions: ['iso'],
    // ISO9660 的签名在 0x8001 处，超出探测窗口，只能靠扩展名
    canExtract: true,
    canCreate: false,
    external: true,
    description: 'ISO 9660 光盘镜像（需 7-Zip）'
  },
  {
    id: 'cab',
    name: 'CAB',
    extensions: ['cab'],
    signature: { offset: 0, bytes: [0x4d, 0x53, 0x43, 0x46] },
    canExtract: true,
    canCreate: false,
    external: true,
    description: 'Microsoft Cabinet（需 7-Zip）'
  },
  {
    id: 'wim',
    name: 'WIM',
    extensions: ['wim', 'swm', 'esd'],
    signature: { offset: 0, bytes: [0x4d, 0x53, 0x57, 0x49, 0x4d, 0x00, 0x00, 0x00] },
    canExtract: true,
    canCreate: false,
    external: true,
    description: 'Windows Imaging Format（需 7-Zip）'
  }
];

/**
 * 注册全部格式。幂等：重复调用无副作用。
 * 测试需要重建注册表时传 { reset: true }。
 * @param {{ reset?: boolean }} [opts]
 */
export function registerAllFormats(opts = {}) {
  if (opts.reset) _resetRegistry();

  // 幂等检查：已经有 zip 说明注册过
  if (describeFormats().some((f) => f.id === 'zip')) return;

  registerFormat(zipFormat);
  registerFormat(tarFormat);
  registerFormat(gzipFormat);
  registerFormat(bzip2Format);
  registerFormat(xzFormat);
  for (const f of EXTERNAL_FORMATS) registerFormat(f);
}

// 首次 import 即完成注册：调用方不必记得手动调
registerAllFormats();

export { describeFormats, findByExtension, findBySignature, detectFormat };
