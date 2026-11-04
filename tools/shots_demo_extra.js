/* 补拍：高级设置里的输出格式选择器 + 纯文字章节的排版效果 */
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
  await page.addStyleTag({ content: BLUR });

  await page.evaluate(() => { document.getElementById('fileInput').multiple = false; });
  await (await page.$('#fileInput')).uploadFile(BOOK);
  await page.waitForSelector('#fileCard[data-ready="1"]', { timeout: 600000 });
  await sleep(900);

  // 展开高级设置
  const tabs = await page.evaluate(() =>
    [...document.querySelectorAll('button, [role=tab], .tab, .seg-btn')]
      .filter((b) => (b.innerText || '').trim() === '高级设置')
      .map((b) => (b.className || '').toString())
  );
  console.log('高级设置 tab:', tabs);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button, [role=tab], .tab, .seg-btn')]
      .find((x) => (x.innerText || '').trim() === '高级设置');
    if (b) b.click();
  });
  await sleep(900);
  await page.addStyleTag({ content: BLUR });

  // 滚到输出格式
  await page.evaluate(() => {
    const el = document.getElementById('verSeg');
    if (el) el.scrollIntoView({ block: 'center' });
  });
  await sleep(600);
  await shot('demo-3-format');

  // 预览原书，跳到纯文字章节
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(400);
  await page.click('#previewBookBtn');
  await page.waitForSelector('#reader:not([hidden])', { timeout: 60000 });
  await sleep(2500);

  const items = await page.evaluate(() => [...document.querySelectorAll('#rdToc li')].slice(0, 12).map((l) => l.innerText.trim()));
  console.log('目录前几项:', JSON.stringify(items));
  // 点第 4 个（通常是第 3 章，纯文字）
  const clicked = await page.evaluate(() => {
    const li = document.querySelectorAll('#rdToc li')[4];
    if (li) { li.click(); return li.innerText.trim(); }
    return null;
  });
  console.log('跳转章节:', clicked);
  await sleep(3000);
  for (const f of page.frames()) {
    try { await f.addStyleTag({ content: 'img{filter:blur(18px) saturate(.7)}' }); } catch (e) {}
  }
  await sleep(400);
  await shot('demo-8-reader');

  await browser.close();
  console.log('完成');
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
