const api = window.zip;

const RING_LEN = 2 * Math.PI * 15.5; // ≈ 97.4

const el = {
  list: document.getElementById('list'),
  empty: document.getElementById('empty'),
  dropzone: document.getElementById('dropzone'),
  pickBtn: document.getElementById('pick-btn'),
  dirBtn: document.getElementById('dir-btn'),
  dirText: document.getElementById('dir-text'),
  formatsNote: document.getElementById('formats-note'),
  statusText: document.getElementById('status-text'),
  statusHint: document.getElementById('status-hint'),
  toasts: document.getElementById('toasts'),

  gsCount: document.getElementById('gs-count'),
  gsActive: document.getElementById('gs-active'),
  gsActiveWrap: document.getElementById('gs-active-wrap'),
  cAll: document.getElementById('c-all'),
  cActive: document.getElementById('c-active'),
  cDone: document.getElementById('c-done'),
  cFailed: document.getElementById('c-failed'),

  toolsBtn: document.getElementById('tools-btn'),
  toolsLabel: document.getElementById('tools-label'),
  toolsModal: document.getElementById('tools-modal'),
  toolsList: document.getElementById('tools-list'),
  toolsClose: document.getElementById('tools-close'),
  toolsRefresh: document.getElementById('tools-refresh'),

  createBtn: document.getElementById('create-btn'),
  createModal: document.getElementById('create-modal'),
  createPick: document.getElementById('create-pick'),
  createCount: document.getElementById('create-count'),
  createSrcList: document.getElementById('create-src-list'),
  createFormat: document.getElementById('create-format'),
  createLevel: document.getElementById('create-level'),
  createLevelText: document.getElementById('create-level-text'),
  createPath: document.getElementById('create-path'),
  createBrowse: document.getElementById('create-browse'),
  createCancel: document.getElementById('create-cancel'),
  createStart: document.getElementById('create-start'),

  listModal: document.getElementById('list-modal'),
  listTitle: document.getElementById('list-title'),
  listMeta: document.getElementById('list-meta'),
  entries: document.getElementById('entries'),
  listClose: document.getElementById('list-close'),

  tpl: document.getElementById('row-template')
};

const state = {
  tasks: [],
  stats: {},
  formats: [],
  tools: { tools: [] },
  outputDir: '',
  filter: 'all'
};

/** id -> { root, refs, data } */
const nodes = new Map();
/** 新建压缩包弹窗的临时状态 */
let createDraft = { sources: [], savePath: '' };

// ---------------------------------------------------------------- 工具函数

function fmtBytes(n) {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2)} ${u[i]}`;
}

function fmtSpeed(n) {
  return n > 0 ? `${fmtBytes(n)}/s` : '—';
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

/** 系统术语（platform.js 写入 html[data-os]） */
const OS = document.documentElement.dataset.os || 'linux';
const OS_TERMS = {
  mac: { reveal: '在访达中显示', fileManager: '访达' },
  win: { reveal: '在资源管理器中显示', fileManager: '资源管理器' },
  linux: { reveal: '在文件管理器中显示', fileManager: '文件管理器' }
};
const terms = OS_TERMS[OS] || OS_TERMS.linux;

/**
 * 长路径中间省略：保留开头与结尾，中间用 … 替换。
 *
 * 为什么不用 CSS 的 text-overflow: ellipsis：它只会截掉结尾，
 * 而路径的关键信息恰恰在**末尾**（目录名）。例如
 *   /Users/wutianhao/Downloads/OmniZip
 * 用 CSS 截断会变成 /Users/wutianhao/Downl…，用户看不出到底输出到哪个目录。
 *
 * @param {string} p 路径
 * @param {number} max 最大字符数
 */
function middleEllipsis(p, max = 28) {
  const s = String(p || '');
  if (s.length <= max) return s;
  // 保留末尾更多：最后一个路径段通常最重要
  const tail = Math.ceil((max - 1) * 0.62);
  const head = max - 1 - tail;
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

let toastId = 0;
function toast(text, type = 'info', ms = 3600) {
  const id = ++toastId;
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.dataset.id = String(id);
  node.textContent = text;
  el.toasts.appendChild(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 220);
  }, ms);
}

function closeMenus() {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
}

// ---------------------------------------------------------------- 状态派生

/**
 * 把后端的 status 归一成 UI 的 5 个状态。
 * 后端状态：queued | running | paused | done | error
 * UI 状态：  active | paused | done | error | queued
 */
function statusOf(t) {
  if (t.status === 'done') return 'done';
  if (t.status === 'error') return 'error';
  if (t.status === 'paused') return 'paused';
  if (t.status === 'queued') return 'queued';
  return 'active';
}

function isActive(t) {
  const s = statusOf(t);
  return s === 'active' || s === 'queued';
}

function visible(t) {
  if (state.filter === 'active') return isActive(t);
  if (state.filter === 'done') return t.done;
  if (state.filter === 'failed') return t.status === 'error';
  return true;
}

const BADGE_TEXT = {
  done: '已完成',
  error: '失败',
  paused: '已暂停',
  queued: '排队中',
  active: '进行中'
};

// ---------------------------------------------------------------- 行创建

function createRow(t) {
  const root = el.tpl.content.firstElementChild.cloneNode(true);
  const refs = {
    ringFg: root.querySelector('.ring-fg'),
    ringTxt: root.querySelector('.ring-txt'),
    name: root.querySelector('.row-name'),
    badge: root.querySelector('.row-badge'),
    kind: root.querySelector('.row-kind'),
    barFill: root.querySelector('.bar-fill'),
    size: root.querySelector('.m-size'),
    items: root.querySelector('.m-items'),
    speed: root.querySelector('.m-speed'),
    state: root.querySelector('.m-state'),
    toggle: root.querySelector('.act-toggle'),
    listBtn: root.querySelector('.act-list'),
    open: root.querySelector('.act-open'),
    more: root.querySelector('.act-more')
  };
  refs.ringFg.style.strokeDasharray = String(RING_LEN);

  const taskOf = () => nodes.get(root.dataset.id)?.data;

  // 暂停 / 继续
  refs.toggle.addEventListener('click', async () => {
    const cur = taskOf();
    if (!cur) return;
    if (cur.status === 'paused') {
      const res = await api.resume(cur.id);
      if (!res.ok) toast('无法继续该任务', 'warn');
    } else if (cur.status === 'running' || cur.status === 'queued') {
      const res = await api.pause(cur.id);
      if (!res.ok) toast('无法暂停该任务', 'warn');
    }
  });

  // 查看内容
  refs.listBtn.addEventListener('click', async () => {
    const cur = taskOf();
    if (!cur) return;
    if (cur.kind !== 'extract') {
      toast('只有解压任务可以查看内容', 'info', 2400);
      return;
    }
    await openListModal(cur.archivePath);
  });

  // 打开输出位置
  refs.open.addEventListener('click', async () => {
    const cur = taskOf();
    if (!cur) return;
    if (cur.kind === 'extract') {
      await api.openPath(cur.destDir);
    } else {
      await api.reveal(cur.archivePath);
    }
  });

  // 更多菜单
  refs.more.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeMenus();
    const cur = taskOf();
    if (!cur) return;

    const menu = document.createElement('div');
    menu.className = 'menu';
    const isDone = cur.status === 'done';
    menu.innerHTML = `
      <button data-act="dest">${cur.kind === 'extract' ? '更改解压目录…' : '复制输出路径'}</button>
      <button data-act="reveal">${terms.reveal}</button>
      <button data-act="copy">复制源路径</button>
      ${cur.kind === 'extract' ? '<button data-act="list">查看内容</button>' : ''}
      ${!isDone && cur.status !== 'error' ? '' : '<hr />'}
      ${!isDone && cur.status !== 'error' ? '' : '<button data-act="retry">重新执行</button>'}
      <hr />
      <button data-act="remove" class="danger">移除任务</button>
      <button data-act="remove-files" class="danger">移除并删除输出</button>`;
    document.body.appendChild(menu);
    const r = ev.currentTarget.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(r.left - 150, window.innerWidth - 210))}px`;
    menu.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 260)}px`;

    menu.addEventListener('click', async (e) => {
      const act = e.target.dataset?.act;
      if (!act) return;
      menu.remove();
      switch (act) {
        case 'dest': {
          if (cur.kind !== 'extract') {
            await api.copy(cur.archivePath);
            toast('已复制输出路径', 'success', 1800);
            break;
          }
          const picked = await api.chooseDir(cur.destDir);
          if (!picked.ok || picked.canceled) break;
          const res = await api.setTaskDest(cur.id, picked.dir);
          if (res.ok) toast('解压目录已更新', 'success', 2000);
          else toast(res.error || '修改失败', 'error');
          break;
        }
        case 'reveal':
          if (cur.kind === 'extract') await api.openPath(cur.destDir);
          else await api.reveal(cur.archivePath);
          break;
        case 'copy':
          await api.copy(cur.kind === 'extract' ? cur.archivePath : cur.destDir);
          toast('已复制路径', 'success', 1800);
          break;
        case 'list':
          await openListModal(cur.archivePath);
          break;
        case 'retry': {
          const res = await api.resume(cur.id);
          if (res.ok) toast('已重新开始', 'info', 2000);
          else toast('无法重新执行', 'warn');
          break;
        }
        case 'remove':
          await api.remove(cur.id, false);
          toast('已移除任务', 'info', 2000);
          break;
        case 'remove-files':
          await api.remove(cur.id, true);
          toast('已移除任务并删除输出', 'warn', 2400);
          break;
      }
    });
  });

  return { root, refs };
}

function updateRow(entry, t) {
  const { root, refs } = entry;
  const st = statusOf(t);
  const pct = Math.round((t.done ? 1 : t.progress) * 100);

  root.classList.toggle('is-done', st === 'done');
  root.classList.toggle('is-paused', st === 'paused');
  root.classList.toggle('is-error', st === 'error');
  root.classList.toggle('is-create', t.kind === 'create');

  refs.ringFg.style.strokeDashoffset = String(RING_LEN * (1 - (t.done ? 1 : t.progress)));
  refs.ringTxt.textContent = `${pct}%`;

  refs.name.textContent = t.name || '—';
  refs.name.title = t.archivePath;
  refs.badge.textContent = BADGE_TEXT[st] || st;
  refs.kind.textContent = t.kind === 'extract' ? `解压 · ${t.formatName || '?'}` : `压缩 · ${t.formatName || '?'}`;
  refs.barFill.style.width = `${(t.done ? 1 : t.progress) * 100}%`;

  // 尺寸：解压看压缩包大小，压缩看输出大小
  if (t.kind === 'extract') {
    refs.size.textContent = fmtBytes(t.archiveSize);
  } else {
    refs.size.textContent = t.archiveSize ? `→ ${fmtBytes(t.archiveSize)}` : fmtBytes(t.bytesTotal);
  }

  // 条目数
  if (t.itemsTotal > 0) {
    refs.items.textContent = `${t.itemsDone} / ${t.itemsTotal} 个文件`;
  } else if (st === 'done') {
    refs.items.textContent = '完成';
  } else {
    refs.items.textContent = '';
  }

  // 速度 / 状态描述
  if (st === 'done') {
    const dur = t.finishedAt && t.startedAt ? fmtDuration(t.finishedAt - t.startedAt) : '';
    refs.speed.textContent = dur ? `耗时 ${dur}` : '已完成';
  } else if (st === 'error') {
    refs.speed.textContent = '';
  } else if (st === 'paused') {
    refs.speed.textContent = '已暂停';
  } else if (st === 'queued') {
    refs.speed.textContent = '等待中';
  } else {
    refs.speed.textContent = fmtSpeed(t.speed);
  }

  refs.state.textContent =
    t.backend === 'external' ? '外部工具' : t.backend === 'builtin' ? '内置引擎' : '';

  // 提示行：错误详情 / 警告 / 外部工具缺失
  let hint = '';
  let hintIsError = false;
  if (st === 'error') {
    hint = `❌ ${t.error || '未知错误'}`;
    hintIsError = true;
  } else if (t.warnings && t.warnings.length) {
    hint = `⚠️ ${t.warnings.slice(0, 2).join('；')}${t.warnings.length > 2 ? ` 等 ${t.warnings.length} 条` : ''}`;
  } else if (st === 'active' && t.backend === 'external') {
    hint = '正在调用外部工具，进度可能不精确';
  }

  let hintEl = root.querySelector('.row-hint');
  if (hint) {
    if (!hintEl) {
      hintEl = document.createElement('div');
      hintEl.className = 'row-hint';
      refs.items.parentElement.after(hintEl);
    }
    hintEl.textContent = hint;
    hintEl.classList.toggle('error', hintIsError);
  } else if (hintEl) {
    hintEl.remove();
  }

  // 按钮可用性
  const canToggle = st === 'active' || st === 'paused' || st === 'queued';
  refs.toggle.style.visibility = canToggle ? 'visible' : 'hidden';
  refs.toggle.title = st === 'paused' ? '继续（从头重新执行）' : '暂停';
  refs.toggle.innerHTML =
    st === 'paused'
      ? `<svg viewBox="0 0 16 16" width="15" height="15"><path d="M4.5 2.8 13 8l-8.5 5.2z" fill="currentColor"/></svg>`
      : `<svg viewBox="0 0 16 16" width="15" height="15"><rect x="4" y="3" width="2.6" height="10" rx="1" fill="currentColor"/><rect x="9.4" y="3" width="2.6" height="10" rx="1" fill="currentColor"/></svg>`;
  refs.listBtn.style.display = t.kind === 'extract' ? '' : 'none';
}

// ---------------------------------------------------------------- 主渲染

function render() {
  const all = state.tasks;
  el.cAll.textContent = String(all.length);
  el.cActive.textContent = String(all.filter(isActive).length);
  el.cDone.textContent = String(all.filter((t) => t.done).length);
  el.cFailed.textContent = String(all.filter((t) => t.status === 'error').length);

  el.gsCount.textContent = String(state.stats.count || 0);
  const activeCount = state.stats.active || 0;
  el.gsActive.textContent = String(activeCount);
  el.gsActiveWrap.hidden = activeCount === 0;

  el.dirText.textContent = state.outputDir ? middleEllipsis(state.outputDir) : '—';
  el.dirText.title = state.outputDir || '';
  updateToolsBadge();
  updateFormatsNote();

  const shown = all.filter(visible);
  // 空状态：只在「当前筛选下一条都没有」时显示。
  // 注意 el.empty 是 el.list 的子节点之一，判断必须基于 shown.length 而非 DOM 数量。
  if (shown.length === 0) {
    if (!el.empty.isConnected) el.list.appendChild(el.empty);
    el.empty.hidden = false;
    el.empty.querySelector('h2').textContent = all.length ? '这个分类下没有任务' : '还没有任务';
    el.empty.querySelector('p').textContent = all.length
      ? '切换左侧筛选查看其他任务'
      : '把压缩包拖到上方区域，或点「选择压缩包」';
  } else {
    el.empty.hidden = true;
  }

  // 排序：进行中 → 排队 → 暂停 → 失败 → 完成；同组内按创建时间倒序
  const rank = { active: 0, queued: 1, paused: 2, error: 3, done: 4 };
  const order = [...shown].sort((a, b) => {
    const ra = rank[statusOf(a)] ?? 9;
    const rb = rank[statusOf(b)] ?? 9;
    if (ra !== rb) return ra - rb;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });

  const seen = new Set();
  // 以空状态节点为起点：任务行始终排在它之后，保证「隐藏的空状态」不会夹在行中间
  let cursor = el.empty;
  for (const t of order) {
    seen.add(t.id);
    let entry = nodes.get(t.id);
    if (!entry) {
      const created = createRow(t);
      created.root.dataset.id = t.id;
      entry = { ...created, data: t };
      nodes.set(t.id, entry);
    } else {
      entry.data = t;
    }
    entry.root.dataset.status = statusOf(t);
    updateRow(entry, t);
    // 保持顺序：把节点插到正确位置
    const target = cursor.nextElementSibling;
    if (target !== entry.root) el.list.insertBefore(entry.root, target || null);
    cursor = entry.root;
  }

  for (const [id, entry] of nodes) {
    if (!seen.has(id)) {
      entry.root.remove();
      nodes.delete(id);
    }
  }

  // 状态栏
  const running = all.filter((t) => t.status === 'running').length;
  const queued = all.filter((t) => t.status === 'queued').length;
  el.statusText.textContent = running
    ? `${running} 个任务进行中${queued ? `，${queued} 个排队` : ''}`
    : queued
      ? `${queued} 个任务排队中`
      : '空闲';

  const doneCount = all.filter((t) => t.done).length;
  const errCount = all.filter((t) => t.status === 'error').length;
  el.statusHint.textContent = all.length
    ? `共 ${all.length} 个任务 · 完成 ${doneCount}${errCount ? ` · 失败 ${errCount}` : ''}`
    : '就绪';
}

function updateToolsBadge() {
  const t = state.tools || { tools: [] };
  const ids = (t.tools || []).map((x) => x.id);
  const parts = [];
  if (ids.includes('7zip')) parts.push('7-Zip');
  if (ids.includes('unrar')) parts.push('unrar');
  if (ids.includes('bsdtar')) parts.push('bsdtar');

  if (parts.length) {
    el.toolsLabel.textContent = parts.join(' · ');
    el.toolsBtn.classList.remove('warn');
    el.toolsBtn.title = `已检测到外部工具：${parts.join('、')}`;
  } else {
    el.toolsLabel.textContent = '仅内置';
    el.toolsBtn.classList.add('warn');
    el.toolsBtn.title = '未检测到外部工具，仅支持 ZIP / TAR / GZIP';
  }
}

function updateFormatsNote() {
  const builtin = (state.formats || []).filter((f) => !f.external).map((f) => f.name);
  const ext = (state.formats || []).filter((f) => f.external).map((f) => f.name);
  const hasExternal = (state.tools?.tools || []).length > 0;
  el.formatsNote.textContent = hasExternal
    ? `内置 ${builtin.length} · 外部 ${ext.length} 种格式`
    : `内置支持：${builtin.join(' / ')}`;
  el.formatsNote.title = `内置：${builtin.join(', ')}\n需外部工具：${ext.join(', ')}`;
}

// ---------------------------------------------------------------- 事件绑定

el.pickBtn.addEventListener('click', async () => {
  const res = await api.pickArchive();
  if (res.canceled) return;
  if (res.ok) {
    toast(`已添加 ${res.added} 个任务`, 'success');
    if (res.error) toast(res.error, 'warn', 4600);
  } else {
    toast(res.error || '添加失败', 'error', 4600);
  }
});

el.dirBtn.addEventListener('click', async () => {
  const picked = await api.chooseDir(state.outputDir);
  if (picked.canceled || !picked.ok) return;
  state.outputDir = picked.dir;
  render();
  toast('默认输出目录已更新（对新任务生效）', 'success');
});

document.querySelectorAll('.filter').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.filter = btn.dataset.filter;
    render();
  });
});

// ---------------------------------------------------------------- 外部工具面板

function openToolsModal() {
  el.toolsModal.hidden = false;
  renderToolsList();
}

function renderToolsList() {
  const tools = state.tools?.tools || [];
  const known = [
    { id: '7zip', name: '7-Zip', hint: '支持 7z / RAR / BZ2 / XZ / ISO / WIM / AES 加密包' },
    { id: 'unrar', name: 'unrar / unar', hint: 'RAR 专用解压（比 7-Zip 更完整）' },
    { id: 'bsdtar', name: 'bsdtar (libarchive)', hint: 'macOS 自带，覆盖 zip / tar / 7z 子集' }
  ];
  el.toolsList.innerHTML = '';
  for (const k of known) {
    const found = tools.find((t) => t.id === k.id);
    const item = document.createElement('div');
    item.className = `tool-item ${found ? 'ok' : 'miss'}`;

    const name = document.createElement('span');
    name.className = 't-name';
    name.textContent = k.name;

    const pathEl = document.createElement('span');
    pathEl.className = 't-path';
    pathEl.textContent = found ? found.path : k.hint;
    pathEl.title = found ? found.path : k.hint;

    const badge = document.createElement('span');
    badge.className = 't-badge';
    badge.textContent = found ? '已启用' : '未检测到';

    item.append(name, pathEl, badge);
    el.toolsList.appendChild(item);
  }

  if (!tools.length) {
    const tip = document.createElement('p');
    tip.className = 'modal-hint';
    tip.style.marginTop = '10px';
    tip.innerHTML =
      '安装方式：<b>macOS</b> <code>brew install sevenzip unrar</code> · ' +
      '<b>Windows</b> 到 7-zip.org 下载安装 · ' +
      '<b>Linux</b> <code>sudo apt install 7zip unrar-free</code>（或 <code>p7zip-full</code>）';
    el.toolsList.appendChild(tip);
  }
}

el.toolsBtn.addEventListener('click', openToolsModal);
el.toolsClose.addEventListener('click', () => (el.toolsModal.hidden = true));
el.toolsRefresh.addEventListener('click', async () => {
  const res = await api.refreshTools();
  state.tools = { tools: res.tools || [], hasSevenZip: res.hasSevenZip, hasUnrar: res.hasUnrar, hasBsdtar: res.hasBsdtar };
  renderToolsList();
  updateToolsBadge();
  updateFormatsNote();
  toast(state.tools.tools.length ? '外部工具已刷新' : '仍未检测到外部工具', state.tools.tools.length ? 'success' : 'warn');
});

// ---------------------------------------------------------------- 新建压缩包

function openCreateModal() {
  createDraft = { sources: [], savePath: '' };
  el.createSrcList.innerHTML = '';
  el.createCount.textContent = '未选择';
  el.createPath.value = '';
  el.createLevel.value = '6';
  el.createLevelText.textContent = '6';
  // 7z 选项只在有 7-Zip 时可用
  const opt7z = document.getElementById('opt-7z');
  const has7z = !!state.tools?.hasSevenZip;
  opt7z.disabled = !has7z;
  opt7z.textContent = has7z ? '7Z' : '7Z（未安装 7-Zip）';
  el.createModal.hidden = false;
}

el.createBtn.addEventListener('click', openCreateModal);
el.createCancel.addEventListener('click', () => (el.createModal.hidden = true));

el.createLevel.addEventListener('input', () => {
  el.createLevelText.textContent = el.createLevel.value;
});

el.createPick.addEventListener('click', async () => {
  const res = await api.pickSources();
  if (!res.ok || res.canceled) return;
  createDraft.sources = res.paths;
  el.createCount.textContent = `已选 ${res.paths.length} 项`;
  el.createSrcList.innerHTML = '';
  for (const p of res.paths) {
    const row = document.createElement('div');
    row.className = 'src-item';
    const icon = document.createElement('span');
    icon.className = 's-icon';
    icon.textContent = '▸';
    const text = document.createElement('span');
    text.textContent = p; // 路径来自用户选择，仍用 textContent 避免注入
    text.style.overflow = 'hidden';
    text.style.textOverflow = 'ellipsis';
    row.append(icon, text);
    el.createSrcList.appendChild(row);
  }
  // 自动建议输出路径
  if (!el.createPath.value) {
    suggestOutputPath();
  }
});

/** 根据第一个源与所选格式，建议一个输出路径 */
function suggestOutputPath() {
  if (!createDraft.sources.length) return;
  const fmt = el.createFormat.value;
  const extMap = { zip: '.zip', tar: '.tar', gzip: '.tar.gz', '7z': '.7z' };
  const sel = el.createFormat.selectedOptions[0];
  const dataExt = sel?.dataset?.ext;
  const ext = dataExt ? '.' + dataExt : extMap[fmt] || '.zip';

  const first = createDraft.sources[0];
  const base = first.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || 'archive';
  // 用系统默认输出目录（主进程会给绝对路径）
  const dir = state.outputDir || '';
  if (dir) {
    createDraft.savePath = `${dir}/${base}${ext}`.replace(/[/\\]+/g, '/');
    el.createPath.value = createDraft.savePath;
  }
}

el.createFormat.addEventListener('change', suggestOutputPath);

el.createBrowse.addEventListener('click', async () => {
  const fmt = el.createFormat.value;
  const extMap = { zip: 'archive.zip', tar: 'archive.tar', gzip: 'archive.tar.gz', '7z': 'archive.7z' };
  const res = await api.chooseSavePath(extMap[fmt] || 'archive.zip');
  if (res.ok && !res.canceled) {
    createDraft.savePath = res.path;
    el.createPath.value = res.path;
  }
});

el.createStart.addEventListener('click', async () => {
  if (!createDraft.sources.length) {
    toast('请先选择要压缩的文件或文件夹', 'warn');
    return;
  }
  if (!createDraft.savePath) {
    toast('请先选择保存位置', 'warn');
    return;
  }

  const sel = el.createFormat.selectedOptions[0];
  const formatId = el.createFormat.value;
  // gzip 有两档（.tar.gz / .gz），靠 dataset.ext 区分
  let savePath = createDraft.savePath;
  const dataExt = sel?.dataset?.ext;
  if (dataExt === 'gz' && !/\.gz$/i.test(savePath)) {
    savePath = savePath.replace(/\.(tar\.gz|tgz|zip|tar|7z)$/i, '') + '.gz';
  }

  el.createStart.disabled = true;
  try {
    const res = await api.create(createDraft.sources, {
      archivePath: savePath,
      formatId,
      level: Number(el.createLevel.value)
    });
    if (res.ok) {
      toast('已开始压缩', 'success');
      el.createModal.hidden = true;
    } else {
      toast(res.error || '创建失败', 'error', 5000);
    }
  } finally {
    el.createStart.disabled = false;
  }
});

// ---------------------------------------------------------------- 内容预览

async function openListModal(archivePath) {
  el.listModal.hidden = false;
  el.listTitle.textContent = '读取中…';
  el.listMeta.textContent = '';
  el.entries.innerHTML = '';
  const loading = document.createElement('div');
  loading.className = 'entries-empty';
  loading.textContent = '正在读取目录…';
  el.entries.appendChild(loading);

  const res = await api.list(archivePath);
  if (!res.ok) {
    el.listTitle.textContent = '压缩包内容';
    el.entries.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'entries-empty';
    err.textContent = res.error || '读取失败';
    el.entries.appendChild(err);
    return;
  }

  el.listTitle.textContent = archivePath.split(/[/\\]/).pop() || '压缩包内容';
  el.listTitle.title = archivePath;

  const dirs = res.entries.filter((e) => e.isDir).length;
  const files = res.entries.length - dirs;
  const total = res.entries.reduce((a, e) => a + (e.size || 0), 0);
  el.listMeta.innerHTML = '';
  const mk = (text, cls) => {
    const s = document.createElement('span');
    s.textContent = text;
    if (cls) s.className = cls;
    return s;
  };
  el.listMeta.append(
    mk(`格式 ${res.formatName || '?'}`),
    mk(`${files} 个文件`),
    mk(dirs ? `${dirs} 个目录` : '无目录'),
    mk(`解压后 ${fmtBytes(total)}`)
  );
  if (res.encrypted) {
    const warn = mk('含加密条目', '');
    warn.style.color = 'var(--red)';
    el.listMeta.appendChild(warn);
  }

  el.entries.innerHTML = '';
  if (!res.entries.length) {
    const empty = document.createElement('div');
    empty.className = 'entries-empty';
    empty.textContent = '（空归档）';
    el.entries.appendChild(empty);
    return;
  }

  // 条目多时只渲染前 2000 条，避免一次性插入十几万个 DOM 节点卡死界面
  const MAX_RENDER = 2000;
  const list = res.entries.slice(0, MAX_RENDER);
  const frag = document.createDocumentFragment();
  for (const e of list) {
    const row = document.createElement('div');
    row.className = `entry${e.isDir ? ' is-dir' : ''}${e.encrypted ? ' is-enc' : ''}`;

    const icon = document.createElement('span');
    icon.className = 'e-icon';
    icon.textContent = e.encrypted ? '🔒' : e.isDir ? '▸' : '·';

    const name = document.createElement('span');
    name.className = 'e-name';
    name.textContent = e.name; // 条目名来自压缩包内容（不可信），必须 textContent
    name.title = e.name;

    const size = document.createElement('span');
    size.className = 'e-size';
    size.textContent = e.isDir ? '' : fmtBytes(e.size || 0);

    const meta = document.createElement('span');
    meta.className = 'e-meta';
    meta.textContent = e.mtime ? String(e.mtime).slice(0, 10) : '';

    row.append(icon, name, size, meta);
    frag.appendChild(row);
  }
  el.entries.appendChild(frag);

  if (res.entries.length > MAX_RENDER) {
    const more = document.createElement('div');
    more.className = 'entries-empty';
    more.textContent = `还有 ${res.entries.length - MAX_RENDER} 项未显示（仅预览前 ${MAX_RENDER} 项）`;
    el.entries.appendChild(more);
  }
}

el.listClose.addEventListener('click', () => (el.listModal.hidden = true));

// ---------------------------------------------------------------- 全局事件

for (const mask of [el.toolsModal, el.createModal, el.listModal]) {
  mask.addEventListener('click', (e) => {
    if (e.target === mask) {
      mask.hidden = true;
      closeMenus();
    }
  });
}

document.addEventListener('click', closeMenus);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMenus();
    el.toolsModal.hidden = true;
    el.createModal.hidden = true;
    el.listModal.hidden = true;
  }
  // ⌘O / Ctrl+O 打开压缩包
  if ((e.metaKey || e.ctrlKey) && e.key === 'o') {
    e.preventDefault();
    el.pickBtn.click();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
    e.preventDefault();
    openCreateModal();
  }
});

// ---------------------------------------------------------------- 拖放

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragover');
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) document.body.classList.remove('dragover');
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('dragover');

  const files = [...(e.dataTransfer.files || [])];
  if (!files.length) {
    // 拖动的是文本（例如从别的应用拖来一个路径）——本应用不支持，提示一下
    toast('请拖入压缩包文件', 'warn');
    return;
  }

  // Electron 32+ 必须用 webUtils.getPathForFile 拿真实路径（file.path 已移除）
  const paths = files.map((f) => api.getFilePath(f)).filter(Boolean);
  if (!paths.length) {
    toast('无法读取拖入文件的路径', 'error');
    return;
  }

  const res = await api.addPaths(paths);
  if (res.ok) {
    toast(`已添加 ${res.added} 个任务`, 'success');
    if (res.error) toast(res.error, 'warn', 4600);
  } else {
    toast(res.error || '添加失败', 'error', 4600);
  }
});

// ---------------------------------------------------------------- 主进程事件

api.onUpdate((payload) => {
  state.tasks = payload.tasks || [];
  state.stats = payload.stats || {};
  state.formats = payload.formats || state.formats;
  state.tools = payload.tools || state.tools;
  state.outputDir = payload.outputDir || state.outputDir;
  render();
});

api.onNotice((payload) => {
  const type = ['warn', 'success', 'error'].includes(payload?.type) ? payload.type : 'info';
  toast(payload.text, type, 4600);
});

api.onMenu((payload) => {
  if (payload?.action === 'open') el.pickBtn.click();
  if (payload?.action === 'create') openCreateModal();
});

// ---------------------------------------------------------------- 初始化

(async () => {
  const initial = await api.getState();
  state.tasks = initial.tasks || [];
  state.stats = initial.stats || {};
  state.formats = initial.formats || [];
  state.tools = initial.tools || { tools: [] };
  state.outputDir = initial.outputDir || '';
  render();
})();
