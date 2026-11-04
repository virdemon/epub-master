/*
 * 端到端测试：无头 Edge 走完整 UI 流程（导入 → 开始处理 → 取输出文件），
 * 把引擎真正产出的字节落盘，再交给 tools/verify_epub.py 校验结构。
 *
 * 这是唯一验证"生成的文件真的能被阅读器打开"的测试，其余测试只看界面状态。
 *
 * 环境变量：
 *   SAMPLE  输入 epub 路径（默认 test/sample_broken.epub）
 *   VOLUME  1 = 开启分卷，其余 = 关闭（默认关闭，即本轮新默认值）
 *   TARGET  目标体积 data-value（auto/20/50/100/0），默认 auto
 *   SPLIT   first / second（切分方式），默认 first
 *   OUTDIR  输出目录（默认 test/out_run）
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'epubfix');
const SAMPLE = path.resolve(ROOT, process.env.SAMPLE || 'test/sample_broken.epub');
const VOLUME = process.env.VOLUME === '1';
const TARGET = process.env.TARGET || 'auto';
const SPLIT = process.env.SPLIT || 'first';
const OUTDIR = path.resolve(ROOT, process.env.OUTDIR || 'test/out_run');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
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

server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  let browser;

  try {
    browser = await puppeteer.launch({
      executablePath: EDGE,
      headless: true,
      protocolTimeout: 900000,
      args: ['--no-sandbox', '--allow-file-access-from-files']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message || e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push('console: ' + m.text());
    });

    await page.goto(base + '/index.html', { waitUntil: 'networkidle2' });
    await wait(600);

    console.log('样书: ' + path.basename(SAMPLE) + '　分卷: ' + (VOLUME ? '开' : '关') +
      (VOLUME ? '（' + SPLIT + ' / ' + TARGET + '）' : ''));

    /* ---------- 1. 导入 ---------- */
    const b64 = fs.readFileSync(SAMPLE).toString('base64');
    const card = await page.evaluate(async (data) => {
      const bin = atob(data);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], '测试书.epub', { type: 'application/epub+zip' });
      const dt = new DataTransfer();
      dt.items.add(file);
      document.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
      document.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
      for (let i = 0; i < 300; i++) {
        const c = document.getElementById('fileCard');
        if (c && !c.hidden && c.dataset.ready === '1') break;
        await new Promise((r) => setTimeout(r, 150));
      }
      return {
        title: document.getElementById('fileTitle').textContent.trim(),
        author: document.getElementById('fileAuthor').textContent.trim(),
        name: document.getElementById('fileName').textContent.trim(),
        facts: document.getElementById('fileFacts').textContent.replace(/\s+/g, ' ').trim(),
        diag: document.getElementById('fileDiag').innerText.replace(/\n/g, ' '),
        hasCover: !document.getElementById('coverImg').hidden,
        coverW: document.getElementById('coverImg').naturalWidth
      };
    }, b64);

    console.log('\n=== 书籍卡 ===');
    console.log('  书名: ' + card.title + '　作者: ' + (card.author || '(空)'));
    console.log('  文件: ' + card.name);
    console.log('  信息: ' + card.facts);
    console.log('  结构: ' + card.diag);
    console.log('  封面: ' + (card.hasCover ? '已显示 ' + card.coverW + 'px 宽' : '未显示'));

    /* ---------- 2. 处理参数 ---------- */
    if (VOLUME) {
      await page.click('#optVolume');
      await wait(200);
    }
    await page.evaluate((split, target, vol) => {
      const s = document.querySelector('#splitLevelSeg [data-value="' + split + '"]');
      if (s) s.click();
      if (vol) {
        const t = document.querySelector('#targetSeg [data-value="' + target + '"]');
        if (t) t.click();
      }
    }, SPLIT, TARGET, VOLUME);
    await wait(150);

    const opts = await page.evaluate(() => ({
      volume: document.getElementById('optVolume').checked,
      optsHidden: document.getElementById('volumeOpts').hidden,
      target: document.querySelector('#targetSeg .is-on')?.dataset.value || ''
    }));
    console.log('\n=== 参数 ===');
    console.log('  分卷: ' + (opts.volume ? '开' : '关') + '　目标体积组隐藏: ' + opts.optsHidden +
      (opts.volume ? '　目标: ' + opts.target : ''));

    /* ---------- 3. 开始处理 ---------- */
    const t0 = Date.now();
    await page.click('#startBtn2');
    await page.waitForSelector('#resultCard:not([hidden])', { timeout: 900000 });
    const ms = Date.now() - t0;
    await wait(300);

    const out = await page.evaluate(async () => {
      const st = (window.__em && window.__em.state) || null;
      const r = st && st.result;
      if (!r) return { err: '拿不到 state.result' };
      const res = r.res || {};
      const vols = res.volumes || [];
      const b64s = [];
      for (const v of vols) {
        const u8 = v.bytes instanceof Uint8Array ? v.bytes : new Uint8Array(v.bytes);
        let s = '';
        const CH = 0x8000;
        for (let i = 0; i < u8.length; i += CH) {
          s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
        }
        b64s.push({ name: v.fileName, size: u8.length, b64: btoa(s) });
      }
      const rep = res.report || {};
      return {
        b64s,
        title: document.getElementById('resultSub').textContent.trim(),
        sums: document.getElementById('statsRow').innerText.replace(/\n+/g, ' | '),
        cats: document.getElementById('breakdown').innerText.replace(/\n+/g, ' | '),
        vols: document.getElementById('volList').innerText.replace(/\n+/g, ' | '),
        scope: document.getElementById('scopeNote').textContent.trim(),
        verified: rep.verified,
        issues: rep.verifyIssues || [],
        inBytes: rep.inputBytes,
        outBytes: rep.outputBytes,
        afterRaw: rep.afterRawTotal
      };
    });

    if (out.err) throw new Error(out.err);

    console.log('\n=== 结果页 ===');
    console.log('  标题: ' + out.title);
    console.log('  概览: ' + out.sums);
    console.log('  分类: ' + out.cats);
    if (out.vols) console.log('  分卷: ' + out.vols);
    console.log('  口径: ' + out.scope);
    console.log('  耗时: ' + (ms / 1000).toFixed(1) + 's');
    console.log('  内存自检: ' + (out.verified ? '通过' : '未通过 ' + out.issues.join('; ')));

    /* ---------- 4. 落盘 ---------- */
    fs.mkdirSync(OUTDIR, { recursive: true });
    const written = [];
    for (const f of out.b64s) {
      const p = path.join(OUTDIR, path.basename(f.name));
      const buf = Buffer.from(f.b64, 'base64');
      fs.writeFileSync(p, buf);
      written.push({ p, size: buf.length, okSize: buf.length === f.size });
    }

    console.log('\n=== 输出文件 ===');
    for (const w of written) {
      console.log('  ' + path.basename(w.p) + '　' + (w.size / 1048576).toFixed(2) + ' MB' +
        (w.okSize ? '' : '　[大小不一致!]'));
    }

    /* ---------- 5. 结构校验 ---------- */
    console.log('\n=== verify_epub.py ===');
    let verifyFail = 0;
    for (const w of written) {
      try {
        const r = execFileSync('python', [path.join(ROOT, 'tools', 'verify_epub.py'), w.p], {
          encoding: 'utf8',
          timeout: 180000
        });
        console.log('  [' + path.basename(w.p) + ']');
        r.trim().split('\n').forEach((l) => console.log('    ' + l));
      } catch (e) {
        verifyFail++;
        console.log('  [' + path.basename(w.p) + '] 校验失败:');
        console.log('    ' + String(e.stdout || e.message).trim().split('\n').join('\n    '));
      }
    }

    if (errors.length) {
      console.log('\n=== 页面报错 ===');
      errors.forEach((e) => console.log('  ' + e));
    }

    console.log('\n--- 汇总 ---');
    console.log('  输出 ' + written.length + ' 个文件，校验失败 ' + verifyFail + ' 个，页面报错 ' + errors.length + ' 条');
    if (verifyFail || errors.length) process.exitCode = 1;
    else console.log('  端到端通过');
  } catch (err) {
    console.error('测试失败: ' + err.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});
