/* 用《我能听到你的心声》重做全套截图：不模糊、排版对比统一阅读样式 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'images');
const BOOK = 'C:\\Users\\wh\\Downloads\\我能听到你的心声.epub';
const DL = path.join(ROOT, 'test', 'demo_out');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/');

function findBrowser() {
  for (const p of ['C:/Program Files/Google/Chrome/Application/chrome.exe',
                   'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'])
    if (fs.existsSync(p)) return p;
  throw new Error('找不到浏览器');
}

(async () => {
  fs.mkdirSync(DL, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files',
           '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=6144'],
    protocolTimeout: 2400000,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1360, height: 860, deviceScaleFactor: 1.6 });
  const client = await page.createCDPSession();
  await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });

  const shot = async (n) => { await page.screenshot({ path: path.join(OUT, n + '.png') }); console.log('  ✓', n); };
  const log = (...a) => console.log(...a);

  await page.goto(fileUrl(path.join(ROOT, 'epubfix', 'index.html')), { waitUntil: 'load' });
  await sleep(900);

  log('导入《我能听到你的心声》...');
  await page.evaluate(() => { document.getElementById('fileInput').multiple = false; });
  await (await page.$('#fileInput')).uploadFile(BOOK);
  await page.waitForSelector('#fileCard[data-ready="1"]', { timeout: 900000 });
  await sleep(1500);
  await shot('demo-2-import');

  log('选 EPUB 2.0...');
  await page.evaluate(() => {
    var tab = document.querySelector('.tab[data-tab="adv"]');
    if (tab) tab.click();
  });
  await sleep(900);
  await page.evaluate(() => document.querySelector('#verSeg .seg-btn[data-ver="2"]')?.click());
  await sleep(500);
  await page.evaluate(() => {
    var seg = document.getElementById('verSeg');
    if (seg) seg.scrollIntoView({ block: 'center' });
  });
  await sleep(900);
  await shot('demo-3-format');
  // 截完切回处理规则，后面的流程和进度条按默认视图走
  await page.evaluate(() => {
    var tab = document.querySelector('.tab[data-tab="rule"]') || document.querySelectorAll('.tab')[0];
    if (tab) tab.click();
  });
  await sleep(600);

  const t0 = Date.now();
  await page.click('#startBtn2');
  for (let i = 0; i < 600; i++) {
    await sleep(400);
    const t = await page.evaluate(() => document.body.innerText.match(/(\d{1,3})\s*%/)?.[1] || '');
    const n = parseInt(t);
    if (n >= 18 && n <= 72) { await shot('demo-4-progress'); log('进度', n + '%'); break; }
  }

  await page.waitForSelector('#resultCard:not([hidden])', { timeout: 2400000 });
  await sleep(2000);
  log('耗时', ((Date.now() - t0) / 1000).toFixed(0) + 's');

  await page.evaluate(() => document.getElementById('resultCard').scrollIntoView({ block: 'start' }));
  await sleep(800);
  await shot('demo-5-result-top');

  const top = await page.evaluate(() => ({
    sub: document.getElementById('resultSub')?.innerText,
    stats: document.getElementById('statsRow')?.innerText,
    ver: document.getElementById('verBox')?.innerText,
  }));
  log('结果:', JSON.stringify(top, null, 1));

  await page.evaluate(() => document.getElementById('dedupeSection')?.scrollIntoView({ block: 'start' }));
  await sleep(800);
  await shot('demo-6-result-mid');

  await page.evaluate(() => document.getElementById('auditSection')?.scrollIntoView({ block: 'start' }));
  await sleep(800);
  await shot('demo-7-result-audit');

  const audit = await page.evaluate(() => document.getElementById('auditList')?.innerText || '');
  const dedupe = await page.evaluate(() => document.getElementById('dedupeSection')?.innerText || '');
  fs.writeFileSync(path.join(ROOT, 'test', 'demo-data-2.txt'),
    JSON.stringify({ top, dedupe, audit }, null, 2), 'utf8');

  log('保存...');
  try { await page.click('#saveBtn'); await sleep(20000); } catch (e) { log('保存失败', e.message); }

  log('打开预览...');
  await page.click('#previewBtn');
  await page.waitForSelector('#reader:not([hidden])', { timeout: 90000 });
  await sleep(4000);

  const tocCount = await page.evaluate(() => document.querySelectorAll('#rdToc li').length);
  log('目录项:', tocCount);

  // 跳到中段一个正文章节
  const ch = await page.evaluate(() => {
    const lis = [...document.querySelectorAll('#rdToc li')];
    const target = lis[Math.min(8, lis.length - 1)];
    if (target) { target.click(); return target.innerText.trim(); }
    return null;
  });
  log('章节:', ch);
  await sleep(4500);

  // 阅读样式（当前是处理结果）
  await page.evaluate(() => document.querySelector('#rdStyleSeg .rd-seg-btn[data-style="reading"]')?.click());
  await sleep(3000);
  const src1 = await page.evaluate(() => document.getElementById('rdSource')?.innerText);
  log('来源1:', src1);
  if (String(src1).indexOf('原书') >= 0) await shot('demo-13-before');
  else await shot('demo-12-after');

  // 切到另一份，停在同章，保持阅读样式
  const swapped = await page.evaluate(() => {
    const b = document.getElementById('rdSwap');
    if (b && !b.hidden) { b.click(); return true; }
    return false;
  });
  log('切换:', swapped);
  await sleep(5000);
  await page.evaluate(() => document.querySelector('#rdStyleSeg .rd-seg-btn[data-style="reading"]')?.click());
  await sleep(3000);
  const src2 = await page.evaluate(() => document.getElementById('rdSource')?.innerText);
  log('来源2:', src2);
  if (String(src2).indexOf('原书') >= 0) await shot('demo-13-before');
  else await shot('demo-12-after');

  // 图片浏览（原图，不模糊）
  await page.evaluate(() => document.querySelector('#rdModeSeg .rd-seg-btn[data-mode="images"]')?.click());
  await sleep(7000);
  await shot('demo-9-gallery');
  const galSum = await page.evaluate(() => document.querySelector('.gal-sum')?.innerText);
  log('画廊:', galSum);

  const opened = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#galGrid .gal-card')];
    if (!cards.length) return 0;
    cards[Math.min(9, cards.length - 1)].click();
    return cards.length;
  });
  log('卡片数:', opened);
  await sleep(3500);
  await shot('demo-10-lightbox');

  await browser.close();
  log('完成');
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
