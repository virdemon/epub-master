/*
 * 第四轮专项：EPUB 2.0 / 3.0 输出格式
 * 不是"改个版本号"，而是拿真实样书跑出文件，再用独立的 Python 校验脚本
 * 逐项核对包结构（OPF 声明、manifest、NCX/nav、章节 DOCTYPE、epub: 命名空间…）。
 */
const fs = require('fs'), path = require('path'), http = require('http');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'epubfix');
const OUT = path.join(ROOT, 'test', 'out_ver');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml'
};

let bad = 0;
const ok = (c, m, d) => { console.log((c ? '  OK   ' : '  FAIL ') + m + (d !== undefined ? ' — ' + d : '')); if (!c) bad++; };
const wait = ms => new Promise(r => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') u = '/index.html';
  const f = path.join(DIR, u);
  if (!f.startsWith(DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

function pyCheck(script, args) {
  try {
    const out = execFileSync('python', [path.join(ROOT, 'tools', script)].concat(args), { encoding: 'utf8' });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
  }
}

server.listen(0, '127.0.0.1', async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const base = 'http://127.0.0.1:' + server.address().port;
  const b = await puppeteer.launch({ executablePath: EDGE, headless: true, protocolTimeout: 600000, args: ['--no-sandbox'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900 });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e.message || e)));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await p.goto(base + '/index.html', { waitUntil: 'networkidle2' });
  await wait(500);

  /* 在页面里跑一次处理，把输出第一卷以 base64 带回来 */
  async function run(sample, outputVersion) {
    const b64 = fs.readFileSync(path.join(ROOT, sample)).toString('base64');
    return p.evaluate(async (data, ver) => {
      const bin = atob(data); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const r = await window.EpubFix.process(arr, { mode: 'deep', outputVersion: ver, rebuildToc: true });

      let bin2 = '';
      const bytes = r.volumes[0].bytes;
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) {
        bin2 += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      }
      const rep = r.report;
      return {
        b64: btoa(bin2),
        report: {
          sourceVersion: rep.sourceVersion,
          outputVersion: rep.outputVersion,
          versionMode: rep.versionMode,
          versionVerified: rep.versionVerified,
          versionWarnings: rep.versionWarnings,
          verified: rep.verified,
          verifyIssues: rep.verifyIssues,
          files: rep.items ? rep.items.length : null,
          inputBytes: rep.inputBytes,
          outputBytes: rep.outputBytes,
          features: rep.features
        }
      };
    }, b64, outputVersion);
  }

  const cases = [
    { name: 'text-auto', sample: 'test/sample_text.epub', ver: 'auto', want: '2.0', label: 'EPUB 2.0 原书 + 保留原书版本' },
    { name: 'text-2', sample: 'test/sample_text.epub', ver: '2', want: '2.0', label: 'EPUB 2.0 原书 + 强制 2.0' },
    { name: 'text-3', sample: 'test/sample_text.epub', ver: '3', want: '3.0', label: 'EPUB 2.0 原书 + 转 3.0' },
    { name: 'rich-auto', sample: 'test/sample_rich.epub', ver: 'auto', want: '3.0', label: 'EPUB 3.0 原书 + 保留原书版本' },
    { name: 'rich-2', sample: 'test/sample_rich.epub', ver: '2', want: '2.0', label: 'EPUB 3.0 原书 + 强制 2.0' },
    { name: 'rich-3', sample: 'test/sample_rich.epub', ver: '3', want: '3.0', label: 'EPUB 3.0 原书 + 强制 3.0' },
    // 带封面的真实书：验证 2.0 的封面声明方式与图片引用没被改坏
    { name: 'book-2', sample: 'test/sample_book.epub', ver: '2', want: '2.0', label: '带封面的书 + 强制 2.0' }
  ];

  console.log('[1] 六种组合各跑一次真实处理');
  for (const c of cases) {
    const r = await run(c.sample, c.ver);
    const file = path.join(OUT, c.name + '.epub');
    fs.writeFileSync(file, Buffer.from(r.b64, 'base64'));
    const rep = r.report;
    console.log('\n  · ' + c.label + ' → test/out_ver/' + c.name + '.epub');

    ok(rep.outputVersion === c.want, 'report 里的输出版本正确', rep.outputVersion);
    ok(rep.versionVerified === true, '引擎自检通过', JSON.stringify(rep.verifyIssues || []));
    ok(rep.verified === true, '整体结构自检通过', (rep.verifyIssues || []).join(';') || undefined);
    ok(/^\s*2\./.test(rep.sourceVersion) === (c.sample.indexOf('text') > 0),
      '识别出原书版本', rep.sourceVersion);
    if (c.ver === 'auto') {
      ok(rep.versionMode === 'auto' && rep.outputVersion === rep.sourceVersion.replace(/^(2|3)$/, '$1.0'),
        'auto 模式下输出沿用原书版本', rep.outputVersion + ' ← ' + rep.sourceVersion);
    } else {
      ok(rep.versionMode === 'forced', '标记为"按用户选择强制转换"', rep.versionMode);
      ok((rep.versionWarnings || []).some(w => /不是只改版本号/.test(w)),
        '明确说明是按版本重建包结构', (rep.versionWarnings || [])[0]);
    }

    const chk = pyCheck('check_version.py', [file, c.want]);
    ok(chk.ok, '独立校验脚本确认结构与 EPUB ' + c.want + ' 一致',
      chk.ok ? chk.out.trim().split('\n').slice(-1)[0] : chk.out.trim().split('\n').filter(l => l.includes('[!!]')).slice(0, 3).join(' | '));

    const ver = pyCheck('verify_epub.py', [file]);
    ok(ver.ok, 'verify_epub.py 通用校验通过',
      ver.ok ? ver.out.trim().split('\n').slice(-1)[0] : ver.out.trim().split('\n').filter(l => l.includes('[!!]')).slice(0, 3).join(' | '));
  }

  console.log('\n[2] 版本转换时对"保不住的特性"的说明');
  const r2 = await run('test/sample_rich.epub', '2');
  const warns = r2.report.versionWarnings || [];
  ok(r2.report.features && r2.report.features.svgFiles >= 1, '统计出 SVG 文件数量',
    JSON.stringify(r2.report.features));
  ok(warns.some(w => /SVG/.test(w)), '提示 EPUB 2.0 下 SVG 的兼容性风险',
    (warns.find(w => /SVG/.test(w)) || '').slice(0, 60));
  ok(warns.some(w => /HTML5|语义标签/.test(w)), '提示 HTML5 语义标签在 2.0 下的问题',
    (warns.find(w => /HTML5|语义标签/.test(w)) || '').slice(0, 60));

  const r3 = await run('test/sample_text.epub', '3');
  ok((r3.report.versionWarnings || []).some(w => /nav|NCX|EPUB 3\.0/.test(w)),
    '2.0 转 3.0 时说明补了什么', (r3.report.versionWarnings || [])[0].slice(0, 70));

  console.log('\n[3] 界面：版本选择与结果页展示');
  await p.evaluate(() => document.getElementById('rechooseBtn').click());
  await wait(200);
  const b64 = fs.readFileSync(path.join(ROOT, 'test/sample_text.epub')).toString('base64');
  await p.evaluate(async (data) => {
    const bin = atob(data); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], '旧版样书.epub', { type: 'application/epub+zip' });
    const dt = new DataTransfer(); dt.items.add(file);
    document.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
    document.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    for (let i = 0; i < 300; i++) {
      if (document.getElementById('fileCard').dataset.ready === '1') break;
      await new Promise(r => setTimeout(r, 100));
    }
  }, b64);

  const verUi = await p.evaluate(async () => {
    document.querySelector('.tab[data-tab="adv"]').click();
    await new Promise(r => setTimeout(r, 250));
    const seg = document.getElementById('verSeg');
    const btns = [...seg.querySelectorAll('.seg-btn')].map(b => ({ v: b.dataset.ver, t: b.textContent.trim() }));
    const descAuto = document.getElementById('verDesc').textContent;
    seg.querySelector('[data-ver="3"]').click();
    await new Promise(r => setTimeout(r, 250));
    const afterClick = {
      desc: document.getElementById('verDesc').textContent,
      note: document.getElementById('verNote').textContent,
      active: (seg.querySelector('.seg-btn.is-active') || {}).dataset.ver,
      panel: document.getElementById('panelFormat').textContent,
      state: window.__em.state.outVersion
    };
    return { btns, descAuto, afterClick, src: document.getElementById('verSeg').textContent };
  });
  ok(verUi.btns.length === 3 && verUi.btns.map(x => x.v).join(',') === 'auto,2,3',
    '高级设置里有三个输出格式选项', verUi.btns.map(x => x.t).join(' / '));
  ok(/保留原书/.test(verUi.btns[0].t), '默认项写明"保留原书版本"并给推荐', verUi.btns[0].t);
  ok(verUi.afterClick.active === '3' && verUi.afterClick.state === '3', '选择后状态同步', verUi.state);
  ok(/3\.0/.test(verUi.afterClick.desc), '选中后说明这个版本会怎么做', verUi.afterClick.desc.slice(0, 50));
  ok(/3\.0/.test(verUi.afterClick.panel), '右侧摘要同步显示输出格式', verUi.afterClick.panel);

  const res = await p.evaluate(async () => {
    document.getElementById('startBtn2').click();
    for (let i = 0; i < 600; i++) {
      if (!window.__em.state.busy && window.__em.state.result) break;
      await new Promise(r => setTimeout(r, 250));
    }
    const r = window.__em.state.result;
    if (!r) return { none: true };
    const rep = r.res.report;
    return {
      outVer: document.getElementById('verOut').textContent,
      state: document.getElementById('verState').textContent,
      note: document.getElementById('verNote2').textContent,
      warnText: document.getElementById('verWarn').innerText.replace(/\n+/g, ' | '),
      warnCount: document.getElementById('verWarn').querySelectorAll('.vw').length,
      summary: document.getElementById('statsRow').innerText.replace(/\n+/g, ' | '),
      reportOut: rep.outputVersion,
      reportVerified: rep.versionVerified,
      volCount: r.res.volumes.length
    };
  });
  ok(!res.none, '处理完成');
  ok(/3\.0/.test(res.outVer), '结果页显示输出版本', res.outVer);
  ok(/通过|一致/.test(res.state), '结果页显示结构自检结论', res.state);
  ok(/\d+ 个文件/.test(res.note) && /MB|KB|B/.test(res.note), '结果页显示文件数与体积', res.note);
  ok(res.warnCount >= 1, '结果页列出兼容性说明', res.warnCount + ' 条');
  ok(/EPUB 3\.0|版本/.test(res.warnText), '兼容性说明内容具体', res.warnText.slice(0, 60));
  ok(/输出版本/.test(res.summary), '概览里也有输出版本一项', res.summary.slice(0, 100));
  ok(res.reportOut === '3.0' && res.reportVerified === true && res.volCount === 1,
    '结果数据与界面一致', res.reportOut + ' / 自检 ' + res.reportVerified + ' / ' + res.volCount + ' 卷');

  await p.screenshot({ path: path.join(ROOT, 'test', 'v22_version_result.png') });

  ok(errs.length === 0, '全程无 JS 报错', errs.slice(0, 3).join(' | ') || undefined);

  await b.close(); server.close();
  console.log(bad === 0 ? '\nEPUB 版本测试通过' : '\n有 ' + bad + ' 项未通过');
  process.exit(bad === 0 ? 0 : 1);
});
