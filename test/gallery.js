/*
 * 第四轮专项：图片浏览模式
 * 覆盖需求书第四节：清单/尺寸/引用章节/未引用标注、按需缩略图、
 * 搜索排序筛选、大图适应与原始尺寸、上下张、对比匹配与不匹配提示、退出释放。
 * 另用 tools/make_many_epub.py 生成的 120 图样书验证"图多不卡"与真正的按需加载。
 */
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
const wait = ms => new Promise(r => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') u = '/index.html';
  const f = path.join(DIR, u);
  if (!f.startsWith(DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

/* 把本地 epub 拖进页面，等书籍卡就绪 */
async function drop(page, relPath, name) {
  const b64 = fs.readFileSync(path.join(ROOT, relPath)).toString('base64');
  return page.evaluate(async (data, fileName) => {
    const bin = atob(data); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], fileName, { type: 'application/epub+zip' });
    const dt = new DataTransfer(); dt.items.add(file);
    document.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
    document.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    for (let i = 0; i < 300; i++) {
      const c = document.getElementById('fileCard');
      if (c && !c.hidden && c.dataset.ready === '1') break;
      await new Promise(r => setTimeout(r, 100));
    }
    return document.getElementById('fileCard').dataset.ready === '1';
  }, b64, name);
}

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

  console.log('[1] 导入样书并打开预览');
  ok(await drop(p, 'test/sample_book.epub', '雾中渡口.epub'), '样书导入就绪');
  await p.click('#previewBookBtn');
  await p.waitForFunction(() => !document.getElementById('reader').hidden, { timeout: 30000 });
  await p.waitForFunction(() => {
    const f = document.getElementById('rdFrame');
    return f && f.contentDocument && f.contentDocument.body && f.contentDocument.body.children.length > 0;
  }, { timeout: 30000 });
  await wait(300);

  console.log('[2] 模式标签：默认原书阅读，切到图片浏览');
  const before = await p.evaluate(() => ({
    galHidden: document.getElementById('rdGallery').hidden,
    activeMode: (document.querySelector('#rdModeSeg .rd-seg-btn.is-active') || {}).dataset.mode,
    modes: [...document.querySelectorAll('#rdModeSeg .rd-seg-btn')].map(b => b.dataset.mode),
    footVisible: getComputedStyle(document.querySelector('.reader-foot')).display !== 'none'
  }));
  ok(before.modes.join(',') === 'read,images', '顶部有「原书阅读 / 图片浏览」两个模式标签', before.modes.join(','));
  ok(before.activeMode === 'read' && before.galHidden, '默认停在原书阅读，图库收起');
  ok(before.footVisible, '原书阅读时底部翻页/字号工具条在');

  const switched = await p.evaluate(async () => {
    document.querySelector('#rdModeSeg [data-mode="images"]').click();
    // 同步取一次：此刻缩略图应该还没生成（证明是按需加载，不是一次性全解码）
    const em = window.__em;
    const immediate = {
      thumbs: em.gallery.images.filter(i => i._thumb).length,
      ready: document.querySelectorAll('#galGrid .gal-thumb[data-state="ok"]').length
    };
    await new Promise(r => setTimeout(r, 1200));
    const grid = document.getElementById('galGrid');
    return {
      immediate,
      cards: document.querySelectorAll('#galGrid .gal-card').length,
      count: document.getElementById('galCount').textContent,
      summary: document.getElementById('galSummary').textContent,
      tocDisplay: getComputedStyle(document.querySelector('.reader-toc')).display,
      viewDisplay: getComputedStyle(document.getElementById('rdView')).display,
      footDisplay: getComputedStyle(document.querySelector('.reader-foot')).display,
      gridOverflow: getComputedStyle(grid).overflowY,
      images: em.gallery.images.map(i => ({
        path: i.path, name: i.name, w: i.width, h: i.height, bytes: i.bytes,
        format: i.format, ref: i.referenced, css: !!i.usedInCss, ch: i.chapters
      })),
      okThumbs: document.querySelectorAll('#galGrid .gal-thumb[data-state="ok"]').length,
      thumbsAfter: em.gallery.images.filter(i => i._thumb).length,
      firstImg: (() => {
        const im = document.querySelector('#galGrid .gal-card img');
        return im ? { w: im.naturalWidth, h: im.naturalHeight } : null;
      })()
    };
  });
  ok(switched.tocDisplay === 'none' && switched.viewDisplay === 'none', '图片模式下目录与正文区让位', switched.tocDisplay + ' / ' + switched.viewDisplay);
  ok(switched.footDisplay === 'none', '图片模式下隐藏翻页工具条（避免无效入口）');
  ok(Number(switched.count) === switched.cards && switched.cards === switched.images.length,
    '图片数量来自真实清单', switched.cards + ' 张 / 总数 ' + switched.images.length);
  ok(/共 \d+ 张 · \d+ 张被引用 · \d+ 张未被引用 · 合计/.test(switched.summary), '清单概览说明了引用与未引用', switched.summary);
  ok(switched.images.every(i => i.w > 0 && i.h > 0), '每张图都读到了真实像素尺寸',
    switched.images.map(i => i.w + '×' + i.h).join(' '));
  ok(switched.images.every(i => i.bytes > 0 && i.format), '每张图都有文件大小与格式',
    switched.images.map(i => i.format + '/' + Math.round(i.bytes / 1024) + 'KB').join(' '));
  ok(switched.images.some(i => i.ref === false), '未引用的图片被单独标注出来',
    switched.images.filter(i => !i.ref).map(i => i.name).join(','));
  ok(switched.images.some(i => i.ref && i.ch && i.ch.length), '被引用的图片记录了所在章节',
    switched.images.filter(i => i.ref && i.ch.length).map(i => i.name + '→第' + (i.ch[0] + 1) + '章').join(' '));
  ok(switched.immediate.thumbs === 0 || switched.immediate.thumbs <= 2,
    '刚切过去时没有一次性解码全部缩略图（按需）', '立即生成 ' + switched.immediate.thumbs + ' / ' + switched.cards);
  ok(switched.okThumbs === switched.cards, '视口内的缩略图随后都画出来了', switched.okThumbs + ' 张');
  ok(switched.firstImg && switched.firstImg.w > 0, '缩略图是真的图片，不是占位框',
    switched.firstImg ? switched.firstImg.w + '×' + switched.firstImg.h : '无');
  ok(switched.gridOverflow === 'auto' || switched.gridOverflow === 'scroll', '网格区可滚动', switched.gridOverflow);

  const cardText = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('#galGrid .gal-card')];
    return cards.map(c => ({
      name: (c.querySelector('.gal-name') || {}).textContent,
      subs: [...c.querySelectorAll('.gal-sub')].map(x => x.textContent),
      tags: [...c.querySelectorAll('.gal-tag')].map(x => x.textContent)
    }));
  });
  ok(cardText.every(c => /\d+×\d+ · [\d.]+ [KMG]B · \w+/.test(c.subs[0] || '')),
    '卡片上写明像素、体积、格式', cardText[0].subs[0]);
  ok(cardText.some(c => c.tags.includes('未引用')), '未引用图片在缩略图上打了标');
  ok(cardText.some(c => /第 \d+ 章/.test(c.subs[1] || '')),
    '卡片写清图片出现在哪一章', cardText.map(c => c.subs[1]).join(' | '));

  console.log('[3] 搜索 / 排序 / 尺寸筛选 / 只看引用');
  const filters = await p.evaluate(async () => {
    const $ = id => document.getElementById(id);
    const fire = (el, t) => el.dispatchEvent(new Event(t, { bubbles: true }));
    const total = window.__em.gallery.images.length;
    const usedCount = window.__em.gallery.images.filter(i => i.referenced).length;

    const names = window.__em.gallery.images.map(i => i.name);
    const probe = names[names.length - 1].replace(/\.[a-z]+$/i, '').slice(0, 3);

    $('galSearch').value = probe;
    fire($('galSearch'), 'input');
    const searched = window.__em.gallery.view.length;

    $('galSearch').value = '';
    fire($('galSearch'), 'input');

    $('galSort').value = 'size';
    fire($('galSort'), 'change');
    const sizes = window.__em.gallery.view.map(i => i.bytes);

    $('galSort').value = 'pixels';
    fire($('galSort'), 'change');
    const pixels = window.__em.gallery.view.map(i => i.width * i.height);

    $('galSort').value = 'order';
    fire($('galSort'), 'change');
    const order = window.__em.gallery.view.map(i => i.order);
    const orderSorted = order.slice().sort((a, b) => a - b);

    $('galMinSize').value = '1200';
    fire($('galMinSize'), 'change');
    const big = window.__em.gallery.view.map(i => Math.max(i.width, i.height));
    const bigCount = big.length;

    $('galMinSize').value = 'all';
    fire($('galMinSize'), 'change');

    $('galOnlyUsed').checked = true;
    fire($('galOnlyUsed'), 'change');
    const usedView = window.__em.gallery.view.length;
    const allUsed = window.__em.gallery.view.every(i => i.referenced);

    $('galOnlyUsed').checked = false;
    fire($('galOnlyUsed'), 'change');

    // 搜个不存在的名字 → 明确的空状态，不是白屏
    $('galSearch').value = 'zzzz-not-exist';
    fire($('galSearch'), 'input');
    const emptyState = { shown: !$('galState').hidden, text: $('galState').textContent };
    $('galSearch').value = '';
    fire($('galSearch'), 'input');
    await new Promise(r => setTimeout(r, 300));

    return {
      total, usedCount, probe, searched, sizes, pixels, order, orderSorted, big, bigCount,
      usedView, allUsed, emptyState, backToAll: window.__em.gallery.view.length
    };
  });
  ok(filters.searched > 0 && filters.searched < filters.total, '按文件名搜索能筛出子集',
    '搜 "' + filters.probe + '" → ' + filters.searched + ' / ' + filters.total);
  ok(JSON.stringify(filters.sizes) === JSON.stringify(filters.sizes.slice().sort((a, b) => b - a)) && filters.sizes.length === filters.total,
    '按大小排序：从大到小', filters.sizes.map(x => Math.round(x / 1024) + 'K').join(' > '));
  ok(JSON.stringify(filters.pixels) === JSON.stringify(filters.pixels.slice().sort((a, b) => b - a)), '按分辨率排序：从高到低',
    filters.pixels.map(x => Math.round(x / 10000) + '万').join(' > '));
  ok(JSON.stringify(filters.order) === JSON.stringify(filters.orderSorted), '按引用顺序排序还原成原书顺序',
    filters.order.join(','));
  ok(filters.big.every(v => v >= 1200), '尺寸筛选不会放过长边 <1200 的图',
    filters.bigCount + ' / ' + filters.total + '，最小长边 ' + Math.min(...filters.big));
  ok(filters.usedView === filters.usedCount && filters.allUsed,
    '「只看正文引用」正好等于被引用的张数', filters.usedView + ' / 引用 ' + filters.usedCount);
  ok(filters.emptyState.shown && /没有图片|放宽筛选/.test(filters.emptyState.text),
    '筛不出结果时给明确说明而不是空白', filters.emptyState.text.replace(/\s+/g, ' ').slice(0, 40));
  ok(filters.backToAll === filters.total, '清空条件后恢复全部', filters.backToAll + ' 张');

  console.log('[4] 大图查看：适应 / 原始尺寸 / 缩放 / 上下张');
  const lb1 = await p.evaluate(async () => {
    document.querySelectorAll('#galGrid .gal-card')[0].click();
    await new Promise(r => setTimeout(r, 700));
    const img = document.getElementById('lbImg');
    const view = window.__em.gallery.view;
    return {
      open: !document.getElementById('lightbox').hidden,
      name: document.getElementById('lbName').textContent,
      meta: document.getElementById('lbMeta').textContent,
      foot: document.getElementById('lbFoot').textContent,
      isFit: document.getElementById('lbStage').classList.contains('is-fit'),
      zoomLabel: document.getElementById('lbZoomVal').textContent,
      prevDisabled: document.getElementById('lbPrev').disabled,
      nextDisabled: document.getElementById('lbNext').disabled,
      nat: { w: img.naturalWidth, h: img.naturalHeight },
      rendered: { w: Math.round(img.getBoundingClientRect().width), h: Math.round(img.getBoundingClientRect().height) },
      stage: { w: Math.round(document.getElementById('lbStage').getBoundingClientRect().width), h: Math.round(document.getElementById('lbStage').getBoundingClientRect().height) },
      compareDisabled: document.getElementById('lbCompare').disabled,
      compareTitle: document.getElementById('lbCompare').title,
      viewCount: view.length
    };
  });
  ok(lb1.open, '点缩略图打开大图');
  ok(/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(lb1.name), '大图显示文件名', lb1.name);
  ok(/\d+×\d+　·　[\d.]+ [KMG]B　·　\w+/.test(lb1.meta), '大图显示原始分辨率/体积/格式', lb1.meta);
  ok(/第 \d+ 章|样式表引用|未在任何章节/.test(lb1.meta), '大图显示所在章节（拿不到就说没有）', lb1.meta);
  ok(lb1.isFit && lb1.zoomLabel === '适应', '默认适应窗口', lb1.zoomLabel);
  ok(lb1.rendered.w <= lb1.stage.w + 2 && lb1.rendered.h <= lb1.stage.h + 2,
    '适应窗口时整张图都在可视区内（不裁切不溢出）',
    lb1.rendered.w + '×' + lb1.rendered.h + ' in ' + lb1.stage.w + '×' + lb1.stage.h);
  ok(lb1.prevDisabled && (lb1.viewCount === 1 || !lb1.nextDisabled), '第一张时「上一张」禁用、「下一张」可用');
  ok(lb1.compareDisabled && /结果页/.test(lb1.compareTitle), '从原书打开时对比按钮禁用并说明原因',
    lb1.compareTitle.slice(0, 24));

  const lb2 = await p.evaluate(async () => {
    document.getElementById('lbNext').click();
    await new Promise(r => setTimeout(r, 600));
    const next = {
      name: document.getElementById('lbName').textContent,
      foot: document.getElementById('lbFoot').textContent,
      prevDisabled: document.getElementById('lbPrev').disabled
    };
    document.getElementById('lbActual').click();
    await new Promise(r => setTimeout(r, 500));
    const img = document.getElementById('lbImg');
    const actual = {
      label: document.getElementById('lbZoomVal').textContent,
      cssW: Math.round(img.getBoundingClientRect().width),
      natW: img.naturalWidth
    };
    document.getElementById('lbZoomIn').click();
    await new Promise(r => setTimeout(r, 400));
    const zoomIn = document.getElementById('lbZoomVal').textContent;
    document.getElementById('lbZoomOut').click();
    await new Promise(r => setTimeout(r, 300));
    document.getElementById('lbFit').click();
    await new Promise(r => setTimeout(r, 300));
    return {
      next, actual, zoomIn,
      backToFit: document.getElementById('lbZoomVal').textContent,
      isFit: document.getElementById('lbStage').classList.contains('is-fit')
    };
  });
  ok(/第 2 \//.test(lb2.next.foot), '「下一张」真的换了图', lb2.next.foot.slice(0, 34));
  ok(!lb2.next.prevDisabled, '翻到第二张后「上一张」可用');
  ok(lb2.actual.label === '100%' && Math.abs(lb2.actual.cssW - lb2.actual.natW) <= 2,
    '「原始尺寸」按 1:1 显示', lb2.actual.cssW + 'px / 原图 ' + lb2.actual.natW + 'px');
  ok(lb2.zoomIn === '120%', '放大按钮按 20% 步进', lb2.zoomIn);
  ok(lb2.isFit && lb2.backToFit === '适应', '「适应窗口」能回到完整可见', lb2.backToFit);

  const lb3 = await p.evaluate(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    const right = document.getElementById('lbFoot').textContent;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    return {
      right,
      closed: document.getElementById('lightbox').hidden,
      readerStill: !document.getElementById('reader').hidden,
      srcCleared: !document.getElementById('lbImg').getAttribute('src')
    };
  });
  ok(/第 3 \//.test(lb3.right), '键盘 → 也能翻下一张', lb3.right.slice(0, 30));
  ok(lb3.closed && lb3.readerStill, 'Esc 关闭大图但回到图库，不会连阅读窗口一起关掉');
  ok(lb3.srcCleared, '关闭后清掉大图 src，不占着原图内存');

  console.log('[5] 切回原书阅读');
  const back = await p.evaluate(async () => {
    document.querySelector('#rdModeSeg [data-mode="read"]').click();
    await new Promise(r => setTimeout(r, 400));
    const d = document.getElementById('rdFrame').contentDocument;
    return {
      galHidden: document.getElementById('rdGallery').hidden,
      tocDisplay: getComputedStyle(document.querySelector('.reader-toc')).display,
      p: d.querySelectorAll('p').length,
      mode: window.__em.reader.mode
    };
  });
  ok(back.galHidden && back.tocDisplay !== 'none' && back.p > 0,
    '切回原书阅读不用重开，正文还在', '段落 ' + back.p);

  console.log('[6] 关闭阅读窗口后资源释放');
  const closed = await p.evaluate(async () => {
    document.getElementById('rdClose').click();
    await new Promise(r => setTimeout(r, 400));
    let threw = '';
    try { window.EpubFix.readImage(window.__em.reader.book || {}, 'x'); } catch (e) { threw = e.message; }
    return {
      hidden: document.getElementById('reader').hidden,
      threw,
      galImages: window.__em.gallery.images.length,
      grid: document.getElementById('galGrid').innerHTML.length,
      view: window.__em.gallery.view.length
    };
  });
  ok(closed.hidden, '关闭后阅读窗口隐藏');
  ok(/关闭/.test(closed.threw), '书已释放，再取图片会明确报错', closed.threw);
  ok(closed.galImages === 0 && closed.view === 0 && closed.grid === 0,
    '图库清单与缩略图节点一并清空', closed.galImages + ' / ' + closed.grid);

  console.log('[7] 处理后的书：与原书对比同一张图');
  const proc = await p.evaluate(async () => {
    document.getElementById('startBtn2').click();
    for (let i = 0; i < 600; i++) {
      if (!window.__em.state.busy && window.__em.state.result) break;
      await new Promise(r => setTimeout(r, 250));
    }
    const r = window.__em.state.result;
    return r ? {
      ok: true,
      outVer: r.res.report.outputVersion,
      verified: r.res.report.versionVerified,
      paths: (r.res.report.items || []).length
    } : { ok: false };
  });
  ok(proc.ok, '处理完成，可进入结果页');

  const cmp = await p.evaluate(async () => {
    document.getElementById('previewBtn').click();
    for (let i = 0; i < 200; i++) {
      if (!document.getElementById('reader').hidden && window.__em.reader.book) break;
      await new Promise(r => setTimeout(r, 150));
    }
    document.querySelector('#rdModeSeg [data-mode="images"]').click();
    await new Promise(r => setTimeout(r, 1200));
    const cards = document.querySelectorAll('#galGrid .gal-card').length;
    document.querySelectorAll('#galGrid .gal-card')[0].click();
    await new Promise(r => setTimeout(r, 700));
    const beforeDisabled = document.getElementById('lbCompare').disabled;
    const beforeToasts = document.querySelectorAll('#toastWrap .toast').length;
    document.getElementById('lbCompare').click();
    // 对比要先解包原书（19MB），不能固定等一小会儿就断言
    for (let i = 0; i < 120; i++) {
      const done = !document.getElementById('lbPaneB').hidden ||
        document.querySelectorAll('#toastWrap .toast').length > beforeToasts;
      if (done) break;
      await new Promise(r => setTimeout(r, 250));
    }
    await new Promise(r => setTimeout(r, 600));
    const after = {
      hiddenB: document.getElementById('lbPaneB').hidden,
      isCompare: document.getElementById('lbStage').classList.contains('is-compare'),
      capA: document.getElementById('lbCapA').textContent,
      capB: document.getElementById('lbCapB').textContent,
      foot: document.getElementById('lbFoot').textContent,
      imgB: (() => { const i = document.getElementById('lbImgB'); return { src: !!i.getAttribute('src'), w: i.naturalWidth }; })()
    };
    return {
      cards, beforeDisabled, after,
      source: document.getElementById('rdSource').textContent,
      paths: window.__em.gallery.images.map(i => i.path)
    };
  });
  ok(!cmp.beforeDisabled, '从结果页打开时对比按钮可用');
  ok(cmp.after.hiddenB === false && cmp.after.isCompare, '对比后右栏出现原书那张图');
  ok(/处理后 · [\d.]+ [KMG]B/.test(cmp.after.capA) && /原书 · [\d.]+ [KMG]B/.test(cmp.after.capB),
    '两侧标注了各自体积，能看出压缩前后差别', cmp.after.capA + ' | ' + cmp.after.capB);
  ok(cmp.after.imgB.src && cmp.after.imgB.w > 0, '原书那张图真的解码出来了', cmp.after.imgB.w + 'px 宽');
  ok(/同一路径|按文件名匹配/.test(cmp.after.foot), '说明两张图是按什么对上的', cmp.after.foot.slice(0, 40));

  const mismatch = await p.evaluate(async () => {
    // 先切回单图，再把当前图路径改成一个原书里没有的名字
    document.getElementById('lbCompare').click();
    await new Promise(r => setTimeout(r, 300));
    const g = window.__em.gallery;
    // 路径和文件名都改成原书里没有的，模拟"匹配不上"的情况
    g.view[g.idx] = Object.assign({}, g.view[g.idx], {
      path: 'OEBPS/Images/not-in-original.png',
      name: 'not-in-original.png'
    });
    document.getElementById('lbCompare').click();
    await new Promise(r => setTimeout(r, 1200));
    const toasts = [...document.querySelectorAll('#toastWrap .toast')].map(t => t.textContent);
    return {
      hiddenB: document.getElementById('lbPaneB').hidden,
      toasts
    };
  });
  ok(mismatch.hiddenB === true, '路径对不上时不显示对比栏，不拿别的图充数');
  ok(mismatch.toasts.some(t => /无法确认是同一张|没有能对上的图片/.test(t)),
    '明确提示无法确认是同一张', (mismatch.toasts[mismatch.toasts.length - 1] || '').slice(0, 46));

  console.log('[8] 120 张图：渲染耗时与按需加载');
  await p.evaluate(async () => {
    document.getElementById('lbClose').click();
    await new Promise(r => setTimeout(r, 200));
    document.getElementById('rdClose').click();
    await new Promise(r => setTimeout(r, 300));
    document.getElementById('rechooseBtn').click();
    await new Promise(r => setTimeout(r, 300));
  });
  ok(await drop(p, 'test/sample_many.epub', '大量图片测试书.epub'), '多图样书导入就绪');

  const many = await p.evaluate(async () => {
    document.getElementById('previewBookBtn').click();
    for (let i = 0; i < 300; i++) {
      if (!document.getElementById('reader').hidden && window.__em.reader.book) break;
      await new Promise(r => setTimeout(r, 100));
    }
    const t0 = performance.now();
    document.querySelector('#rdModeSeg [data-mode="images"]').click();
    const renderMs = performance.now() - t0;
    const total = window.__em.gallery.images.length;
    const cards = document.querySelectorAll('#galGrid .gal-card').length;
    const immediate = document.querySelectorAll('#galGrid .gal-thumb[data-state="ok"]').length;
    const immedThumbs = window.__em.gallery.images.filter(i => i._thumb).length;

    await new Promise(r => setTimeout(r, 1500));
    const afterView = document.querySelectorAll('#galGrid .gal-thumb[data-state="ok"]').length;

    const grid = document.getElementById('galGrid');
    grid.scrollTop = grid.scrollHeight;
    await new Promise(r => setTimeout(r, 1500));
    const afterScroll = document.querySelectorAll('#galGrid .gal-thumb[data-state="ok"]').length;

    // 只被样式表引用的两张，标注不能错
    const cssOnly = window.__em.gallery.images.filter(i => !i.chapters.length && i.usedInCss).map(i => i.name);
    const unused = window.__em.gallery.images.filter(i => !i.referenced).length;
    // 尺寸筛选：120 张里有 2400×3200 / 1600×1200 / 1200×1600 三种过线
    const minSel = document.getElementById('galMinSize');
    minSel.value = '1200';
    minSel.dispatchEvent(new Event('change', { bubbles: true }));
    const filtered = window.__em.gallery.view.map(i => Math.max(i.width, i.height));
    const filteredCount = window.__em.gallery.view.length;
    minSel.value = 'all';
    minSel.dispatchEvent(new Event('change', { bubbles: true }));
    // 内存：缩略图是 dataURL 字符串，不该为全部 120 张都留着原图 objectURL
    const urls = window.__em.gallery.urls.length;
    return {
      total, cards, renderMs: Math.round(renderMs), immediate, immedThumbs,
      afterView, afterScroll, cssOnly, unused, urls, filtered, filteredCount,
      backCount: window.__em.gallery.view.length,
      gridScrollable: grid.scrollHeight > grid.clientHeight + 1
    };
  });
  ok(many.total === 120 && many.cards === 120, '120 张图全部进入清单', many.cards + ' 张');
  ok(many.renderMs < 1500, '切到图片模式不卡（网格用占位符先渲染）', many.renderMs + 'ms');
  ok(many.immedThumbs < many.total && many.immediate < many.total,
    '首屏只解码视口内的缩略图', '立即 ' + many.immediate + ' 张 / 共 ' + many.total);
  ok(many.afterView > 0 && many.afterView < many.total, '滚到哪解到哪，不是一次性全解',
    '首屏 ' + many.afterView + ' 张');
  ok(many.afterScroll > many.afterView, '往下滚会继续补缩略图', many.afterView + ' → ' + many.afterScroll);
  ok(many.gridScrollable, '图多时网格内部滚动，不撑破窗口');
  ok(many.filteredCount > 0 && many.filteredCount < many.total && many.filtered.every(v => v >= 1200),
    '尺寸筛选真的筛掉了小图',
    many.filteredCount + ' / ' + many.total + '，最小长边 ' + Math.min(...many.filtered));
  ok(many.backCount === many.total, '清空筛选恢复全部图片', many.backCount + ' 张');
  ok(many.unused === 88, '未引用统计准确（120 - 30 张正文引用 - 2 张样式表引用）', many.unused + ' 张');
  ok(many.cssOnly.length === 2, '只在样式表里出现的图片被识别', many.cssOnly.join(','));
  ok(many.urls < 40, '退出前没有堆积大量未释放的 objectURL', many.urls + ' 个');

  console.log('[9] 截图');
  await p.evaluate(async () => {
    const grid = document.getElementById('galGrid');
    grid.scrollTop = 0;
    await new Promise(r => setTimeout(r, 800));
    document.querySelectorAll('#galGrid .gal-card')[0].click();
    await new Promise(r => setTimeout(r, 900));
  });
  await p.screenshot({ path: path.join(ROOT, 'test', 'v22_gallery_many.png') });
  await p.evaluate(async () => {
    document.getElementById('lbClose').click();
    await new Promise(r => setTimeout(r, 200));
  });
  await p.screenshot({ path: path.join(ROOT, 'test', 'v22_gallery_grid.png') });

  console.log('[10] 处理后：没被引用的图片不能被悄悄吃掉');
  const dropReport = await p.evaluate(async () => {
    document.getElementById('lbClose').click();
    await new Promise(r => setTimeout(r, 200));
    document.getElementById('rdClose').click();
    await new Promise(r => setTimeout(r, 300));
    // 直接用引擎再跑一遍，核对包里到底写了哪些图
    const buf = window.__em.state.current.buffer;
    const r = await window.EpubFix.process(new Uint8Array(buf), { mode: 'deep', outputVersion: 'auto' });
    const un = fflate.unzipSync(r.volumes[0].bytes);
    const names = Object.keys(un).filter(n => /OEBPS\/Img\//.test(n));
    return {
      unused: r.report.unusedImages,
      unusedBytes: r.report.unusedImageBytes,
      written: names.length,
      warned: (r.report.warnings || []).some(w => /死资源/.test(w)),
      total: r.report.imagesFound
    };
  });
  ok(dropReport.unused === 90 && dropReport.written === 30,
    '未引用图片不再写进新包，且数量对得上',
    '发现 ' + dropReport.total + ' / 写入 ' + dropReport.written + ' / 未引用 ' + dropReport.unused);
  ok(dropReport.warned, '处理报告里明确说明这些图为什么没进新包',
    (dropReport.unusedBytes / 1048576).toFixed(2) + ' MB');

  const uiDrop = await p.evaluate(async () => {
    document.getElementById('startBtn2').click();
    for (let i = 0; i < 600; i++) {
      if (!window.__em.state.busy && window.__em.state.result) break;
      await new Promise(r => setTimeout(r, 250));
    }
    const rep = window.__em.state.result.res.report;
    const cat = [...document.querySelectorAll('#breakdown .cat')]
      .find(c => /图片/.test((c.querySelector('.cat-name') || {}).textContent || ''));
    return {
      unused: rep.unusedImages,
      text: cat ? cat.innerText.replace(/\s+/g, ' ') : '',
      warn: (rep.warnings || []).join(' | ')
    };
  });
  ok(uiDrop.unused === 90, '界面拿到的也是真实数字', uiDrop.unused + ' 张');
  ok(/90/.test(uiDrop.text) && /死资源|没有写进新包/.test(uiDrop.text),
    '结果页图片分类写清了"跳过了哪些、为什么"', uiDrop.text.slice(0, 90));
  ok(/死资源/.test(uiDrop.warn), '警告列表里也有一条完整说明', uiDrop.warn.slice(0, 50));

  const afterGall = await p.evaluate(async () => {
    document.getElementById('previewBtn').click();
    for (let i = 0; i < 200; i++) {
      if (!document.getElementById('reader').hidden && window.__em.reader.book) break;
      await new Promise(r => setTimeout(r, 150));
    }
    document.querySelector('#rdModeSeg [data-mode="images"]').click();
    await new Promise(r => setTimeout(r, 900));
    return {
      count: window.__em.gallery.images.length,
      summary: document.getElementById('galSummary').textContent,
      source: document.getElementById('rdSource').textContent
    };
  });
  ok(afterGall.count === 30, '处理后的书里图库只剩真正保留的图片', afterGall.count + ' 张');
  ok(/共 30 张/.test(afterGall.summary), '概览与文件内容一致', afterGall.summary);

  console.log('[11] 坏图：明确提示，不让整页崩');
  await p.evaluate(async () => {
    document.getElementById('rdClose').click();
    await new Promise(r => setTimeout(r, 300));
    document.getElementById('rechooseBtn').click();
    await new Promise(r => setTimeout(r, 300));
  });
  ok(await drop(p, 'test/sample_badimg.epub', '坏图样书.epub'), '坏图样书导入就绪');

  const badImg = await p.evaluate(async () => {
    document.getElementById('previewBookBtn').click();
    for (let i = 0; i < 300; i++) {
      if (!document.getElementById('reader').hidden && window.__em.reader.book) break;
      await new Promise(r => setTimeout(r, 100));
    }
    document.querySelector('#rdModeSeg [data-mode="images"]').click();
    await new Promise(r => setTimeout(r, 1800));
    const thumbs = [...document.querySelectorAll('#galGrid .gal-thumb')];
    const info = thumbs.map(t => ({
      path: t.dataset.path,
      state: t.dataset.state,
      text: (t.textContent || '').trim(),
      hasImg: !!t.querySelector('img')
    }));
    // 点开那张坏图，看大图层怎么处理
    const cards = [...document.querySelectorAll('#galGrid .gal-card')];
    const badIdx = info.findIndex(x => /broken/.test(x.path));
    cards[badIdx >= 0 ? badIdx : 0].click();
    await new Promise(r => setTimeout(r, 1200));
    const lb = {
      open: !document.getElementById('lightbox').hidden,
      foot: document.getElementById('lbFoot').textContent,
      name: document.getElementById('lbName').textContent
    };
    document.getElementById('lbClose').click();
    // 切回原书阅读，确认正文没被坏图带崩
    document.querySelector('#rdModeSeg [data-mode="read"]').click();
    await new Promise(r => setTimeout(r, 700));
    const d = document.getElementById('rdFrame').contentDocument;
    return {
      info, lb,
      p: d.querySelectorAll('p').length,
      mode: window.__em.reader.mode,
      count: window.__em.gallery.images.length
    };
  });
  ok(badImg.count === 2, '坏图也照样列进清单（不隐藏问题）', badImg.count + ' 张');
  const brokenCard = badImg.info.find(x => /broken/.test(x.path));
  const goodCard = badImg.info.find(x => /good/.test(x.path));
  ok(goodCard && goodCard.state === 'ok' && goodCard.hasImg, '正常那张照常显示');
  ok(brokenCard && brokenCard.state === 'error' && !brokenCard.hasImg,
    '解不开的那张标成错误状态，不留空框', brokenCard && brokenCard.text);
  ok(brokenCard && /无法在当前环境解码|无法解码/.test(brokenCard.text),
    '错误原因写在格子里，用户看得懂', brokenCard && brokenCard.text);
  ok(badImg.lb.open && /无法在当前环境解码|无法解码/.test(badImg.lb.foot),
    '打开大图时也明确说解不开，而不是白屏', badImg.lb.foot.slice(0, 50));
  ok(badImg.p > 2 && badImg.mode === 'read', '坏图不影响正文，切回阅读照常', badImg.p + ' 段');

  ok(errs.length === 0, '全程无 JS 报错', errs.slice(0, 3).join(' | ') || undefined);

  await b.close(); server.close();
  console.log(bad === 0 ? '\n图片浏览测试通过' : '\n有 ' + bad + ' 项未通过');
  process.exit(bad === 0 ? 0 : 1);
});
