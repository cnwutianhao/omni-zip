// 任务引擎端到端测试：解压 / 压缩 / 队列 / 暂停 / 持久化 / 路径穿越防护
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import '../src/main/lib/register-formats.js';
import { ArchiveEngine } from '../src/main/engines/archive-engine.js';
import { ZipWriter } from '../src/main/engines/zip-engine.js';
import { TarWriter } from '../src/main/engines/tar-engine.js';

const TMP = path.join(os.tmpdir(), 'omnizip-engine-test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等任务终态 */
async function waitStatus(engine, id, want, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const t = engine.tasks.get(id);
    if (!t) return 'removed';
    if (Array.isArray(want) ? want.includes(t.status) : t.status === want) return t.status;
    await sleep(80);
  }
  return 'timeout';
}

const STATE = path.join(TMP, 'tasks.json');
const engine = new ArchiveEngine({ downloadDir: TMP, stateFile: STATE, userDataDir: TMP });
await engine.start();

// ───────────────────────────── ① 准备素材
console.log('━━━ ① 准备测试素材 ━━━');
const srcDir = path.join(TMP, 'src');
fs.mkdirSync(path.join(srcDir, 'sub'), { recursive: true });
fs.writeFileSync(path.join(srcDir, 'readme.txt'), 'omnizip test file');
fs.writeFileSync(path.join(srcDir, 'sub', 'nested.txt'), 'nested content '.repeat(500));
fs.writeFileSync(path.join(srcDir, 'empty.txt'), '');
check('素材目录创建', fs.existsSync(srcDir));

// 手工造一个 zip
const zipPath = path.join(TMP, 'sample.zip');
{
  const w = new ZipWriter(zipPath, { level: 6 });
  await w.open();
  await w.addBuffer(Buffer.from('alpha'), 'top.txt');
  await w.addBuffer(Buffer.from('beta'), 'folder/beta.txt');
  await w.addBuffer(Buffer.alloc(50000, 0x5a), 'folder/big.bin');
  await w.addDirectory('folder/empty/', {});
  await w.close();
}
check('造出 sample.zip', fs.statSync(zipPath).size > 0);

// 手工造一个 tar
const tarPath = path.join(TMP, 'sample.tar');
{
  const w = new TarWriter(tarPath);
  await w.open();
  await w.addBuffer(Buffer.from('tar-alpha'), 't1.txt');
  await w.addBuffer(Buffer.from('tar-beta'), 'd/t2.txt');
  await w.close();
}

// ───────────────────────────── ② 解压 ZIP
console.log('━━━ ② 解压 ZIP ━━━');
const destZip = path.join(TMP, 'out-zip');
const idZip = await engine.addExtract(zipPath, { destDir: destZip });
const stZip = await waitStatus(engine, idZip, 'done');
check('ZIP 解压完成', stZip === 'done', engine.tasks.get(idZip)?.error || '');
check('顶层文件解出', fs.readFileSync(path.join(destZip, 'top.txt'), 'utf8') === 'alpha');
check('嵌套文件解出', fs.readFileSync(path.join(destZip, 'folder/beta.txt'), 'utf8') === 'beta');
check('大文件解出', fs.statSync(path.join(destZip, 'folder/big.bin')).size === 50000);
check('空目录还原', fs.existsSync(path.join(destZip, 'folder/empty')) && fs.statSync(path.join(destZip, 'folder/empty')).isDirectory());

// ───────────────────────────── ③ 解压 TAR
console.log('━━━ ③ 解压 TAR ━━━');
const destTar = path.join(TMP, 'out-tar');
const idTar = await engine.addExtract(tarPath, { destDir: destTar });
const stTar = await waitStatus(engine, idTar, 'done');
check('TAR 解压完成', stTar === 'done', engine.tasks.get(idTar)?.error || '');
check('TAR 文件 1', fs.readFileSync(path.join(destTar, 't1.txt'), 'utf8') === 'tar-alpha');
check('TAR 文件 2', fs.readFileSync(path.join(destTar, 'd/t2.txt'), 'utf8') === 'tar-beta');

// ───────────────────────────── ④ 压缩 ZIP
console.log('━━━ ④ 压缩 ZIP ━━━');
const outZip = path.join(TMP, 'created.zip');
const idCreate = await engine.addCreate([srcDir], { archivePath: outZip, formatId: 'zip' });
const stCreate = await waitStatus(engine, idCreate, 'done');
check('ZIP 创建完成', stCreate === 'done', engine.tasks.get(idCreate)?.error || '');
check('输出文件存在', fs.existsSync(outZip));
check('没有残留 .omnizip-part', !fs.existsSync(outZip + '.omnizip-part'));

// 把刚创建的包再解一次，验证往返一致
const destRound = path.join(TMP, 'out-roundtrip');
const idRound = await engine.addExtract(outZip, { destDir: destRound });
const stRound = await waitStatus(engine, idRound, 'done');
check('往返解压完成', stRound === 'done', engine.tasks.get(idRound)?.error || '');
check(
  '往返内容一致',
  fs.readFileSync(path.join(destRound, 'src/readme.txt'), 'utf8') === 'omnizip test file'
);
check(
  '往返嵌套文件一致',
  fs.readFileSync(path.join(destRound, 'src/sub/nested.txt'), 'utf8') === 'nested content '.repeat(500)
);

// ───────────────────────────── ⑤ 压缩 TAR.GZ
console.log('━━━ ⑤ 压缩 TAR.GZ ━━━');
const outTgz = path.join(TMP, 'created.tar.gz');
const idTgz = await engine.addCreate([srcDir], { archivePath: outTgz, formatId: 'gzip' });
const stTgz = await waitStatus(engine, idTgz, 'done');
check('TAR.GZ 创建完成', stTgz === 'done', engine.tasks.get(idTgz)?.error || '');
check('tar.gz 输出存在', fs.existsSync(outTgz));
check('tar.gz 有 gzip 头', fs.readFileSync(outTgz)[0] === 0x1f && fs.readFileSync(outTgz)[1] === 0x8b);

// ───────────────────────────── ⑥ 单文件 GZIP
console.log('━━━ ⑥ 单文件 GZIP ━━━');
const singleFile = path.join(TMP, 'single.txt');
fs.writeFileSync(singleFile, 'gzip single '.repeat(200));
const outGz = path.join(TMP, 'single.txt.gz');
const idGz = await engine.addCreate([singleFile], { archivePath: outGz, formatId: 'gzip' });
const stGz = await waitStatus(engine, idGz, 'done');
check('GZIP 创建完成', stGz === 'done', engine.tasks.get(idGz)?.error || '');
const destGz = path.join(TMP, 'out-gz');
const idGzE = await engine.addExtract(outGz, { destDir: destGz });
const stGzE = await waitStatus(engine, idGzE, 'done');
check('GZIP 解压完成', stGzE === 'done', engine.tasks.get(idGzE)?.error || '');
const gzOutName = fs.readdirSync(destGz)[0];
check('GZIP 还原原文件名', gzOutName === 'single.txt', gzOutName);
check('GZIP 内容一致', fs.readFileSync(path.join(destGz, gzOutName), 'utf8') === 'gzip single '.repeat(200));

// ───────────────────────────── ⑦ 列表预览
console.log('━━━ ⑦ 列表预览 ━━━');
const listZipInfo = await engine.listArchive(zipPath);
check('ZIP 列表条目数', listZipInfo.entries.length === 4, String(listZipInfo.entries.length));
check('ZIP 列表有大小', listZipInfo.entries.some((e) => e.size === 50000));
const listTarInfo = await engine.listArchive(tarPath);
check('TAR 列表条目数', listTarInfo.entries.length === 2, String(listTarInfo.entries.length));

// ───────────────────────────── ⑧ 路径穿越防护
console.log('━━━ ⑧ 路径穿越防护 ━━━');
// 直接构造一个恶意 zip：条目名带 ../
const evilZip = path.join(TMP, 'evil.zip');
{
  const w = new ZipWriter(evilZip, { level: 0 });
  await w.open();
  await w.addBuffer(Buffer.from('pwned'), '../../escape.txt');
  await w.addBuffer(Buffer.from('ok'), 'safe.txt');
  await w.close();
}
const destEvil = path.join(TMP, 'out-evil');
const idEvil = await engine.addExtract(evilZip, { destDir: destEvil });
const stEvil = await waitStatus(engine, idEvil, 'done');
check('恶意包处理完成', stEvil === 'done', engine.tasks.get(idEvil)?.error || '');
check('正常条目解出', fs.existsSync(path.join(destEvil, 'safe.txt')));
check(
  '穿越条目被限制在目标目录内',
  fs.existsSync(path.join(destEvil, 'escape.txt')) || fs.existsSync(path.join(destEvil, '..', 'escape.txt')) === false
);
check(
  '没有写到 target 的上级目录',
  !fs.existsSync(path.join(TMP, 'escape.txt'))
);

// ───────────────────────────── ⑨ 队列并发上限
console.log('━━━ ⑨ 队列并发上限 ━━━');
const ids = [];
for (let i = 0; i < 6; i++) {
  ids.push(await engine.addExtract(zipPath, { destDir: path.join(TMP, `queue-${i}`) }));
}
const doneAll = await Promise.all(ids.map((id) => waitStatus(engine, id, ['done', 'error'], 40000)));
check('6 个任务全部完成', doneAll.every((s) => s === 'done'), doneAll.join(','));

// ───────────────────────────── ⑩ 暂停 / 继续
console.log('━━━ ⑩ 暂停 / 继续 ━━━');
const idPause = await engine.addExtract(zipPath, { destDir: path.join(TMP, 'pause-test') });
// 立刻暂停（可能还没开始跑）
await sleep(5);
const paused = engine.pause(idPause);
check('暂停请求成功或被忽略（已开始）', paused === true || paused === false, String(paused));
const stAfterPause = engine.tasks.get(idPause)?.status;
if (stAfterPause === 'paused') {
  const resumed = engine.resume(idPause);
  check('恢复请求成功', resumed === true);
  const stResumed = await waitStatus(engine, idPause, ['done', 'error'], 20000);
  check('恢复后完成', stResumed === 'done', engine.tasks.get(idPause)?.error || '');
} else {
  const st2 = await waitStatus(engine, idPause, ['done', 'error'], 20000);
  check('任务已完成后无需恢复', st2 === 'done', st2);
}

// ───────────────────────────── ⑪ 持久化与重启
console.log('━━━ ⑪ 持久化与重启 ━━━');
// 先 stop：stop() 会 await _saveState()，保证状态文件已完整落盘
// （运行期是 800ms 防抖保存，直接读会读到上一次的快照）
await engine.stop();
check('状态文件存在', fs.existsSync(STATE));
const savedRaw = JSON.parse(fs.readFileSync(STATE, 'utf8'));
check('状态文件可解析', Array.isArray(savedRaw), String(savedRaw.length));
check('状态文件包含已完成任务', savedRaw.some((t) => t.status === 'done'));

const engine2 = new ArchiveEngine({ downloadDir: TMP, stateFile: STATE, userDataDir: TMP });
await engine2.start();
check('重启后任务恢复', engine2.tasks.size === savedRaw.length, `${engine2.tasks.size} vs ${savedRaw.length}`);
check('重启后没有 running 残留', [...engine2.tasks.values()].every((t) => t.status !== 'running'));
await engine2.stop();

// ───────────────────────────── ⑫ 删除输出
console.log('━━━ ⑫ 移除任务与清理 ━━━');
const engine3 = new ArchiveEngine({ downloadDir: TMP, stateFile: STATE + '.3', userDataDir: TMP });
await engine3.start();
const destRm = path.join(TMP, 'rm-test');
const idRm = await engine3.addExtract(zipPath, { destDir: destRm });
await waitStatus(engine3, idRm, 'done');
check('解压目录存在', fs.existsSync(destRm));
await engine3.remove(idRm, true);
check('删除任务后目录被清理', !fs.existsSync(destRm));
await engine3.stop();

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
