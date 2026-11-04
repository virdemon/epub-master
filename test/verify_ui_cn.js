/* 用真实 Edge 打开新 UI，检查中文界面渲染与 JS 报错，并截四页图 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const WWW = path.resolve(__dirname, '../mobile/www');
const OUT = __dirname;

function findBrowser() {
  const cands = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('找不到浏览器');
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto('file:///' + path.join(WWW, 'index.html').replace(/\\/g, '/'), {
    waitUntil: 'networkidle0'
  });

  const home = await page.evaluate(() => ({
    title: document.querySelector('.hero-title')?.textContent,
    sub: document.querySelector('.hero-subtitle')?.textContent,
    btn: document.getElementById('btn-choose')?.textContent,
    visible: !document.getElementById('screen-home').classList.contains('is-hidden')
  }));

  await page.screenshot({ path: path.join(OUT, 'ui_home_cn.png') });

  // 直接切到完成页看中文与返回按钮
  await page.evaluate(() => {
    window.__emBackTest = true;
    document.getElementById('screen-home').classList.add('is-hidden');
    document.getElementById('screen-done').classList.remove('is-hidden');
    document.getElementById('done-file-name').textContent = '示例书_compressed.epub';
    document.getElementById('done-before').textContent = '23.99 MB';
    document.getElementById('done-after').textContent = '5.69 MB';
    document.getElementById('done-saved').textContent = '-18.31 MB';
    document.getElementById('done-ratio').textContent = '76.3%';
    document.getElementById('done-location').textContent =
      '已保存到「下载/EPUB Master/示例书_compressed.epub」\n格式 EPUB 2.0，排版与章节保持原样';
  });
  await page.screenshot({ path: path.join(OUT, 'ui_done_cn.png') });

  const done = await page.evaluate(() => ({
    title: document.querySelector('.done-title')?.textContent,
    backBtn: !!document.getElementById('btn-done-back'),
    hasBack: document.getElementById('btn-done-back')?.getBoundingClientRect().width > 0,
    loc: document.getElementById('done-location')?.textContent
  }));

  // 返回键行为
  const backFromDone = await page.evaluate(() => window.__emBack());

  await browser.close();

  console.log('=== 主页 ===', JSON.stringify(home, null, 0));
  console.log('=== 完成页 ===', JSON.stringify(done, null, 0));
  console.log('完成页按返回键 -> 已处理?', backFromDone);
  console.log('=== JS 错误 ===', errors.length ? errors : '无');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
