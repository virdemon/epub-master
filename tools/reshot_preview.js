/* 补截：阅读器预览图只取正文排版区域，避开测试用的噪点占位图 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'images');
const BOOK = path.join(ROOT, 'test', 'sample_book.epub');

function findBrowser() {
  const cands = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('找不到浏览器');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 1.5 });
  await page.goto('file:///' + path.join(ROOT, 'epubfix', 'index.html').replace(/\\/g, '/'), { waitUntil: 'load' });
  await sleep(600);

  await page.evaluate(() => { document.getElementById('fileInput').multiple = false; });
  const input = await page.$('#fileInput');
  await input.uploadFile(BOOK);
  await page.waitForSelector('#fileCard[data-ready="1"]', { timeout: 90000 });
  await page.click('#startBtn2');
  await page.waitForSelector('#resultCard:not([hidden])', { timeout: 300000 });
  await sleep(600);

  await page.click('#previewBtn');
  await page.waitForSelector('#reader:not([hidden])', { timeout: 30000 });
  await page.waitForFunction(() => {
    const f = document.getElementById('rdFrame');
    return f && f.contentDocument && f.contentDocument.body && f.contentDocument.body.children.length > 0;
  }, { timeout: 30000 });
  await sleep(1500);

  // 只截上半部分：工具栏 + 目录 + 正文前几段
  await page.screenshot({
    path: path.join(OUT, 'pc-preview.png'),
    clip: { x: 0, y: 0, width: 1280, height: 620 }
  });
  console.log('✓ pc-preview.png（裁剪版）');

  await browser.close();
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
