/* 重点验证本轮三件大事：预览原书、分卷默认关闭、结果页统计口径 */
const fs = require('fs'), path = require('path'), http = require('http'), puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'epubfix');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SAMPLE = 'test/sample_book.epub';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml'
};

let bad = 0;
const ok = (c, m, d) => { console.log((c ? '  OK   ' : '  FAIL ') + m + (d !== undefined ? ' — ' + d : '')); if (!c) bad++; };
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
  const base = 'http://127.0.0.1:' + server.address().port;
  const b = await puppeteer.launch({ executablePath: EDGE, headless: true, protocolTimeout: 600000, args: ['--no-sandbox'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900 });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e.message || e)));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await p.goto(base + '/index.html', { waitUntil: 'networkidle2' });
  await wait(600);

  console.log('[1] 导入书籍');
  const b64 = fs.readFileSync(path.join(ROOT, SAMPLE)).toString('base64');
  const imported = await p.evaluate(async (data) => {
    const bin = atob(data); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], '雾中渡口.epub', { type: 'application/epub+zip' });
    const dt = new DataTransfer(); dt.items.add(file);
    document.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
    document.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    for (let i = 0; i < 200; i++) {
      const c = document.getElementById('fileCard');
      if (c && !c.hidden && c.dataset.ready === '1') break;
      await new Promise(r => setTimeout(r, 150));
    }
    return {
      title: document.getElementById('fileTitle').textContent,
      author: document.getElementById('fileAuthor').textContent,
      name: document.getElementById('fileName').textContent,
      facts: document.getElementById('fileFacts').textContent,
      chips: document.getElementById('fileDiag').innerText,
      hasPreviewBtn: !!document.getElementById('previewBookBtn')
    };
  }, b64);
  ok(imported.hasPreviewBtn, '书籍卡上有「预览原书」按钮');
  ok(/章/.test(imported.facts) && /图片/.test(imported.facts), '卡片显示章数与图片数', imported.facts.replace(/\s+/g, ' '));
  ok(/字体/.test(imported.facts), '卡片说明内嵌字体情况', imported.facts.match(/[^　]*字体[^　]*/)?.[0] || '');
  ok(/\.epub/.test(imported.name), '卡片显示文件名', imported.name);
  ok(/结构正常|问题|提示/.test(imported.chips), '卡片显示结构检查状态', imported.chips.replace(/\n/g, ' '));

  console.log('[2] 预览原书（不处理）');
  await p.click('#previewBookBtn');
  await p.waitForFunction(() => !document.getElementById('reader').hidden, { timeout: 30000 });
  await p.waitForFunction(() => {
    const f = document.getElementById('rdFrame');
    return f && f.contentDocument && f.contentDocument.body && f.contentDocument.body.children.length > 0;
  }, { timeout: 30000 });
  await wait(500);

  const r1 = await p.evaluate(() => {
    const d = document.getElementById('rdFrame').contentDocument;
    const toc = [...document.querySelectorAll('#rdToc li[data-ch]')];
    const box = document.querySelector('.reader-toc').getBoundingClientRect();
    const view = document.querySelector('.reader-view').getBoundingClientRect();
    return {
      title: document.getElementById('rdTitle').textContent,
      source: document.getElementById('rdSource').textContent,
      meta: document.getElementById('rdMeta').textContent,
      tocCount: toc.length,
      tocFirst: toc.slice(0, 3).map(x => x.textContent.trim()),
      tocClipped: toc.some(li => li.scrollWidth > li.clientWidth + 1),
      tocTitleAttr: toc.every(li => !!li.getAttribute('title')),
      chapterTitle: document.getElementById('rdChapterTitle').textContent,
      pos: document.getElementById('rdPos').textContent,
      p: d.querySelectorAll('p').length,
      imgs: [...d.querySelectorAll('img')].map(i => ({ ok: i.naturalWidth > 0, w: i.naturalWidth, alt: i.getAttribute('alt') })),
      missing: d.querySelectorAll('.ef-missing').length,
      tocW: Math.round(box.width),
      viewW: Math.round(view.width),
      scrollers: {
        tocOverflow: getComputedStyle(document.querySelector('.reader-toc')).overflow,
        listOverflow: getComputedStyle(document.getElementById('rdToc')).overflowY
      },
      hasStyles: !!d.querySelector('style')
    };
  });
  ok(r1.tocCount > 0, '目录有章节', r1.tocCount + ' 项');
  ok(/原书/.test(r1.source), '标注这是原书预览', r1.source);
  ok(/章/.test(r1.meta) && /作者|未标注/.test(r1.meta), '标题栏显示书名之外的信息', r1.meta.replace(/\s+/g, ' '));
  ok(r1.p > 5, '正文真的渲染出来了', r1.p + ' 段');
  ok(r1.imgs.length >= 1 && r1.imgs.every(i => i.ok), '图片按原始引用显示', r1.imgs.length + ' 张，均加载成功');
  ok(r1.missing === 0, '没有缺失图片');
  ok(r1.tocW >= 180, '目录栏宽度合理（不再被挤成窄缝）', r1.tocW + 'px');
  ok(r1.viewW > r1.tocW * 1.5, '正文区占据剩余空间', '目录 ' + r1.tocW + ' / 正文 ' + r1.viewW);
  ok(r1.scrollers.listOverflow === 'auto' || r1.scrollers.listOverflow === 'scroll', '目录独立滚动', r1.scrollers.listOverflow);
  ok(!r1.tocClipped, '目录文字没有被裁切');
  ok(r1.tocTitleAttr, '目录项带 title，悬停可看完整标题');
  ok(/第 1 \//.test(r1.pos), '显示章节位置', r1.pos);
  ok(r1.hasStyles, '原书样式表已注入');

  console.log('[3] 切章 / 翻页');
  const r2 = await p.evaluate(async () => {
    const toc = [...document.querySelectorAll('#rdToc li[data-ch]')];
    toc[Math.min(3, toc.length - 1)].click();
    await new Promise(r => setTimeout(r, 900));
    const d = document.getElementById('rdFrame').contentDocument;
    return {
      pos: document.getElementById('rdPos').textContent,
      title: document.getElementById('rdChapterTitle').textContent,
      p: d.querySelectorAll('p').length,
      imgs: d.querySelectorAll('img').length,
      okImgs: [...d.querySelectorAll('img')].every(i => i.naturalWidth > 0)
    };
  });
  ok(/第 4 \//.test(r2.pos), '点击目录跳到第 4 章', r2.pos);
  ok(r2.p > 0, '切换后正文有内容', r2.p + ' 段');
  ok(r2.imgs === 0 || r2.okImgs, '切章后图片仍能加载');

  const r3 = await p.evaluate(async () => {
    document.getElementById('rdNext').click();
    await new Promise(r => setTimeout(r, 800));
    const pos1 = document.getElementById('rdPos').textContent;
    document.getElementById('rdPrev').click();
    await new Promise(r => setTimeout(r, 800));
    return { pos1, pos2: document.getElementById('rdPos').textContent };
  });
  ok(/第 5 \//.test(r3.pos1), '下一章生效', r3.pos1);
  ok(/第 4 \//.test(r3.pos2), '上一章生效', r3.pos2);

  console.log('[4] 阅读样式 / 字号 / 缩放');
  const r4 = await p.evaluate(async () => {
    document.querySelector('#rdStyleSeg [data-style="reading"]').click();
    await new Promise(r => setTimeout(r, 900));
    const d = document.getElementById('rdFrame').contentDocument;
    const ps = [...d.querySelectorAll('p')].filter(x => (x.textContent || '').trim().length > 10);
    const before = {
      indent: ps.length ? getComputedStyle(ps[0]).textIndent : '—',
      lineHeight: ps.length ? getComputedStyle(ps[0]).lineHeight : '—',
      font: ps.length ? getComputedStyle(ps[0]).fontSize : '—',
      fontBtnDisabled: document.getElementById('rdFontPlus').disabled
    };
    document.getElementById('rdFontPlus').click();
    await new Promise(r => setTimeout(r, 800));
    const d2 = document.getElementById('rdFrame').contentDocument;
    const ps2 = [...d2.querySelectorAll('p')].filter(x => (x.textContent || '').trim().length > 10);
    return {
      before,
      afterFont: ps2.length ? getComputedStyle(ps2[0]).fontSize : '—'
    };
  });
  ok(parseFloat(r4.before.indent) > 0, '阅读样式下首行缩进生效', r4.before.indent);
  ok(!r4.before.fontBtnDisabled, '阅读样式下字号按钮可用');
  ok(parseFloat(r4.afterFont) > parseFloat(r4.before.font), 'A+ 真的放大了字号', r4.before.font + ' → ' + r4.afterFont);

  const r5 = await p.evaluate(async () => {
    document.getElementById('rdZoomIn').click();
    await new Promise(r => setTimeout(r, 700));
    const d = document.getElementById('rdFrame').contentDocument;
    return {
      label: document.getElementById('rdZoomVal').textContent,
      zoom: getComputedStyle(d.documentElement).zoom
    };
  });
  ok(parseInt(r5.label) > 100, '缩放比例显示已变化', r5.label);
  ok(parseFloat(r5.zoom) > 1, '正文真的被缩放', r5.zoom);

  console.log('[5] 拖动分隔线');
  const r6 = await p.evaluate(async () => {
    const split = document.getElementById('rdSplit');
    const before = document.querySelector('.reader-toc').getBoundingClientRect().width;
    const r = split.getBoundingClientRect();
    const opts = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + 100 };
    split.dispatchEvent(new MouseEvent('mousedown', opts));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: opts.clientX + 120, clientY: opts.clientY }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await new Promise(x => setTimeout(x, 300));
    return { before: Math.round(before), after: Math.round(document.querySelector('.reader-toc').getBoundingClientRect().width) };
  });
  ok(r6.after > r6.before + 60, '拖动后目录变宽', r6.before + ' → ' + r6.after + 'px');

  await p.screenshot({ path: path.join(ROOT, 'test', 'r3_reader.png') });

  console.log('[6] 关闭后释放');
  const r7 = await p.evaluate(async () => {
    document.getElementById('rdClose').click();
    await new Promise(r => setTimeout(r, 300));
    let threw = '';
    try { window.EpubFix.readChapter({ chapters: [], _ctx: null }, 0); } catch (e) { threw = e.message; }
    return { hidden: document.getElementById('reader').hidden, threw };
  });
  ok(r7.hidden, '关闭后阅读窗口隐藏');
  ok(/关闭/.test(r7.threw), '书已释放，再读会明确报错', r7.threw);

  console.log('[7] 处理（分卷关闭）');
  const res = await p.evaluate(async () => {
    document.getElementById('startBtn2').click();
    for (let i = 0; i < 400; i++) {
      if (!window.__em.state.busy && window.__em.state.result) break;
      await new Promise(r => setTimeout(r, 250));
    }
    const r = window.__em.state.result;
    if (!r) return { none: true };
    const rep = r.res.report;
    return {
      vols: r.res.volumes.length,
      inputBytes: rep.inputBytes,
      outputBytes: rep.outputBytes,
      before: rep.sizeBreakdown,
      after: rep.afterBreakdown,
      rawTotal: rep.rawTotal,
      afterRawTotal: rep.afterRawTotal,
      imagesFound: rep.imagesFound,
      imagesProcessed: rep.imagesProcessed,
      fontsTotal: rep.fontsTotal,
      removedFonts: rep.removedFonts,
      verified: rep.verified,
      verifyIssues: rep.verifyIssues,
      html: document.getElementById('resultCard').innerText.replace(/\n+/g, ' | ').slice(0, 600),
      sums: {
        statsRow: document.getElementById('statsRow').innerText.replace(/\n+/g, ' | '),
        breakdown: document.getElementById('breakdown').innerText.replace(/\n+/g, ' | '),
        scope: document.getElementById('scopeNote').textContent
      }
    };
  });
  ok(!res.none, '处理完成');
  ok(res.vols === 1, '默认不启用分卷 → 只输出一个文件', res.vols + ' 个');
  ok(res.verified === true, '输出自检通过', JSON.stringify(res.verifyIssues));

  // 统计口径自洽性：分类之和必须等于解压总量，且不能拿 ZIP 体积当分母
  const beforeSum = res.before.image + res.before.text + res.before.font + res.before.other;
  const afterSum = res.after.image + res.after.text + res.after.font + res.after.other;
  ok(Math.abs(beforeSum - res.rawTotal) <= 2, '处理前四类之和 = 解压总量', beforeSum + ' vs ' + res.rawTotal);
  ok(Math.abs(afterSum - res.afterRawTotal) <= 2, '处理后四类之和 = 解压总量', afterSum + ' vs ' + res.afterRawTotal);
  ok(res.rawTotal > res.inputBytes, '解压总量大于 ZIP 体积（口径不同，不能混用）',
    (res.rawTotal / 1048576).toFixed(2) + 'MB 解压 vs ' + (res.inputBytes / 1048576).toFixed(2) + 'MB ZIP');
  ok(/口径不同|不能直接相加/.test(res.sums.scope), '结果页明确标注了两个口径', res.sums.scope);
  ok(/%|节省|减少/.test(res.sums.statsRow), '概览显示比例', res.sums.statsRow.slice(0, 80));
  ok(/图片/.test(res.sums.breakdown) && /文本/.test(res.sums.breakdown), '分类面板有内容',
    res.sums.breakdown.slice(0, 100));
  ok(res.imagesFound >= 1 && /发现/.test(res.sums.breakdown), '图片分类说明发现了什么', res.imagesFound + ' 张');
  ok(/保留|移除/.test(res.sums.breakdown), '字体分类说明处理方式');

  await p.screenshot({ path: path.join(ROOT, 'test', 'r3_result.png') });

  console.log('[8] 预览处理结果');
  await p.click('#previewBtn');
  await p.waitForFunction(() => !document.getElementById('reader').hidden, { timeout: 20000 });
  await p.waitForFunction(() => {
    const f = document.getElementById('rdFrame');
    return f && f.contentDocument && f.contentDocument.body && f.contentDocument.body.children.length > 0;
  }, { timeout: 30000 });
  await wait(400);
  const r8 = await p.evaluate(() => {
    const d = document.getElementById('rdFrame').contentDocument;
    return {
      source: document.getElementById('rdSource').textContent,
      title: document.getElementById('rdTitle').textContent,
      p: d.querySelectorAll('p').length,
      imgs: [...d.querySelectorAll('img')].filter(i => i.naturalWidth > 0).length,
      indent: (() => {
        const x = [...d.querySelectorAll('p')].find(y => (y.textContent || '').trim().length > 12);
        return x ? getComputedStyle(x).textIndent : '—';
      })()
    };
  });
  ok(/处理结果/.test(r8.source), '标注这是处理结果', r8.source);
  ok(r8.p > 5, '处理后正文可读', r8.p + ' 段');
  ok(r8.imgs >= 1, '处理后图片可显示', r8.imgs + ' 张');
  ok(parseFloat(r8.indent) > 0, '处理后首行缩进生效', r8.indent);
  await p.screenshot({ path: path.join(ROOT, 'test', 'r3_reader_out.png') });

  ok(errs.length === 0, '全程无 JS 报错', errs.slice(0, 3).join(' | ') || undefined);

  await b.close(); server.close();
  console.log(bad === 0 ? '\n阅读与结果页测试通过' : '\n有 ' + bad + ' 项未通过');
  process.exit(bad === 0 ? 0 : 1);
});
