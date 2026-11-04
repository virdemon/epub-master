/*
 * 第六轮专项：智能重复图片清理
 *
 * 样书 test/sample_dup.epub（由 tools/make_dup_epub.py 生成）里放了：
 *   · 同一张图在同一章出现两次、在另外两章又各出现一次
 *   · 字节完全相同但文件名/目录不同的两张图
 *   · 只差一个像素、看起来几乎一样的两张图
 *   · 封面与正文第一页用同一张图
 *   · 90 多章、279 个图片显示位置，属于"几百张图片"的规模
 *
 * 跑法：node test/dedupe.js
 */
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'epubfix');
const OUT = path.join(ROOT, 'test', 'out_dedupe');
const SAMPLE = path.join(ROOT, 'test', 'sample_dup.epub');
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
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

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

  const srcBuf = fs.readFileSync(SAMPLE);
  const srcHash = sha(srcBuf);
  const b64 = srcBuf.toString('base64');

  /*
   * 跑一次处理。输入数组先复制一份，处理完再比对——
   * 原始 EPUB 一个字节都不该变，这是这个功能的前提。
   */
  async function run(extra) {
    return page.evaluate(async (data, opt) => {
      const bin = atob(data);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const before = arr.slice();
      const r = await window.EpubFix.process(arr, opt);
      let same = before.length === arr.length;
      for (let i = 0; same && i < before.length; i++) if (before[i] !== arr[i]) same = false;

      const by = r.volumes[0].bytes;
      let s = '';
      const CH = 0x8000;
      for (let i = 0; i < by.length; i += CH) s += String.fromCharCode.apply(null, by.subarray(i, i + CH));
      const rep = r.report;
      return {
        b64: btoa(s),
        inputUntouched: same,
        report: {
          chapters: rep.chapters,
          imagesFound: rep.imagesFound,
          dedupe: rep.dedupe,
          dedupeRecordTotal: rep.dedupeRecordTotal,
          unusedImages: rep.unusedImages,
          verified: rep.verified,
          versionVerified: rep.versionVerified,
          sourceChars: rep.sourceChars,
          audit: rep.audit,
          counts: rep.auditCounts,
          warnings: rep.warnings,
          outBytes: rep.outputBytes
        }
      };
    }, b64, extra);
  }

  /* 读输出包里的全部文本文件 */
  async function readZip(zipB64, pattern) {
    return page.evaluate(async (data, pat) => {
      const bin = atob(data);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const files = window.fflate.unzipSync(arr);
      const re = new RegExp(pat);
      const out = { __all: Object.keys(files) };
      Object.keys(files).forEach((k) => {
        if (re.test(k)) out[k] = window.fflate.strFromU8(files[k]);
      });
      return out;
    }, zipB64, pattern);
  }

  const imgSrcs = html => (html.match(/<img\b[^>]*\ssrc="([^"]*)"/g) || [])
    .map(t => (t.match(/src="([^"]*)"/) || ['', ''])[1]);

  console.log('[1] 默认开启：处理一遍（不改图片编码，只看去重）');
  const rOn = await run({ mode: 'standard', noImageOptimize: true, rebuildToc: true });
  const rOff = await run({ mode: 'standard', noImageOptimize: true, rebuildToc: true, imageDedupe: false });
  fs.writeFileSync(path.join(OUT, 'dup-on.epub'), Buffer.from(rOn.b64, 'base64'));
  fs.writeFileSync(path.join(OUT, 'dup-off.epub'), Buffer.from(rOff.b64, 'base64'));

  ok(rOn.inputUntouched, '原始 EPUB 在内存里一个字节都没被改');
  ok(sha(fs.readFileSync(SAMPLE)) === srcHash, '磁盘上的原始 EPUB 完全没动', srcHash.slice(0, 12));

  const d = rOn.report.dedupe || {};
  ok(d.on === true, '重复图片清理默认开启');
  ok(d.positions === 280, '按阅读顺序扫到的图片位置数正确', d.positions + ' 处');
  ok(d.unique === 94, '不同内容的图片 94 种（90 张唯一图 + a + b + b_similar + 封面）', d.unique + ' 种');
  ok(d.removed === 186, '清除的重复显示位置数正确', d.removed + ' 处');
  ok(d.kept === 94, '每种图都保留了第一次出现的位置', d.kept + ' 处');
  ok(d.removed + d.kept === d.positions, '位置总数守恒：保留 + 清除 = 扫描', d.kept + '+' + d.removed + '=' + d.positions);
  ok(d.droppedResources === 2, '只移除了 2 个冗余资源文件（b 的两个副本）', d.droppedResources + ' 个');
  ok(d.pixelConfirmed >= 1, '字节不同但像素相同的图靠逐像素比对认了出来', d.pixelConfirmed + ' 组' + (d.pixelPairs ? '，比对 ' + d.pixelPairs + ' 对' : ''));
  ok(d.savedBytes > 100000, '省下的图片字节按真实文件大小算', Math.round(d.savedBytes / 1024) + ' KB');
  ok(rOn.report.unusedImages === 0, '去重掉的副本没有被算成"原书里的死资源"', rOn.report.unusedImages);

  console.log('\n[2] 输出的章节：留第一次、删后面的位置');
  const chOn = await readZip(rOn.b64, '^OEBPS/text/ch_\\d+\\.xhtml$');
  const allOn = chOn.__all || [];
  const filesOn = await readZip(rOn.b64, '\\.(png|jpe?g|gif|webp)$');
  const chKeys = Object.keys(chOn).filter(k => k !== '__all').sort();
  ok(chKeys.length === 94, '章节数与样书一致（封面 + 93 章）', chKeys.length + ' 章');

  const chByTitle = {};
  chKeys.forEach((k) => {
    const t = (chOn[k].match(/<h1>([^<]*)<\/h1>/) || ['', ''])[1];
    chByTitle[t] = { path: k, html: chOn[k], srcs: imgSrcs(chOn[k]) };
  });
  const c1 = chByTitle['第一章'], c2 = chByTitle['第二章'], c3 = chByTitle['第三章'];
  ok(!!c1 && !!c2 && !!c3, '前三章都还在');
  ok(c1.srcs.length === 2, '第一章：a、b 各留一张，第二次出现的 a 已删除', c1.srcs.join(' / '));
  ok(c1.srcs.filter(s => /a\.png$/.test(s)).length === 1, '第一章里 a 只剩一处');
  ok(c2.srcs.length === 1 && /b_similar\.png$/.test(c2.srcs[0]), '第二章：a 与 b 的两个副本被删，只留 b_similar', c2.srcs.join(' / '));
  ok(c3.srcs.length === 1 && /u000\.png$/.test(c3.srcs[0]), '第三章：跨章重复的 a 被删，其它图保留', c3.srcs.join(' / '));
  ok(/cover\.png$/.test(chByTitle['封面'].srcs[0] || ''), '封面页仍然显示封面图', chByTitle['封面'].srcs[0]);

  ok(filesOn['OEBPS/images/a.png'] !== undefined, 'a.png 资源还在（首次出现要能用）');
  ok(filesOn['OEBPS/images/b.png'] !== undefined, 'b.png 资源还在');
  ok(filesOn['OEBPS/images/b_similar.png'] !== undefined, 'b_similar.png 没被误删（只是相似，不是相同）');
  ok(filesOn['OEBPS/images/sub/b_copy.png'] === undefined, 'b_copy.png 这个冗余副本没有写进新包');
  ok(filesOn['OEBPS/images/sub/b_same.png'] === undefined, 'b_same.png（像素相同、字节不同）同样没有写进新包');
  ok(filesOn['OEBPS/images/cover.png'] !== undefined, '封面图资源还在');

  console.log('\n[3] 图片引用与完整性');
  const missing = [];
  chKeys.forEach((k) => {
    imgSrcs(chOn[k]).forEach((s) => {
      const abs = path.posix.normalize(path.posix.join(path.posix.dirname(k), decodeURIComponent(s)));
      if (allOn.indexOf(abs) < 0) missing.push(k + ' → ' + s);
    });
  });
  ok(missing.length === 0, '每一处 <img> 都能在输出包里找到文件', missing.slice(0, 3).join(' | ') || '279 → 94 处全部有效');

  const a = rOn.report.audit || [];
  const byId = {};
  a.forEach(it => { byId[it.id] = it; });
  ok(byId.dup && byId.dup.status === 'fixed', '检查项「重复图片」标为已修复', byId.dup && byId.dup.detail);
  ok(/186 处/.test(byId.dup.detail) && /2 个/.test(byId.dup.detail), '说清了清了几个位置、删了几个资源文件');
  ok(!/186 个/.test(byId.dup.detail) && /保留第一次出现/.test(byId.dup.detail),
    '没把 186 处显示位置说成 186 个文件，并写明保留首次出现');
  ok(byId.res && byId.res.status === 'ok', '图片资源检查通过', byId.res && byId.res.detail);
  ok(byId.toc && byId.toc.status === 'ok', '目录与章节检查通过', byId.toc && byId.toc.detail);
  ok(byId.pkg && byId.pkg.status === 'ok', '输出完整性检查通过', byId.pkg && byId.pkg.detail);
  ok(byId.text && byId.text.status === 'ok', '正文完整性通过（图片删除不影响文字）', byId.text && byId.text.detail);
  ok(rOn.report.verified && rOn.report.versionVerified, '结构自检与版本自检都通过');

  console.log('\n[4] 清理记录：说得清"哪张图、在第几章、删了哪些位置"');
  const recs = d.records || [];
  ok(recs.length === d.groups && recs.length > 0, '记录覆盖每一组重复图片', recs.length + ' 组');
  ok(rOn.report.dedupeRecordTotal === recs.length, '记录条数与统计一致');
  const recA = recs.find(r => /a\.png$/.test(r.name));
  ok(!!recA, '有 a.png 的记录');
  ok(recA.keep === '第一章', '首次出现位置正确（章名可读）', recA.keep);
  ok(recA.removed.length === 3, '列出全部 3 处重复位置', recA.removed.join(' / '));
  ok(/同章重复/.test(recA.removed[0]), '同一章内的重复另有标注', recA.removed[0]);
  const recB = recs.find(r => /b\.png$/.test(r.name));
  ok(!!recB && recB.mergedFiles === 3, 'b、b_copy、b_same 合成一组，记了合并的文件数', recB && recB.mergedFiles);
  ok(!!recB && recB.pixel === true, '这一组标记为「像素比对确认」');
  ok(recs.every(r => typeof r.bytes === 'number' && r.bytes > 0), '每条记录带真实文件体积');

  console.log('\n[5] 关掉开关：一张都不删');
  const dOff = rOff.report.dedupe || {};
  ok(dOff.on === false, '关闭后明确标记未启用', JSON.stringify(dOff));
  ok(rOff.report.chapters === rOn.report.chapters, '章节数不因开关而变', rOff.report.chapters);
  const chOff = await readZip(rOff.b64, '^OEBPS/text/ch_\\d+\\.xhtml$');
  const filesOff = await readZip(rOff.b64, '\\.(png|jpe?g|gif|webp)$');
  const offKeys = Object.keys(chOff).filter(k => k !== '__all');
  const offPos = offKeys.reduce((n, k) => n + imgSrcs(chOff[k]).length, 0);
  ok(offPos === 280, '关闭时 280 处图片全部保留', offPos + ' 处');
  ok(filesOff['OEBPS/images/sub/b_copy.png'] !== undefined && filesOff['OEBPS/images/sub/b_same.png'] !== undefined, '关闭时冗余副本照旧保留');
  const dupOff = (rOff.report.audit || []).find(it => it.id === 'dup');
  ok(dupOff && dupOff.status === 'info' && /关闭/.test(dupOff.detail), '检查项如实说明"用户关掉了"', dupOff && dupOff.detail);

  console.log('\n[6] 文字与目录不受影响');
  ok(rOn.report.sourceChars === rOff.report.sourceChars, '原书正文字数一致', rOn.report.sourceChars);
  const textOn = chKeys.reduce((n, k) => n + (chOn[k].replace(/<[^>]+>/g, '').replace(/\s/g, '').length), 0);
  const textOff = offKeys.reduce((n, k) => n + (chOff[k].replace(/<[^>]+>/g, '').replace(/\s/g, '').length), 0);
  ok(textOn === textOff, '开关前后输出文字量完全相同（只动了图片）', textOn + ' / ' + textOff);

  console.log('\n[7] 同时开压缩：资源改名后仍然只留一份');
  const rZip = await run({ mode: 'deep', rebuildToc: true });
  fs.writeFileSync(path.join(OUT, 'dup-compressed.epub'), Buffer.from(rZip.b64, 'base64'));
  const dz = rZip.report.dedupe || {};
  ok(dz.positions === 280 && dz.removed === 186, '压缩模式下同样清掉 186 处', dz.positions + ' → ' + dz.removed);
  const chZip = await readZip(rZip.b64, '^OEBPS/text/ch_\\d+\\.xhtml$');
  const allZip = chZip.__all || [];
  let broken = 0;
  Object.keys(chZip).filter(k => k !== '__all').forEach((k) => {
    imgSrcs(chZip[k]).forEach((s) => {
      const abs = path.posix.normalize(path.posix.join(path.posix.dirname(k), decodeURIComponent(s)));
      if (allZip.indexOf(abs) < 0) broken++;
    });
  });
  ok(broken === 0, '压缩后每一处图片引用仍然有效（png→jpg 改名也没断链）', broken + ' 处断裂');
  ok(rZip.report.verified && rZip.report.versionVerified, '压缩+去重的产物仍通过结构/版本自检');
  ok((rZip.report.audit || []).find(it => it.id === 'dup').status === 'fixed', '检查项在压缩模式下也是"已修复"');

  console.log('\n[8] 结果页：统计与清理记录的实际渲染');
  const ui = await page.evaluate(async (data) => {
    const bin = atob(data);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const r = await window.EpubFix.process(arr, { mode: 'standard', noImageOptimize: true, rebuildToc: true });
    window.__em.state.result = { res: r, name: 'sample_dup.epub', opts: { mode: 'standard' }, ms: 1200 };
    window.__em.renderResult();
    const stats = [...document.querySelectorAll('#dedupeStats .dup-stat')].map(el => ({
      k: el.querySelector('.dup-k').textContent,
      v: el.querySelector('.dup-v').textContent
    }));
    return {
      hidden: document.getElementById('dedupeSection').hidden,
      note: document.getElementById('dedupeNote').textContent,
      stats,
      rows: document.querySelectorAll('#dedupeList .dup-row').length,
      summary: document.getElementById('dedupeSummary').textContent,
      first: (document.querySelector('#dedupeList .dup-row-desc') || {}).textContent || ''
    };
  }, b64);
  ok(!ui.hidden, '结果页出现「重复图片清理」区块');
  ok(ui.stats.length >= 5, '统计项齐全', ui.stats.map(s => s.k + '=' + s.v).join('，'));
  const kv = {};
  ui.stats.forEach(s => { kv[s.k] = s.v; });
  ok(kv['正文图片位置'] === '280 处', '显示扫描到的位置数', kv['正文图片位置']);
  ok(/^186/.test(kv['清除重复显示'] || ''), '显示清除的重复位置数', kv['清除重复显示']);
  ok(kv['移除冗余资源'] === '2 个', '资源文件数单独显示', kv['移除冗余资源']);
  ok(/KB|MB/.test(kv['实际节省'] || ''), '显示真实节省的字节', kv['实际节省']);
  ok(ui.rows > 0, '清理记录能展开查看', ui.rows + ' 行');
  ok(/（\d+ 张图）/.test(ui.summary), '标题上带了条数', ui.summary);
  ok(/保留 第.章/.test(ui.first) && /清除/.test(ui.first), '每行写清保留在哪、清除了哪', ui.first.trim().slice(0, 70));

  await page.evaluate(() => {
    document.getElementById('dedupeDetail').open = true;
    document.getElementById('dedupeSection').scrollIntoView({ block: 'center' });
  });
  await wait(300);
  await page.screenshot({ path: path.join(ROOT, 'test', 'dedupe_result.png') });

  ok(jsErrors.length === 0, '全程无 JS 报错', jsErrors.slice(0, 2).join(' | ') || '无');

  await browser.close();
  server.close();
  console.log('\n' + (bad ? '重复图片清理测试失败：' + bad + ' 项' : '重复图片清理测试通过'));
  process.exit(bad ? 1 : 0);
});
