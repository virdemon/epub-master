"""造一本专门用来测"重复图片清理"的样书 test/sample_dup.epub。

里面刻意放齐了这几种情况（顺序就是阅读顺序）：

  1. 封面 cover.png，正文第一章又用到同一张（封面与正文重复）
  2. 第一章：a.png 出现两次（同一图片被多个正文位置引用）
  3. 第二章：a.png 又出现（跨章节重复）
              b_copy.png 与 b.png 字节完全相同、文件名与目录不同（同图不同名）
              b_similar.png 与 b.png 像素上只差一个点（相似但不同，绝不能删）
  4. 第三章：a.png 第三次出现
  5. 第四到九十三章：从 90 张不重复图里循环取用，凑出"几百张图片"的规模

图片用确定性噪声生成，保证每次跑出来的字节完全一样，测试结果可复现。
"""

import hashlib
import os
import struct
import zipfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "test", "sample_dup.epub")

W, H = 200, 240


def _lcg(seed):
    x = seed & 0xFFFFFFFF

    def nxt():
        nonlocal x
        x = (1103515245 * x + 12345) & 0x7FFFFFFF
        return x
    return nxt


def make_raw(seed, tint):
    """每行一个 filter 字节 0，后面跟 RGB。"""
    rnd = _lcg(seed)
    raw = bytearray()
    for y in range(H):
        raw.append(0)
        for x in range(W):
            n = rnd() & 7
            raw.append((x * 3 + tint[0] + y + n) & 0xFF)
            raw.append((y * 2 + tint[1] + x // 2 + n) & 0xFF)
            raw.append((x + y + tint[2] + n) & 0xFF)
    return bytes(raw)


def wrap_png(raw, level=6):
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, level)) + chunk(b"IEND", b""))


def make_png(seed, tint):
    return wrap_png(make_raw(seed, tint))


def tweak_one_pixel(raw):
    """改掉正中间一个像素：尺寸不变、体积几乎不变、画面几乎一样，但内容不同。"""
    buf = bytearray(raw)
    row = H // 2
    col = W // 2
    idx = row * (W * 3 + 1) + 1 + col * 3
    buf[idx] = (buf[idx] + 96) & 0xFF
    return bytes(buf)


def chapter(title, blocks):
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<!DOCTYPE html>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" '
        'xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">\n'
        "<head><title>%s</title>"
        '<link rel="stylesheet" type="text/css" href="../styles/main.css"/></head>\n'
        "<body><h1>%s</h1>\n%s\n</body></html>\n" % (title, title, "\n".join(blocks))
    )


def pic(path):
    return '<p class="pic"><img src="../%s" alt="插图"/></p>' % path


def para(text):
    return "<p>%s</p>" % text


def main():
    files = {}

    for i in range(90):
        files["OEBPS/images/u%03d.png" % i] = make_png(1000 + i * 7, (i * 5 % 251, i * 11 % 241, i * 17 % 233))

    files["OEBPS/images/cover.png"] = make_png(4242, (12, 40, 90))
    files["OEBPS/images/a.png"] = make_png(777, (200, 30, 30))
    b_raw = make_raw(888, (20, 160, 90))
    files["OEBPS/images/b.png"] = wrap_png(b_raw)
    # 同一份字节，换个目录换个名字
    files["OEBPS/images/sub/b_copy.png"] = wrap_png(b_raw)
    # 同一幅画面、只是重新压过一遍（字节不同、像素完全一样）—— 只能靠像素比对认出来
    files["OEBPS/images/sub/b_same.png"] = wrap_png(b_raw, 9)
    # 相似但不同：只改了一个像素
    files["OEBPS/images/b_similar.png"] = wrap_png(tweak_one_pixel(b_raw))

    docs = []
    docs.append(("cover", "封面", chapter("封面", [
        '<div class="cover"><img src="../images/cover.png" alt="封面"/></div>'
    ])))
    docs.append(("ch1", "第一章", chapter("第一章", [
        pic("images/a.png"),
        para("第一章的正文。这里先放一张插图，后面还会再出现同一张。"),
        pic("images/b.png"),
        para("这张 b 会在第二章以另一个文件名再出现一次。"),
        pic("images/a.png"),
        para("同一章里第二次出现 a，属于重复的显示位置。")
    ])))
    docs.append(("ch2", "第二章", chapter("第二章", [
        pic("images/a.png"),
        pic("images/sub/b_copy.png"),
        pic("images/sub/b_same.png"),
        pic("images/b_similar.png"),
        para("第二章：a 跨章重复，b_copy 与 b 字节相同，b_same 像素相同但字节不同，b_similar 只差一个像素。")
    ])))
    docs.append(("ch3", "第三章", chapter("第三章", [
        pic("images/a.png"),
        pic("images/u000.png"),
        para("第三章：a 第三次出现。")
    ])))

    # 90 章循环使用 90 张唯一图，凑出几百个显示位置
    for i in range(90):
        base = (i * 7 + 3) % 90
        docs.append((
            "ch%d" % (i + 4), "第%d章" % (i + 4),
            chapter("第%d章" % (i + 4), [
                pic("images/u%03d.png" % base),
                para("这一章的正文用于撑起结构，插图来自编号 %03d。" % base),
                pic("images/u%03d.png" % ((base + 31) % 90)),
                pic("images/u%03d.png" % ((base + 61) % 90)),
            ])
        ))

    for name, _t, html in docs:
        files["OEBPS/text/%s.xhtml" % name] = html.encode("utf-8")

    files["OEBPS/styles/main.css"] = (
        "body{font-family:serif;line-height:1.7;margin:1em}"
        "h1{text-align:center;font-size:1.4em;margin:1.2em 0 .9em}"
        "p{text-indent:2em;margin:0 0 .6em}"
        "p.pic{text-indent:0;text-align:center;margin:1em 0}"
        "p.pic img{max-width:100%;height:auto}"
        "div.cover{text-align:center;margin:0}"
    ).encode("utf-8")

    manifest = [
        '<item id="css" href="styles/main.css" media-type="text/css"/>',
        '<item id="cover-img" href="images/cover.png" media-type="image/png" properties="cover-image"/>',
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
        '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    ]
    spine = []
    for name, _t, _h in docs:
        manifest.append('<item id="%s" href="text/%s.xhtml" media-type="application/xhtml+xml"/>' % (name, name))
        spine.append('<itemref idref="%s"/>' % name)
    for path in sorted(files):
        if not path.startswith("OEBPS/images/") or path.endswith("cover.png"):
            continue
        iid = "img-" + hashlib.md5(path.encode()).hexdigest()[:10]
        manifest.append('<item id="%s" href="%s" media-type="image/png"/>' % (iid, path[len("OEBPS/"):]))

    opf = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">\n'
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
        '<dc:identifier id="BookId">urn:uuid:dup-test-0001</dc:identifier>\n'
        "<dc:title>重复图片测试书</dc:title><dc:language>zh-CN</dc:language>\n"
        "<dc:creator>测试</dc:creator>\n"
        '<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>\n'
        "</metadata>\n<manifest>\n%s\n</manifest>\n"
        '<spine toc="ncx">\n%s\n</spine>\n'
        "</package>\n" % ("\n".join(manifest), "\n".join(spine))
    )
    files["OEBPS/content.opf"] = opf.encode("utf-8")

    nav_items = "".join('<li><a href="text/%s.xhtml">%s</a></li>' % (name, t) for name, t, _ in docs)
    files["OEBPS/nav.xhtml"] = (
        '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">'
        "<head><title>目录</title></head><body>"
        '<nav epub:type="toc" id="toc"><h1>目录</h1><ol>%s</ol></nav></body></html>' % nav_items
    ).encode("utf-8")

    points = "".join(
        '<navPoint id="np%d" playOrder="%d"><navLabel><text>%s</text></navLabel>'
        '<content src="text/%s.xhtml"/></navPoint>' % (i + 1, i + 1, t, name)
        for i, (name, t, _h) in enumerate(docs)
    )
    files["OEBPS/toc.ncx"] = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">'
        '<head><meta name="dtb:uid" content="urn:uuid:dup-test-0001"/></head>'
        "<docTitle><text>重复图片测试书</text></docTitle><navMap>%s</navMap></ncx>" % points
    ).encode("utf-8")

    files["META-INF/container.xml"] = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
        '<rootfiles><rootfile full-path="OEBPS/content.opf" '
        'media-type="application/oebps-package+xml"/></rootfiles></container>'
    ).encode("utf-8")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        for name in sorted(files):
            data = files[name]
            if isinstance(data, str):
                data = data.encode("utf-8")
            z.writestr(name, data, compress_type=zipfile.ZIP_DEFLATED)

    imgs = [p for p in files if p.startswith("OEBPS/images/")]
    total = sum(len(files[p]) for p in imgs)
    positions = sum(html.count("<img ") for _n, _t, html in docs)
    print("写出 %s" % OUT)
    print("章节 %d 个，图片资源 %d 个（%.2f MB），正文图片位置 %d 处"
          % (len(docs), len(imgs), total / 1048576.0, positions))


if __name__ == "__main__":
    main()
