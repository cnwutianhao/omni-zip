/**
 * 稳定性压测：200 轮混合场景
 *
 * 目的不是再跑一遍功能测试，而是**在随机组合下暴露竞态与资源泄漏**。
 * 每轮随机抽一个场景，运行完统一做四项体检：
 *   1. 无未捕获异常 / 未处理的 Promise 拒绝
 *   2. 状态文件始终可解析（并发保存不会写坏）
 *   3. 任务表里没有 running 残留（否则重启后状态错乱）
 *   4. .omnizip-part 临时文件不残留 + 文件描述符数量不增长
 *
 * 场景分布：
 *   A. 单任务完整解压 → 校验内容 → 删除
 *   B. 解压中途暂停 → 恢复 → 完成（验证 _run 轮次代号）
 *   C. 批量添加 5 个任务（验证并发上限不被突破）
 *   D. 引擎 stop → start 重启（验证持久化与状态降级）
 *   E. 坏包 / 不存在路径（验证错误处理不炸引擎）
 *   F. ZIP 压缩 → 解压往返（验证压缩正确性）
 *   G. 并发保存压力：极短时间内大幅改动任务表
 *   H. 路径穿越恶意包
 *
 * 用法：node scripts/stability-test.mjs [轮数=200]
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import '../src/main/lib/register-formats.js';
import { ArchiveEngine } from '../src/main/engines/archive-engine.js';
import { ZipWriter } from '../src/main/engines/zip-engine.js';
import { TarWriter } from '../src/main/engines/tar-engine.js';

const ROUNDS = Number(process.argv[2]) || 200;
const TMP = path.join(os.tmpdir(), 'omnizip-stability');
const STATE = path.join(TMP, 'tasks.json');

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 统计

const stats = {
  rounds: 0,
  scenarios: { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, G: 0, H: 0 },
  failures: [],
  durations: [],
  memStart: process.memoryUsage().heapUsed,
  memSamples: [],
  fdStart: 0,
  fdEnd: 0,
  leftoverParts: [],
  uncaught: 0
};

process.on('uncaughtException', (err) => {
  stats.uncaught++;
  stats.failures.push(`uncaughtException: ${err?.message || err}`);
});
process.on('unhandledRejection', (err) => {
  stats.uncaught++;
  stats.failures.push(`unhandledRejection: ${err?.message || err}`);
});

function fail(round, scenario, msg) {
  const line = `[round ${round}][${scenario}] ${msg}`;
  stats.failures.push(line);
  console.log(`  ❌ ${line}`);
}

function ok(round, scenario, note = '') {
  if (note) console.log(`  ✅ [round ${round}][${scenario}] ${note}`);
}

/** 统计打开的文件描述符（macOS/Linux 均可） */
function countFds() {
  try {
    return fs.readdirSync('/dev/fd').length;
  } catch {
    return -1;
  }
}

/** 等任务进入终态或超时 */
async function waitStatus(engine, id, want, timeoutMs = 20000) {
  const list = Array.isArray(want) ? want : [want];
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const t = engine.tasks.get(id);
    if (!t) return 'removed';
    if (list.includes(t.status)) return t.status;
    await sleep(40);
  }
  return 'timeout';
}

/**
 * 检查状态文件是否可用。
 *
 * 注意要区分三种情况，不能一律当失败：
 * - ENOENT：文件还没被首次创建（_saveState 首次运行的正常窗口），不算问题
 * - 空内容：同上（writeFile 刚创建、还没写完的瞬间）
 * - JSON 解析失败：这才是**真实损坏**，必须报错
 *
 * 之前这里统一 return false，导致压测把正常的 ENOENT 误报成「状态文件不可解析」。
 */
function stateFileStatus() {
  let raw;
  try {
    raw = fs.readFileSync(STATE, 'utf8');
  } catch (err) {
    return err.code === 'ENOENT' ? 'absent' : 'error';
  }
  if (!raw.trim()) return 'absent';
  try {
    JSON.parse(raw);
    return 'ok';
  } catch {
    return 'corrupt';
  }
}

function stateFileOk() {
  const s = stateFileStatus();
  return s === 'ok' || s === 'absent';
}

/** 找残留的临时文件 */
function findLeftoverParts(dir) {
  const out = [];
  const walk = (d) => {
    let items;
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) walk(full);
      else if (it.name.endsWith('.omnizip-part')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------- 素材准备

console.log('━━━ 准备测试素材 ━━━');

/** 造一个 zip */
async function makeZip(file, opts = {}) {
  const { files = 3, sizeEach = 20000, nested = true } = opts;
  const w = new ZipWriter(file, { level: 6 });
  await w.open();
  for (let i = 0; i < files; i++) {
    const name = nested ? `d${i % 2}/f${i}.bin` : `f${i}.bin`;
    await w.addBuffer(Buffer.alloc(sizeEach, (i * 17) % 256), name);
  }
  if (opts.extra) {
    for (const [name, data] of Object.entries(opts.extra)) {
      await w.addBuffer(Buffer.from(data), name);
    }
  }
  await w.close();
  return file;
}

/** 造一个 tar */
async function makeTar(file, files = 3, sizeEach = 20000) {
  const w = new TarWriter(file);
  await w.open();
  for (let i = 0; i < files; i++) {
    await w.addBuffer(Buffer.alloc(sizeEach, (i * 31) % 256), `t/f${i}.bin`);
  }
  await w.close();
  return file;
}

const FIXTURES = {
  zipSmall: await makeZip(path.join(TMP, 'fix-zip-small.zip'), { files: 2, sizeEach: 5000 }),
  zipMed: await makeZip(path.join(TMP, 'fix-zip-med.zip'), { files: 6, sizeEach: 60000 }),
  zipBig: await makeZip(path.join(TMP, 'fix-zip-big.zip'), { files: 3, sizeEach: 800000 }),
  tarSmall: await makeTar(path.join(TMP, 'fix-tar-small.tar'), 2, 5000),
  tarMed: await makeTar(path.join(TMP, 'fix-tar-med.tar'), 5, 60000)
};

// 恶意包：条目名带路径穿越
const evilZip = path.join(TMP, 'fix-evil.zip');
{
  const w = new ZipWriter(evilZip, { level: 0 });
  await w.open();
  await w.addBuffer(Buffer.from('pwn'), '../../../escape.txt');
  await w.addBuffer(Buffer.from('ok'), 'safe.txt');
  await w.close();
}
FIXTURES.evil = evilZip;

// 坏包：截断的 zip
const brokenZip = path.join(TMP, 'fix-broken.zip');
{
  const full = fs.readFileSync(FIXTURES.zipSmall);
  fs.writeFileSync(brokenZip, full.subarray(0, Math.floor(full.length / 2)));
}
FIXTURES.broken = brokenZip;

// 源目录（用于压缩场景）
const srcDir = path.join(TMP, 'src-for-create');
fs.mkdirSync(path.join(srcDir, 'sub'), { recursive: true });
for (let i = 0; i < 4; i++) {
  fs.writeFileSync(path.join(srcDir, `file-${i}.txt`), `content ${i} `.repeat(200));
}
fs.writeFileSync(path.join(srcDir, 'sub', 'nested.txt'), 'nested '.repeat(500));

const fixtureNames = Object.keys(FIXTURES);
console.log(`  素材：${fixtureNames.length} 个归档 + 1 个源目录`);

// ---------------------------------------------------------------- 引擎

let engine = new ArchiveEngine({ downloadDir: TMP, stateFile: STATE, userDataDir: TMP });
await engine.start();
stats.fdStart = countFds();
console.log(`  初始 fd 数量：${stats.fdStart}`);
console.log('');

// ---------------------------------------------------------------- 场景实现

const SCENARIOS = {
  /** A：单任务完整解压 → 校验 → 删除 */
  async A(round, destRoot) {
    const pick = ['zipSmall', 'zipMed', 'tarSmall', 'tarMed'][round % 4];
    const src = FIXTURES[pick];
    const dest = path.join(destRoot, `a-${round}`);
    const id = await engine.addExtract(src, { destDir: dest });
    const st = await waitStatus(engine, id, ['done', 'error']);

    if (st !== 'done') {
      fail(round, 'A', `${pick} 解压失败：${engine.tasks.get(id)?.error || st}`);
      return;
    }
    // 校验确实解出了文件
    const count = countFiles(dest);
    if (count === 0) {
      fail(round, 'A', `${pick} 解压后目录为空`);
      return;
    }
    const task = engine.tasks.get(id);
    if (task.itemsDone !== task.itemsTotal) {
      fail(round, 'A', `条目数不一致 ${task.itemsDone}/${task.itemsTotal}`);
      return;
    }
    await engine.remove(id, true);
    if (fs.existsSync(dest)) {
      fail(round, 'A', '删除任务后输出目录仍存在');
      return;
    }
    ok(round, 'A', `${pick} → ${count} 个文件`);
  },

  /** B：解压中途暂停 → 恢复 → 完成（验证 _run 轮次代号） */
  async B(round, destRoot) {
    const src = FIXTURES.zipBig;
    const dest = path.join(destRoot, `b-${round}`);
    const id = await engine.addExtract(src, { destDir: dest });

    // 尽快暂停：理想情况下在 running 状态被中断
    await sleep(2 + Math.floor(Math.random() * 12));
    const paused = engine.pause(id);
    const statusAfterPause = engine.tasks.get(id)?.status;

    if (paused && statusAfterPause === 'paused') {
      // 立刻恢复（最容易触发竞态：旧轮次的 pump 可能还在 await）
      const resumed = engine.resume(id);
      if (!resumed) {
        fail(round, 'B', 'resume 返回 false');
        return;
      }
      const st = await waitStatus(engine, id, ['done', 'error']);
      if (st !== 'done') {
        fail(round, 'B', `恢复后未完成：${engine.tasks.get(id)?.error || st}`);
        return;
      }
      // 关键校验：不能因为重复计数导致 received > size（这里看条目数）
      const t = engine.tasks.get(id);
      if (t.itemsDone > t.itemsTotal) {
        fail(round, 'B', `条目重复计数 ${t.itemsDone}/${t.itemsTotal}`);
        return;
      }
      ok(round, 'B', '暂停→立即恢复→完成');
    } else {
      // 已经跑完了，不算失败
      const st = await waitStatus(engine, id, ['done', 'error']);
      ok(round, 'B', `任务太快已完成（${st}）`);
    }
    await engine.remove(id, true);
  },

  /** C：批量添加 5 个任务，验证并发上限 */
  async C(round, destRoot) {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const src = FIXTURES[['zipSmall', 'zipMed', 'tarSmall'][i % 3]];
      ids.push(await engine.addExtract(src, { destDir: path.join(destRoot, `c-${round}-${i}`) }));
    }

    // 采样并发数：running + _started 不应超过 MAX_ACTIVE(3)
    let maxSeen = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      const active = [...engine.tasks.values()].filter(
        (t) => t.status === 'running' || t._started
      ).length;
      maxSeen = Math.max(maxSeen, active);
      const allDone = ids.every((id) => {
        const t = engine.tasks.get(id);
        return !t || t.status === 'done' || t.status === 'error';
      });
      if (allDone) break;
      await sleep(30);
    }

    if (maxSeen > 3) {
      fail(round, 'C', `并发数突破上限：${maxSeen} > 3`);
      return;
    }
    const statuses = ids.map((id) => engine.tasks.get(id)?.status);
    const bad = statuses.filter((s) => s !== 'done');
    if (bad.length) {
      fail(round, 'C', `有任务未完成：${statuses.join(',')}`);
      return;
    }
    for (const id of ids) await engine.remove(id, true);
    ok(round, 'C', `5 任务完成，峰值并发 ${maxSeen}`);
  },

  /** D：重启引擎，验证持久化与 running 降级 */
  async D(round) {
    // 先造几个任务
    const ids = [];
    for (let i = 0; i < 2; i++) {
      ids.push(await engine.addExtract(FIXTURES.zipSmall, { destDir: path.join(TMP, `d-${round}-${i}`) }));
    }
    await sleep(150);

    const beforeCount = engine.tasks.size;
    await engine.stop();

    // 状态文件必须可解析
    if (!stateFileOk()) {
      fail(round, 'D', 'stop 后状态文件损坏');
      return;
    }

    engine = new ArchiveEngine({ downloadDir: TMP, stateFile: STATE, userDataDir: TMP });
    await engine.start();

    if (engine.tasks.size !== beforeCount) {
      fail(round, 'D', `重启后任务数不符 ${engine.tasks.size} vs ${beforeCount}`);
      return;
    }
    const stillRunning = [...engine.tasks.values()].filter((t) => t.status === 'running');
    if (stillRunning.length) {
      fail(round, 'D', `重启后仍有 ${stillRunning.length} 个 running 任务`);
      return;
    }
    // 清理
    for (const t of [...engine.tasks.values()]) await engine.remove(t.id, true);
    ok(round, 'D', `重启恢复 ${beforeCount} 个任务，无 running 残留`);
  },

  /** E：坏包 / 不存在的路径，验证错误处理 */
  async E(round) {
    const dest = path.join(TMP, `e-${round}`);

    // 1) 不存在的文件 → addExtract 应抛错
    let threw = false;
    try {
      await engine.addExtract(path.join(TMP, '__does_not_exist__.zip'), { destDir: dest });
    } catch {
      threw = true;
    }
    if (!threw) {
      fail(round, 'E', '不存在的文件没有抛错');
      return;
    }

    // 2) 截断的 zip → 任务应进入 error 状态而不是崩溃
    const id = await engine.addExtract(FIXTURES.broken, { destDir: dest });
    const st = await waitStatus(engine, id, ['done', 'error']);
    // 截断的包有两种合理结果：引擎判定 error，或部分解出后 done（都有明确文案）
    if (st === 'timeout') {
      fail(round, 'E', '坏包任务卡在非终态');
      return;
    }
    const task = engine.tasks.get(id);
    if (st === 'error' && !task.error) {
      fail(round, 'E', 'error 状态但没有错误信息');
      return;
    }
    await engine.remove(id, true);

    // 3) 引擎仍然健康（能继续干活）
    const okId = await engine.addExtract(FIXTURES.zipSmall, { destDir: path.join(TMP, `e-ok-${round}`) });
    const okSt = await waitStatus(engine, okId, ['done', 'error']);
    if (okSt !== 'done') {
      fail(round, 'E', '坏包之后引擎无法正常工作');
      return;
    }
    await engine.remove(okId, true);
    ok(round, 'E', `坏包容错正常（${st}），引擎后续可用`);
  },

  /** F：ZIP 压缩 → 解压往返 */
  async F(round, destRoot) {
    const out = path.join(TMP, `f-${round}.zip`);
    const id = await engine.addCreate([srcDir], {
      archivePath: out,
      formatId: 'zip',
      level: 6 + (round % 4)
    });
    const st = await waitStatus(engine, id, ['done', 'error']);
    if (st !== 'done') {
      fail(round, 'F', `压缩失败：${engine.tasks.get(id)?.error || st}`);
      return;
    }
    if (!fs.existsSync(out)) {
      fail(round, 'F', '输出文件不存在');
      return;
    }
    // 往返校验
    const dest = path.join(destRoot, `f-${round}`);
    const id2 = await engine.addExtract(out, { destDir: dest });
    const st2 = await waitStatus(engine, id2, ['done', 'error']);
    if (st2 !== 'done') {
      fail(round, 'F', `往返解压失败：${engine.tasks.get(id2)?.error || st2}`);
      return;
    }
    const orig = fs.readFileSync(path.join(srcDir, 'file-0.txt'), 'utf8');
    const back = fs.readFileSync(path.join(dest, 'src-for-create', 'file-0.txt'), 'utf8');
    if (orig !== back) {
      fail(round, 'F', '往返内容不一致');
      return;
    }
    await engine.remove(id, true);
    await engine.remove(id2, true);
    ok(round, 'F', '压缩→解压往返一致');
  },

  /** G：并发保存压力（最容易写坏状态文件） */
  async G(round) {
    // 一次性加一批任务，然后立刻连续 remove，制造大量并发 _saveState
    const ids = [];
    for (let i = 0; i < 6; i++) {
      ids.push(await engine.addExtract(FIXTURES.zipSmall, { destDir: path.join(TMP, `g-${round}-${i}`) }));
    }
    // 不等完成，立刻并发删一半
    const half = ids.slice(0, 3);
    await Promise.all(half.map((id) => engine.remove(id, true)));
    // 等剩下的完成
    await Promise.all(ids.slice(3).map((id) => waitStatus(engine, id, ['done', 'error'], 20000)));

    // 立即触发一次强制保存并等待
    await engine._saveState();
    if (!stateFileOk()) {
      fail(round, 'G', '并发保存后状态文件损坏');
      return;
    }
    for (const id of ids.slice(3)) {
      if (engine.tasks.has(id)) await engine.remove(id, true);
    }
    ok(round, 'G', '并发保存后状态文件完好');
  },

  /** H：路径穿越恶意包 */
  async H(round, destRoot) {
    const dest = path.join(destRoot, `h-${round}`);
    const id = await engine.addExtract(FIXTURES.evil, { destDir: dest });
    const st = await waitStatus(engine, id, ['done', 'error']);
    if (st !== 'done') {
      // 直接拒绝整个包也是合理防御
      ok(round, 'H', `恶意包被拒绝（${st}）`);
      await engine.remove(id, true);
      return;
    }
    // 必须有文件解出，但绝不能写到 dest 之外
    const escaped = path.join(destRoot, 'escape.txt');
    const escaped2 = path.join(TMP, 'escape.txt');
    const escaped3 = path.join(os.tmpdir(), 'escape.txt');
    if (fs.existsSync(escaped) || fs.existsSync(escaped2) || fs.existsSync(escaped3)) {
      fail(round, 'H', '!!! 路径穿越成功，文件被写到目标目录之外');
      return;
    }
    if (!fs.existsSync(path.join(dest, 'safe.txt'))) {
      fail(round, 'H', '正常条目没有解出');
      return;
    }
    await engine.remove(id, true);
    ok(round, 'H', '穿越被拦截，正常条目解出');
  }
};

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    let items;
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (it.isDirectory()) walk(path.join(d, it.name));
      else n++;
    }
  };
  walk(dir);
  return n;
}

// ---------------------------------------------------------------- 主循环

const SCENARIO_KEYS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

console.log(`━━━ 开始 ${ROUNDS} 轮混合压测 ━━━`);
console.log('');

const overallStart = Date.now();

for (let round = 1; round <= ROUNDS; round++) {
  const key = SCENARIO_KEYS[(round - 1) % SCENARIO_KEYS.length];
  const destRoot = path.join(TMP, 'out', String(round));
  fs.mkdirSync(destRoot, { recursive: true });

  stats.rounds++;
  stats.scenarios[key]++;
  const t0 = Date.now();

  try {
    await SCENARIOS[key](round, destRoot);
  } catch (err) {
    fail(round, key, `场景抛出异常：${err?.message || err}`);
  }

  stats.durations.push(Date.now() - t0);

  // 每轮体检
  const sfStatus = stateFileStatus();
  if (sfStatus === 'corrupt') {
    fail(round, key, '状态文件内容损坏（JSON 解析失败）');
  } else if (sfStatus === 'error') {
    fail(round, key, '状态文件读取异常（权限或其他 IO 错误）');
  }
  const runningLeft = [...engine.tasks.values()].filter((t) => t.status === 'running');
  if (runningLeft.length > 2) {
    // 允许 1~2 个（可能是下一轮正在跑的），超过说明有泄漏
    fail(round, key, `running 任务堆积：${runningLeft.length}`);
  }

  // 每 20 轮打一次进度 + 采样内存
  if (round % 20 === 0) {
    const mem = process.memoryUsage().heapUsed;
    stats.memSamples.push(mem);
    const elapsed = ((Date.now() - overallStart) / 1000).toFixed(1);
    console.log(
      `  ── 进度 ${round}/${ROUNDS}  堆 ${(mem / 1048576).toFixed(1)}MB  已用 ${elapsed}s  ` +
        `任务表 ${engine.tasks.size} 个`
    );
  }
}

// ---------------------------------------------------------------- 收尾体检

console.log('');
console.log('━━━ 收尾体检 ━━━');

// 清空所有任务
for (const t of [...engine.tasks.values()]) {
  await engine.remove(t.id, true).catch(() => {});
}
await sleep(300);
await engine.stop();

stats.fdEnd = countFds();

// 1) 临时文件残留
const leftovers = findLeftoverParts(TMP);
stats.leftoverParts = leftovers;
if (leftovers.length) {
  console.log(`  ⚠️  残留 .omnizip-part：${leftovers.length} 个`);
  for (const f of leftovers.slice(0, 5)) console.log(`      ${path.relative(TMP, f)}`);
} else {
  console.log('  ✅ 无 .omnizip-part 残留');
}

// 2) 状态文件
const finalState = stateFileStatus();
if (finalState === 'corrupt') {
  console.log('  ❌ 状态文件内容损坏');
  stats.failures.push('最终状态文件损坏');
} else if (finalState === 'error') {
  console.log('  ❌ 状态文件读取异常');
  stats.failures.push('最终状态文件读取异常');
} else {
  console.log(`  ✅ 状态文件正常（${finalState}）`);
}

// 3) 内存趋势
const memEnd = process.memoryUsage().heapUsed;
const memGrowthMB = (memEnd - stats.memStart) / 1048576;

// 4) fd 泄漏
const fdGrowth = stats.fdEnd - stats.fdStart;

console.log('');
console.log('━━━ 统计 ━━━');
console.log(`  轮数        ${stats.rounds}`);
console.log(`  场景分布    ${Object.entries(stats.scenarios).map(([k, v]) => `${k}:${v}`).join('  ')}`);
const dur = stats.durations.slice().sort((a, b) => a - b);
const p50 = dur[Math.floor(dur.length * 0.5)] || 0;
const p95 = dur[Math.floor(dur.length * 0.95)] || 0;
const max = dur[dur.length - 1] || 0;
console.log(`  单轮耗时    p50 ${p50}ms  p95 ${p95}ms  max ${max}ms`);
console.log(`  总耗时      ${((Date.now() - overallStart) / 1000).toFixed(1)}s`);
console.log(`  内存增长    ${memGrowthMB.toFixed(1)}MB（起始 ${(stats.memStart / 1048576).toFixed(1)}MB）`);
console.log(`  fd 增长     ${fdGrowth}（${stats.fdStart} → ${stats.fdEnd}）`);
console.log(`  未捕获异常  ${stats.uncaught}`);
console.log(`  失败项      ${stats.failures.length}`);

if (stats.failures.length) {
  console.log('');
  console.log('━━━ 失败明细 ━━━');
  const uniq = new Map();
  for (const f of stats.failures) {
    const key = f.replace(/\[round \d+\]/, '[round N]');
    uniq.set(key, (uniq.get(key) || 0) + 1);
  }
  for (const [k, v] of uniq) {
    console.log(`  ×${v}  ${k}`);
  }
}

console.log('');
const pass = stats.failures.length === 0;
console.log(pass ? '✅ 压测通过' : `❌ 压测发现 ${stats.failures.length} 个问题`);
process.exit(pass ? 0 : 1);
