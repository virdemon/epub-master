/* 打开真正的线上链接，跑一本，确认部署后的站点是能用的，而不只是 HTML 换了 */
const fs = require('fs'), path = require('path'), puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '..');
const URL = process.env.LIVE_URL || 'https://epub-fix.app.workbuddy.host/?sharecode=FOPVKGEZQ4';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

let bad = 0;
const ok = (c, m, d) => { console.log((c ? '  OK   ' : '  FAIL ') + m + (d !== undefined ? ' — ' + d : '')); if (!c) bad++; };

(async () => {
  console.log('线上地址', URL);
  const b = await puppeteer.launch({ executablePath: EDGE, headless: true, protocolTimeout: 600000, args: ['--no-sandbox'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900 });

  const errs = [], bad40x = [];
  p.on('pageerror', e => errs.push(String(e.message || e)));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  p.on('response', r => { if (r.status() >= 400) bad40x.push(r.status() + ' ' + r.url()); });

  const t = Date.now();
  const resp = await p.goto(URL, { waitUntil: 'networkidle2', timeout: 90000 });
  await new Promise(r => setTimeout(r, 1200));
  console.log('  加载耗时', Date.now() - t, 'ms | 状态', resp.status());

  ok(resp.status() === 200, '线上页面返回 200');
  ok(bad40x.length === 0, '样式/脚本/图标都能取到', bad40x.join(' , ') || undefined);
  ok(errs.length === 0, '无 JS 报错', errs.slice(0, 2).join(' | ') || undefined);

  const brand = await p.evaluate(() => {
    const sp = document.querySelector('.brand-text span');
    const st = document.querySelector('.brand-text strong');
    return {
    title: st ? st.innerText.trim() : '',
    sub: sp ? sp.innerText.trim() : '',
    subClipped: sp ? sp.scrollWidth > sp.clientWidth + 1 : true,
    nav: [...document.querySelectorAll('.nav-item')].map(x => x.innerText.trim()).filter(Boolean),
    docTitle: document.title,
    api: typeof (window.EpubFix || {}).process,
    logo: (() => { const i = document.querySelector('img[src*="icon.svg"]'); return i ? i.naturalWidth : 0; })()
    };
  });
  ok(brand.title === 'EPUB Master' && /更轻 · 更美 · 更好读/.test(brand.sub), '侧栏是新品牌与副标题',
    brand.title + ' / ' + brand.sub);
  ok(!brand.subClipped, '副标题没有被截断（不出现省略号）');
  ok((brand.docTitle || '').length > 0, '页面标题', brand.docTitle);
  ok(brand.nav.length >= 5, '左导航五项都在', brand.nav.join(' / '));
  ok(brand.api === 'function', '引擎在线上可用', 'process=' + brand.api);
  ok(brand.logo > 0, '图标线上可见', brand.logo + 'px');

  // 跑一本真书
  const b64 = fs.readFileSync(path.join(ROOT, 'test', 'sample_book.epub')).toString('base64');
  const run = await p.evaluate(async (data) => {
    const bin = atob(data); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], '雾中渡口.epub', { type: 'application/epub+zip' });
    const dt = new DataTransfer(); dt.items.add(file);
    document.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
    document.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));

    for (let i = 0; i < 150; i++) {
      const c = document.getElementById('fileCard');
      if (c && !c.hidden && c.dataset.ready === '1') break;
      await new Promise(r => setTimeout(r, 200));
    }
    const facts = (document.getElementById('fileFacts') || {}).innerText || '';
    document.getElementById('startBtn2').click();
    for (let i = 0; i < 300; i++) {
      if (!window.__em.state.busy && window.__em.state.result) break;
      await new Promise(r => setTimeout(r, 300));
    }
    const r = window.__em.state.result;
    const rep = r && r.res && r.res.report ? r.res.report : null;

    // 预览：缩进和加粗是不是真的生效
    document.getElementById('previewBtn') && document.getElementById('previewBtn').click();
    for (let i = 0; i < 120; i++) {
      const f = document.getElementById('rdFrame');
      if (f && f.contentDocument && f.contentDocument.querySelectorAll('p').length) break;
      await new Promise(r => setTimeout(r, 250));
    }
    const d = document.getElementById('rdFrame').contentDocument;
    const ps = [...d.querySelectorAll('p')].filter(x => (x.textContent || '').trim().length > 10);
    const ind = ps.length ? getComputedStyle(ps[0]).textIndent : '—';
    const strongs = [...d.querySelectorAll('strong, b')];
    return {
      facts: facts.replace(/\n/g, ' · ').slice(0, 80),
      haveResult: !!rep,
      inB: rep ? rep.inputBytes : 0, outB: rep ? rep.outputBytes : 0,
      chaps: rep ? rep.chapters : 0,
      pCount: ps.length, indent: ind,
      bold: strongs.length, boldWeight: strongs.length ? getComputedStyle(strongs[0]).fontWeight : '—',
      imgs: [...d.querySelectorAll('img')].map(i => i.naturalWidth > 0)
    };
  }, b64);

  ok(run.haveResult && run.outB > 0, '线上处理成功',
    run.haveResult ? (run.inB / 1048576).toFixed(2) + 'MB → ' + (run.outB / 1048576).toFixed(2) + 'MB，' + run.chaps + ' 章' : '无结果');
  ok(run.pCount > 0 && parseFloat(run.indent) > 0, '正文首行缩进在线上生效', run.pCount + ' 段，indent=' + run.indent);
  ok(run.bold > 0 && parseInt(run.boldWeight, 10) >= 600, '加粗保持', run.bold + ' 处，weight=' + run.boldWeight);
  ok(run.imgs.length > 0 && run.imgs.every(Boolean), '图片正常显示', run.imgs.length + ' 张');
  ok(errs.length === 0, '全程无报错', errs.slice(0, 2).join(' | ') || undefined);

  await p.screenshot({ path: path.join(ROOT, 'test', 'live.png') });
  await b.close();
  console.log(bad === 0 ? '\n线上实测通过' : '\n有 ' + bad + ' 项未通过');
  process.exit(bad === 0 ? 0 : 1);
})();
