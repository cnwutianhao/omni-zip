// 最小的引擎自检：不依赖 Electron，直接 node 跑
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import '../src/main/lib/register-formats.js';
import { ZipReader, ZipWriter } from '../src/main/engines/zip-engine.js';
import { TarReader, TarWriter } from '../src/main/engines/tar-engine.js';
import { gunzipTo, gzipFrom } from '../src/main/engines/stream-engine.js';
import { sanitizeEntryName, safeJoin, defaultExtractDir } from '../src/main/lib/paths.js';
import { detectFormat } from '../src/main/lib/format-registry.js';

const TMP = path.join(os.tmpdir(), 'omnizip-smoke');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

console.log('━━━ ① 路径安全 ━━━');
check('sanitize: 去掉 ..', sanitizeEntryName('../../etc/passwd') === 'etc/passwd');
check('sanitize: 去掉盘符', sanitizeEntryName('C:\\Windows\\x.dll') === 'Windows/x.dll');
check('sanitize: 去掉绝对路径', sanitizeEntryName('/root/a.txt') === 'root/a.txt');
check('sanitize: 反斜杠转正斜杠', sanitizeEntryName('a\\b\\c.txt') === 'a/b/c.txt');
check('sanitize: 全穿越返回 null', sanitizeEntryName('../..') === null);
check('sanitize: 空名返回 null', sanitizeEntryName('') === null);
check('safeJoin 正常拼接', safeJoin('/tmp/x', 'a/b.txt') === '/tmp/x/a/b.txt');
check('safeJoin 拒绝越界', safeJoin('/tmp/x', '../y') === null);
const dd = defaultExtractDir('/tmp/foo.tar.gz');
check('defaultExtractDir 处理复合扩展名', dd === '/tmp/foo', dd);

console.log('━━━ ② ZIP 写入 / 读取 ━━━');
const zipPath = path.join(TMP, 'test.zip');
const w = new ZipWriter(zipPath, { level: 6 });
await w.open();
await w.addBuffer(Buffer.from('hello omnizip'), 'a/hello.txt', { mode: 0o644 });
await w.addBuffer(Buffer.from('中文内容测试'.repeat(100)), 'a/b/中文.txt');
await w.addDirectory('empty-dir/', {});
const bigBuf = Buffer.alloc(1024 * 200, 0x42);
await w.addBuffer(bigBuf, 'big.bin');
const wres = await w.close();
check('写入条目数', wres.entries === 4, String(wres.entries));

const zr = await ZipReader.open(zipPath);
check('读回条目数', zr.entries.length === 4, String(zr.entries.length));
const hello = zr.entries.find((e) => e.name === 'a/hello.txt');
check('找到 hello.txt', !!hello);
const helloData = await zr.readEntry(hello);
check('解压内容正确', helloData.toString() === 'hello omnizip', helloData.toString());
const cn = zr.entries.find((e) => e.name.includes('中文'));
check('中文文件名正确', !!cn, cn?.name);
const cnData = await zr.readEntry(cn);
check('中文内容正确', cnData.toString('utf8') === '中文内容测试'.repeat(100));
const big = zr.entries.find((e) => e.name === 'big.bin');
const bigData = await zr.readEntry(big);
check('大文件 DEFLATE 正确', bigData.length === bigBuf.length && bigData.equals(bigBuf), `${bigData.length}`);
check('目录条目识别', zr.entries.find((e) => e.name === 'empty-dir/').isDir === true);
check('Unix 权限还原', hello.unixMode === 0o644, String(hello.unixMode?.toString(8)));
await zr.close();

console.log('━━━ ③ TAR 写入 / 读取 ━━━');
const tarPath = path.join(TMP, 'test.tar');
const tw = new TarWriter(tarPath);
await tw.open();
await tw.addBuffer(Buffer.from('tar content'), 'x/y.txt', { mode: 0o600 });
await tw.addDirectory('dir-only/');
// 超长路径触发 GNU LongLink
const longName = 'p/'.repeat(80) + 'long.txt';
await tw.addBuffer(Buffer.from('long name file'), longName);
const tlong = 'target.txt';
await tw.addSymlink('link.txt', tlong);
const tres = await tw.close();
check('TAR 写入完成', tres.entries === 4, String(tres.entries));

const tr = await TarReader.open(tarPath);
check('TAR 读回条目数', tr.entries.length === 4, String(tr.entries.length));
const ty = tr.entries.find((e) => e.name === 'x/y.txt');
check('TAR 找到 y.txt', !!ty, ty?.name);
const tyData = await tr.readEntry(ty);
check('TAR 内容正确', tyData.toString() === 'tar content');
const lng = tr.entries.find((e) => e.name.endsWith('long.txt'));
check('TAR 长路径（GNU LongLink）', lng?.name === longName, lng?.name?.slice(0, 20) + '…len=' + lng?.name?.length);
const link = tr.entries.find((e) => e.name === 'link.txt');
check('TAR 符号链接', link?.isSymlink === true && link.linkName === tlong, link?.linkName);
await tr.close();

console.log('━━━ ④ GZIP ━━━');
const srcFile = path.join(TMP, 'plain.txt');
fs.writeFileSync(srcFile, 'gzip test content '.repeat(1000));
const gzPath = path.join(TMP, 'plain.txt.gz');
await gzipFrom(srcFile, gzPath, { level: 6 });
check('生成 .gz', fs.existsSync(gzPath));
const outFile = path.join(TMP, 'plain-out.txt');
await gunzipTo(gzPath, outFile);
check('gunzip 内容一致', fs.readFileSync(outFile, 'utf8') === fs.readFileSync(srcFile, 'utf8'));

console.log('━━━ ⑤ 格式探测 ━━━');
const headZip = Buffer.alloc(64);
fs.openSync(zipPath, 'r') && fs.readSync(fs.openSync(zipPath, 'r'), headZip, 0, 64, 0);
check('签名识别 zip', detectFormat(zipPath, headZip)?.id === 'zip');
const headTar = Buffer.alloc(600);
const tfd = fs.openSync(tarPath, 'r');
fs.readSync(tfd, headTar, 0, 600, 0);
fs.closeSync(tfd);
check('签名识别 tar', detectFormat(tarPath, headTar)?.id === 'tar');
const gzHead = Buffer.alloc(16);
const gfd = fs.openSync(gzPath, 'r');
fs.readSync(gfd, gzHead, 0, 16, 0);
fs.closeSync(gfd);
check('签名识别 gzip', detectFormat(gzPath, gzHead)?.id === 'gzip');
check('扩展名兜底（伪造头）', detectFormat('/x/a.7z', Buffer.from([1, 2, 3]))?.id === '7z');

console.log('━━━ ⑥ 流式解压到文件 ━━━');
const zr2 = await ZipReader.open(zipPath);
const e2 = zr2.entries.find((e) => e.name === 'big.bin');
const outBig = path.join(TMP, 'out-big.bin');
await zr2.extractEntryTo(e2, outBig);
check('extractEntryTo 文件大小', fs.statSync(outBig).size === bigBuf.length);
check('extractEntryTo 内容一致', fs.readFileSync(outBig).equals(bigBuf));
await zr2.close();

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
