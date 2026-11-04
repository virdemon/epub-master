"""生成一本"满是典型毛病"的 EPUB，用于验证 epubfix 的规范化效果。

故意埋进去的问题，全部对应微信读书多端排版不一致的真实成因：
  1. CSS 用 px/pt 绝对字号 + 行高，不同屏幕缩放不一致
  2. 内嵌 @font-face 字体，多数阅读器不加载却白占体积
  3. 全文塞进一个 xhtml，章节粒度粗，加载慢、进度同步错位
  4. 图片写死 width/height，小屏溢出、大屏过小
  5. 用 &nbsp; 手动缩进，与阅读器默认首行缩进叠加
  6. 大量空段落 <p>&nbsp;</p> 制造段距，各端渲染不同
  7. 内联 style 覆盖全局样式
  8. <font> 标签与无意义 span 嵌套
  9. 目录层级混乱，ncx 与实际章节不对应
 10. 图片未压缩，体积巨大
"""

import os
import random
import struct
import zipfile
import zlib

random.seed(20261028)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "test", "sample_broken.epub")


def make_png(width, height, noisy=True):
    """纯标准库生成 RGB PNG。noisy=True 产生随机噪点，PNG 几乎压不动，模拟未优化大图。"""
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0
        if noisy:
            raw.extend(random.getrandbits(8) for _ in range(width * 3))
        else:
            row = bytes([40, 60, 90]) * width
            raw.extend(row)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 1)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", idat)
        + chunk(b"IEND", b"")
    )


CSS_MAIN = """@charset "utf-8";
@font-face {
  font-family: "SourceHanSerif";
  src: url("../Fonts/SourceHanSerif.ttf") format("truetype");
}
body {
  font-family: "SourceHanSerif", serif;
  font-size: 17pt;
  line-height: 34pt;
  margin: 8px 12px 8px 12px;
  text-align: justify;
}
p {
  font-size: 17pt;
  text-indent: 2em;
  margin: 0pt 0pt 0pt 0pt;
}
h1 {
  font-size: 26pt;
  margin: 40pt 0pt 20pt 0pt;
  text-align: center;
}
h2 {
  font-size: 20pt;
  margin-top: 30pt;
}
.duan {
  font-size: 15pt;
  color: #333333;
}
.imgbox img {
  width: 1200px;
  height: 1800px;
}
"""

CSS_EXTRA = """@charset "utf-8";
/* 第二份样式表，与 main.css 打架，最终呈现取决于加载顺序 */
p { text-indent: 0em; }
h1 { color: #8b0000; text-shadow: 1px 1px 2px #cccccc; }
"""

PRE_CHAPTER = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
  <title>版权页</title>
  <link href="../Styles/main.css" rel="stylesheet" type="text/css" />
  <link href="../Styles/extra.css" rel="stylesheet" type="text/css" />
  <style type="text/css">
    body { background: #ffffff; }
    p.copyright { font-size: 12pt; color: #666666; }
  </style>
</head>
<body>
  <p class="copyright">本文为排版测试样书，非真实出版物。<br/></p>
  <p class="copyright">&nbsp;</p>
  <p class="copyright">生成于测试脚本，仅用于校验工具效果。</p>
</body>
</html>
"""


def body_of_book():
    """一本书正文章节全部塞进同一个 xhtml，并且埋满各种脏东西。"""
    parts = []
    for i, (title, paras) in enumerate(
        [
            ("第一章 渡口无船", 14),
            ("第二章 灯火不归", 12),
            ("第三章 长夜将尽", 10),
        ],
        start=1,
    ):
        parts.append('<h1 id="ch%d">%s</h1>' % (i, title))
        for j in range(paras):
            if j == 0:
                # 用 &nbsp; 手动缩进，会和 CSS 的 text-indent 叠加
                parts.append(
                    '<p class="duan">&nbsp;&nbsp;&nbsp;&nbsp;这是%s的第一段，'
                    "作者习惯手动敲空格来缩进，于是和样式表里的缩进叠在一起。</p>" % title
                )
            elif j == 3:
                # 内联样式覆盖全局
                parts.append(
                    '<p style="font-size:19pt;line-height:40pt;margin-top:24pt;">'
                    '<font color="#000000">这一段被内联样式写死了字号和行高，'
                    "在手机上会和其他段落明显不同步。</font></p>"
                )
            elif j == 5:
                # 空段落制造段距
                parts.append('<p>&nbsp;</p>')
                parts.append('<p class="duan">空段落被用来制造段距，但各端对空段落高度处理不同。</p>')
                parts.append('<p><br/></p>')
            elif j == 7 and i == 1:
                parts.append(
                    '<div class="imgbox"><img src="../Images/fig1.png" width="1200" '
                    'height="1800" alt="插图"/></div>'
                )
            elif j == 9:
                parts.append(
                    "<p>" + "<span>" * 3 + "这里有三层无意义 span 嵌套，还有<b>加粗</b>和<i>斜体</i>。</span>" + "</span>" * 2 + "</p>"
                )
            else:
                parts.append(
                    '<p class="duan">这是%s的第%d段。段落文字用于测试排版一致性，'
                    "内容本身没有意义，只关心显示效果是否在各端统一。</p>" % (title, j + 1)
                )
        parts.append('<div class="breaker"><br/><br/><br/></div>')

    return """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
  <title>正文</title>
  <link href="../Styles/main.css" rel="stylesheet" type="text/css" />
  <link href="../Styles/extra.css" rel="stylesheet" type="text/css" />
</head>
<body>
""" + "\n".join(parts) + """
</body>
</html>
"""


OPF = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>渡口无船</dc:title>
    <dc:creator opf:role="aut">测试作者</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:identifier id="BookId">urn:uuid:00000000-0000-0000-0000-000000000001</dc:identifier>
    <dc:publisher>排版实验室</dc:publisher>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css-main" href="Styles/main.css" media-type="text/css"/>
    <item id="css-extra" href="Styles/extra.css" media-type="text/css"/>
    <item id="font-serif" href="Fonts/SourceHanSerif.ttf" media-type="application/x-font-ttf"/>
    <item id="pre" href="Text/preface.xhtml" media-type="application/xhtml+xml"/>
    <item id="book" href="Text/book.xhtml" media-type="application/xhtml+xml"/>
    <item id="txtstyle" href="Text/txtstyle.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-img" href="Images/cover.png" media-type="image/png"/>
    <item id="fig1" href="Images/fig1.png" media-type="image/png"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="cover-img" linear="no"/>
    <itemref idref="pre"/>
    <itemref idref="book"/>
    <itemref idref="txtstyle"/>
  </spine>
</package>
"""

NCX = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:00000000-0000-0000-0000-000000000001"/>
    <meta name="dtb:depth" content="3"/>
  </head>
  <docTitle><text>渡口无船</text></docTitle>
  <navMap>
    <navPoint id="n1" playOrder="1">
      <navLabel><text>版权页</text></navLabel>
      <content src="Text/preface.xhtml"/>
      <navPoint id="n1-1" playOrder="2">
        <navLabel><text>第一章 渡口无船</text></navLabel>
        <content src="Text/book.xhtml#ch1"/>
        <navPoint id="n1-1-1" playOrder="3">
          <navLabel><text>第一节 旧事</text></navLabel>
          <content src="Text/book.xhtml#ch1"/>
        </navPoint>
      </navPoint>
      <navPoint id="n1-2" playOrder="4">
        <navLabel><text>第二章 灯火不归</text></navLabel>
        <content src="Text/book.xhtml#ch2"/>
      </navPoint>
      <navPoint id="n1-3" playOrder="5">
        <navLabel><text>第三章 长夜将尽</text></navLabel>
        <content src="Text/book.xhtml#ch3"/>
      </navPoint>
    </navPoint>
  </navMap>
</ncx>
"""

TXT_STYLE = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
  <title>第四章 旧事</title>
  <link href="../Styles/main.css" rel="stylesheet" type="text/css" />
</head>
<body>
<div>第四章 旧事<br/>
这是 TXT 转出来的书最常见的样子：整篇没有一个 p 标签，全靠 br 分段。<br/>
所以首行缩进无处可挂，看起来像记事本。<br/>
<br/>
这一行前面有一个空行，应该被丢掉。<br/>
<b>这一整段是加粗的，阅读器里必须看得见。</b><br/>
结尾一行，后面还跟着一串空行。<br/>
<br/>
<br/>
</div>
</body>
</html>
"""

CONTAINER = """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""


def build():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    if os.path.exists(OUT):
        os.remove(OUT)

    files = [
        ("META-INF/container.xml", CONTAINER.encode("utf-8")),
        ("OEBPS/content.opf", OPF.encode("utf-8")),
        ("OEBPS/toc.ncx", NCX.encode("utf-8")),
        ("OEBPS/Styles/main.css", CSS_MAIN.encode("utf-8")),
        ("OEBPS/Styles/extra.css", CSS_EXTRA.encode("utf-8")),
        ("OEBPS/Fonts/SourceHanSerif.ttf", bytes(random.getrandbits(8) for _ in range(120_000))),
        ("OEBPS/Text/preface.xhtml", PRE_CHAPTER.encode("utf-8")),
        ("OEBPS/Text/book.xhtml", body_of_book().encode("utf-8")),
        ("OEBPS/Text/txtstyle.xhtml", TXT_STYLE.encode("utf-8")),
        ("OEBPS/Images/cover.png", make_png(900, 1200)),
        ("OEBPS/Images/fig1.png", make_png(1200, 1800)),
    ]

    with zipfile.ZipFile(OUT, "w") as z:
        # mimetype 必须是第一个条目，且不压缩
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", zipfile.ZIP_STORED)
        for name, data in files:
            z.writestr(name, data, zipfile.ZIP_DEFLATED)

    size = os.path.getsize(OUT)
    print("已生成样书: %s (%.2f MB)" % (OUT, size / 1024 / 1024))
    for name, data in files:
        print("  %-38s %8.1f KB" % (name, len(data) / 1024))


if __name__ == "__main__":
    build()
