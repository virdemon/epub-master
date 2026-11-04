/*
 * 预加载脚本：只暴露一组明确的、有边界的能力给页面。
 * 页面拿不到 require / fs，也不能执行任意路径，避免"界面代码即系统权限"。
 */

const { contextBridge, ipcRenderer } = require('electron');

// 默认输出目录要在页面首屏就能显示，所以同步取一次
let defaultDir = '';
try {
  defaultDir = ipcRenderer.sendSync('ef:default-dir') || '';
} catch (e) {
  defaultDir = '';
}

contextBridge.exposeInMainWorld('emDesktop', {
  version: process.versions.electron || '',
  platform: process.platform,
  defaultDir: defaultDir,

  // payload: [{ name, bytes:Uint8Array }]；opts: { dir?, silent? }
  saveFiles: function (payload, opts) {
    return ipcRenderer.invoke('ef:save', payload, opts || {});
  },
  pickDir: function () {
    return ipcRenderer.invoke('ef:pick-dir');
  },
  openDir: function (dir) {
    return ipcRenderer.invoke('ef:open-dir', dir || '');
  },
  revealFile: function (file) {
    return ipcRenderer.invoke('ef:reveal', file || '');
  },
  checkUpdate: function () {
    return ipcRenderer.invoke('ef:check-update');
  }
});
