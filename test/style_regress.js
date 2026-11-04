/*
 * 排版回归：真实书 × {标准, 深度} × {2.0, 3.0}
 *
 * 重点不是"打包成功"，而是把输出包重新解开来、用浏览器真渲染一章，
 * 量出首行缩进、段间距、标题对齐 —— 排版有没有真的生效，只有量得出数才算。
 *
 * 跑法：node test/style_regress.js [书.epub]
 */
const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const puppeteer = require('puppeteer-core');
const fflate = require('../epubfix/vendor/fflate.js');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'epubfix');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };
const BOOK = process.argv[2] || path.join(ROOT, 'test', 'probe_2.epub');

let bad = 0;
const ok = (c, m, d) => {
  console.log((c ? '  OK   ' : '  FAIL ') + m + (d !== undefined ? ' — ' + d : ''));
  if (!c) bad++;
};

const srv = http.createServer((q, s) => {
  let u = decodeURIComponent(q.url.split('?')[0]);
  if (u === '/') u = '/index.html';
  const f = path.join(DIR, u);
  if (!fs.existsSync(f)) { s.writeHead(404).end(); return; }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(s);
});

/* 把 zip base64 解开落盘，返回目录 */
function unpack(b64) {
  const tmp = path.join(os.tmpdir(), 'efsr_' + Date.now() + Math.random().toString(16).slice(2));
  fs.mkdirSync(tmp, { recursive: true });
  const files = fflate.unzipSync(Buffer.from(b64, 'base64'));
  Object.keys(files).forEach(n => {
    const p = path.join(tmp, n);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(files[n]));
  });
  return { tmp, names: Object.keys(files), files };
}

async function measure(browser, dir, pick) {
  const p = await browser.newPage();
  await p.setViewport({ width: 520, height: 900 });
  await p.goto('file:///' + path.join(dir, pick).replace(/\\/g, '/'), { waitUntil: 'load' });
  const m = await p.evaluate(() => {
    const ps = [...document.querySelectorAll('p')].filter(e => (e.textContent || '').trim().length > 15);
    const f = ps[0], s = ps[1];
    const h = document.querySelector('h1,h2,h3');
    const st = f ? getComputedStyle(f) : null;
    return {
      paras: ps.length,
      indent: st ? parseFloat(st.textIndent) : -1,
      font: st ? parseFloat(st.fontSize) : 0,
      gap: s ? +(s.getBoundingClientRect().top - f.getBoundingClientRect().bottom).toFixed(1) : -1,
      lineH: st ? parseFloat(st.lineHeight) : 0,
      head: h ? { align: getComputedStyle(h).textAlign, indent: parseFloat(getComputedStyle(h).textIndent) } : null,
      links: [...document.querySelectorAll('link[rel=stylesheet]')].map(l => l.getAttribute('href'))
    };
  });
  await p.close();
  return m;
}

srv.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, protocolTimeout: 900000, args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const page = await browser.newPage();
  await page.goto(base + '/index.html', { waitUntil: 'networkidle2' });

  const b64 = fs.readFileSync(BOOK).toString('base64');
  console.log('书：' + path.basename(BOOK) + '\n');

  async function run(bytesB64, mode, ver) {
    return page.evaluate(async (data, m, v) => {
      const bin = atob(data); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const res = await window.EpubFix.process(arr, { mode: m, outputVersion: v, rebuildToc: true });
      let s = ''; const by = res.volumes[0].bytes; const CH = 0x8000;
      for (let i = 0; i < by.length; i += CH) s += String.fromCharCode.apply(null, by.subarray(i, i + CH));
      const rep = res.report;
      return {
        zip: btoa(s),
        rep: {
          ver: rep.outputVersion, chapters: rep.chapters, rebuilt: rep.rebuiltParagraphs,
          merged: rep.mergedLines, cssKind: rep.cssKind, keptCss: rep.keptCssFiles,
          verified: rep.verified, versionVerified: rep.versionVerified,
          audit: (rep.audit || []).map(x => x.id + ':' + x.status)
        }
      };
    }, bytesB64, mode, ver);
  }

  const seen = {};
  for (const mode of ['standard', 'deep']) {
    for (const ver of ['2', '3']) {
      const r = await run(b64, mode, ver);
      const { tmp, names, files } = unpack(r.zip);
      const opf = names.find(n => n.endsWith('.opf'));
      const opfText = Buffer.from(files[opf]).toString('utf8');
      const hrefs = (opfText.match(/<item[^>]*text\/css[^>]*>/g) || [])
        .map(t => (t.match(/href="([^"]+)"/) || [])[1]);
      const cssFiles = names.filter(n => n.toLowerCase().endsWith('.css'));
      const xh = names.filter(n => /\.x?html?$/i.test(n)).sort();
      const pick = xh.filter(n => /ch_0(0[4-9]|1[0-9])/.test(n))[0] || xh[Math.min(3, xh.length - 1)];
      const m = await measure(browser, tmp, pick);

      console.log(mode + ' → EPUB ' + r.rep.ver + '（' + pick + '，' + m.paras + ' 段）');
      ok(m.indent >= m.font * 1.9 && m.indent <= m.font * 2.1,
        '首行缩进实测 2em', m.indent + 'px / 字号 ' + m.font + 'px');
      ok(m.gap > 0, '段落之间有可见间距', m.gap + 'px');
      ok(m.lineH / m.font >= 1.6, '行距处于舒适区间', (m.lineH / m.font).toFixed(2) + ' 倍');
      ok(!!m.head && m.head.align === 'center' && m.head.indent === 0, '章节标题居中且无首行缩进',
        m.head ? m.head.align + ' / indent ' + m.head.indent : '没有标题');
      ok(new Set(hrefs).size === hrefs.length, 'manifest 里没有重复声明的样式表',
        hrefs.length + ' 项：' + hrefs.join(', '));
      ok(new Set(m.links).size === m.links.length, '每章只链一张同名样式表', m.links.join(', '));
      ok(m.links.length === cssFiles.length, '章节链接的样式表数量与包内一致',
        m.links.length + ' / ' + cssFiles.length);
      ok(r.rep.versionVerified, 'EPUB ' + r.rep.ver + ' 结构自检通过');
      if (mode === 'standard') ok(!!r.rep.cssKind, '样式层选择有记录（' + r.rep.cssKind + '，保留原样式表 ' + (r.rep.keptCss || []).length + ' 份）');
      seen[mode + ver] = m.indent;
      fs.rmSync(tmp, { recursive: true, force: true });
      console.log('');
    }
  }

  // 同一个设置下，2.0 与 3.0 的首行缩进必须一致
  for (const mode of ['standard', 'deep']) {
    ok(seen[mode + '2'] === seen[mode + '3'], '同设置下 2.0 与 3.0 缩进一致',
      seen[mode + '2'] + 'px / ' + seen[mode + '3'] + 'px');
  }

  /*
   * 二次处理：把处理结果再喂回引擎一次。
   * 这是用户最容易踩的场景（导出的书又导一遍），暴露的是"重名样式表被重复声明"。
   */
  const again = await run(b64, 'standard', '2');
  const again2 = await run(again.zip, 'standard', '2');
  const { tmp, names, files } = unpack(again2.zip);
  const opf = names.find(n => n.endsWith('.opf'));
  const opfText = Buffer.from(files[opf]).toString('utf8');
  const hrefs = (opfText.match(/<item[^>]*text\/css[^>]*>/g) || []).map(t => (t.match(/href="([^"]+)"/) || [])[1]);
  const xh = names.filter(n => /\.x?html?$/i.test(n)).sort();
  const m = await measure(browser, tmp, xh.filter(n => /ch_0(0[4-9]|1[0-9])/.test(n))[0] || xh[3]);
  console.log('二次处理（处理的产物再处理一遍）');
  ok(new Set(hrefs).size === hrefs.length, '第二次处理没有产生重复的样式表声明', hrefs.join(', '));
  ok(m.indent >= m.font * 1.9, '第二次处理排版仍然有 2em 缩进', m.indent + 'px');
  ok(!!m.head && m.head.align === 'center', '第二次处理标题仍然居中', m.head && m.head.align);
  fs.rmSync(tmp, { recursive: true, force: true });

  await browser.close(); srv.close();
  console.log('\n' + (bad ? '有 ' + bad + ' 项不达标' : '测试通过：全部达标'));
  process.exit(bad ? 1 : 0);
});
