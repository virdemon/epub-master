/* 打开新界面：抓控制台报错，截屏各页面 */
const fs = require('fs'), path = require('path'), puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '..');
const PAGE = 'file://' + path.join(ROOT, 'epubfix', 'index.html').replace(/\\/g, '/');
const EDGE = 'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: true,
    args: ['--no-sandbox', '--allow-file-access-from-files', '--window-size=1440,940'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 940 });
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
  await p.goto(PAGE, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 700));

  const info = await p.evaluate(() => ({
    modeDesc: (document.getElementById('modeDesc') || {}).textContent,
    modeParams: (document.getElementById('modeParams') || {}).textContent,
    activeMode: (document.querySelector('.mode-btn.is-active') || {}).dataset,
    panelVisible: getComputedStyle(document.querySelector('.panel')).display,
    hasApi: !!window.__em,
    est: (document.getElementById('estSize') || {}).textContent
  }));
  console.log('模式默认:', JSON.stringify(info.activeMode), '| 描述:', info.modeDesc);
  console.log('参数表:', info.modeParams);
  console.log('面板:', info.panelVisible, '| API:', info.hasApi, '| 估算:', info.est);

  await p.screenshot({ path: path.join(ROOT, 'test', 'ui2_home.png') });

  // 切到各页面截图
  for (const v of ['batch', 'history', 'tools', 'settings']) {
    await p.evaluate(x => { document.querySelector(`.nav-item[data-view="${x}"]`).click(); }, v);
    await new Promise(r => setTimeout(r, 260));
    await p.screenshot({ path: path.join(ROOT, 'test', 'ui2_' + v + '.png') });
  }

  console.log(errs.length ? '\n报错:\n' + errs.join('\n') : '\n无 JS 报错');
  await b.close();
})().catch(e => { console.error('失败: ' + e.message); process.exit(1); });
