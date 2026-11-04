/* 验证分块 Base64 传输的字节完整性：
   每块 192KB（3 的倍数）→ Base64 → 独立解码 → 拼接，必须和原始字节完全一致。
   这是"保存出来的 epub 是否损坏"的关键保证。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CHUNK_BYTES = 192 * 1024;

function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const CHUNK = 0xc000; // 必须是 3 的倍数，否则块间会产生 "=" 填充破坏整体
  const out = [];
  for (let i = 0; i < u8.length; i += CHUNK) {
    const chunk = u8.subarray(i, i + CHUNK);
    let bin = '';
    for (let j = 0; j < chunk.length; j++) bin += String.fromCharCode(chunk[j]);
    out.push(Buffer.from(bin, 'binary').toString('base64'));
  }
  return out.join('');
}

function roundTrip(src, label) {
  let out = Buffer.alloc(0);
  const sizes = [];
  let midHasPadding = false;
  const chunkCount = Math.ceil(src.length / CHUNK_BYTES);

  for (let off = 0; off < src.length; off += CHUNK_BYTES) {
    const end = Math.min(off + CHUNK_BYTES, src.length);
    const sub = src.subarray(off, end);
    const b64 = bytesToBase64(sub);

    if (b64.length % 4 !== 0) {
      throw new Error(`${label}: 第 ${off / CHUNK_BYTES} 块长度 ${b64.length} 不是 4 的倍数`);
    }
    const isLast = end >= src.length;
    if (!isLast && b64.indexOf('=') >= 0) midHasPadding = true;

    out = Buffer.concat([out, Buffer.from(b64, 'base64')]);
    sizes.push(b64.length);
  }

  const ok = out.length === src.length && out.equals(src);
  console.log(`${label}: 原 ${src.length} 字节 / 回 ${out.length} 字节 / ${chunkCount} 块 / 中间块含填充=${midHasPadding} / ${ok ? '✅ 一致' : '❌ 不一致'}`);
  return ok;
}

(async () => {
  let allOk = true;

  // 1) 5.68MB（对应用户那本压缩后的体积）
  const big = crypto.randomBytes(Math.round(5.68 * 1024 * 1024));
  allOk = roundTrip(big, '5.68MB 随机数据') && allOk;

  // 2) 正好是块大小的整数倍
  const exact = crypto.randomBytes(CHUNK_BYTES * 3);
  allOk = roundTrip(exact, '576KB 整块边界') && allOk;

  // 3) 只有 1 字节
  allOk = roundTrip(Buffer.from([0xff]), '1 字节') && allOk;

  // 4) 真实 epub 文件
  const book = path.resolve(__dirname, 'sample_book.epub');
  if (fs.existsSync(book)) {
    allOk = roundTrip(fs.readFileSync(book), 'sample_book.epub') && allOk;
  }

  console.log(allOk ? '\n✅ 分块传输字节完整性全部通过' : '\n❌ 存在失败项');
  process.exit(allOk ? 0 : 1);
})();
