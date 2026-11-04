/*
 * 桌面版外壳：Electron 只负责给这个工具一个"像软件"的窗口和好用的另存为，
 * 界面与处理逻辑仍然完全复用同一份 HTML / JS —— 一份代码，两种发布形态。
 */

const { app, BrowserWindow, dialog, shell, Menu, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_DIR = path.join(__dirname, 'app');
const INDEX = path.join(APP_DIR, 'index.html');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    // 三栏式界面：左导航 228 + 工作区 + 右面板 318，窗口窄了会挤成两栏
    width: 1360,
    height: 900,
    minWidth: 1180,
    minHeight: 680,
    title: 'EPUB Master — EPUB 排版与压缩大师',
    icon: path.join(APP_DIR, 'icon.ico'),
    backgroundColor: '#f5f7fb',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      // 允许拖拽本地文件、允许 file:// 页面读 Blob（导出下载需要）
      webSecurity: true
    }
  });

  win.loadFile(INDEX);
  win.once('ready-to-show', function () {
    win.show();
  });

  // 外链一律丢给系统浏览器，别在应用窗口里跑
  win.webContents.setWindowOpenHandler(function (details) {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', function (e, url) {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
}

/* ---------------------------------------------------------------- 输出目录
 * 默认写到「下载\EPUB_Master」：用系统提供的下载目录拼出来，
 * 不写死用户名，也不假设盘符。目录不存在就建。
 */

function defaultDir() {
  return path.join(app.getPath('downloads'), 'EPUB_Master');
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    // 建不出来就把错误往上抛，绝不"静默改成别的地方"
    throw new Error('无法创建输出目录 ' + dir + '：' + e.message);
  }
  return dir;
}

// 同名不覆盖：a.epub 存在就写 a (2).epub
function uniquePath(dir, name) {
  const safe = path.basename(String(name || 'book.epub')).replace(/[\\/:*?"<>|]/g, '_');
  let target = path.join(dir, safe);
  if (!fs.existsSync(target)) return target;
  const base = safe.replace(/\.epub$/i, '');
  for (let i = 2; i < 1000; i++) {
    const cand = path.join(dir, base + ' (' + i + ').epub');
    if (!fs.existsSync(cand)) return cand;
  }
  return path.join(dir, base + ' (' + Date.now() + ').epub');
}

function setupIpc() {
  ipcMain.on('ef:default-dir', function (e) {
    e.returnValue = defaultDir();
  });

  ipcMain.handle('ef:save', function (e, payload, opts) {
    try {
      const dir = ensureDir(opts && opts.dir ? opts.dir : defaultDir());
      let n = 0;
      const written = [];
      (payload || []).forEach(function (f) {
        const raw = f.bytes || f.data || [];
        // 必须带上 byteOffset/byteLength：Uint8Array 可能只是某个更大 buffer 的一段视图，
        // 直接 Buffer.from(raw.buffer) 会把整块内存都写进文件，得到一本坏书
        let buf;
        if (Buffer.isBuffer(raw)) buf = raw;
        else if (raw && raw.buffer instanceof ArrayBuffer) {
          buf = Buffer.from(raw.buffer, raw.byteOffset || 0, raw.byteLength);
        } else buf = Buffer.from(raw);
        const target = uniquePath(dir, f.name);
        fs.writeFileSync(target, buf);
        written.push(target);
        n++;
      });
      return { saved: n, dir: dir, files: written };
    } catch (err) {
      return { error: err.message, dir: '' };
    }
  });

  ipcMain.handle('ef:pick-dir', async function () {
    const r = await dialog.showOpenDialog(win, {
      title: '选择输出目录',
      defaultPath: defaultDir(),
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths.length) return '';
    return ensureDir(r.filePaths[0]);
  });

  ipcMain.handle('ef:open-dir', function (e, dir) {
    const target = ensureDir(dir && String(dir).trim() ? dir : defaultDir());
    shell.openPath(target);
    return target;
  });

  ipcMain.handle('ef:reveal', function (e, file) {
    if (file && fs.existsSync(file)) shell.showItemInFolder(file);
    return true;
  });

  ipcMain.handle('ef:check-update', function () {
    // 这个构建没有更新服务器，如实说明，不假装检查成功
    return { ok: false, message: '当前为离线构建（v' + app.getVersion() + '），没有配置更新服务器，无法自动升级。' };
  });
}

/*
 * 下载：浏览器的 a[download] 在 Electron 里默认直接落到下载目录，
 * 用户找不到文件。这里改成弹"另存为"，默认文件名用书籍原名。
 */
function setupDownload() {
  session.defaultSession.on('will-download', function (event, item, webContents) {
    const suggested = item.getFilename() || 'book.epub';

    // 自动化测试用：跳过系统对话框直接落到下载目录，
    // 这样能验证"Blob → will-download → 写文件"整条链路真的通。
    if (process.env.EPUBFIX_AUTOSAVE) {
      item.setSavePath(path.join(process.env.EPUBFIX_AUTOSAVE, suggested));
      return;
    }

    // 页面已通过 IPC 直接写盘的情况不会走到这里；这里是兜底：
    // 落到同一个默认目录，不再弹系统对话框打断流程。
    const dir = ensureDir(defaultDir());
    const target = uniquePath(dir, suggested);
    item.setSavePath(target);
    item.once('done', function (e, state) {
      if (state === 'completed' && win) {
        win.webContents.send('ef:saved', target);
      }
    });
  });
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开 EPUB…',
          accelerator: 'CmdOrCtrl+O',
          click: function () {
            if (win) win.webContents.executeJavaScript("document.getElementById('pickBtn').click()");
          }
        },
        {
          label: '打开输出文件夹',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: function () {
            shell.openPath(ensureDir(defaultDir()));
          }
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
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
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: function () {
            dialog.showMessageBoxSync(win, {
              type: 'info',
              title: '关于',
              message: 'EPUB Master ' + app.getVersion(),
              detail:
                'EPUB 排版与压缩大师。\n\n' +
                '· 保留原始排版，只在必要时重排正文\n' +
                '· 图片按目标体积反推压缩，超不过上限\n' +
                '· 文本本身放不下时，按章节边界拆成多卷\n' +
                '· 结构诊断与修复：manifest 双向校验、引用、命名\n\n' +
                '所有处理都在本机完成，不上传任何服务器。'
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(function () {
  setupIpc();
  setupDownload();
  buildMenu();
  createWindow();
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
