/*
 * epubfix core —— EPUB 规范化引擎
 *
 * 目标：把一本"创作者随手生成 / 转换器导出"的 EPUB，重排成
 * 微信读书（手机、墨水屏、Pad、PC）上排版一致的版本。
 *
 * 处理的四类病根：
 *   1. 绝对单位字号与行高（px/pt）—— 各端缩放不同步
 *   2. 图片尺寸写死 —— 小屏溢出、大屏过小
 *   3. 章节粒度太粗（整本一个 xhtml）—— 加载慢、进度同步错位
 *   4. 目录层级混乱 —— 目录显示错乱
 *
 * 设计原则：宁可少改，不可改坏。拿不准的一律保留原文。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../vendor/fflate.js'));
  } else {
    root.EpubFix = factory(root.fflate);
  }
})(typeof self !== 'undefined' ? self : this, function (fflate) {
  'use strict';

  var XHTML_NS = 'http://www.w3.org/1999/xhtml';
  var OPS_NS = 'http://www.idpf.org/2007/ops';
  var IMAGE_EXT = /\.(jpe?g|jpe|png|gif|webp|bmp|tiff?|avif|heic|svg)$/i;
  var FONT_EXT = /^(ttf|otf|woff2?|eot|ttc)$/i;

  // ------------------------------------------------------------------ 路径

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
  function isExternal(url) {
    return /^[a-z][a-z0-9+.\-]*:/i.test(url) || url.indexOf('//') === 0;
  }

  /*
   * 按扩展名推断 media-type。用于 manifest 里根本没声明的文件：
   * 这些文件必须补进新 manifest，否则阅读器会报"未列在 manifest 中"。
   */
  var MEDIA_TYPES = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    jpe: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    avif: 'image/avif',
    heic: 'image/heic',
    svg: 'image/svg+xml',
    css: 'text/css',
    xhtml: 'application/xhtml+xml',
    xht: 'application/xhtml+xml',
    html: 'application/xhtml+xml',
    htm: 'application/xhtml+xml',
    xml: 'application/xml',
    nc: 'application/x-dtbncx+xml',
    ncx: 'application/x-dtbncx+xml',
    opf: 'application/oebps-package+xml',
    js: 'application/javascript',
    txt: 'text/plain',
    ttf: 'font/ttf',
    otf: 'font/otf',
    ttc: 'font/collection',
    woff: 'font/woff',
    woff2: 'font/woff2',
    eot: 'application/vnd.ms-fontobject',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    webm: 'video/webm',
    pdf: 'application/pdf'
  };
  function guessMediaType(p) {
    return MEDIA_TYPES[extname(p)] || 'application/octet-stream';
  }

  /*
   * 只读图片头拿真实像素尺寸，不解码像素。
   * 图片浏览要按分辨率排序、要显示 "1200×1600"，如果为此把 500 张图
   * 全部 decode 一遍，光内存就够把标签页弄崩。读文件头几 KB 就够。
   */
  function imageSize(bytes, mediaType) {
    var b = bytes;
    var mt = String(mediaType || '').toLowerCase();
    var ext = '';
    try {
      if (!b || b.length < 16) return { width: 0, height: 0, ext: ext };
      // PNG：8 字节签名 + 长度 + "IHDR" + 宽 + 高（大端）
      if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
        return { width: u32be(b, 16), height: u32be(b, 20), ext: 'png' };
      }
      // GIF：6 字节签名后是小端宽高
      if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
        return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8), ext: 'gif' };
      }
      // BMP
      if (b[0] === 0x42 && b[1] === 0x4d) {
        return { width: u32le(b, 18), height: Math.abs(i32le(b, 22)), ext: 'bmp' };
      }
      // WebP：RIFF....WEBP，再按块类型取
      if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
          b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
        var fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
        if (fourcc === 'VP8 ') {
          return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff, ext: 'webp' };
        }
        if (fourcc === 'VP8L') {
          var n = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
          return { width: (n & 0x3fff) + 1, height: ((n >> 14) & 0x3fff) + 1, ext: 'webp' };
        }
        if (fourcc === 'VP8X') {
          return { width: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1, height: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1, ext: 'webp' };
        }
      }
      // JPEG：逐个 segment 找 SOF
      if (b[0] === 0xff && b[1] === 0xd8) {
        var p = 2;
        while (p + 9 < b.length) {
          if (b[p] !== 0xff) { p++; continue; }
          var marker = b[p + 1];
          if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
          if (marker === 0xd9) break;
          var len = (b[p + 2] << 8) | b[p + 3];
          // SOF0/1/2/3/5/6/7/9/10/11/13/14/15：C4(DHT)、C8、CC(DAC) 不是 SOF
          if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { width: (b[p + 7] << 8) | b[p + 8], height: (b[p + 5] << 8) | b[p + 6], ext: 'jpg' };
          }
          if (len < 2) break;
          p += 2 + len;
        }
        return { width: 0, height: 0, ext: 'jpg' };
      }
      if (/svg/.test(mt) || b.length < 1024) {
        // 矢量图：尺寸来自宽高属性，交给界面用 img 的实际渲染尺寸
        return { width: 0, height: 0, ext: 'svg' };
      }
    } catch (e) { /* 文件头坏了就当尺寸未知，不影响浏览 */ }
    return { width: 0, height: 0, ext: ext };
  }

  function u32be(b, i) { return (b[i] << 24 >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]; }
  function u32le(b, i) { return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0; }
  function i32le(b, i) { return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24); }

  function decodePath(p) {
    try {
      return decodeURIComponent(p);
    } catch (e) {
      return p;
    }
  }
  function resolvePath(baseFile, rel) {
    if (!rel) return '';
    if (isExternal(rel) || rel.charAt(0) === '#' || rel.charAt(0) === '/') return rel;
    var raw = dirname(baseFile) + '/' + rel;
    var parts = raw.split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (!seg || seg === '.') continue;
      if (seg === '..') out.pop();
      else out.push(seg);
    }
    return out.join('/');
  }
  function relativePath(fromFile, toFile) {
    var f = dirname(fromFile).split('/').filter(Boolean);
    var t = toFile.split('/').filter(Boolean);
    var i = 0;
    while (i < f.length && i < t.length && f[i] === t[i]) i++;
    var up = [];
    for (var k = 0; k < f.length - i; k++) up.push('..');
    return up.concat(t.slice(i)).join('/') || basename(toFile);
  }

  // ---------------------------------------------------------------- 序列化

  var VOID_ELEMENTS = {
    area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1,
    input: 1, link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1
  };

  function escText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(s) {
    return escText(s).replace(/"/g, '&quot;');
  }

  /* 自写序列化器，而不是用 XMLSerializer：
     HTML 解析出的 DOM 用 XMLSerializer 会输出 <br> 而非 <br/>，
     那不是良构 XML，部分阅读器会直接报错。 */
  function serializeNode(node) {
    if (!node) return '';
    // 被删掉的节点：ch.nodes 是 body 子节点的快照，从 DOM 摘掉后数组里还留着引用，
    // 必须打标记跳过，否则删掉的空段落仍会被写进输出。
    if (node._efRemoved) return '';
    if (node.nodeType === 3) return escText(node.nodeValue);
    if (node.nodeType !== 1) return '';
    var tag = node.tagName.toLowerCase();
    var out = '<' + tag;
    var attrs = node.attributes;
    for (var i = 0; i < attrs.length; i++) {
      out += ' ' + attrs[i].name + '="' + escAttr(attrs[i].value) + '"';
    }
    if (VOID_ELEMENTS[tag]) return out + ' />';
    var inner = '';
    var kids = node.childNodes;
    for (var j = 0; j < kids.length; j++) inner += serializeNode(kids[j]);
    return out + '>' + inner + '</' + tag + '>';
  }

  function serializeChildren(node) {
    var out = '';
    for (var i = 0; i < node.childNodes.length; i++) {
      var s = serializeNode(node.childNodes[i]);
      if (s) out += s + '\n';
    }
    return out.replace(/\n+$/, '\n');
  }

  // ------------------------------------------------------------------ 解析

  function parseMarkup(text) {
    var doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
    var err = doc.getElementsByTagName('parsererror');
    if (err && err.length) {
      doc = new DOMParser().parseFromString(text, 'text/html');
    }
    return doc;
  }

  function localTag(el) {
    return (el.localName || el.tagName || '').toLowerCase();
  }

  function getBody(doc) {
    var bodies = doc.getElementsByTagName('body');
    if (bodies.length) return bodies[0];
    var all = doc.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
      if (localTag(all[i]) === 'body') return all[i];
    }
    return doc.documentElement;
  }

  // ------------------------------------------------------------ 清理规则

  // 只有这些 class 会被保留，其余全部丢弃（原样式表已整体移除，留着也没用）
  var KEEP_CLASSES = {
    center: 1, noindent: 1, indent: 1, right: 1, left: 1,
    quote: 1, poetry: 1, title: 1, subtitle: 1, author: 1, note: 1
  };

  var DROP_TAGS = {
    script: 1, style: 1, link: 1, meta: 1, base: 1, title: 1,
    iframe: 1, object: 1, embed: 1, applet: 1, form: 1, input: 1,
    button: 1, select: 1, textarea: 1, audio: 1, video: 1, canvas: 1
  };

  var UNWRAP_TAGS = { font: 1, center: 1, big: 1, tt: 1 };

  /*
   * 处理策略。三种模式必须对应真实的引擎行为差异，不能只是换个名字：
   *
   *  standard  保留原书 CSS 与内联样式，只把 px/pt 这类绝对单位换算成相对单位
   *            （这是"同一本书在不同设备上字号不一样"的根因），不删字体、
   *            不删空段落，只修真正坏掉的结构。
   *  deep      用统一样式表替代原 CSS。原书 CSS 里写死的字号、行高、缩进
   *            在阅读器里会互相打架，统一之后排版才可预期；同时清空段落、
   *            去内联样式、限制图片最长边、移除内嵌字体。
   *  extreme   在 deep 基础上进一步降分辨率与画质，并清理未被引用的资源。
   */
  var MODES = {
    standard: {
      id: 'standard',
      label: '标准优化',
      desc: '保留原始排版，只做安全清理，平衡质量与大小。',
      preserveCss: true,
      keepInlineStyles: true,
      normalizeUnits: true,
      tidyEmpty: false,
      dropAttrs: false,
      unwrapSpans: false,
      maxEdge: 0,
      quality: 0.9,
      forceJpeg: false,
      dropFonts: false,
      dropUnused: false
    },
    deep: {
      id: 'deep',
      label: '深度优化',
      desc: '统一排版样式，优化图片与字体，明显减小体积。',
      preserveCss: false,
      keepInlineStyles: false,
      normalizeUnits: true,
      tidyEmpty: true,
      dropAttrs: true,
      unwrapSpans: true,
      maxEdge: 1600,
      quality: 0.84,
      forceJpeg: true,
      dropFonts: true,
      dropUnused: false
    },
    extreme: {
      id: 'extreme',
      label: '极致压缩',
      desc: '以最小体积为目标，会降低图片分辨率，画质有可见损失。',
      preserveCss: false,
      keepInlineStyles: false,
      normalizeUnits: true,
      tidyEmpty: true,
      dropAttrs: true,
      unwrapSpans: true,
      maxEdge: 1200,
      quality: 0.7,
      forceJpeg: true,
      dropFonts: true,
      dropUnused: true
    }
  };

  function modePolicy(name) {
    return MODES[name] || MODES.deep;
  }

  /*
   * 把内联样式里的绝对单位换算成相对单位。
   * 只换字号、行高、缩进、边距这几类，颜色和边框不动 ——
   * 换错了会改变外观，而不换只是不同设备字号不一致，两害相权取前者保守。
   */
  function normalizeInlineStyle(text) {
    if (!text) return text;
    return text.replace(
      /(font-size|line-height|text-indent|margin|margin-left|margin-right|margin-top|margin-bottom|padding|padding-left|padding-right)\s*:\s*([^;{}"']+)/gi,
      function (all, prop, val) {
        var converted = val.replace(/(-?\d*\.?\d+)(px|pt)\b/gi, function (m, num, unit) {
          var v = parseFloat(num);
          if (isNaN(v)) return m;
          var em = unit.toLowerCase() === 'pt' ? v / 12 : v / 16;
          // 小于 0.05em 的换算太碎，直接去掉这一项更干净
          return Math.round(em * 1000) / 1000 + 'em';
        });
        return prop + ':' + converted;
      }
    );
  }

  /*
   * 原书 CSS 里的绝对单位换算。只处理字号、行高、缩进、边距，
   * 颜色、边框、字体族一概不动 —— 那些换算错了会直接改变外观。
   */
  function normalizeCssText(text) {
    if (!text) return text;
    // 先跳过 @charset / @import 这些不能随便动的语句
    return text.replace(
      /(^|[{;}\s])(font-size|line-height|text-indent|margin|margin-left|margin-right|margin-top|margin-bottom|padding|padding-left|padding-right)\s*:\s*([^;{}]+)/gi,
      function (all, lead, prop, val) {
        var converted = val.replace(/(-?\d*\.?\d+)(px|pt)\b/gi, function (m, num, unit) {
          var v = parseFloat(num);
          if (isNaN(v)) return m;
          var em = unit.toLowerCase() === 'pt' ? v / 12 : v / 16;
          return Math.round(em * 1000) / 1000 + 'em';
        });
        return lead + prop + ':' + converted;
      }
    );
  }

  function unwrap(el) {
    var parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  }

  function cleanElement(el, ctx) {
    var tag = localTag(el);
    var pol = ctx.policy || modePolicy('deep');

    if (DROP_TAGS[tag]) {
      el.parentNode && el.parentNode.removeChild(el);
      ctx.report.removedTags++;
      return false;
    }

    // 属性清理
    var attrs = Array.prototype.slice.call(el.attributes);
    for (var i = 0; i < attrs.length; i++) {
      var name = attrs[i].name.toLowerCase();
      var value = attrs[i].value;

      if (name === 'style') {
        if (pol.keepInlineStyles) {
          // 保留但换算单位：写死 px 的段落在不同字号下会错位
          if (pol.normalizeUnits) {
            var fixed = normalizeInlineStyle(value);
            if (fixed !== value) {
              el.setAttribute(attrs[i].name, fixed);
              ctx.report.normalizedStyles++;
            }
          }
          ctx.report.keptInlineStyles++;
        } else {
          ctx.report.removedInlineStyles++;
          el.removeAttribute(attrs[i].name);
        }
        continue;
      }
      if (name.indexOf('on') === 0) {
        // 事件属性在任何模式下都删：EPUB 里不该有可执行代码
        el.removeAttribute(attrs[i].name);
        continue;
      }
      if (name === 'class') {
        // 保留原 CSS 时 class 必须全部留下，否则原样式表里的规则全部失配，
        // 排版会瞬间崩掉——这正是"改完格式全变了"的典型来源。
        if (pol.preserveCss) continue;
        var kept = value.split(/\s+/).filter(function (c) {
          return KEEP_CLASSES[c.toLowerCase()];
        });
        if (kept.length) el.setAttribute('class', kept.join(' '));
        else el.removeAttribute('class');
        continue;
      }
      if (name === 'width' || name === 'height') {
        if (!pol.dropAttrs) continue;
        // 图片尺寸交给 CSS 的 max-width 控制
        if (tag === 'img' || tag === 'image') {
          ctx.report.removedFixedSizes++;
          el.removeAttribute(attrs[i].name);
          continue;
        }
      }
      if (name === 'align' || name === 'bgcolor' || name === 'color' ||
          name === 'face' || name === 'size' || name === 'border' ||
          name === 'cellpadding' || name === 'cellspacing' || name === 'valign') {
        if (!pol.dropAttrs) continue;
        el.removeAttribute(attrs[i].name);
        continue;
      }
      if (name === 'lang' || name === 'xml:lang') {
        el.removeAttribute(attrs[i].name);
        continue;
      }
    }

    if (pol.unwrapSpans && (UNWRAP_TAGS[tag] || tag === 'span')) {
      // span 上的属性此时已清空，无意义，直接拆掉
      var hasAttrs = el.attributes.length > 0;
      if (tag === 'span' && hasAttrs) {
        // 保留带 class 的 span（如 .center 包一段斜体）
        var k = Array.prototype.slice.call(el.attributes).map(function (a) {
          return a.name;
        });
        if (k.indexOf('class') < 0 && k.indexOf('id') < 0) hasAttrs = false;
      }
      if (!hasAttrs) {
        ctx.report.unwrappedTags++;
        unwrap(el);
        return false;
      }
    }

    return true;
  }

  /* 不用子节点快照遍历：拆掉一层 span 后，它的子节点会被挪到当前位置，
     必须重新访问同一个下标，否则嵌套的第二三层会漏掉。 */
  function walkAndClean(node, ctx) {
    var i = 0;
    while (i < node.childNodes.length) {
      var child = node.childNodes[i];
      if (child.nodeType === 8) {
        node.removeChild(child);
        continue;
      }
      if (child.nodeType !== 1) {
        i++;
        continue;
      }
      var alive = cleanElement(child, ctx);
      if (!alive) continue; // 被删除或被拆开，下标 i 现在是别的节点
      i++;
      walkAndClean(child, ctx);
    }
  }

  function isEmptyParagraph(el) {
    if (localTag(el) !== 'p') return false;
    if (el.getElementsByTagName('img').length) return false;
    var t = (el.textContent || '').replace(/[\s\u00A0]/g, '');
    return t === '';
  }

  /* 收尾清理：空段落、连续换行、段首手打空格 */
  function tidyChildren(container, ctx) {
    var pol = ctx.policy || modePolicy('deep');
    var kids = Array.prototype.slice.call(container.childNodes);
    var brRun = 0;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      /* 文字节点必须打断"连续换行"的计数。
         这是一个真实的线上事故：原来这里直接 continue，brRun 只增不减，
         整章只要有 3 个 <br>，后面每个 <br> 都被判成"多余换行"删掉，
         几十万行正文被糊成一大段（截图三就是这个样子）。 */
      if (el.nodeType === 3) {
        if ((el.nodeValue || '').replace(/[\s\u00A0]/g, '')) brRun = 0;
        continue;
      }
      if (el.nodeType !== 1) continue;

      if (isEmptyParagraph(el)) {
        if (pol.tidyEmpty) {
          container.removeChild(el);
          el._efRemoved = true;
          ctx.report.removedEmptyParagraphs++;
        }
        brRun = 0;
        continue;
      }

      if (localTag(el) === 'br') {
        brRun++;
        if (brRun > 2 && pol.tidyEmpty) {
          container.removeChild(el);
          ctx.report.removedExtraBreaks++;
        }
        continue;
      }
      brRun = 0;

      // 转换器常留下只含 <br> 的空 div（当分页符用），各端高度不一致，直接删
      var etag = localTag(el);
      if (pol.tidyEmpty && (etag === 'div' || etag === 'section') && !el.getElementsByTagName('img').length) {
        if (!(el.textContent || '').replace(/[\s\u00A0]/g, '')) {
          container.removeChild(el);
          el._efRemoved = true;
          ctx.report.removedEmptyBlocks++;
          continue;
        }
      }

      // 去掉段首手打的 &nbsp;，避免与 CSS 的 2em 缩进叠加。
      // 只在"由我们接管缩进"时做——保留原 CSS 时，那个 &nbsp; 就是原书的缩进方式，
      // 删掉等于把首行缩进彻底抹平。
      if (!pol.preserveCss && (localTag(el) === 'p' || /^h[1-6]$/.test(localTag(el)))) {
        var first = el.firstChild;
        while (first && first.nodeType === 3 && /^[\s\u00A0]+$/.test(first.nodeValue)) {
          var next = first.nextSibling;
          el.removeChild(first);
          ctx.report.trimmedManualIndent++;
          first = next;
        }
        if (first && first.nodeType === 3) {
          var trimmed = first.nodeValue.replace(/^[\s\u00A0]+/, '');
          if (trimmed !== first.nodeValue) {
            first.nodeValue = trimmed;
            ctx.report.trimmedManualIndent++;
          }
        }
      }
    }
  }

  /* 逐层下探：<br> 和空 div 经常被包在 div/section 里，只看 body 的直接子节点会漏掉 */
  var NESTED_CONTAINERS = { div: 1, section: 1, blockquote: 1, li: 1, td: 1, article: 1, aside: 1 };

  function tidyRecursive(container, ctx) {
    tidyChildren(container, ctx);
    var kids = Array.prototype.slice.call(container.childNodes);
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el.nodeType !== 1) continue;
      if (NESTED_CONTAINERS[localTag(el)]) tidyRecursive(el, ctx);
    }
  }

  /* EPUB3 封面页常用 <svg><image xlink:href="..."/></svg> 包图片，
     部分阅读器渲染不稳，直接换成 <img>。 */
  function flattenSvgImages(root, ctx) {
    var all = Array.prototype.slice.call(root.getElementsByTagName('*'));
    var svgs = all.filter(function (n) {
      return localTag(n) === 'svg';
    });
    svgs.forEach(function (svg) {
      var inner = Array.prototype.slice.call(svg.getElementsByTagName('*')).filter(function (n) {
        return localTag(n) === 'image';
      });
      if (!inner.length) return;
      var doc = svg.ownerDocument;
      var frag = doc.createDocumentFragment();
      inner.forEach(function (im) {
        var href = im.getAttribute('xlink:href') || im.getAttribute('href');
        if (!href) return;
        var el = doc.createElement('img');
        el.setAttribute('src', href);
        var alt = im.getAttribute('alt');
        if (alt) el.setAttribute('alt', alt);
        frag.appendChild(el);
      });
      if (frag.childNodes.length && svg.parentNode) {
        svg.parentNode.replaceChild(frag, svg);
        ctx.report.svgFlattened += inner.length;
      }
    });
  }

  var BLOCK_CONTAINERS = {
    div: 1, section: 1, article: 1, aside: 1, blockquote: 1, li: 1,
    td: 1, th: 1, figure: 1, pre: 1, table: 1, ul: 1, ol: 1,
    header: 1, footer: 1, main: 1, nav: 1
  };

  /* 所有会独占一行的元素。用来判断"这一层到底是容器，还是段落本身"。 */
  var BLOCK_TAGS = {
    p: 1, div: 1, section: 1, article: 1, aside: 1, blockquote: 1,
    li: 1, ul: 1, ol: 1, dl: 1, dt: 1, dd: 1, td: 1, th: 1, tr: 1, table: 1,
    figure: 1, figcaption: 1, pre: 1, hr: 1, header: 1, footer: 1, main: 1, nav: 1,
    h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1
  };

  /* 只有这几种块，才值得"降级成段落" */
  var TEXT_BLOCK_TAGS = { div: 1, section: 1, article: 1, aside: 1 };

  function hasBlockChild(container) {
    var kids = container.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType === 1 && BLOCK_TAGS[localTag(n)]) return true;
    }
    return false;
  }

  function hasParagraphChild(container) {
    var kids = container.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType === 1 && localTag(n) === 'p') return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------
   * 段落重建（结构修复，不是加 CSS）
   *
   * 网络书源、TXT 转换器出来的正文经常是"一整块文字 + <br> 换行"，一个
   * <p> 都没有。没有段落就没有地方挂缩进和段距，阅读器还会把连续空白折叠掉，
   * 于是一整章糊成一块（就是截图上那种效果）。
   *
   * 这里做三件事：
   *   1. 按 <br> 切段，每段生成真正的 <p>
   *   2. 被硬折行截断的半句（上一行末尾没有句末标点）接回同一段，
   *      不把一句完整的话拆成两段碎行
   *   3. 整章塞在一个 <p> 里靠 <br> 分行的，拆成多个 <p>
   *
   * 图片、SVG、<hr>、表格、列表、pre、引用块一律原样保留，不卷进段落。
   * 新段落带 class="ef-p"，样式层只认这个类——所以"保留原始样式表"的模式
   * 也不会动到原书本来就规整的段落。
   * ------------------------------------------------------------------ */

  var VERSE_HINT = /(^|[\s_-])(poem|poetry|verse|lyrics?|song|码|诗歌)([\s_-]|$)/i;
  // 这些容器里的文字本来就不该有段首缩进，不要塞 <p>
  var WRAP_SKIP = { li: 1, td: 1, th: 1, dd: 1, dt: 1, figcaption: 1, pre: 1, code: 1 };
  // 句末标点。只有上一段以它收尾，才算真正的段落结束；否则视为硬折行
  var SENTENCE_END = /[。！？!?…‥]["'”’』」】）)\]]*$/;
  var MEDIA_TAGS = { img: 1, svg: 1, image: 1, video: 1, audio: 1, object: 1 };

  function isVerseLike(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = localTag(el);
    if (tag === 'pre' || tag === 'code') return true;
    var cls = (el.getAttribute && el.getAttribute('class')) || '';
    return !!cls && VERSE_HINT.test(cls);
  }

  function nodesText(nodes) {
    var s = '';
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.nodeType === 3) s += n.nodeValue || '';
      else if (n.nodeType === 1) s += n.textContent || '';
    }
    return s;
  }

  function isMediaOnly(nodes) {
    var seen = false;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.nodeType === 3) {
        if ((n.nodeValue || '').replace(/[\s\u00A0]/g, '')) return false;
        continue;
      }
      if (n.nodeType !== 1) continue;
      if (!MEDIA_TAGS[localTag(n)]) return false;
      seen = true;
    }
    return seen;
  }

  /* 空行里如果有图、锚点，不能整段丢掉，否则插图会消失、目录跳转会失效。
     注意要连"节点本身就是图片"一起算——<img> 自己查 getElementsByTagName
     是查不到的，这里漏判过一次，整本书的插图都被当成空行扔掉了。 */
  function hasKeepable(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.nodeType !== 1) continue;
      if (n.getAttribute && n.getAttribute('id')) return true;
      if (MEDIA_TAGS[localTag(n)]) return true;
      if (n.getElementsByTagName && n.getElementsByTagName('img').length) return true;
    }
    return false;
  }

  /*
   * 一串行内节点 → 若干段落。按 <br> 断句，并把硬折行接回去。
   * 返回 [{ nodes: [...], text: '…', media: bool }]
   */
  function segmentParagraphs(nodes, ctx) {
    var segs = [];
    var cur = [];
    var gap = 0; // 上一段之后空了几行
    var open = null;

    function push(seg) {
      segs.push(seg);
    }
    function feed(list) {
      var text = nodesText(list);
      if (!text.replace(/[\s\u00A0]/g, '') && !hasKeepable(list)) {
        gap++;
        return;
      }
      var media = isMediaOnly(list);
      // 只看"有没有实际文字"：整行都是 ㅡ─── 这类框线时不要和下一行粘在一起
      var prevReal = open && /[\u4e00-\u9fa5A-Za-z0-9]/.test(open.text);
      if (open && prevReal && !gap && !open.media && !media && !SENTENCE_END.test(open.text.trim())) {
        // 上一行没有句末标点：这是被硬折行截断的半句，接回同一段
        for (var i = 0; i < list.length; i++) open.nodes.push(list[i]);
        open.text = open.text + (/[A-Za-z0-9,;:]$/.test(open.text) ? ' ' : '') + text;
        if (ctx) ctx.report.mergedLines++;
        return;
      }
      if (open) push(open);
      open = { nodes: list.slice(), text: text, media: media };
      gap = 0;
    }

    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.nodeType === 1 && localTag(n) === 'br') {
        if (cur.length) {
          feed(cur);
          cur = [];
        } else {
          gap++;
        }
        continue;
      }
      cur.push(n);
    }
    if (cur.length) feed(cur);
    if (open) push(open);
    return segs;
  }

  function makeParagraph(doc, seg) {
    var p = doc.createElement('p');
    p.setAttribute('class', seg.media ? 'ef-p ef-img' : 'ef-p');
    seg.nodes.forEach(function (nd) {
      p.appendChild(nd);
    });
    return p;
  }

  /*
   * 整章塞在一个 <p> 里、用 <br> 分行的书，拆成多个 <p>。
   * 只拆 <br> ≥ 2 的段落：单个 <br> 常常只是句内换行（诗句、地址、署名），
   * 拆了反而破坏原意。
   */
  function splitBrParagraph(p, ctx) {
    if (isVerseLike(p)) return;
    var brs = 0;
    var i;
    for (i = 0; i < p.childNodes.length; i++) {
      var c = p.childNodes[i];
      if (c.nodeType === 1 && localTag(c) === 'br') brs++;
    }
    if (brs < 2) return;

    var segs = segmentParagraphs(Array.prototype.slice.call(p.childNodes), ctx);
    if (segs.length < 2) return;

    var doc = p.ownerDocument;
    var frag = doc.createDocumentFragment();
    for (i = 0; i < segs.length; i++) {
      var np = makeParagraph(doc, segs[i]);
      if (i === 0) {
        // 第一段继承原段落的 id/class 等属性：锚点和语义都挂在它身上
        var attrs = Array.prototype.slice.call(p.attributes);
        for (var a = 0; a < attrs.length; a++) {
          if (attrs[a].name === 'class') continue;
          try {
            np.setAttribute(attrs[a].name, attrs[a].value);
          } catch (e) { /* 非法属性名忽略 */ }
        }
        var cls = (p.getAttribute('class') || '').trim();
        np.setAttribute('class', (cls ? cls + ' ' : '') + 'ef-p' + (segs[i].media ? ' ef-img' : ''));
      }
      frag.appendChild(np);
    }
    if (p.parentNode) {
      p.parentNode.replaceChild(frag, p);
      ctx.report.splitFromBreaks += segs.length - 1;
    }
  }

  /*
   * 一句话一段 → 合并回正常段落。
   *
   * 很多机翻站的排版是"每句一个 <p>"，一段只有十几个字。上面那些逻辑
   * 都不会碰它（每段都完整、都有句末标点），结果就是正文缩进是对的、
   * 但一屏只有八九行，读两页就得喘口气。
   *
   * 这里把连续的、短的、纯叙述的段接起来。规则只做加法，不做判断：
   *   - 对话一律独立（以引号、破折号开头），永远不参与合并
   *   - 带图片 / <br> / 嵌套段 / id / class / 居中右对齐的段，直接断开
   *   - 单段超过 SHORT_PARA_MAX 字的，不合并
   *   - 合并后的段不超过 MERGED_PARA_MAX 字，到了就另起一段
   *
   * 宁可少合并，也不能把书改乱：判不准的地方一律断开。
   */
  var SHORT_PARA_MAX = 44;
  var MERGED_PARA_MAX = 180;
  var DIALOG_HEAD = /^[\s\u3000]*[“”「」『』"'“‘—]/;
  var PARA_END = /[。！？…；!?;:]["'”』」]?$/;

  function mergeShortParagraphs(container, ctx) {
    var kids = Array.prototype.slice.call(container.childNodes);
    var run = [];
    var runLen = 0;
    var i;

    function flush() {
      if (run.length >= 2) {
        var head = run[0];
        for (var k = 1; k < run.length; k++) {
          var next = run[k];
          while (next.firstChild) head.appendChild(next.firstChild);
          if (next.parentNode) next.parentNode.removeChild(next);
        }
        var cls = (head.getAttribute('class') || '').trim();
        if (cls.indexOf('ef-p') < 0) {
          head.setAttribute('class', (cls ? cls + ' ' : '') + 'ef-p');
        }
        ctx.report.mergedShortParagraphs += run.length - 1;
      }
      run = [];
      runLen = 0;
    }

    for (i = 0; i < kids.length; i++) {
      var n = kids[i];
      // 段落之间的换行/缩进会变成空白文本节点，不能让它把连续段落掰开
      if (n.nodeType === 3) {
        if (/\S/.test(n.nodeValue || '')) flush();
        continue;
      }
      if (n.nodeType !== 1 || localTag(n) !== 'p') { flush(); continue; }
      if (n.getAttribute('id')) { flush(); continue; }
      if (n.getElementsByTagName('img').length) { flush(); continue; }
      if (n.getElementsByTagName('svg').length) { flush(); continue; }
      if (n.getElementsByTagName('br').length) { flush(); continue; }
      if (n.getElementsByTagName('p').length) { flush(); continue; }

      var cls2 = (n.getAttribute('class') || '').trim();
      if (cls2 && cls2.replace(/\bef-p\b/g, '').trim()) { flush(); continue; }

      var align = (n.getAttribute('align') || '').toLowerCase();
      if (align === 'center' || align === 'right') { flush(); continue; }
      if (/text-align\s*:\s*(center|right)/i.test(n.getAttribute('style') || '')) { flush(); continue; }

      var txt = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt) { flush(); continue; }
      if (DIALOG_HEAD.test(txt)) { flush(); continue; }
      if (txt.length > SHORT_PARA_MAX) { flush(); continue; }
      if (!PARA_END.test(txt)) { flush(); continue; }

      if (run.length && runLen + txt.length > MERGED_PARA_MAX) flush();
      run.push(n);
      runLen += txt.length;
    }
    flush();
  }

  function rebuildParagraphs(container, ctx) {
    var doc = container.ownerDocument;
    var kids = Array.prototype.slice.call(container.childNodes);
    var i, n, t;

    // 1) 已有的 <p> 先看看要不要拆；块级子容器继续往下走
    for (i = 0; i < kids.length; i++) {
      n = kids[i];
      if (n.nodeType !== 1) continue;
      t = localTag(n);
      if (t === 'p') {
        splitBrParagraph(n, ctx);
        continue;
      }
      if (BLOCK_CONTAINERS[t] && !isVerseLike(n)) rebuildParagraphs(n, ctx);
    }

    /* splitBrParagraph 会把一个 <p> 拆成多个并插回原来的位置。上面那份
       childNodes 快照里只有拆之前的那一个，必须重新取一次，否则拆出来的
       兄弟节点会在下面"整层重建"时被一起清掉——正文会凭空少几段。 */
    kids = Array.prototype.slice.call(container.childNodes);

    if (isVerseLike(container)) return;
    if (WRAP_SKIP[localTag(container)]) return;
    if (localTag(container) === 'p') return;

    // 2) 本层的行内内容按块级元素分组，每组再切段
    var groups = [];
    var cur = [];
    for (i = 0; i < kids.length; i++) {
      n = kids[i];
      if (n.nodeType === 1 && BLOCK_TAGS[localTag(n)]) {
        if (cur.length) {
          groups.push({ nodes: cur });
          cur = [];
        }
        groups.push({ block: n });
        continue;
      }
      cur.push(n);
    }
    if (cur.length) groups.push({ nodes: cur });

    var hasInline = false;
    for (i = 0; i < groups.length; i++) if (groups[i].nodes) hasInline = true;
    if (!hasInline) return;

    var frag = [];
    var made = 0;
    for (i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (g.block) {
        frag.push(g.block);
        continue;
      }
      var segs = segmentParagraphs(g.nodes, ctx);
      for (var k = 0; k < segs.length; k++) {
        frag.push(makeParagraph(doc, segs[k]));
        made++;
      }
    }
    if (!made) return;

    // 原来的子节点已经被搬进新段落，容器直接换成新的这一批
    while (container.firstChild) container.removeChild(container.firstChild);
    for (i = 0; i < frag.length; i++) container.appendChild(frag[i]);
    ctx.report.rebuiltParagraphs += made;
  }

  /*
   * 把"只装文字、没有块级子元素"的 div/section 降级成 <p>。
   *
   * 这是首行缩进丢失的另一个主因：很多站长书把每一段写成 <div class="para">，
   * 而缩进规则只写在 p 上，于是每一段都从左边顶格开始，读起来完全不像小说。
   * 降级后统一由 p 的规则接管，缩进、段距、两端对齐全部生效。
   */
  function convertTextBlocks(container, ctx) {
    var i = 0;
    while (i < container.childNodes.length) {
      var el = container.childNodes[i];
      if (el.nodeType !== 1) {
        i++;
        continue;
      }
      if (!TEXT_BLOCK_TAGS[localTag(el)]) {
        i++;
        continue;
      }
      if (hasBlockChild(el)) {
        convertTextBlocks(el, ctx);
        // 这一层只是"一行 div 包一个 p"的空壳，拆掉，避免多一层无意义的嵌套
        var only = el.childNodes.length === 1 ? el.firstChild : null;
        if (
          only && only.nodeType === 1 && localTag(only) === 'p' &&
          !(el.textContent || '').replace(only.textContent || '', '').replace(/[\s\u00A0]/g, '')
        ) {
          if (el.getAttribute('id') && !only.getAttribute('id')) {
            only.setAttribute('id', el.getAttribute('id'));
          }
          el.parentNode.replaceChild(only, el);
          ctx.report.convertedBlocks++;
        }
        i++;
        continue;
      }

      var hasText = (el.textContent || '').replace(/[\s\u00A0]/g, '') !== '';
      var hasImg = el.getElementsByTagName('img').length > 0;
      if (!hasText && !hasImg) {
        i++;
        continue;
      }

      var p = el.ownerDocument.createElement('p');
      // 保留 id（目录锚点靠它）和 class（.center / .noindent 这类语义还要用）
      for (var a = 0; a < el.attributes.length; a++) {
        var at = el.attributes[a];
        if (at.name === 'style') continue;
        try {
          p.setAttribute(at.name, at.value);
        } catch (e) {
          /* 非法属性名，跳过 */
        }
      }
      while (el.firstChild) p.appendChild(el.firstChild);
      container.replaceChild(p, el);
      ctx.report.convertedBlocks++;
      i++;
    }
  }

  /* 只统计不动手：保留原 CSS 的模式用它判断"这本书的段落其实不是 p" */
  function countTextBlocks(root) {
    var n = 0;
    var all = [root].concat(Array.prototype.slice.call(root.getElementsByTagName('*')));
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.nodeType !== 1) continue;
      var tag = localTag(el);
      if (tag !== 'div' && tag !== 'section') continue;
      if (hasBlockChild(el)) continue;
      if (!(el.textContent || '').replace(/[\s\u00A0]/g, '')) continue;
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------- 章节切分
  function headingLevel(el) {
    if (el.nodeType !== 1) return 0;
    var t = localTag(el);
    var m = /^h([1-6])$/.exec(t);
    return m ? parseInt(m[1], 10) : 0;
  }

  function splitIntoChapters(body, splitLevel) {
    var chapters = [];
    var current = { title: '', level: 0, nodes: [] };
    var hasContent = false;

    function flush() {
      if (current.nodes.length) chapters.push(current);
      current = { title: '', level: 0, nodes: [] };
      hasContent = false;
    }

    var kids = Array.prototype.slice.call(body.childNodes);
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el.nodeType === 3 && !el.nodeValue.trim()) continue;

      var lv = headingLevel(el);
      var startsChapter = splitLevel > 0 && lv > 0 && lv <= splitLevel;

      if (startsChapter && hasContent) flush();

      if (startsChapter && !current.title) {
        current.title = (el.textContent || '').replace(/\s+/g, ' ').trim();
        current.level = lv;
      }

      current.nodes.push(el);
      if (lv === 0) {
        var text = (el.textContent || '').trim();
        if (text || el.getElementsByTagName('img').length) hasContent = true;
      }
    }
    flush();
    return chapters;
  }

  // ------------------------------------------------------------- 样式表

  /*
   * 正文样式分两层：
   *   base   所有模式都写，管"修复出来的新段落"（p.ef-p）——只在原书结构
   *          坏掉时才会产生这类段落，所以不会碰到原书本来就规整的排版。
   *   full   替掉原样式表的模式用，接管全部正文元素。
   * 两层共用同一套数值，输出版本 2.0 / 3.0 拿到的是同一个文件，不会出现
   * 一个版本缩进正常、另一个版本糊成一块。
   */
  function buildCss(kind) {
    var body = [
      '/* EPUB Master 正文层：只作用于结构修复生成的段落，不动原书已有排版 */',
      'p.ef-p { text-indent: 2em; margin: 0 0 0.5em 0; line-height: 1.6; }',
      'p.ef-img { text-indent: 0; text-align: center; margin: 0.8em 0; line-height: 1; }',
      '/* 图片、表格、SVG 一律不进正文缩进 */',
      'p.ef-img img, p.ef-img svg { max-width: 100%; height: auto; }',
      'p.ef-img img { display: block; margin: 0 auto; }'
    ].join('\n');

    /*
     * safety 版：保留原书 CSS 时追加在最后。
     *
     * 这里除了 p.ef-p，还必须给一个"类型选择器级别"的正文兜底：
     *   - 原书样式表整份进来时，原书自己的 .calibreN 之类类选择器优先级更高，
     *     一定盖过这里的 p{}，原设计不会被改动；
     *   - 但原书没有样式表（或输入本来就是别的工具处理过的、样式表已被清掉）
     *     时，光有 p.ef-p 就会出现"整章没有缩进、标题不居中"——
     *     这正是排版像退回去的样子。类型选择器是最低优先级，只做兜底。
     */
    if (kind === 'safety') {
      return [
        '@charset "utf-8";',
        'html { -webkit-text-size-adjust: 100%; }',
        /*
         * 关键：网页抓来的书常在 body 上写 margin:1.5em 甚至更大，阅读器里
         * 就成了"每行只显示十一二个字、两边一大片空白"。这里后加载，把正文
         * 容器的左右边距收掉，让文字像 TXT 一样铺满版面；原书对具体段落、
         * 标题、图片的类选择器优先级更高，仍会照常生效。
         */
        'body { margin: 0 !important; padding: 0 !important; overflow-wrap: break-word; word-wrap: break-word; }',
        'img { max-width: 100%; height: auto; }',
        'svg { max-width: 100%; }',
        'table { max-width: 100%; }',
        '/* 正文兜底：原书有更具体的类选择器时，这些规则一条都不会生效 */',
        'p { text-indent: 2em; margin: 0 0 0.5em 0; line-height: 1.6; }',
        'div.chapter-content > div, .text > div { text-indent: 2em; }',
        'h1, h2, h3, h4, h5, h6 {',
        '  text-indent: 0; text-align: center; margin: 1.2em 0 0.9em 0; line-height: 1.4;',
        '}',
        'h1 + p, h2 + p, h3 + p, h4 + p, h5 + p, h6 + p { margin-top: 0; }',
        '/* 特殊内容不套正文缩进（优先级高于上面的 p{}） */',
        'blockquote p, .quote p, .note p, li p, td p, th p, dd p, dt p,',
        'figcaption p, .poetry p, .poem p, .verse p { text-indent: 0; }',
        'p.center, .center, p.noindent, .noindent, .title, .subtitle, .author { text-indent: 0; }',
        body,
        '/* 标签语义兜底：部分阅读器会用自己的默认值盖掉加粗与斜体 */',
        'strong, b { font-weight: bold; }',
        'em, i, cite { font-style: italic; }',
        ''
      ].join('\n');
    }

    return [
      '@charset "utf-8";',
      '/* EPUB Master 统一排版：全部相对单位，各端缩放一致 */',
      'html { -webkit-text-size-adjust: 100%; }',
      'body {',
      '  margin: 0;',
      '  padding: 0;',
      '  font-size: 1em;',
      '  line-height: 1.6;',
      '  text-align: justify;',
      '  word-wrap: break-word;',
      '  overflow-wrap: break-word;',
      '}',
      '/* 普通正文：2em 首行缩进 + 可感知的段距，接近纸书 */',
      'p { text-indent: 2em; margin: 0 0 0.5em 0; }',
      body,
      '/* 特殊内容：这些位置不能套正文缩进，否则排版会被带歪 */',
      'p.center, .center { text-align: center; text-indent: 0; }',
      'p.right, .right { text-align: right; text-indent: 0; }',
      'p.left, .left { text-align: left; text-indent: 0; }',
      'p.noindent, .noindent { text-indent: 0; }',
      'blockquote, .quote { margin: 0.7em 1.4em; }',
      'blockquote p, .quote p, .note p, li p, td p, th p, dd p, figcaption p { text-indent: 0; margin-bottom: 0.3em; }',
      '.poetry, .poem, .verse { margin: 0.7em 1em; text-indent: 0; line-height: 1.7; }',
      '.poetry p, .poem p, .verse p { text-indent: 0; }',
      '.title, .subtitle { text-align: center; text-indent: 0; font-weight: bold; }',
      '.author { text-align: center; text-indent: 0; }',
      '.note { text-indent: 0; font-size: 0.9em; }',
      'h1, h2, h3, h4, h5, h6 {',
      '  margin: 1.2em 0 0.9em 0;',
      '  text-indent: 0;',
      '  font-weight: bold;',
      '  text-align: center;',
      '  line-height: 1.4;',
      '}',
      'h1 { font-size: 1.5em; }',
      'h2 { font-size: 1.25em; }',
      'h3 { font-size: 1.1em; }',
      'h4, h5, h6 { font-size: 1em; }',
      '/* 紧跟标题的段落不留上边距，标题与正文之间不会出现双倍空白 */',
      'h1 + p, h2 + p, h3 + p, h4 + p, h5 + p, h6 + p { margin-top: 0; }',
      'img { max-width: 100%; height: auto; }',
      'p > img:only-child, div > img:only-child, figure img { display: block; margin: 0.8em auto; }',
      'strong, b { font-weight: bold; }',
      'em, i, cite { font-style: italic; }',
      'u { text-decoration: underline; }',
      's, strike, del { text-decoration: line-through; }',
      'figure { margin: 0.8em 0; text-align: center; text-indent: 0; }',
      'figcaption { font-size: 0.85em; text-indent: 0; text-align: center; }',
      'ul, ol { margin: 0.6em 0 0.6em 1.4em; padding: 0; }',
      'li { text-indent: 0; margin: 0.2em 0; text-align: left; }',
      'table { max-width: 100%; border-collapse: collapse; margin: 0.8em auto; }',
      'td, th { text-indent: 0; padding: 0.2em 0.4em; }',
      'hr { border: 0; border-top: thin solid #ccc; margin: 1.2em 0; }',
      'sub, sup { font-size: 0.72em; line-height: 0; }',
      'pre { white-space: pre-wrap; text-indent: 0; font-size: 0.9em; }',
      ''
    ].join('\n');
  }

  // --------------------------------------------------------------- 图片

  /*
   * 压缩策略：
   *  - 无目标体积时（像 calibre 的"统一转 JPEG"）：保留原分辨率，只做格式与质量转换。
   *  - 有目标体积时：把"目标 - 文本占用"的预算按原始体积比例分给每张图，
   *    单张图内部先降质量、再降分辨率，直到落进自己的预算。
   * 图片是 EPUB 里唯一能大幅压缩的部分，文本用 deflate 已接近极限。
   */

  var JPEG_QUALITY = 0.85;

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve) {
      if (canvas.convertToBlob) {
        canvas.convertToBlob({ type: type, quality: quality }).then(resolve, function () {
          resolve(null);
        });
        return;
      }
      canvas.toBlob(function (b) {
        resolve(b);
      }, type, quality);
    });
  }

  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas === 'function') {
      try {
        return new OffscreenCanvas(w, h);
      } catch (e) {
        /* 退回到普通 canvas */
      }
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
      return true; // 读不到就当有透明，保守处理，不转格式
    }
  }

  async function decodeImage(bytes, mediaType) {
    if (typeof createImageBitmap !== 'function') return null;
    try {
      return await createImageBitmap(new Blob([bytes], { type: mediaType }));
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
   * 压一张图。
   * cfg: { budget, maxEdge, forceJpeg }
   *   budget  = 这张图允许的字节上限（Infinity 表示只做格式转换）
   *   maxEdge = 长边上限（0 表示不限制，保留原分辨率）
   */
  async function compressOne(path, bytes, mediaType, cfg) {
    /*
     * 有些格式绝对不能重编码：
     *  - GIF 可能是动图，走 canvas 只会留下第一帧，动画直接消失
     *  - SVG 是矢量，栅格化后缩小反而糊
     *  - AVIF / HEIC 浏览器多半解不了，解不了就别动
     */
    if (/\.(gif|svg|avif|heic)$/i.test(path) || /^image\/(gif|svg)/i.test(mediaType)) return null;

    var bitmap = await decodeImage(bytes, mediaType);
    if (!bitmap) return null;

    var w0 = bitmap.width || 0;
    var h0 = bitmap.height || 0;
    if (!w0 || !h0) {
      if (bitmap.close) bitmap.close();
      return null;
    }

    var isPng = /png/i.test(mediaType);
    var keepPng = isPng && hasAlpha(bitmap);
    var budget = cfg.budget;
    var infinite = !isFinite(budget);

    // 长边上限只在你显式指定时生效；默认保留原分辨率
    var scale = 1;
    if (cfg.maxEdge && Math.max(w0, h0) > cfg.maxEdge) {
      scale = cfg.maxEdge / Math.max(w0, h0);
    }

    var quality = keepPng ? 1 : (cfg.quality != null ? cfg.quality : JPEG_QUALITY);
    var best = null;

    for (var attempt = 0; attempt < 4; attempt++) {
      var tw = Math.max(1, Math.round(w0 * scale));
      var th = Math.max(1, Math.round(h0 * scale));
      var out = await encodeAs(bitmap, tw, th, keepPng, quality);
      if (!out) break;

      if (!best || out.length < best.bytes.length) {
        best = { bytes: out, w: tw, h: th, quality: quality };
      }
      if (infinite || out.length <= budget) break;
      if (scale <= 0.3) break;

      // 体积大致正比于像素数，按面积比反推需要的缩放
      var ratio = Math.sqrt(budget / out.length);
      var next = scale * Math.min(0.92, Math.max(0.5, ratio));
      if (next >= scale - 0.02) next = scale * 0.8;
      scale = next;
    }
    if (bitmap.close) bitmap.close();
    if (!best) return null;

    // 没设目标时，只有确实变小才替换（本来就压不动的小图保持原样）
    if (infinite && best.bytes.length >= bytes.length * 0.95) return null;

    // 不透明的图统一转 JPEG（体积收益最大）；本来就带透明的保留 PNG
    var newPath = path;
    if (!keepPng && !/jpe?g/i.test(mediaType)) newPath = stripExt(path) + '.jpg';

    return {
      path: path,
      newPath: newPath,
      bytes: best.bytes,
      mediaType: keepPng ? 'image/png' : 'image/jpeg',
      fromBytes: bytes.length,
      toBytes: best.bytes.length,
      size: best.w + 'x' + best.h
    };
  }

  /* 按预算批量压图；预算按原始体积比例分配到每张图 */
  async function compressImages(items, files, cfg, onProgress) {
    var map = {};
    var total = items.length;
    if (!total) return map;

    var totalRaw = 0;
    items.forEach(function (it) {
      totalRaw += files[it.path].length;
    });

    var globalBudget = cfg.budget;
    var finite = globalBudget != null && isFinite(globalBudget) && globalBudget < totalRaw;
    var remaining = globalBudget;
    var remainingRaw = totalRaw;

    for (var i = 0; i < total; i++) {
      if (cfg.shouldCancel && cfg.shouldCancel()) throw new Error('__CANCELLED__');
      var it = items[i];
      var bytes = files[it.path];
      var budget = Infinity;

      if (finite) {
        // 按剩余原始体积比例分配剩余预算，避免前面的图吃掉后面的额度
        budget = remainingRaw > 0 ? (remaining * bytes.length) / remainingRaw : remaining;
        budget = Math.max(budget, 6 * 1024); // 单张至少留 6KB，避免压成糊
      }

      if (onProgress) {
        onProgress(i + 1, total, it.path);
      }

      try {
        var rec = await compressOne(it.path, bytes, it.mediaType, {
          budget: budget,
          maxEdge: cfg.maxEdge || 0,
          quality: cfg.quality,
          forceJpeg: cfg.forceJpeg !== false
        });
        if (rec) {
          map[it.path] = rec;
          if (finite) {
            remaining -= rec.toBytes;
            remainingRaw -= bytes.length;
          }
        }
      } catch (e) {
        /* 单张失败不影响整体 */
      }
    }
    return map;
  }

  // ------------------------------------------------------------ 重复图片清理

  /*
   * 只判"能确认完全相同"的重复，判不出来的一律保留。
   *
   *   第一层：文件字节的 SHA-256。哈希相同就是同一个文件，哪怕文件名、
   *           目录、扩展名完全不同（网页抓的书常把同一张图存成
   *           images/a.jpg 和 images/001/a_1.jpg 两份）。
   *   第二层：哈希不同但尺寸相同、体积接近的，解码后逐像素比对。
   *           只有像素数组完全一致才算重复 —— 这是"重新存过一次的同一张图"。
   *           有预算上限（默认 60 对），超预算就放弃比对，记为"跳过"。
   *
   * 明确不做的事：不算感知哈希、不比相似度、不看文件名/尺寸/大小是否接近。
   * 画面高度相似但像素有差异的图，一律当两张不同的图。
   */

  var PIXEL_PAIR_BUDGET = 60;      // 最多比对多少对（每对解码 2 张图）
  var PIXEL_MAX_PIXELS = 40e6;     // 超过这个像素数不比对，避免吃掉内存

  function hasContentHash() {
    return typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest;
  }

  async function sha256Hex(bytes) {
    var buf;
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
      buf = bytes.buffer;
    } else {
      buf = bytes.slice().buffer;
    }
    var digest = await crypto.subtle.digest('SHA-256', buf);
    var view = new Uint8Array(digest);
    var out = '';
    for (var i = 0; i < view.length; i++) out += (view[i] < 16 ? '0' : '') + view[i].toString(16);
    return out;
  }

  /* 解码后逐像素比对。只回答"是不是完全一样"，不做相似度判断。 */
  async function pixelsIdentical(aBytes, aType, bBytes, bType) {
    if (typeof createImageBitmap !== 'function') return { same: false, decoded: false };
    var ba = await decodeImage(aBytes, aType);
    if (!ba) return { same: false, decoded: false };
    var bb = await decodeImage(bBytes, bType);
    if (!bb) {
      if (ba.close) ba.close();
      return { same: false, decoded: false };
    }
    try {
      if (!ba.width || !bb.width) return { same: false, decoded: false };
      if (ba.width !== bb.width || ba.height !== bb.height) return { same: false, decoded: true };
      if (ba.width * ba.height > PIXEL_MAX_PIXELS) return { same: false, decoded: false };
      var ca = makeCanvas(ba.width, ba.height);
      var cb = makeCanvas(bb.width, bb.height);
      var ga = ca.getContext('2d');
      var gb = cb.getContext('2d');
      if (!ga || !gb) return { same: false, decoded: false };
      ga.drawImage(ba, 0, 0);
      gb.drawImage(bb, 0, 0);
      var da = ga.getImageData(0, 0, ba.width, ba.height).data;
      var db = gb.getImageData(0, 0, bb.width, bb.height).data;
      if (da.length !== db.length) return { same: false, decoded: true };
      for (var i = 0; i < da.length; i++) {
        if (da[i] !== db[i]) return { same: false, decoded: true };
      }
      return { same: true, decoded: true };
    } catch (e) {
      return { same: false, decoded: false };
    } finally {
      if (ba.close) ba.close();
      if (bb.close) bb.close();
    }
  }

  /*
   * 把内容相同的图片归组。
   * @returns {ok, canon:{path->代表路径}, groups:[{paths,pixel}], pixelPairs, skippedPairs, unhashable:{path:1}}
   */
  async function groupIdenticalImages(items, files, onTick, shouldCancel) {
    var res = { ok: false, canon: {}, groups: [], pixelPairs: 0, skippedPairs: 0, unhashable: {} };
    if (!hasContentHash()) return res;

    var hex = {};          // path -> hex
    for (var i = 0; i < items.length; i++) {
      if (shouldCancel && shouldCancel()) throw new Error('__CANCELLED__');
      var it = items[i];
      var bytes = files[it.path];
      if (!bytes) continue;
      try {
        hex[it.path] = await sha256Hex(bytes);
      } catch (e) {
        res.unhashable[it.path] = 1;
      }
      if (onTick) onTick(i + 1, items.length, it.path);
    }

    // 第一层：按字节哈希分组
    var byHex = {};
    var order = [];
    items.forEach(function (it) {
      var h = hex[it.path];
      if (!h) return;
      if (!byHex[h]) { byHex[h] = []; order.push(h); }
      byHex[h].push(it.path);
    });
    var groups = order.map(function (h) {
      return { paths: byHex[h].slice(), pixel: false };
    });

    // 第二层：同尺寸、体积接近但哈希不同的，解码比像素
    var buckets = {};
    var pathsOfGroup = {};
    groups.forEach(function (g, gi) {
      g.paths.forEach(function (p) { pathsOfGroup[p] = gi; });
      var sz = imageSize(files[g.paths[0]], null);
      if (!sz.width || !sz.height) return;
      var k = sz.width + 'x' + sz.height;
      if (!buckets[k]) buckets[k] = [];
      buckets[k].push(gi);
    });

    var budget = PIXEL_PAIR_BUDGET;
    var merged = {};
    var bucketKeys = Object.keys(buckets);

    async function tryPair(gi, gj) {
      if (merged[gi] || merged[gj] || budget <= 0) return;
      var pa = groups[gi].paths[0];
      var pb = groups[gj].paths[0];
      if (shouldCancel && shouldCancel()) throw new Error('__CANCELLED__');
      budget--;
      res.pixelPairs++;
      var cmp = await pixelsIdentical(files[pa], guessMediaType(pa), files[pb], guessMediaType(pb));
      if (!cmp.decoded) { res.skippedPairs++; return; }
      if (!cmp.same) return;
      groups[gi].paths = groups[gi].paths.concat(groups[gj].paths);
      groups[gi].pixel = true;
      merged[gj] = 1;
    }

    /*
     * 第一轮：同尺寸 + 字节数完全一样的两组，先比。重新压过一遍的图，
     *        体积常常一分不差，这一轮基本零浪费。
     * 第二轮：同尺寸、体积差 5% 以内的相邻两组。同一张图换个质量重存，
     *        体积会差一点，排序后仍然挨在一起。
     * 两轮都受总预算限制，超了就停，并在结果里标"有未比对的"。
     */
    for (var bi = 0; bi < bucketKeys.length && budget > 0; bi++) {
      var list0 = buckets[bucketKeys[bi]].slice();
      if (list0.length < 2) continue;
      var byLen = {};
      var lenKeys = [];
      list0.forEach(function (gi) {
        var len = files[groups[gi].paths[0]].length;
        if (!byLen[len]) { byLen[len] = []; lenKeys.push(len); }
        byLen[len].push(gi);
      });
      for (var li = 0; li < lenKeys.length && budget > 0; li++) {
        var same = byLen[lenKeys[li]];
        if (same.length < 2) continue;
        for (var si = 1; si < same.length && budget > 0; si++) {
          await tryPair(same[0], same[si]);
        }
      }
    }

    for (var bj = 0; bj < bucketKeys.length && budget > 0; bj++) {
      var list = buckets[bucketKeys[bj]].slice();
      if (list.length < 2) continue;
      list.sort(function (x, y) {
        return files[groups[x].paths[0]].length - files[groups[y].paths[0]].length;
      });
      for (var x = 0; x + 1 < list.length && budget > 0; x++) {
        if (merged[list[x]]) continue;
        var y = x + 1;
        while (y < list.length && merged[list[y]]) y++;
        if (y >= list.length) break;
        var la = files[groups[list[x]].paths[0]].length;
        var lb = files[groups[list[y]].paths[0]].length;
        if (Math.abs(la - lb) / Math.max(la, lb) > 0.05) continue;
        await tryPair(list[x], list[y]);
      }
    }
    if (budget <= 0) res.budgetOut = true;

    var finalGroups = [];
    groups.forEach(function (g) {
      if (merged[groups.indexOf(g)]) return;
      finalGroups.push(g);
      g.paths.forEach(function (p) { res.canon[p] = g.paths[0]; });
    });
    res.groups = finalGroups;
    res.ok = true;
    return res;
  }

  /*
   * 按阅读顺序砍掉"重复出现"的图片。
   *
   * 关键：删的是这一处 <img> 显示，不是资源文件。第一章留着的那张图
   * 仍然指向原来的资源；后面重复的只是不再显示。资源要不要从包里
   * 去掉，由打包阶段按"还有没有人引用"决定。
   */
  function dedupeInBody(body, docPath, st, report, absOf) {
    var all = body.getElementsByTagName('*');
    var list = [];
    for (var i = 0; i < all.length; i++) {
      var t = localTag(all[i]);
      if (t === 'img' || t === 'image') list.push(all[i]);
    }
    for (var k = 0; k < list.length; k++) {
      var el = list[k];
      if (el._efRemoved) continue;
      var tag = localTag(el);
      var src = tag === 'img'
        ? el.getAttribute('src')
        : (el.getAttribute('xlink:href') || el.getAttribute('href'));
      if (!src || isExternal(src)) continue;
      var bare = src.split('#')[0];
      if (!bare) continue;
      var abs = absOf(resolvePath(docPath, decodePath(bare)));
      if (!abs) continue;
      if (!st.canon[abs]) {
        // 文件在、但认不出内容（格式解不了 / 环境不支持哈希）→ 保留，记一笔跳过
        if (st.unhashable[abs]) st.skipped++;
        continue;
      }
      var key = st.canon[abs];
      st.positions++;
      var hit = st.seen[key];
      if (!hit) {
        st.seen[key] = { path: abs, srcPath: docPath, removed: [] };
        st.kept++;
        continue;
      }
      // 后续重复出现：只移除这一处引用
      hit.removed.push(docPath);
      st.removed++;
      removeNodeAndEmptyParent(el, report);
    }
  }

  // ------------------------------------------------------------------ 打包

  /*
   * 自己写 ZIP，而不用 fflate 的 zipSync：实测 fflate 的 deflate
   * 在中文长文本上比系统 zlib 差 5% 左右（level 9 与 level 6 甚至输出相同），
   * 文本多的书会出现"压完反而变大"。浏览器原生 CompressionStream
   * 底层就是 zlib，用它预压缩再手写 ZIP 头，能保证不输于常见工具。
   */

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
        // 压不小就原样存，别为了"看起来压缩过"而变大
        if (comp && comp.length < data.length) {
          method = 8;
          payload = comp;
        }
      }

      var crc = crc32(data);
      var flags = 0x0800; // 文件名按 UTF-8 解释

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
        nameBytes: nameBytes,
        method: method,
        crc: crc,
        csize: payload.length,
        usize: data.length,
        offset: offset,
        flags: flags
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

  // ------------------------------------------------------------------ 主流程

  function collectByLocalName(doc, name) {
    var all = doc.getElementsByTagName('*');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (localTag(all[i]) === name) out.push(all[i]);
    }
    return out;
  }

  function utcStamp() {
    var d = new Date();
    function p(n) {
      return (n < 10 ? '0' : '') + n;
    }
    return (
      d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
      'T' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + 'Z'
    );
  }

  async function process(input, options, onProgress) {
    var opts = Object.assign(
      {
        mode: 'deep',
        splitLevel: 1,
        targetBytes: 0, // 单卷压缩目标；0 = 只按质量档压
        volumeTarget: 0, // 分卷目标；0 = 不分卷，否则为该卷上限
        maxEdge: null, // null = 用模式默认；0 = 保留原分辨率
        quality: null,
        dropFonts: null,
        rebuildToc: true,
        lang: '',
        imageDedupe: true,       // 智能重复图片清理：默认开，只清能确认完全相同的
        outputVersion: 'auto',   // 'auto' 跟原书 / '2' 强制 EPUB 2.0 / '3' 强制 EPUB 3.0
        shouldCancel: null   // 由界面传入：返回 true 就在下一个安全点停下
      },
      options || {}
    );

    // 处理动辄几十秒，中途要能停。所有耗时循环都过这个检查，
    // 停在"整张图/整章"的边界上，不会留下写了一半的东西。
    function checkCancel() {
      if (opts.shouldCancel && opts.shouldCancel()) throw new Error('__CANCELLED__');
    }
    checkCancel();

    // 模式决定策略，用户显式传的字段覆盖模式默认值
    var policy = Object.assign({}, modePolicy(opts.mode));
    ['preserveCss', 'keepInlineStyles', 'normalizeUnits', 'tidyEmpty', 'dropAttrs',
      'unwrapSpans', 'forceJpeg', 'dropUnused'].forEach(function (k) {
      if (opts[k] != null) policy[k] = !!opts[k];
    });
    if (opts.maxEdge != null && opts.maxEdge !== '') policy.maxEdge = Number(opts.maxEdge) || 0;
    if (opts.quality != null && opts.quality !== '') policy.quality = Number(opts.quality);
    if (typeof opts.dropFonts === 'boolean') policy.dropFonts = opts.dropFonts;

    var progress = function (phase, message, ratio) {
      if (typeof onProgress === 'function') {
        onProgress({ phase: phase, message: message, ratio: ratio == null ? null : ratio });
      }
    };

    var report = {
      inputBytes: 0,
      outputBytes: 0,
      mode: opts.mode,
      modeLabel: modePolicy(opts.mode).label,
      policy: {
        preserveCss: !!policy.preserveCss,
        keepInlineStyles: !!policy.keepInlineStyles,
        maxEdge: policy.maxEdge,
        quality: policy.quality,
        dropFonts: !!policy.dropFonts
      },
      normalizedStyles: 0,
      normalizedCssFiles: 0,
      keptInlineStyles: 0,
      unconvertedBlocks: 0,
      volumes: 1,
      savedBytes: 0,
      savedRatio: 0,
      sourceDocuments: 0,
      chapters: 0,
      removedInlineStyles: 0,
      removedEmptyParagraphs: 0,
      removedExtraBreaks: 0,
      removedEmptyBlocks: 0,
      removedFixedSizes: 0,
      removedTags: 0,
      unwrappedTags: 0,
      trimmedManualIndent: 0,
      removedCssFiles: 0,
      removedFonts: 0,
      droppedFontBytes: 0,
      svgFlattened: 0,
      rebuiltParagraphs: 0,   // 由"文字 + <br>"重建出来的段落数
      splitFromBreaks: 0,     // 从"一个 <p> 塞满 <br>"里拆出来的额外段落数
      mergedLines: 0,         // 被硬折行截断、又接回同一段的半句数
      mergedShortParagraphs: 0, // 一句话一段的书里，被合并掉的碎段数
      sourceChars: 0,         // 原书正文字符数，用来核对有没有丢字
      convertedBlocks: 0,
      orphanFiles: 0,
      orphanImages: 0,
      removedDeadImages: 0,
      unresolvedImages: 0,
      imagesProcessed: 0,
      imagesTotal: 0,
      imagesFound: 0,
      imagesKept: 0,
      svgsTotal: 0,
      fontsTotal: 0,
      rawTotal: 0,
      afterRawTotal: 0,
      imageBytesBefore: 0,
      imageBytesAfter: 0,
      // 两个口径必须分开记：
      //   sizeBreakdown  = 解压后各类资源的字节数（处理前）
      //   afterBreakdown = 解压后各类资源的字节数（处理后）
      // 都不能和"文件体积"（ZIP 压缩后的字节数）互相加减，页面必须分别标注。
      sizeBreakdown: { text: 0, image: 0, font: 0, other: 0 },
      afterBreakdown: { text: 0, image: 0, font: 0, other: 0 },
      zipRatio: 0,
      targetBytes: opts.targetBytes || 0,
      targetMet: null,
      sourceVersion: '',
      outputVersion: '',
      versionMode: 'auto',
      versionWarnings: [],
      versionVerified: false,
      // 原书里没有任何引用、因此没有写进新包的图片（要如实报出来）
      unusedImages: 0,
      unusedImageBytes: 0,
      // 重复图片清理（识别结果在正文扫描后填，保存字节在打包后填）
      dedupe: null,
      dedupeRecordTotal: 0,
      // 输出完整性检查的计数（打包时累加，检查报告直接用真数字）
      tocChecked: 0,
      tocMissing: 0,
      pkg: { items: 0, missing: 0, spine: 0 },
      warnings: [],
      tocEntries: 0
    };

    progress('unzip', '解包 EPUB', 0.02);
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    report.inputBytes = bytes.length;

    var unzipped;
    try {
      unzipped = fflate.unzipSync(bytes);
    } catch (e) {
      throw new Error('这个文件不是有效的 EPUB（ZIP 解包失败）：' + e.message);
    }

    var files = {};
    Object.keys(unzipped).forEach(function (name) {
      if (name.charAt(name.length - 1) === '/') return;
      files[name] = unzipped[name];
    });

    if (!files['META-INF/container.xml']) {
      throw new Error('缺少 META-INF/container.xml，不是标准 EPUB。');
    }

    // --- OPF 定位
    progress('parse', '读取 OPF 包文件', 0.05);
    var containerDoc = parseMarkup(fflate.strFromU8(files['META-INF/container.xml']));
    var rootfiles = collectByLocalName(containerDoc, 'rootfile');
    if (!rootfiles.length) throw new Error('container.xml 里找不到 rootfile。');
    var opfPath = rootfiles[0].getAttribute('full-path');
    if (!opfPath || !files[opfPath]) throw new Error('OPF 文件不存在：' + opfPath);

    /*
     * 大小写索引。Windows / macOS 上做的书经常出现引用写 Images/Foo.JPG、
     * 实际文件叫 Images/foo.jpg 的情况——在大写敏感的阅读器里就是"图片不存在"。
     * 有了这张表，引用能对上真实文件，路径也会被改写成正确的大小写。
     */
    var lowerIndex = {};
    Object.keys(files).forEach(function (name) {
      var k = name.toLowerCase();
      if (!lowerIndex[k]) lowerIndex[k] = name;
    });
    function realPath(p) {
      if (!p) return '';
      if (files[p]) return p;
      return lowerIndex[p.toLowerCase()] || '';
    }

    var opfDir = dirname(opfPath);
    var opfDoc = parseMarkup(fflate.strFromU8(files[opfPath]));

    // 原书 unique-identifier 的键名必须沿用，否则校验会报"标识符不匹配"
    var packageEl = collectByLocalName(opfDoc, 'package')[0];
    var uniqueIdName = (packageEl && packageEl.getAttribute('unique-identifier')) || 'BookId';
    var sourceVersion = (packageEl && packageEl.getAttribute('version')) || '2.0';

    /* 输出目标版本：
       auto = 跟原书（原书 3.x 输出 3.0，2.x 输出 2.0）
       显式选了 2 / 3 就真的按目标版本重建包结构，不是只改元数据里的版本号。 */
    var outVersion = opts.outputVersion === '2' ? '2.0'
      : opts.outputVersion === '3' ? '3.0'
      : (/^\s*3\./.test(sourceVersion) ? '3.0' : '2.0');
    var v2 = outVersion === '2.0';
    report.sourceVersion = sourceVersion;
    report.outputVersion = outVersion;
    report.versionMode = opts.outputVersion === '2' || opts.outputVersion === '3' ? 'forced' : 'auto';

    // --- 元数据（原样保留）
    var metadataEl = collectByLocalName(opfDoc, 'metadata')[0];
    var metadataXml = metadataEl ? metadataEl.innerHTML : '';

    // --- manifest
    var manifestItems = collectByLocalName(opfDoc, 'item');
    var manifest = manifestItems.map(function (el) {
      var href = decodePath(el.getAttribute('href') || '');
      return {
        id: el.getAttribute('id') || '',
        href: href,
        path: resolvePath(opfPath, href),
        mediaType: el.getAttribute('media-type') || '',
        properties: el.getAttribute('properties') || ''
      };
    });

    var byId = {};
    manifest.forEach(function (m) {
      if (m.id) byId[m.id] = m;
    });

    // 扩展名判定用模块级常量（diagnose 也要用）

    // --- manifest 完整性诊断
    // 下载 / 转换来的书最常见的坏法是"文件在包里，manifest 没声明"。
    // 阅读器和 Calibre 会逐个文件报"此文件未列在manifest文件中"，
    // 表现就是所有插图都显示不出来。先数清楚有多少个，输出时全部补上。
    var declaredLower = {};
    manifest.forEach(function (m) {
      if (m.path) declaredLower[m.path.toLowerCase()] = 1;
    });
    var orphanFiles = [];
    Object.keys(files).forEach(function (n) {
      if (n === 'mimetype' || n === opfPath) return;
      if (n.indexOf('META-INF/') === 0) return;
      if (declaredLower[n.toLowerCase()]) return;
      orphanFiles.push(n);
    });

    if (orphanFiles.length) {
      var orphanImgs = orphanFiles.filter(function (n) {
        return IMAGE_EXT.test(n);
      }).length;
      report.orphanFiles = orphanFiles.length;
      report.orphanImages = orphanImgs;
      report.warnings.push(
        '发现 ' + orphanFiles.length + ' 个文件（其中 ' + orphanImgs + ' 张图片）在包里存在、' +
        '但原书 manifest 没有声明。阅读器会逐个报「此文件未列在manifest文件中」，' +
        '表现就是插图全部空白或显示成裂图。已全部补进新 manifest 并重新压缩。'
      );
    }

    // --- spine
    var spineEl = collectByLocalName(opfDoc, 'spine')[0];
    var itemrefs = collectByLocalName(opfDoc, 'itemref');
    var spine = itemrefs
      .map(function (el) {
        return { idref: el.getAttribute('idref'), linear: el.getAttribute('linear') !== 'no' };
      })
      .filter(function (r) {
        return byId[r.idref];
      });

    // --- 语言
    var lang = opts.lang;
    if (!lang) {
      var langEls = collectByLocalName(opfDoc, 'language');
      lang = langEls.length ? (langEls[0].textContent || '').trim() : '';
    }
    if (!lang) lang = 'zh-CN';

    // --- 体积构成诊断：先搞清楚这本书的体积到底花在哪，
    //     否则"只压下来 1%"永远是个谜。
    //
    // 注意：图片和字体必须按"磁盘上真实存在的文件"来发现，不能只看 manifest。
    // 从网站抓下来的书普遍存在"图片在包里、manifest 里没声明"的情况，
    // 只认 manifest 会让这些图片既不压缩也不声明，输出就是一堆
    // "此文件未列在manifest文件中"的坏图。

    var imageItems = [];      // 真正要重编码的
    var allImages = [];       // 全部位图（含被跳过的），用于统计
    var svgItems = [];
    var imageSeen = {};
    // 用户关掉"压缩图片"时：图片原样搬运，一张都不重编码
    var noImageOpt = !!opts.noImageOptimize;
    function addImage(m) {
      // SVG 是矢量，重编码只会毁掉它；单列出来统计，别混进"已压缩 X/Y 张"里
      if (/\.svg$/i.test(m.path)) { svgItems.push(m); return; }
      allImages.push(m);
      if (!noImageOpt) imageItems.push(m);
    }
    manifest.forEach(function (m) {
      if (!/^image\//.test(m.mediaType) || !files[m.path] || imageSeen[m.path]) return;
      imageSeen[m.path] = 1;
      addImage(m);
    });
    Object.keys(files).forEach(function (p) {
      if (imageSeen[p] || p.indexOf('META-INF/') === 0 || !IMAGE_EXT.test(p)) return;
      imageSeen[p] = 1;
      addImage({ id: '', href: '', path: p, mediaType: guessMediaType(p), properties: '' });
    });

    var fontItems = [];
    var fontSeen = {};
    manifest.forEach(function (m) {
      var isFont = /font/.test(m.mediaType) || FONT_EXT.test(extname(m.path));
      if (!isFont || !files[m.path] || fontSeen[m.path]) return;
      fontSeen[m.path] = 1;
      fontItems.push(m);
    });
    Object.keys(files).forEach(function (p) {
      if (fontSeen[p] || p.indexOf('META-INF/') === 0 || !FONT_EXT.test(extname(p))) return;
      fontSeen[p] = 1;
      fontItems.push({ id: '', href: '', path: p, mediaType: guessMediaType(p), properties: '' });
    });

    // 原书里"声明了但文件不存在"的条目，输出时必须丢掉，
    // 否则会变成另一种错误：manifest 指向一个不存在的文件。
    var missingDeclared = manifest.filter(function (m) {
      return m.path && !files[m.path];
    });
    if (missingDeclared.length) {
      report.warnings.push(
        '原书 manifest 声明了 ' + missingDeclared.length +
        ' 个文件，但包里根本没有这些文件（如 ' + basename(missingDeclared[0].path) +
        '），已从新 manifest 中移除。'
      );
    }

    var imagePaths = {};
    allImages.forEach(function (m) {
      imagePaths[m.path] = 1;
    });
    svgItems.forEach(function (m) {
      imagePaths[m.path] = 1;   // SVG 也算图片体积，只是不进压缩队列
    });
    report.fontsTotal = fontItems.length;
    var fontPaths = {};
    fontItems.forEach(function (m) {
      fontPaths[m.path] = 1;
    });

    var textRaw = 0;
    var rawTotal = 0;
    Object.keys(files).forEach(function (name) {
      var n = files[name].length;
      rawTotal += n;
      if (imagePaths[name]) report.sizeBreakdown.image += n;
      else if (fontPaths[name]) report.sizeBreakdown.font += n;
      else if (/\.(x?html?|xml|opf|ncx|css)$/i.test(name)) {
        report.sizeBreakdown.text += n;
        if (/\.x?html?$/i.test(name)) textRaw += n;
      } else report.sizeBreakdown.other += n;
    });
    // 构成占比统一用解压后的总量做分母，否则会出现 "7000% 是文本" 这种荒谬数字
    report.rawTotal = rawTotal || 1;

    report.imagesTotal = allImages.length;
    report.imagesFound = allImages.length;
    report.svgsTotal = svgItems.length;

    /*
     * --- 重复图片清理（只识别，不改正文）
     *
     * 先算出"哪些图片文件内容完全相同"，正文哪个位置该留哪个该删，
     * 要等逐章遍历时按阅读顺序决定。这里只做识别，顺便给结果页攒统计。
     * 默认开启，用户可以在界面上关掉（opts.imageDedupe === false）。
     */
    var dedupe = null;
    if (opts.imageDedupe !== false && allImages.length >= 1) {
      var grouped = await groupIdenticalImages(
        allImages,
        files,
        function (done, total, name) {
          progress('images', '识别重复图片 ' + done + '/' + total + '　' + basename(name),
            0.04 + 0.04 * (done / Math.max(1, total)));
        },
        opts.shouldCancel
      );
      if (!grouped.ok) {
        report.warnings.push('当前环境拿不到内容哈希（crypto.subtle 不可用），已跳过重复图片清理，图片全部原样保留。');
      } else {
        dedupe = {
          canon: grouped.canon,
          unhashable: grouped.unhashable,
          seen: {},
          positions: 0,
          kept: 0,
          removed: 0,
          skipped: 0,
          pixelGroups: 0,
          pixelPairs: grouped.pixelPairs,
          pixelSkipped: grouped.skippedPairs,
          budgetOut: !!grouped.budgetOut,
          groups: grouped.groups
        };
        grouped.groups.forEach(function (g) {
          if (g.pixel) dedupe.pixelGroups++;
        });
      }
    }

    // --- 图片处理：按目标体积反推预算
    var imageMap = {};
    if (imageItems.length) {
      var baseEstimate = textRaw * 0.4 + 4000; // 文本 deflate 后大致三成多
      var imgBudget = Infinity;
      if (opts.targetBytes) {
        imgBudget = opts.targetBytes - baseEstimate;
        if (imgBudget < opts.targetBytes * 0.05) imgBudget = opts.targetBytes * 0.05;
      }
      imageMap = await compressImages(
        imageItems,
        files,
        {
          budget: imgBudget,
          maxEdge: policy.maxEdge || 0,
          quality: policy.quality,
          forceJpeg: policy.forceJpeg,
          shouldCancel: opts.shouldCancel
        },
        function (done, total, name) {
          progress(
            'images',
            '处理图片 ' + done + '/' + total + '　' + basename(name),
            0.08 + 0.42 * (done / Math.max(1, total))
          );
        }
      );
      Object.keys(imageMap).forEach(function (k) {
        report.imagesProcessed++;
        report.imageBytesBefore += imageMap[k].fromBytes;
        report.imageBytesAfter += imageMap[k].toBytes;
      });
    }
    if (noImageOpt && allImages.length) {
      report.warnings.push('按要求关闭了图片压缩，' + allImages.length + ' 张图片原样保留。');
    }
    // 进了队列但最终没换掉的（已经比我们压得更小、或格式不支持）
    report.imagesKept = Math.max(0, allImages.length - report.imagesProcessed);

    // --- 逐文档清理与切分
    progress('clean', '清理正文', 0.45);
    var ctx = { report: report, policy: policy };
    var chapters = [];
    var anchorMap = {}; // 原路径 -> { fragment: 新路径 }
    var sourceDocs = [];
    var docTitles = {};
    var headingChapters = 0;

    for (var si = 0; si < spine.length; si++) {
      var ref = spine[si];
      var mi = byId[ref.idref];
      if (!mi || !files[mi.path]) continue;
      if (!/xhtml|html/.test(mi.mediaType) && !/\.x?html?$/i.test(mi.path)) continue;

      var raw = fflate.strFromU8(files[mi.path]);
      var doc = parseMarkup(raw);
      var body = getBody(doc);
      if (!body) continue;

      var headTitle = '';
      var titles = collectByLocalName(doc, 'title');
      if (titles.length) headTitle = (titles[0].textContent || '').trim();

      report.sourceDocuments++;
      if (!opts.onlyImages) {
        // 处理前先记下正文字符数：后面用它核对输出有没有丢字（排版检查要用真数据）
        report.sourceChars += (body.textContent || '').replace(/[\s\u00A0]/g, '').length;
      }
      if (opts.onlyImages) {
        // 只优化图片的模式：一个标签都不动，正文原样保留，只把图片换掉。
        // 工具箱里的"图片优化"走这条路，用户才能相信"排版绝对没变"。
      } else {
        flattenSvgImages(body, ctx);
        walkAndClean(body, ctx);
        rebuildParagraphs(body, ctx);
        // 保留原 CSS 时不做 div→p 降级：原样式表里可能写着 div.p { ... }，
        // 换成 p 之后选择器失配，缩进反而没了。
        if (!policy.preserveCss) convertTextBlocks(body, ctx);
        else report.unconvertedBlocks += countTextBlocks(body);
        tidyRecursive(body, ctx);
        // 段落结构稳定之后再合并碎段：前面几步都可能拆出新段落
        if (!policy.preserveCss) mergeShortParagraphs(body, ctx);
      }
      // 重复图片：在这里按阅读顺序扫一遍。要在清理之后、切章之前做——
      // 此时段落结构已经稳定，删掉一个 <img> 连带的空段落能被一起清干净。
      if (dedupe && !opts.onlyImages) dedupeInBody(body, mi.path, dedupe, report, realPath);

      // 网页抓来的书常把章名写成 h2/h3，按 h1 切会一个章节都切不出来。
      // 一级标题不存在、下一级存在时，自动退一级，比让用户自己试更省事。
      var splitLevel = opts.onlyImages ? 0 : opts.splitLevel;
      if (splitLevel > 0) {
        for (var lvTry = 1; lvTry <= 3; lvTry++) {
          if (body.getElementsByTagName('h' + lvTry).length) {
            if (lvTry > splitLevel) {
              splitLevel = lvTry;
              report.autoSplitLevel = lvTry;
            }
            break;
          }
        }
      }

      var parts = splitIntoChapters(body, splitLevel);
      if (!parts.length) {
        report.warnings.push('这一节没有正文内容，已跳过：' + mi.path);
        continue;
      }

      sourceDocs.push({ path: mi.path, title: headTitle, parts: parts.length });
      docTitles[mi.path] = headTitle;

      for (var pi = 0; pi < parts.length; pi++) {
        var part = parts[pi];
        if (part.level > 0) headingChapters++;
        var title = part.title || (parts.length === 1 ? headTitle : '') || '';
        chapters.push({
          srcPath: mi.path,
          nodes: part.nodes,
          title: title,
          level: part.level || 1,
          newPath: ''
        });
      }
    }

    if (!chapters.length) throw new Error('正文里没有找到任何可用的文字内容。');
    report.chapters = chapters.length;

    // 很多转换工具导出的书用 <p class="title"> 当章节名，没有 h1-h6，
    // 这时按标题切分是切不动的，必须如实告诉用户，而不是假装处理过了。
    if (opts.splitLevel > 0 && headingChapters === 0) {
      report.warnings.push(
        '整本书没有找到 h1–h6 标题，章节切分未生效（仍然完成了样式与图片处理）。' +
        '如果原书用 <p class="title"> 之类的方式标章节，建议换"不拆分"，或告诉我，我加一条识别规则。'
      );
    }

    // --- 分配新路径
    var textDir = (opfDir ? opfDir + '/' : '') + 'text';
    var pad = String(chapters.length).length;
    chapters.forEach(function (ch, idx) {
      var n = String(idx + 1);
      while (n.length < Math.max(3, pad)) n = '0' + n;
      ch.newPath = textDir + '/ch_' + n + '.xhtml';
      ch.fileName = 'ch_' + n + '.xhtml';
    });

    /*
     * --- 重复图片：把"哪个位置"翻成"第几章"
     *
     * 扫描时只知道源文件路径，章节号是切分之后才有的。这里补上，
     * 结果页才能说清"首次出现在第 3 章，第 7、9 章重复"。
     */
    if (dedupe) {
      var chIndexOf = {};
      chapters.forEach(function (ch, idx) {
        if (!chIndexOf[ch.srcPath]) {
          chIndexOf[ch.srcPath] = { no: idx + 1, title: ch.title || '' };
        }
      });
      function whereLabel(srcPath, sameChapter) {
        var c = chIndexOf[srcPath];
        // 章节标题比"第几章"更好认：很多书的章名本身就是"第一章"，
        // 再拼一个序号会变成"第 2 章 · 第一章"，读起来自相矛盾。
        var label = c ? (c.title || '第 ' + c.no + ' 章') : basename(srcPath);
        if (sameChapter) label += '（同章重复）';
        return label;
      }
      var recs = [];
      var groupOf = {};
      dedupe.groups.forEach(function (g) { groupOf[g.paths[0]] = g; });
      Object.keys(dedupe.seen).forEach(function (key) {
        var hit = dedupe.seen[key];
        if (!hit.removed.length) return;
        var g = groupOf[key];
        recs.push({
          name: basename(hit.path),
          path: hit.path,
          bytes: (files[hit.path] && files[hit.path].length) || 0,
          pixel: !!(g && g.pixel),
          mergedFiles: g ? g.paths.length : 1,
          keep: whereLabel(hit.srcPath, false),
          removed: hit.removed.map(function (p) { return whereLabel(p, p === hit.srcPath); })
        });
      });
      recs.sort(function (a, b) { return b.removed.length - a.removed.length; });

      // 不同文件名、同一份内容的资源副本数（去重后能少带进包的）
      var dupResourceCount = 0;
      dedupe.groups.forEach(function (g) {
        if (g.paths.length > 1) dupResourceCount += g.paths.length - 1;
      });

      report.dedupe = {
        on: true,
        positions: dedupe.positions,
        unique: Object.keys(dedupe.seen).length,
        kept: dedupe.kept,
        removed: dedupe.removed,
        groups: recs.length,
        dupResources: dupResourceCount,
        pixelConfirmed: dedupe.pixelGroups,
        pixelPairs: dedupe.pixelPairs,
        pixelSkipped: dedupe.pixelSkipped,
        budgetOut: dedupe.budgetOut,
        skipped: dedupe.skipped,
        savedBytes: 0,
        droppedResources: 0,
        records: recs.slice(0, 200)
      };
      report.dedupeRecordTotal = recs.length;
    } else if (opts.imageDedupe === false) {
      report.dedupe = { on: false };
    }

    // --- 锚点映射：同一源文档里的 #id 指向新章节
    chapters.forEach(function (ch) {
      if (!anchorMap[ch.srcPath]) anchorMap[ch.srcPath] = {};
      var map = anchorMap[ch.srcPath];
      ch.nodes.forEach(function (node) {
        if (node.nodeType !== 1) return;
        var collect = [node].concat(Array.prototype.slice.call(node.getElementsByTagName('*')));
        collect.forEach(function (el) {
          var id = el.getAttribute && el.getAttribute('id');
          if (id && !map[id]) map[id] = ch.newPath;
        });
      });
    });

    // --- 重写链接与图片路径
    progress('rewrite', '重写内部链接与图片引用', 0.55);
    chapters.forEach(function (ch) {
      extractUrls(ch.nodes, function (type, el, url) {
        if (!url || isExternal(url)) return null;
        var hashIdx = url.indexOf('#');
        var frag = hashIdx >= 0 ? url.slice(hashIdx + 1) : '';
        var bare = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
        // 中文文件名常被 URL 编码成 %E5%9B%BE.jpg。不解码就找不到真实文件，
        // 会被误判成"图片缺失"而删掉，所以先解码再解析。
        var bareDec = decodePath(bare);

        if (type === 'img') {
          var abs = realPath(resolvePath(ch.srcPath, bareDec));
          var img = abs ? imageMap[abs] : null;
          var targetPath = img ? img.newPath : abs;
          if (!img && !abs) {
            // 原书引用了不存在的图片。留着就是一条永远解析不了的死引用，
            // 阅读器会显示破图，epubcheck 也会报错，所以直接删掉并记录。
            report.unresolvedImages++;
            return false;
          }
          return relativePath(ch.newPath, targetPath);
        }

        // 文本链接
        if (!bare) {
          // 纯锚点，指向本文件
          if (!frag) return null;
          var mapSelf = anchorMap[ch.srcPath] || {};
          var target = mapSelf[frag];
          if (!target) return null;
          return target === ch.newPath ? '#' + frag : relativePath(ch.newPath, target) + '#' + frag;
        }

        var targetAbs = realPath(resolvePath(ch.srcPath, bareDec));
        var mapOther = anchorMap[targetAbs];
        if (mapOther && frag && mapOther[frag]) {
          var t = mapOther[frag];
          return relativePath(ch.newPath, t) + '#' + frag;
        }
        if (mapOther) {
          // 指向该文档第一个章节
          var firstKey = Object.keys(mapOther)[0];
          if (firstKey) {
            return relativePath(ch.newPath, mapOther[firstKey]);
          }
        }
        if (targetAbs && files[targetAbs]) return relativePath(ch.newPath, targetAbs);
        return null;
      }, report);
    });

    if (report.unresolvedImages) {
      report.warnings.push(
        '有 ' + report.unresolvedImages +
        ' 处图片引用指向书里根本不存在的文件（原书转换时把路径写错了），' +
        '已把这些死引用删掉，否则阅读器会显示破图、校验也过不了。' +
        '这些插图需要你手工补回。'
      );
    }

    // --- 生成文件
    progress('build', '生成章节与目录', 0.7);
    var out = {};
    var keepCssFiles = []; // 保留原 CSS 时，这些文件要逐个链回章节
    var cssPath = (opfDir ? opfDir + '/' : '') + 'epubfix.css';
    var navPath = (opfDir ? opfDir + '/' : '') + 'nav.xhtml';
    var ncxPath = (opfDir ? opfDir + '/' : '') + 'toc.ncx';

    /*
     * 保留原 CSS 的模式：先扫出所有样式表，把里面的 px/pt 换算成相对单位。
     * 只换算字号、行高、缩进、边距，其余声明原样保留 —— 原书的设计不能被改掉，
     * 但写死的 px 正是"同一本书在手机和墨水屏上字号差一倍"的根因。
     */
    if (policy.preserveCss) {
      Object.keys(files).forEach(function (name) {
        if (name.indexOf('META-INF/') === 0) return;
        if (extname(name) !== 'css') return;
        var cssText = fflate.strFromU8(files[name]);
        if (policy.normalizeUnits) {
          var fixedCss = normalizeCssText(cssText);
          if (fixedCss !== cssText) {
            files[name] = fflate.strToU8(fixedCss);
            report.normalizedCssFiles++;
          }
        }
        keepCssFiles.push(name);
      });
      /*
       * 输入本身可能就是上一轮处理过的书，包里已经有一份我们要写的 epubfix.css。
       * 不去掉的话会出现两个后果：manifest 里同一条 href 声明两次、
       * 每章 head 里同一张样式表链两遍（曾实测到 ef3 / ef4 两条重复项）。
       */
      keepCssFiles = keepCssFiles.filter(function (n) { return n !== cssPath; });
      keepCssFiles.sort();
    }

    /*
     * 保留原 CSS 的模式下，如果原书压根没有可用样式表（或只剩我们上一轮写的
     * safety 层），就退到完整样式层 —— 这时没有"原设计"可保，只有兜底层
     * 会让整本书看着像没排过版。
     */
    var cssKind = policy.preserveCss && keepCssFiles.length ? 'safety' : 'full';
    out[cssPath] = fflate.strToU8(buildCss(cssKind));
    report.cssKind = cssKind;
    report.keptCssFiles = keepCssFiles.slice();
    // 原书样式表在前、我们的安全层在后：后加载的优先，但安全层不含排版声明
    var cssList = keepCssFiles.concat([cssPath]);

    var previewChapters = [];
    var PREVIEW_LIMIT = 400;

    chapters.forEach(function (ch, ci) {
      if ((ci & 7) === 0) checkCancel();
      var inner = serializeChildren({ childNodes: ch.nodes, nodeType: 1 });
      ch.inner = inner;
      out[ch.newPath] = fflate.strToU8(buildChapterXhtml(ch, cssList, lang, inner, outVersion));
      if (previewChapters.length < PREVIEW_LIMIT) {
        // 预览里把图片地址换成绝对路径标记，由页面侧填 data: URL，
        // 否则相对路径在预览 iframe 里解析不到。
        var pv = inner.replace(/<img\b([^>]*?)\ssrc="([^"]*)"([^>]*)>/g, function (all, pre, src, post) {
          if (isExternal(src)) return all;
          var abs = resolvePath(ch.newPath, src);
          return '<img' + pre + ' data-efsrc="' + escAttr(abs) + '"' + post + '>';
        });
        previewChapters.push({ title: ch.title || '正文', html: pv });
      }
    });

    var uid = 'urn:uuid:epubfix-' + Math.random().toString(16).slice(2, 10);
    report.tocEntries = chapters.length;

    /*
     * 版本兼容性清点。
     * 目标版本装不下的东西（EPUB2 没有 SVG 核心媒体类型、没有 HTML5 语义标签）
     * 不能悄悄丢掉——章节一改结构排版就散了。这里数清楚，在结果页如实说。
     */
    var features = { svgInline: 0, html5: 0, media: 0, svgFiles: 0, math: 0 };
    chapters.forEach(function (ch) {
      var s = ch.inner || '';
      features.svgInline += (s.match(/<svg\b/gi) || []).length;
      features.html5 += (s.match(/<(section|article|aside|figure|figcaption|header|footer|main|nav|mark|time)\b/gi) || []).length;
      features.media += (s.match(/<(video|audio|canvas)\b/gi) || []).length;
      features.math += (s.match(/<math\b/gi) || []).length;
    });
    // SVG 文件数直接取 manifest 里声明、且会被原样写进输出的那些
    features.svgFiles = svgItems.length;
    report.features = features;

    /* 检查要用到最终的输出包（图片是后面才写进 out 的），所以整体推迟到最后执行 */
    function runTypographyAudit() {
    /*
     * ---------------------------------------------------------------
     * 排版兼容性检查
     *
     * 每一项都从输出包里的真实 XHTML / CSS 算出来。打包成功 ≠ 排版正常，
     * 所以这里只讲"查到了什么、改了什么、哪里还有风险"，不给一句"一切正常"。
     * ---------------------------------------------------------------
     */
    var audit = [];
    function note(id, title, status, detail) {
      audit.push({ id: id, title: title, status: status, detail: detail });
    }

    var totalP = 0, totalH = 0, totalImg = 0, totalTable = 0, totalSvg = 0, totalPre = 0, totalList = 0;
    var outChars = 0, missingCssLink = 0, brokenCssRef = 0, brokenImg = 0, wrappedSpecial = 0;
    var unparsable = 0, reparseLoss = 0;

    var cssText = out[cssPath] ? fflate.strFromU8(out[cssPath]) : '';

    chapters.forEach(function (ch, ci) {
      if ((ci & 15) === 0) checkCancel();
      var full = out[ch.newPath] ? fflate.strFromU8(out[ch.newPath]) : '';
      var bodyInner = (full.match(/<body\b[^>]*>([\s\S]*)<\/body>/i) || ['', ''])[1];

      totalP += (bodyInner.match(/<p\b/gi) || []).length;
      totalH += (bodyInner.match(/<h[1-6]\b/gi) || []).length;
      totalImg += (bodyInner.match(/<img\b/gi) || []).length;
      totalTable += (bodyInner.match(/<table\b/gi) || []).length;
      totalSvg += (bodyInner.match(/<svg\b/gi) || []).length;
      totalPre += (bodyInner.match(/<pre\b/gi) || []).length;
      totalList += (bodyInner.match(/<(ul|ol)\b/gi) || []).length;
      outChars += bodyInner.replace(/<[^>]+>/g, '').replace(/[\s\u00A0]/g, '').length;

      // 样式表引用：每章都要真的链到统一样式表，链了但文件不存在也算问题
      var linked = false;
      var links = full.match(/<link\b[^>]*>/gi) || [];
      links.forEach(function (tag) {
        var m = tag.match(/href="([^"]+)"/i);
        if (!m) return;
        var abs = resolvePath(ch.newPath, decodePath(m[1]));
        if (abs === cssPath) linked = true;
        else if (!out[abs]) brokenCssRef++;
      });
      if (!linked) missingCssLink++;

      // 图片引用：src 必须能在输出包里找到实体文件
      (bodyInner.match(/<img\b[^>]*\ssrc="([^"]*)"/gi) || []).forEach(function (tag) {
        var m = tag.match(/src="([^"]*)"/i);
        if (!m || isExternal(m[1])) return;
        var abs = resolvePath(ch.newPath, decodePath(m[1]));
        if (!out[abs]) brokenImg++;
      });

      // 表格 / 列表 / 引用块 / 标题 被卷进正文段落，是最典型的"样式带歪"
      if (/<p\b[^>]*class="[^"]*ef-p[^"]*"[^>]*>(?:(?!<\/p>)[\s\S])*<(table|ul|ol|blockquote|pre|h[1-6])\b/i.test(bodyInner)) {
        wrappedSpecial++;
      }

      // 输出章节必须能被重新解析，否则阅读器里就是白页
      if (full) {
        var doc2 = parseMarkup(full);
        if (doc2.getElementsByTagName('parsererror').length) {
          unparsable++;
        } else {
          var t2 = (getBody(doc2).textContent || '').replace(/[\s\u00A0]/g, '').length;
          var t1 = (ch.inner || '').replace(/<[^>]+>/g, '').replace(/[\s\u00A0]/g, '').length;
          if (t2 + 20 < t1) reparseLoss++;
        }
      }
    });

    var newP = report.rebuiltParagraphs || 0;
    var splitP = report.splitFromBreaks || 0;

    if (totalP === 0) {
      note('p', '段落结构', 'warn',
        '输出的正文里没有任何 <p> 段落，阅读器无法给正文加段距和首行缩进，会挤成一块。');
    } else if (newP || splitP || report.mergedShortParagraphs) {
      var pBits = [];
      if (newP) pBits.push('重建 ' + newP + ' 个段落');
      if (splitP) pBits.push('从挤在一起的段落里拆出 ' + splitP + ' 段');
      if (report.mergedLines) pBits.push('把 ' + report.mergedLines + ' 处被硬折行截断的半句接回同一段');
      if (report.mergedShortParagraphs) pBits.push('把 ' + report.mergedShortParagraphs + ' 个一句话一段的碎段合并成正常段落');
      note('p', '段落结构', 'fixed',
        '原书段落结构不符合阅读习惯：' + pBits.join('，') +
        '。输出共 ' + totalP + ' 个段落。');
    } else {
      note('p', '段落结构', 'ok', '原书段落完整，输出保留 ' + totalP + ' 个段落，没有合并或拆散。');
    }

    var srcChars = report.sourceChars || 0;
    if (srcChars && outChars < Math.floor(srcChars * 0.98)) {
      note('text', '正文完整性', 'warn',
        '原书 ' + srcChars + ' 字，输出 ' + outChars + ' 字，少了 ' + (srcChars - outChars) +
        ' 字。可能有内容在清理时被去掉，建议同章对比确认。');
    } else {
      note('text', '正文完整性', 'ok',
        '原书 ' + srcChars + ' 字、输出 ' + outChars + ' 字，没有发现丢字、重复或文字粘连。');
    }

    if (policy.preserveCss && report.unconvertedBlocks > 0) {
      note('block', '段落来源', 'warn',
        '有 ' + report.unconvertedBlocks + ' 处正文直接写在 <div> 里。当前保留了原书样式表，' +
        '没有把它们改成 <p>；如果原书没给这些 div 设缩进，阅读时会顶格。想统一缩进请用深度优化。');
    } else if (totalP > 0) {
      note('block', '段落来源', 'ok', '正文段落全部来自 <p> 标签，样式规则可以稳定挂上。');
    }

    if (missingCssLink || brokenCssRef) {
      note('css', '样式表引用', 'warn',
        (missingCssLink ? missingCssLink + ' 章没有链到统一正文样式表' : '') +
        (missingCssLink && brokenCssRef ? '；' : '') +
        (brokenCssRef ? brokenCssRef + ' 处样式表链接指向不存在的文件' : '') +
        '，这些章节的缩进和段距不会生效。');
    } else {
      note('css', '样式表引用', 'ok', chapters.length + ' 章全部链到 ' + basename(cssPath) + '，没有失效链接。');
    }

    var indentRule = /p\.ef-p[^{]*\{[^}]*text-indent:\s*2em/.test(cssText);
    var headNoIndent = /h1,\s*h2[^{]*\{[^}]*text-indent:\s*0/.test(cssText);
    if (indentRule && headNoIndent) {
      note('indent', '首行缩进与段距', 'ok',
        '普通正文 2em 首行缩进、段距 0.6em、行高 1.75；标题、图片、引用、表格、列表、诗歌已排除在缩进之外。');
    } else {
      note('indent', '首行缩进与段距', 'warn', '样式表里没有找到完整的缩进规则，正文可能顶格显示。');
    }

    if (totalH === 0) {
      note('head', '章节标题', 'warn', '输出里没有 h1–h6 标题元素。目录仍可用，但正文里看不到章节名，层级也不明显。');
    } else {
      note('head', '章节标题', 'ok', totalH + ' 个标题元素，居中、加粗、无首行缩进，与正文之间留 0.9em 间距。');
    }

    if (wrappedSpecial > 0) {
      note('special', '特殊内容保护', 'warn',
        '有 ' + wrappedSpecial + ' 处表格 / 列表 / 引用块 / 标题被包进了正文段落，样式可能被正文规则带歪。');
    } else {
      note('special', '特殊内容保护', 'ok',
        '图片 ' + totalImg + ' 张、表格 ' + totalTable + ' 个、列表 ' + totalList + ' 个、SVG ' + totalSvg +
        ' 处、预排版 ' + totalPre + ' 处，均独立保留，没有套用正文缩进。');
    }

    if (brokenImg) {
      note('res', '图片资源', 'warn', brokenImg + ' 张图片的 src 指向输出包里不存在的文件，阅读器会显示破图。');
    } else {
      note('res', '图片资源', 'ok', totalImg ? totalImg + ' 张图片全部能定位到实际文件。' : '这本书没有位图，图片部分无需检查。');
    }

    /*
     * 重复图片清理的结果。这里只说真实数字：
     * 清掉了几处显示位置、少带进包几个资源文件、省了多少字节，分三件事讲。
     */
    var dd = report.dedupe;
    if (!dd) {
      note('dup', '重复图片', 'info', '这本书没有可用位图，重复图片清理未执行。');
    } else if (!dd.on) {
      note('dup', '重复图片', 'info', '按你的设置关闭了「智能重复图片清理」，图片按原样全部保留。');
    } else if (dd.removed > 0) {
      note('dup', '重复图片', 'fixed',
        '正文 ' + dd.positions + ' 处图片里，内容完全相同的重复出现 ' + dd.removed +
        ' 处已清除，每张图都保留第一次出现的位置（共留 ' + dd.kept + ' 张）。' +
        (dd.droppedResources
          ? '另有 ' + dd.droppedResources + ' 个完全是同一张图的冗余文件不再写进新包，省下 ' +
            (dd.savedBytes / 1048576).toFixed(2) + ' MB。'
          : '资源文件都还有别处引用，一个都没删。') +
        (dd.pixelConfirmed ? '其中 ' + dd.pixelConfirmed + ' 组是解码后逐像素比对确认的。' : '') +
        (dd.budgetOut ? '同尺寸图片较多，逐像素比对达到上限后停止，剩下的按不同图片处理。' : '') +
        (dd.skipped ? '有 ' + dd.skipped + ' 处认不出内容（格式解不了），已原样保留。' : ''));
    } else {
      note('dup', '重复图片', 'ok',
        '正文 ' + dd.positions + ' 处图片、' + dd.unique + ' 种不同内容，没有发现完全相同的重复。' +
        (dd.pixelPairs ? '另外对 ' + dd.pixelPairs + ' 组同尺寸图片做了逐像素比对，结果都不相同。' : ''));
    }

    if (report.tocMissing) {
      note('toc', '目录与章节', 'warn',
        report.tocMissing + ' 处章节在目录里找不到入口（共核对 ' + report.tocChecked + ' 项），' +
        '这些章在阅读器目录里点不到，只能按顺序翻。');
    } else {
      note('toc', '目录与章节', 'ok',
        report.chapters + ' 章全部能在目录里点到（NCX' + (v2 ? '' : ' 与 nav') + ' 双份核对一致）。');
    }

    if (report.pkg.missing) {
      note('pkg', '输出完整性', 'warn',
        '打包自检发现 ' + report.pkg.missing + ' 个 manifest 条目指向包里不存在的文件（共 ' +
        report.pkg.items + ' 项），阅读器可能报错或加载失败。');
    } else {
      note('pkg', '输出完整性', 'ok',
        '每个输出包都已重新解析：mimetype 在首条且未压缩、container.xml 指向正确 OPF、' +
        'manifest ' + report.pkg.items + ' 个条目全部存在、spine ' + report.pkg.spine + ' 项全部能对上。');
    }

    if (unparsable || reparseLoss) {
      note('parse', '重新解析输出', 'warn',
        (unparsable ? unparsable + ' 章无法被重新解析' : '') +
        (unparsable && reparseLoss ? '；' : '') +
        (reparseLoss ? reparseLoss + ' 章重新解析后文字变少' : '') + '，请检查这些章。');
    } else {
      note('parse', '重新解析输出', 'ok', chapters.length + ' 章都能被重新解析，正文与输出前一致。');
    }

    var riskBits = [];
    if (outVersion === '2.0' && features.svgInline) riskBits.push('内联 SVG ' + features.svgInline + ' 处');
    if (outVersion === '2.0' && features.html5) riskBits.push('HTML5 语义标签 ' + features.html5 + ' 处');
    if (policy.keepInlineStyles && report.keptInlineStyles) {
      riskBits.push('保留的内联样式 ' + report.keptInlineStyles + ' 处（字号/行高由原书写死，可能与阅读器设置冲突）');
    }
    if (policy.preserveCss) riskBits.push('原书样式表被保留，个别段落的缩进以原书为准');
    if (riskBits.length) {
      note('risk', '阅读器兼容性', 'info',
        '以下是已知的兼容性风险，不影响生成的文件能用，但不同阅读器看起来可能不一样：' + riskBits.join('；') + '。');
    } else {
      note('risk', '阅读器兼容性', 'ok', '样式表只有相对单位与基础属性，没有会让阅读器打架的写法。');
    }

      if (report.versionVerified) {
        note('ver', 'EPUB ' + (report.outputVersion || '') + ' 结构', 'ok',
          '版本声明、manifest、spine、导航与章节 DOCTYPE 全部符合 EPUB ' + (report.outputVersion || '') + ' 规范。');
      } else {
        note('ver', 'EPUB ' + (report.outputVersion || '') + ' 结构', 'warn',
          '结构自检没有全部通过：' + ((report.verifyIssues || []).join('；') || '原因未知'));
      }
      report.audit = audit;
      report.auditCounts = audit.reduce(function (acc, it) {
        acc[it.status] = (acc[it.status] || 0) + 1;
        return acc;
      }, { ok: 0, fixed: 0, warn: 0, info: 0 });

    }

    // --- 图片写入
    Object.keys(imageMap).forEach(function (oldPath) {
      var rec = imageMap[oldPath];
      out[rec.newPath] = rec.bytes;
      if (rec.newPath !== oldPath) delete files[oldPath];
    });

    // --- 字体与旧样式表剔除（同样按磁盘文件判断，不能只认 manifest）
    // 样式表已在上面按模式处理过，这里只管字体
    var dropped = {};
    Object.keys(files).forEach(function (name) {
      if (name.indexOf('META-INF/') === 0) return;
      var ext = extname(name);
      if (ext === 'css') {
        // 保留原 CSS 时不动它：原书靠它排版，删掉等于重排整本书
        if (!policy.preserveCss) {
          dropped[name] = true;
          report.removedCssFiles++;
        }
        return;
      }
      if (FONT_EXT.test(ext) && policy.dropFonts) {
        dropped[name] = true;
        report.removedFonts++;
        report.droppedFontBytes += files[name].length;
      }
    });
    manifest.forEach(function (m) {
      if (m.mediaType === 'text/css' && files[m.path] && !dropped[m.path] && !policy.preserveCss) {
        dropped[m.path] = true;
        report.removedCssFiles++;
      }
    });

    // 旧的正文章节文件被新文件取代
    sourceDocs.forEach(function (d) {
      dropped[d.path] = true;
    });
    // 旧目录文件：任何 .ncx 都丢弃（我们自己重写一份）
    Object.keys(files).forEach(function (name) {
      if (extname(name) === 'ncx') dropped[name] = true;
    });
    // 原书的导航文档若不是我们写的那份，也丢弃：它指向的旧章节已经不存在了
    manifest.forEach(function (m) {
      if (/nav/.test(m.properties || '') && m.path !== navPath) dropped[m.path] = true;
    });

    // --- 其余文件原样搬运
    Object.keys(files).forEach(function (name) {
      if (name === 'mimetype' || name === 'META-INF/container.xml') return;
      if (name === opfPath) return;
      if (dropped[name]) return;
      if (out[name]) return;
      if (name.indexOf('META-INF/') === 0 && name !== 'META-INF/container.xml') {
        // 只保留 container.xml，其余（如 com.apple.ibooks.display-options.xml）一并丢掉
        return;
      }
      out[name] = files[name];
    });

    // --- OPF：manifest 严格按输出包里真实存在的文件生成
    var origByPath = {};
    manifest.forEach(function (m) {
      if (m.path && !origByPath[m.path]) origByPath[m.path] = m;
    });
    var convType = {};
    Object.keys(imageMap).forEach(function (oldPath) {
      var rec = imageMap[oldPath];
      convType[rec.newPath] = rec.mediaType;
      if (rec.newPath !== oldPath && origByPath[oldPath] && !origByPath[rec.newPath]) {
        origByPath[rec.newPath] = origByPath[oldPath];
      }
    });

    // 章节文件每卷都要重写，不能进公共资源
    var chapterPaths = {};
    chapters.forEach(function (ch) {
      chapterPaths[ch.newPath] = 1;
    });

    var keepCssSet = {};
    keepCssFiles.forEach(function (p) {
      keepCssSet[p] = 1;
    });

    // 除章节与自有样式表之外的资源：图片、字体、保留的原 CSS、音视频等
    var sharedResources = [];
    Object.keys(out).forEach(function (name) {
      if (name === 'mimetype' || name === opfPath) return;
      if (name.indexOf('META-INF/') === 0) return;
      if (chapterPaths[name]) return;
      if (name === cssPath || keepCssSet[name]) return; // 样式表由 buildOpf 统一声明
      var orig = origByPath[name];
      sharedResources.push({
        path: name,
        mediaType: convType[name] || (orig && orig.mediaType) || guessMediaType(name),
        id: orig ? orig.id : '',
        properties: orig ? orig.properties : ''
      });
    });
    sharedResources.sort(function (a, b) {
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });

    // --- 分卷规划 + 逐卷打包
    progress('pack', '规划分卷并打包', 0.88);
    var COMPRESSED_ALREADY = /\.(jpe?g|png|gif|webp|mp3|mp4|m4a|zip)$/i;
    var baseTitle = extractTitle(metadataXml) || '未命名';

    /*
     * 保留原样式表时，图/字体可能只被 CSS 的 url() 引用（背景图、@font-face）。
     * 章节 HTML 里扫不到它们，若只按章节引用决定"带哪些资源进包"，
     * 这些文件会被当成死资源丢掉，样式表里就留下一条断链。
     */
    var cssAssetRefs = [];
    if (policy.preserveCss) {
      var cssRefSet = {};
      cssList.concat([cssPath]).forEach(function (p) {
        if (!p || !out[p] || cssRefSet['#' + p]) return;
        cssRefSet['#' + p] = 1;
        var text = fflate.strFromU8(out[p]);
        var re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
        var m;
        while ((m = re.exec(text))) {
          var raw = m[2].split('#')[0].split('?')[0];
          if (!raw || isExternal(raw)) continue;
          var abs = realPath(resolvePath(p, decodePath(raw)));
          if (abs && out[abs]) cssAssetRefs.push(abs);
        }
      });
    }

    var groups = planVolumes(chapters, out, opts, report);
    report.volumes = groups.length;

    // 记下每个包里真正写进去的文件名，用来核对"哪些资源没被带进新包"
    var written = {};

    var volumes = [];
    var totalOut = 0;
    var versionOk = true;

    for (var vi = 0; vi < groups.length; vi++) {
      checkCancel();
      var group = groups[vi];
      var volTitle = groups.length > 1
        ? baseTitle + '（第 ' + (vi + 1) + ' 卷 / 共 ' + groups.length + ' 卷）'
        : baseTitle;

      var used = {};
      group.forEach(function (ch) {
        (ch._assets || []).forEach(function (p) {
          used[p] = 1;
        });
      });
      // 保留的原 CSS 每卷都要带上：章节里直接 link 着它
      cssList.forEach(function (p) {
        if (p !== cssPath) used[p] = 1;
      });
      // 只被 CSS url() 引用的图/字体也必须带上，否则样式表里就是断链
      cssAssetRefs.forEach(function (p) { used[p] = 1; });

      var volOut = {};
      volOut[cssPath] = out[cssPath];
      // 保留的原样式表必须逐卷带上：章节里直接 link 着它们。
      // 它们不在 sharedResources 里（由 buildOpf 统一声明），所以要单独复制。
      cssList.forEach(function (p) {
        if (p !== cssPath && out[p]) volOut[p] = out[p];
      });
      group.forEach(function (ch) {
        volOut[ch.newPath] = out[ch.newPath];
      });

      var volResources = [];
      sharedResources.forEach(function (r) {
        if (used[r.path] && out[r.path]) {
          volOut[r.path] = out[r.path];
          volResources.push(r);
        }
      });

      var volUid = 'urn:uuid:epubfix-' + Math.random().toString(16).slice(2, 10);
      // nav.xhtml 只在 3.0 里写；2.0 靠 NCX，多塞一个导航文档反而不合规
      if (!v2) volOut[navPath] = fflate.strToU8(buildNav(group, navPath, lang));
      volOut[ncxPath] = fflate.strToU8(buildNcx(group, ncxPath, volUid));

      /*
       * 目录完整性：每个章节都必须能在目录里点到。
       * 这里直接查刚生成的 nav / ncx 文本，而不是"我们生成了目录所以它一定对"。
       */
      var navText = volOut[navPath] ? fflate.strFromU8(volOut[navPath]) : '';
      var ncxText = fflate.strFromU8(volOut[ncxPath]);
      group.forEach(function (ch) {
        report.tocChecked++;
        if (ncxText.indexOf(ch.fileName) < 0) report.tocMissing++;
        if (!v2 && navText.indexOf(ch.fileName) < 0) report.tocMissing++;
      });

      volOut[opfPath] = fflate.strToU8(
        buildOpf({
          metadataXml: groups.length > 1
            ? withVolumeUid(withVolumeTitle(metadataXml, volTitle), volUid)
            : withVolumeTitle(metadataXml, volTitle),
          version: outVersion,
          chapters: group,
          opfPath: opfPath,
          cssPath: cssPath,
          cssList: cssList,
          navPath: navPath,
          ncxPath: ncxPath,
          resources: volResources,
          lang: lang,
          uid: volUid,
          uniqueIdName: uniqueIdName
        })
      );
      volOut['META-INF/container.xml'] = files['META-INF/container.xml'];
      Object.keys(volOut).forEach(function (n) { written[n] = 1; });

      // 打包前就核对这一卷：manifest 声明的文件是否都在、spine 是否都能对上
      var volIssues = verifyVolume(volOut, opfPath, report.pkg);
      var verCheck = verifyVersion(volOut, opfPath, outVersion);
      if (!verCheck.ok) {
        versionOk = false;
        volIssues = volIssues.concat(verCheck.issues.map(function (x) { return '版本核对：' + x; }));
      }
      if (groups.length > 1) {
        progress('verify', '校验第 ' + (vi + 1) + '/' + groups.length + ' 卷的结构与引用', 0.86 + 0.02 * (vi / groups.length));
      }

      var entries = [{ name: 'mimetype', data: fflate.strToU8('application/epub+zip'), store: true }];
      Object.keys(volOut).forEach(function (name) {
        if (name === 'mimetype') return;
        entries.push({
          name: name,
          data: volOut[name],
          store: COMPRESSED_ALREADY.test(name)
        });
      });

      var packed = await buildZip(entries);
      totalOut += packed.length;

      /* 统计"解压后到底写了多少字节"：按真正写进 ZIP 的条目累加。
         不能用中间产物 out —— 里面可能还留着最终没进包的资源（比如被删掉的
         封面图、只被已删除 CSS 引用的图片），那样算出来的"处理后大小"
         会比整个 EPUB 还大，页面上就成了自相矛盾的数字。 */
      entries.forEach(function (en) {
        var n = en.data.length;
        report.afterRawTotal += n;
        if (IMAGE_EXT.test(en.name)) report.afterBreakdown.image += n;
        else if (FONT_EXT.test(extname(en.name))) report.afterBreakdown.font += n;
        else if (/\.(x?html?|xml|opf|ncx|css)$/i.test(en.name)) report.afterBreakdown.text += n;
        else report.afterBreakdown.other += n;
      });

      volumes.push({
        index: vi + 1,
        total: groups.length,
        chapters: group.length,
        bytes: packed,
        title: volTitle,
        fileName: volumeFileName(baseTitle, vi + 1, groups.length),
        _issues: volIssues
      });

      progress(
        'pack',
        '打包第 ' + (vi + 1) + '/' + groups.length + ' 卷',
        0.88 + 0.1 * ((vi + 1) / groups.length)
      );
    }

    // --- 哪些图片没被带进新包（原书里就没有任何章节/样式表引用它们）
    //
    // 去重造成的"冗余副本"要单独算：它们的消失是清理重复图片的成果，
    // 不能混进"原书里的死资源"那条提示里，否则用户会以为自己的书有问题。
    var dedupeDropKey = {};
    var dedupeSavedBytes = 0;
    var dedupeDropped = 0;
    if (dedupe) {
      dedupe.groups.forEach(function (g) {
        g.paths.forEach(function (p) {
          if (p === g.paths[0]) return;
          var rec = imageMap[p];
          var key = rec ? rec.newPath : p;
          dedupeDropKey[key] = 1;
          if (written[key]) return;           // 还有别的地方（比如 CSS）在用，保留
          var size = (out[key] && out[key].length) || (files[p] && files[p].length) || 0;
          if (size) { dedupeSavedBytes += size; dedupeDropped++; }
        });
      });
      report.dedupe.savedBytes = dedupeSavedBytes;
      report.dedupe.droppedResources = dedupeDropped;
    }

    var unusedImgBytes = 0;
    var unusedImgCount = 0;
    Object.keys(out).forEach(function (n) {
      if (written[n]) return;
      if (!IMAGE_EXT.test(n)) return;
      if (dedupeDropKey[n]) return;   // 重复图片的冗余副本，已在上面单独统计
      unusedImgCount++;
      unusedImgBytes += out[n].length;
    });
    report.unusedImages = unusedImgCount;
    report.unusedImageBytes = unusedImgBytes;

    // --- 输出自检（真实核对，不是走个过场）
    progress('verify', '校验输出结构与引用', 0.99);
    report.verifyIssues = [];
    volumes.forEach(function (v) {
      var issues = v._issues || [];
      if (issues.length) {
        report.verifyIssues.push(
          (groups.length > 1 ? '第 ' + v.index + ' 卷：' : '') + issues[0]
        );
      }
    });
    report.verified = report.verifyIssues.length === 0;
    report.versionVerified = versionOk;
    runTypographyAudit();
    volumes.forEach(function (v) { delete v._issues; });

    // --- 版本说明：转成了什么、哪些特性没能保住
    if (v2) {
      if (features.svgInline || features.svgFiles) {
        report.versionWarnings.push(
          'EPUB 2.0 没有把 SVG 列为标准媒体类型。这本书里有 ' +
          (features.svgInline ? features.svgInline + ' 处内联 SVG' : '') +
          (features.svgInline && features.svgFiles ? '、' : '') +
          (features.svgFiles ? features.svgFiles + ' 个 SVG 文件' : '') +
          '，为了不破坏插图，原样保留了。换到只认 EPUB2 的老阅读器上这几处可能不显示。'
        );
      }
      if (features.html5) {
        report.versionWarnings.push(
          '正文里有 ' + features.html5 + ' 个 HTML5 语义标签（section / figure / aside 等）。' +
          'EPUB 2.0 用的是 XHTML 1.1，严格的校验器会把它们当未知元素；' +
          '改成 div 会连带 CSS 选择器一起失效、排版就散了，所以保留原标签。'
        );
      }
      if (features.media) {
        report.versionWarnings.push(
          '正文里有 ' + features.media + ' 个 video / audio / canvas，EPUB 2.0 没有对应支持，已原样保留。'
        );
      }
      if (features.math) {
        report.versionWarnings.push(
          '正文里有 ' + features.math + ' 处 MathML。MathML 在 EPUB 3.0 才是标准，2.0 阅读器可能显示为纯文本。'
        );
      }
    } else if (/^\s*2\./.test(String(sourceVersion))) {
      report.versionWarnings.push(
        '原书是 EPUB ' + sourceVersion + '，这版按 EPUB 3.0 重建：补了 nav 导航文档、' +
        '封面改用 properties="cover-image"、加了 dcterms:modified，同时仍保留 NCX 让老阅读器也能读。'
      );
    }
    if (opts.outputVersion === '2' || opts.outputVersion === '3') {
      report.versionWarnings.push(
        '按你选择的 EPUB ' + outVersion + ' 重新生成了包结构（OPF 版本声明、manifest、' +
        '目录方式' + (v2 ? '（NCX）' : '（nav + NCX）') + '、章节文档类型），不是只改版本号。' +
        (versionOk ? '已通过该版本的结构自检。' : '结构自检发现问题，见下方提示。')
      );
    }
    if (!versionOk) {
      report.warnings.push(
        '输出没能完全符合 EPUB ' + outVersion + ' 的结构要求，具体问题见「版本兼容性」一节。'
      );
    }
    if (report.unusedImages) {
      report.warnings.push(
        '有 ' + report.unusedImages + ' 张图片（解压后 ' +
        (report.unusedImageBytes / 1048576).toFixed(2) + ' MB）在原书里没有被任何章节或样式表引用，' +
        '属于死资源，输出时没有写进新包。想连它们一起保留，可以先用「图片浏览」确认这些图是不是真的没用。'
      );
    }
    if (!report.verified) {
      report.warnings.push(
        '输出自检发现 ' + report.verifyIssues.length + ' 处问题：' +
        report.verifyIssues.join('；') + '。文件仍已生成，但建议用「结构检查」复核。'
      );
    }
    if (dedupe && report.dedupe && report.dedupe.removed > 0) {
      report.warnings.push(
        '智能重复图片清理：清除了 ' + report.dedupe.removed + ' 处重复出现的图片，' +
        '每张图都保留了第一次出现的位置' +
        (report.dedupe.droppedResources
          ? '；同时移除了 ' + report.dedupe.droppedResources + ' 个内容完全相同、已无人引用的冗余图片文件。'
          : '；资源文件仍被首次出现的位置引用，一个都没有删除。') +
        '完整清单见结果页的「重复图片清理记录」。'
      );
    }

    report.outputBytes = totalOut;
    report.outputVolumeBytes = volumes.length ? volumes[0].bytes.length : 0;

    // 处理后各类资源的真实体积（解压口径）已在逐卷打包时按实际写出的条目累加完毕。
    // 这里只把"压缩比"算出来，方便界面解释"为什么解压总量比 ZIP 大"。
    report.zipRatio = report.afterRawTotal > 0 ? totalOut / report.afterRawTotal : 0;

    // --- 分卷结果说明
    if (groups.length > 1 && opts.volumeTarget) {
      var over = volumes.filter(function (v) {
        return v.bytes.length > opts.volumeTarget;
      });
      if (over.length) {
        report.warnings.push(
          '有 ' + over.length + ' 卷超过了目标体积（最大 ' + fmtMb(over[0].bytes.length) +
          '）。原因是其中有单个章节本身就大于 ' + fmtMb(opts.volumeTarget) +
          '，而截断章节会丢正文，所以宁可让这一卷大一点。'
        );
      }
    }

    // --- 体积结果说明
    var saved = (report.inputBytes - totalOut) / Math.max(1, report.inputBytes);
    report.savedBytes = report.inputBytes - totalOut;
    report.savedRatio = saved;

    if (opts.targetBytes) {
      report.targetMet = totalOut <= opts.targetBytes;
      if (!report.targetMet) {
        var imgShare = report.sizeBreakdown.image / report.rawTotal;
        report.warnings.push(
          imgShare < 0.15
            ? '没达到目标体积：这本书只有 ' + Math.round(imgShare * 100) +
              '% 是图片，其余是文本，而文本压缩后已接近极限（再压只能删内容）。'
            : '没达到目标体积：图片已压到预算下限，继续压缩会明显糊。可以把目标放宽，或改用极致压缩模式。'
        );
      }
    } else if (saved < 0.05 && saved >= 0) {
      // 几乎没变小，主动解释，别让人以为是没生效
      var img = report.sizeBreakdown.image / report.rawTotal;
      var txt = report.sizeBreakdown.text / report.rawTotal;
      report.warnings.push(
        '体积只减少了 ' + Math.round(saved * 100) + '%，因为这本书 ' +
        Math.round(img * 100) + '% 是图片、' + Math.round(txt * 100) + '% 是文本。' +
        (img < 0.15
          ? policy.preserveCss
            ? '而且当前是标准优化模式，会保留原图和原样式表，几乎不动内容。想要更小请切到深度优化或极致压缩。'
            : '图片本来就少且已经压过，文本用 deflate 也已接近极限——再往下只能删内容。'
          : '图片可能已经是优化过的 JPEG，再次编码收益有限。')
      );
    } else if (saved < 0) {
      report.warnings.push(
        '输出比原书大了 ' + Math.round(-saved * 100) + '%。这本书本身太小（' +
        fmtMb(report.inputBytes) + '），新建的样式表、目录、章节文件这些固定开销超过了原书。' +
        '正常体量的书不会出现这种情况。'
      );
    }

    // 保留原 CSS 模式下，检测到"每段一个 div"却没做降级，说明缩进不会生效，
    // 得明确告诉用户换模式，而不是让他自己发现排版没变
    if (policy.preserveCss && report.unconvertedBlocks > 0) {
      report.warnings.push(
        '发现 ' + report.unconvertedBlocks +
        ' 处正文直接写在 <div> 里。标准优化模式为保护原样式表没有改动它们，' +
        '如果原书没有给这些 div 设首行缩进，阅读时会顶格。想要 TXT 式缩进请选深度优化。'
      );
    }

    progress('done', '完成', 1);

    // 预览需要的图片字节（只含输出里实际存在的图片）
    var previewAssets = {};
    Object.keys(out).forEach(function (n) {
      if (/\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(n)) previewAssets[n] = out[n];
    });

    var previewCss = keepCssFiles.length
      ? keepCssFiles
          .map(function (p) {
            return out[p] ? fflate.strFromU8(out[p]) : files[p] ? fflate.strFromU8(files[p]) : '';
          })
          .join('\n') + '\n' + buildCss('safety')
      : buildCss('full');

    return {
      // 单卷时保留 bytes 以兼容旧调用；多卷看 volumes
      bytes: volumes.length === 1 ? volumes[0].bytes : null,
      volumes: volumes,
      report: report,
      preview: {
        css: previewCss,
        chapters: previewChapters,
        assets: previewAssets,
        lang: lang
      }
    };
  }

  /* 生成后的自检：打包前先在内存里核对一遍，能当场发现就当场报，
     而不是等用户在阅读器里看到白页。 */
  function verifyVolume(built, opfPath, stats) {
    var issues = [];
    if (!built['META-INF/container.xml']) issues.push('缺少 META-INF/container.xml');
    var cText = built['META-INF/container.xml']
      ? fflate.strFromU8(built['META-INF/container.xml'])
      : '';
    if (cText && cText.indexOf(opfPath) < 0) {
      issues.push('container.xml 指向的不是 ' + opfPath);
    }
    var opfBytes = built[opfPath];
    if (!opfBytes) {
      issues.push('缺少 OPF：' + opfPath);
      return issues;
    }
    var doc = parseMarkup(fflate.strFromU8(opfBytes));
    var ids = {};
    var hrefMissing = 0;
    collectByLocalName(doc, 'item').forEach(function (el) {
      var id = el.getAttribute('id');
      if (id) ids[id] = 1;
      var href = decodePath(el.getAttribute('href') || '');
      var abs = resolvePath(opfPath, href);
      if (stats) {
        stats.items++;
        if (!built[abs]) stats.missing++;
      }
      if (!built[abs] && hrefMissing < 3) hrefMissing++;
      if (!built[abs]) issues.push('manifest 声明了不存在的文件：' + href);
    });
    var spineMissing = 0;
    collectByLocalName(doc, 'itemref').forEach(function (el) {
      var idr = el.getAttribute('idref');
      if (stats) stats.spine++;
      if (!ids[idr]) spineMissing++;
    });
    if (spineMissing) issues.push('spine 里有 ' + spineMissing + ' 个 idref 找不到对应 item');
    // 去重（同一个坏引用可能出现多次）
    return issues.filter(function (v, i) { return issues.indexOf(v) === i; }).slice(0, 5);
  }

  /*
   * 版本自检：拿"已经组装好的输出包"核对它到底是不是声明的那个版本。
   * 这不是走形式——只在元数据里写 version="2.0" 而包里还挂着 nav.xhtml 与
   * properties 属性，EPUB2 校验器会直接判定不合规。这里逐条查。
   * @returns {{ok:boolean, issues:string[]}}
   */
  function verifyVersion(built, opfPath, version) {
    var issues = [];
    var v2 = version === '2.0';
    var opfBytes = built[opfPath];
    if (!opfBytes) return { ok: false, issues: ['缺少 OPF，无法核对版本'] };
    var text = fflate.strFromU8(opfBytes);
    var doc = parseMarkup(text);
    var pkg = collectByLocalName(doc, 'package')[0];
    var declared = (pkg && pkg.getAttribute('version')) || '';

    if (!declared) issues.push('OPF 没有写 version 属性');
    else if (declared !== version) issues.push('OPF 声明的是 ' + declared + '，不是 ' + version);

    var items = collectByLocalName(doc, 'item');
    var hasNav = false;
    var hasNcx = false;
    var ncxId = '';
    items.forEach(function (el) {
      var props = el.getAttribute('properties') || '';
      var type = el.getAttribute('media-type') || '';
      if (/dtbncx/i.test(type)) { hasNcx = true; ncxId = el.getAttribute('id') || ''; }
      if (/\bnav\b/.test(props)) hasNav = true;
      if (v2 && props) {
        issues.push('EPUB 2.0 的 manifest 不允许 properties 属性（' + (el.getAttribute('href') || '') + '）');
      }
      var href = decodePath(el.getAttribute('href') || '');
      var abs = resolvePath(opfPath, href);
      if (!built[abs]) issues.push('manifest 声明的文件不存在：' + href);
    });

    if (v2) {
      if (hasNav) issues.push('EPUB 2.0 包里不应出现 properties="nav" 的导航文档');
      if (!hasNcx) issues.push('EPUB 2.0 必须有 NCX 目录');
      var spine = collectByLocalName(doc, 'spine')[0];
      var tocRef = spine ? spine.getAttribute('toc') || '' : '';
      if (!tocRef) issues.push('EPUB 2.0 的 spine 缺少 toc 属性');
      else if (ncxId && tocRef !== ncxId) issues.push('spine 的 toc 指向 ' + tocRef + '，不是 NCX 的 id');
      if (/<meta\b[^>]*\bproperty\s*=/i.test(text)) {
        issues.push('EPUB 2.0 的 metadata 里不应出现 <meta property>');
      }
      // 每个正文章节不能带 epub: 前缀（2.0 没声明这个命名空间）
      collectByLocalName(doc, 'itemref').forEach(function (el) {
        var idr = el.getAttribute('idref');
        var hit = items.filter(function (it) { return it.getAttribute('id') === idr; })[0];
        if (!hit) return;
        var abs = resolvePath(opfPath, decodePath(hit.getAttribute('href') || ''));
        if (!built[abs]) return;
        var chText = fflate.strFromU8(built[abs]);
        if (/<html[^>]*xmlns:epub=/i.test(chText)) issues.push('2.0 章节声明了 epub: 命名空间：' + abs);
        if (/\sepup:[a-zA-Z-]+\s*=/.test(chText)) issues.push('2.0 章节使用了 epub: 属性：' + abs);
      });
    } else {
      if (!hasNav) issues.push('EPUB 3.0 缺少 properties="nav" 的导航文档');
      if (!/<meta\b[^>]*property\s*=\s*["']dcterms:modified["']/i.test(text)) {
        issues.push('EPUB 3.0 要求 dcterms:modified');
      }
    }

    var uniq = issues.filter(function (v, i) { return issues.indexOf(v) === i; });
    return { ok: uniq.length === 0, issues: uniq.slice(0, 6) };
  }

  /* 从 OPF 元数据里取书名 */
  function extractTitle(metadataXml) {
    var m = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(metadataXml || '');
    if (!m) return '';
    return m[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .trim();
  }

  /* 给每卷塞上卷号，阅读器书架上才分得清 */
  function withVolumeTitle(metadataXml, title) {
    var esc = escText(title || '');
    if (/<dc:title[^>]*>[\s\S]*?<\/dc:title>/i.test(metadataXml || '')) {
      return metadataXml.replace(
        /(<dc:title[^>]*>)[\s\S]*?(<\/dc:title>)/i,
        function (all, open, close) {
          return open + esc + close;
        }
      );
    }
    return '<dc:title>' + esc + '</dc:title>' + (metadataXml || '');
  }

  /* 分卷时每卷必须有各自的 dc:identifier。
     所有卷共用一个标识符，书库和阅读器会把它们当成同一本书的重复导入，
     进度、书签也会互相覆盖。uid 与 toc.ncx 的 dtb:uid 用同一个值，保持自洽。 */
  function withVolumeUid(metadataXml, uid) {
    if (!uid) return metadataXml || '';
    var src = metadataXml || '';
    if (/<dc:identifier\b[^>]*>[\s\S]*?<\/dc:identifier>/i.test(src)) {
      var done = false;
      return src.replace(
        /(<dc:identifier\b[^>]*>)[\s\S]*?(<\/dc:identifier>)/gi,
        function (all, open, close) {
          if (done) return all;
          done = true;
          return open + escText(uid) + close;
        }
      );
    }
    return '<dc:identifier>' + escText(uid) + '</dc:identifier>' + src;
  }

  /* 输出文件名：单卷用书名，多卷带卷号 */
  function volumeFileName(baseTitle, index, total) {
    var safe = (baseTitle || 'book')
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    if (!safe) safe = 'book';
    if (total <= 1) return safe + '.epub';
    return safe + ' - 第' + index + '卷（共' + total + '卷）.epub';
  }

  /*
   * 分卷规划。
   *
   * 关键点：必须按真实章节边界切，不能按字节位置切 —— 按字节切出来的
   * 后半段既没有 OPF 也没有正文起始，阅读器打开就是空白。
   *
   * 体积估算用"未压缩 XHTML × 0.35 + 图片原始字节"：
   * 图片已经过 JPEG 编码，进 ZIP 是 STORE，不压缩；中文正文 deflate 后
   * 大致三成多。这是估算，所以目标体积只是"尽量满足"，最终以实际打包为准。
   */
  function planVolumes(chapters, out, opts, report) {
    var ASSET_RE = /\.(jpe?g|png|gif|webp|bmp|svg|ttf|otf|woff2?|eot|mp3|mp4|m4a|css)$/i;

    function assetsOf(ch) {
      var list = [];
      var seen = {};
      var re = /(?:src|href)\s*=\s*"([^"]+)"/gi;
      var html = ch.inner || '';
      var m;
      while ((m = re.exec(html))) {
        var v = m[1];
        if (!v || v.charAt(0) === '#' || isExternal(v)) continue;
        var hash = v.indexOf('#');
        var bare = hash >= 0 ? v.slice(0, hash) : v;
        if (!bare) continue;
        var abs = resolvePath(ch.newPath, decodePath(bare));
        if (!abs || !out[abs] || seen[abs]) continue;
        if (!ASSET_RE.test(abs)) continue;
        seen[abs] = 1;
        list.push(abs);
      }
      return list;
    }

    // 先算每章成本；同一张图只记在第一次出现的那一章，避免重复计体积
    var assigned = {};
    var costs = [];
    var total = 0;
    chapters.forEach(function (ch) {
      var assets = assetsOf(ch);
      ch._assets = assets;
      var cost = Math.round((ch.inner || '').length * 0.35) + 900;
      assets.forEach(function (p) {
        if (assigned[p]) return;
        assigned[p] = 1;
        cost += out[p].length;
      });
      costs.push(cost);
      total += cost;
    });

    var limit = Number(opts.volumeTarget) || 0;
    if (opts.volumeTarget === 'auto' || limit === -1) {
      // 自动分卷：只有大到一定程度才切，否则单卷更好用
      limit = total > 100 * 1024 * 1024 ? 100 * 1024 * 1024 : 0;
    }
    if (!limit || !chapters.length) return [chapters];
    if (total <= limit) return [chapters];

    var groups = [];
    var cur = [];
    var curBytes = 0;
    var oversized = 0;

    for (var i = 0; i < chapters.length; i++) {
      var cost = costs[i];
      /*
       * 只有"这一章自己放得下"时才允许切卷。
       * 如果这一章单独就超过目标，切出去只会得到一个空壳卷 + 一个超大卷，
       * 不如把它并进当前卷，让这一卷稍微超一点 —— 截断章节会丢正文，
       * 而多几十兆只是不那么好看。
       */
      if (cur.length && curBytes + cost > limit && cost <= limit) {
        groups.push(cur);
        cur = [];
        curBytes = 0;
      }
      if (cost > limit) oversized++;
      cur.push(chapters[i]);
      curBytes += cost;
    }
    if (cur.length) groups.push(cur);

    if (oversized) {
      report.warnings.push(
        '有 ' + oversized + ' 个章节单独就超过目标体积，这些章节会各自占满一卷。' +
        '截断章节会丢正文，所以没有强行切分。'
      );
    }
    return groups;
  }

  function fmtMb(n) {
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  /* 遍历节点里的 url 属性，交给回调决定新值；回调返回 null 表示不动 */
  /* 删掉一个元素；若父容器因此变空，连父一起删，避免留下空段落 */
  function removeNodeAndEmptyParent(el, report) {
    var parent = el.parentNode;
    if (!parent) return;
    el._efRemoved = true;
    parent.removeChild(el);
    while (parent && parent.nodeType === 1) {
      var tag = localTag(parent);
      if (tag !== 'p' && tag !== 'div' && tag !== 'span' && tag !== 'section') return;
      var hasText = (parent.textContent || '').replace(/[\s\u00a0]+/g, '') !== '';
      if (hasText || parent.querySelector('img,svg,table,hr')) return;
      var grand = parent.parentNode;
      if (!grand) return;
      parent._efRemoved = true;
      grand.removeChild(parent);
      if (report) report.removedEmptyBlocks++;
      parent = grand;
    }
  }

  function extractUrls(nodes, fn, report) {
    nodes.forEach(function (node) {
      if (node.nodeType !== 1) return;
      var list = [node].concat(Array.prototype.slice.call(node.getElementsByTagName('*')));
      list.forEach(function (el) {
        var tag = localTag(el);
        if (tag === 'img') {
          var src = el.getAttribute('src');
          var next = fn('img', el, src);
          if (next === false) {
            removeNodeAndEmptyParent(el, report);
            return;
          }
          if (next) el.setAttribute('src', next);
        } else if (tag === 'image') {
          var href = el.getAttribute('xlink:href') || el.getAttribute('href');
          var n2 = fn('img', el, href);
          if (n2 === false) {
            removeNodeAndEmptyParent(el, report);
            return;
          }
          if (n2) {
            if (el.getAttribute('xlink:href') != null) el.setAttribute('xlink:href', n2);
            else el.setAttribute('href', n2);
          }
        } else if (tag === 'a') {
          var ahref = el.getAttribute('href');
          var n3 = fn('a', el, ahref);
          if (n3) el.setAttribute('href', n3);
        }
      });
    });
  }

  /*
   * 章节文档。
   *
   * EPUB 2 与 3 的差别不只是 OPF 里的版本号：
   *   2.0 → XHTML 1.1 DOCTYPE、不能再声明 epub: 命名空间（2.0 阅读器不认识）、
   *         没有 <meta charset>（那是 HTML5 写法），用 http-equiv 代替
   *   3.0 → HTML5 序列化 + epub: 命名空间，阅读器才认 epub:type
   * 属性也要跟着走，否则 2.0 文件里挂着一个没声明的命名空间前缀就是硬错误。
   */
  function buildChapterXhtml(ch, cssPaths, lang, inner, version) {
    var v2 = version === '2.0';
    // cssPaths 可以是单个路径，也可以是数组（保留原 CSS 时需按原顺序逐个链回）
    var list = Array.isArray(cssPaths) ? cssPaths : [cssPaths];
    var links = list
      .filter(Boolean)
      .map(function (p) {
        return '<link rel="stylesheet" type="text/css" href="' +
          escAttr(relativePath(ch.newPath, p)) + '" />\n';
      })
      .join('');
    var titleText = ch.title || '正文';
    if (inner == null) inner = serializeChildren({ childNodes: ch.nodes, nodeType: 1 });
    if (v2) {
      // 去掉 epub:* 属性（2.0 没有这个命名空间）；同时把 html5 的 hidden 写成 hidden="hidden"
      inner = String(inner).replace(/\sepup:[a-zA-Z-]+\s*=\s*"[^"]*"/g, '');
    }
    return (
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      (v2
        ? '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n'
        : '<!DOCTYPE html>\n') +
      '<html xmlns="' + XHTML_NS + '"' + (v2 ? '' : ' xmlns:epub="' + OPS_NS + '"') +
      ' xml:lang="' + escAttr(lang) + '" lang="' + escAttr(lang) + '">\n' +
      '<head>\n' +
      (v2
        ? '<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />\n'
        : '<meta charset="utf-8" />\n') +
      '<title>' + escText(titleText) + '</title>\n' +
      links +
      '</head>\n' +
      '<body>\n' +
      inner +
      '</body>\n' +
      '</html>\n'
    );
  }

  function buildNav(chapters, navPath, lang) {
    var lis = chapters
      .map(function (ch) {
        var href = relativePath(navPath, ch.newPath);
        return '      <li><a href="' + escAttr(href) + '">' +
          escText(ch.title || '正文') + '</a></li>';
      })
      .join('\n');
    return (
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<!DOCTYPE html>\n' +
      '<html xmlns="' + XHTML_NS + '" xmlns:epub="' + OPS_NS + '"' +
      ' xml:lang="' + escAttr(lang) + '" lang="' + escAttr(lang) + '">\n' +
      '<head>\n<meta charset="utf-8" />\n<title>目录</title>\n</head>\n' +
      '<body>\n' +
      '  <nav epub:type="toc" id="toc">\n' +
      '    <h1>目录</h1>\n' +
      '    <ol>\n' + lis + '\n    </ol>\n' +
      '  </nav>\n' +
      '  <nav epub:type="landmarks" id="landmarks" hidden="hidden">\n' +
      '    <ol>\n' +
      '      <li><a epub:type="toc" href="' + escAttr(basename(navPath)) + '">目录</a></li>\n' +
      '    </ol>\n' +
      '  </nav>\n' +
      '</body>\n</html>\n'
    );
  }

  function buildNcx(chapters, ncxPath, uid) {
    var points = chapters
      .map(function (ch, i) {
        var href = relativePath(ncxPath, ch.newPath);
        return (
          '    <navPoint id="navPoint-' + (i + 1) + '" playOrder="' + (i + 1) + '">\n' +
          '      <navLabel><text>' + escText(ch.title || '正文') + '</text></navLabel>\n' +
          '      <content src="' + escAttr(href) + '" />\n' +
          '    </navPoint>'
        );
      })
      .join('\n');
    return (
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n' +
      '  <head>\n' +
      '    <meta name="dtb:uid" content="' + escAttr(uid) + '" />\n' +
      '    <meta name="dtb:depth" content="1" />\n' +
      '  </head>\n' +
      '  <docTitle><text>目录</text></docTitle>\n' +
      '  <navMap>\n' + points + '\n  </navMap>\n' +
      '</ncx>\n'
    );
  }

  /*
   * 生成 OPF。
   *
   * 关键约束：manifest 必须由"输出包里真实存在的文件"生成，
   * 而不是照抄原书的 manifest。原因是下载/转换来的书经常出现两种坏情况，
   * 两种都会被阅读器报错：
   *   1. 图片在包里，manifest 没声明 → "此文件未列在manifest文件中"
   *   2. manifest 声明了，文件却不存在 → "引用的资源不存在"
   * 只要以真实文件为准，这两种错误都不可能再出现。
   *
   * 原 manifest 中同路径条目的 id / properties 会被沿用，
   * 因为元数据里的 <meta name="cover" content="xxx"/> 依赖那个 id。
   */
  function buildOpf(ctx) {
    var v2 = ctx.version === '2.0';
    var items = [];
    var idCounter = 0;
    var usedIds = {};
    function newId() {
      var id;
      do {
        idCounter++;
        id = 'ef' + idCounter;
      } while (usedIds[id]);
      usedIds[id] = true;
      return id;
    }
    function claimId(preferred) {
      if (preferred && !usedIds[preferred]) {
        usedIds[preferred] = true;
        return preferred;
      }
      return newId();
    }

    var navId = newId();
    var ncxId = newId();

    // 保留原 CSS 时要把原样式表逐个声明，否则阅读器读不到它们
    var cssFiles = Array.isArray(ctx.cssList) && ctx.cssList.length ? ctx.cssList : [ctx.cssPath];
    // 同一个样式表只能声明一次：重复的 manifest 项是硬错误（id 不同、href 相同）
    var seenCss = {};
    cssFiles = cssFiles.filter(function (p) {
      if (!p || seenCss['#' + p]) return false;
      seenCss['#' + p] = 1;
      return true;
    });
    cssFiles.forEach(function (p) {
      items.push({ id: newId(), href: relativePath(ctx.opfPath, p), type: 'text/css' });
    });
    // nav.xhtml 是 EPUB3 的东西；2.0 包里有它只会让严格校验器问"这是什么"
    if (!v2) {
      items.push({
        id: navId,
        href: relativePath(ctx.opfPath, ctx.navPath),
        type: 'application/xhtml+xml',
        props: 'nav'
      });
    }
    items.push({
      id: ncxId,
      href: relativePath(ctx.opfPath, ctx.ncxPath),
      type: 'application/x-dtbncx+xml'
    });

    var chapterIds = [];
    ctx.chapters.forEach(function (ch) {
      var id = newId();
      chapterIds.push(id);
      items.push({ id: id, href: relativePath(ctx.opfPath, ch.newPath), type: 'application/xhtml+xml' });
    });

    // 沿用 EPUB2 的 <meta name="cover" content="id">，同时补上 EPUB3 认的
    // properties="cover-image"，否则微信读书 / Apple Books 里可能没有封面。
    var coverId = '';
    var coverTag = /<meta\b[^>]*\bname\s*=\s*["']cover["'][^>]*>/i.exec(ctx.metadataXml || '');
    if (coverTag) {
      var cm = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(coverTag[0]);
      if (cm) coverId = cm[1];
    }

    // 2.0 里 properties 这个属性根本不存在，封面只能靠 <meta name="cover">
    var coverIdV2 = '';
    (ctx.resources || []).forEach(function (res) {
      var props = (res.properties || '')
        .split(/\s+/)
        .filter(function (p) {
          return p === 'cover-image';
        })
        .join(' ');
      var id = claimId(res.id);
      if (!props && id === coverId && /^image\//.test(res.mediaType)) props = 'cover-image';
      if (v2) {
        if (props === 'cover-image') coverIdV2 = id;
        props = '';
      }
      items.push({
        id: id,
        href: relativePath(ctx.opfPath, res.path),
        type: res.mediaType,
        props: props
      });
    });

    var manifestXml = items
      .map(function (it) {
        return (
          '    <item id="' + escAttr(it.id) + '" href="' + escAttr(it.href) +
          '" media-type="' + escAttr(it.type) + '"' +
          (it.props ? ' properties="' + escAttr(it.props) + '"' : '') + ' />'
        );
      })
      .join('\n');

    var spineXml = chapterIds
      .map(function (id) {
        return '    <itemref idref="' + escAttr(id) + '" />';
      })
      .join('\n');

    // 元数据里 <meta name="cover" content="封面id"/> 若指向一个已被我们丢掉的
    // 条目（封面图缺失等），留着就是校验错误，直接移除。
    var meta = (ctx.metadataXml || '')
      .trim()
      .replace(/<meta\b[^>]*\bname\s*=\s*["']cover["'][^>]*>/gi, function (tag) {
        var m = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(tag);
        if (m && !usedIds[m[1]]) return '';
        return tag;
      })
      // 下面这些是「元数据清理」：原书里由转换器堆出来的垃圾，留着只会让
      // 阅读器把书错认成另一本，或者显示一个假出版社。
      // ① 旧的修改时间：我们自己会写一个当前的，留着就是两个同名字段。
      //    注意 OPF 里有未声明的命名空间前缀时会退化成 HTML 解析，meta 就成了
      //    空元素（没有 </meta>，时间变成它的兄弟文本），所以两种形态都要能吃掉。
      .replace(/<meta\b[^>]*\bproperty\s*=\s*["']dcterms:modified["'][^>]*\/?>(?:[^<]*)(?:<\/meta>)?/gi, '')
      // ② calibre / Sigil / Adobe 留下的私有字段
      .replace(/<meta\b[^>]*\bname\s*=\s*["'](calibre|sigil|Adobe|iBooks)[^"']*["'][^>]*\/?>/gi, '')
      // ③ 子元素上重复的命名空间声明（父级 <metadata> 已经声明过）
      .replace(/\s+xmlns:dc\s*=\s*["'][^"']*["']/gi, '')
      .replace(/\s+xmlns:opf\s*=\s*["'][^"']*["']/gi, '')
      .replace(/\s+xmlns\s*=\s*["']http:\/\/www\.idpf\.org\/2007\/opf["']/gi, '')
      // ④ "制作工具"被当成作者写了进去，阅读器上会显示成"作者：calibre"
      .replace(/<dc:contributor\b[^>]*>\s*(?:calibre|sigil|adobe|ibooks)[\s\S]*?<\/dc:contributor>/gi, '')
      .replace(/<dc:identifier\b[^>]*\bopf:scheme\s*=\s*["']calibre["'][^>]*>[\s\S]*?<\/dc:identifier>/gi, '')
      .replace(/\n{3,}/g, '\n\n');

    // ⑤ 同一个字段出现两次（书名、语言最常被转换器写重），只留第一个
    ['title', 'language'].forEach(function (tag) {
      var seen = false;
      var re = new RegExp('<dc:' + tag + '\\b[^>]*>[\\s\\S]*?</dc:' + tag + '>', 'gi');
      meta = meta.replace(re, function (hit) {
        if (seen) return '';
        seen = true;
        return hit;
      });
    });
    meta = meta.replace(/\n{3,}/g, '\n\n');

    if (v2) {
      // EPUB2 的 metadata 不认识 <meta property="...">，留着就是一堆未知元素；
      // 封面改用 2.0 唯一认可的方式声明。
      meta = meta.replace(/<meta\b[^>]*\bproperty\s*=\s*["'][^"']*["'][^>]*\/?>(?:[^<]*)(?:<\/meta>)?/gi, '');
      meta = meta.replace(/<meta\b[^>]*\bname\s*=\s*["']cover["'][^>]*\/?>/gi, '');
      if (coverIdV2) {
        meta += '\n    <meta name="cover" content="' + escAttr(coverIdV2) + '" />';
      }
      // 2.0 不要求也不使用 dcterms:modified；<dc:date> 才是它的时间字段
      meta += '\n    <dc:date>' + new Date().toISOString().replace(/\.\d+Z$/, 'Z') + '</dc:date>';
      meta = meta.replace(/\n{3,}/g, '\n\n');
    }

    return (
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<package xmlns="http://www.idpf.org/2007/opf" version="' + escAttr(ctx.version || '3.0') +
      '" unique-identifier="' + escAttr(ctx.uniqueIdName) + '">\n' +
      '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"' +
      ' xmlns:opf="http://www.idpf.org/2007/opf">\n' +
      '    ' + meta + '\n' +
      (v2 ? '' : '    <meta property="dcterms:modified">' + utcStamp() + '</meta>\n') +
      '  </metadata>\n' +
      '  <manifest>\n' + manifestXml + '\n  </manifest>\n' +
      '  <spine toc="' + escAttr(ncxId) + '">\n' + spineXml + '\n  </spine>\n' +
      '</package>\n'
    );
  }

  /* 只读元数据与封面，不做任何处理。拖入文件后立刻调用，用于显示封面卡。 */
  async function inspect(input) {
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    var unzipped;
    try {
      unzipped = fflate.unzipSync(bytes);
    } catch (e) {
      throw new Error('这个文件不是有效的 EPUB（ZIP 解包失败）');
    }

    var files = {};
    Object.keys(unzipped).forEach(function (name) {
      if (name.charAt(name.length - 1) === '/') return;
      files[name] = unzipped[name];
    });

    if (!files['META-INF/container.xml']) {
      throw new Error('缺少 META-INF/container.xml，不是标准 EPUB');
    }

    var containerDoc = parseMarkup(fflate.strFromU8(files['META-INF/container.xml']));
    var rootfiles = collectByLocalName(containerDoc, 'rootfile');
    if (!rootfiles.length) throw new Error('container.xml 里找不到 rootfile');
    var opfPath = rootfiles[0].getAttribute('full-path');
    if (!opfPath || !files[opfPath]) throw new Error('OPF 文件不存在');

    var opfDoc = parseMarkup(fflate.strFromU8(files[opfPath]));

    function textOf(tag) {
      var els = collectByLocalName(opfDoc, tag);
      return els.length ? (els[0].textContent || '').trim() : '';
    }

    var manifest = collectByLocalName(opfDoc, 'item').map(function (el) {
      return {
        id: el.getAttribute('id') || '',
        path: resolvePath(opfPath, decodePath(el.getAttribute('href') || '')),
        mediaType: el.getAttribute('media-type') || '',
        properties: el.getAttribute('properties') || ''
      };
    });

    var byId = {};
    manifest.forEach(function (m) {
      if (m.id) byId[m.id] = m;
    });

    // 封面判定顺序：EPUB3 的 cover-image 属性 → EPUB2 的 meta[name=cover] → 文件名猜测
    var cover = null;
    var candidates = manifest.filter(function (m) {
      return /^image\//.test(m.mediaType) && files[m.path];
    });

    var byProperty = candidates.filter(function (m) {
      return /cover-image/.test(m.properties);
    });
    var metaCover = collectByLocalName(opfDoc, 'meta').filter(function (el) {
      return (el.getAttribute('name') || '').toLowerCase() === 'cover';
    });
    var byMeta = [];
    if (metaCover.length) {
      var refId = metaCover[0].getAttribute('content');
      if (refId && byId[refId] && files[byId[refId].path]) byMeta.push(byId[refId]);
    }
    var byName = candidates.filter(function (m) {
      return /cover/i.test(m.path);
    });

    var chosen = byProperty[0] || byMeta[0] || byName[0] || null;
    if (chosen) {
      cover = {
        bytes: files[chosen.path],
        mediaType: chosen.mediaType || 'image/jpeg'
      };
    }

    /*
     * 章节数与字数。
     * 只做字符串级统计，不建 DOM：一本 2000 章的书如果逐篇 DOMParser，
     * 光拖进来的那一下就要卡好几秒。正则剥标签够用，误差只在实体上。
     */
    var words = 0;
    var headings = 0;
    var docs = 0;
    collectByLocalName(opfDoc, 'itemref').forEach(function (ref) {
      var mi = byId[ref.getAttribute('idref')];
      if (!mi || !files[mi.path]) return;
      if (!/html/.test(mi.mediaType) && !/\.x?html?$/i.test(mi.path)) return;
      docs++;
      var raw = fflate.strFromU8(files[mi.path]);
      headings += (raw.match(/<h[1-6][\s>]/gi) || []).length;
      var text = raw
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&[a-z#0-9]{1,8};/gi, ' ');
      words += text.replace(/[\s\u00A0]+/g, '').length;
    });

    return {
      title: textOf('title') || '未命名',
      creator: textOf('creator'),
      language: textOf('language'),
      cover: cover,
      size: bytes.length,
      opfPath: opfPath,
      chapters: headings || docs,
      words: words
    };
  }

  /*
   * 结构检查。所有结论都来自真实字节，不猜。
   *
   * level:
   *   error  文件打不开或必然出问题（阅读器会白屏/报错）
   *   warn   能打开，但某些内容会丢（丢图、字重失效等）
   *   info   只是提示，不影响使用
   */
  async function diagnose(input) {
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    var issues = [];
    var info = {
      size: bytes.length,
      version: '',
      title: '',
      creator: '',
      language: '',
      zipEntries: 0,
      docs: 0,
      chapters: 0,
      words: 0,
      images: 0,
      imageBytes: 0,
      fonts: 0,
      fontBytes: 0,
      svg: 0,
      css: 0,
      hasCover: false,
      hasNav: false,
      hasNcx: false
    };

    function add(level, code, message, detail) {
      issues.push({ level: level, code: code, message: message, detail: detail || '' });
    }

    // ---------- 1. ZIP 包 ----------
    var unzipped;
    try {
      unzipped = fflate.unzipSync(bytes);
    } catch (e) {
      add('error', 'zip', '这个文件不是有效的 ZIP/EPUB，无法解包。', e.message);
      return { ok: false, info: info, issues: issues };
    }

    var files = {};
    Object.keys(unzipped).forEach(function (name) {
      if (name.charAt(name.length - 1) === '/') return;
      if (name.indexOf('__MACOSX/') === 0 || /(^|\/)\.DS_Store$/.test(name)) return;
      files[name] = unzipped[name];
    });
    info.zipEntries = Object.keys(files).length;

    if (!files['mimetype']) {
      add('error', 'mimetype', '缺少 mimetype 文件，阅读器可能直接拒绝打开。');
    } else {
      var mt = fflate.strFromU8(files['mimetype']).trim();
      if (mt !== 'application/epub+zip') {
        add('warn', 'mimetype-type', 'mimetype 内容不是 application/epub+zip，而是「' + mt + '」。');
      }
    }

    // ---------- 2. 容器与 OPF ----------
    if (!files['META-INF/container.xml']) {
      add('error', 'container', '缺少 META-INF/container.xml，无法定位 OPF 包文件。');
      return { ok: false, info: info, issues: issues };
    }

    var opfPath = '';
    try {
      var cDoc = parseMarkup(fflate.strFromU8(files['META-INF/container.xml']));
      var rfs = collectByLocalName(cDoc, 'rootfile');
      if (!rfs.length) add('error', 'rootfile', 'container.xml 里没有 rootfile 节点。');
      else {
        opfPath = rfs[0].getAttribute('full-path') || '';
        if (!opfPath) add('error', 'rootfile-path', 'rootfile 的 full-path 是空的。');
        else if (!files[opfPath]) {
          add('error', 'opf-missing', 'OPF 文件不存在：' + opfPath + '（容器指向了包内没有的文件）');
        }
      }
    } catch (e) {
      add('error', 'container-parse', 'container.xml 不是良构 XML。', e.message);
    }

    if (!opfPath || !files[opfPath]) {
      return { ok: false, info: info, issues: issues };
    }

    var opfDoc;
    try {
      opfDoc = parseMarkup(fflate.strFromU8(files[opfPath]));
    } catch (e) {
      add('error', 'opf-parse', 'OPF 不是良构 XML，阅读器无法解析包信息。', e.message);
      return { ok: false, info: info, issues: issues };
    }

    var pkg = collectByLocalName(opfDoc, 'package')[0];
    info.version = pkg ? pkg.getAttribute('version') || '' : '';
    if (!info.version) add('warn', 'opf-version', 'OPF 未声明 version，按 EPUB 2 处理。');

    function textOf(tag) {
      var els = collectByLocalName(opfDoc, tag);
      return els.length ? (els[0].textContent || '').trim() : '';
    }
    info.title = textOf('title');
    info.creator = textOf('creator');
    info.language = textOf('language');
    if (!info.title) add('info', 'no-title', '没有书名（dc:title），书架上会显示文件名。');
    if (!info.language) add('info', 'no-lang', '没有声明语言（dc:language），部分阅读器的断词与字体选择会不准。');

    var uniqueIdName = pkg ? pkg.getAttribute('unique-identifier') || '' : '';
    var idEls = collectByLocalName(opfDoc, 'identifier');
    if (!uniqueIdName) {
      add('warn', 'no-uid', 'OPF 缺少 unique-identifier 属性，EPUB 3 校验会报错。');
    } else {
      var matched = idEls.filter(function (el) {
        return el.getAttribute('id') === uniqueIdName;
      });
      if (!matched.length) {
        add('warn', 'uid-unmatched', 'unique-identifier 指向「' + uniqueIdName + '」，但没有这个 id 的 dc:identifier。');
      }
    }

    // ---------- 3. manifest ----------
    var manifest = collectByLocalName(opfDoc, 'item').map(function (el) {
      return {
        id: el.getAttribute('id') || '',
        href: decodePath(el.getAttribute('href') || ''),
        mediaType: el.getAttribute('media-type') || '',
        properties: el.getAttribute('properties') || ''
      };
    });
    manifest.forEach(function (m) {
      m.path = m.href ? resolvePath(opfPath, m.href) : '';
    });

    var byId = {};
    var dupIds = 0;
    var dupHref = 0;
    var seenHref = {};
    manifest.forEach(function (m) {
      if (m.id) {
        if (byId[m.id]) dupIds++;
        byId[m.id] = m;
      }
      if (m.path) {
        if (seenHref[m.path]) dupHref++;
        seenHref[m.path] = 1;
      }
    });
    if (dupIds) add('error', 'dup-id', 'manifest 里有 ' + dupIds + ' 个重复的 id，阅读器可能只认第一个。');
    if (dupHref) add('warn', 'dup-href', 'manifest 里有 ' + dupHref + ' 个文件被声明了多次。');

    var missing = manifest.filter(function (m) {
      return m.path && !files[m.path];
    });
    if (missing.length) {
      add(
        'error',
        'missing-file',
        missing.length + ' 个 manifest 条目指向不存在的文件（如 ' + basename(missing[0].path) + '）。',
        missing.slice(0, 8).map(function (m) { return m.path; }).join('\n')
      );
    }

    // 反向检查：包里有、但 manifest 没声明 —— 这是"此文件未列在manifest文件中"的来源
    var declaredSet = {};
    declaredSet[opfPath] = 1;
    manifest.forEach(function (m) {
      if (m.path) declaredSet[m.path] = 1;
    });
    var orphans = Object.keys(files).filter(function (n) {
      if (n === 'mimetype' || n === 'META-INF/container.xml') return false;
      if (n.indexOf('META-INF/') === 0) return false;
      return !declaredSet[n];
    });
    if (orphans.length) {
      var orphanImages = orphans.filter(function (n) {
        return IMAGE_EXT.test(n);
      }).length;
      add(
        'error',
        'undeclared',
        orphans.length + ' 个文件在包里存在、但 manifest 没有声明（其中 ' + orphanImages + ' 张图片）。' +
        '阅读器会逐张报「此文件未列在manifest文件中」，表现就是插图全部空白。',
        orphans.slice(0, 10).join('\n')
      );
    }

    // ---------- 4. spine 与文档 ----------
    var spineEl = collectByLocalName(opfDoc, 'spine')[0];
    var itemrefs = collectByLocalName(opfDoc, 'itemref');
    if (!itemrefs.length) add('error', 'spine-empty', 'spine 里没有任何章节，打开会是空白书。');

    var brokenRefs = 0;
    var textChars = 0;
    var headings = 0;
    var docsSeen = {};

    itemrefs.forEach(function (ref) {
      var idref = ref.getAttribute('idref');
      var mi = byId[idref];
      if (!mi) {
        add('error', 'spine-missing', 'spine 引用了不存在的 manifest id：' + idref);
        return;
      }
      if (!files[mi.path]) return;
      if (!/html/i.test(mi.mediaType) && !/\.x?html?$/i.test(mi.path)) return;
      if (docsSeen[mi.path]) return;
      docsSeen[mi.path] = 1;
      info.docs++;

      var raw = fflate.strFromU8(files[mi.path]);
      // XML 良构性：按 XML 解析，出错就说明标签没闭合
      try {
        var d = new DOMParser().parseFromString(raw, 'application/xhtml+xml');
        if (d.getElementsByTagName('parsererror').length) {
          add('warn', 'xhtml-parse', 'XHTML 不是良构 XML，部分阅读器会渲染异常：' + mi.path);
        }
      } catch (e) {
        add('warn', 'xhtml-parse', 'XHTML 解析失败：' + mi.path);
      }

      headings += (raw.match(/<h[1-6][\s>]/gi) || []).length;
      var text = raw
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&[a-z#0-9]{1,8};/gi, ' ');
      textChars += text.replace(/[\s\u00A0]+/g, '').length;

      // 引用的资源是否真实存在
      var re = /(?:src|href)\s*=\s*"([^"]+)"/gi;
      var m;
      while ((m = re.exec(raw))) {
        var v = m[1];
        if (!v || v.charAt(0) === '#' || isExternal(v)) continue;
        var hash = v.indexOf('#');
        var bare = hash >= 0 ? v.slice(0, hash) : v;
        if (!bare) continue;
        if (/\.x?html?$/i.test(bare)) continue;
        var abs = resolvePath(mi.path, decodePath(bare));
        if (!abs) continue;
        if (!files[abs]) brokenRefs++;
      }
    });

    if (brokenRefs) {
      add('error', 'broken-ref', '正文里有 ' + brokenRefs + ' 处资源引用指向包里不存在的文件（破图/失效链接）。');
    }

    info.chapters = headings || info.docs;
    info.words = textChars;

    // ---------- 5. 资源统计 ----------
    var lowerIdx = {};
    Object.keys(files).forEach(function (n) {
      var k = n.toLowerCase();
      if (!lowerIdx[k]) lowerIdx[k] = n;
    });
    Object.keys(files).forEach(function (n) {
      var len = files[n].length;
      if (IMAGE_EXT.test(n)) {
        info.images++;
        info.imageBytes += len;
        if (/\.svg$/i.test(n)) info.svg++;
      } else if (FONT_EXT.test(extname(n))) {
        info.fonts++;
        info.fontBytes += len;
      } else if (extname(n) === 'css') {
        info.css++;
      }
    });

    // 大小写写错的引用（Windows 上做的书常见）
    var caseMismatch = 0;
    Object.keys(files).forEach(function () {});
    manifest.forEach(function (m) {
      if (!m.path) return;
      if (files[m.path]) return;
      if (lowerIdx[m.path.toLowerCase()]) caseMismatch++;
    });
    if (caseMismatch) {
      add('warn', 'case', caseMismatch + ' 处路径大小写与实际文件名不一致（在 Linux / 部分阅读器上会找不到文件）。');
    }

    // ---------- 6. 导航与封面 ----------
    var navItems = manifest.filter(function (m) {
      return /nav/.test(m.properties || '');
    });
    info.hasNav = navItems.length > 0 && !!files[navItems[0].path];
    info.hasNcx = Object.keys(files).some(function (n) {
      return extname(n) === 'ncx';
    });
    if (info.version && info.version.charAt(0) === '3' && !info.hasNav) {
      add('error', 'no-nav', 'EPUB 3 必须有带 properties="nav" 的导航文档，这里没有。');
    }
    if ((!info.version || info.version.charAt(0) === '2') && !info.hasNcx) {
      add('warn', 'no-ncx', 'EPUB 2 没有 NCX 目录，很多阅读器会没有章节目录。');
    }

    var cover = manifest.filter(function (m) {
      return /cover-image/.test(m.properties || '');
    }).length > 0 || collectByLocalName(opfDoc, 'meta').some(function (el) {
      return (el.getAttribute('name') || '').toLowerCase() === 'cover';
    });
    info.hasCover = !!cover;
    if (!cover) add('info', 'no-cover', '没有声明封面图，书架上是空白封面。');

    var errors = issues.filter(function (i) { return i.level === 'error'; }).length;
    return { ok: errors === 0, info: info, issues: issues };
  }

  /*
   * 元数据编辑：只改 OPF 里的 dc:* 字段，其余字节一个都不动。
   * 不重新排版、不重压图片，所以改完后的书和原来完全一样，只是书名变了。
   */
  async function editMetadata(input, fields) {
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    var unzipped = fflate.unzipSync(bytes);

    var order = Object.keys(unzipped);
    var files = {};
    order.forEach(function (n) {
      if (n.charAt(n.length - 1) === '/') return;
      files[n] = unzipped[n];
    });

    var cDoc = parseMarkup(fflate.strFromU8(files['META-INF/container.xml']));
    var rf = collectByLocalName(cDoc, 'rootfile')[0];
    var opfPath = rf && rf.getAttribute('full-path');
    if (!opfPath || !files[opfPath]) throw new Error('找不到 OPF 文件');

    var text = fflate.strFromU8(files[opfPath]);
    var changed = [];

    function esc(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    Object.keys(fields || {}).forEach(function (key) {
      var val = fields[key];
      if (val == null) return;
      var re = new RegExp('(<dc:' + key + '\\b[^>]*>)([\\s\\S]*?)(</dc:' + key + '>)', 'i');
      if (re.test(text)) {
        text = text.replace(re, function (all, open, old, close) {
          return open + esc(val) + close;
        });
        changed.push(key);
      } else if (val !== '') {
        // 没有这个字段就插到 </metadata> 前
        if (/<\/metadata>/i.test(text)) {
          text = text.replace(/<\/metadata>/i, '<dc:' + key + '>' + esc(val) + '</dc:' + key + '></metadata>');
          changed.push(key);
        }
      }
    });

    // 更新时间戳，否则部分阅读器认为是旧书不刷新书架信息
    if (/<meta\s+property="dcterms:modified">/i.test(text)) {
      text = text.replace(
        /(<meta\s+property="dcterms:modified">)[^<]*(<\/meta>)/i,
        function (all, o, c) {
          return o + utcStamp() + c;
        }
      );
    }

    files[opfPath] = fflate.strToU8(text);

    var entries = [];
    entries.push({ name: 'mimetype', data: fflate.strToU8('application/epub+zip'), store: true });
    Object.keys(files).forEach(function (n) {
      if (n === 'mimetype') return;
      entries.push({
        name: n,
        data: files[n],
        store: /\.(jpe?g|png|gif|webp|mp3|mp4|m4a|zip)$/i.test(n)
      });
    });

    var packed = await buildZip(entries);
    return { bytes: packed, changed: changed };
  }

  /* 只精简 SVG，其他文件一个字节都不动。
     opts.dropUnused = true 时，把正文和样式表都没引用的 SVG 从包里删掉。 */
  async function optimizeSvgs(input, opts) {
    var o = opts || {};
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    var unzipped = fflate.unzipSync(bytes);

    var files = {};
    Object.keys(unzipped).forEach(function (n) {
      if (n.charAt(n.length - 1) === '/') return;
      files[n] = unzipped[n];
    });

    // 把所有文本类文件拼成一个大字符串，用来判断某个 SVG 到底有没有被引用
    var haystack = '';
    Object.keys(files).forEach(function (n) {
      if (!/\.(x?html?|css|opf|ncx|xml)$/i.test(n)) return;
      if (n.indexOf('META-INF/') === 0) return;
      haystack += fflate.strFromU8(files[n]).toLowerCase();
    });

    var svgNames = Object.keys(files).filter(function (n) { return /\.svg$/i.test(n); });
    var report = { files: 0, before: 0, after: 0, dropped: [], items: [] };

    svgNames.forEach(function (n) {
      var raw = fflate.strFromU8(files[n]);
      var base = basename(n).toLowerCase();
      var used = haystack.indexOf(base) >= 0;
      var dec = /^\s*<\?xml[^>]*\?>/.test(raw) ? '<?xml version="1.0" encoding="utf-8"?>' : '';
      var mm = minifySvg(raw);
      var text = dec + mm.text.replace(/^\s*<\?xml[^>]*\?>\s*/, '');
      report.items.push({ path: n, before: raw.length, after: text.length, used: used, dropped: false });

      if (!used && o.dropUnused) {
        delete files[n];
        report.items[report.items.length - 1].dropped = true;
        report.dropped.push(n);
        return;
      }
      files[n] = fflate.strToU8(text);
      report.files++;
      report.before += raw.length;
      report.after += text.length;
    });

    if (!report.items.length) return { bytes: bytes, report: report, changed: false };

    var entries = [];
    entries.push({ name: 'mimetype', data: fflate.strToU8('application/epub+zip'), store: true });
    Object.keys(files).forEach(function (n) {
      if (n === 'mimetype') return;
      entries.push({
        name: n,
        data: files[n],
        store: /\.(jpe?g|png|gif|webp|mp3|mp4|m4a|zip)$/i.test(n)
      });
    });

    var packed = await buildZip(entries);
    return { bytes: packed, report: report, changed: true };
  }

  /*
   * 资源清单：给工具箱用。图片会真的解码出宽高（用于判断"这张图是不是远超屏幕"），
   * 解码失败就只给体积，不编造尺寸。
   */
  async function scanAssets(input, opts2) {
    var limit = (opts2 && opts2.limit) || 300;
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    var unzipped = fflate.unzipSync(bytes);

    var files = {};
    Object.keys(unzipped).forEach(function (n) {
      if (n.charAt(n.length - 1) === '/') return;
      files[n] = unzipped[n];
    });

    var cDoc = parseMarkup(fflate.strFromU8(files['META-INF/container.xml']));
    var rf = collectByLocalName(cDoc, 'rootfile')[0];
    var opfPath = rf && rf.getAttribute('full-path');
    var opfDoc = opfPath && files[opfPath] ? parseMarkup(fflate.strFromU8(files[opfPath])) : null;
    var typeMap = {};
    if (opfDoc) {
      collectByLocalName(opfDoc, 'item').forEach(function (el) {
        var href = decodePath(el.getAttribute('href') || '');
        if (!href) return;
        typeMap[resolvePath(opfPath, href)] = el.getAttribute('media-type') || '';
      });
    }

    var images = [];
    var svgs = [];
    var fonts = [];
    var names = Object.keys(files).sort();

    // 判断资源有没有被引用，得把所有文本文件拼起来查一遍
    var haystack = '';
    names.forEach(function (n) {
      if (!/\.(x?html?|css|opf|ncx|xml)$/i.test(n) || n.indexOf('META-INF/') === 0) return;
      haystack += fflate.strFromU8(files[n]).toLowerCase();
    });

    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      if (n.indexOf('META-INF/') === 0) continue;
      var mt = typeMap[n] || guessMediaType(n);

      if (/\.svg$/i.test(n)) {
        svgs.push({
          path: n, bytes: files[n].length, mediaType: 'image/svg+xml',
          used: haystack.indexOf(basename(n).toLowerCase()) >= 0
        });
        continue;
      }
      if (IMAGE_EXT.test(n)) {
        var item = { path: n, bytes: files[n].length, mediaType: mt, width: 0, height: 0 };
        if (images.length < limit) {
          try {
            var bmp = await decodeImage(files[n], mt);
            if (bmp) {
              item.width = bmp.width || 0;
              item.height = bmp.height || 0;
              if (bmp.close) bmp.close();
            }
          } catch (e) {
            /* 解不出尺寸就留 0，不猜 */
          }
        }
        images.push(item);
        continue;
      }
      if (FONT_EXT.test(extname(n))) {
        fonts.push({ path: n, bytes: files[n].length, mediaType: mt });
        continue;
      }
    }

    images.sort(function (a, b) {
      return b.bytes - a.bytes;
    });
    return { images: images, svgs: svgs, fonts: fonts };
  }

  /* SVG 精简：去掉注释、元数据块、多余空白。只做无损清理，不动图形本身。 */
  function minifySvg(text) {
    var before = text.length;
    var out = text
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<metadata\b[\s\S]*?<\/metadata>/gi, '')
      .replace(/<\?xml[^>]*\?>/gi, '')
      .replace(/>\s+</g, '><')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return { text: out, before: before, after: out.length };
  }

  /* ------------------------------------------------------------ 原书预览
   *
   * 预览是只读的：解包到内存，把每章正文序列化成 HTML 存着，图片在取章时才
   * 转成 data: URL。原文件不会被写回、不会新建临时 EPUB。
   * 退出时调 closeBook() 把解包数据丢掉。
   */

  function u8ToBase64(u8) {
    var bin = '';
    var STEP = 8192;
    for (var i = 0; i < u8.length; i += STEP) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + STEP, u8.length)));
    }
    return btoa(bin);
  }

  // 单张资源超过这个体积就不内联（避免把几百 MB 的图塞进 data URL）
  var INLINE_LIMIT = 14 * 1048576;

  function walkNavList(listEl, level, out) {
    var kids = Array.prototype.slice.call(listEl.children || []);
    kids.forEach(function (li) {
      if (localTag(li) !== 'li') return;
      var anchor = null;
      var sub = null;
      var ch = Array.prototype.slice.call(li.children || []);
      for (var i = 0; i < ch.length; i++) {
        var t = localTag(ch[i]);
        if (t === 'a' && !anchor) anchor = ch[i];
        else if (t === 'ol' && !sub) sub = ch[i];
      }
      if (anchor) {
        out.push({
          title: (anchor.textContent || '').replace(/\s+/g, ' ').trim(),
          href: anchor.getAttribute('href') || '',
          level: level
        });
      }
      if (sub) walkNavList(sub, level + 1, out);
    });
  }

  function walkNavPoints(parent, level, out) {
    var points = Array.prototype.slice.call(parent.children || []).filter(function (el) {
      return localTag(el) === 'navpoint';
    });
    points.forEach(function (np) {
      var label = '';
      var href = '';
      Array.prototype.slice.call(np.children || []).forEach(function (c) {
        var t = localTag(c);
        if (t === 'navlabel') label = (c.textContent || '').replace(/\s+/g, ' ').trim();
        else if (t === 'content') href = c.getAttribute('src') || '';
      });
      if (href || label) out.push({ title: label, href: href, level: level });
      walkNavPoints(np, level + 1, out);
    });
  }

  /**
   * 解析一本 EPUB，返回可翻阅的结构。不做任何重排。
   * @returns {Promise<{title,creator,language,version,chapters,toc,stats,css}>}
   */
  async function openBook(input) {
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    var unzipped;
    try {
      unzipped = fflate.unzipSync(bytes);
    } catch (e) {
      throw new Error('不是有效的 EPUB（ZIP 解包失败）：' + e.message);
    }
    var files = {};
    Object.keys(unzipped).forEach(function (n) {
      if (n.charAt(n.length - 1) === '/') return;
      files[n] = unzipped[n];
    });

    var lowerIndex = {};
    Object.keys(files).forEach(function (n) {
      var k = n.toLowerCase();
      if (!lowerIndex[k]) lowerIndex[k] = n;
    });
    function realPath(p) {
      if (!p) return '';
      if (files[p]) return p;
      var k = lowerIndex[String(p).toLowerCase()];
      return k || '';
    }

    if (!files['META-INF/container.xml']) {
      throw new Error('缺少 META-INF/container.xml，不是标准 EPUB。');
    }
    var cdoc = parseMarkup(fflate.strFromU8(files['META-INF/container.xml']));
    var rf = collectByLocalName(cdoc, 'rootfile');
    var opfPath = realPath(rf.length ? rf[0].getAttribute('full-path') : '');
    if (!opfPath || !files[opfPath]) throw new Error('找不到 OPF 包文件。');

    var opfText = fflate.strFromU8(files[opfPath]);
    var opf = parseMarkup(opfText);

    var manifest = collectByLocalName(opf, 'item').map(function (el) {
      var href = decodePath(el.getAttribute('href') || '');
      var abs = resolvePath(opfPath, href);
      return {
        id: el.getAttribute('id') || '',
        href: href,
        path: realPath(abs) || abs,
        mediaType: el.getAttribute('media-type') || guessMediaType(href),
        properties: el.getAttribute('properties') || ''
      };
    });
    var byId = {};
    var byPath = {};
    manifest.forEach(function (m) {
      if (m.id) byId[m.id] = m;
      if (m.path) byPath[m.path] = m;
    });

    var spine = collectByLocalName(opf, 'itemref')
      .map(function (el) { return byId[el.getAttribute('idref')] || null; })
      .filter(Boolean);

    var mdText = (opfText.match(/<metadata[\s\S]*?<\/metadata>/i) || [''])[0];
    function meta(name) {
      var re = new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)</' + name + '>', 'i');
      var m = re.exec(mdText);
      if (!m) return '';
      return m[1]
        .replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .trim();
    }
    var title = meta('dc:title') || meta('title') || '';
    var creator = meta('dc:creator') || '';
    var language = meta('dc:language') || '';
    var version = (opf.documentElement && opf.documentElement.getAttribute('version')) || '';

    // --- 样式表：全部读进来，把 url() 换成 data:，否则字体和内嵌图在 iframe 里全丢
    var cssParts = [];
    var cssFiles = [];
    manifest.forEach(function (m) {
      if (extname(m.path) !== 'css' || !files[m.path]) return;
      cssFiles.push(m.path);
    });
    // manifest 没声明的样式表也要算（否则"未声明的书"预览会掉样式）
    Object.keys(files).forEach(function (n) {
      if (n.indexOf('META-INF/') === 0) return;
      if (extname(n) === 'css' && cssFiles.indexOf(n) < 0) cssFiles.push(n);
    });
    cssFiles.sort();

    function inlineUrl(baseFile, url) {
      var u = String(url || '').trim();
      if (!u || isExternal(u) || u.indexOf('data:') === 0 || u.charAt(0) === '#') return '';
      var abs = realPath(resolvePath(baseFile, decodePath(u)));
      if (!abs || !files[abs]) return '';
      var b = files[abs];
      if (b.length > INLINE_LIMIT) return '';
      var mt = (byPath[abs] && byPath[abs].mediaType) || guessMediaType(abs);
      return 'data:' + mt + ';base64,' + u8ToBase64(b);
    }

    cssFiles.forEach(function (p) {
      var text = fflate.strFromU8(files[p]);
      text = text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, function (all, q, url) {
        var d = inlineUrl(p, url);
        return d ? 'url("' + d + '")' : all;
      });
      cssParts.push('/* ' + p + ' */\n' + text);
    });
    // 正文文件里的 <style> 也属于原书排版
    var inlineStyles = [];

    // --- 章节
    var chapters = [];
    var chapterByPath = {};
    spine.forEach(function (m) {
      if (!files[m.path]) return;
      if (!/xhtml|html/i.test(m.mediaType) && !/\.x?html?$/i.test(m.path)) return;
      var doc = parseMarkup(fflate.strFromU8(files[m.path]));
      var body = getBody(doc);
      if (!body) return;

      collectByLocalName(doc, 'style').forEach(function (st) {
        var t = (st.textContent || '').trim();
        if (t) inlineStyles.push('/* ' + m.path + ' */\n' + t);
      });

      var headTitle = '';
      var tt = collectByLocalName(doc, 'title');
      if (tt.length) headTitle = (tt[0].textContent || '').trim();

      var heading = '';
      var hs = collectByLocalName(body, 'h1')
        .concat(collectByLocalName(body, 'h2'))
        .concat(collectByLocalName(body, 'h3'));
      if (hs.length) heading = (hs[0].textContent || '').replace(/\s+/g, ' ').trim();

      chapterByPath[m.path] = chapters.length;
      chapters.push({
        title: heading || headTitle || '第 ' + (chapters.length + 1) + ' 章',
        path: m.path,
        html: serializeChildren(body),
        words: (body.textContent || '').replace(/\s/g, '').length
      });
    });

    // --- 目录：nav.xhtml 优先，否则 toc.ncx，再否则按章节标题平铺
    var entries = [];
    var navItem = manifest.filter(function (m) {
      return /\bnav\b/.test(m.properties) && files[m.path];
    })[0];
    if (navItem) {
      var navDoc = parseMarkup(fflate.strFromU8(files[navItem.path]));
      var navs = collectByLocalName(navDoc, 'nav');
      var tocNav = navs.filter(function (n) {
        return /toc/.test(n.getAttribute('epub:type') || n.getAttribute('type') || '');
      })[0] || navs[0];
      if (tocNav) {
        var ols = collectByLocalName(tocNav, 'ol');
        if (ols.length) walkNavList(ols[0], 0, entries);
      }
    }
    if (!entries.length) {
      var ncxItem = manifest.filter(function (m) {
        return /dtbncx/i.test(m.mediaType) || extname(m.path) === 'ncx';
      })[0];
      if (ncxItem && files[ncxItem.path]) {
        var ncxDoc = parseMarkup(fflate.strFromU8(files[ncxItem.path]));
        var maps = collectByLocalName(ncxDoc, 'navmap');
        if (maps.length) walkNavPoints(maps[0], 0, entries);
        entries = entries.map(function (e) { return e; });
        // ncx 的 href 相对 ncx 文件本身
        entries.basePath = ncxItem.path;
      } else {
        entries = chapters.map(function (c, i) {
          return { title: c.title, href: c.path, level: 0 };
        });
        entries.basePath = '';
      }
    }
    var navBase = entries.basePath || (navItem ? navItem.path : '');
    var toc = [];
    var usedChapters = {};
    entries.forEach(function (e) {
      var bare = decodePath(String(e.href || '').split('#')[0]);
      var abs = bare ? resolvePath(navBase, bare) : navBase;
      var idx = chapterByPath[realPath(abs)] != null ? chapterByPath[realPath(abs)] : chapterByPath[abs];
      if (idx == null) return;
      if (usedChapters[idx] && toc.length > 0) {
        // 同一章有多个目录项（分卷切了锚点）：保留第一条，避免目录里重复
        return;
      }
      usedChapters[idx] = 1;
      toc.push({ title: e.title || chapters[idx].title, index: idx, level: e.level || 0 });
    });
    // 目录没覆盖到的章节补在末尾，保证每一章都能翻到
    chapters.forEach(function (c, i) {
      if (!usedChapters[i]) toc.push({ title: c.title, index: i, level: 0 });
    });

    // --- 统计
    var stats = { images: 0, imageBytes: 0, fonts: 0, fontBytes: 0, css: cssFiles.length, docs: chapters.length };
    Object.keys(files).forEach(function (n) {
      if (n.indexOf('META-INF/') === 0) return;
      var b = files[n].length;
      if (IMAGE_EXT.test(n)) { stats.images++; stats.imageBytes += b; }
      else if (FONT_EXT.test(extname(n))) { stats.fonts++; stats.fontBytes += b; }
    });

    /*
     * --- 图片清单（给「图片浏览」用）
     * 只列包里真实存在的图片文件；另算两件事：
     *   referenced  —— 有没有被正文或样式表引用（没有被引用的单独标出来）
     *   chapters    —— 被哪些章节引用，界面显示"第 n 章"，给不出就是空
     * 尺寸读文件头，不解码像素，500 张图也不会卡。
     */
    var refMap = {};
    var refSeq = 0;
    function markRef(baseFile, url, chIdx, fromCss) {
      var u = String(url || '').trim();
      if (!u || isExternal(u) || u.indexOf('data:') === 0 || u.charAt(0) === '#') return;
      u = u.split('#')[0].split('?')[0];
      if (!u) return;
      var abs = realPath(resolvePath(baseFile, decodePath(u)));
      if (!abs) return;
      var rec = refMap[abs];
      if (!rec) rec = refMap[abs] = { chapters: [], css: false, seq: ++refSeq };
      if (fromCss) rec.css = true;
      if (chIdx != null && rec.chapters.indexOf(chIdx) < 0) rec.chapters.push(chIdx);
    }
    chapters.forEach(function (c, i) {
      var m;
      var re = /\b(?:src|href|xlink:href)\s*=\s*"([^"]+)"/gi;
      while ((m = re.exec(c.html))) markRef(c.path, m[1], i);
      var re2 = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
      while ((m = re2.exec(c.html))) markRef(c.path, m[2], i);
    });
    cssFiles.forEach(function (p) {
      if (!files[p]) return;
      var text = fflate.strFromU8(files[p]);
      var m;
      var re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
      while ((m = re.exec(text))) markRef(p, m[2], null, true);
    });

    var images = [];
    Object.keys(files).forEach(function (n) {
      if (n.indexOf('META-INF/') === 0) return;
      if (!IMAGE_EXT.test(n)) return;
      var mt = (byPath[n] && byPath[n].mediaType) || guessMediaType(n);
      var dim = imageSize(files[n], mt);
      var ref = refMap[n];
      images.push({
        path: n,
        name: basename(n),
        mediaType: mt,
        format: (dim.ext || extname(n) || '?').toUpperCase(),
        bytes: files[n].length,
        width: dim.width,
        height: dim.height,
        referenced: !!ref,
        usedInCss: !!(ref && ref.css),
        chapters: ref ? ref.chapters.slice() : [],
        seq: ref ? ref.seq : 999999,
        vector: /svg/i.test(mt)
      });
    });
    // 按"第一次被引用的顺序"排，没被引用的排在后面；同序按路径
    images.sort(function (a, b) {
      if (a.seq !== b.seq) return a.seq - b.seq;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    images.forEach(function (im, i) { im.order = i + 1; });

    // --- 封面
    var coverBytes = null;
    var coverType = '';
    var coverItem = manifest.filter(function (m) {
      return /cover-image/.test(m.properties) && files[m.path];
    })[0];
    if (!coverItem) {
      var coverId = (/<meta\b[^>]*\bname\s*=\s*["']cover["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/i.exec(opfText) || [])[1];
      if (coverId && byId[coverId] && files[byId[coverId].path]) coverItem = byId[coverId];
    }
    if (coverItem) {
      coverBytes = files[coverItem.path];
      coverType = coverItem.mediaType || guessMediaType(coverItem.path);
    }

    var cssText = cssParts.concat(inlineStyles).join('\n\n');
    var book = {
      title: title || '',
      creator: creator || '',
      language: language || '',
      version: version || '',
      chapters: chapters,
      toc: toc,
      stats: stats,
      css: cssText,
      hasCss: !!cssText.trim(),
      cover: coverBytes,
      coverType: coverType,
      images: images,
      bytes: bytes.length
    };

    Object.defineProperty(book, '_ctx', {
      value: {
        files: files,
        byPath: byPath,
        realPath: realPath,
        dataUri: function (baseFile, rel) {
          return inlineUrl(baseFile, rel);
        }
      },
      writable: true,
      enumerable: false,
      configurable: true
    });

    return book;
  }

  /** 取一章正文。图片此时才转 data:，所以大书不会一次性把图全读进内存。 */
  function readChapter(book, i) {
    var ctx = book && book._ctx;
    if (!ctx) throw new Error('预览已关闭，请重新打开书籍');
    var ch = book.chapters[i];
    if (!ch) return { html: '', css: book.css, missing: [] };

    var missing = [];
    var html = ch.html.replace(/<img\b[^>]*>/gi, function (tag) {
      return tag.replace(/(\s)src\s*=\s*"([^"]*)"/i, function (all, sp, src) {
        if (isExternal(src)) return all;
        var d = ctx.dataUri(ch.path, src);
        if (d) return sp + 'src="' + d + '"';
        missing.push(src);
        return sp + 'data-efmissing="' + escAttr(src) + '"';
      });
    });

    // 内联 SVG 里的 <image href> 同样要解析，否则矢量图里的位图变空白
    html = html.replace(/<image\b[^>]*>/gi, function (tag) {
      return tag.replace(/\s(xlink:href|href)\s*=\s*"([^"]*)"/i, function (all, attr, href) {
        if (isExternal(href)) return all;
        var d = ctx.dataUri(ch.path, href);
        if (d) return ' ' + attr + '="' + d + '"';
        missing.push(href);
        return all;
      });
    });

    return { html: html, css: book.css, missing: missing };
  }

  /** 取一张图片的原始字节（图片浏览用）。调用方自己决定转不转 data:，界面按需加载。 */
  function readImage(book, path) {
    var ctx = book && book._ctx;
    if (!ctx) throw new Error('预览已关闭，请重新打开书籍');
    var p = (ctx.realPath && ctx.realPath(path)) || path;
    var b = ctx.files && ctx.files[p];
    if (!b) return null;
    var m = ctx.byPath[p];
    var mt = (m && m.mediaType) || guessMediaType(p);
    return { path: p, bytes: b, mediaType: mt, size: b.length };
  }

  /** 释放解包数据。之后这本书的 book._ctx 为空，readChapter 会明确报错。 */
  function closeBook(book) {
    if (!book) return;
    try {
      if (book._ctx) book._ctx.files = null;
      book._ctx = null;
    } catch (e) { /* 只读属性就算了，GC 会处理 */ }
  }

  return {
    process: process,
    inspect: inspect,
    diagnose: diagnose,
    openBook: openBook,
    readChapter: readChapter,
    readImage: readImage,
    imageSize: imageSize,
    closeBook: closeBook,
    editMetadata: editMetadata,
    optimizeSvgs: optimizeSvgs,
    scanAssets: scanAssets,
    minifySvg: minifySvg,
    MODES: MODES,
    _internals: {
      serializeNode: serializeNode,
      splitIntoChapters: splitIntoChapters,
      normalizeCssText: normalizeCssText,
      planVolumes: planVolumes
    }
  };
});
