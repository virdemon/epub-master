/* 工具箱四项功能：都要求真的读写文件，不是只看界面 */
const fs = require('fs'), path = require('path'), puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '..');
const PAGE = 'file://' + path.join(ROOT, 'epubfix', 'index.html').replace(/\\/g, '/');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DL = path.join(ROOT, 'test', 'downloads_tools');
const TOOL_BOOK = path.join(ROOT, 'test', 'sample_tools.epub');

let fails = 0;
const ok = (c, label, extra) => {
  console.log((c ? '  OK   ' : '  FAIL ') + label + (extra !== undefined ? '  → ' + extra : ''));
  if (!c) fails++;
};
const wait = ms => new Promise(r => setTimeout(r, ms));

async function runTool(p, tool, file) {
  await p.evaluate(t => {
    const b = document.querySelector(`[data-tool="${t}"]`);
    b.click();
  }, tool);
  await p.waitForFunction(() => document.getElementById('toolPick'), { timeout: 10000 });
  await p.evaluate(() => document.getElementById('toolPick').click());
  await wait(300);
  const inp = await p.$('#toolInput');
  await inp.uploadFile(file);
  await p.waitForFunction(() => {
    const o = document.getElementById('toolOut');
    return o && o.innerText.trim().length > 0 && !/正在读取/.test(o.innerText);
  }, { timeout: 120000 });
  return p.evaluate(() => ({
    text: document.getElementById('toolOut').innerText,
    html: document.getElementById('toolOut').innerHTML.slice(0, 400),
    foot: [...document.querySelectorAll('#modalFoot button')].map(b => b.textContent)
  }));
}

async function closeModal(p) {
  await p.evaluate(() => {
    const m = document.getElementById('modal');
    if (m) { m.hidden = true; }
  });
  await wait(200);
}

(async () => {
  fs.rmSync(DL, { recursive: true, force: true });
  fs.mkdirSync(DL, { recursive: true });

  const b = await puppeteer.launch({ executablePath: EDGE, headless: true, protocolTimeout: 600000,
    args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 980 });
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const cdp = await p.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

  await p.goto(PAGE, { waitUntil: 'load' });
  await wait(500);
  await p.evaluate(() => document.querySelector('.nav-item[data-view="tools"]').click());
  await wait(200);

  /* ---------- 1. 结构检查 ---------- */
  console.log('\n[1] 结构检查');
  const st = await runTool(p, 'structure', TOOL_BOOK);
  const lines = st.text.split('\n').filter(Boolean);
  console.log('    ' + lines.slice(0, 6).join('\n    '));
  console.log('    按钮:', st.foot.join(' / ') || '无');
  ok(/错误|提示|正常/.test(st.text), '列出了结构问题');
  ok(/manifest|声明|未声明|不存在/.test(st.text), '指出 manifest 双向不一致');
  ok(st.foot.some(t => /修复/.test(t)), '有「修复结构并保存」按钮');

  // 点修复，验证真的产出新文件
  await p.evaluate(() => {
    const b2 = [...document.querySelectorAll('#modalFoot button')].find(x => /修复/.test(x.textContent));
    b2 && b2.click();
  });
  for (let i = 0; i < 60; i++) {
    await wait(1000);
    const got = fs.readdirSync(DL).filter(f => f.endsWith('.epub'));
    if (got.length) { await wait(600); break; }
  }
  const fixed = fs.readdirSync(DL).filter(f => f.endsWith('.epub'));
  console.log('    修复产物:', fixed.join(', ') || '（无）');
  ok(fixed.length > 0, '修复后生成了新的 epub');
  await p.screenshot({ path: path.join(ROOT, 'test', 'tool_structure.png') });
  await closeModal(p);
  const raw = fs.readdirSync(DL).filter(f => f.endsWith('.epub'));
  fs.mkdirSync(path.join(ROOT, 'test', 'tool_out'), { recursive: true });
  raw.forEach(f => fs.copyFileSync(path.join(DL, f), path.join(ROOT, 'test', 'tool_out', 'fixed.epub')));

  /* ---------- 2. 图片优化 ---------- */
  console.log('\n[2] 图片优化');
  fs.readdirSync(DL).forEach(f => fs.rmSync(path.join(DL, f)));
  const im = await runTool(p, 'images', TOOL_BOOK);
  console.log('    ' + im.text.split('\n').slice(0, 4).join('\n    '));
  ok(/张位图|共 \d+/.test(im.text), '统计出位图数量与体积');
  ok(/png|jpg|jpeg/i.test(im.text), '列出具体文件');
  ok(im.foot.some(t => /压缩/.test(t)), '有「压缩图片并保存」按钮');
  await p.evaluate(() => {
    const b2 = [...document.querySelectorAll('#modalFoot button')].find(x => /压缩/.test(x.textContent));
    b2 && b2.click();
  });
  await wait(1500);
  for (let i = 0; i < 90; i++) {
    await wait(1000);
    if (fs.readdirSync(DL).some(f => f.endsWith('.epub'))) { await wait(800); break; }
  }
  const imgOut = fs.readdirSync(DL).filter(f => f.endsWith('.epub'));
  console.log('    产物:', imgOut.join(', ') || '（无）');
  if (imgOut.length) {
    const sz = fs.statSync(path.join(DL, imgOut[0])).size;
    console.log('    体积:', (sz / 1048576).toFixed(2) + 'MB（原 18.69MB）');
    ok(sz < 18.69 * 1048576, '只压图片也显著减小了体积', (sz / 1048576).toFixed(2) + 'MB');
    fs.copyFileSync(path.join(DL, imgOut[0]), path.join(ROOT, 'test', 'tool_out', 'images.epub'));
  } else ok(false, '图片优化产出了文件');
  const afterText = await p.evaluate(() => document.getElementById('toolOut').innerText.slice(0, 200));
  console.log('    回显:', afterText.split('\n')[0]);
  await closeModal(p);

  /* ---------- 3. SVG 检查 ---------- */
  console.log('\n[3] SVG 检查');
  const sv = await runTool(p, 'svg', TOOL_BOOK);
  console.log('    ' + sv.text.split('\n').slice(0, 5).join('\n    '));
  ok(/svg/i.test(sv.text), '找到了 SVG 资源');
  ok(/logo\.svg/.test(sv.text), '列出了具体 SVG 文件');
  ok(/孤儿|未声明|未引用/.test(sv.text), '标出了没被引用的 SVG', (sv.text.match(/.{0,12}(孤儿|未声明)[^\n]{0,20}/) || [])[0]);
  console.log('    按钮:', sv.foot.join(' / ') || '无');
  await p.screenshot({ path: path.join(ROOT, 'test', 'tool_svg.png') });
  if (sv.foot.length) {
    fs.readdirSync(DL).forEach(f => fs.rmSync(path.join(DL, f)));
    await p.evaluate(() => {
      const b2 = document.querySelector('#modalFoot button');
      b2 && b2.click();
    });
    for (let i = 0; i < 60; i++) {
      await wait(1000);
      if (fs.readdirSync(DL).filter(f => f.endsWith('.epub')).length >= 1) { await wait(800); break; }
    }
    const svgOut = fs.readdirSync(DL).filter(f => f.endsWith('.epub'));
    console.log('    产物:', svgOut.join(', ') || '（无）');
    ok(svgOut.length > 0, 'SVG 优化产出了文件');
    const target = svgOut.find(f => /精简SVG/.test(f)) || svgOut[0];
    if (target) fs.copyFileSync(path.join(DL, target), path.join(ROOT, 'test', 'tool_out', 'svg.epub'));
  }
  await closeModal(p);

  /* ---------- 4. 元数据编辑 ---------- */
  console.log('\n[4] 元数据编辑');
  const mt = await runTool(p, 'meta', TOOL_BOOK);
  const fields = await p.evaluate(() => {
    const r = {};
    document.querySelectorAll('#toolOut input, #toolOut textarea').forEach(i => { r[i.id] = i.value; });
    return r;
  });
  console.log('    读到的字段:', JSON.stringify(fields).slice(0, 220));
  ok(Object.keys(fields).length >= 2, '读出了可编辑的元数据字段');
  const titleId = Object.keys(fields).find(k => /title/i.test(k));
  const authorId = Object.keys(fields).find(k => /creator|author/i.test(k));
  ok(!!titleId, '书名字段存在', titleId);
  // 改名后保存
  await p.evaluate((tid, aid) => {
    const t = document.getElementById(tid); t.value = '改过名字的书';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    if (aid) { const a = document.getElementById(aid); a.value = '新作者'; a.dispatchEvent(new Event('input', { bubbles: true })); }
  }, titleId, authorId);
  console.log('    按钮:', mt.foot.join(' / ') || '无');
  ok(mt.foot.length > 0, '有保存按钮', mt.foot.join('/'));
  fs.readdirSync(DL).forEach(f => fs.rmSync(path.join(DL, f)));
  await p.evaluate(() => { const b2 = document.querySelector('#modalFoot button'); b2 && b2.click(); });
  for (let i = 0; i < 90; i++) {
    await wait(1000);
    if (fs.readdirSync(DL).some(f => f.endsWith('.epub'))) { await wait(1200); break; }
  }
  const metaOut = fs.readdirSync(DL).filter(f => f.endsWith('.epub'));
  console.log('    产物:', metaOut.join(', ') || '（无）');
  ok(metaOut.length > 0, '元数据编辑产出了文件');
  if (metaOut.length) fs.copyFileSync(path.join(DL, metaOut[0]), path.join(ROOT, 'test', 'tool_out', 'meta.epub'));
  await closeModal(p);

  /* ---------- 4b. 元数据真的写进去了吗 ---------- */
  if (metaOut.length) {
    const { execFileSync } = require('child_process');
    const info = JSON.parse(execFileSync('python',
      [path.join(ROOT, 'tools', 'epub_spine.py'), path.join(ROOT, 'test', 'tool_out', 'meta.epub')],
      { encoding: 'utf8' }));
    ok(info.title === '改过名字的书', '新书名真的写进了 OPF', info.title);
    ok(info.spine.length === 10, '正文没被动过（仍是 10 章）', info.spine.length + ' 章');
  }

  /* ---------- 5. 封面提取（本轮新增，替代被删掉的批量入口） ---------- */
  console.log('\n[5] 封面提取');
  fs.readdirSync(DL).forEach(f => fs.rmSync(path.join(DL, f)));
  const cv = await runTool(p, 'cover', path.join(ROOT, 'test', 'sample_book.epub'));
  console.log('    ' + cv.text.split('\n').filter(Boolean).slice(0, 3).join('\n    '));
  ok(/封面/.test(cv.text), '认出了封面');
  ok(cv.foot.length > 0, '有导出按钮', cv.foot.join(' / '));
  await p.evaluate(() => {
    const b2 = document.querySelector('#modalFoot button');
    b2 && b2.click();
  });
  let coverOut = [];
  for (let i = 0; i < 30; i++) {
    await wait(500);
    coverOut = fs.readdirSync(DL).filter(f => /\.(png|jpe?g|gif|webp)$/i.test(f));
    if (coverOut.length) break;
  }
  console.log('    产物:', coverOut.join(', ') || '（无）');
  ok(coverOut.length === 1, '导出了 1 张封面图');
  if (coverOut.length) {
    const p2 = path.join(DL, coverOut[0]);
    const sz = fs.statSync(p2).size;
    const sig = fs.readFileSync(p2).subarray(0, 8).toString('hex');
    const isPng = sig.startsWith('89504e47');
    const isJpg = sig.startsWith('ffd8ff');
    ok(isPng || isJpg, '导出的是真图片（文件头合法）', (isPng ? 'PNG ' : 'JPEG ') + (sz / 1024).toFixed(0) + ' KB');
  }
  const noEpub = fs.readdirSync(DL).filter(f => f.endsWith('.epub'));
  ok(noEpub.length === 0, '封面提取不改动 EPUB（没有生成新书）', noEpub.join(', ') || '无');
  await closeModal(p);

  console.log('\n' + (errs.length ? '控制台报错:\n' + errs.join('\n') : '控制台无报错'));
  console.log(fails ? `\n共 ${fails} 项未通过` : '\n全部通过');
  await b.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('崩了: ' + e.stack); process.exit(1); });
