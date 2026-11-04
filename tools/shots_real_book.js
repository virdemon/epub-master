/* 用真实书跑完整流程并截图：导入 → 配置 → 处理 → 结果 → 预览（正文/图片墙/大图/对比） */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'images');
const BOOK = 'C:\\Users\\wh\\Downloads\\成为被猎人们痴迷的心理医生.epub';
const DL = path.join(ROOT, 'test', 'out');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/');

function findBrowser() {
  const c = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ];
  for (const p of c) if (fs.existsSync(p)) return p;
  throw new Error('找不到浏览器');
}

(async () => {
  fs.mkdirSync(DL, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-gpu', '--allow-file-access-from-files',
      '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=6144',
    ],
    protocolTimeout: 1800000,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1360, height: 860, deviceScaleFactor: 1.6 });

  const client = await page.createCDPSession();
  await client.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DL,
    eventsEnabled: true,
  });

  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, name + '.png') });
    console.log('  ✓', name + '.png');
  };

  await page.goto(fileUrl(path.join(ROOT, 'epubfix', 'index.html')), { waitUntil: 'load' });
  await sleep(1000);

  // 1 首页
  await shot('real-1-home');

  // 2 导入
  console.log('导入...');
  await page.evaluate(() => { document.getElementById('fileInput').multiple = false; });
  const input = await page.$('#fileInput');
  await input.uploadFile(BOOK);
  await page.waitForSelector('#fileCard[data-ready="1"]', { timeout: 300000 });
  await sleep(900);
  const cardInfo = await page.evaluate(() => document.getElementById('fileCard').innerText);
  console.log('--- 卡片信息 ---\n' + cardInfo);
  await shot('real-2-import');

  // 3 设置区（滚到图片参数）
  await page.evaluate(() => {
    const el = document.getElementById('imgEdge');
    if (el) el.closest('.card, .field, section')?.scrollIntoView({ block: 'center' });
  });
  await sleep(600);
  await shot('real-3-config');
  await page.evaluate(() => window.scrollTo(0, 0));

  // 4 处理
  console.log('开始处理...');
  const t0 = Date.now();
  await page.click('#startBtn2');

  // 进度截图：等到 12%~45%
  let gotProgress = false;
  for (let i = 0; i < 240; i++) {
    await sleep(1000);
    const p = await page.evaluate(() => {
      const el = document.querySelector('[id*=progress], .progress-fill, .pg-fill');
      return el ? (el.style.width || el.getAttribute('aria-valuenow') || '') : '';
    });
    const txt = await page.evaluate(() => document.body.innerText.match(/\d{1,3}\s*%/)?.[0] || '');
    if (i === 12 || /[2-5]\d\s*%/.test(txt)) {
      await shot('real-4-progress');
      gotProgress = true;
      console.log('  进度:', txt, p);
      break;
    }
  }
  if (!gotProgress) await shot('real-4-progress');

  // 5 等结果
  await page.waitForSelector('#resultCard:not([hidden])', { timeout: 1500000 });
  await sleep(1200);
  console.log('处理耗时: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  const resultText = await page.evaluate(() => document.getElementById('resultCard').innerText);
  fs.writeFileSync(path.join(ROOT, 'test', 'result.txt'), resultText, 'utf8');
  console.log('--- 结果页 ---\n' + resultText.slice(0, 2000));
  await shot('real-5-result');

  // 6 保存产物
  try {
    await page.click('#saveBtn');
    await sleep(12000);
  } catch (e) { console.log('保存失败', e.message); }

  // 7 预览正文
  await page.click('#previewBtn');
  await page.waitForSelector('#reader:not([hidden])', { timeout: 60000 });
  await sleep(3000);
  await shot('real-6-reader');

  // 8 图片浏览
  const okGal = await page.evaluate(() => {
    const b = document.querySelector('#rdModeSeg .rd-seg-btn[data-mode="images"]');
    if (!b) return false;
    b.click();
    return true;
  });
  console.log('切图片浏览:', okGal);
  await sleep(4000);
  await shot('real-7-gallery');

  // 9 打开一张大图（尽量挑尺寸大的）
  const opened = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#rdGallery .gal-item, #rdGallery button, #rdGallery figure')];
    if (!items.length) return 0;
    items[Math.min(1, items.length - 1)].click();
    return items.length;
  });
  console.log('画廊项目数:', opened);
  await sleep(3000);
  await shot('real-8-lightbox');

  // 10 对比原图
  const cmp = await page.evaluate(() => {
    const b = document.getElementById('lbCompare');
    if (!b) return false;
    b.click();
    return true;
  });
  console.log('对比原图:', cmp);
  await sleep(3500);
  await shot('real-9-compare');

  const meta = await page.evaluate(() => ({
    name: document.getElementById('lbName')?.innerText,
    metaA: document.getElementById('lbMeta')?.innerText,
    foot: document.getElementById('lbFoot')?.innerText,
    capA: document.getElementById('lbCapA')?.innerText,
    capB: document.getElementById('lbCapB')?.innerText,
  }));
  console.log('灯箱信息:', JSON.stringify(meta, null, 1));

  fs.writeFileSync(path.join(ROOT, 'test', 'shots-meta.json'), JSON.stringify({ cardInfo, resultText, meta }, null, 2), 'utf8');

  await browser.close();
  console.log('完成');
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
