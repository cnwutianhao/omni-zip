# AGENTS.md — OmniZip 开发约定

> 本文件供 AI 编码助手（Copilot / Claude 等）和人类协作者阅读，定义项目结构、约定与工作流。

## 项目概览

**OmniZip** — 跨平台全能解压缩工具（ZIP/TAR/GZIP 内置引擎 + 可选外部 7-Zip），Electron。

- 运行时：Node.js ≥ 22（测试脚本用内置 WebSocket），Electron 33
- 平台：macOS / Windows / Linux
- 语言：纯 JavaScript（ESM，`"type": "module"`），无 TypeScript、无构建步骤
- **运行时零依赖**：`dependencies` 为空，解压能力全部自己实现或调用系统程序

## 依赖与安装（改依赖前必读）

- **不要在 `dependencies` 里加任何包**。本项目的核心卖点是零依赖：ZIP/TAR/GZIP
  用 Node 内置 `zlib` + 自己写的解析器，其余格式调系统 7-Zip。
  加一个 npm 包就等于把「装完即用」变成「npm install 才行」。
- `.npmrc` 的 `electron_mirror` / `electron_builder_binaries_mirror` 不能删：国内直连 GitHub 会 `ECONNRESET`。
  npm 11 会对这两个非标准键打 `Unknown project config` 警告，属预期行为。
- `.npmrc` 的 `cache` 用 `~` 展开，不要改回绝对路径（mac 上写死的 `/Users/...` 在 Linux 会 EACCES）。
- **npm 11 会拦截 install 脚本**：装完 Electron 若提示 `install scripts not yet covered`，
  需执行 `npm install-scripts approve electron`，否则 `node_modules/electron/dist` 是空的。

## 目录结构

```
src/
├── main/               # Electron 主进程
│   ├── main.js         # 入口：窗口、IPC、菜单、单实例、命令行/拖放
│   ├── engines/        # 解压/压缩引擎（纯 Node，不依赖 Electron）
│   │   ├── archive-engine.js  # 任务引擎：队列/进度/暂停/持久化（与 omni-down 同构）
│   │   ├── zip-engine.js      # ZIP 读写
│   │   ├── tar-engine.js      # TAR 读写
│   │   └── stream-engine.js   # GZIP 单文件流
│   └── lib/            # 无状态工具库
│       ├── format-registry.js  # 格式注册表
│       ├── register-formats.js # 显式注册（import 即生效）
│       ├── external-tool.js    # 外部程序探测与调用
│       ├── paths.js            # 路径安全（最重要）
│       └── crc32.js            # CRC-32
├── preload/
│   └── preload.cjs     # contextBridge 白名单（唯一 .cjs，因主项目是 ESM）
└── renderer/           # 无框架原生 DOM
```

## 核心约定

### 1. 路径安全是硬红线

**所有写盘操作必须经过 `lib/paths.js`**：

```js
const rel = sanitizeEntryName(entry.name);   // 净化：去 ..、去盘符、去绝对路径
if (!rel) continue;                          // null = 必须跳过
const abs = safeJoin(dest, rel);             // 二次校验：必须严格位于 dest 之下
if (!abs) continue;
```

- 绝不允许 `path.join(dest, entry.name)` 直接用压缩包里的名字
- `sanitizeEntryName` 丢弃 `..` 而不是"回退一级"（回退会被嵌套穿越绕过）
- 符号链接可以做，但**不跟随**它去写文件（否则等于给攻击者一个写任意路径的跳板）
- 新增任何解压后端，都要过这两个函数。测试 `engine-test.mjs` 的 ⑧ 段会验证这一点

### 2. 三个后端的分派规则

| 格式 | 后端 | 特点 |
|---|---|---|
| zip / tar / gzip | `builtin` | 可精确报进度、可中断、零依赖 |
| 其余（7z/rar/bz2/xz/iso/wim…） | `external` | 只能拿百分比、暂停 = kill 进程 |

- `_pickBackendForExtract()` 决定后端，`capabilities()` 告诉 UI 有哪些工具
- 外部队列用 `pickTool()` 选择：RAR 优先 unrar → 7-Zip → bsdtar
- **绝不捆绑任何二进制**：只探测与调用用户自己装的

### 3. 任务引擎的竞态控制（照抄 omni-down 的模式）

- `task._run` 是运行代号：`_run()` 开始时递增，`pause` / `remove` 也递增以作废当前轮次
- 旧轮次在所有 `await` 之后必须检查 `task._run !== run` 并退出
- `finally` 里只有当前轮次才能清理，否则会关掉新一轮刚打开的资源
- `_schedule()` 里并发名额**同步预留**（`_started = true`），否则批量添加会突破 `MAX_ACTIVE`
- `_promoteQueue()` 只提升 `queued`，绝不自动拉起 `paused`（那是用户显式暂停）

### 4. 持久化必须原子 + 互斥

```js
if (this._saving) { this._dirty = true; return; }  // 并发写直接返回
await fsp.writeFile(tmp, data);                    // 先写 .tmp
await fsp.rename(tmp, this.stateFile);             // 再 rename
finally { this._saving = false; if (this._dirty) this._saveStateSoon(); }
```

- 解压任务**不能续传**，所以重启后 `running` 一律降级为 `paused`，resume 是"从头重跑"
- 新建压缩包先写 `.omnizip-part`，成功后 rename —— 中途失败绝不留下"看起来完好"的坏包

### 5. 格式注册表

- 所有格式在 `lib/register-formats.js` 里**显式**注册（不用模块自注册，顺序不可控）
- 探测规则：**签名优先，扩展名兜底**（`detectFormat`）
- 新增格式：在注册表加一条描述符 + （若要内置支持）在 `archive-engine.js` 加一个 `_extractXxx`

### 6. IPC 与渲染层

- `t:`/`z:` 前缀区分项目（本项目用 `z:`）
- 新增 IPC **必须同时改三处**：`main.js` 的 `registerIpc()`、`preload.cjs` 的白名单、`renderer.js` 的调用
- 渲染层的 `statusOf()` 是唯一状态派生入口，别在别处重复判断
- **所有来自压缩包/用户的文本一律 `textContent`**，不拼 `innerHTML`（CSP 也禁了内联脚本）
- 列表用"节点池 + 就地更新"（`nodes` Map），不要每次 `innerHTML = ''` 重建

### 7. 平台兼容

- 窗口配置按 `process.platform` 分支（mac: hiddenInset 红绿灯；win/linux: 原生标题栏）
- CSS 用 `html[data-platform]` 区分标题栏留白
- 文案用 `html[data-os]` 显示各平台系统术语（访达/资源管理器/文件管理器）
- 字体栈必须包含 Segoe UI / Microsoft YaHei（Windows）
- 不要引入 macOS 专属 API（osascript 等）；`shell.*` 是跨平台的

## 测试

所有测试直接 `node scripts/xxx.mjs`，无框架：

| 脚本 | 用途 |
|---|---|
| `smoke-test.mjs` | 核心库（路径/ZIP/TAR/GZIP/探测），32 项 |
| `engine-test.mjs` | 任务引擎端到端（含穿越防护），41 项 |
| `format-test.mjs` | 边界与互操作（与系统 bsdtar 双向验证），48 项 |
| `external-tool-test.mjs` | 外部工具适配（用假可执行脚本，不依赖真实 7-Zip），42 项 |
| `ui-test.mjs` | UI 自动化（CDP 驱动，需 `--remote-debugging-port`），41 项 |
| `run-all.mjs` | 全部串跑，自动拉起应用 |

改引擎代码的最小验证集：

```bash
node scripts/smoke-test.mjs && node scripts/engine-test.mjs && node scripts/format-test.mjs
```

- UI 测试用 Node 内置 `WebSocket`（Node 22+），**不要装 ws/undici**
- UI 测试开头必须先清空历史任务：应用会从 `userData/tasks.json` 恢复上次的列表，
  而 `run-all.mjs` 复用固定 `--user-data-dir` 以省启动时间，不清就会导致计数与行数断言全错
- 测试用的临时目录统一在 `os.tmpdir()/omnizip-*`，每个脚本开头 `rmSync` 清空
- 断言用统一的 `check(name, ok, detail)`，输出 `✅/❌` 与最终统计
- **测试必须幂等**：连跑两遍结果要完全一致（改完测试请实际连跑验证）

工具脚本（不参与回归，改动后手动跑一次确认输出正常）：

| 脚本 | 用途 |
|---|---|
| `gen-icon.mjs` | 生成 `build/icon.png`（纯 Node 绘制） |
| `gen-icon-ico.mjs` | 从 PNG 派生 Windows 多尺寸 ICO |
| `optimize-png.mjs` | 文档截图体积优化 |
| `lib/png.mjs` | 上面三个共用的 PNG 编解码/缩放库 |

> 图标这类「大面积纯色 + 渐变」的图，**关掉自适应行过滤**体积更小
> （`adaptiveFilter: false`）；截图类图像则相反，开着能降 40% 以上。

## 打包

```bash
npm run dist        # mac（本机架构，dmg）
npm run dist:win    # Windows（需在 Windows 上跑）
npm run dist:linux  # Linux（AppImage + deb + rpm）
```

### 目标矩阵（CI 全量产出）

| 平台 | 架构 | Runner | 产物 |
|---|---|---|---|
| macOS | x64 | `macos-15-intel` | `.dmg` |
| macOS | arm64 | `macos-15` | `.dmg` |
| Windows | x64 | `windows-2025` | NSIS `.exe` |
| Windows | arm64 | `windows-11-arm` | NSIS `.exe` |
| Linux | x64 | `ubuntu-22.04` | `.AppImage` + `.deb` + `.rpm` |

- 架构参数必须写独立的 `--x64` / `--arm64`，**不能写 `--mac x64`**（会被当成 target 名报错）
- `artifactName` 必须带 `${os}-${arch}`：两个 mac job 默认同名会互相覆盖
- 产出未签名：macOS 需 `xattr -cr`，Windows 触发 SmartScreen

## Git 提交规范

格式：`<type>: <一句话中文描述>`（小写 type，冒号后空格）

type：`feat` / `fix` / `perf` / `refactor` / `docs` / `test` / `chore`

示例：
```
feat: ZIP 引擎支持 ZIP64 与 Unix 权限还原
fix: 修复空状态节点遮挡任务列表的问题
test: 补充与系统 bsdtar 的双向互操作验证
```

- 一次提交只做一件事
- **提交与推送由人类执行**：AI 只给建议消息文本，不自行 `git commit` / `git push`

## 已知注意事项

- 内置引擎**不支持加密 ZIP**（Traditional / AES 都不支持）；遇到加密包会明确报错并提示装 7-Zip
- BZIP2 / XZ 不做纯 JS 实现（各需数千行解码器）；宁可让用户装 7-Zip
- ZIP 不写符号链接（需要 Info-ZIP Unix extra field，多数工具不认）；解压 TAR 时支持
- GZIP 的进度是"已写入原始字节 / 压缩包字节"的粗略估计，不做精确换算
