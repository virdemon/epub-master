/* ============================================================
   EPUB Master (Android) — 精简 EPUB 压缩引擎
   只做一件事：把 EPUB 里的位图逐张压缩，再原样重打包。
   不改排版、不删内容、不转版本、不清理资源。

   复用自电脑端 epubfix/src/core.js 中已验证的核心算法：
     - 图片解码/重编码：createImageBitmap + canvas + toBlob
     - ZIP 打包：手写 ZIP + 浏览器原生 deflate-raw（比 fflate 更小）
   依赖：fflate（解包用）
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../vendor/fflate.js'));
  } else {
    root.EpubCompress = factory(root.fflate);
  }
})(typeof self !== 'undefined' ? self : this, function (fflate) {
  'use strict';

  var IMAGE_EXT = /\.(jpe?g|jpe|png|gif|webp|bmp|tiff?|avif|heic)$/i;
  var COMPRESSED_ALREADY = /\.(jpe?g|png|gif|webp|mp3|mp4|m4a|zip)$/i;

  /* ---------------------------------------------------------------- 路径 */

  function dirname(p) {
    var i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
  }
  function basename(p) {
    var i = p.lastIndexOf('/');
    return i < 0 ? p : p.slice(i + 1);
  }
  function extname(p) {
    var b = basename(p);
    var i = b.lastIndexOf('.');
    return i <= 0 ? '' : b.slice(i + 1).toLowerCase();
  }
  function stripExt(p) {
    var i = p.lastIndexOf('.');
    return i <= 0 ? p : p.slice(0, i);
  }

  var MEDIA_TYPES = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg',
    png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
    avif: 'image/avif', heic: 'image/heic', svg: 'image/svg+xml',
    css: 'text/css', xhtml: 'application/xhtml+xml', html: 'application/xhtml+xml',
    htm: 'application/xhtml+xml', xml: 'application/xml', nc: 'application/x-dtbncx+xml',
    ncx: 'application/x-dtbncx+xml', opf: 'application/oebps-package+xml',
    js: 'application/javascript', txt: 'text/plain',
    ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
    eot: 'application/vnd.ms-fontobject'
  };
  function guessMediaType(p) {
    return MEDIA_TYPES[extname(p)] || 'application/octet-stream';
  }

  // 读取原书 OPF 里声明的 EPUB 版本，仅用于展示。
  // 压缩过程绝不改动 OPF，因此 EPUB 2.0 输出仍是 EPUB 2.0，EPUB 3.0 也保持原样。
  function detectEpubVersion(files) {
    var opfPath = null;
    Object.keys(files).forEach(function (p) {
      if (!opfPath && /\.opf$/i.test(p)) opfPath = p;
    });
    if (!opfPath) return '';
    try {
      var text = fflate.strFromU8(files[opfPath]);
      var m = /<package[^>]*\sversion\s*=\s*["']([^"']+)["']/i.exec(text);
      return m ? m[1] : '';
    } catch (e) {
      return '';
    }
  }

  /* ---------------------------------------------------------------- 压缩模式 */

  /*
   * 三档模式，只作用于图片压缩，与排版无关：
   *   recommended  推荐（默认）：平衡体积与画质。长边 2000，JPEG 0.85。
   *   high         高质量：尽量保持清晰。不缩分辨率，JPEG 0.92。
   *   strong       强力压缩：更积极减小体积。长边 1400，JPEG 0.70。
   */
  var MODES = {
    recommended: { id: 'recommended', label: '推荐模式', quality: 0.85, maxEdge: 2000, forceJpeg: true },
    high:        { id: 'high',        label: '高质量',   quality: 0.92, maxEdge: 0,    forceJpeg: false },
    strong:      { id: 'strong',      label: '强力压缩', quality: 0.70, maxEdge: 1400, forceJpeg: true }
  };

  function modePolicy(name) {
    return MODES[name] || MODES.recommended;
  }

  /* ---------------------------------------------------------------- 图片压缩 */

  var JPEG_QUALITY = 0.85;

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve) {
      if (canvas.convertToBlob) {
        canvas.convertToBlob({ type: type, quality: quality }).then(resolve, function () {
          resolve(null);
        });
        return;
      }
      canvas.toBlob(function (b) { resolve(b); }, type, quality);
    });
  }

  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas === 'function') {
      try { return new OffscreenCanvas(w, h); } catch (e) { /* 回退 */ }
    }
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function hasAlpha(bitmap) {
    try {
      var c = makeCanvas(48, 48);
      var g = c.getContext('2d');
      g.drawImage(bitmap, 0, 0, 48, 48);
      var data = g.getImageData(0, 0, 48, 48).data;
      for (var i = 3; i < data.length; i += 4) {
        if (data[i] < 250) return true;
      }
      return false;
    } catch (e) {
      return true; // 读不到就当有透明，保守处理
    }
  }

  // 只读文件头拿到图片尺寸，避免为了"知道多大"而整张解码
  function imageSize(bytes) {
    if (!bytes || bytes.length < 24) return null;
    // PNG
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      var pw = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
      var ph = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
      if (pw && ph) return { w: pw, h: ph };
    }
    // GIF
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
      var gw = bytes[6] | (bytes[7] << 8);
      var gh = bytes[8] | (bytes[9] << 8);
      if (gw && gh) return { w: gw, h: gh };
    }
    // JPEG
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      var i = 2;
      while (i < bytes.length - 9) {
        if (bytes[i] !== 0xff) { i++; continue; }
        var marker = bytes[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        if (marker === 0xd9 || marker === 0xda) break;
        var len = (bytes[i + 2] << 8) | bytes[i + 3];
        if (len < 2) break;
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          var jh = (bytes[i + 5] << 8) | bytes[i + 6];
          var jw = (bytes[i + 7] << 8) | bytes[i + 8];
          if (jw && jh) return { w: jw, h: jh };
          break;
        }
        i += 2 + len;
      }
    }
    // WebP
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
      var fmt = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
      if (fmt === 'VP8 ') {
        var vw = ((bytes[26] | (bytes[27] << 8)) & 0x3fff);
        var vh = ((bytes[28] | (bytes[29] << 8)) & 0x3fff);
        if (vw && vh) return { w: vw, h: vh };
      } else if (fmt === 'VP8L') {
        var lw = 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]);
        var lh = 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | ((bytes[22] & 0xc0) >> 6));
        if (lw && lh) return { w: lw, h: lh };
      } else if (fmt === 'VP8X') {
        var xw = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
        var xh = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
        if (xw && xh) return { w: xw, h: xh };
      }
    }
    return null;
  }

  // 解码时直接按目标尺寸降采样，避免超大图把手机内存吃光而闪退
  var SAFE_EDGE = 3000;

  async function decodeImage(bytes, mediaType, targetEdge) {
    if (typeof createImageBitmap !== 'function') return null;
    var blob = new Blob([bytes], { type: mediaType });
    var limit = targetEdge && targetEdge > 0 ? targetEdge : SAFE_EDGE;

    var dim = null;
    try { dim = imageSize(bytes); } catch (e) { dim = null; }

    if (dim && Math.max(dim.w, dim.h) > limit) {
      var s = limit / Math.max(dim.w, dim.h);
      var rw = Math.max(1, Math.round(dim.w * s));
      var rh = Math.max(1, Math.round(dim.h * s));
      try {
        return await createImageBitmap(blob, {
          resizeWidth: rw,
          resizeHeight: rh,
          resizeQuality: 'high'
        });
      } catch (e) { /* 老内核不支持带缩放解码，回退整张解码 */ }
    }

    try {
      return await createImageBitmap(blob);
    } catch (e) {
      return null;
    }
  }

  async function encodeAs(bitmap, tw, th, keepPng, quality) {
    var canvas = makeCanvas(tw, th);
    var g = canvas.getContext('2d');
    if (!g) return null;
    if (!keepPng) {
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, tw, th);
    }
    g.drawImage(bitmap, 0, 0, tw, th);
    var blob = await canvasToBlob(canvas, keepPng ? 'image/png' : 'image/jpeg', quality);
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  }

  /*
   * 压一张图。cfg: { quality, maxEdge, forceJpeg }
   * 只在"压完确实变小"时才替换；GIF/SVG/AVIF/HEIC 一律跳过（不能安全重编码）。
   */
  async function compressOne(path, bytes, mediaType, cfg) {
    if (/\.(gif|svg|avif|heic)$/i.test(path) || /^image\/(gif|svg)/i.test(mediaType)) return null;

    var bitmap = await decodeImage(bytes, mediaType, cfg.maxEdge);
    if (!bitmap) return null;

    var w0 = bitmap.width || 0;
    var h0 = bitmap.height || 0;
    if (!w0 || !h0) {
      if (bitmap.close) bitmap.close();
      return null;
    }

    var isPng = /png/i.test(mediaType);
    var keepPng = isPng && hasAlpha(bitmap);
    var scale = 1;
    if (cfg.maxEdge && Math.max(w0, h0) > cfg.maxEdge) {
      scale = cfg.maxEdge / Math.max(w0, h0);
    }

    var quality = keepPng ? 1 : (cfg.quality != null ? cfg.quality : JPEG_QUALITY);
    var tw = Math.max(1, Math.round(w0 * scale));
    var th = Math.max(1, Math.round(h0 * scale));
    var out = await encodeAs(bitmap, tw, th, keepPng, quality);
    if (bitmap.close) bitmap.close();
    if (!out) return null;

    // 只有确实变小（<95%）才替换，避免"压缩后反而变大"
    if (out.length >= bytes.length * 0.95) return null;

    var newPath = path;
    if (!keepPng && !/jpe?g/i.test(mediaType)) newPath = stripExt(path) + '.jpg';

    return {
      path: path,
      newPath: newPath,
      bytes: out,
      mediaType: keepPng ? 'image/png' : 'image/jpeg',
      fromBytes: bytes.length,
      toBytes: out.length
    };
  }

  /* ---------------------------------------------------------------- 重复图片 */

  /*
   * 判断重复的规则：**字节完全一样才算**。
   * 先按文件长度分桶，长度一样的再逐字节比对 —— 长度不同的绝不可能是同一张图，
   * 所以绝大多数图连比对都不会触发，手机上也不会卡。
   * 之所以不用"看起来像"，是因为删错图的代价远大于少删几张。
   */

  function bytesEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  function groupIdentical(files, paths) {
    var byLen = {};
    paths.forEach(function (p) {
      var b = files[p];
      if (!b || !b.length) return;
      var key = String(b.length);
      if (!byLen[key]) byLen[key] = [];
      byLen[key].push(p);
    });

    var groups = [];
    Object.keys(byLen).forEach(function (key) {
      var list = byLen[key];
      if (list.length < 2) return;
      var used = {};
      for (var i = 0; i < list.length; i++) {
        if (used[list[i]]) continue;
        var same = [list[i]];
        for (var j = i + 1; j < list.length; j++) {
          if (used[list[j]]) continue;
          if (bytesEqual(files[list[i]], files[list[j]])) {
            same.push(list[j]);
            used[list[j]] = 1;
          }
        }
        if (same.length > 1) groups.push({ paths: same });
      }
    });
    return groups;
  }

  /* 相对路径解析：把 ref 按 baseDir 解析成包内绝对路径 */
  function resolveRel(baseDir, ref) {
    var clean = String(ref || '').replace(/[?#].*$/, '');
    if (!clean) return null;
    try { clean = decodeURIComponent(clean); } catch (e) { /* 保持原样 */ }
    if (/^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.indexOf('//') === 0) return null;
    var parts = (baseDir ? baseDir.split('/') : []).concat(clean.split('/'));
    var stack = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p || p === '.') continue;
      if (p === '..') { stack.pop(); continue; }
      stack.push(p);
    }
    return stack.join('/');
  }

  /* 从 fromDir 出发，指向 toPath 的相对路径 */
  function relPath(fromDir, toPath) {
    var from = fromDir ? fromDir.split('/') : [];
    var to = toPath.split('/');
    var i = 0;
    while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
    var up = [];
    for (var k = i; k < from.length; k++) up.push('..');
    return up.concat(to.slice(i)).join('/');
  }

  var TEXT_FILE = /\.(x?html?|css|opf|ncx|xml)$/i;

  /* 找出封面图片的包内路径：EPUB2 的 meta name=cover + EPUB3 的 cover-image 属性 */
  function findCoverPaths(files) {
    var opfPath = null;
    Object.keys(files).forEach(function (p) {
      if (!opfPath && /\.opf$/i.test(p)) opfPath = p;
    });
    var out = {};
    if (!opfPath) return out;
    var text;
    try { text = fflate.strFromU8(files[opfPath]); } catch (e) { return out; }
    var opfDir = dirname(opfPath);
    var idToHref = {};
    var itemRe = /<item\b[^>]*>/gi;
    var m;
    while ((m = itemRe.exec(text))) {
      var tag = m[0];
      var id = (/\sid\s*=\s*"([^"]*)"/i.exec(tag) || [])[1];
      var href = (/\shref\s*=\s*"([^"]*)"/i.exec(tag) || [])[1];
      if (id && href) idToHref[id] = href;
      if (/properties\s*=\s*"[^"]*cover-image/i.test(tag) && href) {
        var cp = resolveRel(opfDir, href);
        if (cp) out[cp] = 1;
      }
    }
    var coverMeta = /<meta\b[^>]*name\s*=\s*"cover"[^>]*>/i.exec(text);
    if (coverMeta) {
      var cid = (/\scontent\s*=\s*"([^"]*)"/i.exec(coverMeta[0]) || [])[1];
      if (cid && idToHref[cid]) {
        var p2 = resolveRel(opfDir, idToHref[cid]);
        if (p2) out[p2] = 1;
      }
    }
    return out;
  }

  /* 把正文/样式/目录里指向被删图片的引用改到保留的那一份 */
  function rewriteRefs(files, out, renameMap, removedSet) {
    var oldToNew = {}; // basename 兜底用
    Object.keys(renameMap).forEach(function (oldPath) {
      oldToNew[basename(oldPath).toLowerCase()] = basename(renameMap[oldPath]);
    });

    Object.keys(out).forEach(function (name) {
      if (!TEXT_FILE.test(name)) return;
      var text;
      try { text = fflate.strFromU8(out[name]); } catch (e) { return; }
      var dir = dirname(name);
      var before = text;

      // 1) src= / href= / xlink:href= 属性
      text = text.replace(/(\s(?:xlink:href|href|src)\s*=\s*")([^"]*)(")/gi, function (all, open, val, close) {
        var abs = resolveRel(dir, val);
        if (!abs) return all;
        var dropFrag = /[?#]/.test(val) ? val.slice(val.search(/[?#]/)) : '';
        if (renameMap[abs]) {
          return open + relPath(dir, renameMap[abs]) + dropFrag + close;
        }
        if (removedSet[abs]) return open + '' + close; // 理论上不会走到，保险
        return all;
      });

      // 2) CSS 里的 url(...)
      text = text.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, function (all, q, val) {
        var abs = resolveRel(dir, val);
        if (!abs || !renameMap[abs]) return all;
        return 'url(' + q + relPath(dir, renameMap[abs]) + q + ')';
      });

      if (text !== before) out[name] = fflate.strToU8(text);
    });
  }

  /* 从 OPF 的 manifest 里删掉已被移除的图片条目，否则阅读器会说文件缺失 */
  function pruneManifest(files, out, removedSet) {
    var opfPath = null;
    Object.keys(out).forEach(function (p) {
      if (!opfPath && /\.opf$/i.test(p)) opfPath = p;
    });
    if (!opfPath || !Object.keys(removedSet).length) return;
    var dir = dirname(opfPath);
    var text;
    try { text = fflate.strFromU8(out[opfPath]); } catch (e) { return; }

    var changed = false;
    text = text.replace(/<item\b[^>]*\/?>/gi, function (tag) {
      var href = (/\shref\s*=\s*"([^"]*)"/i.exec(tag) || [])[1];
      if (!href) return tag;
      var abs = resolveRel(dir, href);
      if (abs && removedSet[abs]) { changed = true; return ''; }
      return tag;
    });
    if (changed) out[opfPath] = fflate.strToU8(text);
  }

  /* ---------------------------------------------------------------- ZIP 打包 */

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    var c = 0xffffffff;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  async function deflateRaw(bytes) {
    if (typeof CompressionStream !== 'function') return null;
    try {
      var cs = new CompressionStream('deflate-raw');
      var stream = new Blob([bytes]).stream().pipeThrough(cs);
      var ab = await new Response(stream).arrayBuffer();
      return new Uint8Array(ab);
    } catch (e) {
      return null;
    }
  }

  function dosDateTime(d) {
    var time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
    var date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time: time & 0xffff, date: date & 0xffff };
  }

  async function buildZip(entries) {
    var now = dosDateTime(new Date());
    var locals = [];
    var centrals = [];
    var offset = 0;

    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var nameBytes = fflate.strToU8(e.name);
      var data = e.data;
      var method = 0;
      var payload = data;

      if (e.store !== true && data.length > 0) {
        var comp = await deflateRaw(data);
        if (!comp) comp = fflate.deflateSync(data, { level: 9 });
        if (comp && comp.length < data.length) {
          method = 8;
          payload = comp;
        }
      }

      var crc = crc32(data);
      var flags = 0x0800;

      var lh = new Uint8Array(30 + nameBytes.length);
      var dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, flags, true);
      dv.setUint16(8, method, true);
      dv.setUint16(10, now.time, true);
      dv.setUint16(12, now.date, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, payload.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);

      locals.push(lh, payload);
      centrals.push({
        nameBytes: nameBytes, method: method, crc: crc,
        csize: payload.length, usize: data.length, offset: offset, flags: flags
      });
      offset += lh.length + payload.length;
    }

    var cdSize = 0;
    var cdParts = [];
    for (var j = 0; j < centrals.length; j++) {
      var c = centrals[j];
      var ch = new Uint8Array(46 + c.nameBytes.length);
      var cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, c.flags, true);
      cv.setUint16(10, c.method, true);
      cv.setUint16(12, now.time, true);
      cv.setUint16(14, now.date, true);
      cv.setUint32(16, c.crc, true);
      cv.setUint32(20, c.csize, true);
      cv.setUint32(24, c.usize, true);
      cv.setUint16(28, c.nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, c.offset, true);
      ch.set(c.nameBytes, 46);
      cdParts.push(ch);
      cdSize += ch.length;
    }

    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, centrals.length, true);
    ev.setUint16(10, centrals.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    var total = offset + cdSize + eocd.length;
    var outBuf = new Uint8Array(total);
    var pos = 0;
    var k;
    for (k = 0; k < locals.length; k++) {
      outBuf.set(locals[k], pos);
      pos += locals[k].length;
    }
    for (k = 0; k < cdParts.length; k++) {
      outBuf.set(cdParts[k], pos);
      pos += cdParts[k].length;
    }
    outBuf.set(eocd, pos);
    return outBuf;
  }

  /* ---------------------------------------------------------------- 主入口 */

  /*
   * compress(input, options, onProgress) -> Promise<{ bytes, report }>
   *   input : Uint8Array（EPUB 字节）
   *   options: { mode: 'recommended'|'high'|'strong', shouldCancel: fn }
   *   onProgress: fn({ phase, message, ratio })
   *
   * 流程：解包 → 发现所有位图 → 逐张压缩 → 原样重打包。
   * 原文件字节只读，绝不修改；输出是全新字节。
   */
  async function compress(input, options, onProgress) {
    var opts = options || {};
    var policy = modePolicy(opts.mode || 'recommended');

    function checkCancel() {
      if (opts.shouldCancel && opts.shouldCancel()) throw new Error('__CANCELLED__');
    }
    function progress(phase, message, ratio) {
      if (typeof onProgress === 'function') {
        onProgress({ phase: phase, message: message, ratio: ratio == null ? null : ratio });
      }
    }
    checkCancel();

    var report = {
      mode: policy.id,
      modeLabel: policy.label,
      inputBytes: 0,
      outputBytes: 0,
      imageBytesBefore: 0,
      imageBytesAfter: 0,
      imagesTotal: 0,
      imagesCompressed: 0,
      imagesSkipped: 0,
      savedBytes: 0,
      savedRatio: 0,
      epubVersion: '',
      dupGroups: 0,
      dupRemoved: 0,
      dupSavedBytes: 0
    };

    progress('unzip', '正在解包 EPUB', 0.03);
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    report.inputBytes = bytes.length;

    var files;
    try {
      files = fflate.unzipSync(bytes);
    } catch (e) {
      throw new Error('无法解包：不是有效的 EPUB 文件。');
    }
    checkCancel();

    // 发现所有位图（manifest 声明的 + 包里真实存在的，按扩展名）
    var imagePaths = [];
    var seen = {};
    Object.keys(files).forEach(function (p) {
      if (seen[p] || p.indexOf('META-INF/') === 0) return;
      if (!IMAGE_EXT.test(p)) return;
      if (/\.svg$/i.test(p)) return; // SVG 矢量，跳过
      seen[p] = 1;
      imagePaths.push(p);
    });
    report.imagesTotal = imagePaths.length;
    report.epubVersion = detectEpubVersion(files);

    /* --- 先去重，再压缩：重复的直接不压，省时间也省电 --- */
    var removedSet = {};
    var renameMap = {};
    if (opts.dedupe !== false && imagePaths.length > 1) {
      progress('dedupe', '正在查找重复图片', 0.06);
      var covers = findCoverPaths(files);
      var groups = groupIdentical(files, imagePaths);
      report.dupGroups = groups.length;
      checkCancel();

      groups.forEach(function (g) {
        // 封面永远留下，用它当保留的那一份
        var keep = g.paths[0];
        for (var gi = 0; gi < g.paths.length; gi++) {
          if (covers[g.paths[gi]]) { keep = g.paths[gi]; break; }
        }
        g.paths.forEach(function (p) {
          if (p === keep) return;
          renameMap[p] = keep;
          removedSet[p] = 1;
          report.dupRemoved++;
          report.dupSavedBytes += files[p].length;
        });
      });

      if (report.dupRemoved) {
        imagePaths = imagePaths.filter(function (p) { return !removedSet[p]; });
        report.imagesTotal = imagePaths.length;
      }
    }

    progress('compress', '正在压缩图片', 0.1);
    var out = {};
    var changed = {};

    for (var i = 0; i < imagePaths.length; i++) {
      checkCancel();
      var path = imagePaths[i];
      var raw = files[path];
      var mt = guessMediaType(path);
      report.imageBytesBefore += raw.length;

      var r = await compressOne(path, raw, mt, {
        quality: policy.quality,
        maxEdge: policy.maxEdge,
        forceJpeg: policy.forceJpeg
      });

      if (r) {
        changed[r.path] = r;
        out[r.newPath] = r.bytes;
        report.imageBytesAfter += r.toBytes;
        report.imagesCompressed++;
      } else {
        report.imageBytesAfter += raw.length;
        report.imagesSkipped++;
      }

      // 压缩阶段进度 10% → 80%
      var ratio = 0.1 + 0.7 * ((i + 1) / Math.max(1, imagePaths.length));
      progress('compress', '正在压缩图片 ' + (i + 1) + '/' + imagePaths.length, ratio);
    }

    // 更新引用：图片扩展名可能变化（png→jpg），需要同步 XHTML/CSS 里的引用
    progress('rewrite', '正在更新引用', 0.85);
    Object.keys(files).forEach(function (name) {
      if (removedSet[name]) return; // 被判为重复的，直接不进新包
      if (changed[name]) {
        out[name] = changed[name].bytes;
      } else {
        out[name] = files[name];
      }
    });

    // 指向被删图片的引用改到保留的那一份，并从 manifest 摘掉对应条目
    // 顺序不能反：先摘 manifest，再改引用。反了的话 manifest 里那条指向重复图的
    // href 已经被改写，就认不出来该删哪一条，最后会留下两条指向同一个文件的条目。
    if (report.dupRemoved) {
      pruneManifest(files, out, removedSet);
      rewriteRefs(files, out, renameMap, removedSet);
    }

    // 修正改扩展名后的引用（.png → .jpg）
    var renames = {};
    Object.keys(changed).forEach(function (oldPath) {
      var c = changed[oldPath];
      if (c.newPath !== c.path) renames[oldPath] = c.newPath;
    });
    var renameKeys = Object.keys(renames);
    if (renameKeys.length) {
      Object.keys(out).forEach(function (name) {
        if (/\.(x?html?|css|xml|ncx|opf)$/i.test(name)) {
          var text = fflate.strFromU8(out[name]);
          var changedText = false;
          renameKeys.forEach(function (oldPath) {
            var base = basename(oldPath);
            var newBase = basename(renames[oldPath]);
            var re = new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
            if (re.test(text)) {
              text = text.replace(re, newBase);
              changedText = true;
            }
          });
          if (changedText) out[name] = fflate.strToU8(text);
        }
      });
    }

    checkCancel();

    // 重打包
    progress('pack', '正在生成文件', 0.9);
    var entries = [{ name: 'mimetype', data: fflate.strToU8('application/epub+zip'), store: true }];
    Object.keys(out).forEach(function (name) {
      if (name === 'mimetype') return;
      entries.push({
        name: name,
        data: out[name],
        store: COMPRESSED_ALREADY.test(name)
      });
    });

    var packed = await buildZip(entries);
    checkCancel();

    report.outputBytes = packed.length;
    report.savedBytes = report.inputBytes - report.outputBytes;
    report.savedRatio = report.inputBytes > 0 ? report.savedBytes / report.inputBytes : 0;

    progress('done', '完成', 1.0);

    return { bytes: packed, report: report };
  }

  return {
    MODES: MODES,
    compress: compress,
    _internals: { groupIdentical: groupIdentical, resolveRel: resolveRel, relPath: relPath }
  };
});
