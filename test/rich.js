/*
 * 排版要素验证：预览到底是在"真实渲染"，还是把文字抽出来拼纯文本。
 *
 * 用 tools/make_rich_epub.py 造的书，一次塞进最容易糊掉的六样东西：
 *   表格（thead/tbody/合并单元格/表注）、内联 SVG、以文件引用的 SVG、
 *   原书 CSS 的类（背景色/首字下沉/宋体）、图片与图注、加粗斜体列表。
 *
 * 判据全部来自 getComputedStyle 与元素的真实布局尺寸，
 * 只要有一项读不到，就说明那份 CSS 或那段结构没进预览。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'epubfix');
const SAMPLE = path.join(ROOT, 'test', 'sample_rich.epub');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

let bad = 0;
const ok = (c, m, d) => {
  console.log((c ? '  OK   ' : '  FAIL ') + m + (d !== undefined ? ' — ' + d : ''));
  if (!c) bad++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') u = '/index.html';
  const f = path.join(DIR, u);
  if (!f.startsWith(DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

/* 把一章读进 iframe 后，量一遍所有要断言的东西 */
const PROBE = () => {
  const d = document.getElementById('rdFrame').contentDocument;
  if (!d || !d.body) return null;
  const q = (s) => d.querySelector(s);
  const cs = (el) => (el ? getComputedStyle(el) : null);

  const table = q('table');
  const rows = table ? table.querySelectorAll('tr').length : 0;
  const cells = table ? table.querySelectorAll('th,td').length : 0;
  const span = table ? table.querySelector('[colspan]') : null;
  const caption = q('caption');

  const svg = q('svg');
  const svgBox = svg ? svg.getBoundingClientRect() : null;

  const svgImg = d.querySelector('img[src*="pic.svg"], img[src^="data:image/svg"]');
  const coverImg = d.querySelector('img[src*="cover"], img[src^="data:image/png"]');

  const note = q('.note');
  const drop = q('.dropcap');
  const bodyP = d.querySelector('p');
  const strong = q('strong');
  const em = q('em');
  const serif = q('.serif');

  return {
    bodyFont: cs(d.body).fontSize,
    bodyLine: cs(d.body).lineHeight,
    rows,
    cells,
    colspan: span ? span.getAttribute('colspan') : '',
    caption: caption ? caption.textContent.trim() : '',
    thBg: table ? cs(table.querySelector('th')).backgroundColor : '',
    svgW: svgBox ? Math.round(svgBox.width) : 0,
    svgH: svgBox ? Math.round(svgBox.height) : 0,
    svgKids: svg ? svg.children.length : 0,
    svgImgW: svgImg ? svgImg.naturalWidth : 0,
    svgImgBox: svgImg ? Math.round(svgImg.getBoundingClientRect().width) : 0,
    coverW: coverImg ? coverImg.naturalWidth : 0,
    noteBg: note ? cs(note).backgroundColor : '',
    notePad: note ? cs(note).paddingLeft : '',
    dropFont: drop ? parseFloat(cs(drop).fontSize) : 0,
    pFont: bodyP ? parseFloat(cs(bodyP).fontSize) : 0,
    dropFloat: drop ? cs(drop).float : '',
    strongW: strong ? parseInt(cs(strong).fontWeight, 10) : 0,
    emStyle: em ? cs(em).fontStyle : '',
    serifFamily: serif ? cs(serif).fontFamily : '',
    listItems: d.querySelectorAll('li').length,
    figCaption: d.querySelector('figcaption') ? d.querySelector('figcaption').textContent.trim() : '',
    paraCount: d.querySelectorAll('p').length
  };
};

/* 跳到第 i 章（0 起），等这一章真的渲染出来 */
async function gotoChapter(p, i) {
  await p.evaluate((idx) => {
    const li = document.querySelectorAll('#rdToc li[data-ch]')[idx];
    if (li) li.click();
  }, i);
  await p.waitForFunction(
    () => {
      const f = document.getElementById('rdFrame');
      return f && f.contentDocument && f.contentDocument.body && f.contentDocument.body.children.length > 0;
    },
    { timeout: 30000 }
  );
  await wait(700);
}

server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: EDGE,
      headless: true,
      protocolTimeout: 600000,
      args: ['--no-sandbox']
    });
    const p = await browser.newPage();
    await p.setViewport({ width: 1440, height: 900 });
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e.message || e)));
    p.on('console', (m) => {
      if (m.type() === 'error') errs.push('console: ' + m.text());
    });

    await p.goto(base + '/index.html', { waitUntil: 'networkidle2' });
    await wait(600);

    console.log('样书: sample_rich.epub（表格 / 内联 SVG / SVG 文件 / 自定义 CSS）\n');

    const b64 = fs.readFileSync(SAMPLE).toString('base64');
    const card = await p.evaluate(async (data) => {
      const bin = atob(data);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], '排版要素大全.epub', { type: 'application/epub+zip' });
      const dt = new DataTransfer();
      dt.items.add(file);
      document.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
      document.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
      for (let i = 0; i < 200; i++) {
        const c = document.getElementById('fileCard');
        if (c && !c.hidden && c.dataset.ready === '1') break;
        await new Promise((r) => setTimeout(r, 150));
      }
      return {
        facts: document.getElementById('fileFacts').textContent.replace(/\s+/g, ' ').trim(),
        cover: document.getElementById('coverImg').naturalWidth
      };
    }, b64);
    console.log('  卡片: ' + card.facts);
    ok(card.cover > 0, '封面在书籍卡上显示出来了', card.cover + 'px 宽');

    console.log('\n[1] 预览原书 · 表格');
    await p.click('#previewBookBtn');
    await p.waitForFunction(() => !document.getElementById('reader').hidden, { timeout: 30000 });
    await p.waitForFunction(
      () => {
        const f = document.getElementById('rdFrame');
        return f && f.contentDocument && f.contentDocument.body && f.contentDocument.body.children.length > 0;
      },
      { timeout: 30000 }
    );
    await wait(600);

    const t = await p.evaluate(PROBE);
    ok(t.rows === 5, '表格行数正确（表头 1 + 数据 4）', t.rows + ' 行');
    ok(t.cells === 19, '单元格数量正确（含 colspan 合并的那格）', t.cells + ' 格');
    ok(t.colspan === '2', '合并单元格保留', 'colspan=' + t.colspan);
    ok(/表 1-1/.test(t.caption), '表注保留', t.caption);
    ok(t.thBg && t.thBg !== 'rgba(0, 0, 0, 0)', '原书 CSS 给表头加的背景色生效', t.thBg);

    console.log('\n[2] 预览原书 · 矢量图（第 2 章）');
    await gotoChapter(p, 1);
    const t2 = await p.evaluate(PROBE);
    ok(t2.svgW > 200 && t2.svgH > 80, '内联 SVG 画出真实尺寸（不是 0×0）', t2.svgW + '×' + t2.svgH);
    ok(t2.svgKids >= 3, '内联 SVG 的子元素都在', t2.svgKids + ' 个');
    ok(t2.svgImgW > 0, '以文件引用的 SVG 也加载成功了', t2.svgImgW + 'px 宽（布局宽 ' + t2.svgImgBox + '）');
    ok(/图 2-1/.test(t2.figCaption), '图注文字保留', t2.figCaption);

    console.log('\n[3] 预览原书 · 原书 CSS（第 3 章）');
    await gotoChapter(p, 2);
    const t3 = await p.evaluate(PROBE);
    ok(t3.coverW > 0, '位图封面在正文里显示正常', t3.coverW + 'px');
    ok(/图 3-1/.test(t3.figCaption), '图片的图注保留', t3.figCaption);
    ok(t3.noteBg === 'rgb(255, 246, 213)', '提示块背景色与书里写的一致', t3.noteBg);
    ok(parseFloat(t3.notePad) > 5, '提示块内边距生效', t3.notePad);
    ok(t3.dropFont >= t3.pFont * 2, '首字下沉字号明显大于正文', t3.dropFont + 'px vs ' + t3.pFont + 'px');
    ok(t3.dropFloat === 'left', '首字下沉的浮动生效', t3.dropFloat);
    ok(parseFloat(t3.bodyLine) > 20, '行距来自原书样式（1.9）', t3.bodyLine);

    console.log('\n[3b] 预览原书 · 文字样式（第 1 章）');
    await gotoChapter(p, 0);
    const t1 = await p.evaluate(PROBE);
    ok(/serif|song|simsun/i.test(t1.serifFamily), '自定义字体族生效', t1.serifFamily.slice(0, 40));
    ok(t1.strongW >= 600, '加粗是粗的', 'font-weight=' + t1.strongW);
    ok(t1.emStyle === 'italic', '斜体是斜的', t1.emStyle);
    ok(t1.listItems === 3, '列表项齐全', t1.listItems + ' 项');

    console.log('\n[4] 阅读样式不能把结构改坏（回到第 2 章再切）');
    await gotoChapter(p, 1);
    await p.click('#rdStyleSeg [data-style="reading"]');
    // 切样式会整章重渲染一次，iframe 会短暂空缺，等它把 SVG 重新画出来再量
    await p
      .waitForFunction(
        () => {
          const f = document.getElementById('rdFrame');
          const d = f && f.contentDocument;
          const svg = d && d.querySelector('svg');
          return !!(svg && svg.getBoundingClientRect().width > 100);
        },
        { timeout: 20000 }
      )
      .catch(() => {});
    await wait(400);
    const r2 = await p.evaluate(PROBE);
    ok(r2.svgW > 200, '切到阅读样式后 SVG 还在', r2.svgW + '×' + r2.svgH);
    ok(r2.svgImgW > 0, '切到阅读样式后 SVG 文件图还显示', r2.svgImgW + 'px');
    await gotoChapter(p, 0);
    const r1 = await p.evaluate(PROBE);
    ok(r1.rows === 5, '切到阅读样式后表格还在', r1.rows + ' 行');
    ok(r1.colspan === '2', '切到阅读样式后合并单元格还在', 'colspan=' + r1.colspan);

    console.log('\n[5] 处理之后，结构必须还在');
    await p.keyboard.press('Escape');
    await wait(300);
    await p.click('#startBtn2');
    await p.waitForSelector('#resultCard:not([hidden])', { timeout: 120000 });
    await wait(300);
    await p.click('#previewBtn');
    await p.waitForFunction(() => !document.getElementById('reader').hidden, { timeout: 30000 });
    await p.waitForFunction(
      () => {
        const f = document.getElementById('rdFrame');
        return f && f.contentDocument && f.contentDocument.body && f.contentDocument.body.children.length > 0;
      },
      { timeout: 30000 }
    );
    await wait(600);
    const a1 = await p.evaluate(PROBE);
    ok(a1.rows === 5, '处理后表格还在（没被当成杂项删掉）', a1.rows + ' 行');
    ok(a1.colspan === '2', '处理后合并单元格还在', 'colspan=' + a1.colspan);
    ok(a1.paraCount >= 4, '处理后正文有段落', a1.paraCount + ' 段');
    await gotoChapter(p, 1);
    const a2 = await p.evaluate(PROBE);
    ok(a2.svgW > 200, '处理后内联 SVG 还在', a2.svgW + '×' + a2.svgH);
    ok(a2.svgImgW > 0, '处理后 SVG 文件引用还能解析', a2.svgImgW + 'px');

    await p.screenshot({ path: path.join(ROOT, 'test', 'rich_preview.png') });
    ok(errs.length === 0, '全程无 JS 报错', errs.slice(0, 2).join(' | ') || '无');

    console.log('\n' + (bad ? '失败 ' + bad + ' 项' : '排版要素测试通过'));
    if (bad) process.exitCode = 1;
  } catch (e) {
    console.error('测试失败: ' + e.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});
