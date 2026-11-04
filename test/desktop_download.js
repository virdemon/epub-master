/* 验证桌面版的完整链路：选择文件 → 处理 → 点下载 → 文件真的落盘 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'EpubFix-win32-x64', 'EpubFix.exe');
const SAVE_DIR = path.join(ROOT, 'test', 'desktop_out');
const PORT = 9334;

(async function () {
  fs.rmSync(SAVE_DIR, { recursive: true, force: true });
  fs.mkdirSync(SAVE_DIR, { recursive: true });

  const env = Object.assign({}, process.env, { EPUBFIX_AUTOSAVE: SAVE_DIR });
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, ['--remote-debugging-port=' + PORT], { stdio: 'ignore', env: env });
  await new Promise((r) => setTimeout(r, 6000));

  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:' + PORT, defaultViewport: null });
  const pages = await browser.pages();
  const page = pages.find((p) => /index\.html/.test(p.url())) || pages[0];

  // 直接喂文件（拖拽在 CDP 里不好模拟，走同一个入口函数）
  const b64 = fs.readFileSync(path.join(ROOT, 'test', 'sample_web.epub')).toString('base64');
  await page.evaluate(async (data) => {
    const bin = atob(data);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], '测试书.epub', { type: 'application/epub+zip' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, b64);

  await page.waitForSelector('#fileCard:not([hidden])', { timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('fileCard').getAttribute('data-ready') === '1', { timeout: 60000 });
  const card = await page.evaluate(() => ({
    title: document.getElementById('fileTitle').textContent,
    author: document.getElementById('fileAuthor').textContent,
    facts: document.getElementById('fileFacts').textContent
  }));

  await page.click('#startBtn2');
  await page.waitForSelector('#result:not([hidden])', { timeout: 120000 });
  await page.click('#downloadBtn');

  let saved = null;
  for (let i = 0; i < 40; i++) {
    const list = fs.readdirSync(SAVE_DIR);
    if (list.length) { saved = list[0]; break; }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log('桌面版下载链路');
  console.log('  卡片: ' + card.title + ' / ' + card.author + ' / ' + card.facts);
  console.log('  落盘文件: ' + (saved || '（没生成）'));
  if (saved) {
    const p = path.join(SAVE_DIR, saved);
    console.log('  体积: ' + fs.statSync(p).size + ' 字节');
  }

  browser.disconnect();
  child.kill();
  if (!saved) process.exit(1);
})().catch(function (e) {
  console.error('失败: ' + e.message);
  process.exit(1);
});
