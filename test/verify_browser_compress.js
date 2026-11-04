// 用 Edge（真实浏览器）验证图片压缩逻辑
// 加载 core-compress.js + fflate，实际压缩 sample_book.epub 的图片
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

async function main() {
  const inPath = path.join(__dirname, 'sample_book.epub');
  const bytes = fs.readFileSync(inPath);
  const b64 = bytes.toString('base64');

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage();

  await page.goto('about:blank');
  // 注入 fflate 和 core-compress
  await page.addScriptTag({ path: path.join(__dirname, '../mobile/www/vendor/fflate.js') });
  await page.addScriptTag({ path: path.join(__dirname, '../mobile/www/src/core-compress.js') });

  const result = await page.evaluate(async (b64) => {
    const raw = atob(b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

    const r = await window.EpubCompress.compress(bytes, { mode: 'recommended' }, (p) => {});

    // 检查压缩后的图片实际大小
    const out = window.fflate.unzipSync(r.bytes);
    const before = { cover: null, p1: null, p2: null, p3: null };
    const after = { cover: null, p1: null, p2: null, p3: null };

    const names = ['OEBPS/Images/cover.png', 'OEBPS/Images/p1.png', 'OEBPS/Images/p2.png', 'OEBPS/Images/p3.png'];
    // 原始大小
    const inFiles = window.fflate.unzipSync(bytes);
    names.forEach((n, i) => {
      const key = ['cover', 'p1', 'p2', 'p3'][i];
      before[key] = inFiles[n] ? inFiles[n].length : 0;
      // 压缩后可能改扩展名为 .jpg
      const alt = n.replace(/\.png$/i, '.jpg');
      after[key] = out[n] ? out[n].length : (out[alt] ? out[alt].length : 0);
    });

    return {
      inputBytes: r.report.inputBytes,
      outputBytes: r.report.outputBytes,
      imagesTotal: r.report.imagesTotal,
      imagesCompressed: r.report.imagesCompressed,
      imagesSkipped: r.report.imagesSkipped,
      imageBytesBefore: r.report.imageBytesBefore,
      imageBytesAfter: r.report.imageBytesAfter,
      savedRatio: r.report.savedRatio,
      before,
      after
    };
  }, b64);

  console.log('=== 真实浏览器图片压缩验证 ===');
  console.log('输入:', result.inputBytes, '字节');
  console.log('输出:', result.outputBytes, '字节');
  console.log('图片总数:', result.imagesTotal);
  console.log('已压缩:', result.imagesCompressed, '/ 跳过:', result.imagesSkipped);
  console.log('图片字节 前:', result.imageBytesBefore, '→ 后:', result.imageBytesAfter);
  console.log('整体节省比例:', (result.savedRatio * 100).toFixed(1) + '%');
  console.log('\n逐张对比:');
  ['cover', 'p1', 'p2', 'p3'].forEach((k) => {
    const b = result.before[k], a = result.after[k];
    const pct = b > 0 ? ((1 - a / b) * 100).toFixed(1) : '0';
    console.log(`  ${k}: ${b} → ${a} 字节 (${pct}%)`);
  });

  await browser.close();
  console.log('\n✅ 图片压缩逻辑验证完成');
}

main().catch((e) => {
  console.error('❌ 失败:', e);
  process.exit(1);
});
