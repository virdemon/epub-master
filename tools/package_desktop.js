/* 打包桌面版：把单文件 HTML 塞进 desktop/app/，再用 electron-packager 出 Windows 目录版。 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'dist', 'epubfix-standalone.html');
const APP_DIR = path.join(ROOT, 'desktop', 'app');
const OUT = path.join(ROOT, 'dist');

async function main() {
  if (!fs.existsSync(SRC)) {
    throw new Error('先跑 python tools/build_standalone.py 生成单文件版');
  }
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.copyFileSync(SRC, path.join(APP_DIR, 'index.html'));
  console.log('已准备 desktop/app/index.html');

  const packager = require('@electron/packager');

  const paths = await packager({
    dir: path.join(ROOT, 'desktop'),
    out: OUT,
    name: 'EpubFix',
    platform: 'win32',
    arch: 'x64',
    overwrite: true,
    asar: true,
    appVersion: '1.1.0',
    win32metadata: {
      ProductName: 'EPUB 排版归一',
      FileDescription: 'EPUB 排版归一',
      CompanyName: 'epubfix'
    },
    ignore: [/^\/app\/.*\.map$/, /\.git/]
  });

  paths.forEach(function (p) {
    console.log('已打包: ' + p);
    const exe = path.join(p, 'EpubFix.exe');
    if (fs.existsSync(exe)) {
      const mb = fs.statSync(exe).size / 1048576;
      console.log('  可执行文件: ' + exe + '（' + mb.toFixed(1) + ' MB）');
    }
  });
}

main().catch(function (e) {
  console.error('打包失败: ' + e.message);
  process.exit(1);
});
