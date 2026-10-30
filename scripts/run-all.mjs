// 统一测试入口：node scripts/run-all.mjs [--skip-ui]
// 依次跑引擎层与 UI 层测试，任一失败则整体失败（CI 用）。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skipUi = process.argv.includes('--skip-ui');

/** 跑一个脚本，返回是否成功 */
function run(script, args = []) {
  return new Promise((resolve) => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`▶ ${script} ${args.join(' ')}`);
    console.log('='.repeat(60));
    const child = spawn(process.execPath, [path.join(__dirname, script), ...args], {
      stdio: 'inherit',
      env: process.env
    });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

const suites = [
  ['smoke-test.mjs', []], // 核心库：路径安全 / ZIP / TAR / GZIP / 探测
  ['engine-test.mjs', []], // 任务引擎：解压 / 压缩 / 队列 / 暂停 / 持久化 / 穿越防护
  ['format-test.mjs', []], // 格式兼容性：边界情况 + 与系统 bsdtar 互操作
  ['external-tool-test.mjs', []], // 外部工具适配：参数拼接 / 进度解析 / 退出码
  // 压测：默认 200 轮，--quick 时降到 40 轮（本地快速验证用）
  ['stability-test.mjs', [process.argv.includes('--quick') ? '40' : '200']]
];

let allOk = true;
for (const [script, args] of suites) {
  const ok = await run(script, args);
  if (!ok) allOk = false;
}

if (!skipUi) {
  // UI 测试需要应用带调试端口运行，这里自动拉起一个
  const port = 9399;
  const ud = path.join(process.env.TMPDIR || '/tmp', 'omnizip-uitest-ud');
  console.log(`\n${'='.repeat(60)}`);
  console.log(`▶ 启动应用（端口 ${port}）并运行 ui-test.mjs`);
  console.log('='.repeat(60));

  const electronBin = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
  let appProc = null;
  try {
    appProc = spawn(
      electronBin,
      ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${ud}`],
      { cwd: path.join(__dirname, '..'), stdio: 'ignore', detached: false }
    );
    // 等调试端口就绪
    const ready = await waitForPort(port, 15000);
    if (!ready) {
      console.error('❌ 应用未能启动（调试端口不可用），跳过 UI 测试');
      allOk = false;
    } else {
      const ok = await run('ui-test.mjs', [String(port)]);
      if (!ok) allOk = false;
    }
  } finally {
    if (appProc) {
      try {
        appProc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(allOk ? '✅ 全部测试通过' : '❌ 有测试失败');
console.log('='.repeat(60));
process.exit(allOk ? 0 : 1);

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      if (res.ok) {
        const list = await res.json();
        if (list.some((t) => t.type === 'page')) return true;
      }
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
