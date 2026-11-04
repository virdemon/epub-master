/* 大文件走 HTTP 传输（base64 塞 500MB 会炸），验证 500MB 档压到 100MB 以内 */
const fs = require('fs'), path = require('path'), http = require('http'), puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '..');
const PAGE = 'file://' + path.join(ROOT, 'epubfix', 'index.html').replace(/\\/g, '/');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SAMPLE = process.argv[2] || 'test/sample_big.epub';
const CAP_MB = Number(process.argv[3] || 100);
const MODE = process.argv[4] || 'deep';

const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!fs.existsSync(f)) { res.writeHead(404).end(); return; }
  res.writeHead(200, {
    'Content-Type': 'application/epub+zip',
    'Content-Length': fs.statSync(f).size,
    'Access-Control-Allow-Origin': '*'
  });
  fs.createReadStream(f).pipe(res);
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const b = await puppeteer.launch({ executablePath: EDGE, headless: true, protocolTimeout: 1800000,
    args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const p = await b.newPage();
  await p.goto(PAGE, { waitUntil: 'load' });
  console.log(SAMPLE, '|', (fs.statSync(path.join(ROOT, SAMPLE)).size / 1048576).toFixed(0), 'MB | 上限', CAP_MB, 'MB | 模式', MODE);

  const out = await p.evaluate(async (url, mode, capMb) => {
    const buf = await (await fetch(url)).arrayBuffer();
    const t = performance.now();
    let lastPhase = '';
    const res = await EpubFix.process(buf, {
      mode, targetBytes: capMb * 1048576, volumeTarget: capMb * 1048576
    }, (ph) => { lastPhase = ph; });
    return {
      ms: Math.round(performance.now() - t),
      vols: res.volumes.map(v => v.bytes.length),
      chapters: res.volumes.map(v => v.chapters),
      r: {
        inputBytes: res.report.inputBytes, outputBytes: res.report.outputBytes,
        targetMet: res.report.targetMet, imgs: res.report.imagesProcessed,
        imgBefore: res.report.imageBytesBefore, imgAfter: res.report.imageBytesAfter,
        warnings: res.report.warnings
      }
    };
  }, `http://127.0.0.1:${port}/${SAMPLE}`, MODE, CAP_MB);

  const mb = n => (n / 1048576).toFixed(2) + ' MB';
  console.log('  耗时', (out.ms / 1000).toFixed(1) + 's');
  console.log('  输出', mb(out.r.outputBytes), '| 卷数', out.vols.length, '| 各卷', out.vols.map(mb).join(' / '));
  console.log('  图片', out.r.imgs, '张', mb(out.r.imgBefore), '→', mb(out.r.imgAfter));
  console.log('  压缩率', (100 * (1 - out.r.outputBytes / out.r.inputBytes)).toFixed(1) + '%', '| 达标', out.r.targetMet);
  if (out.r.warnings.length) console.log('  提示:', out.r.warnings.join(' | '));
  const cap = CAP_MB * 1048576;
  console.log(out.vols.every(v => v <= cap) ? '  OK   每一卷都在 ' + CAP_MB + ' MB 以内' : '  FAIL 有卷超出上限');
  await b.close();
  server.close();
});
