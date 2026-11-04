/* 真实书完整演示：EPUB 3 原书 → 输出 EPUB 2，全程截图（插图模糊处理） */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'images');
const BOOK = 'C:\\Users\\wh\\Downloads\\成为被猎人们痴迷的心理医生.epub';
const DL = path.join(ROOT, 'test', 'out2');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/');

// 封面/插图一律模糊，避免把书里的成人内容带进公开仓库
const BLUR = `
  .gal-thumb, .gal-thumb img, .gal-card img { filter: blur(18px) saturate(.7); transform: scale(1.02); }
  #lbImg, #lbImgB { filter: blur(18px) saturate(.7); }
  #coverImg { filter: blur(18px); }
`;

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

  const shot = async (n) => {
    await page.screenshot({ path: path.join(OUT, n + '.png') });
    console.log('  ✓', n);
  };
  const log = (...a) => console.log(...a);

  await page.goto(fileUrl(path.join(ROOT, 'epubfix', 'index.html')), { waitUntil: 'load' });
  await sleep(900);
  await page.addStyleTag({ content: BLUR });
  await shot('demo-1-home');

  log('导入真实书...');
  await page.evaluate(() => { document.getElementById('fileInput').multiple = false; });
  await (await page.$('#fileInput')).uploadFile(BOOK);
  await page.waitForSelector('#fileCard[data-ready="1"]', { timeout: 600000 });
  await sleep(1000);
  await page.addStyleTag({ content: BLUR });
  await shot('demo-2-import');

  // 输出格式选 EPUB 2.0
  const verOk = await page.evaluate(() => {
    const b = document.querySelector('#verSeg .seg-btn[data-ver="2"]');
    if (b) { b.click(); return true; }
    return false;
  });
  log('切 EPUB 2.0:', verOk);
  await sleep(600);
  await shot('demo-3-format');

  // 开始处理
  const t0 = Date.now();
  await page.click('#startBtn2');
  for (let i = 0; i < 400; i++) {
    await sleep(500);
    const t = await page.evaluate(() => document.body.innerText.match(/\d{1,3}\s*%/)?.[0] || '');
    if (t && parseInt(t) >= 20 && parseInt(t) <= 70) { await shot('demo-4-progress'); log('进度', t); break; }
    if (!t && i > 30) { await shot('demo-4-progress'); break; }
  }

  await page.waitForSelector('#resultCard:not([hidden])', { timeout: 2400000 });
  await sleep(1500);
  log('耗时', ((Date.now() - t0) / 1000).toFixed(0) + 's');

  // 结果页顶部
  await page.evaluate(() => document.getElementById('resultCard').scrollIntoView({ block: 'start' }));
  await sleep(700);
  await page.addStyleTag({ content: BLUR });
  await shot('demo-5-result-top');

  const top = await page.evaluate(() => ({
    sub: document.getElementById('resultSub')?.innerText,
    stats: document.getElementById('statsRow')?.innerText,
    ver: document.getElementById('verBox')?.innerText,
  }));
  log('结果顶部:', JSON.stringify(top, null, 1));

  // 结果页中部（资源分析 + 重复清理）
  await page.evaluate(() => document.getElementById('dedupeSection')?.scrollIntoView({ block: 'start' }));
  await sleep(700);
  await shot('demo-6-result-mid');

  // 审计
  await page.evaluate(() => document.getElementById('auditSection')?.scrollIntoView({ block: 'start' }));
  await sleep(700);
  await shot('demo-7-result-audit');

  const audit = await page.evaluate(() => document.getElementById('auditList')?.innerText);
  fs.writeFileSync(path.join(ROOT, 'test', 'demo-data.txt'),
    JSON.stringify({ top, audit }, null, 2), 'utf8');

  // 保存
  try { await page.click('#saveBtn'); await sleep(15000); } catch (e) { log('保存失败', e.message); }

  // 预览：阅读
  await page.click('#previewBtn');
  await page.waitForSelector('#reader:not([hidden])', { timeout: 60000 });
  await sleep(3500);
  const frames = page.frames();
  for (const f of frames) {
    try { await f.addStyleTag({ content: 'img{filter:blur(18px) saturate(.7);transform:scale(1.02)}' }); } catch (e) {}
  }
  await sleep(500);
  await shot('demo-8-reader');

  // 图片浏览
  await page.evaluate(() => document.querySelector('#rdModeSeg .rd-seg-btn[data-mode="images"]').click());
  await sleep(4500);
  await page.addStyleTag({ content: BLUR });
  await shot('demo-9-gallery');
  const galSum = await page.evaluate(() => document.querySelector('.gal-sum')?.innerText);
  log('画廊统计:', galSum);

  // 打开一张中等大小的图
  const thumbInfo = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#galGrid .gal-card')];
    if (!cards.length) return 0;
    cards[Math.min(8, cards.length - 1)].click();
    return cards.length;
  });
  log('画廊卡片数:', thumbInfo);
  await sleep(3000);
  await page.addStyleTag({ content: BLUR });
  await shot('demo-10-lightbox');

  const lb = await page.evaluate(() => ({
    name: document.getElementById('lbName')?.innerText,
    meta: document.getElementById('lbMeta')?.innerText,
    foot: document.getElementById('lbFoot')?.innerText,
    capA: document.getElementById('lbCapA')?.innerText,
    capB: document.getElementById('lbCapB')?.innerText,
  }));
  log('灯箱:', JSON.stringify(lb, null, 1));

  // 对比原图
  await page.evaluate(() => document.getElementById('lbCompare')?.click());
  await sleep(3500);
  await page.addStyleTag({ content: BLUR });
  await shot('demo-11-compare');

  fs.appendFileSync(path.join(ROOT, 'test', 'demo-data.txt'), '\n' + JSON.stringify({ galSum, lb }, null, 2), 'utf8');

  await browser.close();
  log('完成');
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
