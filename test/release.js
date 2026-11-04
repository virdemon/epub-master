/* 发布版冒烟测试：拿真实打包出来的 EXE 跑一遍完整链路。
   用法： node test/release.js "<exe 路径>" "<标签>"
   检查：窗口/品牌/版本号、preload 桥接、默认输出目录、导入→处理→保存（文件真的落盘且是合法 EPUB）、
         阅读窗口能渲染原书 HTML/CSS/图片/SVG、图片浏览能列真图并出缩略图、全程无 JS 报错。 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.resolve(process.argv[2] || path.join(ROOT, 'dist', 'EPUBMaster-win32-x64', 'EPUB Master.exe'));
const LABEL = process.argv[3] || '未命名';
const PORT = 9300 + Math.floor(Math.random() * 400);
// 带图、带内联 SVG、带表格、带自定义 CSS 的样书：一次覆盖四类资源
const SAMPLE = path.join(ROOT, 'test', 'sample_rich.epub');

let fails = 0;
const ok = (c, l, e) => {
  console.log((c ? '  OK   ' : '  FAIL ') + l + (e !== undefined && e !== '' ? '  → ' + e : ''));
  if (!c) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function () {
  if (!fs.existsSync(EXE)) throw new Error('找不到可执行文件: ' + EXE);
  console.log('\n=== ' + LABEL + ' ===\n' + EXE);

  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;   // 从 Electron 里启动时必须去掉，否则被当成 node
  delete env.EPUBFIX_AUTOSAVE;

  const child = spawn(EXE, ['--remote-debugging-port=' + PORT], { stdio: 'ignore', env });
  child.on('error', (e) => console.error('启动失败: ' + e.message));
  await sleep(7000);

  let browser;
  for (let i = 0; i < 14 && !browser; i++) {
    try {
      browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:' + PORT, defaultViewport: null });
    } catch (e) {
      await sleep(1500);
    }
  }
  if (!browser) {
    child.kill();
    throw new Error('连不上调试端口，进程可能没起来');
  }

  const pages = await browser.pages();
  const page = pages.find((p) => /index\.html/.test(p.url())) || pages[0];
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e.message)));
  await page.waitForFunction(() => typeof EpubFix === 'object', { timeout: 30000 });
  await page.waitForFunction(() => !!document.getElementById('fileCard'), { timeout: 30000 });

  const info = await page.evaluate(() => ({
    title: document.title,
    brand: (document.querySelector('.brand-text strong') || {}).textContent,
    ver: (document.getElementById('navVersion') || {}).textContent,
    logoOk: (() => {
      const i = document.querySelector('.brand-mark');
      return !!(i && i.complete && i.naturalWidth > 0);
    })(),
    desktop: !!window.emDesktop,
    defaultDir: window.emDesktop ? window.emDesktop.defaultDir : '',
    electron: window.emDesktop ? window.emDesktop.version : ''
  }));

  console.log('\n[程序本体]');
  ok(/EPUB Master/.test(info.title), '窗口标题正确', info.title);
  ok(info.brand === 'EPUB Master', '侧栏品牌正确', info.brand);
  ok(/v1\.0\.0/.test(info.ver || ''), '界面版本号是 1.0.0', info.ver);
  ok(info.logoOk, '图标资源能加载（打包没漏 assets）');
  ok(!!info.electron, 'Electron 运行时正常', 'v' + info.electron);

  console.log('\n[默认输出目录]');
  const defDir = path.resolve(info.defaultDir || '');
  ok(info.desktop, 'preload 桥接已注入');
  ok(/EPUB_Master$/.test(defDir), '指向「下载\\EPUB_Master」', defDir);
  ok(!defDir.toLowerCase().startsWith(path.dirname(EXE).toLowerCase()), '不在程序目录里', defDir);
  const before = fs.existsSync(defDir)
    ? new Set(fs.readdirSync(defDir).filter((f) => f.endsWith('.epub')))
    : new Set();

  console.log('\n[导入 → 处理 → 保存]');
  await page.evaluate(() => { document.getElementById('fileInput').multiple = false; });
  const inp = await page.$('#fileInput');
  await inp.uploadFile(SAMPLE);
  await page.waitForFunction(
    () => {
      const c = document.getElementById('fileCard');
      return c && !c.hidden && c.dataset.ready === '1';
    },
    { timeout: 90000 }
  );
  const card = await page.evaluate(() => ({
    title: document.getElementById('fileTitle').textContent.trim(),
    facts: document.getElementById('fileFacts').textContent.replace(/\s+/g, ' ').trim()
  }));
  ok(!!card.title, '书能导入并出信息卡', card.title + '　' + card.facts);

  await page.click('#startBtn2');
  await page.waitForFunction(
    () => !document.getElementById('resultCard').hidden || !document.getElementById('errorCard').hidden,
    { timeout: 300000 }
  );
  const res = await page.evaluate(() => ({
    err: !document.getElementById('errorCard').hidden,
    errText: document.getElementById('errorText').textContent,
    sums: document.getElementById('statsRow').innerText.replace(/\n+/g, ' | ')
  }));
  ok(!res.err, '处理成功', res.err ? res.errText : '');
  console.log('     ' + res.sums);

  console.log('\n[保存文件]');
  // 这台机器上之前跑过测试，设置里可能留着自定义输出目录；清掉才叫"开箱默认值"
  await page.evaluate(() => { window.__em.settings.dirName = ''; });
  await page.click('#saveBtn');
  let created = [];
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (fs.existsSync(defDir)) {
      created = fs.readdirSync(defDir)
        .filter((f) => f.endsWith('.epub') && !before.has(f))
        .map((f) => path.join(defDir, f));
    }
    if (created.length) break;
  }
  ok(created.length >= 1, '文件真的写到默认目录', created.map((p) => path.basename(p)).join(', ') || '没写出来');
  if (created.length) {
    const sz = fs.statSync(created[0]).size;
    const head = fs.readFileSync(created[0]).subarray(0, 4).toString('hex');
    ok(sz > 2000, '输出文件有实际内容', (sz / 1048576).toFixed(2) + ' MB');
    ok(head === '504b0304', '输出是合法 ZIP/EPUB', head);
  }

  console.log('\n[阅读窗口：原书 HTML / CSS / 图片 / SVG]');
  await page.click('#previewSrcBtn');
  await page.waitForFunction(() => !document.getElementById('reader').hidden, { timeout: 30000 });
  await sleep(1500);

  // 逐章翻一遍：图片和 SVG 不一定在第一章
  const rd = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const chs = [...document.querySelectorAll('#rdToc li[data-ch]')];
    let imgs = 0, svg = 0, paras = 0, indent = '', imgsLoaded = 0, titles = [];
    for (const li of chs) {
      li.click();
      await sleep(900);
      const d = document.getElementById('rdFrame').contentDocument;
      if (!d) continue;
      titles.push(li.textContent.trim());
      paras += d.body.querySelectorAll('p').length;
      svg += d.querySelectorAll('svg').length;
      imgs += d.images.length;
      imgsLoaded += [...d.images].filter((i) => i.complete && i.naturalWidth > 0).length;
      if (!indent && d.body.firstElementChild) indent = getComputedStyle(d.body.firstElementChild).textIndent;
    }
    return { toc: chs.length, paras, imgs, imgsLoaded, svg, indent, titles };
  });
  ok(rd.toc > 0, '目录树有章节', rd.toc + ' 章：' + rd.titles.join(' / '));
  ok(rd.paras > 0, '正文渲染出来了', rd.paras + ' 段');
  ok(rd.imgs > 0, '正文里的图片能显示', rd.imgs + ' 张，其中解码成功 ' + rd.imgsLoaded + ' 张');
  ok(rd.imgsLoaded === rd.imgs, '图片真的加载出来了，不是空框', rd.imgsLoaded + '/' + rd.imgs);
  ok(rd.svg > 0, '内联 SVG 没丢', rd.svg + ' 个');
  ok(/px/.test(rd.indent || ''), '正文样式（首行缩进）生效', rd.indent);

  console.log('\n[图片浏览模式]');
  await page.evaluate(() => { window.__em.setReaderMode('images'); });
  // 缩略图是按需解码的，等它真的出图，别用固定 sleep 赌时间
  try {
    await page.waitForFunction(
      () => {
        const cards = [...document.querySelectorAll('.gal-card')];
        return cards.length > 0 && cards.some((c) => {
          const i = c.querySelector('img');
          return i && i.complete && i.naturalWidth > 0;
        });
      },
      { timeout: 20000 }
    );
  } catch (e) { /* 交给下面的断言报失败 */ }
  await sleep(500);
  const gal = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.gal-card')];
    const loaded = cards.filter((c) => {
      const i = c.querySelector('img');
      return i && i.complete && i.naturalWidth > 0;
    });
    return {
      cards: cards.length,
      loaded: loaded.length,
      w: (loaded[0] && loaded[0].naturalWidth) || 0,
      h: (loaded[0] && loaded[0].naturalHeight) || 0,
      summary: (document.getElementById('galSummary') || {}).textContent,
      count: (document.getElementById('galCount') || {}).textContent
    };
  });
  ok(gal.cards > 0, '图库列出真实图片', gal.cards + ' 张');
  ok(gal.loaded > 0, '缩略图真的解码出来了', gal.loaded + ' 张已加载，首张 ' + gal.w + '×' + gal.h);
  console.log('     ' + (gal.summary || '').replace(/\s+/g, ' ').trim());
  await page.screenshot({ path: path.join(ROOT, 'test', 'release_' + LABEL.replace(/[^\w]/g, '_') + '.png') });

  // 回到阅读模式再关，确认两个模式切换不崩
  await page.evaluate(() => { window.__em.setReaderMode('read'); });
  await sleep(800);
  const backOk = await page.evaluate(() => !!document.getElementById('rdFrame').contentDocument);
  ok(backOk, '切回阅读模式正常');
  await page.keyboard.press('Escape');
  await sleep(600);

  ok(jsErrors.length === 0, '全程无 JS 报错', jsErrors.join(' / '));

  // 只删本次测试写进去的文件
  try {
    const mine = fs.readdirSync(defDir).filter((f) => f.endsWith('.epub') && !before.has(f));
    mine.forEach((f) => fs.unlinkSync(path.join(defDir, f)));
    console.log('  已清理本次生成的 ' + mine.length + ' 个测试文件');
  } catch (e) { /* 删不掉不影响结论 */ }

  browser.disconnect();
  child.kill();
  console.log(fails ? '\n' + LABEL + '：' + fails + ' 项未通过' : '\n' + LABEL + '：全部通过');
  process.exit(fails ? 1 : 0);
})().catch(function (e) {
  console.error('失败: ' + e.message);
  process.exit(1);
});
