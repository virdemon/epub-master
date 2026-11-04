/* 临时诊断：用真实书跑 2.0 / 3.0，检查输出章节结构，并截图两种阅读样式 */
const fs = require('fs'), path = require('path'), http = require('http');
const puppeteer = require('puppeteer-core');
const JSZip = null;

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'epubfix');
const BOOK = 'C:\\Users\\wh\\Downloads\\成为令强者们痴迷的装备制作师.epub';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
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
  await p.goto(base + '/index.html', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 400));

  const b64 = fs.readFileSync(BOOK).toString('base64');
  for (const ver of ['2', '3']) {
    const out = await p.evaluate(async (data, v) => {
      const bin = atob(data); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const r = await window.EpubFix.process(arr, { mode: 'deep', outputVersion: v, rebuildToc: true });
      const by = r.volumes[0].bytes;
      let s = '';
      const CH = 0x8000;
      for (let i = 0; i < by.length; i += CH) s += String.fromCharCode.apply(null, by.subarray(i, i + CH));
      const rep = r.report;
      return {
        b64: btoa(s),
        stats: {
          chapters: rep.chapters, rebuilt: rep.rebuiltParagraphs, split: rep.splitFromBreaks,
          merged: rep.mergedLines, converted: rep.convertedBlocks, breaks: rep.removedExtraBreaks,
          chars: rep.sourceChars, version: rep.outputVersion, verified: rep.verified,
          audit: (rep.audit || []).map(function (a) { return a.status + ' | ' + a.title + ' | ' + a.detail; })
        }
      };
    }, b64, ver);
    fs.writeFileSync(path.join(ROOT, 'test', 'probe_' + ver + '.epub'), Buffer.from(out.b64, 'base64'));
    console.log('输出 ' + ver + '.0:', JSON.stringify(out.stats));
  }

  // 截图：打开 2.0 输出，阅读样式 vs 原书样式
  await p.evaluate(async () => {
    /* 直接把生成的文件塞进去预览：借用 openReader 的入口 */
    window.__probe = {};
  });
  await b.close();
  server.close();
  if (errs.length) console.log('页面错误:', errs.slice(0, 3));
  console.log('done');
});
