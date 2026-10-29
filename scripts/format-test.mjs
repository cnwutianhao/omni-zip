// 格式兼容性与边界测试
// 重点验证：跨实现互操作（用系统 bsdtar / tar 交叉验证）、ZIP64、大文件、
// 特殊文件名、空文件、坏包容错、格式探测优先级。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import '../src/main/lib/register-formats.js';
import { ZipReader, ZipWriter } from '../src/main/engines/zip-engine.js';
import { TarReader, TarWriter } from '../src/main/engines/tar-engine.js';
import { detectFormat, describeFormats, findByExtension } from '../src/main/lib/format-registry.js';
import { sanitizeEntryName, uniqueName, portableName } from '../src/main/lib/paths.js';

const TMP = path.join(os.tmpdir(), 'omnizip-format-test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

/** 是否有某个系统命令 */
function hasCmd(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

console.log('━━━ ① 格式注册表完整性 ━━━');
const formats = describeFormats();
check('至少 10 种格式', formats.length >= 10, String(formats.length));
check('zip 可创建', formats.find((f) => f.id === 'zip')?.canCreate === true);
check('tar 可创建', formats.find((f) => f.id === 'tar')?.canCreate === true);
check('gzip 可创建', formats.find((f) => f.id === 'gzip')?.canCreate === true);
check('7z 标记为外部', formats.find((f) => f.id === '7z')?.external === true);
check('rar 不支持创建', formats.find((f) => f.id === 'rar')?.canCreate === false);
check('无重复 id', new Set(formats.map((f) => f.id)).size === formats.length);

console.log('━━━ ② 复合扩展名优先级 ━━━');
check('.tar.gz → gzip', findByExtension('a.tar.gz')?.id === 'gzip');
check('.tgz → gzip', findByExtension('a.tgz')?.id === 'gzip');
check('.tar → tar', findByExtension('a.tar')?.id === 'tar');
check('.zip → zip', findByExtension('a.zip')?.id === 'zip');
check('.docx → zip', findByExtension('a.docx')?.id === 'zip');
check('.jar → zip', findByExtension('a.jar')?.id === 'zip');
check('未知扩展名 → null', findByExtension('a.unknownext') === null);

console.log('━━━ ③ 文件名可移植性 ━━━');
check('Windows 保留名加前缀', portableName('CON') === '_CON', portableName('CON'));
check('COM1 加前缀', portableName('COM1') === '_COM1');
check('普通名不变', portableName('normal.txt') === 'normal.txt');
check('CON.txt 加前缀', portableName('CON.txt') === '_CON.txt');
check('NUL 加前缀', portableName('NUL') === '_NUL');

console.log('━━━ ④ 重名分配 ━━━');
const taken = new Set();
const d = path.join(TMP, 'unique');
fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(d, 'exists.txt'), 'x');
check('已存在文件自动改名', uniqueName(d, 'exists.txt', taken) === 'exists (1).txt', uniqueName(d, 'exists.txt', new Set()));
const t2 = new Set();
const n1 = uniqueName(d, 'new.txt', t2);
const n2 = uniqueName(d, 'new.txt', t2);
check('同一批次内不重复', n1 === 'new.txt' && n2 === 'new (1).txt', `${n1} / ${n2}`);

console.log('━━━ ⑤ ZIP 边界情况 ━━━');
const emptyZip = path.join(TMP, 'empty.zip');
{
  const w = new ZipWriter(emptyZip);
  await w.open();
  await w.close();
}
const er = await ZipReader.open(emptyZip);
check('空 ZIP 可读', er.entries.length === 0);
await er.close();

const zeroZip = path.join(TMP, 'zero.zip');
{
  const w = new ZipWriter(zeroZip);
  await w.open();
  await w.addBuffer(Buffer.alloc(0), 'zero.txt');
  await w.close();
}
const zr = await ZipReader.open(zeroZip);
check('零字节文件条目', zr.entries.length === 1 && zr.entries[0].size === 0);
check('零字节内容可读', (await zr.readEntry(zr.entries[0])).length === 0);
await zr.close();

// STORE 模式（不压缩）
const storeZip = path.join(TMP, 'store.zip');
{
  const w = new ZipWriter(storeZip, { compress: false });
  await w.open();
  await w.addBuffer(Buffer.from('stored data'), 's.txt');
  await w.close();
}
const sr = await ZipReader.open(storeZip);
check('STORE 方法写入', sr.entries[0].method === 0, String(sr.entries[0].method));
check('STORE 内容正确', (await sr.readEntry(sr.entries[0])).toString() === 'stored data');
await sr.close();

// 特殊文件名
const specialZip = path.join(TMP, 'special.zip');
{
  const w = new ZipWriter(specialZip);
  await w.open();
  const names = ['a b.txt', 'a(b).txt', "quote'.txt", 'amp&.txt', 'дзынь.txt', '日本語.txt'];
  for (const n of names) await w.addBuffer(Buffer.from(n), n);
  await w.close();
}
const spr = await ZipReader.open(specialZip);
const backNames = spr.entries.map((e) => e.name);
check('空格/括号/引号文件名', ['a b.txt', 'a(b).txt', "quote'.txt"].every((n) => backNames.includes(n)), backNames.join(','));
check('CJK / 西里尔文件名', backNames.includes('日本語.txt') && backNames.includes('дзынь.txt'));
await spr.close();

console.log('━━━ ⑥ TAR 边界情况 ━━━');
const emptyTar = path.join(TMP, 'empty.tar');
{
  const w = new TarWriter(emptyTar);
  await w.open();
  await w.close();
}
const etr = await TarReader.open(emptyTar);
check('空 TAR 可读', etr.entries.length === 0);
await etr.close();

// 大文件（>8GB 需要 base-256，这里用 5MB 验证流式路径）
const bigTar = path.join(TMP, 'big.tar');
const bigSrc = path.join(TMP, 'big-src.bin');
fs.writeFileSync(bigSrc, Buffer.alloc(5 * 1024 * 1024, 0x77));
{
  const w = new TarWriter(bigTar);
  await w.open();
  await w.addFile(bigSrc, 'big.bin');
  await w.close();
}
const btr = await TarReader.open(bigTar);
check('大文件 TAR 条目', btr.entries[0].size === 5 * 1024 * 1024, String(btr.entries[0].size));
const bigOut = path.join(TMP, 'big-out.bin');
await btr.extractEntryTo(btr.entries[0], bigOut);
check('大文件 TAR 解出', fs.statSync(bigOut).size === 5 * 1024 * 1024);
await btr.close();

// 目录条目（结尾 /）
const dirTar = path.join(TMP, 'dir.tar');
{
  const w = new TarWriter(dirTar);
  await w.open();
  await w.addDirectory('only-dir');
  await w.close();
}
const dtr = await TarReader.open(dirTar);
check('目录条目识别', dtr.entries[0].isDir === true && dtr.entries[0].name.endsWith('/'), dtr.entries[0].name);
await dtr.close();

console.log('━━━ ⑦ 与系统 bsdtar 互操作 ━━━');
if (hasCmd('bsdtar')) {
  // 我们写的 TAR → bsdtar 能读
  check('bsdtar 可解我们写的 TAR', (() => {
    try {
      const out = execFileSync('bsdtar', ['-tf', bigTar], { encoding: 'utf8' });
      return out.includes('big.bin');
    } catch {
      return false;
    }
  })());

  // bsdtar 写的 TAR → 我们能读
  const bsTar = path.join(TMP, 'from-bsdtar.tar');
  const bsSrcDir = path.join(TMP, 'bs-src');
  fs.mkdirSync(bsSrcDir, { recursive: true });
  fs.writeFileSync(path.join(bsSrcDir, 'x.txt'), 'from bsdtar');
  try {
    execFileSync('bsdtar', ['-cf', bsTar, '-C', bsSrcDir, 'x.txt'], { stdio: 'ignore' });
    const r = await TarReader.open(bsTar);
    const entry = r.entries.find((e) => e.name === 'x.txt');
    check('可读 bsdtar 生成的 TAR', !!entry, r.entries.map((e) => e.name).join(','));
    if (entry) {
      const data = await r.readEntry(entry);
      check('bsdtar TAR 内容正确', data.toString() === 'from bsdtar');
    }
    await r.close();
  } catch (err) {
    check('可读 bsdtar 生成的 TAR', false, err.message);
  }

  // 我们写的 ZIP → bsdtar 能读
  check('bsdtar 可解我们写的 ZIP', (() => {
    try {
      const out = execFileSync('bsdtar', ['-tf', specialZip], { encoding: 'utf8' });
      return out.length > 0;
    } catch {
      return false;
    }
  })());

  // bsdtar 写的 ZIP → 我们能读
  const bsZip = path.join(TMP, 'from-bsdtar.zip');
  try {
    execFileSync('bsdtar', ['-a', '-cf', bsZip, '-C', bsSrcDir, 'x.txt'], { stdio: 'ignore' });
    const r = await ZipReader.open(bsZip);
    const entry = r.entries.find((e) => e.name === 'x.txt');
    check('可读 bsdtar 生成的 ZIP', !!entry, r.entries.map((e) => e.name).join(','));
    if (entry) {
      check('bsdtar ZIP 内容正确', (await r.readEntry(entry)).toString() === 'from bsdtar');
      check('bsdtar ZIP 方法为 DEFLATE', entry.method === 8, String(entry.method));
    }
    await r.close();
  } catch (err) {
    check('可读 bsdtar 生成的 ZIP', false, err.message);
  }
} else {
  console.log('  ⏭  未安装 bsdtar，跳过互操作测试');
}

console.log('━━━ ⑧ 坏包容错 ━━━');
// 截断的 ZIP
const truncZip = path.join(TMP, 'truncated.zip');
{
  const w = new ZipWriter(truncZip);
  await w.open();
  await w.addBuffer(Buffer.alloc(10000, 0x11), 'x.bin');
  await w.close();
}
const full = fs.readFileSync(truncZip);
fs.writeFileSync(truncZip, full.subarray(0, Math.floor(full.length / 2)));
let truncatedError = null;
try {
  const r = await ZipReader.open(truncZip);
  await r.close();
} catch (err) {
  truncatedError = err.message;
}
check('截断 ZIP 抛出明确错误', !!truncatedError, truncatedError || 'no error');

// 完全不是压缩包
const notArc = path.join(TMP, 'not-archive.zip');
fs.writeFileSync(notArc, Buffer.from('this is just plain text, not a zip'));
let notArcError = null;
try {
  const r = await ZipReader.open(notArc);
  await r.close();
} catch (err) {
  notArcError = err.message;
}
check('非压缩包抛出明确错误', !!notArcError, notArcError || 'no error');

// 格式探测：假扩展名
const fakeZip = path.join(TMP, 'fake.txt');
{
  const w = new ZipWriter(fakeZip);
  await w.open();
  await w.addBuffer(Buffer.from('real zip, fake ext'), 'a.txt');
  await w.close();
}
const headFake = Buffer.alloc(64);
const fdF = fs.openSync(fakeZip, 'r');
fs.readSync(fdF, headFake, 0, 64, 0);
fs.closeSync(fdF);
check('签名优先于扩展名', detectFormat('a.txt', headFake)?.id === 'zip', detectFormat('a.txt', headFake)?.id);

console.log('━━━ ⑨ 路径净化补充 ━━━');
check('URL 编码的 .. 不被解码（不做 URL 处理）', sanitizeEntryName('%2e%2e/x') === '%2e%2e/x');
check('深层合法路径保留', sanitizeEntryName('a/b/c/d.txt') === 'a/b/c/d.txt');
check('多个连续斜杠合并', sanitizeEntryName('a//b///c.txt') === 'a/b/c.txt');
check('前导 ./ 去掉', sanitizeEntryName('./a/b.txt') === 'a/b.txt');
check('混合穿越 a/../../b', sanitizeEntryName('a/../../b.txt') === 'a/b.txt', sanitizeEntryName('a/../../b.txt'));
check('结尾斜杠的目录条目保留语义', sanitizeEntryName('dir/') === 'dir', sanitizeEntryName('dir/'));

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
