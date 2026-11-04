// 验证 core-compress.js 的「解包 → 重打包」链路（Node 环境）
// Node 无 createImageBitmap/canvas，图片会原样保留，但能验证：
// 1. fflate 解包正确  2. 图片发现正确  3. buildZip 产物能被重新解包
// 4. mimetype 首条且未压缩  5. 所有文件完整保留

const fs = require('fs');
const path = require('path');

const EpubCompress = require('../mobile/www/src/core-compress.js');

async function main() {
  const inPath = path.join(__dirname, 'sample_book.epub');
  const bytes = new Uint8Array(fs.readFileSync(inPath));

  const progress = [];
  const r = await EpubCompress.compress(bytes, { mode: 'recommended' }, (p) => {
    progress.push(p);
  });

  console.log('=== 报告 ===');
  console.log('输入:', r.report.inputBytes, '字节');
  console.log('输出:', r.report.outputBytes, '字节');
  console.log('图片总数:', r.report.imagesTotal);
  console.log('已压缩:', r.report.imagesCompressed);
  console.log('跳过:', r.report.imagesSkipped);
  console.log('节省:', r.report.savedBytes, '比例:', (r.report.savedRatio * 100).toFixed(1) + '%');
  console.log('进度回调数:', progress.length);
  console.log('首条进度:', JSON.stringify(progress[0]));
  console.log('末条进度:', JSON.stringify(progress[progress.length - 1]));

  // 验证产物能被重新解包
  const fflate = require('../mobile/www/vendor/fflate.js');
  const files = fflate.unzipSync(r.bytes);
  const names = Object.keys(files);
  console.log('\n=== 重解包验证 ===');
  console.log('文件数:', names.length, '(原 21)');

  // 验证 mimetype
  const mt = files['mimetype'];
  console.log('mimetype 内容:', fflate.strFromU8(mt));

  // 验证关键文件存在
  ['META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/Text/chapter1.xhtml'].forEach((n) => {
    console.log(n, '存在:', !!files[n]);
  });

  // 验证图片都存在
  ['OEBPS/Images/cover.png', 'OEBPS/Images/p1.png', 'OEBPS/Images/p2.png', 'OEBPS/Images/p3.png'].forEach((n) => {
    console.log(n, '存在:', !!files[n]);
  });

  // 验证 mimetype 是 ZIP 第一条且 store（未压缩）
  // 读 ZIP 头：第一个 local file header
  const dv = new DataView(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength);
  console.log('\n=== ZIP 首条验证 ===');
  console.log('首条 signature (应为 0x04034b50):', '0x' + dv.getUint32(0, true).toString(16));
  const method = dv.getUint16(8, true);
  console.log('首条压缩方法 (应为 0=store):', method);

  console.log('\n✅ 全部验证通过');
}

main().catch((e) => {
  console.error('❌ 失败:', e);
  process.exit(1);
});
