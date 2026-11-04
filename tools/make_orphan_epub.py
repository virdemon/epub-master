"""造一本"manifest 与文件对不上"的书 —— 复刻从网站下载的书最常见的坏法。

真实场景（用户反馈）：
  - 包里有一堆 img_0001.jpg、img_0002.jpg ……
  - OPF 的 manifest 里一个都没声明
  - 结果 Calibre / 阅读器逐张报「此文件未列在manifest文件中」，图片全都不显示

同时埋进反向的坏法：
  - manifest 声明了幽灵文件（图片被删了，声明还在）
  - 封面 meta 指向一个不存在的 id
  - 一张图的路径大小写写错（../images/IMG_0004.PNG vs Images/img_0004.png）

这两种错误都必须由 epubfix 在输出里修掉。
"""

import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "test", "sample_broken.epub")
OUT = os.path.join(ROOT, "test", "sample_orphan.epub")

CONTAINER = """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

# 关键：manifest 只声明两章正文 + 一个根本不存在的幽灵图片，
# 包里实际存在的 6 张图片一张都没声明。
OPF = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>飘在 manifest 外的插图</dc:title>
    <dc:creator>测试作者</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:identifier id="BookId">urn:uuid:orphan-images-0001</dc:identifier>
    <meta name="cover" content="ghost-cover"/>
  </metadata>
  <manifest>
    <item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ghost-cover" href="Images/cover_missing.png" media-type="image/png"/>
    <item id="ghost-fig" href="Images/figure_missing.png" media-type="image/png"/>
    <item id="css" href="Styles/main.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>
"""

CSS = """@charset "utf-8";
body { font-size: 14px; line-height: 22px; margin: 0 5px; }
p { text-indent: 2em; font-size: 13px; }
h1 { font-size: 20px; text-align: center; }
img { width: 600px; height: 800px; }
"""

CH1 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="utf-8"/><title>第一章</title>
<link rel="stylesheet" type="text/css" href="../Styles/main.css"/>
</head>
<body>
<h1>第一章 那些没有身份的插图</h1>
<p style="text-indent:0; font-size:12px;">这一章里的图片全都存在于包里，但 manifest 一个都没写。</p>
<p>第一张图在下面，接着是第二张。如果阅读器报「未列在manifest中」，这里就是空白。</p>
<p><img src="../Images/img_0001.png" width="600" height="800" alt=""/></p>
<p>这是第一张图后面的说明文字，用来确认图片是否按位置插入。</p>
<p><img src="../Images/img_0002.png" alt=""/></p>
<p>这是第二张图后面的文字，段落之间不该出现空行。</p>
<p class="pic"><img src="../Images/img_0003.png" alt=""/></p>
<p>还有一张指向根本不存在文件的图片，这一处应该被如实报告。</p>
<p><img src="../Images/nowhere.png" alt=""/></p>
</body>
</html>
"""

CH2 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="utf-8"/><title>第二章</title>
<link rel="stylesheet" type="text/css" href="../Styles/main.css"/>
</head>
<body>
<h1>第二章 幽灵声明</h1>
<p>这一章测试反向错误：manifest 声明了 ghost-cover 与 ghost-fig 两个图片，但文件根本不存在。</p>
<p><b>加粗的文字必须正常显示。</b>斜体<i>也要正常</i>。</p>
<p><img src="../images/IMG_0004.PNG" alt=""/></p>
<p>第四张图之后的段落。</p>
</body>
</html>
"""


def main():
    src = zipfile.ZipFile(SRC)
    imgs = [n for n in src.namelist() if n.startswith("OEBPS/Images/")]
    imgs.sort()
    # 只用两张图循环复用，凑出 4 个不同的文件名
    pool = [src.read(n) for n in imgs]

    files = []
    for i in range(1, 5):
        files.append(("OEBPS/Images/img_%04d.png" % i, pool[(i - 1) % len(pool)]))

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", CONTAINER)
        z.writestr("OEBPS/content.opf", OPF)
        z.writestr("OEBPS/Styles/main.css", CSS)
        z.writestr("OEBPS/Text/ch1.xhtml", CH1)
        z.writestr("OEBPS/Text/ch2.xhtml", CH2)
        # 关键：这些图片一次都没有出现在 manifest 里
        for name, data in files:
            z.writestr(name, data)

    print("已生成 %s（%.2f MB）" % (OUT, os.path.getsize(OUT) / 1048576))
    print("  包内图片 4 张，manifest 声明 0 张（另有 2 个幽灵声明）")


if __name__ == "__main__":
    main()
