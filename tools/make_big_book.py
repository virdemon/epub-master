# -*- coding: utf-8 -*-
"""造一本大体积样书，用来验证「压到 N MB 以内」这条硬指标。

用法：python tools/make_big_book.py 60      # 约 60MB
图片用真实 PNG 反复引用不同文件名，保证是不可压缩的大块数据。
"""
import os, sys, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'test', 'sample_broken.epub')
TARGET_MB = float(sys.argv[1]) if len(sys.argv) > 1 else 60
OUT = os.path.join(ROOT, 'test', 'sample_big.epub')

with zipfile.ZipFile(SRC) as z:
    IMG = z.read('OEBPS/Images/fig1.png')   # 6.2MB
    IMG2 = z.read('OEBPS/Images/cover.png')  # 3.1MB

IMG_MB = (len(IMG) + len(IMG2)) / 1048576
# 每章配两张图，算出需要多少章
n_ch = max(4, int(TARGET_MB / IMG_MB) + 1)

TEXT = ('江面上起了雾，船工的号子从很远的地方传过来，一声接一声，像是有人在雾里敲着一面破锣。'
        '他把手揣进袖子里，指节冻得发僵，脑子里却翻来覆去只有一句话：这趟货，不能丢。')

def chap(i):
    body = []
    for k in range(12):
        body.append(f'<p>{TEXT}（第 {i} 章第 {k + 1} 段）</p>')
    body.append(f'<div class="fig"><img src="../Images/a{i}.png" alt="图A{i}" /></div>')
    for k in range(12, 24):
        body.append(f'<p>{TEXT}（第 {i} 章第 {k + 1} 段）</p>')
    body.append(f'<div class="fig"><img src="../Images/b{i}.png" alt="图B{i}" /></div>')
    return ('<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n'
            '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN" lang="zh-CN">'
            f'<head><meta charset="utf-8"/><title>第{i}章</title>'
            '<link rel="stylesheet" type="text/css" href="../Styles/book.css"/></head>'
            f'<body><h2>第 {i} 章　长夜</h2>{"".join(body)}</body></html>')

items, spine, navs = [], [], []
items.append('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>')
items.append('<item id="css" href="Styles/book.css" media-type="text/css"/>')
for i in range(1, n_ch + 1):
    items.append(f'<item id="c{i}" href="Text/c{i}.xhtml" media-type="application/xhtml+xml"/>')
    items.append(f'<item id="a{i}" href="Images/a{i}.png" media-type="image/png"/>')
    items.append(f'<item id="b{i}" href="Images/b{i}.png" media-type="image/png"/>')
    spine.append(f'<itemref idref="c{i}"/>')
    navs.append(f'<li><a href="Text/c{i}.xhtml">第 {i} 章　长夜</a></li>')

opf = ('<?xml version="1.0" encoding="utf-8"?>\n'
       '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">'
       '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
       '<dc:identifier id="bookid">urn:uuid:8b2c1d44-2a51-4c9e-8f33-1a2b3c4d5e6f</dc:identifier>'
       '<dc:title>大体积压缩测试书</dc:title><dc:creator>压力测试</dc:creator>'
       '<dc:language>zh-CN</dc:language><dc:date>2026-10-28</dc:date>'
       '<meta property="dcterms:modified">2026-10-28T00:00:00Z</meta></metadata>'
       f'<manifest>{"".join(items)}</manifest>'
       f'<spine>{"".join(spine)}</spine></package>')

nav = ('<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n'
       '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">'
       '<head><meta charset="utf-8"/><title>目录</title></head><body>'
       f'<nav epub:type="toc" id="toc"><h1>目录</h1><ol>{"".join(navs)}</ol></nav></body></html>')

css = 'body{margin:0;padding:0}p{margin:0 0 .4em;line-height:1.6}div.fig{text-align:center}'
container = ('<?xml version="1.0" encoding="utf-8"?>\n'
             '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
             '<rootfiles><rootfile full-path="OEBPS/content.opf" '
             'media-type="application/oebps-package+xml"/></rootfiles></container>')

if os.path.exists(OUT):
    os.remove(OUT)
with zipfile.ZipFile(OUT, 'w') as z:
    z.writestr(zipfile.ZipInfo('mimetype'), 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
    z.writestr('META-INF/container.xml', container)
    z.writestr('OEBPS/content.opf', opf)
    z.writestr('OEBPS/nav.xhtml', nav)
    z.writestr('OEBPS/Styles/book.css', css)
    for i in range(1, n_ch + 1):
        z.writestr(f'OEBPS/Images/a{i}.png', IMG, compress_type=zipfile.ZIP_STORED)
        z.writestr(f'OEBPS/Images/b{i}.png', IMG2, compress_type=zipfile.ZIP_STORED)
        z.writestr(f'OEBPS/Text/c{i}.xhtml', chap(i))

print(f'已生成 {OUT}　{os.path.getsize(OUT)/1048576:.1f} MB　{n_ch} 章　{n_ch*2} 图')
