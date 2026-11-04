/* ============================================================
   EPUB Master — 原生桥接层（Android）
   把压缩后的 EPUB 分块写入手机公共「下载/EPUB Master」目录。

   为什么分块：一本 EPUB 转成 Base64 有七八 MB，一次性通过 WebView
   桥接传给原生层会超出单次调用上限被截断，导致「文件数据解码失败」。
   改成每块 192KB 原始字节（Base64 后 256KB，且在 4 的倍数边界上），
   逐块写入，稳定且内存占用低。

   本文件会被 esbuild 打包成自包含 IIFE，挂 window.__emNative。
   ============================================================ */
import { Capacitor, registerPlugin } from '@capacitor/core';

var DownloadSaver = registerPlugin('DownloadSaver');

// 每块原始字节数：192KB = 196608，是 3 的倍数，
// 因此每块 Base64 后正好 262144 字符，块间不会产生 padding
var CHUNK_BYTES = 192 * 1024;

// base64 编码二进制。
// 内部分块必须是 3 的倍数（0xC000 = 49152），否则每块单独编码会产生 "=" 填充，
// 拼接后中间出现填充字符会让整个 Base64 失效、解码数据被截断。
function bytesToBase64(bytes) {
  var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  var CHUNK = 0xc000;
  var out = [];
  for (var i = 0; i < u8.length; i += CHUNK) {
    var chunk = u8.subarray(i, i + CHUNK);
    var bin = '';
    for (var j = 0; j < chunk.length; j++) {
      bin += String.fromCharCode(chunk[j]);
    }
    out.push(btoa(bin));
  }
  return out.join('');
}

function nativeReady() {
  try {
    return Capacitor.isNativePlatform();
  } catch (e) {
    return false;
  }
}

function errText(e) {
  if (!e) return '未知错误';
  return String(e.message || e);
}

/**
 * 保存单个文件
 * @param {string} name 文件名
 * @param {Uint8Array} bytes 文件内容
 * @param {function} onProgress 可选，(已写字节, 总字节) => void
 * @returns {Promise<{ok:boolean, uri?:string, path?:string, name?:string, error?:string}>}
 */
async function save(name, bytes, onProgress) {
  if (!nativeReady()) {
    return { ok: false, error: 'NOT_NATIVE' };
  }

  var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  var total = u8.length;
  if (!total) return { ok: false, error: '文件内容为空' };

  var begun = false;
  try {
    await DownloadSaver.begin({ fileName: name });
    begun = true;

    for (var off = 0; off < total; off += CHUNK_BYTES) {
      var end = Math.min(off + CHUNK_BYTES, total);
      var sub = u8.subarray(off, end);
      await DownloadSaver.writeChunk({ chunk: bytesToBase64(sub) });
      if (typeof onProgress === 'function') {
        onProgress(end, total);
      }
    }

    var res = await DownloadSaver.finish({});
    return {
      ok: true,
      uri: res.uri,
      path: res.path,
      name: res.name,
      bytes: res.bytes
    };
  } catch (e) {
    if (begun) {
      try { await DownloadSaver.abort({}); } catch (e2) { /* 忽略 */ }
    }
    return { ok: false, error: errText(e) };
  }
}

// 用系统阅读器打开已保存的文件
async function open(uri) {
  if (!nativeReady()) return { ok: false, error: 'NOT_NATIVE' };
  try {
    await DownloadSaver.open({ uri: uri });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// 批量保存（给网页版兼容用）
async function saveMany(files) {
  var saved = [];
  var errors = [];
  for (var i = 0; i < files.length; i++) {
    var r = await save(files[i].name, files[i].bytes);
    if (r.ok) saved.push(r);
    else errors.push({ name: files[i].name, error: r.error });
  }
  return { saved: saved, errors: errors };
}

window.__emNative = {
  available: nativeReady(),
  save: save,
  saveMany: saveMany,
  open: open
};
