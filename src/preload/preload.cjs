const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * 主进程与渲染进程之间的唯一通道。
 *
 * 约定（与 omni-down 一致）：
 * - 只暴露**白名单方法**，不暴露 ipcRenderer 本身（否则渲染层可以发任意 channel）
 * - 每个方法都是薄包装，不含业务逻辑
 * - 唯一的例外是 getFilePath：Electron 32+ 起 webUtils.getPathForFile 是
 *   渲染层拿到拖入文件真实路径的官方方式（file.path 已被移除），需要在这里包一层
 */
contextBridge.exposeInMainWorld('zip', {
  getState: () => ipcRenderer.invoke('z:get-state'),

  // 添加任务
  pickArchive: () => ipcRenderer.invoke('z:pick-archive'),
  addPaths: (paths) => ipcRenderer.invoke('z:add-paths', paths),
  getFilePath: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  // 解压任务控制
  pause: (id) => ipcRenderer.invoke('z:pause', id),
  resume: (id) => ipcRenderer.invoke('z:resume', id),
  remove: (id, deleteOutput) => ipcRenderer.invoke('z:remove', id, deleteOutput),
  setTaskDest: (id, dir) => ipcRenderer.invoke('z:set-task-dest', id, dir),
  defaultDest: (archivePath) => ipcRenderer.invoke('z:default-dest', archivePath),

  // 目录选择
  chooseDir: (initial) => ipcRenderer.invoke('z:choose-dir', initial),

  // 预览
  list: (archivePath, password) => ipcRenderer.invoke('z:list', archivePath, password),

  // 新建压缩包
  pickSources: () => ipcRenderer.invoke('z:pick-sources'),
  chooseSavePath: (defaultName) => ipcRenderer.invoke('z:choose-save-path', defaultName),
  create: (sourcePaths, opts) => ipcRenderer.invoke('z:create', sourcePaths, opts),

  // 系统集成
  openPath: (p) => ipcRenderer.invoke('z:open-path', p),
  reveal: (p) => ipcRenderer.invoke('z:reveal', p),
  copy: (text) => ipcRenderer.invoke('z:copy', text),

  // 外部工具
  refreshTools: () => ipcRenderer.invoke('z:refresh-tools'),
  getCapabilities: () => ipcRenderer.invoke('z:get-capabilities'),

  // 事件订阅
  onUpdate: (cb) => ipcRenderer.on('z:update', (_e, payload) => cb(payload)),
  onNotice: (cb) => ipcRenderer.on('z:notice', (_e, payload) => cb(payload)),
  onMenu: (cb) => ipcRenderer.on('z:menu', (_e, payload) => cb(payload))
});
