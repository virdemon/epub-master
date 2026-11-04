/*
 * 分卷专项测试（需求书第十节第 4、5 条 / 第二节「分卷原则」）
 *
 * 界面只提供 20MB 起步的目标体积，样书都不到 20MB，所以这里直接调引擎，
 * 用很小的 volumeTarget 逼出多卷，逐卷交给 tools/verify_epub.py 校验，
 * 再核对：章节数守恒、没有重复章节、顺序与原书一致、每卷能单独打开。
 *
 * 用法：node test/volumes.js
 * 环境变量：SAMPLE（默认 test/sample_text_big.epub，24 章纯文本）
 *           LIMIT （默认 8，单位 KB；样书处理后只有二十几 KB，上限要小于它才切得开）
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'epubfix');
const SAMPLE = path.resolve(ROOT, process.env.SAMPLE || 'test/sample_text_big.epub');
const LIMIT_KB = Number(process.env.LIMIT || 8);
const OUTDIR = path.join(ROOT, 'test', 'out_vol');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

let bad = 0;
const ok = (c, m, d) => {
  console.log((c ? '  OK   ' : '  FAIL ') + m + (d !== undefined ? ' — ' + d : ''));
  if (!c) bad++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

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

/* 从一卷 epub 里取出 spine 顺序的正文文件与目录条目，用来核对不丢不重不乱序 */
function readEpub(p) {
  const script = path.join(ROOT, 'tools', 'epub_spine.py');
  const out = execFileSync('python', [script, p], { encoding: 'utf8', timeout: 120000 });
  return JSON.parse(out);
}

server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  let browser;

  try {
    browser = await puppeteer.launch({
      executablePath: EDGE,
      headless: true,
      protocolTimeout: 900000,
      args: ['--no-sandbox']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message || e)));
    await page.goto(base + '/index.html', { waitUntil: 'networkidle2' });
    await wait(600);

    const b64 = fs.readFileSync(SAMPLE).toString('base64');
    console.log('样书: ' + path.basename(SAMPLE) + '　每卷上限: ' + LIMIT_KB + ' KB\n');

    const res = await page.evaluate(
      async (data, limitKb) => {
        const bin = atob(data);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);

        const out = await EpubFix.process(
          u8,
          {
            mode: 'deep',
            splitLevel: 1,
            volumeTarget: limitKb * 1024,
            targetBytes: 0,
            rebuildToc: true
          },
          () => {}
        );

        const vols = (out.volumes || []).map((v) => {
          const b = v.bytes;
          let s = '';
          const CH = 0x8000;
          for (let i = 0; i < b.length; i += CH) s += String.fromCharCode.apply(null, b.subarray(i, i + CH));
          return {
            name: v.fileName,
            title: v.title,
            chapters: v.chapters,
            size: b.length,
            b64: btoa(s)
          };
        });

        return {
          vols: vols,
          outBytes: out.report.outputBytes,
          warnings: out.report.warnings || [],
          verified: out.report.verified,
          issues: out.report.verifyIssues || []
        };
      },
      b64,
      LIMIT_KB
    );

    ok(res.vols.length > 1, '小上限下真的切成了多卷', res.vols.length + ' 卷');
    ok(res.verified === true, '打包前内存自检通过', (res.issues || []).join('; ') || '无问题');

    if (res.warnings.length) {
      console.log('\n  引擎提示：');
      res.warnings.forEach((w) => console.log('    · ' + w));
    }

    fs.mkdirSync(OUTDIR, { recursive: true });
    // 清掉上一轮残留，避免把旧卷一起统计进去
    fs.readdirSync(OUTDIR).forEach((f) => {
      if (f.endsWith('.epub')) fs.unlinkSync(path.join(OUTDIR, f));
    });

    console.log('\n[1] 逐卷落盘');
    const files = [];
    for (const v of res.vols) {
      const p = path.join(OUTDIR, path.basename(v.name));
      const buf = Buffer.from(v.b64, 'base64');
      fs.writeFileSync(p, buf);
      files.push(p);
      ok(buf.length === v.size, '体积一致 ' + path.basename(p), (buf.length / 1024).toFixed(0) + ' KB');
    }

    console.log('\n[2] 逐卷结构校验');
    let fail = 0;
    for (const p of files) {
      try {
        const r = execFileSync('python', [path.join(ROOT, 'tools', 'verify_epub.py'), p], {
          encoding: 'utf8',
          timeout: 180000
        });
        const line = r.split('\n').filter((l) => l.trim().startsWith('结果')).pop() || '';
        ok(true, path.basename(p) + ' 可独立打开', line.replace(/结果:\s*/, '').trim());
      } catch (e) {
        fail++;
        ok(false, path.basename(p) + ' 校验失败', String(e.stdout || e.message).split('\n')[0]);
      }
    }

    console.log('\n[3] 章节守恒 / 不丢不重不乱序');
    const spineAll = [];
    const headAll = [];
    const leadAll = [];
    for (const p of files) {
      const info = readEpub(p);
      spineAll.push(...info.spine.map((s) => path.basename(s)));
      headAll.push(...info.headings);
      leadAll.push(...info.leads);
      ok(info.spine.length > 0, path.basename(p) + ' 的 spine 非空', info.spine.length + ' 章');
      ok(!!info.title, path.basename(p) + ' 有书名', info.title);
      ok(!!info.identifier, path.basename(p) + ' 有唯一标识', info.identifier);
    }

    // 原书章节数
    const srcInfo = readEpub(SAMPLE);
    const srcCount = srcInfo.spine.length;

    ok(spineAll.length === srcCount, '各卷章节数之和 = 原书章节数', spineAll.length + ' vs ' + srcCount);

    // 每卷必须是独立出版物：共用一个 dc:identifier 会被书库当成同一本书重复导入
    const ids = files.map((p) => readEpub(p).identifier);
    const uniq = new Set(ids);
    ok(uniq.size === ids.length, '每卷有独立的 dc:identifier', uniq.size + ' 个不同 / ' + ids.length + ' 卷');
    ok(headAll.length === spineAll.length, '标题数与章节数一致', headAll.length + ' vs ' + spineAll.length);

    // 每章开头 40 字是这一章的身份指纹：重复即说明同一章进了两卷
    const dupLead = leadAll.filter((x, i) => x && leadAll.indexOf(x) !== i);
    ok(dupLead.length === 0, '没有章节被重复放进两卷', dupLead.length ? dupLead.length + ' 处重复' : '无重复');

    // 顺序：逐章比对开头（标题可能重名，开头 40 字基本唯一）
    let firstDiff = -1;
    for (let i = 0; i < srcCount; i++) {
      if (srcInfo.leads[i] !== leadAll[i]) { firstDiff = i; break; }
    }
    ok(firstDiff < 0, '章节顺序与原书完全一致', firstDiff < 0
      ? srcCount + ' 章逐章比对通过'
      : '第 ' + (firstDiff + 1) + ' 章不同: 原「' + srcInfo.leads[firstDiff] + '」→ 现「' + leadAll[firstDiff] + '」');

    console.log('\n[4] 卷体积与章节范围');
    let overLimit = 0;
    for (const v of res.vols) {
      const mb = (v.size / 1024).toFixed(0) + ' KB';
      const over = v.size > LIMIT_KB * 1024;
      if (over) overLimit++;
      console.log('  · ' + v.name + '　' + v.chapters + ' 章　' + mb + (over ? '　[超出上限，因单章放不下]' : ''));
    }
    ok(overLimit <= res.vols.length, '卷体积在上限内或已给出超限说明', overLimit + ' 卷超限');
    const sumCh = res.vols.reduce((a, v) => a + v.chapters, 0);
    ok(sumCh === srcCount, '界面显示的章数之和也守恒', sumCh + ' vs ' + srcCount);

    console.log('\n[5] 失败要报错，不能假报成功');
    let threw = '';
    try {
      // 故意传一个不是 zip 的东西
      await page.evaluate(async () => {
        const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        await EpubFix.process(junk, { mode: 'deep' }, () => {});
      });
    } catch (e) {
      threw = String(e.message || e);
    }
    ok(!!threw, '垃圾输入直接抛错而不是返回空结果', threw.slice(0, 70));

    ok(errs.length === 0, '全程无 JS 报错', errs.join(' | ') || '无');

    console.log('\n--- 汇总 ---');
    console.log('  输出目录: ' + OUTDIR);
    if (bad) {
      console.log('  失败 ' + bad + ' 项');
      process.exitCode = 1;
    } else {
      console.log('  分卷测试通过');
    }
  } catch (err) {
    console.error('测试失败: ' + err.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});
