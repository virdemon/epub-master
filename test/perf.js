/* 量一下处理一本大书要多久，以及主线程被独占的最长一段有多长 */
const fs = require('fs'), path = require('path'), puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '..');
const PAGE = 'file://' + path.join(ROOT, 'epubfix', 'index.html').replace(/\\/g, '/');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SAMPLE = process.argv[2] || 'test/sample_broken.epub';
const MODE = process.argv[3] || 'standard';

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: true, protocolTimeout: 600000,
    args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const p = await b.newPage();
  await p.goto(PAGE, { waitUntil: 'load' });
  const b64 = fs.readFileSync(path.join(ROOT, SAMPLE)).toString('base64');

  const out = await p.evaluate(async (data, mode) => {
    const bin = atob(data); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const buf = arr.buffer;

    // 用 rAF 间隔量主线程最长停顿
    let last = performance.now(), maxGap = 0, gaps = [];
    let run = true;
    (function tick() {
      const now = performance.now();
      const gap = now - last; last = now;
      if (gap > 120) { maxGap = Math.max(maxGap, gap); gaps.push(Math.round(gap)); }
      if (run) requestAnimationFrame(tick);
    })();

    const t = performance.now();
    const phases = {};
    const res = await EpubFix.process(buf, { mode }, (ph, msg, ratio) => {
      if (!phases[ph]) phases[ph] = Math.round(performance.now() - t);
      phases['_' + ph] = Math.round(performance.now() - t);
    });
    const total = Math.round(performance.now() - t);
    run = false;
    return { total, phases, maxGap: Math.round(maxGap), gaps: gaps.slice(0, 12),
      size: res.bytes ? res.bytes.length : res.volumes[0].bytes.length,
      vols: res.volumes.length, images: res.report.images };
  }, b64, MODE);

  console.log(SAMPLE, MODE);
  console.log('  总耗时', (out.total / 1000).toFixed(1) + 's', '| 输出', (out.size / 1048576).toFixed(2) + 'MB', '| 卷', out.vols);
  console.log('  最长主线程停顿', (out.maxGap / 1000).toFixed(1) + 's', '| 超过 120ms 的停顿', out.gaps.join(','));
  console.log('  阶段耗时', JSON.stringify(out.phases));
  await b.close();
})().catch(e => { console.error(e.message); process.exit(1); });
