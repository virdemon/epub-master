/* 手机端界面实测：首页 → 配置（含去重开关）→ 处理中 → 完成 */
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'shots');
const BOOK = path.join(ROOT, 'test', 'sample_book.epub');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new',
    args: ['--allow-file-access-from-files'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

  await page.goto('file:///' + path.join(ROOT, 'mobile', 'www', 'index.html').replace(/\\/g, '/'), { waitUntil: 'load' });
  await sleep(800);
  await page.screenshot({ path: path.join(OUT, '_m-home.png') });

  // 选文件
  const input = await page.$('#file-input');
  await input.uploadFile(BOOK);
  await sleep(2500);
  await page.screenshot({ path: path.join(OUT, '_m-config.png') });

  const cfg = await page.evaluate(() => {
    const sw = document.getElementById('opt-dedupe');
    return {
      hasSwitch: !!sw,
      checked: sw ? sw.checked : null,
      text: document.querySelector('.config-body').innerText.replace(/\n+/g, ' | ').slice(0, 300),
    };
  });
  console.log('配置页:', JSON.stringify(cfg).slice(0, 400));

  // 开始压缩
  await page.click('#btn-start');
  await sleep(1200);
  await page.screenshot({ path: path.join(OUT, '_m-progress.png') });

  // 等完成（最多 3 分钟）
  let done = false;
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const cur = await page.evaluate(() => {
      const el = document.getElementById('screen-done');
      return el && !el.classList.contains('is-hidden');
    });
    if (cur) { done = true; break; }
  }
  console.log('完成:', done);
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT, '_m-done.png') });

  const res = await page.evaluate(() => document.querySelector('.done-body').innerText.replace(/\n+/g, ' | '));
  console.log('结果页:', res);
  console.log('错误:', errors.length ? errors.slice(0, 5) : '无');

  await browser.close();
})();
