/* 单独压批量：看它是慢、是卡，还是死循环 */
const fs = require('fs'), path = require('path'), puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '..');
const PAGE = 'file://' + path.join(ROOT, 'epubfix', 'index.html').replace(/\\/g, '/');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: true, protocolTimeout: 600000,
    args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const p = await b.newPage();
  const logs = [];
  p.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
  p.on('console', m => logs.push(m.type() + ' ' + m.text()));
  await p.goto(PAGE, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 500));

  await p.evaluate(() => document.querySelector('.nav-item[data-view="batch"]').click());
  await p.evaluate(() => { document.getElementById('fileInput').multiple = true; });
  const inp = await p.$('#fileInput');
  await inp.uploadFile(path.join(ROOT, 'test/sample_web.epub'), path.join(ROOT, 'test/sample_broken.epub'));
  await p.waitForFunction(() => document.querySelectorAll('#batchBody tr').length >= 2, { timeout: 30000 });
  console.log('队列就绪');

  const t = Date.now();
  await p.evaluate(() => document.getElementById('batchStartBtn').click());

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const st = await p.evaluate(() => ({
      rows: [...document.querySelectorAll('#batchBody tr')].map(tr =>
        tr.children[4].innerText.trim() + ':' + tr.children[5].innerText.trim()),
      running: window.__em.state.batchRunning,
      btn: document.getElementById('batchStartBtn').disabled
    })).catch(e => ({ err: e.message }));
    console.log(((Date.now() - t) / 1000).toFixed(0) + 's', JSON.stringify(st));
    if (st.rows && st.rows.every(r => /完成|失败|跳过/.test(r)) && !st.running) break;
  }
  console.log('日志:', logs.slice(-8).join('\n      ') || '无');
  await p.screenshot({ path: path.join(ROOT, 'test', 'batch_probe.png') });
  await b.close();
  process.exit(0);
})().catch(e => { console.error('崩: ' + e.message); process.exit(1); });
