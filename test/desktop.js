/* 启动真实打包出来的桌面版：确认窗口能开、界面是新版、默认写到「下载\EPUB_Master」、
   同名不覆盖、预览原书能用。测完删掉本次测试自己写进去的那两个文件。 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'EPUBMaster-win32-x64', 'EPUB Master.exe');
const PORT = 9333;
const SAMPLE = path.join(ROOT, 'test', 'sample_book.epub');

let fails = 0;
const ok = (c, l, e) => {
  console.log((c ? '  OK   ' : '  FAIL ') + l + (e !== undefined ? '  → ' + e : ''));
  if (!c) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function () {
  if (!fs.existsSync(EXE)) throw new Error('还没打包：' + EXE);

  // 默认输出目录不在这里硬猜：以主进程真的返回的值为准（用户可能把「下载」挪到了 D 盘）
  let DEFAULT_DIR = '';
  let before = new Set();

  // WorkBuddy 自己就是 Electron，会设置 ELECTRON_RUN_AS_NODE，
  // 带着它启动会被当成 node 跑。测试时必须去掉。
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.EPUBFIX_AUTOSAVE;

  const child = spawn(EXE, ['--remote-debugging-port=' + PORT], { stdio: 'ignore', env });
  child.on('error', (e) => console.error('启动失败: ' + e.message));
  await sleep(7000);

  let browser;
  for (let i = 0; i < 12; i++) {
    try {
      browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:' + PORT, defaultViewport: null });
      break;
    } catch (e) {
      await sleep(1500);
    }
  }
  if (!browser) {
    child.kill();
    throw new Error('连不上桌面版的调试端口');
  }

  const pages = await browser.pages();
  const page = pages.find((p) => /index\.html/.test(p.url())) || pages[0];
  await page.waitForFunction(() => typeof EpubFix === 'object', { timeout: 20000 });
  await page.waitForFunction(() => !!document.getElementById('fileCard'), { timeout: 20000 });

  const info = await page.evaluate(() => ({
    title: document.title,
    brand: (document.querySelector('.brand-text strong') || {}).textContent,
    logoOk: (() => {
      const i = document.querySelector('.brand-mark');
      return !!(i && i.complete && i.naturalWidth > 0);
    })(),
    nav: [...document.querySelectorAll('.nav-item')].map((b) => b.dataset.view),
    panel: getComputedStyle(document.querySelector('.panel')).display !== 'none',
    size: [window.outerWidth, window.outerHeight],
    desktop: !!window.emDesktop,
    defaultDir: window.emDesktop ? window.emDesktop.defaultDir : '',
    ev: window.emDesktop ? window.emDesktop.version : '',
    hero: !!document.querySelector('.hero'),
    quick: !!document.querySelector('.quicktools')
  }));

  console.log('桌面版: ' + EXE);
  ok(/EPUB Master/.test(info.title), '窗口标题是新品牌', info.title);
  ok(info.brand === 'EPUB Master', '侧栏品牌正确', info.brand);
  ok(info.logoOk, '窗口图标资源能加载');
  ok(info.nav.length === 6, '六项导航都在', info.nav.join(','));
  ok(info.nav.includes('about'), '导航里有「关于」', info.nav.join(','));
  ok(info.panel, '三栏中的右面板可见');
  ok(info.size[0] >= 1180, '默认窗口宽度够放三栏', info.size.join('×'));
  ok(!info.hero && !info.quick, '首页已无品牌横幅与底部工具条');

  console.log('\n[默认输出目录]');
  ok(info.desktop, 'preload 桥接已注入（能读写真实文件系统）');
  ok(/EPUB_Master$/.test(info.defaultDir), '默认目录指向 EPUB_Master', info.defaultDir);
  DEFAULT_DIR = path.resolve(info.defaultDir);
  ok(path.isAbsolute(DEFAULT_DIR), '默认目录是绝对路径', DEFAULT_DIR);
  ok(!DEFAULT_DIR.startsWith(ROOT), '默认目录不在程序目录里（不会被当成缓存清掉）', DEFAULT_DIR);
  ok(fs.existsSync(path.dirname(DEFAULT_DIR)), '上级目录（系统下载目录）真实存在', path.dirname(DEFAULT_DIR));
  before = fs.existsSync(DEFAULT_DIR)
    ? new Set(fs.readdirSync(DEFAULT_DIR).filter((f) => f.endsWith('.epub')))
    : new Set();
  ok(!!info.ev, '桌面版能拿到 Electron 版本', info.ev);

  console.log('\n[真跑一次：导入 → 处理 → 保存]');
  await page.evaluate(() => {
    document.getElementById('fileInput').multiple = false;
  });
  const inp = await page.$('#fileInput');
  await inp.uploadFile(SAMPLE);
  await page.waitForFunction(
    () => {
      const c = document.getElementById('fileCard');
      return c && !c.hidden && c.dataset.ready === '1';
    },
    { timeout: 60000 }
  );
  const card = await page.evaluate(() => ({
    title: document.getElementById('fileTitle').textContent.trim(),
    facts: document.getElementById('fileFacts').textContent.replace(/\s+/g, ' ').trim()
  }));
  console.log('  导入: ' + card.title + '　' + card.facts);

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
  ok(!res.err, '桌面版处理成功', res.err ? res.errText : '');
  console.log('  结果: ' + res.sums);

  console.log('\n[预览原书]');
  await page.click('#previewSrcBtn');
  await page.waitForFunction(() => !document.getElementById('reader').hidden, { timeout: 30000 });
  const rd = await page.evaluate(() => {
    const f = document.getElementById('rdFrame');
    return {
      open: !document.getElementById('reader').hidden,
      toc: document.querySelectorAll('#rdToc li[data-ch]').length,
      paras: f && f.contentDocument && f.contentDocument.body ? f.contentDocument.body.querySelectorAll('p').length : 0
    };
  });
  ok(rd.open && rd.toc > 0 && rd.paras > 0, '桌面版也能打开阅读窗口', rd.toc + ' 章 / ' + rd.paras + ' 段');
  await page.keyboard.press('Escape');
  await sleep(400);

  console.log('\n[保存到默认目录]');
  // 这台机器上跑过真实使用，设置里可能留着自定义输出目录；
  // 清掉才能验证"开箱默认值"，否则测的是上次那个目录
  await page.evaluate(() => { if (window.__em && window.__em.settings) window.__em.settings.dirName = ''; });
  await page.click('#saveBtn');
  let created = [];
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (fs.existsSync(DEFAULT_DIR)) {
      created = fs.readdirSync(DEFAULT_DIR)
        .filter((f) => f.endsWith('.epub') && !before.has(f))
        .map((f) => path.join(DEFAULT_DIR, f));
    }
    if (created.length) break;
  }
  ok(created.length === 1, '保存写到了「下载\\EPUB_Master」', created.map((p) => path.basename(p)).join(', ') || '没写出来');
  if (created.length) {
    const sz = fs.statSync(created[0]).size;
    ok(sz > 100000, '写出的文件有实际内容', (sz / 1048576).toFixed(2) + ' MB');
    const head = fs.readFileSync(created[0]).subarray(0, 4).toString('hex');
    ok(head === '504b0304', '写出的是合法 ZIP（EPUB 头正确）', head);
  }

  // 同一次运行里再存一次：应当得到「书名 (2).epub」，绝不覆盖上一份
  await page.click('#saveBtn');
  let second = [];
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    second = fs.readdirSync(DEFAULT_DIR)
      .filter((f) => f.endsWith('.epub') && !before.has(f));
    if (second.length > 1) break;
  }
  ok(second.length === 2, '再存一次不覆盖，自动改名', second.join(', '));
  ok(second.some((f) => /\(2\)/.test(f)), '同名文件加了序号', second.find((f) => /\(2\)/.test(f)) || '');

  await page.screenshot({ path: path.join(ROOT, 'test', 'desktop_window.png') });

  // 清理：只删本次测试自己新建的那些文件（before 里已有的一个都不动）
  const mine = fs.readdirSync(DEFAULT_DIR).filter((f) => f.endsWith('.epub') && !before.has(f));
  mine.forEach((f) => fs.unlinkSync(path.join(DEFAULT_DIR, f)));
  console.log('\n  已清理本次测试写入的 ' + mine.length + ' 个文件（原有文件未动）');

  browser.disconnect();
  child.kill();
  console.log(fails ? '\n' + fails + ' 项未通过' : '\n全部通过');
  process.exit(fails ? 1 : 0);
})().catch(function (e) {
  console.error('失败: ' + e.message);
  process.exit(1);
});
