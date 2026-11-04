/* 验证「压到 N MB 以内」这条硬指标：65MB 的书按 20MB 上限处理 */
const fs = require('fs'), path = require('path'), puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '..');
const PAGE = 'file://' + path.join(ROOT, 'epubfix', 'index.html').replace(/\\/g, '/');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SAMPLE = process.argv[2] || 'test/sample_big.epub';
const CAP_MB = Number(process.argv[3] || 20);
const MODE = process.argv[4] || 'deep';

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: true, protocolTimeout: 900000,
    args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const p = await b.newPage();
  await p.goto(PAGE, { waitUntil: 'load' });
  const b64 = fs.readFileSync(path.join(ROOT, SAMPLE)).toString('base64');
  console.log(SAMPLE, '| 模式', MODE, '| 上限', CAP_MB, 'MB');
  console.log('  原始', (fs.statSync(path.join(ROOT, SAMPLE)).size / 1048576).toFixed(1), 'MB');

  const out = await p.evaluate(async (data, mode, capMb) => {
    const bin = atob(data); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const buf = arr.buffer;
    const t = performance.now();
    const res = await EpubFix.process(buf, {
      mode, targetBytes: capMb * 1048576, volumeTarget: capMb * 1048576
    });
    for (const v of res.volumes) arr.set ? null : null;
    const dump = res.volumes.map(v => {
      const a = new Uint8Array(v.bytes); let s2 = '';
      for (let i = 0; i < a.length; i += 8192) s2 += String.fromCharCode.apply(null, a.subarray(i, i + 8192));
      return { name: v.fileName, b64: btoa(s2), ch: v.chapters };
    });
    return {
      dump,
      ms: Math.round(performance.now() - t),
      vols: res.volumes.map(v => v.bytes.length),
      pages: res.volumes.map(v => v.chapters),
      report: {
        inputBytes: res.report.inputBytes, outputBytes: res.report.outputBytes,
        targetMet: res.report.targetMet, imgs: res.report.imagesProcessed,
        imgBefore: res.report.imageBytesBefore, imgAfter: res.report.imageBytesAfter,
        warnings: res.report.warnings
      }
    };
  }, b64, MODE, CAP_MB);

  const mb = n => (n / 1048576).toFixed(2) + ' MB';
  console.log('  耗时', (out.ms / 1000).toFixed(1) + 's');
  console.log('  输出', mb(out.report.outputBytes), '| 卷数', out.vols.length,
    '| 各卷', out.vols.map(mb).join(' / '));
  console.log('  图片', out.report.imgs, '张', mb(out.report.imgBefore), '→', mb(out.report.imgAfter));
  console.log('  达标', out.report.targetMet === undefined ? '（未标记）' : out.report.targetMet);
  if (out.report.warnings.length) console.log('  提示:', out.report.warnings.join(' | '));
  const dumpDir = path.join(ROOT, 'test', 'tier_out');
  fs.rmSync(dumpDir, { recursive: true, force: true });
  fs.mkdirSync(dumpDir, { recursive: true });
  out.dump.forEach((d, i) => {
    fs.writeFileSync(path.join(dumpDir, `vol${i + 1}.epub`), Buffer.from(d.b64, 'base64'));
  });
  console.log('  已导出到 test/tier_out/　卷', out.dump.map(d => d.name).join(' / '));
  const cap = CAP_MB * 1048576;
  // 拆成多卷时，"总量"是各卷之和，天然大于单卷上限，此时只要求每卷达标
  if (out.vols.length === 1) {
    console.log(out.report.outputBytes <= cap ? '  OK   总输出在 ' + CAP_MB + ' MB 以内' : '  FAIL 超出上限');
  } else {
    console.log('  OK   已拆成 ' + out.vols.length + ' 卷，合计 ' + mb(out.report.outputBytes));
  }
  console.log(out.vols.every(v => v <= cap) ? '  OK   每一卷都在上限内' : '  FAIL 有卷超出上限');
  await b.close();
})().catch(e => { console.error(e.message); process.exit(1); });
