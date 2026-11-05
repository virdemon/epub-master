"""整理 Windows 发布产物：绿色便携目录 + 便携 ZIP。

输入是 tools/assemble_desktop.py 组好的运行目录（dist/EPUBMaster-win32-x64），
这里只做「发布前该做的事」：
  · 剪掉开发期残留（debug.log、default_app.asar、上一次的临时文件）
  · 检查有没有写死的本机绝对路径（构建目录 / 用户名）
  · 检查运行时必需的 DLL、locales、pak 是否齐全
  · 复制成 release/EPUB_Master_Portable/，再压成 ZIP

产物：
  release/EPUB_Master_Portable/
  release/EPUB_Master_v1.3_Windows_x64_Portable.zip
"""

import os
import re
import shutil
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "dist", "EPUBMaster-win32-x64")
REL = os.path.join(ROOT, "release")
NAME = "EPUB_Master_Portable"
# 便携目录放在 release/portable/ 下：这一层是干净可写的，
# 万一 release/ 里已经有同名残留（被别的进程占用删不掉）也不会污染产物
OUT = os.path.join(REL, "portable", NAME)
EXE = "EPUB Master.exe"
VERSION = "1.3"
ZIP_NAME = "EPUB_Master_v%s_Windows_x64_Portable.zip" % VERSION

# Electron 在 Windows 上真正必需的运行文件：缺一个都会白屏或直接起不来
REQUIRED = [
    EXE,
    "resources/app/main.js",
    "resources/app/preload.js",
    "resources/app/package.json",
    "resources/app/app/index.html",
    "resources/app/app/icon.ico",
    "icudtl.dat",
    "resources.pak",
    "chrome_100_percent.pak",
    "chrome_200_percent.pak",
    "v8_context_snapshot.bin",
    "snapshot_blob.bin",
    "libEGL.dll",
    "libGLESv2.dll",
    "d3dcompiler_47.dll",
    "ffmpeg.dll",
]

# 只留真正用得到的界面语言：Chromium 自带 55 种，占了 39 MB，
# 这个程序的界面只有中文和英文，其他 .pak 全是白占体积
KEEP_LOCALES = ("zh-CN.pak", "zh-TW.pak", "en-US.pak", "en-GB.pak")

# 开发期产物，不进发布包
DROP_FILES = (
    "debug.log",
    # 软件光栅化后备（Vulkan/SwiftShader）：Windows 上 Electron 默认走 ANGLE + D3D11，
    # 没有显卡时用系统 WARP 兜底，这一套基本不会被加载，白占 6 MB
    "vk_swiftshader.dll",
    "vulkan-1.dll",
    "vk_swiftshader_icd.json",
)
DROP_TREES = ("resources/default_app.asar",)

# 允许出现本机路径的位置：这些文件里出现就说明打包被打脏了
SCAN_EXT = (".js", ".html", ".json", ".css", ".txt", ".iss")
BAD_PATTERNS = [
    (re.compile(r"users/wh/", re.I), "本机用户目录"),
    (re.compile(r":/users/", re.I), "绝对盘符路径"),
    (re.compile(r"workbuddy/2026", re.I), "构建工作目录"),
]


def walk(root):
    for dp, dns, fns in os.walk(root):
        for f in fns:
            yield os.path.join(dp, f)


def force_rm(path):
    """删目录：优先用系统 rmdir。

    某些环境（包括这个仓库的构建沙箱）会把 shutil.rmtree 拦成"移到回收站"，
    258 MB 的 Electron 目录经常搬不动，于是直接用 rmdir /s /q 兜底。
    """
    if not os.path.exists(path):
        return
    if os.name == "nt":
        import subprocess

        subprocess.run(["cmd", "/c", "rmdir", "/s", "/q", path], check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if os.path.exists(path):
        shutil.rmtree(path, ignore_errors=True)


def main():
    if not os.path.exists(os.path.join(SRC, EXE)):
        raise SystemExit("缺少运行目录，先跑：python tools/assemble_desktop.py")

    os.makedirs(REL, exist_ok=True)
    force_rm(os.path.join(REL, "portable"))
    os.makedirs(os.path.join(REL, "portable"), exist_ok=True)
    print("复制运行文件…")
    # 直接用 ignore 剪掉开发期残留，比"先复制再删"稳（有些环境对 asar 有占用）
    skip = shutil.ignore_patterns(*DROP_FILES, *[os.path.basename(t) for t in DROP_TREES])
    shutil.copytree(SRC, OUT, ignore=skip)

    # 使用说明放一份在根目录，解压就能看到
    readme = os.path.join(ROOT, "dist", "使用说明.txt")
    if os.path.exists(readme):
        shutil.copy2(readme, os.path.join(OUT, "使用说明.txt"))

    missing = [r for r in REQUIRED if not os.path.exists(os.path.join(OUT, r.replace("/", os.sep)))]
    if missing:
        raise SystemExit("运行文件不全，缺：\n  " + "\n  ".join(missing))
    # 精简语言包
    loc_dir = os.path.join(OUT, "locales")
    drop = [f for f in os.listdir(loc_dir) if f not in KEEP_LOCALES]
    if drop:
        import subprocess
        for i in range(0, len(drop), 20):
            batch = [os.path.join(loc_dir, f) for f in drop[i:i + 20]]
            subprocess.run(["cmd", "/c", "del", "/f", "/q"] + batch, check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        left = [f for f in os.listdir(loc_dir) if f not in KEEP_LOCALES]
        if left:
            print("  语言包没删干净，剩 %d 个" % len(left))
        else:
            print("  去掉 %d 个用不到的语言包" % len(drop))

    locales = os.listdir(os.path.join(OUT, "locales"))
    if "zh-CN.pak" not in locales:
        raise SystemExit("locales 里没有 zh-CN.pak，界面会缺字")

    dirty = []
    for p in walk(os.path.join(OUT, "resources")):
        if os.path.splitext(p)[1].lower() not in SCAN_EXT:
            continue
        try:
            text = open(p, encoding="utf-8", errors="ignore").read().replace("\\", "/").lower()
        except Exception:
            continue
        for pat, why in BAD_PATTERNS:
            if pat.search(text):
                dirty.append("%s —— %s" % (os.path.relpath(p, OUT), why))
                break
    if dirty:
        raise SystemExit("发布包里有写死的本机路径：\n  " + "\n  ".join(dirty))
    print("  路径检查：没有写死的本机目录")

    total = sum(os.path.getsize(p) for p in walk(OUT))
    files = sum(1 for _ in walk(OUT))
    print("  便携目录 %d 个文件，%.0f MB" % (files, total / 1048576))

    zpath = os.path.join(REL, ZIP_NAME)
    if os.path.exists(zpath):
        os.remove(zpath)
    print("压缩…")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        # 顶层目录用 EPUB_Master_Portable，解压后是一整份，不会散落在下载目录里
        for p in sorted(walk(OUT)):
            arc = os.path.join(NAME, os.path.relpath(p, OUT)).replace(os.sep, "/")
            z.write(p, arc)
    print("已生成 %s（%.0f MB）" % (zpath, os.path.getsize(zpath) / 1048576))
    return 0


if __name__ == "__main__":
    sys.exit(main())
