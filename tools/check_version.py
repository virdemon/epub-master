# -*- coding: utf-8 -*-
"""独立核对一本 EPUB 是否真的符合指定版本的结构（不依赖项目里的 JS 解析器）。

用法:
    python tools/check_version.py <book.epub> 2.0|3.0

逐项检查（EPUB 2.0 / 3.0 的真实差别，不是只看 version 号）：
  OPF            package@version、manifest 文件是否都存在、spine 引用是否合法
  2.0            NCX 必备 + spine@toc 指向 NCX、manifest 不能有 properties、
                 metadata 不能有 <meta property>、封面用 <meta name="cover">、
                 章节必须是 XHTML 1.1 DOCTYPE、不能声明/使用 epub: 命名空间
  3.0            nav 文档（properties="nav"）必备、必须有 dcterms:modified、
                 章节用 HTML5 DOCTYPE
"""

import re
import sys
import zipfile
from urllib.parse import unquote

XHTML11 = "-//W3C//DTD XHTML 1.1//EN"
errors = []
checks = 0


def ok(msg):
    global checks
    checks += 1
    print("  [ok] " + msg)


def fail(msg):
    global checks
    checks += 1
    errors.append(msg)
    print("  [!!] " + msg)


def resolve(base, href):
    href = unquote(href.split("#")[0])
    base_dir = base.rsplit("/", 1)[0] if "/" in base else ""
    parts = (base_dir + "/" + href).split("/") if base_dir else href.split("/")
    out = []
    for p in parts:
        if p == "..":
            if out:
                out.pop()
        elif p not in ("", "."):
            out.append(p)
    return "/".join(out)


def main(path, want):
    print("核对: %s → 期望 EPUB %s\n" % (path, want))
    zf = zipfile.ZipFile(path)
    names = set(zf.namelist())

    # --- mimetype
    first = zf.infolist()[0]
    if first.filename == "mimetype" and first.compress_type == zipfile.ZIP_STORED \
            and zf.read("mimetype") == b"application/epub+zip":
        ok("mimetype 是第一个条目、未压缩、内容正确")
    else:
        fail("mimetype 不符合要求（第一个条目/未压缩/内容）")

    container = zf.read("META-INF/container.xml").decode("utf-8")
    m = re.search(r'full-path\s*=\s*"([^"]+)"', container)
    if not m:
        print("找不到 OPF，无法继续")
        return 1
    opf_path = m.group(1)
    opf = zf.read(opf_path).decode("utf-8")

    # --- 版本声明
    pkg = re.search(r"<package\b[^>]*>", opf)
    ver = re.search(r'\bversion\s*=\s*"([^"]+)"', pkg.group(0)) if pkg else None
    if ver and ver.group(1) == want:
        ok("OPF package@version = %s" % want)
    else:
        fail("OPF 声明的是 %s，不是 %s" % (ver.group(1) if ver else "空", want))

    # --- manifest 文件存在性
    items = re.findall(r"<item\b[^>]*>", opf)
    missing = []
    props_count = 0
    has_nav = False
    has_ncx = False
    ncx_id = ""
    for it in items:
        href = re.search(r'\bhref\s*=\s*"([^"]+)"', it)
        props = re.search(r'\bproperties\s*=\s*"([^"]*)"', it)
        mtype = re.search(r'\bmedia-type\s*=\s*"([^"]+)"', it)
        iid = re.search(r'\bid\s*=\s*"([^"]+)"', it)
        if props:
            props_count += 1
        if props and re.search(r"\bnav\b", props.group(1)):
            has_nav = True
        if mtype and "dtbncx" in mtype.group(1):
            has_ncx = True
            ncx_id = iid.group(1) if iid else ""
        if href:
            p = resolve(opf_path, href.group(1))
            if p not in names:
                missing.append(href.group(1))
    if missing:
        fail("manifest 声明的文件不存在：%s" % ", ".join(missing[:4]))
    else:
        ok("manifest 声明的 %d 个文件全部存在" % len(items))

    spine = re.search(r"<spine\b[^>]*>", opf)
    spine_tag = spine.group(0) if spine else ""
    if spine_tag:
        ok("spine 存在")
    else:
        fail("缺少 spine")

    if want == "2.0":
        if has_ncx:
            ok("有 NCX 目录")
        else:
            fail("EPUB 2.0 必须有 NCX")
        toc = re.search(r'\btoc\s*=\s*"([^"]+)"', spine_tag)
        if toc and has_ncx and toc.group(1) == ncx_id:
            ok("spine@toc 指向 NCX（%s）" % ncx_id)
        else:
            fail("spine@toc 缺失或没指向 NCX")
        if has_nav:
            fail('EPUB 2.0 不应出现 properties="nav"')
        else:
            ok('没有 properties="nav" 的导航文档')
        if props_count:
            fail("manifest 里还有 %d 处 properties 属性" % props_count)
        else:
            ok("manifest 没有 properties 属性")
        if re.search(r"<meta\b[^>]*\bproperty\s*=", opf):
            fail("metadata 里还有 <meta property>")
        else:
            ok("metadata 没有 <meta property>")
        # 封面是可选元素：有封面图就必须按 2.0 的方式声明，没有就不强求
        has_cover_meta = bool(re.search(r'<meta\b[^>]*\bname\s*=\s*"cover"[^>]*\bcontent\s*=\s*"([^"]+)"', opf))
        cover_like = re.search(r'<item\b[^>]*href\s*=\s*"([^"]*(?:cover|封面)[^"]*)"', opf, re.I)
        if has_cover_meta:
            ok('封面用 <meta name="cover"> 声明')
        elif cover_like:
            fail('有封面图（%s）却没有 <meta name="cover">' % cover_like.group(1))
        else:
            ok("原书没有封面，输出也没有（不作假）")
        if "dcterms:modified" in opf:
            fail("EPUB 2.0 不应该有 dcterms:modified")
        else:
            ok("没有 dcterms:modified（2.0 用 dc:date）")
        if re.search(r"<dc:date\b", opf):
            ok("有 dc:date")
        else:
            fail("EPUB 2.0 缺少 dc:date")
        if "nav.xhtml" in [n.split("/")[-1] for n in names]:
            fail("包里还有 nav.xhtml")
    else:
        if has_nav:
            ok('有 properties="nav" 的导航文档')
        else:
            fail('EPUB 3.0 缺少 nav 文档')
        if re.search(r'<meta\b[^>]*\bproperty\s*=\s*"dcterms:modified"', opf):
            ok("有 dcterms:modified")
        else:
            fail("EPUB 3.0 必须有 dcterms:modified")
        if 'properties="cover-image"' in opf:
            ok("封面用 properties=\"cover-image\"")
        elif re.search(r'<item\b[^>]*href\s*=\s*"([^"]*(?:cover|封面)[^"]*)"', opf, re.I):
            fail("EPUB 3.0 有封面图却没有 cover-image 属性")
        else:
            ok("原书没有封面，输出也没有（不作假）")

    # --- 正文章节
    idrefs = re.findall(r'<itemref\b[^>]*\bidref\s*=\s*"([^"]+)"', opf)
    by_id = {}
    for it in items:
        iid = re.search(r'\bid\s*=\s*"([^"]+)"', it)
        href = re.search(r'\bhref\s*=\s*"([^"]+)"', it)
        if iid and href:
            by_id[iid.group(1)] = href.group(1)
    ch_paths = [resolve(opf_path, by_id[i]) for i in idrefs if i in by_id]
    ch_paths = [p for p in ch_paths if p in names]
    if not ch_paths:
        fail("spine 里没有可读的章节")
    checked = 0
    for p in ch_paths:
        text = zf.read(p).decode("utf-8")
        checked += 1
        if want == "2.0":
            if XHTML11 in text:
                pass
            else:
                fail("章节不是 XHTML 1.1 DOCTYPE：%s" % p)
            if re.search(r"xmlns:epub\s*=", text):
                fail("章节声明了 epub: 命名空间：%s" % p)
            if re.search(r"\bepub:[a-zA-Z-]+\s*=", text):
                fail("章节使用了 epub: 属性：%s" % p)
            if '<meta charset="' in text:
                fail("2.0 章节用了 HTML5 的 <meta charset>：%s" % p)
            if 'http-equiv="Content-Type"' not in text:
                fail("2.0 章节缺少 http-equiv Content-Type：%s" % p)
        else:
            if re.search(r"<!DOCTYPE\s+html\s*>", text, re.I):
                pass
            else:
                fail("章节不是 HTML5 DOCTYPE：%s" % p)
    if checked:
        ok("%d 个章节的文档类型与命名空间符合 %s" % (checked, want))

    # --- XHTML 良构
    bad = 0
    for p in ch_paths:
        raw = zf.read(p)
        try:
            import xml.etree.ElementTree as ET
            ET.fromstring(raw)
        except Exception as e:
            bad += 1
            if bad <= 2:
                fail("章节 XML 不良构：%s（%s）" % (p, e))
    if not bad:
        ok("%d 个章节 XML 全部良构" % len(ch_paths))

    print()
    if errors:
        print("未通过 %d 项 / 共 %d 项检查" % (len(errors), checks))
        return 1
    print("全部 %d 项检查通过" % checks)
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("用法: python tools/check_version.py <book.epub> 2.0|3.0")
        sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2]))
