/* 生成 README 用的界面截图：电脑版各页面 + 手机版四页 */
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
const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/');

async function shootPC(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 1.5 });
  await page.goto(fileUrl(path.join(ROOT, 'epubfix', 'index.html')), { waitUntil: 'load' });
  await sleep(800);

  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, name + '.png') });
    console.log('  ✓', name + '.png');
  };

  // 1. 首页空状态
  await shot('pc-home');

  // 2-6. 各导航页
  const views = [['batch', 'pc-batch'], ['tools', 'pc-tools'], ['settings', 'pc-settings'], ['about', 'pc-about']];
  for (const [view, name] of views) {
    await page.evaluate((v) => {
      const b = document.querySelector('.nav-item[data-view="' + v + '"]');
      if (b) b.click();
    }, view);
    await sleep(600);
    await shot(name);
  }

  // 回首页并拖入文件
  await page.evaluate(() => document.querySelector('.nav-item[data-view="home"]').click());
  await sleep(400);
  await page.evaluate(() => { document.getElementById('fileInput').multiple = false; });
  const input = await page.$('#fileInput');
  await input.uploadFile(BOOK);
  await page.waitForSelector('#fileCard[data-ready="1"]', { timeout: 90000 });
  await sleep(700);
  await shot('pc-card');

  // 处理中
  await page.click('#startBtn2');
  await sleep(1200);
  await shot('pc-processing');

  // 结果页
  await page.waitForSelector('#resultCard:not([hidden])', { timeout: 300000 });
  await sleep(800);
  await shot('pc-result');

  // 预览（阅读器）
  try {
    await page.click('#previewBtn');
    await page.waitForSelector('#reader:not([hidden])', { timeout: 30000 });
    await sleep(1800);
    await shot('pc-preview');
  } catch (e) {
    console.log('  ! 预览失败:', e.message);
  }

  await page.close();
}

async function shootApp(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await page.goto(fileUrl(path.join(ROOT, 'mobile', 'www', 'index.html')), { waitUntil: 'load' });
  await sleep(600);

  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, name + '.png') });
    console.log('  ✓', name + '.png');
  };

  await shot('app-home');

  const input = await page.$('#file-input');
  await input.uploadFile(BOOK);
  await sleep(1600);
  await shot('app-config');

  await page.click('#btn-start');
  await sleep(1000);
  await shot('app-progress');

  for (let i = 0; i < 300; i++) {
    await sleep(500);
    const done = await page.evaluate(() =>
      !document.getElementById('screen-done').classList.contains('is-hidden'));
    if (done) break;
  }
  await sleep(500);
  await shot('app-done');

  await page.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(BOOK)) throw new Error('缺少测试书 ' + BOOK);
  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--disable-dev-shm-usage']
  });
  console.log('电脑版截图：');
  await shootPC(browser);
  console.log('手机版截图：');
  await shootApp(browser);
  await browser.close();
  console.log('全部完成，输出目录：' + OUT);
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
