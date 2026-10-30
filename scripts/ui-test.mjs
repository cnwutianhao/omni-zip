/**
 * UI 自动化测试：通过 CDP 驱动运行中的 OmniZip
 *
 * 用法：
 *   # 1) 先带调试端口启动应用
 *   ./node_modules/.bin/electron . --remote-debugging-port=9333 --user-data-dir=/tmp/omnizip-ui-ud
 *   # 2) 再跑本脚本
 *   node scripts/ui-test.mjs
 *
 * 覆盖：页面无渲染异常 / 首屏渲染 / 添加任务（走真实 IPC）/ 进度与完成 /
 *       内容预览 / 新建压缩包弹窗 / 拖放区与筛选按钮存在性
 *
 * 为什么用 Node 内置 WebSocket：本项目零运行时依赖，测试脚本也不该额外装 ws。
 * Node 22+ 的 globalThis.WebSocket 已稳定，够驱动 CDP。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * 用 Node 内置 WebSocket（Node 22+ 已稳定）驱动 CDP。
 * 项目本身零运行时依赖，测试脚本也不该为了一个 WS 客户端装 ws/undici。
 */
const { WebSocket } = globalThis;

const PORT = Number(process.argv[2]) || 9333;
const TMP = path.join(os.tmpdir(), 'omnizip-ui-test');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- CDP 客户端
let ws;
let msgId = 0;
const pending = new Map();
const pageErrors = [];

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到应用页面，请确认应用已带 --remote-debugging-port 启动');
  if (!WebSocket) throw new Error('当前 Node 不支持全局 WebSocket（需要 Node 22+）');

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      pageErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  });

  await send('Runtime.enable');
  await send('Page.enable');
}

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (res.result?.exceptionDetails) {
    throw new Error(res.result.exceptionDetails.exception?.description || 'eval 失败');
  }
  return res.result?.result?.value;
}

// ---------------------------------------------------------------- 准备素材
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// 用引擎先造一个测试 zip（不走 UI，保证素材可控）
const { ZipWriter } = await import('../src/main/engines/zip-engine.js');
const sampleZip = path.join(TMP, 'ui-sample.zip');
{
  const w = new ZipWriter(sampleZip, { level: 6 });
  await w.open();
  await w.addBuffer(Buffer.from('ui test alpha'), 'a.txt');
  await w.addBuffer(Buffer.from('ui test beta'), 'dir/b.txt');
  await w.addBuffer(Buffer.alloc(300000, 0x33), 'dir/blob.bin');
  await w.close();
}

// ---------------------------------------------------------------- 开始
await connect();
console.log('━━━ ⓪ 清空历史任务 ━━━');

/**
 * 前一步必须清空任务表。
 *
 * 为什么要这步：应用会把任务持久化到 userData/tasks.json，重启后自动恢复。
 * 如果跑测时复用了同一个 --user-data-dir（run-all.mjs 就复用固定目录以节省启动时间），
 * 上一次测试留下的任务会被恢复出来，导致后面「列表应有 N 行」「计数为 N」全部对不上。
 */
const stale = await evaluate('window.zip.getState()');
const staleCount = (stale?.tasks || []).length;
for (const t of stale?.tasks || []) {
  await evaluate(`window.zip.remove(${JSON.stringify(t.id)}, true)`);
}
if (staleCount) await sleep(300);
check('历史任务已清空', true, `清除 ${staleCount} 个`);

console.log('━━━ ① 首屏渲染 ━━━');

const title = await evaluate('document.title');
check('窗口标题', title === 'OmniZip', title);

const hasApp = await evaluate("!!document.querySelector('.app')");
check('主容器存在', hasApp === true);

const dropExists = await evaluate("!!document.getElementById('dropzone')");
check('拖放区存在', dropExists === true);

const filterCount = await evaluate("document.querySelectorAll('.filter').length");
check('筛选按钮 4 个', filterCount === 4, String(filterCount));

const template = await evaluate("!!document.getElementById('row-template')");
check('行模板存在', template === true);

// 首屏不应该有 JS 异常
await sleep(400);
check('首屏无 JS 异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200));

console.log('━━━ ② 工具状态 ━━━');
const toolsLabel = await evaluate("document.getElementById('tools-label').textContent");
check('工具状态已渲染', typeof toolsLabel === 'string' && toolsLabel.length > 0, toolsLabel);

const state0 = await evaluate('window.zip.getState()');
check('能拿到主进程状态', !!state0 && Array.isArray(state0.tasks));
check('格式表非空', Array.isArray(state0.formats) && state0.formats.length >= 5, String(state0.formats?.length));
check('能力清单存在', !!state0.tools);

console.log('━━━ ③ 通过 IPC 添加解压任务 ━━━');
const destDir = path.join(TMP, 'extracted');
const addRes = await evaluate(`window.zip.addPaths(${JSON.stringify([sampleZip])})`);
check('addPaths 成功', addRes?.ok === true, JSON.stringify(addRes).slice(0, 120));

// 等任务完成（最多 15 秒）
let finalTask = null;
for (let i = 0; i < 150; i++) {
  const st = await evaluate('window.zip.getState()');
  finalTask = (st.tasks || []).find((t) => t.name === 'ui-sample.zip');
  if (finalTask && (finalTask.status === 'done' || finalTask.status === 'error')) break;
  await sleep(100);
}
check('任务出现在列表', !!finalTask, finalTask ? finalTask.status : 'not found');
check('任务完成', finalTask?.status === 'done', finalTask?.error || finalTask?.status);

console.log('━━━ ④ UI 反映任务状态 ━━━');
await sleep(600);
const rowCount = await evaluate("document.querySelectorAll('.row').length");
check('列表渲染出 1 行', rowCount === 1, String(rowCount));

const rowName = await evaluate("document.querySelector('.row .row-name')?.textContent");
check('行内显示文件名', rowName === 'ui-sample.zip', rowName);

const badge = await evaluate("document.querySelector('.row .row-badge')?.textContent");
check('行内显示已完成', badge === '已完成', badge);

const pct = await evaluate("document.querySelector('.row .ring-txt')?.textContent");
check('进度环 100%', pct === '100%', pct);

const kindText = await evaluate("document.querySelector('.row .row-kind')?.textContent");
check('显示任务类型与格式', /解压 · ZIP/.test(kindText || ''), kindText);

console.log('━━━ ⑤ 文件确实解出 ━━━');
check('解出 a.txt', fs.existsSync(path.join(destDir, 'a.txt')) || fs.existsSync(path.join(TMP, 'ui-sample', 'a.txt')));
const extractedRoot = fs.existsSync(path.join(destDir, 'a.txt')) ? destDir : path.join(TMP, 'ui-sample');
check('内容正确', fs.readFileSync(path.join(extractedRoot, 'dir/b.txt'), 'utf8') === 'ui test beta');
check('大文件完整', fs.statSync(path.join(extractedRoot, 'dir/blob.bin')).size === 300000);

console.log('━━━ ⑥ 内容预览弹窗 ━━━');
const listRes = await evaluate(`window.zip.list(${JSON.stringify(sampleZip)})`);
check('list 返回成功', listRes?.ok === true, listRes?.error || '');
check('条目数 3', listRes?.entries?.length === 3, String(listRes?.entries?.length));
check('识别 ZIP 格式', listRes?.formatId === 'zip', listRes?.formatId);

// 直接打开预览弹窗（等价于点按钮）
await evaluate(`document.getElementById('list-modal').hidden = false`);
const modalVisible = await evaluate("!document.getElementById('list-modal').hidden");
check('预览弹窗可显示', modalVisible === true);
await evaluate(`document.getElementById('list-modal').hidden = true`);

console.log('━━━ ⑦ 新建压缩包弹窗 ━━━');
await evaluate(`document.getElementById('create-btn').click()`);
await sleep(200);
const createVisible = await evaluate("!document.getElementById('create-modal').hidden");
check('新建弹窗打开', createVisible === true);

const optCount = await evaluate("document.querySelectorAll('#create-format option').length");
check('格式选项 >= 4', optCount >= 4, String(optCount));

const levelVal = await evaluate("document.getElementById('create-level').value");
check('压缩级别默认 6', levelVal === '6', levelVal);

await evaluate(`document.getElementById('create-cancel').click()`);
await sleep(150);
const createClosed = await evaluate("document.getElementById('create-modal').hidden");
check('新建弹窗关闭', createClosed === true);

console.log('━━━ ⑧ 通过弹窗状态执行压缩 ━━━');
const createdZip = path.join(TMP, 'ui-created.zip');
const createRes = await evaluate(
  `window.zip.create(${JSON.stringify([path.join(TMP, 'src-for-zip')])}, { archivePath: ${JSON.stringify(createdZip)}, formatId: 'zip', level: 6 })`
);
// 源目录还没建，预期失败
check('源不存在时报错', createRes?.ok === false, createRes?.error?.slice(0, 60) || 'no error');

fs.mkdirSync(path.join(TMP, 'src-for-zip'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'src-for-zip', 'f1.txt'), 'compress me');

const createRes2 = await evaluate(
  `window.zip.create(${JSON.stringify([path.join(TMP, 'src-for-zip')])}, { archivePath: ${JSON.stringify(createdZip)}, formatId: 'zip', level: 6 })`
);
check('创建任务成功', createRes2?.ok === true, createRes2?.error || '');

let createTask = null;
for (let i = 0; i < 100; i++) {
  const st = await evaluate('window.zip.getState()');
  createTask = (st.tasks || []).find((t) => t.kind === 'create');
  if (createTask && (createTask.status === 'done' || createTask.status === 'error')) break;
  await sleep(100);
}
check('压缩完成', createTask?.status === 'done', createTask?.error || createTask?.status);
check('输出 zip 存在', fs.existsSync(createdZip));

console.log('━━━ ⑨ 筛选与计数 ━━━');
await sleep(400);
const counts = await evaluate(`JSON.stringify({
  all: document.getElementById('c-all').textContent,
  done: document.getElementById('c-done').textContent,
  failed: document.getElementById('c-failed').textContent,
  rows: document.querySelectorAll('.row').length
})`);
const c = JSON.parse(counts);
check('全部计数为 2', c.all === '2', c.all);
check('完成计数为 2', c.done === '2', c.done);
check('失败计数为 0', c.failed === '0', c.failed);

// 切到「进行中」筛选应该看不到任务
await evaluate(`document.querySelector('.filter[data-filter="active"]').click()`);
await sleep(200);
const activeRows = await evaluate("document.querySelectorAll('.row').length");
check('进行中筛选为空', activeRows === 0, String(activeRows));

await evaluate(`document.querySelector('.filter[data-filter="all"]').click()`);
await sleep(200);
const allRows = await evaluate("document.querySelectorAll('.row').length");
check('切回全部有 2 行', allRows === 2, String(allRows));

console.log('━━━ ⑩ TAR.GZ 双层压缩 / 预览 / 解压与 setTaskDest IPC ━━━');
const createdTgz = path.join(TMP, 'ui-created.tar.gz');
const tgzCreateRes = await evaluate(
  `window.zip.create(${JSON.stringify([path.join(TMP, 'src-for-zip')])}, { archivePath: ${JSON.stringify(createdTgz)}, formatId: 'tar.gz', level: 6 })`
);
check('IPC 创建 TAR.GZ 任务成功', tgzCreateRes?.ok === true, tgzCreateRes?.error || '');

let tgzCreateTask = null;
for (let i = 0; i < 100; i++) {
  const st = await evaluate('window.zip.getState()');
  tgzCreateTask = (st.tasks || []).find((t) => t.id === tgzCreateRes.id);
  if (tgzCreateTask && (tgzCreateTask.status === 'done' || tgzCreateTask.status === 'error')) break;
  await sleep(100);
}
check('TAR.GZ 压缩完成且标识为 TAR.GZ', tgzCreateTask?.status === 'done' && tgzCreateTask?.formatName === 'TAR.GZ', tgzCreateTask?.formatName);

// 通过 UI 按钮打开 TAR.GZ 预览弹窗
const tgzListRes = await evaluate(`window.zip.list(${JSON.stringify(createdTgz)})`);
check('IPC list TAR.GZ 返回内层文件', tgzListRes?.ok === true && tgzListRes?.formatName === 'TAR.GZ' && tgzListRes.entries.some((e) => e.name.endsWith('f1.txt')));

// 添加 TAR.GZ 解压任务并验证解出内层文件
const tgzAddRes = await evaluate(`window.zip.addPaths(${JSON.stringify([createdTgz])})`);
check('IPC 添加 TAR.GZ 解压任务成功', tgzAddRes?.ok === true);
let tgzExtTask = null;
for (let i = 0; i < 100; i++) {
  const st = await evaluate('window.zip.getState()');
  tgzExtTask = (st.tasks || []).find((t) => t.id === tgzAddRes.ids?.[0]);
  if (tgzExtTask && (tgzExtTask.status === 'done' || tgzExtTask.status === 'error')) break;
  await sleep(100);
}
check('TAR.GZ 解压完成', tgzExtTask?.status === 'done', tgzExtTask?.error || '');
check('TAR.GZ 实际解出内层 f1.txt', fs.existsSync(path.join(tgzExtTask.destDir, 'src-for-zip/f1.txt')));

// 验证 setTaskDest IPC
const setDestRes = await evaluate(`window.zip.setTaskDest(${JSON.stringify(tgzExtTask.id)}, ${JSON.stringify(path.join(TMP, 'custom-dest'))})`);
check('IPC setTaskDest 成功', setDestRes?.ok === true);

console.log('━━━ ⑪ 清理与异常检查 ━━━');
// 移除创建的任务（删掉生成的 zip）
const stFinal = await evaluate('window.zip.getState()');
for (const t of stFinal.tasks || []) {
  if (t.kind === 'create') await evaluate(`window.zip.remove(${JSON.stringify(t.id)}, true)`);
}
await sleep(200);
check('删除输出后文件消失', !fs.existsSync(createdZip));

check('全程无 JS 异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
if (ws) ws.close();
process.exit(fail ? 1 : 0);
