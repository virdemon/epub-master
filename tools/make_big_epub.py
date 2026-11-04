"""生成一本体积较大的样书（默认约 57 MB），用于验证"按目标体积反推图片预算"是否真的达标。

图片用 os.urandom 造噪点：随机数据几乎无法被 PNG 压缩，能真实模拟
"图片未优化、整本书体积失控"的情况。
"""

import os
import struct
import sys
import zipfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def make_noise_png(width, height):
    raw = bytearray()
    row_bytes = width * 3
    for _ in range(height):
        raw.append(0)
        raw.extend(os.urandom(row_bytes))

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 1))
        + chunk(b"IEND", b"")
    )


def chapter(title, paras, images=()):
    body = ['<h1>%s</h1>' % title]
    for i in range(paras):
        if i in images:
            body.append('<p class="pic"><img src="../%s" alt=""/></p>' % images[i])
        body.append("<p>%s 第 %d 段。这段文字用于撑起正文结构，本身没有意义。</p>" % (title, i + 1))
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/>'
        "<title>%s</title></head><body>%s</body></html>" % (title, "\n".join(body))
    )


def build(out_path, image_count=6, w=1600, h=2000):
    imgs = {}
    for i in range(image_count):
        name = "Im/%s%02d.png" % ("p", i + 1)
        imgs[name] = make_noise_png(w, h)
        print("  生成图片 %d/%d  %.1f MB" % (i + 1, image_count, len(imgs[name]) / 1048576))

    chapters = []
    per = max(1, image_count // 2)
    for c in range(3):
        mapping = {}
        if c == 0:
            mapping = {2: "Im/p01.png", 5: "Im/p02.png", 8: "Im/p03.png"}
        elif c == 1:
            mapping = {3: "Im/p04.png", 7: "Im/p05.png"}
        elif c == 2:
            mapping = {2: "Im/p06.png"} if image_count >= 6 else {}
        chapters.append(chapter("第%d章 测试" % (c + 1), 12, mapping))

    items = "".join(
        '<item id="c%d" href="Text/c%d.xhtml" media-type="application/xhtml+xml"/>' % (i, i)
        for i in range(len(chapters))
    )
    img_items = "".join(
        '<item id="i%s" href="%s" media-type="image/png"/>' % (n.replace("/", "_"), n)
        for n in imgs
    )
    spine = "".join('<itemref idref="c%d"/>' % i for i in range(len(chapters)))

    opf = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">\n'
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
        "<dc:title>体积测试书</dc:title>"
        "<dc:creator>测试</dc:creator>"
        "<dc:language>zh-CN</dc:language>"
        '<dc:identifier id="BookId">urn:uuid:big-test-book</dc:identifier>'
        "</metadata>\n<manifest>%s%s</manifest>\n<spine>%s</spine>\n</package>" % (items, img_items, spine)
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
        for i, ch in enumerate(chapters):
            z.writestr("OEBPS/Text/c%d.xhtml" % i, ch, zipfile.ZIP_DEFLATED)
        for n, data in imgs.items():
            z.writestr("OEBPS/" + n, data, zipfile.ZIP_DEFLATED)

    print("已生成: %s (%.1f MB)" % (out_path, os.path.getsize(out_path) / 1048576))


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "test", "sample_big.epub")
    build(out)
