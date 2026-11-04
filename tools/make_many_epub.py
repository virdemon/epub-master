# -*- coding: utf-8 -*-
"""生成一本"图片特别多"的样书，用来验证图片浏览的按需加载与筛选。

图故意造成纯色块（体积小、像素多）：解压后每张都是真实像素，
解码成本和大图一样，但整本书只有 1MB 上下，测试跑得动。

结构：
  20 章 / 120 张图
  - 30 张在正文里被引用（分布在前 20 章）
  - 2 张只被样式表 url() 引用（验证「样式表引用」这条标注）
  - 其余 88 张没有任何引用（验证「未引用」标注与筛选）
"""

import os
import struct
import sys
import zipfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

IMG_COUNT = 120
CHAPTERS = 20


def solid_png(width, height, rgb):
    """纯色 PNG，filter=0 逐行写，zlib 压得很小。"""
    row = bytes(rgb) * width
    raw = bytearray()
    for _ in range(height):
        raw.append(0)
        raw.extend(row)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + chunk(b"IEND", b""))


def size_for(i):
    # 五种尺寸轮着来，方便按分辨率排序/筛选时看出差别
    return [(2400, 3200), (1600, 1200), (1200, 1600), (800, 1000), (600, 800)][i % 5]


def color_for(i):
    return ((i * 37 + 60) % 256, (i * 91 + 30) % 256, (i * 53 + 120) % 256)


def chapter_xhtml(title, paras, images):
    body = ["<h1>%s</h1>" % title]
    for i in range(paras):
        if i in images:
            body.append('<p class="pic"><img src="../Img/%s" alt=""/></p>' % images[i])
        body.append("<p>%s 第 %d 段。这段文字只是把本章撑到正常长度，没有别的意思。</p>"
                    % (title, i + 1))
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" '
        'xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">'
        '<head><meta charset="utf-8"/><title>%s</title>'
        '<link rel="stylesheet" type="text/css" href="../Styles/main.css"/></head>'
        "<body>%s</body></html>" % (title, "\n".join(body))
    )


def build(out_path):
    names = ["p%03d.png" % (i + 1) for i in range(IMG_COUNT)]
    imgs = {}
    for i, n in enumerate(names):
        imgs[n] = solid_png(*size_for(i), color_for(i))

    # 前 30 张分给 20 章；另外 2 张只在 CSS 里出现
    referenced = names[:30]
    per_ch = {}
    for k, n in enumerate(referenced):
        ch = k % CHAPTERS
        # 段落索引固定在 2..9，落在 10 段正文范围内，保证真的被引用
        per_ch.setdefault(ch, {})[2 + k % 8] = n

    chs = []
    for c in range(CHAPTERS):
        chs.append(chapter_xhtml("第%d章 大量图片" % (c + 1), 10, per_ch.get(c, {})))

    css = (
        "body{margin:0;padding:1em;font-family:serif;line-height:1.8}\n"
        ".pic{margin:1.2em 0;text-align:center}\n"
        ".pic img{max-width:100%%;height:auto}\n"
        ".deco{background-image:url('../Img/%s');background-size:cover;height:40px}\n"
        ".deco2{background-image:url(../Img/%s)}\n" % (names[30], names[31])
    )

    items = "".join(
        '<item id="c%d" href="Text/c%d.xhtml" media-type="application/xhtml+xml"/>' % (i, i)
        for i in range(len(chs))
    )
    img_items = "".join(
        '<item id="i%03d" href="Img/%s" media-type="image/png"/>' % (i + 1, n)
        for i, n in enumerate(names)
    )
    spine = "".join('<itemref idref="c%d"/>' % i for i in range(len(chs)))
    nav_li = "".join('<li><a href="Text/c%d.xhtml">第%d章 大量图片</a></li>' % (i, i + 1)
                     for i in range(len(chs)))

    opf = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" '
        'unique-identifier="BookId" xml:lang="zh-CN">\n'
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
        "<dc:title>大量图片测试书</dc:title>"
        "<dc:creator>测试</dc:creator>"
        "<dc:language>zh-CN</dc:language>"
        '<dc:identifier id="BookId">urn:uuid:many-images-test</dc:identifier>'
        '<meta property="dcterms:modified">2024-05-01T00:00:00Z</meta>'
        "</metadata>\n"
        '<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" '
        'properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
        '<item id="css" href="Styles/main.css" media-type="text/css"/>%s%s</manifest>\n'
        '<spine toc="ncx">%s</spine>\n</package>' % (items, img_items, spine)
    )

    nav = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" '
        'lang="zh-CN"><head><meta charset="utf-8"/><title>目录</title></head><body>'
        '<nav epub:type="toc" id="toc"><h1>目录</h1><ol>%s</ol></nav></body></html>' % nav_li
    )

    points = "".join(
        '<navPoint id="n%d" playOrder="%d"><navLabel><text>第%d章 大量图片</text></navLabel>'
        '<content src="Text/c%d.xhtml"/></navPoint>' % (i, i + 1, i + 1, i)
        for i in range(len(chs))
    )
    ncx = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">'
        '<head><meta name="dtb:uid" content="urn:uuid:many-images-test"/></head>'
        '<docTitle><text>大量图片测试书</text></docTitle><navMap>%s</navMap></ncx>' % points
    )

    container = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
        '<rootfiles><rootfile full-path="OEBPS/content.opf" '
        'media-type="application/oebps-package+xml"/></rootfiles></container>'
    )

    with zipfile.ZipFile(out_path, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", container, zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/content.opf", opf, zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/nav.xhtml", nav, zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/toc.ncx", ncx, zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/Styles/main.css", css, zipfile.ZIP_DEFLATED)
        for i, ch in enumerate(chs):
            z.writestr("OEBPS/Text/c%d.xhtml" % i, ch, zipfile.ZIP_DEFLATED)
        for n, data in imgs.items():
            z.writestr("OEBPS/Img/" + n, data, zipfile.ZIP_DEFLATED)

    print("已生成: %s (%.2f MB, %d 张图)" %
          (out_path, os.path.getsize(out_path) / 1048576, len(imgs)))


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "test", "sample_many.epub")
    build(out)
