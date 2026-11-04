"""造一本"网页抓取式"的 EPUB，专门验证首行缩进能不能被修好。

这类书的排版特征（也是首行缩进丢失的真实原因）：
  1. 每段写成 <div class="p">文字</div>，而不是 <p> —— 缩进规则挂在 p 上，div 一律顶格
  2. 同一章里又夹了一个 <p>（图注、分割线说明）—— 旧的"整层没有 p 才处理"判断
     会因此把整章跳过，所以缩进"改了也没变化"
  3. 有的章节是一整个 div 里用 <br> 分隔，同理被跳过

输出必须做到：每一段都是 <p>，全部有 2em 缩进，没有空段落。
"""

import os
import random
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "test", "sample_web.epub")

random.seed(88)
POOL = [chr(c) for c in range(0x4E00, 0x4E00 + 1200)]


def line(n=72):
    return "".join(random.choice(POOL) for _ in range(n))


CONTAINER = """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

OPF = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>网页抓下来的小说</dc:title>
    <dc:creator>某站长</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:identifier id="BookId">urn:uuid:web-crawl-0001</dc:identifier>
  </metadata>
  <manifest>
    <item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="Text/ch3.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="Styles/site.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="c3"/>
  </spine>
</package>
"""

CSS = """@charset "utf-8";
body { font-size: 12pt; line-height: 1.8; margin: 0 12px; }
div.p { margin: 0 0 10px 0; }
p { margin: 0; }
h2 { font-size: 16pt; text-align: center; }
"""

# 第一章：每段一个 div，同章夹一个 <p>（旧逻辑会整章跳过）
CH1_DIVS = "\n".join(
    '<div class="p">%s</div>' % line() for _ in range(10)
)
CH1 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="utf-8"/><title>第一章 顶格的段落</title>
<link rel="stylesheet" type="text/css" href="../Styles/site.css"/></head>
<body>
<h2>第一章 顶格的段落</h2>
%s
<p class="note">（本章由网友手打，如有错字请见谅）</p>
<div class="p">%s</div>
</body>
</html>
""" % (CH1_DIVS, line())

# 第二章：整章一个 div，用 <br> 分段，外加一个 <p> —— 旧逻辑同样跳过
CH2 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="utf-8"/><title>第二章 换行分段</title>
<link rel="stylesheet" type="text/css" href="../Styles/site.css"/></head>
<body>
<h2>第二章 换行分段</h2>
<div class="txt">
%s
</div>
<p class="note">（未完待续）</p>
</body>
</html>
""" % "<br/>\n".join(line() for _ in range(10))

# 第三章：正常 <p>，用来确认没有被改坏
CH3 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="utf-8"/><title>第三章 本来就是段落</title>
<link rel="stylesheet" type="text/css" href="../Styles/site.css"/></head>
<body>
<h2>第三章 本来就是段落</h2>
%s
</body>
</html>
""" % "\n".join("<p>%s</p>" % line() for _ in range(8))


def main():
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", CONTAINER)
        z.writestr("OEBPS/content.opf", OPF)
        z.writestr("OEBPS/Styles/site.css", CSS)
        z.writestr("OEBPS/Text/ch1.xhtml", CH1)
        z.writestr("OEBPS/Text/ch2.xhtml", CH2)
        z.writestr("OEBPS/Text/ch3.xhtml", CH3)
    print("已生成 %s（%.0f KB）" % (OUT, os.path.getsize(OUT) / 1024))
    print("  3 章，全部顶格；第 1、2 章各夹了一个 <p>")


if __name__ == "__main__":
    main()
