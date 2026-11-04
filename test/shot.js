/* 截图脚本：拖入文件 → 读封面 → 处理 → 预览，逐状态截图，用于肉眼检查界面。 */
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const PAGE = 'file://' + path.join(ROOT, 'epubfix', 'index.html').replace(/\\/g, '/');
const SAMPLE = process.env.SAMPLE || path.join(ROOT, 'test', 'sample_broken.epub');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PREFIX = process.env.PREFIX || '';

(async function () {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
  await page.goto(PAGE, { waitUntil: 'load' });

  await page.screenshot({ path: path.join(ROOT, 'test', PREFIX + 'ui_idle.png'), fullPage: true });

  // 单本走 loadSingle 分支，必须先把 multiple 关掉，否则会进批量队列
  await page.evaluate(() => { document.getElementById('fileInput').multiple = false; });
  const input = await page.$('#fileInput');
  await input.uploadFile(SAMPLE);
  await page.waitForSelector('#fileCard[data-ready="1"]', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: path.join(ROOT, 'test', PREFIX + 'ui_card.png'), fullPage: true });

  await page.click('#startBtn2');
  await page.waitForSelector('#resultCard:not([hidden])', { timeout: 300000 });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(ROOT, 'test', PREFIX + 'ui_done.png'), fullPage: true });

  // 预览现在是独立阅读窗口（全屏），截图取整个视口
  await page.click('#previewBtn');
  await page.waitForSelector('#reader:not([hidden])', { timeout: 30000 });
  await page.waitForFunction(() => {
    const f = document.getElementById('rdFrame');
    return f && f.contentDocument && f.contentDocument.body && f.contentDocument.body.children.length > 0;
  }, { timeout: 30000 });
  await page.evaluate(function () {
    const li = document.querySelectorAll('#rdToc li[data-ch]')[1];
    if (li) li.click();
  });
  await new Promise((r) => setTimeout(r, 1800));
  await page.screenshot({ path: path.join(ROOT, 'test', PREFIX + 'ui_preview.png') });

  await browser.close();
  console.log('已生成截图');
})().catch(function (e) {
  console.error('截图失败: ' + e.message);
  process.exit(1);
});
