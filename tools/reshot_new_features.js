/* 补拍 README 用的两张新图：文字替换工具、手机端去重开关 */
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'images');
const BOOK = path.join(ROOT, 'test', 'sample_book.epub');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new',
    args: ['--allow-file-access-from-files'],
  });

  /* ---- 1. 电脑端：文字查找替换 ---- */
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1.5 });
  await page.goto('file:///' + path.join(ROOT, 'epubfix', 'index.html').replace(/\\/g, '/'), { waitUntil: 'load' });
  await sleep(1000);
  await page.evaluate(() => document.querySelector('.nav-item[data-view="tools"]').click());
  await sleep(600);
  await page.evaluate(() => document.querySelector('#toolGrid [data-tool="replace"]').click());
  await sleep(500);
  await page.evaluate(() => document.getElementById('toolPick').click());
  await sleep(400);
  const input = await page.$('#toolInput');
  await input.uploadFile(BOOK);
  await sleep(2500);

  await page.evaluate(() => {
    document.getElementById('repFind').value = '渡口无船';
    document.getElementById('repTo').value = '三岔路口';
    const b = [...document.querySelectorAll('#modalFoot button')].find((x) => x.textContent.includes('先查一查'));
    if (b) b.click();
  });
  await sleep(3000);
  await page.screenshot({ path: path.join(OUT, 'pc-replace.png') });
  console.log('  ✓ pc-replace.png');
  await page.close();

  /* ---- 2. 手机端：设置页（含去重开关） ---- */
  const m = await browser.newPage();
  await m.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await m.goto('file:///' + path.join(ROOT, 'mobile', 'www', 'index.html').replace(/\\/g, '/'), { waitUntil: 'load' });
  await sleep(800);
  const finput = await m.$('#file-input');
  await finput.uploadFile(BOOK);
  await sleep(2500);
  await m.screenshot({ path: path.join(OUT, 'app-config.png') });
  console.log('  ✓ app-config.png（已覆盖旧图）');
  await m.close();

  await browser.close();
})();
