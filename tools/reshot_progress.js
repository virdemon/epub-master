/* 重截处理中页面：等真实进度到中间状态再按下快门 */
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

(async () => {
  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 1.5 });
  await page.goto('file:///' + path.join(ROOT, 'epubfix', 'index.html').replace(/\\/g, '/'), { waitUntil: 'load' });
  await sleep(600);

  await page.evaluate(() => { document.getElementById('fileInput').multiple = false; });
  const input = await page.$('#fileInput');
  await input.uploadFile(BOOK);
  await page.waitForSelector('#fileCard[data-ready="1"]', { timeout: 90000 });
  await sleep(400);

  await page.click('#startBtn2');

  // 轮询真实进度，落在 15%~75% 之间截图
  let shot = false;
  for (let i = 0; i < 400; i++) {
    await sleep(120);
    const st = await page.evaluate(() => {
      const pctEl = document.getElementById('progressPct');
      const msgEl = document.getElementById('progressMsg');
      const phaseEl = document.getElementById('progressPhase');
      if (!pctEl) return null;
      const txt = (pctEl.textContent || '').replace(/[^\d.]/g, '');
      return {
        pct: parseFloat(txt) || 0,
        msg: msgEl ? msgEl.textContent : '',
        phase: phaseEl ? phaseEl.textContent : ''
      };
    });
    if (!st) continue;
    if (!shot && st.pct >= 15 && st.pct <= 75) {
      await page.screenshot({ path: path.join(OUT, 'pc-processing.png') });
      console.log('✓ pc-processing.png @ ' + st.pct + '% — ' + (st.msg || st.phase));
      shot = true;
      break;
    }
  }

  if (!shot) {
    // 兜底：进度跳得太快就抓一次即时状态
    await page.screenshot({ path: path.join(OUT, 'pc-processing.png') });
    console.log('! 未捕捉到中间进度，已用当前状态兜底');
  }

  await browser.close();
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
