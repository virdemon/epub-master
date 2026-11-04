/* 验证单文件版真的能跑：直接打开 dist 里那个 html，跑一次完整处理 */
const fs = require('fs'), path = require('path'), puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '..');
const FILE = process.argv[2] || path.join(ROOT, 'dist', 'epubfix-standalone.html');
const SAMPLE = process.argv[3] || path.join(ROOT, 'test', 'sample_book.epub');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
let fails = 0;
const ok = (c, l, e) => { console.log((c ? '  OK   ' : '  FAIL ') + l + (e !== undefined ? '  → ' + e : '')); if (!c) fails++; };

(async function () {
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: true, protocolTimeout: 600000,
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1360, height: 900 });
  const errs = [], ext = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('request', r => {
    const u = r.url();
    if (!/^(file:|data:|blob:|about:)/.test(u)) ext.push(u);
  });
  await page.goto('file://' + FILE.replace(/\\/g, '/'), { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 800));

  console.log('单文件版: ' + path.basename(FILE) + '　' + (fs.statSync(FILE).size / 1024).toFixed(0) + ' KB');
  const ui = await page.evaluate(() => ({
    brand: (document.querySelector('.brand-text strong') || {}).textContent,
    logoLoaded: (() => { const i = document.querySelector('.brand-mark'); return i && i.complete && i.naturalWidth > 0; })(),
    navCount: document.querySelectorAll('.nav-item').length,
    panel: !!document.querySelector('.panel'),
    hasApi: typeof EpubFix === 'object' && typeof EpubFix.process === 'function'
  }));
  ok(ui.hasApi, '引擎可用');
  ok(ui.brand === 'EPUB Master', '品牌名正确', ui.brand);
  ok(ui.logoLoaded, '图标已内联并且能显示');
  ok(ui.navCount === 6, '六项导航都在（含关于）', ui.navCount);
  ok(ui.panel, '右侧快捷设置栏存在');

  // 真实跑一次：导入 → 处理
  await page.evaluate(() => { document.getElementById('fileInput').multiple = false; });
  const inp = await page.$('#fileInput');
  await inp.uploadFile(SAMPLE);
  await page.waitForFunction(() => {
    const c = document.getElementById('fileCard');
    return c && !c.hidden && c.dataset.ready === '1';
  }, { timeout: 60000 });
  const card = await page.evaluate(() => ({
    title: document.getElementById('fileTitle').textContent,
    facts: document.getElementById('fileFacts').textContent,
    diag: document.getElementById('fileDiag').innerText.replace(/\n/g, ' ')
  }));
  console.log('  导入: ' + card.title + '　' + card.facts.replace(/　/g, ' '));
  ok(/万字/.test(card.facts), '字数按万字显示', (card.facts.match(/[\d.]+ 万字/) || [])[0]);

  await page.click('#startBtn2');
  await page.waitForFunction(() => !document.getElementById('resultCard').hidden ||
    !document.getElementById('errorCard').hidden, { timeout: 180000 });
  const res = await page.evaluate(() => ({
    err: !document.getElementById('errorCard').hidden,
    errText: document.getElementById('errorText').textContent,
    stats: document.getElementById('statsRow').innerText.replace(/\s+/g, ' ')
  }));
  ok(!res.err, '单文件版处理成功', res.err ? res.errText : '');
  console.log('  结果: ' + res.stats);
  await page.screenshot({ path: path.join(ROOT, 'test', 'standalone_new.png') });

  ok(errs.length === 0, '没有 JS 报错', errs.join(' | '));
  ok(ext.length === 0, '没有请求任何外部资源（离线可用）', ext.slice(0, 3).join(' '));
  await browser.close();
  console.log(fails ? `\n${fails} 项未通过` : '\n全部通过');
  process.exit(fails ? 1 : 0);
})().catch(function (e) {
  console.error('失败: ' + e.message);
  process.exit(1);
});
