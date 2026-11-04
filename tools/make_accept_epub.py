# -*- coding: utf-8 -*-
"""生成一本"像真书"的验收样书：故意保留原书的排版毛病，用来验证处理效果。

毛病清单（每一条都对应需求里的一个功能点）：
  1. 原书样式表没有首行缩进，body 还带 margin/padding  —— 验证「排版保护」
  2. 段落写成 <div>、<div><p> 空壳、<br> 连行          —— 验证段落重建
  3. 大量空 <p>&nbsp;</p>                              —— 验证空行清理
  4. <strong>/<b>/<em> 混用                             —— 验证加粗不被吃掉
  5. 3 张大图 + 图注 <p class="caption">               —— 验证图片顺序与引用
  6. 内嵌 ttf 字体                                     —— 验证字体处理
  7. 图注里写死 width/height                           —— 验证尺寸归一
  8. 一本 3 万字 10 章，图片共约 10MB                   —— 验证压缩与分卷
"""
import os, sys, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_IMG = os.path.join(ROOT, 'test', 'sample_broken.epub')
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'test', 'sample_book.epub')

# 复用坏包里的真实图片（3.2MB + 6.4MB），避免造图
with zipfile.ZipFile(SRC_IMG) as z:
    IMG_A = z.read('OEBPS/Images/cover.png')
    IMG_B = z.read('OEBPS/Images/fig1.png')
    try:
        FONT = z.read([n for n in z.namelist() if n.lower().endswith('.ttf')][0])
    except IndexError:
        FONT = b''

CHAPTERS = [
    ('第一章　渡口无船', 'chapter1'),
    ('第二章　灯火不归', 'chapter2'),
    ('第三章　长夜将尽', 'chapter3'),
    ('第四章　旧事如尘', 'chapter4'),
    ('第五章　山中来客', 'chapter5'),
    ('第六章　风声渐紧', 'chapter6'),
    ('第七章　一纸空文', 'chapter7'),
    ('第八章　铁与火', 'chapter8'),
    ('第九章　归途', 'chapter9'),
    ('第十章　新的渡口', 'chapter10'),
]

SENT = [
    '江面上起了雾，船工的号子从很远的地方传过来，一声接一声，像是有人在雾里敲着一面破锣。',
    '他把手揣进袖子里，指节冻得发僵，脑子里却翻来覆去只有一句话：这趟货，不能丢。',
    '岸边的柳树早没了叶子，枝子垂下来，扫着水面，扫出一道一道细碎的白痕。',
    '那时节谁也没想到，一场雨能把整条街的人心都泡软了。',
    '她说这话的时候没有抬头，手里还在剥一颗花生，剥得很慢，像在剥一件旧事。',
    '灯芯爆了一下，火苗歪过去，屋子里的影子跟着晃了晃，又立住了。',
    '街上有人在卖热汤面，白汽腾起来，把招牌上的字熏得看不清。',
    '他忽然想起许多年前的一个下午，也是这样灰蒙蒙的天，也是这样没有尽头的等。',
    '船到了河心，水声忽然大了起来，盖过了所有说话的声音。',
    '后来许多人都说，那一天的风向是反的，可没人说得清它到底从哪边吹来。',
]

def para(text, style='p'):
    return f'<{style}>{text}</{style}>'

def chapter_xhtml(title, body, extra_head=''):
    return f'''<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>{title}</title>
  <link rel="stylesheet" type="text/css" href="../Styles/book.css" />
  {extra_head}
</head>
<body>
  <h2 class="ch-title">{title}</h2>
{body}
</body>
</html>
'''

def build_body(idx):
    """混排四种段落形态，模拟抓取/转换来的脏 HTML。"""
    parts = []
    parts.append('<p>&nbsp;</p>')                       # 空行
    # 1) 正常的 p
    parts.append(para(SENT[idx % 10] + SENT[(idx + 1) % 10]))
    # 2) div 直接包文字（原书没有 p，缩进挂不上）
    parts.append('<div class="txt">' + SENT[(idx + 2) % 10] + SENT[(idx + 3) % 10] + '</div>')
    # 3) div > p 空壳
    parts.append('<div class="wrap"><p>' + SENT[(idx + 4) % 10] + '</p></div>')
    # 4) 带加粗与斜体的段落
    parts.append(para('他忽然明白，<strong>' + SENT[(idx + 5) % 10] + '</strong>'
                      '这句话不是问句，是一个结论。'
                      '而<b>结论是不能改的</b>，' + SENT[(idx + 6) % 10] +
                      '他低下头，<em>像是认了</em>。'))
    parts.append('<p> </p>')                            # 只有空格的行
    # 5) br 连行的一段（抓取网页最常见）
    parts.append('<p>' + SENT[(idx + 7) % 10] + '<br/>' +
                 SENT[(idx + 8) % 10] + '<br/>' +
                 SENT[(idx + 9) % 10] + '</p>')
    # 前 3 章插图，验证图片顺序与图注
    if idx < 3:
        src = f'../Images/p{idx + 1}.png'
        parts.append(f'<div class="fig"><img src="{src}" width="600" height="800" alt="插图{idx + 1}" />'
                     f'<p class="caption">图 {idx + 1}　这是第 {idx + 1} 幅插图，应紧跟在上一段之后。</p></div>')
        parts.append(para(SENT[(idx + 1) % 10] + SENT[(idx + 4) % 10]))
    # 再补几段把每章撑到 3000 字左右
    base = SENT[(idx * 3) % 10]
    for k in range(22):
        parts.append(para(base + SENT[(idx + k) % 10] + SENT[(idx + k * 2 + 1) % 10], 'p'))
        if k == 4:
            parts.append('<p></p>')                     # 完全空的 p
    return '\n  '.join(parts)

def main():
    css = '''@charset "utf-8";
/* 原书样式：故意没有首行缩进，还带一堆写死的固定值 */
body { margin: 8px 12px; padding: 0 6px; font-family: "Songti SC", serif; font-size: 17px; line-height: 1.6; }
h2.ch-title { font-size: 22px; text-align: center; margin: 1.2em 0 0.8em; font-weight: normal; }
p { margin: 0 0 0.35em; text-indent: 0; }
div.txt { margin: 0 0 0.35em; }
div.wrap { margin: 0; }
div.fig { text-align: center; margin: 1em 0; }
p.caption { text-align: center; font-size: 13px; color: #666; margin-top: 0.3em; }
strong, b { font-weight: bold; }
'''
    opf_items, spine, nav_li = [], [], []
    opf_items.append('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>')
    opf_items.append('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>')
    opf_items.append('<item id="css" href="Styles/book.css" media-type="text/css"/>')
    opf_items.append('<item id="cover-img" href="Images/cover.png" media-type="image/png" properties="cover-image"/>')
    for i in range(3):
        opf_items.append(f'<item id="img{i+1}" href="Images/p{i+1}.png" media-type="image/png"/>')
    if FONT:
        opf_items.append('<item id="font1" href="Fonts/main.ttf" media-type="font/ttf"/>')
    for i, (title, slug) in enumerate(CHAPTERS, 1):
        opf_items.append(f'<item id="{slug}" href="Text/{slug}.xhtml" media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="{slug}"/>')
        nav_li.append(f'      <li><a href="Text/{slug}.xhtml">{title}</a></li>')

    opf = f'''<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:6f1a0c22-1f3e-4d6b-9a51-7c0d5e8b1a33</dc:identifier>
    <dc:title>雾中渡口</dc:title>
    <dc:creator>沈砚秋</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:publisher>验收样书生成器</dc:publisher>
    <dc:date>2026-10-28</dc:date>
    <meta property="dcterms:modified">2026-10-28T00:00:00Z</meta>
  </metadata>
  <manifest>
    {chr(10).join('    ' + x for x in opf_items)}
  </manifest>
  <spine toc="ncx">
    {chr(10).join('    ' + x for x in spine)}
  </spine>
</package>
'''
    nav = f'''<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">
<head><meta charset="utf-8" /><title>目录</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
{chr(10).join(nav_li)}
    </ol>
  </nav>
</body>
</html>
'''
    points = '\n'.join(
        f'    <navPoint id="np{i}" playOrder="{i}"><navLabel><text>{t}</text></navLabel>'
        f'<content src="Text/{s}.xhtml"/></navPoint>'
        for i, (t, s) in enumerate(CHAPTERS, 1))
    ncx = f'''<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:6f1a0c22-1f3e-4d6b-9a51-7c0d5e8b1a33"/></head>
  <docTitle><text>雾中渡口</text></docTitle>
  <navMap>
{points}
  </navMap>
</ncx>
'''
    container = '''<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
'''

    if os.path.exists(OUT):
        os.remove(OUT)
    with zipfile.ZipFile(OUT, 'w') as z:
        z.writestr(zipfile.ZipInfo('mimetype'), 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
        z.writestr('META-INF/container.xml', container, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/content.opf', opf, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/nav.xhtml', nav, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/toc.ncx', ncx, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/Styles/book.css', css, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/Images/cover.png', IMG_A, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/Images/p1.png', IMG_A, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/Images/p2.png', IMG_B, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/Images/p3.png', IMG_B, compress_type=zipfile.ZIP_DEFLATED)
        if FONT:
            z.writestr('OEBPS/Fonts/main.ttf', FONT, compress_type=zipfile.ZIP_DEFLATED)
        for i, (title, slug) in enumerate(CHAPTERS):
            z.writestr(f'OEBPS/Text/{slug}.xhtml', chapter_xhtml(title, build_body(i)),
                       compress_type=zipfile.ZIP_DEFLATED)

    size = os.path.getsize(OUT)
    words = sum(len(build_body(i)) for i in range(len(CHAPTERS)))
    print(f'已生成 {OUT}')
    print(f'  {size/1048576:.2f} MB · {len(CHAPTERS)} 章 · 正文约 {words} 字符 · 图 3 张 · 字体 1 个')

if __name__ == '__main__':
    main()
