/*
 * 直接调核心引擎测"目标体积"路径，不走 UI，便于用任意目标值。
 *   node test/target.js <目标MB> [样书路径]
 * 用来验证：预算不足时会不会真的逐张降分辨率。
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const PAGE = 'file://' + path.join(ROOT, 'epubfix', 'index.html').replace(/\\/g, '/');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const TARGET_MB = parseFloat(process.argv[2] || '1');
const SAMPLE = process.argv[3] || path.join(ROOT, 'test', 'sample_broken.epub');
const OUT = path.join(ROOT, 'test', 'sample_target.epub');

(async function () {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    protocolTimeout: 900000,
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--js-flags=--max-old-space-size=4096']
  });
  const page = await browser.newPage();
  page.on('pageerror', function (e) { console.log('PAGEERROR ' + e.message); });
  await page.goto(PAGE, { waitUntil: 'load' });

  const buf = fs.readFileSync(SAMPLE).toString('base64');
  const res = await page.evaluate(async function (b64, targetBytes) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);

    const t0 = performance.now();
    const out = await EpubFix.process(arr.buffer, {
      splitLevel: 1,
      targetBytes: targetBytes,
      maxEdge: 0,
      dropFonts: true
    });
    const ms = Math.round(performance.now() - t0);

    // 逐字节转 base64 太慢，只回报体积与报告
    return {
      ms: ms,
      input: out.report.inputBytes,
      output: out.bytes.length,
      targetMet: out.report.targetMet,
      imagesProcessed: out.report.imagesProcessed,
      imgBefore: out.report.imageBytesBefore,
      imgAfter: out.report.imageBytesAfter,
      breakdown: out.report.sizeBreakdown,
      warnings: out.report.warnings,
      b64: out.bytes.length < 40 * 1048576 ? (function () {
        let s2 = '';
        const u8 = out.bytes;
        for (let i = 0; i < u8.length; i += 8192) {
          s2 += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
        }
        return btoa(s2);
      })() : null
    };
  }, buf, Math.round(TARGET_MB * 1048576));

  const mb = function (n) { return (n / 1048576).toFixed(2) + ' MB'; };
  console.log('目标: ' + TARGET_MB + ' MB');
  console.log('输入: ' + mb(res.input));
  console.log('输出: ' + mb(res.output) + '　' + (res.targetMet ? '✓ 达成' : '✗ 未达成'));
  console.log('耗时: ' + (res.ms / 1000).toFixed(1) + ' 秒');
  console.log('图片: ' + res.imagesProcessed + ' 张　' + mb(res.imgBefore) + ' → ' + mb(res.imgAfter));
  if (res.warnings.length) res.warnings.forEach(function (w) { console.log('提示: ' + w); });

  if (res.b64) {
    fs.writeFileSync(OUT, Buffer.from(res.b64, 'base64'));
    console.log('已保存输出: ' + OUT + '（' + fs.statSync(OUT).size + ' 字节）');
  }
  console.log('输入字节: ' + res.input + '　输出字节: ' + res.output);

  await browser.close();
  if (res.targetMet === false) process.exitCode = 2;
})().catch(function (e) {
  console.error('失败: ' + e.message);
  process.exitCode = 1;
  process.exit(1);
});
