/* 设置是否真的存下来：改 → 保存 → 刷新 → 再读 */
const fs = require('fs'), path = require('path'), puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '..');
const PAGE = 'file://' + path.join(ROOT, 'epubfix', 'index.html').replace(/\\/g, '/');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
let fails = 0;
const ok = (c, l, e) => { console.log((c ? '  OK   ' : '  FAIL ') + l + (e !== undefined ? '  → ' + e : '')); if (!c) fails++; };
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: true,
    args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto(PAGE, { waitUntil: 'load' });
  await wait(500);

  console.log('\n[1] 改设置并保存');
  await p.evaluate(() => document.querySelector('.nav-item[data-view="settings"]').click());
  await wait(200);
  await p.select('#setMode', 'extreme');
  await p.$eval('#setEdge', el => { el.value = '1200'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.$eval('#setQuality', el => { el.value = '72'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.$eval('#setConcurrency', el => { el.value = '2'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.evaluate(() => { const c = document.getElementById('setFonts'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); });
  await p.evaluate(() => document.getElementById('saveSettingsBtn').click());
  await wait(400);
  const toastTxt = await p.evaluate(() => (document.querySelector('.toast') || {}).textContent || '');
  console.log('    提示:', toastTxt || '（无）');
  const stored = await p.evaluate(() => JSON.parse(localStorage.getItem('epubmaster.settings.v1') || '{}'));
  console.log('    已写入:', JSON.stringify(stored));
  ok(stored.mode === 'extreme' && stored.edge === 1200 && stored.quality === 72 && stored.concurrency === 2 && stored.fonts === true,
    '设置写进了 localStorage');

  console.log('\n[2] 刷新后仍然生效');
  await p.reload({ waitUntil: 'load' });
  await wait(600);
  const back = await p.evaluate(() => ({
    mode: document.getElementById('setMode').value,
    edge: document.getElementById('setEdge').value,
    quality: document.getElementById('setQuality').value,
    conc: document.getElementById('setConcurrency').value,
    fonts: document.getElementById('setFonts').checked,
    homeMode: (document.querySelector('.mode-btn.is-active') || {}).getAttribute
      ? document.querySelector('.mode-btn.is-active').getAttribute('data-mode') : '',
    panelEdge: document.getElementById('imgEdge').value,
    panelQuality: document.getElementById('imgQuality').value
  }));
  console.log('    ', JSON.stringify(back));
  ok(back.mode === 'extreme', '默认模式记住了', back.mode);
  ok(back.edge === '1200', '默认图片最长边记住了', back.edge);
  ok(back.quality === '72', '默认图片质量记住了', back.quality);
  ok(back.conc === '2', '并发数记住了', back.conc);
  ok(back.fonts === true, '移除字体选项记住了');
  ok(back.homeMode === 'extreme', '首页右栏沿用了默认模式', back.homeMode);
  ok(back.panelEdge === '1200' && back.panelQuality === '72', '首页滑块跟着设置走', back.panelEdge + '/' + back.panelQuality);

  console.log('\n[3] 恢复默认，别污染后面的测试');
  await p.evaluate(() => document.querySelector('.nav-item[data-view="settings"]').click());
  await wait(150);
  await p.select('#setMode', 'deep');
  await p.$eval('#setEdge', el => { el.value = '1600'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.$eval('#setQuality', el => { el.value = '85'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.$eval('#setConcurrency', el => { el.value = '1'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.evaluate(() => { const c = document.getElementById('setFonts'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); });
  await p.evaluate(() => document.getElementById('saveSettingsBtn').click());
  await wait(300);
  const reset = await p.evaluate(() => JSON.parse(localStorage.getItem('epubmaster.settings.v1') || '{}'));
  ok(reset.mode === 'deep', '已恢复默认模式', reset.mode);

  console.log('\n' + (errs.length ? '报错: ' + errs.join(' | ') : '无 JS 报错'));
  console.log(fails ? `\n${fails} 项未通过` : '\n全部通过');
  await b.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('崩: ' + e.stack); process.exit(1); });
