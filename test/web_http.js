/* 按"部署后线上"的方式验证：静态服务 + http 协议访问，不是 file://。
   重点看 http 下有没有资源 404、有没有因非安全上下文禁用 API、引擎是否还能跑完一本。 */
const fs = require('fs'), path = require('path'), http = require('http'), puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'epubfix');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.epub': 'application/epub+zip'
};

let bad = 0;
const ok = (c, m, d) => { console.log((c ? '  OK   ' : '  FAIL ') + m + (d !== undefined ? ' — ' + d : '')); if (!c) bad++; };

const server = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') u = '/index.html';
  const f = path.join(DIR, u);
  if (!f.startsWith(DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404).end('404'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  console.log('服务地址', base);

  const b = await puppeteer.launch({
    executablePath: EDGE, headless: true, protocolTimeout: 600000,
    args: ['--no-sandbox']
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900 });

  const errs = [], reqFail = [], notFound = [];
  p.on('pageerror', e => errs.push(String(e.message || e)));
  p.on('requestfailed', r => reqFail.push(r.url()));
  p.on('response', r => { if (r.status() >= 400) notFound.push(r.status() + ' ' + r.url()); });
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await p.goto(base + '/index.html', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 900));

  ok(errs.length === 0, '首屏无 JS 报错', errs.slice(0, 2).join(' | ') || undefined);
  ok(notFound.length === 0, '所有资源都能加载（无 404）', notFound.join(' , ') || undefined);
  ok(reqFail.length === 0, '没有失败的请求', reqFail.join(' , ') || undefined);

  // 图标是 <img src="assets/icon.svg">，得真的画出来
  const logo = await p.evaluate(() => {
    const i = document.querySelector('.brand-mark img, .brand img, img[src*="icon.svg"]');
    return i ? { ok: i.naturalWidth > 0, w: i.naturalWidth, src: i.getAttribute('src') } : null;
  });
  ok(!!logo && logo.ok, '品牌图标在 http 下正常渲染', logo ? logo.w + 'px' : '未找到');

  // 引擎脚本是否真的挂上
  const api = await p.evaluate(() => ({
    fix: typeof window.EpubFix,
    process: typeof (window.EpubFix || {}).process,
    diagnose: typeof (window.EpubFix || {}).diagnose,
    secure: window.isSecureContext,
    picker: typeof window.showDirectoryPicker
  }));
  ok(api.process === 'function' && api.diagnose === 'function', '引擎已加载', 'process=' + api.process + ' diagnose=' + api.diagnose);
  ok(api.secure === true, '处于安全上下文（目录选择等 API 可用）', 'secure=' + api.secure + ' picker=' + api.picker);

  // 真跑一本：导入 → 处理
  const sample = fs.readFileSync(path.join(ROOT, 'test', 'sample_book.epub')).toString('base64');
  const run = await p.evaluate(async (data) => {
    const bin = atob(data); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], '雾中渡口.epub', { type: 'application/epub+zip' });
    const dt = new DataTransfer(); dt.items.add(file);
    const dz = document.getElementById('dropzone');
    document.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
    document.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));

    const t0 = Date.now();
    for (let i = 0; i < 100; i++) {
      const c = document.getElementById('fileCard');
      if (c && !c.hidden && document.getElementById('fileCard').dataset.ready === '1') break;
      await new Promise(r => setTimeout(r, 200));
    }
    const card = document.getElementById('fileCard');
    const facts = (document.getElementById('fileFacts') || {}).innerText || '';

    document.getElementById('startBtn2').click();
    for (let i = 0; i < 300; i++) {
      if (!window.__em.state.busy && window.__em.state.result) break;
      await new Promise(r => setTimeout(r, 300));
    }
    const r = window.__em.state.result;
    const rep = r && r.res && r.res.report ? r.res.report : null;
    return {
      cardShown: !!card && !card.hidden,
      facts: facts.replace(/\n/g, ' · ').slice(0, 90),
      haveResult: !!rep,
      vols: r && r.res && r.res.volumes ? r.res.volumes.length : 0,
      outBytes: rep ? rep.outputBytes : 0,
      inBytes: rep ? rep.inputBytes : 0,
      ms: Date.now() - t0
    };
  }, sample);

  ok(run.cardShown, '加入书籍后卡片显示', run.facts);
  ok(run.haveResult && run.outBytes > 0, '处理跑完并产出文件',
    run.haveResult ? (run.inBytes / 1048576).toFixed(2) + 'MB → ' + (run.outBytes / 1048576).toFixed(2) + 'MB，' + (run.ms / 1000).toFixed(1) + 's' : '无结果');
  ok(errs.length === 0, '整个流程里没有新增报错', errs.slice(0, 3).join(' | ') || undefined);

  await p.screenshot({ path: path.join(ROOT, 'test', 'web_http.png') });
  await b.close(); server.close();

  console.log(bad === 0 ? '\n线上形态验证通过' : '\n有 ' + bad + ' 项未通过');
  process.exit(bad === 0 ? 0 : 1);
});
