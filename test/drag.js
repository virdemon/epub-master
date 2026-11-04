/* 真拖拽：用 DataTransfer 模拟把文件丢进拖拽区（不是点按钮选文件） */
const fs = require('fs'), path = require('path'), puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '..');
const PAGE = 'file://' + path.join(ROOT, 'epubfix', 'index.html').replace(/\\/g, '/');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SAMPLE = 'test/sample_book.epub';
let fails = 0;
const ok = (c, l, e) => { console.log((c ? '  OK   ' : '  FAIL ') + l + (e !== undefined ? '  → ' + e : '')); if (!c) fails++; };

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: true, protocolTimeout: 300000,
    args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1360, height: 900 });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto(PAGE, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 500));

  const b64 = fs.readFileSync(path.join(ROOT, SAMPLE)).toString('base64');

  // 先造一个带文件的 DataTransfer：真实拖拽的 types 里一定有 'Files'
  const hover = await p.evaluate((data) => {
    const bin = atob(data); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], '雾中渡口.epub', { type: 'application/epub+zip' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const dz = document.getElementById('dropzone');
    document.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
    const on = dz.className;
    document.dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: dt }));
    return { on, off: dz.className, size: file.size };
  }, b64);
  ok(/is-over/.test(hover.on), '拖入时拖拽区有高亮态', hover.on);
  ok(!/is-over/.test(hover.off), '离开后高亮消失', hover.off);

  // 真丢文件进去
  const dropped = await p.evaluate((data) => {
    const bin = atob(data); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], '雾中渡口.epub', { type: 'application/epub+zip' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const dz = document.getElementById('dropzone');
    document.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
    document.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    document.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    return file.size;
  }, b64);
  console.log('    丢入文件', (dropped / 1048576).toFixed(2), 'MB');

  await p.waitForFunction(() => {
    const c = document.getElementById('fileCard');
    return c && !c.hidden && c.dataset.ready === '1';
  }, { timeout: 60000 });
  const card = await p.evaluate(() => ({
    title: document.getElementById('fileTitle').textContent,
    facts: document.getElementById('fileFacts').textContent,
    cover: (() => { const i = document.getElementById('coverImg'); return i.hidden ? 0 : i.naturalWidth; })(),
    emptyHidden: document.getElementById('dzEmpty').hidden
  }));
  console.log('    卡片:', card.title, '|', card.facts.replace(/　/g, ' '));
  ok(card.emptyHidden, '拖入后空态让位给书籍卡');
  ok(!!card.title, '拖拽导入拿到了书名', card.title);
  ok(card.cover > 0, '封面显示出来了', card.cover + 'px');
  ok(errs.length === 0, '无 JS 报错', errs.join(' | '));
  await p.screenshot({ path: path.join(ROOT, 'test', 'drag_card.png') });

  await b.close();
  console.log(fails ? `\n${fails} 项未通过` : '\n全部通过');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('崩: ' + e.message); process.exit(1); });
