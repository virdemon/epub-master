"""校验 EPUB 结构合规性。

不是"看起来像"就算过，逐项硬校验：
  1. mimetype 必须是第一个条目、不压缩、内容精确
  2. 所有 XML 必须良构（阅读器遇到坏 XML 会直接白屏）
  3. manifest 里声明的文件必须真实存在
  4. spine 引用的 id 必须在 manifest 里
  5. unique-identifier 必须能对上 dc:identifier 的 id
  6. 样式表不能有 px / pt 这类绝对单位
  7. 正文不能残留 style 属性、font 标签、空段落
  8. 图片引用必须能解析到真实文件
"""

import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from urllib.parse import unquote

NS = {
    "opf": "http://www.idpf.org/2007/opf",
    "dc": "http://purl.org/dc/elements/1.1/",
    "xhtml": "http://www.w3.org/1999/xhtml",
    "ncx": "http://www.daisy.org/z3986/2005/ncx/",
    "container": "urn:oasis:names:tc:opendocument:xmlns:container",
}

errors = []
warnings = []
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


def warn(msg):
    warnings.append(msg)
    print("  [??] " + msg)


def info(msg):
    """模式相关的预期行为，只陈述不改判。"""
    print("  [--] " + msg)


def main(path, mode="deep"):
    print("校验: %s\n" % path)
    zf = zipfile.ZipFile(path)

    # ---------- 1. mimetype ----------
    print("[1] mimetype 规范性")
    infos = zf.infolist()
    names = zf.namelist()
    if names and names[0] == "mimetype":
        ok("mimetype 是压缩包第一个条目")
    else:
        fail("mimetype 不是第一个条目（部分阅读器会直接判定为非法 EPUB）")

    mt = [i for i in infos if i.filename == "mimetype"]
    if mt:
        if mt[0].compress_type == zipfile.ZIP_STORED:
            ok("mimetype 未压缩存储")
        else:
            fail("mimetype 被压缩了，规范要求必须 STORE")
        if mt[0].extra:
            warn("mimetype 带有 extra field，个别严格的阅读器可能拒绝")
        if zf.read("mimetype") == b"application/epub+zip":
            ok("mimetype 内容正确")
        else:
            fail("mimetype 内容不正确")

    # ---------- 2. XML 良构 ----------
    print("\n[2] XML 良构性")
    xml_files = [
        n for n in names
        if n.lower().endswith((".xml", ".opf", ".ncx", ".xhtml", ".html"))
    ]
    bad_xml = []
    for n in xml_files:
        try:
            ET.fromstring(zf.read(n))
        except ET.ParseError as e:
            bad_xml.append("%s: %s" % (n, e))
    if bad_xml:
        for b in bad_xml:
            fail("XML 不良构 -> " + b)
    else:
        ok("%d 个 XML 文件全部良构" % len(xml_files))

    # ---------- 3. container / opf ----------
    print("\n[3] 包结构")
    container = ET.fromstring(zf.read("META-INF/container.xml"))
    rootfile = container.find(".//container:rootfile", NS)
    if rootfile is None:
        fail("container.xml 里没有 rootfile，流程无法继续")
        return
    opf_path = rootfile.get("full-path")
    if opf_path in names:
        ok("OPF 存在于 %s" % opf_path)
    else:
        fail("OPF 文件不存在: %s" % opf_path)
        return

    opf_dir = os.path.dirname(opf_path)
    opf = ET.fromstring(zf.read(opf_path))

    # ---------- 4. manifest ----------
    items = {}
    missing = []
    for item in opf.findall(".//opf:manifest/opf:item", NS):
        iid = item.get("id")
        href = unquote(item.get("href", ""))
        full = os.path.normpath(os.path.join(opf_dir, href)).replace("\\", "/")
        items[iid] = {"href": href, "path": full, "type": item.get("media-type")}
        if full not in names:
            missing.append("%s -> %s" % (iid, full))

    if missing:
        for m in missing:
            fail("manifest 声明的文件不存在: " + m)
    else:
        ok("%d 个 manifest 条目全部指向真实文件" % len(items))

    # ---------- 4b. manifest 完整性 ----------
    # 反过来的错误同样致命：包里有的文件没被声明。
    # 阅读器（以及 Calibre 的编辑工具）会逐个报「此文件未列在manifest文件中」，
    # 图片全部显示不出来。下载 / 转换来的书这是最常见的坏法。
    print("\n[3b] manifest 完整性")
    declared_paths = set(v["path"] for v in items.values())
    undeclared = [
        n for n in names
        if n != "mimetype" and n != opf_path
        and not n.startswith("META-INF/") and not n.endswith("/")
        and n not in declared_paths
    ]
    if undeclared:
        for u in undeclared[:20]:
            fail("包内文件未列入 manifest（阅读器会报「此文件未列在manifest文件中」）: " + u)
        if len(undeclared) > 20:
            fail("……另有 %d 个文件同样未列入 manifest" % (len(undeclared) - 20))
    else:
        ok("包内 %d 个资源文件全部已在 manifest 声明" % (len(names) - 1))

    ids = [item.get("id") for item in opf.findall(".//opf:manifest/opf:item", NS)]
    dup = sorted(set(i for i in ids if ids.count(i) > 1))
    if dup:
        fail("manifest 存在重复 id: %s" % dup)
    else:
        ok("manifest 的 id 无重复")

    # ---------- 5. spine ----------
    spine = opf.find(".//opf:spine", NS)
    idrefs = [r.get("idref") for r in opf.findall(".//opf:spine/opf:itemref", NS)]
    orphan = [i for i in idrefs if i not in items]
    if orphan:
        for o in orphan:
            fail("spine 引用了 manifest 中不存在的 id: " + o)
    else:
        ok("spine 的 %d 个条目都能在 manifest 中找到" % len(idrefs))

    non_xhtml = [
        i for i in idrefs
        if not (items[i]["href"].endswith((".xhtml", ".html")))
    ]
    if non_xhtml:
        warn("spine 里混入了非正文条目: %s" % non_xhtml)

    # ---------- 6. unique-identifier ----------
    print("\n[4] 元数据")
    uid_attr = opf.get("unique-identifier")
    idents = [
        (e.get("id"), (e.text or "").strip())
        for e in opf.findall(".//dc:identifier", NS)
    ]
    match = [v for i, v in idents if i == uid_attr and v]
    if match:
        ok("unique-identifier=%s 能对上 dc:identifier" % uid_attr)
    else:
        fail("unique-identifier=%s 找不到对应的 dc:identifier" % uid_attr)

    version = opf.get("version")
    ok("package version=%s" % version)

    # EPUB2 风格的封面声明靠 id 指回 manifest，指空了同样是错误
    for m in opf.findall(".//opf:meta", NS):
        if (m.get("name") or "").lower() != "cover":
            continue
        c = m.get("content")
        if c and c not in items:
            fail("meta name=cover 指向 manifest 中不存在的 id: " + c)
    if version and version.startswith("3"):
        mod = opf.find(".//opf:meta[@property='dcterms:modified']", NS)
        if mod is not None and re.match(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", mod.text or ""):
            ok("EPUB3 必需的 dcterms:modified 格式正确")
        else:
            fail("EPUB3 缺少合法格式的 dcterms:modified")

        nav_items = [k for k, v in items.items() if "nav" in (v.get("type") or "")]
        navs = [i for i in opf.findall(".//opf:item", NS) if "nav" in (i.get("properties") or "")]
        if navs:
            ok("存在导航文档 nav")
        else:
            fail("EPUB3 缺少 properties=nav 的导航文档")

    # ---------- 7. 样式表单位 ----------
    print("\n[5] 样式表")
    css_items = [v for v in items.values() if v["type"] == "text/css"]
    if not css_items:
        fail("没有任何样式表，排版会完全依赖阅读器默认值（各端必然不一致）")
    else:
        ok("有 %d 份样式表" % len(css_items))

    # 标准模式刻意保留原书样式表，因此"残留 px / @font-face"是预期行为，
    # 只统计不改判；深度与极致模式应当把它们清干净。
    preserve = mode == "standard"
    for c in css_items:
        text = zf.read(c["path"]).decode("utf-8", "ignore")
        text_nc = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
        px = re.findall(r"[\d.]+(px|pt|cm|mm|in)\b", text_nc)
        if c["path"].endswith("epubfix.css"):
            if px:
                fail("自有样式表残留绝对单位 %s -> %s" % (set(px), c["path"]))
            else:
                ok("自有样式表没有绝对单位")
            if re.search(r"text-indent\s*:\s*2em", text_nc):
                ok("首行缩进使用 2em")
        elif preserve:
            if px:
                info("原书样式表保留绝对单位 %d 处（标准模式预期行为）-> %s" % (len(px), c["path"]))
        else:
            if px:
                fail("样式表残留绝对单位 %s（%d 处）-> %s" % (set(px), len(px), c["path"]))
        if "@font-face" in text_nc:
            if preserve:
                info("原书样式表保留 @font-face（标准模式预期行为）-> " + c["path"])
            else:
                fail("样式表仍有 @font-face -> " + c["path"])

    # ---------- 8. 正文残留物 ----------
    print("\n[6] 正文残留")
    ch_files = [items[i]["path"] for i in idrefs if i in items and items[i]["href"].endswith(".xhtml")]
    stat_attr = 0
    font_tag = 0
    empty_p = 0
    fixed_dim = 0
    img_missing = []

    for f in ch_files:
        raw = zf.read(f).decode("utf-8", "ignore")
        stat_attr += len(re.findall(r'\sstyle\s*=', raw))
        font_tag += len(re.findall(r"<font\b", raw, re.I))
        fixed_dim += len(re.findall(r"<img\b[^>]*\s(width|height)\s*=", raw, re.I))
        empty_p += len(re.findall(r"<p[^>]*>(?:\s|&nbsp;|<br\s*/?>)*</p>", raw))
        for m in re.finditer(r'<img\b[^>]*\ssrc="([^"]+)"', raw):
            src = unquote(m.group(1))
            if re.match(r"^[a-z][a-z0-9+.\-]*:", src):
                continue
            target = os.path.normpath(os.path.join(os.path.dirname(f), src)).replace("\\", "/")
            if target not in names:
                img_missing.append("%s -> %s" % (f, target))

    residue = [
        ("内联 style 属性", stat_attr),
        ("font 标签", font_tag),
        ("空段落", empty_p),
        ("写死的图片宽高", fixed_dim),
    ]
    if preserve:
        # 标准模式保真优先，这些"残留"是原书排版的一部分，不算缺陷
        for label, count in residue:
            info("保留%s %d 处（标准模式预期行为）" % (label, count))
        residue = []
    for label, count in residue:
        if count == 0:
            ok("无残留" + label)
        else:
            fail("仍残留 %s: %d 处" % (label, count))

    if img_missing:
        for m in img_missing:
            fail("图片引用指向不存在的文件: " + m)
    else:
        ok("所有图片引用都能解析到真实文件")

    # ---------- 6b. 段落结构 ----------
    # 首行缩进挂在 <p> 上。如果正文是"一行一个 <div>"，缩进就没有地方生效，
    # 读起来会像记事本——这正是很多网页抓取来的书的通病。
    print("\n[6b] 段落结构")
    bare_div = []
    no_p = []
    for f in ch_files:
        raw = zf.read(f).decode("utf-8", "ignore")
        body = raw[raw.find("<body"):]
        text_len = len(re.sub(r"<[^>]+>", "", body).strip())
        if text_len >= 100 and "<p" not in body:
            no_p.append(f)
        for m in re.finditer(r"<div\b[^>]*>((?:(?!</div>)[^<]){5,})</div>", body):
            if m.group(1).strip():
                bare_div.append("%s -> %s…" % (f, m.group(1).strip()[:16]))

    if no_p:
        for f in no_p:
            fail("整章正文没有 <p> 标签，首行缩进不会生效: " + f)
    else:
        ok("每一章正文都使用 <p> 段落")

    if bare_div:
        for b in bare_div[:10]:
            fail("文字直接写在 <div> 里（应为 <p>，否则没有首行缩进）: " + b)
    else:
        ok("没有把正文直接塞进 <div> 的段落")

    # ---------- 9. 体量对比 ----------
    print("\n[7] 体量")
    total = sum(i.file_size for i in infos)
    largest = sorted(infos, key=lambda i: -i.file_size)[:5]
    print("  压缩包 %.2f MB（解压后 %.2f MB，%d 个文件，%d 个章节）"
          % (os.path.getsize(path) / 1048576, total / 1048576, len(names), len(ch_files)))
    for i in largest:
        print("    %8.1f KB  %s" % (i.file_size / 1024, i.filename))

    # ---------- 汇总 ----------
    print("\n" + "=" * 56)
    if errors:
        print("结果: 不通过，%d 个错误 / %d 个警告 / 共 %d 项检查"
              % (len(errors), len(warnings), checks))
        for e in errors:
            print("  - " + e)
        return 1
    print("结果: 全部通过（%d 项检查，%d 个警告）" % (checks, len(warnings)))
    return 0


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "test", "sample_fixed.epub"
    )
    _mode = os.environ.get("VERIFY_MODE", "deep")
    if len(sys.argv) > 2:
        _mode = sys.argv[2]
    sys.exit(main(target, _mode))
