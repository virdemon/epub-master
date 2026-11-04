"""把 epubfix 打成单个 HTML 文件，方便发给别人。

为什么要单文件：
  - 发微信 / 邮件时不用带文件夹，一个 .html 双击就能用
  - 不需要装 node、不需要起本地服务器
  - 仍然是纯前端，书不会离开对方的电脑

只做一件事：把 style.css、vendor/fflate.js、src/core.js、app.js 内联进 index.html。
不做压缩混淆——这类工具让人能看清代码反而更容易被信任。
"""

import base64
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "epubfix")
OUT_DIR = os.path.join(ROOT, "dist")
OUT = os.path.join(OUT_DIR, "epubfix-standalone.html")


def read(*parts):
    with open(os.path.join(SRC, *parts), encoding="utf-8") as f:
        return f.read()


def main():
    html = read("index.html")
    css = read("style.css")
    fflate = read("vendor", "fflate.js")
    core = read("src", "core.js")
    app = read("app.js")

    # 内联时不能出现 </script>，否则会提前闭合标签
    def safe_js(code):
        return code.replace("</script", "<\\/script")

    html = html.replace(
        '<link rel="stylesheet" href="style.css" />',
        "<style>\n" + css + "\n</style>",
    )
    html = html.replace(
        '<script src="vendor/fflate.js"></script>',
        "<script>\n" + safe_js(fflate) + "\n</script>",
    )
    html = html.replace(
        '<script src="src/core.js"></script>',
        "<script>\n" + safe_js(core) + "\n</script>",
    )
    html = html.replace(
        '<script src="app.js"></script>',
        "<script>\n" + safe_js(app) + "\n</script>",
    )

    # 图标也得内联，否则单文件挪到别处就少个 logo
    icon_path = os.path.join(SRC, "assets", "icon.svg")
    if os.path.exists(icon_path):
        with open(icon_path, encoding="utf-8") as f:
            svg = f.read()
        data = "data:image/svg+xml;base64," + base64.b64encode(svg.encode("utf-8")).decode("ascii")
        html = html.replace('src="assets/icon.svg"', 'src="%s"' % data)
        html = html.replace('href="assets/icon.svg"', 'href="%s"' % data)

    # 单文件版没有同目录资源了，标注一下来源
    html = html.replace(
        "<title>",
        "<!-- 单文件免安装版：直接用浏览器打开即可，不需要任何依赖 -->\n<title>",
        1,
    )

    # 检查外部引用时先把内联进去的脚本/样式剥掉，
    # 否则 JS 里那些拼接字符串里的 src="…" 会被误判成外链。
    markup = re.sub(r"<script\b[\s\S]*?</script>", "", html)
    markup = re.sub(r"<style\b[\s\S]*?</style>", "", markup)
    left = re.findall(r'(?:src|href)="(?!data:|#|https?:)([^"]+)"', markup)
    if left:
        raise SystemExit("还有外部引用没内联：%s" % left)

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(html)

    size = os.path.getsize(OUT)
    print("已生成 %s（%.0f KB）" % (OUT, size / 1024))
    print("  单文件、零依赖，双击即可使用")


if __name__ == "__main__":
    main()
