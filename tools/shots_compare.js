/* 同一章「处理前 vs 处理后」对照截图：用界面自带的「回原书对照」 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'images');
const BOOK = 'C:\\Users\\wh\\Downloads\\成为被猎人们痴迷的心理医生.epub';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/');
const BLUR = `.gal-thumb,#lbImg,#lbImgB,#coverImg{filter:blur(18px) saturate(.7)}`;

function findBrowser() {
  for (const p of ['C:/Program Files/Google/Chrome/Application/chrome.exe',
                   'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'])
    if (fs.existsSync(p)) return p;
  throw new Error('no browser');
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: findBrowser(), headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--disable-dev-shm-usage',
           '--js-flags=--max-old-space-size=6144'],
    protocolTimeout: 2400000,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1360, height: 860, deviceScaleFactor: 1.6 });
  const shot = async (n) => { await page.screenshot({ path: path.join(OUT, n + '.png') }); console.log('  ✓', n); };

  await page.goto(fileUrl(path.join(ROOT, 'epubfix', 'index.html')), { waitUntil: 'load' });
  await sleep(800);
  await page.evaluate(() => { document.getElementById('fileInput').multiple = false; });
  await (await page.$('#fileInput')).uploadFile(BOOK);
  await page.waitForSelector('#fileCard[data-ready="1"]', { timeout: 600000 });
  await sleep(800);

  // 输出 EPUB 2.0 + 深度优化
  await page.evaluate(() => document.querySelector('#verSeg .seg-btn[data-ver="2"]')?.click());
  await sleep(400);
  await page.click('#startBtn2');
  await page.waitForSelector('#resultCard:not([hidden])', { timeout: 2400000 });
  await sleep(1200);
  console.log('处理完成');

  await page.click('#previewBtn');
  await page.waitForSelector('#reader:not([hidden])', { timeout: 90000 });
  await sleep(3000);

  // 跳到第 6 章（"4. 陈世雅"，纯文字章节）
  const ch = await page.evaluate(() => {
    const lis = document.querySelectorAll('#rdToc li');
    const li = lis[5];
    if (li) { li.click(); return li.innerText.trim(); }
    return null;
  });
  console.log('章节:', ch);
  await sleep(3000);

  // 阅读样式
  await page.evaluate(() => document.querySelector('#rdStyleSeg .rd-seg-btn[data-style="reading"]')?.click());
  await sleep(2500);
  for (const f of page.frames()) {
    try { await f.addStyleTag({ content: 'img{filter:blur(18px) saturate(.7)}' }); } catch (e) {}
  }
  await sleep(400);
  await shot('demo-12-after');

  // 回原书对照（同一章）
  const swapped = await page.evaluate(() => {
    const b = document.getElementById('rdSwap');
    if (b && !b.hidden) { b.click(); return true; }
    return false;
  });
  console.log('切回原书:', swapped);
  await sleep(3500);
  await page.evaluate(() => document.querySelector('#rdStyleSeg .rd-seg-btn[data-style="original"]')?.click());
  await sleep(2000);
  for (const f of page.frames()) {
    try { await f.addStyleTag({ content: 'img{filter:blur(18px) saturate(.7)}'}); } catch (e) {}
  }
  await sleep(400);
  await shot('demo-13-before');

  const src = await page.evaluate(() => document.getElementById('rdSource')?.innerText);
  const meta = await page.evaluate(() => document.getElementById('rdMeta')?.innerText);
  console.log('当前来源:', src, '|', meta);

  await browser.close();
  console.log('完成');
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
