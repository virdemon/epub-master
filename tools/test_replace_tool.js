/* 测试「文字查找替换」工具：真实浏览器里点一遍并截图 */
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'shots');
const BOOK = path.join(ROOT, 'test', 'sample_book.epub');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new',
    defaultViewport: { width: 1280, height: 860, deviceScaleFactor: 1.5 },
    args: ['--allow-file-access-from-files'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto('file:///' + path.join(ROOT, 'epubfix', 'index.html').replace(/\\/g, '/'), { waitUntil: 'load' });
  await sleep(1200);

  // 进入工具箱
  await page.evaluate(() => document.querySelector('.nav-item[data-view="tools"]').click());
  await sleep(700);
  await page.screenshot({ path: path.join(OUT, '_t-tools.png') });

  // 点「文字查找替换」
  const opened = await page.evaluate(() => {
    const b = document.querySelector('#toolGrid [data-tool="replace"]');
    if (!b) return false;
    b.click();
    return true;
  });
  console.log('打开工具:', opened);
  await sleep(600);

  // 先点「选择 EPUB 文件」，让 askFile() 挂上 onchange，再塞文件进去
  await page.evaluate(() => {
    const b = document.getElementById('toolPick');
    if (b) b.click();
  });
  await sleep(500);
  const input = await page.$('#toolInput');
  await input.uploadFile(BOOK);
  await sleep(2500);
  await page.screenshot({ path: path.join(OUT, '_t-replace-form.png') });

  // 填查找/替换
  await page.evaluate(() => {
    document.getElementById('repFind').value = '渡口无船';
    document.getElementById('repTo').value = '三岔路口';
  });

  // 先查一查
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#modalFoot button')];
    const b = btns.find((x) => x.textContent.includes('先查一查'));
    if (b) b.click();
  });
  await sleep(3000);
  await page.screenshot({ path: path.join(OUT, '_t-replace-scan.png') });

  const scanText = await page.evaluate(() => document.getElementById('repResult').innerText);
  console.log('--- 查找结果 ---');
  console.log(scanText.slice(0, 400));

  // 真的替换（拦截下载）
  const client = await page.target().createCDPSession();
  await client.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: path.join(ROOT, 'test', 'dl'),
  });
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#modalFoot button')];
    const b = btns.find((x) => x.textContent.includes('全部替换并保存'));
    if (b) b.click();
  });
  await sleep(4000);
  await page.screenshot({ path: path.join(OUT, '_t-replace-done.png') });

  const doneText = await page.evaluate(() => document.getElementById('repResult').innerText);
  console.log('--- 替换结果 ---');
  console.log(doneText.slice(0, 400));

  console.log('--- 页面错误 ---');
  console.log(errors.length ? errors.slice(0, 8).join('\n') : '无');

  await browser.close();
})();
