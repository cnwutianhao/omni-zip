import { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// 必须在任何使用格式表的模块之前 import：它负责把格式注册进注册表
import './lib/register-formats.js';
import { describeFormats } from './lib/register-formats.js';
import { ArchiveEngine } from './engines/archive-engine.js';
import { defaultExtractDir } from './lib/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 开发模式下的窗口图标。
 * - Windows：多尺寸 .ico（由 scripts/gen-icon-ico.mjs 生成）
 * - Linux：窗口管理器通常只认 PNG
 * - macOS：不使用（Dock 图标来自 .app 包）
 * 打包后 build/ 不进 asar，fs.existsSync 守卫会跳过。
 */
const ICON_PATH =
  process.platform === 'win32'
    ? path.join(__dirname, '../../build/icon.ico')
    : path.join(__dirname, '../../build/icon.png');

/** @type {BrowserWindow|null} */
let win = null;
/** @type {ArchiveEngine|null} */
let engine = null;
let settingsFile = '';
/** @type {{ lastOutputDir?: string, defaultExtractMode?: string }} */
let settings = {};

/** 聚合状态（模块级，供 IPC 与事件转发共用，与 omni-down 的 mergedState 同一思路） */
function mergedState() {
  if (!engine) {
    return {
      tasks: [],
      stats: { count: 0, active: 0, queued: 0, done: 0, error: 0, paused: 0 },
      formats: describeFormats(),
      tools: { tools: [], hasSevenZip: false, hasUnrar: false, hasBsdtar: false },
      outputDir: settings.lastOutputDir || app.getPath('downloads')
    };
  }
  const caps = engine.capabilities();
  return {
    tasks: engine.serializeAll(),
    stats: engine.stats(),
    formats: describeFormats(),
    tools: caps,
    outputDir: settings.lastOutputDir || engine.workDir
  };
}

/** 向界面推一条提示（窗口已关闭时静默丢弃） */
function notify(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('z:notice', payload);
}

function loadSettings() {
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    settings = {};
  }
  return settings;
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
  } catch {
    /* 落盘失败不影响使用 */
  }
}

/**
 * 菜单设置。
 *
 * 与 omni-down 完全同一套判断：macOS 必须保留菜单（它承载 ⌘C/⌘V/⌘Q 等标准快捷键），
 * Windows/Linux 直接移除默认英文调试菜单。
 */
function setupMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }

  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: `关于 ${app.name}` },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${app.name}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出 ${app.name}` }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '文件',
      submenu: [
        {
          label: '打开压缩包…',
          accelerator: 'CmdOrCtrl+O',
          click: () => win?.webContents.send('z:menu', { action: 'open' })
        },
        {
          label: '新建压缩包…',
          accelerator: 'CmdOrCtrl+N',
          click: () => win?.webContents.send('z:menu', { action: 'create' })
        }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'close', label: '关闭窗口' }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const isMac = process.platform === 'darwin';

  win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 820,
    minHeight: 540,
    show: false,
    ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 20 } } : {}),
    ...(!isMac && fs.existsSync(ICON_PATH) ? { icon: ICON_PATH } : {}),
    backgroundColor: '#0a0d14',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.once('ready-to-show', () => win.show());

  // 渲染进程的 console 转发到主进程，便于排查
  win.webContents.on('console-message', (...args) => {
    const details = args[1];
    if (details && typeof details === 'object' && 'message' in details) {
      console.log(`[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
    } else {
      console.log(`[renderer] ${args[2]} (${args[4]}:${args[3]})`);
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => console.error('[renderer 崩溃]', d));
  win.webContents.on('preload-error', (_e, p, err) => console.error('[preload 错误]', p, err));

  // 外部链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    win = null;
  });
}

/**
 * 把拖入的路径解析成「可解压的压缩包列表」。
 * 拖入目录时，扫描其中所有能识别格式的文件（只扫一层，避免误伤大目录树）。
 */
async function collectArchivesFromPaths(paths) {
  const out = [];
  for (const p of paths) {
    const st = await fsp.stat(p).catch(() => null);
    if (!st) continue;
    if (st.isFile()) {
      out.push(p);
    } else if (st.isDirectory()) {
      const names = await fsp.readdir(p).catch(() => []);
      for (const n of names) {
        const full = path.join(p, n);
        const s = await fsp.stat(full).catch(() => null);
        if (s?.isFile()) out.push(full);
      }
    }
  }
  return out;
}

function registerIpc() {
  ipcMain.handle('z:get-state', () => mergedState());

  // ---- 选择一个或多个压缩包并加入任务 ----
  ipcMain.handle('z:pick-archive', async () => {
    const formats = describeFormats();
    const exts = new Set();
    for (const f of formats) for (const e of f.extensions) exts.add(e);

    const res = await dialog.showOpenDialog(win, {
      title: '选择压缩包',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '所有支持的压缩包', extensions: [...exts].sort() },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return addArchives(res.filePaths);
  });

  // ---- 拖放 / 命令行传入的路径 ----
  ipcMain.handle('z:add-paths', async (_e, paths) => {
    const list = Array.isArray(paths) ? paths : [paths];
    const archives = await collectArchivesFromPaths(list.filter(Boolean));
    if (!archives.length) return { ok: false, error: '没有找到可解压的文件' };
    return addArchives(archives);
  });

  // ---- 通用的「添加若干压缩包」 ----
  async function addArchives(paths) {
    const ids = [];
    const errors = [];
    for (const p of paths) {
      try {
        const id = await engine.addExtract(p);
        ids.push(id);
      } catch (err) {
        errors.push(`${path.basename(p)}：${err.message}`);
      }
    }
    if (!ids.length) return { ok: false, error: errors[0] || '添加失败' };
    return { ok: true, added: ids.length, ids, error: errors.length ? errors.join('；') : null };
  }

  // ---- 选择输出目录（解压用）----
  ipcMain.handle('z:choose-dir', async (_e, initial) => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择解压目标目录',
      defaultPath: initial || settings.lastOutputDir || app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
    settings.lastOutputDir = res.filePaths[0];
    saveSettings();
    return { ok: true, dir: res.filePaths[0] };
  });

  // ---- 改某个任务的目标目录（未开始时有效）----
  ipcMain.handle('z:set-task-dest', (_e, id, dir) => {
    if (!engine) return { ok: false, error: '引擎未就绪' };
    return engine.setTaskDest(id, dir);
  });

  // ---- 解压 ----
  ipcMain.handle('z:pause', (_e, id) => ({ ok: engine.pause(String(id)) }));
  ipcMain.handle('z:resume', (_e, id) => ({ ok: engine.resume(String(id)) }));
  ipcMain.handle('z:remove', async (_e, id, deleteOutput) => {
    await engine.remove(String(id), !!deleteOutput);
    return { ok: true };
  });

  // ---- 预览压缩包内容 ----
  ipcMain.handle('z:list', async (_e, archivePath, password) => {
    try {
      const res = await engine.listArchive(archivePath, password);
      return { ok: true, ...res };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ---- 新建压缩包：选源文件（文件或目录，可多选）----
  ipcMain.handle('z:pick-sources', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择要压缩的文件或文件夹',
      properties: ['openFile', 'openDirectory', 'multiSelections']
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, paths: res.filePaths };
  });

  // ---- 新建压缩包：选输出位置 ----
  ipcMain.handle('z:choose-save-path', async (_e, defaultName) => {
    const name = String(defaultName || 'archive.zip');
    const res = await dialog.showSaveDialog(win, {
      title: '保存压缩包',
      defaultPath: path.join(settings.lastOutputDir || app.getPath('downloads'), name),
      filters: [
        { name: 'ZIP', extensions: ['zip'] },
        { name: 'TAR', extensions: ['tar'] },
        { name: 'TAR.GZ', extensions: ['tar.gz', 'tgz'] },
        { name: 'GZIP', extensions: ['gz'] },
        { name: '7Z（需 7-Zip）', extensions: ['7z'] }
      ]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    settings.lastOutputDir = path.dirname(res.filePath);
    saveSettings();
    return { ok: true, path: res.filePath };
  });

  // ---- 新建压缩包：真正创建任务 ----
  ipcMain.handle('z:create', async (_e, sourcePaths, opts) => {
    try {
      const id = await engine.addCreate(sourcePaths, opts || {});
      return { ok: true, id };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ---- 打开/定位 ----
  ipcMain.handle('z:open-path', async (_e, p) => {
    const target = String(p || '');
    const err = await shell.openPath(target);
    return { ok: !err, error: err || null };
  });

  ipcMain.handle('z:reveal', async (_e, p) => {
    const target = String(p || '');
    shell.showItemInFolder(target);
    return { ok: true };
  });

  // ---- 外部工具 ----
  ipcMain.handle('z:refresh-tools', () => {
    const tools = engine.refreshTools();
    return { ok: true, ...engine.capabilities(), tools: tools.tools };
  });

  ipcMain.handle('z:get-capabilities', () => ({ ok: true, ...engine.capabilities() }));

  // ---- 复制路径到剪贴板 ----
  ipcMain.handle('z:copy', (_e, text) => {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  });

  // ---- 默认解压目录预览（UI 显示用）----
  ipcMain.handle('z:default-dest', (_e, archivePath) => {
    const base = settings.lastOutputDir || path.dirname(String(archivePath));
    return { ok: true, dir: defaultExtractDir(String(archivePath), base) };
  });
}

/** 从命令行参数中取出待打开的压缩包（支持 `omnizip a.zip` 与 `open -a OmniZip b.zip`） */
function archivePathsFromArgv(argv) {
  const out = [];
  for (const a of argv.slice(1)) {
    if (!a || a.startsWith('-')) continue;
    if (path.resolve(a) === path.resolve(process.execPath)) continue;
    try {
      if (fs.statSync(a).isFile()) out.push(path.resolve(a));
    } catch {
      /* 忽略不存在的参数 */
    }
  }
  return out;
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  fs.mkdirSync(userData, { recursive: true });
  settingsFile = path.join(userData, 'settings.json');
  loadSettings();

  engine = new ArchiveEngine({
    downloadDir: settings.lastOutputDir || app.getPath('downloads'),
    stateFile: path.join(userData, 'tasks.json'),
    userDataDir: userData
  });

  const forward = () => {
    if (win && !win.isDestroyed()) win.webContents.send('z:update', mergedState());
  };
  engine.on('update', forward);
  engine.on('notice', notify);

  try {
    await engine.start();
  } catch (err) {
    dialog.showErrorBox('引擎启动失败', String(err?.stack || err));
  }

  registerIpc();
  setupMenu();
  createWindow();

  // 命令行/双击打开：等窗口就绪后再加任务
  const initial = archivePathsFromArgv(process.argv);
  if (initial.length) {
    win.webContents.once('did-finish-load', async () => {
      for (const p of initial) {
        try {
          await engine.addExtract(p);
        } catch (err) {
          notify({ type: 'error', text: `${path.basename(p)}：${err.message}` });
        }
      }
    });
  }

  // macOS 通过 Finder 打开文件时走 open-file 事件，不是 argv
  app.on('open-file', async (event, filePath) => {
    event.preventDefault();
    try {
      await engine.addExtract(filePath);
    } catch (err) {
      notify({ type: 'error', text: `${path.basename(filePath)}：${err.message}` });
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', async (event) => {
  if (engine && engine.started) {
    event.preventDefault();
    const stopping = engine;
    engine = null;
    await stopping.stop().catch(() => {});
    app.quit();
  }
});

// 只在单实例时运行：否则重复双击压缩包会开多个窗口、抢同一份 tasks.json
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', async (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    for (const p of archivePathsFromArgv(argv)) {
      try {
        await engine?.addExtract(p);
      } catch (err) {
        notify({ type: 'error', text: `${path.basename(p)}：${err.message}` });
      }
    }
  });
}
