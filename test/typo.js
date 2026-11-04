/*
 * 第五轮专项：排版兼容性（段落结构 / 首行缩进 / 段距 / 特殊内容 / 2.0 与 3.0 一致）
 *
 * 用的是一本"结构最差"的样书：正文只有文字 + <br>，一个 <p> 都没有，
 * 还混着表格、引用块、pre、诗歌、插图、以及"整章塞在一个 <p> 里"的章节。
 * 这类书正是截图里糊成一块的那一类。
 *
 * 跑法：node test/typo.js
 */
const fs = require('fs'), path = require('path'), http = require('http');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'epubfix');
const OUT = path.join(ROOT, 'test', 'out_typo');
const SAMPLE = path.join(ROOT, 'test', 'sample_brtext.epub');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml'
};

let bad = 0;
const ok = (c, m, d) => {
  console.log((c ? '  OK   ' : '  FAIL ') + m + (d !== undefined ? ' — ' + d : ''));
  if (!c) bad++;
};
const wait = ms => new Promise(r => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') u = '/index.html';
  const f = path.join(DIR, u);
  if (!f.startsWith(DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

server.listen(0, '127.0.0.1', async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: true, protocolTimeout: 600000, args: ['--no-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 940 });
  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(String(e.message || e)));
  page.on('console', m => { if (m.type() === 'error') jsErrors.push('console: ' + m.text()); });

  await page.goto(base + '/index.html', { waitUntil: 'networkidle2' });
  await wait(400);

  const b64 = fs.readFileSync(SAMPLE).toString('base64');

  /* 跑一次处理，把输出（第一卷）解成 base64 带回来，同时取回报告 */
  async function run(mode, ver) {
    return page.evaluate(async (data, m, v) => {
      const bin = atob(data); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const r = await window.EpubFix.process(arr, { mode: m, outputVersion: v, rebuildToc: true });
      let s = '';
      const by = r.volumes[0].bytes;
      const CH = 0x8000;
      for (let i = 0; i < by.length; i += CH) s += String.fromCharCode.apply(null, by.subarray(i, i + CH));
      const rep = r.report;
      return {
        b64: btoa(s),
        report: {
          chapters: rep.chapters,
          rebuilt: rep.rebuiltParagraphs,
          split: rep.splitFromBreaks,
          merged: rep.mergedLines,
          sourceChars: rep.sourceChars,
          version: rep.outputVersion,
          verified: rep.verified,
          versionVerified: rep.versionVerified,
          audit: rep.audit,
          counts: rep.auditCounts,
          warnings: rep.warnings
        }
      };
    }, b64, mode, ver);
  }

  /* 直接读输出包里的章节 XHTML（用 Python 的 zipfile 不方便，这里用页面里的 fflate） */
  async function readOut(zipB64, pattern) {
    return page.evaluate(async (data, pat) => {
      const bin = atob(data); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const files = window.fflate.unzipSync(arr);
      const re = new RegExp(pat);
      const out = {};
      Object.keys(files).forEach((k) => {
        if (re.test(k)) out[k] = window.fflate.strFromU8(files[k]);
      });
      return out;
    }, zipB64, pattern);
  }

  console.log('[1] 结构最差的样书：2.0 / 3.0 / 保留原样式表 / 各跑一次');
  const r2 = await run('deep', '2');
  const r3 = await run('deep', '3');
  const rStd = await run('standard', '3');
  fs.writeFileSync(path.join(OUT, 'brtext-2.0.epub'), Buffer.from(r2.b64, 'base64'));
  fs.writeFileSync(path.join(OUT, 'brtext-3.0.epub'), Buffer.from(r3.b64, 'base64'));
  fs.writeFileSync(path.join(OUT, 'brtext-standard-3.0.epub'), Buffer.from(rStd.b64, 'base64'));

  ok(r2.report.rebuilt > 0, '深度优化：把"文字 + <br>"重建成了段落', r2.report.rebuilt + ' 段');
  ok(r2.report.split > 0, '深度优化：把"整章一个 <p>"拆开了', r2.report.split + ' 段');
  ok(r2.report.merged > 0, '被硬折行截断的半句接回同一段', r2.report.merged + ' 处');
  ok(r2.report.verified && r3.report.verified, '两个版本都通过结构自检', '2.0 / 3.0');
  ok(r2.report.versionVerified && r3.report.versionVerified, '版本合规自检通过（不是只改版本号）');

  console.log('\n[2] 输出的段落结构（EPUB 2.0）');
  const ch2 = await readOut(r2.b64, '^OEBPS/text/ch_\\d+\\.xhtml$');
  const first = ch2['OEBPS/text/ch_001.xhtml'] || Object.values(ch2)[0];
  ok(/<p class="ef-p">/.test(first), '正文段落是真正的 <p>，不是裸文字');
  ok(!/<body[^>]*>\s*[^<\s][^<]*<br/.test(first.replace(/<h1[\s\S]*?<\/h1>/, '')), '正文里不再有"裸文字 + 直接 <br>"的写法');

  const txtFirst = first.slice(first.indexOf('<h1'));
  ok(/<h1>第 1 章 结构测试<\/h1>/.test(txtFirst), '章节标题保留为 h1');
  ok(txtFirst.indexOf('<h1') < txtFirst.indexOf('<p class="ef-p">'), '标题在正文之前，顺序没乱');

  // 被硬折行的两句必须在同一个 <p> 里，而不是被切成两段
  const merged = txtFirst.match(/<p class="ef-p">([\s\S]*?)<\/p>/g) || [];
  const hasMerged = merged.some(p => p.indexOf('这是第一段正文') >= 0 &&
    p.indexOf('这是被硬折行截断的半句') >= 0 && p.indexOf('它应该和上一行接回同一个段落') >= 0);
  ok(hasMerged, '硬折行的三行合成了一段，没有制造碎行',
    (merged.find(p => p.indexOf('这是第一段正文') >= 0) || '').slice(0, 90));

  ok(merged.some(p => /独立的第二段/.test(p)), '空行分隔出来的段落独立成段');
  ok(merged.some(p => /\[论坛\] 第一行引用/.test(p)) && merged.some(p => /\[论坛\] 第二行引用/.test(p)),
    '引用行各自成段（没有被合并成一坨）');
  // 整章塞在 <p> 里、靠 <br> 分行的那一段，必须被拆成三段，而且一段都不能丢
  ['整章塞在一个 p 里的第一句。', '第二句也在这里。', '第三句结束。'].forEach((line, k) => {
    ok(merged.filter(p => p.indexOf(line) >= 0).length === 1,
      '塞满 <br> 的段落拆开了：第 ' + (k + 1) + ' 句独立成段', line);
  });

  console.log('\n[3] 特殊内容没有被段落重建破坏');
  ok(/<table>/.test(first) && (first.match(/<tr>/g) || []).length >= 2, '表格还在，行数没变');
  ok(/<blockquote><p>引用块里的一段话/.test(first), '引用块保持原样');
  ok(/<pre>预排版文本/.test(first) && first.indexOf('<pre>预排版文本\n') >= 0, 'pre 内容与换行原样保留');
  const poem = (first.match(/<(div|p) class="poetry">[\s\S]*?<\/(div|p)>/) || [''])[0];
  ok(poem.indexOf('床前明月光') >= 0 && (poem.match(/<br \/>/g) || []).length === 3,
    '诗歌里的 <br> 原样保留，没有被拆成段落', poem.slice(0, 60));
  ok(/<p class="ef-p ef-img"><img src="\.\.\/Images\/pic1\.png"/.test(first), '插图单独成段（ef-img 类），没有被卷进文字段落');
  ok(!/<p class="ef-p"[^>]*>(?:(?!<\/p>)[\s\S])*<table/.test(first), '表格没有被包进正文段落');

  console.log('\n[4] 样式表：缩进只给正文，特殊内容全部排除');
  const cssFiles2 = await readOut(r2.b64, '^OEBPS/epubfix\\.css$');
  const css = Object.values(cssFiles2)[0] || '';
  ok(/p\.ef-p \{[^}]*text-indent: 2em/.test(css), '新段落 2em 首行缩进');
  ok(/p\.ef-p \{[^}]*margin: 0 0 0\.5em/.test(css), '段距 0.5em');
  ok(/line-height: 1\.6/.test(css), '正文行高 1.6（TXT 式紧凑）');
  ok(/p\.ef-img \{[^}]*text-indent: 0/.test(css), '图片段落不缩进、居中');
  ok(/blockquote p[^{]*\{[^}]*text-indent: 0/.test(css), '引用块里的 <p> 不缩进');
  ok(/\.poetry[^{]*\{[^}]*text-indent: 0/.test(css), '诗歌不缩进');
  ok(/li \{[^}]*text-indent: 0/.test(css), '列表项不缩进');
  ok(/h1, h2, h3, h4, h5, h6 \{[^}]*text-indent: 0/.test(css.replace(/\n/g, ' ')), '标题不加首行缩进');
  ok(/h1, h2, h3, h4, h5, h6 \{[^}]*text-align: center/.test(css.replace(/\n/g, ' ')), '标题居中');

  console.log('\n[5] EPUB 2.0 与 3.0 的正文必须一模一样');
  const ch3 = await readOut(r3.b64, '^OEBPS/text/ch_\\d+\\.xhtml$');
  const body = h => (h.match(/<body[^>]*>([\s\S]*)<\/body>/) || ['', ''])[1].trim();
  const keys2 = Object.keys(ch2).sort(), keys3 = Object.keys(ch3).sort();
  ok(keys2.length === keys3.length, '两个版本的章节数一致', keys2.length + ' / ' + keys3.length);
  let same = 0, diff = [];
  keys2.forEach((k) => {
    if (!ch3[k]) { diff.push(k + ' 缺'); return; }
    if (body(ch2[k]) === body(ch3[k])) same++; else diff.push(k);
  });
  ok(same === keys2.length, '逐章对比：正文标记完全一致（版本不同不改变排版）', same + '/' + keys2.length + (diff.length ? ' 不同：' + diff.slice(0, 3) : ''));
  const css3 = Object.values(await readOut(r3.b64, '^OEBPS/epubfix\\.css$'))[0] || '';
  ok(css3 === css, '两个版本共用同一份正文样式表');

  console.log('\n[6] 保留原书样式表（标准优化）也要能修好段落');
  const chStd = await readOut(rStd.b64, '^OEBPS/text/ch_\\d+\\.xhtml$');
  const stdFirst = Object.values(chStd)[0] || '';
  ok(/<p class="ef-p">/.test(stdFirst), '标准优化：段落照样重建了');
  const stdCss = await readOut(rStd.b64, '^OEBPS/Styles/style\\.css$');
  ok(Object.keys(stdCss).length === 1, '原书样式表仍然在包里');
  ok((stdFirst.match(/<link[^>]*href="[^"]*style\.css"/) || []).length === 1, '章节仍然链到原书样式表');
  ok((stdFirst.match(/<link[^>]*href="[^"]*epubfix\.css"/) || []).length === 1, '同时链到正文层（后加载，只补 ef-p 段落）');
  const stdCssText = Object.values(await readOut(rStd.b64, '^OEBPS/epubfix\\.css$'))[0] || '';
  ok(/p\.ef-p \{[^}]*text-indent: 2em/.test(stdCssText), '保留原样式表时，新段落也有 2em 缩进');
  /*
   * 现在这里有一条全局 p{} 兜底：原书没有样式表时，光有 p.ef-p 会出现
   * "整章没缩进、标题不居中"。类型选择器优先级最低，原书的 .calibreN 之类
   * 一定盖得住它，所以不是覆盖原设计，而是垫底。
   */
  ok(/(^|\n)p \{[^}]*text-indent: 2em/.test(stdCssText), '有类型选择器级别的正文兜底（原书无样式表时才有实际作用）');
  // body 的 margin/padding 用 !important 是刻意的：网页书常在 body 写 margin:1.5em，
  // 阅读器里就成了"每行只显示十一二个字"。但段落的缩进不用 important，原书类选择器仍可覆盖。
  ok(/body \{[^}]*margin: 0 !important/.test(stdCssText), '正文容器边距用 !important 强制收掉（防原书大边距）');
  ok(!/text-indent: 2em !important/.test(stdCssText), '段落缩进不用 !important，原书类选择器仍能盖住');

  console.log('\n[7] 排版兼容性检查：每一项都来自真实数据');
  const a = r2.report.audit || [];
  ok(a.length >= 10, '检查项齐全', a.length + ' 项');
  const byId = {};
  a.forEach(it => { byId[it.id] = it; });
  ok(byId.p && byId.p.status === 'fixed', '段落结构 → 已修复', byId.p && byId.p.detail);
  ok(/重建 \d+ 个段落/.test(byId.p.detail), '说清了重建了多少段');
  ok(byId.text && byId.text.status === 'ok', '正文完整性 → 通过', byId.text && byId.text.detail);
  ok(byId.css && byId.css.status === 'ok', '样式表引用 → 每一章都链到了');
  ok(byId.indent && byId.indent.status === 'ok', '首行缩进与段距 → 通过');
  ok(byId.head && byId.head.status === 'ok', '章节标题 → 通过');
  ok(byId.special && byId.special.status === 'ok', '特殊内容保护 → 通过', byId.special && byId.special.detail);
  ok(byId.res && byId.res.status === 'ok', '图片资源 → 全部能定位', byId.res && byId.res.detail);
  ok(byId.parse && byId.parse.status === 'ok', '重新解析输出 → 通过');
  ok(byId.ver && byId.ver.status === 'ok', 'EPUB 2.0 结构 → 通过');
  ok(r3.report.audit.some(it => it.id === 'ver' && /EPUB 3\.0/.test(it.title)), '换 3.0 时标题跟着变', 'EPUB 3.0 结构');
  ok(r2.report.counts.fixed === 1 && r2.report.counts.warn === 0 && r2.report.counts.info === 0,
    '统计口径正确：1 项已修复、0 项待确认', JSON.stringify(r2.report.counts));

  console.log('\n[8] 界面：检查卡与阅读窗口的实际渲染');
  const ui = await page.evaluate(async (data) => {
    const bin = atob(data); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const r = await window.EpubFix.process(arr, { mode: 'deep', outputVersion: '2', rebuildToc: true });
    window.__em.state.result = { res: r, name: 'sample_brtext.epub', opts: { mode: 'deep' }, ms: 860 };
    window.__em.renderResult();
    const items = [...document.querySelectorAll('#auditList .audit-item')];
    return {
      rows: items.length,
      tags: items.map(i => i.querySelector('.audit-tag').textContent.trim()),
      titles: items.map(i => i.querySelector('.audit-title').textContent.replace(/[^\u4e00-\u9fa5A-Za-z0-9. ]/g, '').trim()),
      note: document.getElementById('auditNote').textContent.trim(),
      hidden: document.getElementById('auditSection').hidden
    };
  }, b64);
  ok(ui.rows === a.length, '结果页列出全部检查项', ui.rows + ' 行');
  ok(!ui.hidden, '检查区块显示出来了');
  ok(/1 项已修复/.test(ui.note) && /项通过/.test(ui.note), '右上角有统计', ui.note);
  ok(ui.tags.filter(t => t === '已修复').length === 1, '只有段落结构一项标"已修复"', ui.tags.join(' / '));
  ok(ui.tags.filter(t => t === '检查通过').length >= 8, '"检查通过"标记用在真正通过的项上');

  await page.evaluate(() => document.getElementById('auditSection').scrollIntoView({ block: 'center' }));
  await wait(300);
  await page.screenshot({ path: path.join(ROOT, 'test', 'typo_audit.png') });

  // 阅读窗口：用处理结果打开，量一下真实计算样式
  await page.evaluate(() => window.__em.openReader('result'));
  await page.waitForFunction(() => {
    const f = document.getElementById('rdFrame');
    return f && f.contentDocument && f.contentDocument.body &&
      f.contentDocument.body.querySelectorAll('p').length > 0;
  }, { timeout: 30000 });
  await page.evaluate(() => {
    const b = document.querySelector('#rdStyleSeg .rd-seg-btn[data-style="original"]');
    if (b) b.click();
  });
  await wait(1200);

  const style = await page.evaluate(() => {
    const d = document.getElementById('rdFrame').contentDocument;
    const p = d.querySelector('p.ef-p');
    const cs = d.defaultView.getComputedStyle(p);
    const h1 = d.querySelector('h1');
    const hs = d.defaultView.getComputedStyle(h1);
    const img = d.querySelector('p.ef-img');
    const is = img ? d.defaultView.getComputedStyle(img) : null;
    const table = d.querySelector('table');
    return {
      indent: cs.textIndent,
      margin: cs.marginBottom,
      lh: cs.lineHeight,
      align: cs.textAlign,
      hIndent: hs.textIndent,
      hAlign: hs.textAlign,
      imgIndent: is ? is.textIndent : '',
      imgAlign: is ? is.textAlign : '',
      tableW: table ? table.getBoundingClientRect().width : 0,
      pCount: d.querySelectorAll('p').length,
      swap: !document.getElementById('rdSwap').hidden
    };
  });
  ok(/px/.test(style.indent) && parseFloat(style.indent) >= 30, '正文首行缩进真的生效', style.indent);
  ok(parseFloat(style.margin) > 0, '段落之间有间距', style.margin);
  ok(style.align === 'justify', '正文两端对齐', style.align);
  ok(style.hIndent === '0px', '标题没有首行缩进', style.hIndent);
  ok(style.hAlign === 'center', '标题居中', style.hAlign);
  ok(style.imgIndent === '0px' && style.imgAlign === 'center', '插图段落居中且不缩进', style.imgIndent + ' / ' + style.imgAlign);
  ok(style.tableW > 0, '表格照常渲染', Math.round(style.tableW) + 'px');
  ok(style.pCount >= 8, '整章被切成了多个正常段落', style.pCount + ' 段');
  ok(style.swap, '阅读窗口给了"回原书对照"入口');

  await page.screenshot({ path: path.join(ROOT, 'test', 'typo_reader.png') });

  console.log('\n[9] 切回原书，停在同一章');
  // 测试里没有走"选文件"这一步，这里补上原书，等价于用户已经导入过
  await page.evaluate((data) => {
    const bin = atob(data); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    window.__em.state.current = {
      buffer: arr,
      file: { name: 'sample_brtext.epub' },
      info: { title: '换行分段样书' }
    };
  }, b64);
  const before = await page.evaluate(() => document.getElementById('rdChapterTitle').textContent);
  await page.click('#rdSwap');
  await page.waitForFunction(() => {
    const f = document.getElementById('rdFrame');
    return f && f.contentDocument && f.contentDocument.body &&
      document.getElementById('rdSource').textContent.indexOf('原书') >= 0;
  }, { timeout: 30000 });
  await wait(800);
  const after = await page.evaluate(() => ({
    title: document.getElementById('rdChapterTitle').textContent,
    src: document.getElementById('rdSource').textContent,
    label: document.getElementById('rdSwapLabel').textContent
  }));
  ok(/原书/.test(after.src), '切到了原书', after.src);
  ok(after.title === before, '停在同一章', before + ' → ' + after.title);
  ok(/回原书|处理结果/.test(after.label), '按钮文字跟着变', after.label);

  ok(jsErrors.length === 0, '全程无 JS 报错', jsErrors.slice(0, 2).join(' | ') || '无');

  await browser.close();
  server.close();
  console.log('\n' + (bad ? '排版兼容性测试失败：' + bad + ' 项' : '排版兼容性测试通过'));
  process.exit(bad ? 1 : 0);
});
