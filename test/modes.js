/* 直接调引擎：验证三种模式差异、诊断、分卷 */
const fs = require('fs'), path = require('path'), puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '..');
const PAGE = 'file://' + path.join(ROOT, 'epubfix', 'index.html').replace(/\\/g, '/');
const SAMPLE = process.env.SAMPLE || 'test/sample_broken.epub';

const EDGE = (() => {
  for (const p of ['C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
                   'C://Program Files\\Microsoft\\Edge\\Application\\msedge.exe']) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('找不到 Edge');
})();

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: true,
    args: ['--no-sandbox', '--allow-file-access-from-files'] });
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('PAGEERROR', e.message));
    await page.goto(PAGE, { waitUntil: 'load' });
    const b64 = fs.readFileSync(path.join(ROOT, SAMPLE)).toString('base64');

    const out = await page.evaluate(async (data) => {
      const bin = atob(data); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const buf = arr.buffer;

      const diag = await EpubFix.diagnose(buf);
      const res = {};
      for (const mode of ['standard', 'deep', 'extreme']) {
        const r = await EpubFix.process(buf, { mode });
        res[mode] = {
          out: r.report.outputBytes,
          inb: r.report.inputBytes,
          vols: r.volumes.length,
          images: r.report.imagesProcessed,
          imgBefore: r.report.imageBytesBefore,
          imgAfter: r.report.imageBytesAfter,
          fonts: r.report.removedFonts,
          cssKept: r.report.normalizedCssFiles,
          cssRemoved: r.report.removedCssFiles,
          inlineKept: r.report.keptInlineStyles,
          inlineRemoved: r.report.removedInlineStyles,
          policy: r.report.policy
        };
      }
      // 分卷：目标 0.6MB
      const std = await EpubFix.process(buf, { mode: 'standard' });
      const toB64 = (u8) => { let t = ''; for (let i = 0; i < u8.length; i += 8192) t += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(t); };
      window.__std = toB64(std.bytes || std.volumes[0].bytes);
      const vs = await EpubFix.process(buf, { mode: 'deep', volumeTarget: 0.6 * 1024 * 1024 });
      window.__vols = vs.volumes.map(v => toB64(v.bytes));
      return {
        diag: { ok: diag.ok, issues: diag.issues.map(i => i.level + ':' + i.code),
                info: { v: diag.info.version, ch: diag.info.chapters, imgs: diag.info.images,
                        fonts: diag.info.fonts, docs: diag.info.docs, cover: diag.info.hasCover } },
        modes: res,
        split: { volumes: vs.volumes.length,
                 sizes: vs.volumes.map(v => (v.bytes.length / 1048576).toFixed(2)),
                 names: vs.volumes.map(v => v.fileName),
                 chapters: vs.volumes.map(v => v.chapters) }
      };
    }, b64);

    const stdB64 = await page.evaluate(() => window.__std);
    const volB64 = await page.evaluate(() => window.__vols);
    fs.writeFileSync(path.join(ROOT, 'test', 'out_standard.epub'), Buffer.from(stdB64, 'base64'));
    volB64.forEach((b, i) => fs.writeFileSync(path.join(ROOT, 'test', 'out_vol' + (i + 1) + '.epub'), Buffer.from(b, 'base64')));
    console.log('=== 诊断 ===');
    console.log('  ok=' + out.diag.ok + '  EPUBy=' + out.diag.info.v + '  章=' + out.diag.info.ch +
                '  图=' + out.diag.info.imgs + '  字体=' + out.diag.info.fonts + '  封面=' + out.diag.info.cover);
    console.log('  问题: ' + out.diag.issues.join(', '));
    console.log('=== 三种模式 ===');
    for (const m of ['standard', 'deep', 'extreme']) {
      const r = out.modes[m];
      console.log('  ' + m.padEnd(9) + (r.out / 1048576).toFixed(2) + ' MB  图 ' +
        (r.imgBefore / 1048576).toFixed(2) + '→' + (r.imgAfter / 1048576).toFixed(2) +
        '  字体删' + r.fonts + '  CSS保留' + r.cssKept + '/删' + r.cssRemoved +
        '  内联留' + r.inlineKept + '/删' + r.inlineRemoved +
        '  maxEdge=' + r.policy.maxEdge + ' q=' + r.policy.quality);
    }
    console.log('=== 分卷（目标 0.6MB）===');
    console.log('  卷数: ' + out.split.volumes + '  各卷: ' + out.split.sizes.join(' / ') + ' MB');
    console.log('  章节分布: ' + out.split.chapters.join(' / '));
    console.log('  文件名: ' + out.split.names[0]);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('失败: ' + e.message); process.exit(1); });
