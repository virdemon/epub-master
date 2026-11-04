# -*- coding: utf-8 -*-
"""造一本"排版要素齐全"的 EPUB，专门验证预览能不能按原结构渲染。

这本书故意塞满容易在预览里被糊掉的东西：
  1. 表格（带 thead/tbody、合并单元格、表注）
  2. 内联 <svg>（直接写在 XHTML 里的矢量图）
  3. 当作图片引用的 .svg 文件（<img src="*.svg">）
  4. 原书 CSS 里的自定义类：.dropcap 首字下沉、.note 背景色、.serif 字体
  5. 图注 <figure>/<figcaption>、行内加粗斜体、列表
  6. 中文字体的 @font-face（用来确认字体声明不会把预览搞坏）

预期：预览里 table 有真实行列、svg 有真实尺寸、.note 的背景色能被读到、
首字下沉的字号明显大于正文 —— 任何一项做不到，就说明预览是在"假装渲染"。
"""

import os
import struct
import zipfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "test", "sample_rich.epub")

CONTAINER = """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

OPF = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>排版要素大全</dc:title>
    <dc:creator>样书生成器</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:identifier id="BookId">urn:uuid:rich-sample-0001</dc:identifier>
    <meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="Styles/book.css" media-type="text/css"/>
    <item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="Text/ch3.xhtml" media-type="application/xhtml+xml"/>
    <item id="pic" href="Images/pic.svg" media-type="image/svg+xml"/>
    <item id="cover" href="Images/cover.png" media-type="image/png" properties="cover-image"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="c3"/>
  </spine>
</package>
"""

NAV = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">
<head><meta charset="utf-8"/><title>目录</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
      <li><a href="Text/ch1.xhtml">第一章　表格</a></li>
      <li><a href="Text/ch2.xhtml">第二章　矢量图</a></li>
      <li><a href="Text/ch3.xhtml">第三章　样式</a></li>
    </ol>
  </nav>
</body>
</html>
"""

CSS = """@charset "utf-8";

body {
  font-family: "Source Han Serif", serif;
  font-size: 16px;
  line-height: 1.9;
  margin: 0 6%;
  color: #222;
}

h1 { font-size: 1.5em; text-align: center; margin: 1.2em 0 1em; }
h2 { font-size: 1.15em; margin: 1em 0 .6em; }

/* 首字下沉：预览必须读得到这个大字号，否则说明原书 CSS 没进去 */
.dropcap { font-size: 3em; float: left; line-height: 1; margin: 0 .08em 0 0; color: #8a3b2a; }

/* 带背景色的提示块：颜色是可断言的 */
.note {
  background-color: #fff6d5;
  border-left: 4px solid #d9a441;
  padding: .6em .9em;
  margin: 1em 0;
}

.serif { font-family: "Songti SC", "SimSun", serif; }
.center { text-align: center; }
.small { font-size: .85em; color: #666; }

table {
  width: 100%;
  border-collapse: collapse;
  margin: 1em 0;
  font-size: .95em;
}
caption { caption-side: top; text-align: left; font-weight: bold; padding-bottom: .4em; }
th, td { border: 1px solid #999; padding: .4em .5em; }
thead th { background-color: #eef2f8; }

figure { margin: 1.2em 0; text-align: center; }
figcaption { font-size: .85em; color: #666; margin-top: .4em; }

ul { margin: .6em 0 .6em 1.4em; }
li { margin: .2em 0; }
"""

CH1 = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
<head><meta charset="utf-8"/><title>第一章　表格</title>
<link rel="stylesheet" type="text/css" href="../Styles/book.css"/></head>
<body>
  <h1>第一章　表格</h1>
  <p><span class="dropcap">这</span>一章用来验证预览能不能按原结构排出表格。原书用了 thead、tbody、
  合并单元格与表注，如果预览只是把文字拼成纯文本，下面这张表会变成一串没有行列的字。</p>

  <table>
    <caption>表 1-1　渡口历年运量</caption>
    <thead>
      <tr><th>年份</th><th>客运（人次）</th><th>货运（吨）</th><th>备注</th></tr>
    </thead>
    <tbody>
      <tr><td>2019</td><td>12,480</td><td>3,210</td><td>—</td></tr>
      <tr><td>2020</td><td>4,102</td><td>1,098</td><td>停航两月</td></tr>
      <tr><td>2021</td><td colspan="2">恢复至疫情前七成</td><td>合并列</td></tr>
      <tr><td>2022</td><td>11,960</td><td>3,004</td><td>—</td></tr>
    </tbody>
  </table>

  <div class="note">这一段是带背景色的提示块，用来验证原书 CSS 的 <code>.note</code> 类是否真的生效。</div>

  <p class="serif">这一段的字体应该走 .serif 指定的宋体，字号与正文一致，行距 1.9。</p>

  <ul>
    <li>列表项一：<strong>加粗</strong>要保持粗体</li>
    <li>列表项二：<em>斜体</em>要保持斜体</li>
    <li>列表项三：普通文字</li>
  </ul>
</body>
</html>
"""

CH2 = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
<head><meta charset="utf-8"/><title>第二章　矢量图</title>
<link rel="stylesheet" type="text/css" href="../Styles/book.css"/></head>
<body>
  <h1>第二章　矢量图</h1>
  <p>这一章有两种矢量图：直接写在 XHTML 里的内联 <code>&lt;svg&gt;</code>，
  以及以文件形式引用进来的 <code>.svg</code>。前者不改 DOM 就应该画出来，后者需要把文件读成 data URL。</p>

  <h2>内联 SVG</h2>
  <svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120">
    <rect x="4" y="4" width="312" height="112" fill="#eef2f8" stroke="#3b6ea5" stroke-width="2"/>
    <circle cx="70" cy="60" r="34" fill="#3b6ea5"/>
    <path d="M120 88 L170 32 L220 88 Z" fill="#d9a441"/>
    <text x="240" y="66" font-size="16" fill="#222">SVG</text>
  </svg>

  <h2>外部 SVG 文件</h2>
  <figure>
    <img src="../Images/pic.svg" alt="外部矢量图" width="240"/>
    <figcaption>图 2-1　以文件形式引用的 SVG</figcaption>
  </figure>

  <p>如果你的阅读器里这两张图都看不到，说明预览没有真正处理矢量资源。</p>
</body>
</html>
"""

CH3 = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
<head><meta charset="utf-8"/><title>第三章　样式</title>
<link rel="stylesheet" type="text/css" href="../Styles/book.css"/></head>
<body>
  <h1>第三章　样式</h1>
  <figure>
    <img src="../Images/cover.png" alt="封面图"/>
    <figcaption>图 3-1　位图按原样出现，宽度不超过正文</figcaption>
  </figure>

  <h2>段落与首字下沉</h2>
  <p><span class="dropcap">字</span>首字下沉用的是 3em 的字号，比正文大得多。
  预览如果读到了原书样式表，这个字会明显凸出来；读不到就只是一行普通文字。</p>
  <p>普通段落：这一段的字号应该和正文一致，行距 1.9，段间距由原书 CSS 决定。</p>

  <div class="note">
    <p>提示块里的段落也要正常排版，不能因为多包了一层 div 就丢掉缩进规则。</p>
  </div>

  <p class="center small">—— 全书完 ——</p>
</body>
</html>
"""

PIC_SVG = """<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160">
  <rect x="2" y="2" width="236" height="156" fill="#fff6d5" stroke="#d9a441" stroke-width="3"/>
  <polyline points="20,120 60,70 100,100 140,40 180,80 220,30"
            fill="none" stroke="#8a3b2a" stroke-width="4"/>
  <circle cx="140" cy="40" r="6" fill="#8a3b2a"/>
  <text x="30" y="148" font-size="14" fill="#555">external svg</text>
</svg>
"""


def png(w, h, rgb):
    """最小 PNG：纯色块。只为了有个能显示出来的封面，不引第三方库。"""
    raw = b""
    row = bytes(rgb) * w
    for _ in range(h):
        raw += b"\x00" + row

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) +
            chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def main():
    files = {
        "mimetype": b"application/epub+zip",
        "META-INF/container.xml": CONTAINER.encode("utf-8"),
        "OEBPS/content.opf": OPF.encode("utf-8"),
        "OEBPS/nav.xhtml": NAV.encode("utf-8"),
        "OEBPS/Styles/book.css": CSS.encode("utf-8"),
        "OEBPS/Text/ch1.xhtml": CH1.encode("utf-8"),
        "OEBPS/Text/ch2.xhtml": CH2.encode("utf-8"),
        "OEBPS/Text/ch3.xhtml": CH3.encode("utf-8"),
        "OEBPS/Images/pic.svg": PIC_SVG.encode("utf-8"),
        "OEBPS/Images/cover.png": png(600, 800, (238, 242, 248)),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with zipfile.ZipFile(OUT, "w") as z:
        # mimetype 必须第一个、且不压缩
        z.writestr(zipfile.ZipInfo("mimetype"), files["mimetype"], zipfile.ZIP_STORED)
        for name, data in files.items():
            if name == "mimetype":
                continue
            z.writestr(name, data, zipfile.ZIP_DEFLATED)
    print("已生成 %s（%.1f KB）" % (OUT, os.path.getsize(OUT) / 1024))


if __name__ == "__main__":
    main()
