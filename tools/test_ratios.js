/* 实测：同一本书在不同压缩参数下的真实输出体积 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const BOOK = process.env.BOOK || 'C:\\Users\\wh\\Downloads\\成为被猎人们痴迷的心理医生.epub';
const DL = path.join(ROOT, 'test', 'ratio_out');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/');

function findBrowser() {
  for (const p of ['C:/Program Files/Google/Chrome/Application/chrome.exe',
                   'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'])
    if (fs.existsSync(p)) return p;
  throw new Error('找不到浏览器');
}

const CASES = [
  { name: 'A 默认（不重编码小图）', edge: 1600, q: 85 },
  { name: 'B 中等', edge: 1000, q: 80 },
  { name: 'C 强力', edge: 800, q: 72 },
  { name: 'D 极限', edge: 600, q: 60 },
];

(async () => {
  fs.mkdirSync(DL, { recursive: true });
  const origSize = fs.statSync(BOOK).size;
  const results = [];

  for (const c of CASES) {
    const browser = await puppeteer.launch({
      executablePath: findBrowser(),
      headless: 'new',
      args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files',
             '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=6144'],
      protocolTimeout: 2400000,
    });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1360, height: 860 });
      const client = await page.createCDPSession();
      await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });

      await page.goto(fileUrl(path.join(ROOT, 'epubfix', 'index.html')), { waitUntil: 'load' });
      await sleep(800);

      await page.evaluate(() => { document.getElementById('fileInput').multiple = false; });
      await (await page.$('#fileInput')).uploadFile(BOOK);
      await page.waitForSelector('#fileCard[data-ready="1"]', { timeout: 600000 });
      await sleep(700);

      await page.evaluate((edge, q) => {
        const e = document.getElementById('imgEdge');
        const qq = document.getElementById('imgQuality');
        e.value = edge; e.dispatchEvent(new Event('input', { bubbles: true }));
        qq.value = q; qq.dispatchEvent(new Event('input', { bubbles: true }));
      }, c.edge, c.q);
      await sleep(400);

      const t0 = Date.now();
      await page.click('#startBtn2');
      await page.waitForSelector('#resultCard:not([hidden])', { timeout: 2400000 });
      await sleep(1200);

      const stats = await page.evaluate(() => document.getElementById('statsRow')?.innerText || '');
      const sub = await page.evaluate(() => document.getElementById('resultSub')?.innerText || '');
      const dedupe = await page.evaluate(() => document.getElementById('dedupeSection')?.innerText || '');

      results.push({
        name: c.name, edge: c.edge, q: c.q,
        secs: ((Date.now() - t0) / 1000).toFixed(0),
        stats: stats.replace(/\n+/g, ' | '),
        sub: sub.replace(/\n+/g, ' '),
        dedupe: dedupe.replace(/\n+/g, ' ').slice(0, 200),
      });
      console.log('✓', c.name, '→', stats.replace(/\n+/g, ' | '));
    } catch (e) {
      console.log('✗', c.name, e.message);
    }
    await browser.close();
  }

  console.log('\n=== 汇总 ===');
  console.log('原书:', (origSize / 1048576).toFixed(2), 'MB');
  for (const r of results) console.log(r.name, '|', r.stats, '|', r.secs + 's');
  fs.writeFileSync(path.join(ROOT, 'test', 'ratio-results.json'),
    JSON.stringify({ origSize, results }, null, 2), 'utf8');
})();
