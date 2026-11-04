/* 取消按钮必须真的能中断处理，而不是等跑完再说 */
const fs = require('fs'), path = require('path'), http = require('http'), puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '..');
const PAGE = 'file://' + path.join(ROOT, 'epubfix', 'index.html').replace(/\\/g, '/');
const EDGE = 'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SAMPLE = process.env.SAMPLE || 'test/sample_book.epub';   // 要有图有字体，跑起来才够时间点取消

const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!fs.existsSync(f)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': 'application/epub+zip', 'Content-Length': fs.statSync(f).size, 'Access-Control-Allow-Origin': '*' });
  fs.createReadStream(f).pipe(res);
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const b = await puppeteer.launch({ executablePath: EDGE, headless: true, protocolTimeout: 600000,
    args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const p = await b.newPage();
  await p.goto(PAGE, { waitUntil: 'load' });
  const buf = Buffer.from(await (await fetch(`http://127.0.0.1:${port}/${SAMPLE}`)).arrayBuffer());

  const r = await p.evaluate(async (url) => {
    const data = await (await fetch(url)).arrayBuffer();
    const state = window.__em.state;
    let cancelledAt = 0, seen = 0;
    state.current = { buffer: data, info: { title: 't' }, file: { name: 't.epub', size: data.byteLength } };
    const t0 = performance.now();
    const timer = setInterval(() => { if (seen > 0 && !cancelledAt) { state.cancel = true; cancelledAt = performance.now() - t0; } }, 30);
    try {
      await EpubFix.process(data, {
        mode: 'deep',
        shouldCancel: () => !!state.cancel
      }, () => { seen++; });
      clearInterval(timer);
      return { ok: false, msg: '没有抛取消', seen };
    } catch (e) {
      clearInterval(timer);
      return { ok: e.message === '__CANCELLED__', msg: e.message, cancelledAt: Math.round(cancelledAt), total: Math.round(performance.now() - t0), seen };
    }
  }, `http://127.0.0.1:${port}/${SAMPLE}`);

  console.log('取消:', r.ok ? 'OK' : 'FAIL', '| 抛出:', r.msg,
    '| 请求取消于', r.cancelledAt, 'ms | 实际中断于', r.total, 'ms | 进度回调', r.seen, '次');
  console.log(r.ok && r.total < 3000 ? '  OK   取消在 3 秒内生效（不是等整本跑完）' : '  FAIL   取消没有及时生效');
  await b.close(); server.close();
  process.exit(r.ok && r.total < 3000 ? 0 : 1);
});
