/* 端到端：选文件 → 压缩 → 完成 → 返回键，全部走真实点击 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const WWW = path.resolve(__dirname, '../mobile/www');
const BOOK = path.resolve(__dirname, 'sample_book.epub');

function findBrowser() {
  const cands = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('找不到浏览器');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto('file:///' + path.join(WWW, 'index.html').replace(/\\/g, '/'), { waitUntil: 'networkidle0' });

  // 1. 选文件
  const input = await page.$('#file-input');
  await input.uploadFile(BOOK);
  await sleep(1500);

  const cfg = await page.evaluate(() => ({
    visible: !document.getElementById('screen-config').classList.contains('is-hidden'),
    name: document.getElementById('cfg-file-name').textContent,
    size: document.getElementById('cfg-file-size').textContent
  }));
  console.log('① 设置页:', JSON.stringify(cfg));

  // 2. 开始压缩
  await page.click('#btn-start');
  await sleep(600);
  const prog = await page.evaluate(() => ({
    visible: !document.getElementById('screen-progress').classList.contains('is-hidden'),
    status: document.getElementById('progress-status').textContent
  }));
  console.log('② 进度页:', JSON.stringify(prog));

  // 3. 等完成（最多 90 秒）
  let done = null;
  for (let i = 0; i < 180; i++) {
    await sleep(500);
    done = await page.evaluate(() => {
      const vis = !document.getElementById('screen-done').classList.contains('is-hidden');
      if (!vis) return null;
      return {
        before: document.getElementById('done-before').textContent,
        after: document.getElementById('done-after').textContent,
        saved: document.getElementById('done-saved').textContent,
        ratio: document.getElementById('done-ratio').textContent,
        loc: document.getElementById('done-location').textContent
      };
    });
    if (done) break;
  }
  console.log('③ 完成页:', JSON.stringify(done));
  await page.screenshot({ path: path.join(__dirname, 'ui_e2e_done.png') });

  // 4. 返回键：完成页应回主页而不是退出
  const backHandled = await page.evaluate(() => window.__emBack());
  await sleep(300);
  const backHome = await page.evaluate(() =>
    !document.getElementById('screen-home').classList.contains('is-hidden'));

  // 5. 主页再按返回 = 允许退出
  const homeBackHandled = await page.evaluate(() => window.__emBack());

  console.log('④ 完成页返回键: 已处理=' + backHandled + ' 已回主页=' + backHome);
  console.log('⑤ 主页返回键: 已处理=' + homeBackHandled + '（false 表示交给系统退出）');
  console.log('=== JS 错误 ===', errors.length ? errors : '无');

  await browser.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
