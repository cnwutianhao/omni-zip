// 外部工具适配层测试：不依赖真实 7-Zip，用假的可执行脚本验证参数拼接、
// 进度解析、退出码语义与取消能力。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  detectTools,
  parseSevenZipProgress,
  pickTool,
  extractWithSevenZip,
  createWithSevenZip,
  listWithSevenZip,
  extractWithTool,
  ExternalToolError
} from '../src/main/lib/external-tool.js';

const TMP = path.join(os.tmpdir(), 'omnizip-exttool-test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

/** 造一个假的 7-Zip：按 argv 输出预设内容 */
async function makeFakeTool(name, body) {
  const p = path.join(TMP, name);
  await fsp.writeFile(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

console.log('━━━ ① 进度解析 ━━━');
check('标准百分比', parseSevenZipProgress(' 45% 12 - file.txt') === 45);
check('带退格符', parseSevenZipProgress(' 30%\b\b\b') === 30);
check('100%', parseSevenZipProgress('100%') === 100);
check('0%', parseSevenZipProgress('  0%') === 0);
check('非进度行', parseSevenZipProgress('Scanning drive') === null);
check('空行', parseSevenZipProgress('') === null);
check('超过 100 被拒绝', parseSevenZipProgress('150%') === null);
check('负数被拒绝', parseSevenZipProgress('-5%') === null);

console.log('━━━ ② 工具探测结构 ━━━');
const detected = detectTools();
check('返回七个字段结构', 'sevenZip' in detected && 'unrar' in detected && 'bsdtar' in detected && Array.isArray(detected.tools));
check('tools 是数组', Array.isArray(detected.tools));
// macOS 上 bsdtar 一定存在
if (process.platform === 'darwin') {
  check('macOS 上检测到 bsdtar', !!detected.bsdtar, detected.bsdtar || 'none');
}

console.log('━━━ ③ 工具选择优先级 ━━━');
check('RAR 优先 unrar', pickTool({ unrar: '/u/unrar', sevenZip: '/u/7z', bsdtar: '/u/bsdtar' }, 'rar')?.id === 'unrar');
check('其他格式优先 7-Zip', pickTool({ unrar: '/u/unrar', sevenZip: '/u/7z', bsdtar: '/u/bsdtar' }, '7z')?.id === '7zip');
check('无 7-Zip 时 RAR 用 bsdtar', pickTool({ unrar: null, sevenZip: null, bsdtar: '/u/bsdtar' }, 'rar')?.id === 'bsdtar');
check('全无时返回 null', pickTool({ unrar: null, sevenZip: null, bsdtar: null }, 'zip') === null);

console.log('━━━ ④ 7-Zip 解压调用（假工具） ━━━');
// 假工具：把收到的参数写到文件，并输出进度
const argDump = path.join(TMP, 'args.txt');
const fakeExtract = await makeFakeTool(
  'fake7z-extract.sh',
  `echo "$@" > ${JSON.stringify(argDump)}
echo "  0%"
echo " 50%"
echo "100%"
exit 0`
);

const progressSeen = [];
{
  const handle = extractWithSevenZip({
    tool: fakeExtract,
    archive: '/tmp/a b/test.7z', // 含空格，验证不被 shell 拆开
    destDir: '/tmp/out dir',
    password: 'p@ss word',
    onProgress: (pct) => progressSeen.push(pct)
  });
  const res = await handle.promise;
  check('解压返回 ok', res.ok === true);
  const args = fs.readFileSync(argDump, 'utf8').trim();
  check('参数含 x', /\bx\b/.test(args), args);
  check('含归档路径（空格完整）', args.includes('/tmp/a b/test.7z'));
  check('含 -o 目标目录', args.includes('-o/tmp/out dir'));
  check('含 -bsp1 进度开关', args.includes('-bsp1'));
  check('含密码', args.includes('-pp@ss word'));
  check('进度回调收到 0/50/100', progressSeen.join(',') === '0,50,100', progressSeen.join(','));
}

console.log('━━━ ⑤ 退出码语义 ━━━');
{
  const warnTool = await makeFakeTool('fake7z-warn.sh', 'echo "some warning" >&2\nexit 1');
  const r = await extractWithSevenZip({ tool: warnTool, archive: 'a.7z', destDir: '/t' }).promise;
  check('退出码 1 = 成功带警告', r.ok === true && r.warnings.length > 0, JSON.stringify(r).slice(0, 80));
}
{
  const errTool = await makeFakeTool('fake7z-err.sh', 'echo "cannot open archive" >&2\nexit 2');
  let err = null;
  try {
    await extractWithSevenZip({ tool: errTool, archive: 'a.7z', destDir: '/t' }).promise;
  } catch (e) {
    err = e;
  }
  check('退出码 2 = 抛异常', err instanceof ExternalToolError, err?.message);
  check('异常带原始 stderr', err?.message?.includes('cannot open'), err?.message);
}
{
  const cancelTool = await makeFakeTool('fake7z-cancel.sh', 'exit 255');
  let err = null;
  try {
    await extractWithSevenZip({ tool: cancelTool, archive: 'a.7z', destDir: '/t' }).promise;
  } catch (e) {
    err = e;
  }
  check('退出码 255 = 已取消', err?.message === '已取消', err?.message);
}

console.log('━━━ ⑥ 7-Zip 压缩调用 ━━━');
const createArgs = path.join(TMP, 'create-args.txt');
const createCwd = path.join(TMP, 'create-cwd');
fs.mkdirSync(createCwd, { recursive: true });
// 假工具额外把 pwd 存下来，验证 cwd 确实被应用
const fakeCreate = await makeFakeTool(
  'fake7z-create.sh',
  `pwd > ${JSON.stringify(createArgs + '.pwd')}
echo "$@" > ${JSON.stringify(createArgs)}
echo "100%"
exit 0`
);
{
  const handle = createWithSevenZip({
    tool: fakeCreate,
    archive: '/tmp/out.7z',
    cwd: createCwd,
    items: ['a.txt', 'sub/b.txt'],
    level: '9',
    password: 'secret'
  });
  const res = await handle.promise;
  check('压缩返回 ok', res.ok === true);
  const args = fs.readFileSync(createArgs, 'utf8').trim();
  check('含 a 命令', /^a\b/.test(args), args.slice(0, 40));
  check('含 -mx=9', args.includes('-mx=9'));
  check('含所有条目', args.includes('a.txt') && args.includes('sub/b.txt'));
  check('含密码', args.includes('-psecret'));
  const cwdUsed = fs.readFileSync(createArgs + '.pwd', 'utf8').trim();
  // /var 与 /private/var 在 macOS 上是同一路径的两种写法，用 realpath 比较
  check('cwd 生效', fs.realpathSync(cwdUsed) === fs.realpathSync(createCwd), cwdUsed);
}

console.log('━━━ ⑦ 7-Zip 列表解析 ━━━');
const fakeList = await makeFakeTool(
  'fake7z-list.sh',
  `cat <<'EOF'
7-Zip 24.09 (arm64) : Copyright (c) 1999-2024 Igor Pavlov : 2024-11-29

Listing archive: test.7z

--
Path = test.7z
Type = 7z
Physical Size = 1234

----------
Path = a.txt
Size = 100
Packed Size = 50
Modified = 2025-01-02 03:04:05
Attributes = A
CRC = 1234ABCD
Method = LZMA2:24
Encrypted = -

Path = sub
Folder = +
Size = 0

Path = sub/b.bin
Size = 9000
Packed Size = 4000
Method = LZMA2:24
Encrypted = +
EOF`
);
{
  const entries = await listWithSevenZip(fakeList, 'test.7z');
  check('解析出 3 个条目', entries.length === 3, String(entries.length));
  check('文件名正确', entries[0].name === 'a.txt', entries[0]?.name);
  check('大小解析', entries[0].size === 100, String(entries[0]?.size));
  check('压缩后大小解析', entries[0].compressedSize === 50, String(entries[0]?.compressedSize));
  check('目录识别', entries[1].isDir === true, String(entries[1]?.isDir));
  check('加密识别', entries[2].encrypted === true, String(entries[2]?.encrypted));
  check('方法解析', entries[0].method === 'LZMA2:24', entries[0]?.method);
  check('归档自身被过滤', !entries.some((e) => e.name === 'test.7z'));
}

console.log('━━━ ⑧ 统一分派 ━━━');
{
  const fake = await makeFakeTool('fake-dispatch.sh', 'echo ok\nexit 0');
  const r1 = await extractWithTool({ toolId: '7zip', tool: fake, archive: 'a.7z', destDir: '/t' }).promise;
  check('toolId=7zip 分派成功', r1.ok === true);
  const r2 = await extractWithTool({ toolId: 'unknown', tool: fake, archive: 'a.7z', destDir: '/t' }).promise;
  check('未知 toolId 走 7zip 兜底', r2.ok === true);
}

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
