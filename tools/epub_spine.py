# -*- coding: utf-8 -*-
"""把一个 epub 的 spine 顺序、目录标题、书名、唯一标识抽出来，输出 JSON。

测试用：核对分卷之后章节是否守恒、有没有重复、顺序有没有乱。
"""
import html
import json
import re
import sys
import zipfile


def text_of(xml):
    return html.unescape(re.sub(r"<[^>]+>", "", xml or ""))


def find_opf(z):
    names = z.namelist()
    container = next((n for n in names if n.endswith("META-INF/container.xml")), None)
    if container:
        c = z.read(container).decode("utf-8", "ignore")
        m = re.search(r'full-path="([^"]+)"', c)
        if m and m.group(1) in names:
            return m.group(1)
    return next((n for n in names if n.lower().endswith(".opf")), None)


def resolve(base, href):
    import posixpath

    if not base:
        return href
    return posixpath.normpath(posixpath.join(posixpath.dirname(base), href))


def main(path):
    out = {"spine": [], "toc": [], "title": "", "identifier": "", "headings": [], "leads": [], "ncx_uid": ""}
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        opf_path = find_opf(z)
        if not opf_path:
            print(json.dumps(out))
            return
        opf = z.read(opf_path).decode("utf-8", "ignore")
        base = opf_path

        m = re.search(r"<dc:title[^>]*>(.*?)</dc:title>", opf, re.S)
        if m:
            out["title"] = text_of(m.group(1)).strip()
        m = re.search(r"<dc:identifier[^>]*>(.*?)</dc:identifier>", opf, re.S)
        if m:
            out["identifier"] = text_of(m.group(1)).strip()

        idmap = {}
        for m in re.finditer(r"<item\b([^>]*)/?>", opf):
            attrs = m.group(1)
            i = re.search(r'id="([^"]+)"', attrs)
            h = re.search(r'href="([^"]+)"', attrs)
            if i and h:
                idmap[i.group(1)] = resolve(base, h.group(1)).replace("\\", "/")

        for m in re.finditer(r"<itemref\b([^>]*)/?>", opf):
            r = re.search(r'idref="([^"]+)"', m.group(1))
            if r and r.group(1) in idmap:
                out["spine"].append(idmap[r.group(1)])

        # 每章的标题与开头，用来核对分卷之后顺序有没有乱
        for p in out["spine"]:
            if p not in names:
                out["headings"].append("")
                out["leads"].append("")
                continue
            src = z.read(p).decode("utf-8", "ignore")
            h = re.search(r"<h[1-6][^>]*>(.*?)</h[1-6]>", src, re.S)
            if not h:
                h = re.search(r"<title[^>]*>(.*?)</title>", src, re.S)
            out["headings"].append(text_of(h.group(1)).strip() if h else "")
            body = re.search(r"<body\b[^>]*>(.*?)</body>", src, re.S)
            plain = text_of(body.group(1) if body else src)
            out["leads"].append(re.sub(r"\s+", "", plain)[:40])

        # 目录：优先 properties="nav" 的文档，其次任意 nav.xhtml，退回 toc.ncx
        nav = next((n for n in names if n.lower().endswith("nav.xhtml")), None)
        toc_path = None
        m = re.search(r'<item\b[^>]*properties="[^"]*nav[^"]*"[^>]*href="([^"]+)"', opf)
        if not m:
            m = re.search(r'<item\b[^>]*href="([^"]+)"[^>]*properties="[^"]*nav[^"]*"', opf)
        if m:
            toc_path = resolve(base, m.group(1)).replace("\\", "/")
        if not toc_path or toc_path not in names:
            toc_path = nav
        if toc_path and toc_path in names:
            nav_src = z.read(toc_path).decode("utf-8", "ignore")
            for a in re.finditer(r"<a\b[^>]*>(.*?)</a>", nav_src, re.S):
                t = text_of(a.group(1)).strip()
                if t:
                    out["toc"].append(t)
        else:
            ncx = next((n for n in names if n.lower().endswith(".ncx")), None)
            if ncx:
                src = z.read(ncx).decode("utf-8", "ignore")
                u = re.search(r'name="dtb:uid"\s+content="([^"]*)"', src)
                if u:
                    out["ncx_uid"] = u.group(1)
                for m in re.finditer(r"<text>(.*?)</text>", src, re.S):
                    t = text_of(m.group(1)).strip()
                    if t:
                        out["toc"].append(t)

    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1])
