# -*- coding: utf-8 -*-
"""
造一本"结构最差"的样书，专门用来复现截图里的排版问题：

    <body>
      <h1>章节名</h1>
      一整块文字，用 <br> 分行，没有任何 <p>
      <b>[论坛] …</b><br> 这种引用行
      <img> 插图
      <table> / <blockquote> / <pre> / <div class="poetry">
      一个塞满 <br> 的 <p>（整章一段）
    </body>

现实里很多网络书源、TXT 转换器导出的 EPUB 就长这样：没有段落标签，
缩进无处可挂，连续空白一折叠就糊成一整块。EPUB Master 必须在这种书上
也能产出正常段落，而不仅仅是"换个 CSS"。

用法：python tools/make_brtext_epub.py [输出路径]
"""
import sys, os, zipfile, struct, zlib

CHAPTERS = 4


def solid_png(w, h, rgb):
    raw = bytearray()
    for _ in range(h):
        raw.append(0)
        raw.extend(bytes(rgb) * w)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + chunk(b"IEND", b""))


def chapter_body(idx):
    """一章的正文：完全是"文字 + <br>"的写法，故意不放一个 <p>"""
    return """  <h1>第 %d 章 结构测试</h1>
  <p class="center">· 本章用于验证段落重建 ·</p>
  这是第一段正文，前半句在这里<br />
  这是被硬折行截断的半句，末尾没有标点<br />
  它应该和上一行接回同一个段落。<br />
  <br />
  独立的第二段。<br />
  <br />
  <b>[论坛] 第一行引用</b><br />
  <b>[论坛] 第二行引用</b><br />
  <b></b><br />
  <br />
  <img src="../Images/pic%d.png" alt="插图 %d" /><br />
  <br />
  <table>
    <tr><th>项目</th><th>数值</th></tr>
    <tr><td>甲</td><td>1</td></tr>
  </table>
  <blockquote><p>引用块里的一段话，不应该带首行缩进。</p></blockquote>
  <pre>预排版文本
    保留    原有空格</pre>
  <div class="poetry">床前明月光<br />疑是地上霜<br />举头望明月<br />低头思故乡</div>
  <p>整章塞在一个 p 里的第一句。<br />第二句也在这里。<br />第三句结束。</p>
  <p>真正的段落，原书就有，必须原样保留。</p>
""" % (idx, idx, idx)


def build(out_path):
    opf_items, spine, nav_lis = [], [], []
    files = {}

    for i in range(1, CHAPTERS + 1):
        name = "ch%02d.xhtml" % i
        files["OEBPS/text/" + name] = (
            '<?xml version="1.0" encoding="utf-8"?>\n'
            '<!DOCTYPE html>\n'
            '<html xmlns="http://www.w3.org/1999/xhtml" '
            'xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">\n'
            '<head><meta charset="utf-8" /><title>第 %d 章 结构测试</title>'
            '<link rel="stylesheet" type="text/css" href="../Styles/style.css" /></head>\n'
            '<body>\n%s</body>\n</html>\n' % (i, chapter_body(i))
        ).encode("utf-8")
        opf_items.append('    <item id="ch%d" href="text/%s" media-type="application/xhtml+xml" />' % (i, name))
        spine.append('    <itemref idref="ch%d" />' % i)
        nav_lis.append('      <li><a href="text/%s">第 %d 章 结构测试</a></li>' % (name, i))

    files["OEBPS/Styles/style.css"] = (
        "body { font-family: serif; line-height: 1.6; }\n"
        "p { text-indent: 2em; margin: 0 0 0.8em 0; }\n"
    ).encode("utf-8")

    for i in range(1, CHAPTERS + 1):
        files["OEBPS/Images/pic%d.png" % i] = solid_png(360, 240, (60 + i * 30, 120, 200))
        opf_items.append('    <item id="pic%d" href="Images/pic%d.png" media-type="image/png" />' % (i, i))

    files["OEBPS/nav.xhtml"] = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<!DOCTYPE html>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">\n'
        '<head><meta charset="utf-8" /><title>目录</title></head>\n'
        '<body><nav epub:type="toc" id="toc"><h1>目录</h1><ol>\n%s\n</ol></nav></body>\n</html>\n'
        % "\n".join(nav_lis)
    ).encode("utf-8")

    files["OEBPS/content.opf"] = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">\n'
        '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
        '    <dc:identifier id="uid">urn:uuid:brtext-0001</dc:identifier>\n'
        '    <dc:title>换行分段样书</dc:title>\n'
        '    <dc:creator>virdemon</dc:creator>\n'
        '    <dc:language>zh-CN</dc:language>\n'
        '    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>\n'
        '  </metadata>\n'
        '  <manifest>\n'
        '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />\n'
        '    <item id="css" href="Styles/style.css" media-type="text/css" />\n'
        '%s\n'
        '  </manifest>\n'
        '  <spine>\n%s\n  </spine>\n'
        '</package>\n'
        % ("\n".join(opf_items), "\n".join(spine))
    ).encode("utf-8")

    files["META-INF/container.xml"] = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
        '  <rootfiles><rootfile full-path="OEBPS/content.opf" '
        'media-type="application/oebps-package+xml" /></rootfiles>\n'
        '</container>\n'
    ).encode("utf-8")

    if os.path.exists(out_path):
        os.remove(out_path)
    with zipfile.ZipFile(out_path, "w") as z:
        # mimetype 必须第一个、不压缩
        z.writestr(zipfile.ZipInfo("mimetype"), b"application/epub+zip", zipfile.ZIP_STORED)
        for name, data in files.items():
            z.writestr(name, data, zipfile.ZIP_DEFLATED)
    return out_path


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "test", "sample_brtext.epub")
    print("已生成", build(out), os.path.getsize(out), "字节")
