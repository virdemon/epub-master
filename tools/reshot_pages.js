/* 重截工具箱 / 批量 / 设置三页，确保版本号是 1.2 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'images');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1360, height: 860, deviceScaleFactor: 1.6 });
  await page.goto(fileUrl(path.join(ROOT, 'epubfix', 'index.html')), { waitUntil: 'load' });
  await sleep(900);

  const clickNav = async (label) => {
    const ok = await page.evaluate((t) => {
      const els = [...document.querySelectorAll('.side-nav a, .nav-item, aside a, aside button, .sidebar a, .sidebar button')];
      const hit = els.find((e) => (e.innerText || '').trim().indexOf(t) >= 0);
      if (hit) { hit.click(); return true; }
      const all = [...document.querySelectorAll('a,button,li,div')];
      const any = all.find((e) => (e.innerText || '').trim() === t && e.offsetParent);
      if (any) { any.click(); return true; }
      return false;
    }, label);
    await sleep(1200);
    return ok;
  };

  for (const [label, file] of [['工具箱', 'pc-tools'], ['批量处理', 'pc-batch'], ['设置', 'pc-settings']]) {
    const ok = await clickNav(label);
    await sleep(900);
    await page.screenshot({ path: path.join(OUT, file + '.png') });
    console.log(ok ? '✓' : '✗', label, '->', file + '.png');
  }

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
