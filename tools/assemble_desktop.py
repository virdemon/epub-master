"""组装 Windows 桌面版：Electron 运行时 + 我们的界面代码。

为什么不直接用 electron-packager：
  它要联网从 GitHub 拖 electron 压缩包，这里网络拿不到。
  手工组装做的是同一件事——把 electron 运行时复制一份，再塞进 resources/app，
  然后把 exe 改名。产物结构也和 packager 一致。

运行时从哪来：
  · 优先用 .cache/electron.zip（官方/镜像下载的 electron-v*-win32-x64.zip）
  · 没有的话，复用 dist 里上一次打好的包（它本身就是运行时 + 我们的 app）
  两者都没有才报错。

产物：dist/EPUBMaster-win32-x64/EPUB Master.exe（整个文件夹可以一起拷走，免安装）
"""

import os
import shutil
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ZIP = os.path.join(ROOT, ".cache", "electron.zip")
DIST = os.path.join(ROOT, "dist")
OUT = os.path.join(DIST, "EPUBMaster-win32-x64")
TMP = OUT + ".building"
EXE_NAME = "EPUB Master.exe"


def find_runtime_dir():
    """在 dist 里找一个已经是「electron + app」结构的目录，当作运行时来源。"""
    if not os.path.isdir(DIST):
        return None
    for name in sorted(os.listdir(DIST)):
        p = os.path.join(DIST, name)
        # 上一次的产物就是 OUT 本身，可以边读边写（先写 TMP 再整体换过去）
        if not os.path.isdir(p) or p == TMP or name.endswith(".old"):
            continue
        res = os.path.join(p, "resources")
        if any(os.path.exists(os.path.join(res, f)) for f in ("electron.asar", "default_app.asar", "app")):
            return p
    return None


def copy_tree(src, dst, skip=()):
    for item in os.listdir(src):
        if item in skip:
            continue
        s, d = os.path.join(src, item), os.path.join(dst, item)
        if os.path.isdir(s):
            shutil.copytree(s, d)
        else:
            shutil.copy2(s, d)


def main():
    html = os.path.join(DIST, "epubfix-standalone.html")
    if not os.path.exists(html):
        raise SystemExit("缺少单文件版：先跑 python tools/build_standalone.py")

    prev = find_runtime_dir()
    if not os.path.exists(ZIP) and not prev:
        raise SystemExit(
            "缺少 Electron 运行时。二选一：\n"
            "  1) 下载到 .cache/electron.zip（electron-v31.7.7-win32-x64.zip）\n"
            "  2) 保留 dist 里上一次打好的目录，脚本会复用它"
        )

    if os.path.exists(TMP):
        shutil.rmtree(TMP)
    os.makedirs(TMP)

    if os.path.exists(ZIP):
        print("解压 Electron 运行时…")
        with zipfile.ZipFile(ZIP) as z:
            z.extractall(TMP)
    else:
        print("复用上一次打包的运行时：%s" % os.path.relpath(prev, ROOT))
        copy_tree(prev, TMP, skip=("resources",))
        shutil.copytree(os.path.join(prev, "resources"), os.path.join(TMP, "resources"),
                        ignore=shutil.ignore_patterns("app"))

    target_exe = os.path.join(TMP, EXE_NAME)
    if not os.path.exists(target_exe):
        exe = os.path.join(TMP, "electron.exe")
        if not os.path.exists(exe):
            cands = [f for f in os.listdir(TMP) if f.lower().endswith(".exe")]
            if not cands:
                raise SystemExit("没有找到 electron 主程序，运行时目录不完整")
            exe = os.path.join(TMP, cands[0])
        os.replace(exe, target_exe)

    # 资源：main.js + package.json + 界面（单文件 HTML）+ 窗口图标
    app_dir = os.path.join(TMP, "resources", "app")
    os.makedirs(os.path.join(app_dir, "app"), exist_ok=True)
    shutil.copy2(os.path.join(ROOT, "desktop", "main.js"), os.path.join(app_dir, "main.js"))
    # preload.js 是桌面版读写真实文件系统、取默认下载目录的唯一通道，漏了它
    # 界面就退化成浏览器模式，保存会走到下载而不是「下载\EPUB_Master」
    shutil.copy2(os.path.join(ROOT, "desktop", "preload.js"), os.path.join(app_dir, "preload.js"))
    shutil.copy2(os.path.join(ROOT, "desktop", "package.json"), os.path.join(app_dir, "package.json"))
    shutil.copy2(html, os.path.join(app_dir, "app", "index.html"))

    icon = os.path.join(DIST, "icon.ico")
    if os.path.exists(icon):
        shutil.copy2(icon, os.path.join(app_dir, "app", "icon.ico"))
        shutil.copy2(icon, os.path.join(TMP, "icon.ico"))

    readme = os.path.join(DIST, "使用说明.txt")
    if os.path.exists(readme):
        shutil.copy2(readme, os.path.join(TMP, "使用说明.txt"))

    # 换到正式位置：先把旧的挪开，避免半成品和新成品混在一起
    old = OUT + ".old"
    if os.path.exists(old):
        shutil.rmtree(old)
    if os.path.exists(OUT):
        os.replace(OUT, old)
    os.replace(TMP, OUT)
    if os.path.exists(old):
        shutil.rmtree(old, ignore_errors=True)

    size = sum(os.path.getsize(os.path.join(dp, f))
               for dp, _, fs in os.walk(OUT) for f in fs)
    print("已生成 %s" % OUT)
    print("  可执行文件: %s" % os.path.join(OUT, EXE_NAME))
    print("  整包 %.0f MB（免安装，整个文件夹拷走即可）" % (size / 1048576))


if __name__ == "__main__":
    sys.exit(main())
