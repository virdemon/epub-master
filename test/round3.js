/* 第三轮改动的冒烟测试：先确认页面能起来、没有报错，再逐项功能验证 */
const fs = require('fs'), path = require('path'), http = require('http'), puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'epubfix');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml'
};

let bad = 0;
const ok = (c, m, d) => { console.log((c ? '  OK   ' : '  FAIL ') + m + (d !== undefined ? ' — ' + d : '')); if (!c) bad++; };

const server = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') u = '/index.html';
  const f = path.join(DIR, u);
  if (!f.startsWith(DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const b = await puppeteer.launch({ executablePath: EDGE, headless: true, protocolTimeout: 600000, args: ['--no-sandbox'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900 });

  const errs = [];
  p.on('pageerror', e => errs.push(String(e.message || e)));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await p.goto(base + '/index.html', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 800));
  ok(errs.length === 0, '首屏无 JS 报错', errs.slice(0, 3).join(' | ') || undefined);

  // 结构：首页不该再有品牌横幅、底部快捷条；工具箱不该有批量处理
  const layout = await p.evaluate(() => ({
    hero: !!document.querySelector('.hero'),
    quicktools: !!document.querySelector('.quicktools'),
    batchTool: !!document.querySelector('#toolGrid [data-tool="batch"]'),
    activeView: (document.querySelector('.view.is-active') || {}).id,
    navItems: [...document.querySelectorAll('.nav-item')].map(b => b.dataset.view),
    hasAbout: !!document.getElementById('view-about'),
    hasReader: !!document.getElementById('reader')
  }));
  ok(!layout.hero, '首页不再有品牌横幅');
  ok(!layout.quicktools, '首页不再有底部快捷工具条');
  ok(!layout.batchTool, '工具箱不再重复「批量处理」入口');
  ok(layout.activeView === 'view-home', '默认停在首页', layout.activeView);
  ok(layout.navItems.includes('about') && layout.hasAbout, '关于页存在且在导航里');
  ok(layout.hasReader, '阅读窗口节点存在');

  // 分卷默认关闭
  const vol = await p.evaluate(() => ({
    checked: document.getElementById('optVolume').checked,
    optsHidden: document.getElementById('volumeOpts').hidden,
    panel: document.getElementById('panelVolume').textContent
  }));
  ok(!vol.checked && vol.optsHidden, '分卷开关默认关闭且目标体积被收起', JSON.stringify(vol));
  ok(/关闭/.test(vol.panel), '右栏显示分卷关闭', vol.panel);

  // 打开高级设置 → 打开分卷 → 选项出现
  await p.evaluate(() => {
    document.querySelector('.tab[data-tab="adv"]').click();
  });
  await new Promise(r => setTimeout(r, 200));
  const advVisible = await p.evaluate(() => !document.getElementById('advPane').classList.contains('is-active') ? 'pane隐藏' : document.getElementById('optVolume') ? 'ok' : 'missing');
  ok(advVisible === 'ok', '高级设置里有分卷开关', advVisible);

  await p.evaluate(() => {
    const cb = document.getElementById('optVolume');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 200));
  const afterOn = await p.evaluate(() => ({
    hidden: document.getElementById('volumeOpts').hidden,
    panel: document.getElementById('panelVolume').textContent,
    hasSplit: !!document.querySelector('#splitLevelSeg .seg-btn'),
    hasTarget: !!document.querySelector('#targetSeg .seg-btn')
  }));
  ok(!afterOn.hidden && afterOn.hasSplit && afterOn.hasTarget, '开启分卷后切分方式与目标体积出现', JSON.stringify(afterOn));
  ok(/自动/.test(afterOn.panel), '右栏同步显示分卷上限', afterOn.panel);

  // 关回去
  await p.evaluate(() => {
    const cb = document.getElementById('optVolume');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 150));

  // 关于页
  await p.evaluate(() => document.getElementById('aboutBtn').click());
  await new Promise(r => setTimeout(r, 300));
  const about = await p.evaluate(() => ({
    active: (document.querySelector('.view.is-active') || {}).id,
    title: (document.querySelector('#view-about h1') || {}).textContent,
    runtime: (document.getElementById('aboutRuntime') || {}).textContent,
    deps: document.querySelectorAll('#view-about .about-item').length
  }));
  ok(about.active === 'view-about', '关于按钮切到关于页', about.active);
  ok(/EPUB Master/.test(about.title || ''), '关于页显示应用名', about.title);
  ok(about.deps >= 4, '关于页列出核心功能', about.deps + ' 条');

  // 更新检查：如实说明没有更新服务器
  await p.evaluate(() => document.getElementById('checkUpdateBtn').click());
  await new Promise(r => setTimeout(r, 300));
  const upd = await p.evaluate(() => document.getElementById('updateNote').textContent);
  ok(/没有配置更新服务器|离线构建/.test(upd), '更新检查如实说明（不假报成功）', upd.slice(0, 40));

  // 输出目录默认值
  const dir = await p.evaluate(() => ({
    text: document.getElementById('dirText').textContent,
    ph: document.getElementById('setDir').placeholder
  }));
  ok(/EPUB_Master/.test(dir.text + dir.ph), '默认输出目录指向 EPUB_Master', dir.text + ' / ' + dir.ph);

  await p.screenshot({ path: path.join(ROOT, 'test', 'r3_about.png') });
  await b.close(); server.close();
  console.log(bad === 0 ? '\n冒烟测试通过' : '\n有 ' + bad + ' 项未通过');
  process.exit(bad === 0 ? 0 : 1);
});
